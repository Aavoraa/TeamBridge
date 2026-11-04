import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

const bool = (v, d = false) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(String(v)));

/**
 * The deployment's public origin. Set WEB_BASE_URL explicitly once a custom
 * domain is attached; until then, on Vercel, its own production domain
 * (VERCEL_PROJECT_PRODUCTION_URL, set by the platform) is the right answer.
 */
const vercelOrigin = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : '';
const publicOrigin = process.env.WEB_BASE_URL || vercelOrigin;

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4010),
  apiBaseUrl: process.env.API_BASE_URL || publicOrigin || `http://localhost:${process.env.PORT || 4010}`,
  webBaseUrl: publicOrigin || 'http://localhost:5174',

  /**
   * Origins allowed to call the API in production.
   *
   * The web app is same-origin so it needs nothing here, but the Capacitor
   * mobile app is not: its pages are served by the device, which sends
   * `Origin: http://localhost` on Android and `capacitor://localhost` on iOS.
   * These are fixed platform constants, not a wildcard — an arbitrary site
   * still cannot reach the API from a browser.
   *
   * EXTRA_CORS_ORIGINS (comma-separated) covers anything else, e.g. a separately
   * hosted web front end.
   */
  corsOrigins: [
    publicOrigin || 'http://localhost:5174',
    'capacitor://localhost',
    'http://localhost',
    'https://localhost',
    ...(process.env.EXTRA_CORS_ORIGINS || '')
      .split(',')
      .map((o) => o.trim())
      .filter(Boolean),
  ],

  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || 'dev-access-secret-change-me',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-change-me',
    accessTtl: process.env.ACCESS_TOKEN_TTL || '15m',
    refreshTtl: process.env.REFRESH_TOKEN_TTL || '30d',
  },

  // The database is chosen by DATABASE_URL - see db/driver.js. Files (PDFs,
  // attachments) live in the database too - see services/storage.js.

  // Single-origin deploys: the API also serves the built web app, so the SPA's
  // relative /api/v1 calls and the chat SSE stream need no CORS at all.
  serveWeb: bool(process.env.SERVE_WEB, false),
  webDist: path.resolve(ROOT, process.env.WEB_DIST || '../web/dist'),

  // Fill an empty database with the demo workspace on start (`npm start` only).
  seedOnBoot: bool(process.env.SEED_ON_BOOT, false),

  /**
   * LiveKit (AI Meetings video). LIVEKIT_URL is the project's wss:// address;
   * the key and secret sign join tokens and verify webhooks and never leave
   * the server. Unset = video meetings show "not configured" instead of failing.
   */
  livekit: {
    url: process.env.LIVEKIT_URL || '',
    apiKey: process.env.LIVEKIT_API_KEY || '',
    apiSecret: process.env.LIVEKIT_API_SECRET || '',
  },

  /**
   * Where meeting recordings go (AWS S3, or any S3-compatible store with an
   * endpoint). LiveKit Egress uploads straight here; the server reads audio
   * back for transcription and hands out short-lived playback links.
   * Unset = meetings run without recording.
   */
  recordingStorage: {
    bucket: process.env.RECORDING_S3_BUCKET || '',
    region: process.env.RECORDING_S3_REGION || '',
    accessKeyId: process.env.RECORDING_S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.RECORDING_S3_SECRET_ACCESS_KEY || '',
    endpoint: process.env.RECORDING_S3_ENDPOINT || '',
    forcePathStyle: bool(process.env.RECORDING_S3_FORCE_PATH_STYLE, false),
    prefix: `${(process.env.RECORDING_S3_PREFIX || 'meetings').replace(/^\/+|\/+$/g, '')}/`,
  },

  providers: {
    whatsapp: process.env.WHATSAPP_PROVIDER || 'log',
    whatsappToken: process.env.WHATSAPP_TOKEN || '',
    whatsappPhoneId: process.env.WHATSAPP_PHONE_ID || '',
    email: process.env.EMAIL_PROVIDER || 'log',
    smtp: {
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
      from: process.env.MAIL_FROM || 'no-reply@phoenixxit.com',
    },
    teamsWebhook: process.env.TEAMS_WEBHOOK_URL || '',
    // Browser pop-ups (Web Push). Without both keys the push channel is off and
    // every other channel works exactly as before.
    push: {
      publicKey: process.env.VAPID_PUBLIC_KEY || '',
      privateKey: process.env.VAPID_PRIVATE_KEY || '',
      subject: process.env.VAPID_SUBJECT || 'mailto:admin@phoenixxedu.com',
    },
  },

  billing: {
    razorpayKeyId: process.env.RAZORPAY_KEY_ID || '',
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET || '',
    stripeSecret: process.env.STRIPE_SECRET_KEY || '',
  },

  jobs: {
    enabled: bool(process.env.JOBS_ENABLED, true),
    tickMs: Number(process.env.JOB_TICK_MS || 60_000),
  },

  rateLimit: { windowMs: 60_000, max: 600 },
};

/**
 * The dev fallbacks above are conveniences, not defaults to ship. Signing
 * tokens with a secret that is published in this repo would let anyone mint a
 * session for any tenant, so production refuses to start with them.
 */
if (config.env === 'production') {
  const weak = Object.entries({
    JWT_ACCESS_SECRET: process.env.JWT_ACCESS_SECRET,
    JWT_REFRESH_SECRET: process.env.JWT_REFRESH_SECRET,
  }).filter(([, v]) => !v || v.length < 24 || /change-me|dev-/i.test(v));

  if (weak.length) {
    throw new Error(
      `Refusing to start: ${weak.map(([k]) => k).join(' and ')} must be set to a strong random value `
      + '(24+ characters). Generate one with: node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"',
    );
  }
}
