import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import helmet from 'helmet';
import { config } from './config.js';
import { init } from './db/index.js';
import { api } from './routes/index.js';
import { requestLog, notFoundHandler, errorHandler } from './middleware/common.js';

/**
 * Outside origins the page itself talks to, for the CSP below. LiveKit: the
 * browser opens the signal socket (wss) and first probes it over https; LiveKit
 * Cloud then moves the session to a regional host, hence the wildcard. S3:
 * recordings play from short-lived signed links straight from the bucket.
 */
export function externalSources(cfg = config) {
  const live = [];
  try {
    if (cfg.livekit?.url) {
      const u = new URL(cfg.livekit.url);
      const ws = u.protocol === 'ws:' || u.protocol === 'http:' ? 'ws' : 'wss';
      const http = ws === 'ws' ? 'http' : 'https';
      live.push(`${ws}://${u.host}`, `${http}://${u.host}`);
      if (u.hostname.endsWith('.livekit.cloud')) live.push('wss://*.livekit.cloud', 'https://*.livekit.cloud');
    }
  } catch { /* a malformed URL just means no extra sources */ }

  const media = [];
  const s3 = cfg.recordingStorage || {};
  try {
    if (s3.endpoint) media.push(new URL(s3.endpoint).origin);
    else if (s3.bucket && s3.region) {
      media.push(`https://${s3.bucket}.s3.${s3.region}.amazonaws.com`, `https://s3.${s3.region}.amazonaws.com`);
    }
  } catch { /* ignore */ }
  return { live, media };
}

export async function createApp({ migrateOnBoot = true } = {}) {
  const ext = externalSources();
  if (migrateOnBoot) await init();

  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  // NFR security: OWASP baseline headers. When this process also serves the SPA
  // we know every source the page loads, so the policy can be written here; when
  // the SPA is hosted separately, CSP belongs at that edge instead.
  app.use(helmet({
    contentSecurityPolicy: config.serveWeb ? {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        // React inline style props and the chart library both set element styles;
        // the two font families are loaded from Google Fonts by index.html.
        styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
        imgSrc: ["'self'", 'data:', 'blob:', ...ext.media],
        fontSrc: ["'self'", 'data:', 'https://fonts.gstatic.com'],
        // Same-origin XHR and the chat SSE stream; blob: for generated PDFs;
        // the LiveKit video service; recordings fetched from the bucket.
        connectSrc: ["'self'", 'blob:', ...ext.live, ...ext.media],
        // Meeting video/audio arrive as MediaStreams (no URL); recordings play from S3.
        mediaSrc: ["'self'", 'blob:', 'data:', ...ext.media],
        // livekit-client runs small helpers (audio processing) in blob: workers.
        workerSrc: ["'self'", 'blob:'],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        upgradeInsecureRequests: config.env === 'production' ? [] : null,
      },
    } : false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // PDFs are opened from blob: URLs in a new tab.
    crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  }));

  app.use(cors({
    origin: config.env === 'production' ? config.corsOrigins : true,
    credentials: true,
    exposedHeaders: ['Idempotent-Replay', 'X-RateLimit-Remaining', 'X-RateLimit-Reset'],
  }));

  // Base64 attachment uploads need headroom beyond the 100kb default.
  app.use(express.json({ limit: '25mb' }));
  app.use(express.urlencoded({ extended: true }));
  app.use(requestLog);

  app.use('/api/v1', api);

  if (config.serveWeb && fs.existsSync(config.webDist)) {
    serveSpa(app, config.webDist);
  } else {
    app.get('/', (req, res) => res.json({
      service: 'Phoenixx OS API',
      version: '1.0.0',
      docs: '/api/v1/openapi.json',
      health: '/api/v1/health',
    }));
  }

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}

/**
 * Serves the built web app from this process, so the whole product is one
 * origin: no CORS, no second deploy, and the SPA's relative `/api/v1` calls
 * work unchanged. Hashed asset filenames are immutable and cached for a year;
 * index.html never is, or a deploy would not reach anyone still holding it.
 */
function serveSpa(app, dist) {
  app.use('/assets', express.static(path.join(dist, 'assets'), {
    immutable: true,
    maxAge: '1y',
    fallthrough: false,
  }));
  app.use(express.static(dist, { index: false, maxAge: '1h' }));

  // Client-side routes (/chat, /projects/:id, …) have no file behind them, so
  // anything that is not an API call and not a file gets the app shell. Express
  // 5 dropped bare '*' patterns, hence a plain middleware rather than a route.
  const indexHtml = path.join(dist, 'index.html');
  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (req.path.startsWith('/api/')) return next();
    res.set('Cache-Control', 'no-cache');
    return res.sendFile(indexHtml);
  });
}
