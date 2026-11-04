import { ApiError } from '../lib/http.js';
import { get, run } from '../db/index.js';
import { nowIso } from '../lib/util.js';
import { config } from '../config.js';

// ------------------------------------------------------------- rate limiting
// AR2: per-tenant rate limiting. In-memory sliding window; the production
// target swaps this for the Redis counter without changing call sites.
const buckets = new Map();

/**
 * `keyBy` overrides what the window counts against. The default - tenant, then
 * IP - is right for authenticated traffic, but an unauthenticated endpoint that
 * targets one named account (password recovery) wants a per-account window
 * instead: an office behind one NAT address should not exhaust the budget for
 * everybody, and spraying many accounts from one IP is what the per-account
 * lockout is there to stop.
 */
export function rateLimit({ windowMs = config.rateLimit.windowMs, max = config.rateLimit.max, keyBy } = {}) {
  return (req, res, next) => {
    const key = keyBy ? keyBy(req) : (req.auth?.tenantId || req.ip || 'anon');
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now > b.reset) {
      b = { count: 0, reset: now + windowMs };
      buckets.set(key, b);
    }
    b.count++;
    res.setHeader('X-RateLimit-Limit', max);
    res.setHeader('X-RateLimit-Remaining', Math.max(0, max - b.count));
    res.setHeader('X-RateLimit-Reset', Math.ceil(b.reset / 1000));
    if (b.count > max) {
      return next(new ApiError(429, 'rate_limited', 'Too many requests. Please slow down.'));
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k);
}, 60_000).unref?.();

// --------------------------------------------------------------- idempotency
/**
 * AR2: idempotency keys on payment/invoice endpoints. Replays the stored
 * response instead of creating a second record.
 */
export async function idempotency(req, res, next) {
  const key = req.headers['idempotency-key'];
  if (!key || !req.auth?.tenantId) return next();

  const endpoint = `${req.method} ${req.baseUrl}${req.path}`;
  const existing = await get(
    'SELECT response_json, status_code FROM idempotency_keys WHERE tenant_id = ? AND key = ? AND endpoint = ?',
    [req.auth.tenantId, key, endpoint],
  );
  if (existing?.response_json) {
    res.setHeader('Idempotent-Replay', 'true');
    return res.status(existing.status_code || 200).json(JSON.parse(existing.response_json));
  }

  const originalJson = res.json.bind(res);
  res.json = async (body) => {
    if (res.statusCode < 400) {
      try {
        await run(
          `INSERT INTO idempotency_keys (tenant_id, key, endpoint, response_json, status_code, created_at)
           VALUES (?,?,?,?,?,?)
           ON CONFLICT (tenant_id, key, endpoint) DO UPDATE SET response_json = excluded.response_json`,
          [req.auth.tenantId, key, endpoint, JSON.stringify(body), res.statusCode, nowIso()],
        );
      } catch { /* replay storage is best-effort */ }
    }
    return originalJson(body);
  };
  next();
}

// ------------------------------------------------------------- request logging
export function requestLog(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    if (req.path === '/api/v1/health') return;
    const line = {
      t: nowIso(),
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      ms: Math.round(ms),
      tenant: req.auth?.tenantId?.slice(0, 8) || '-',
      user: req.auth?.email || '-',
    };
    // Structured logs (NFR observability).
    console.log(JSON.stringify(line));
  });
  next();
}

// ------------------------------------------------------------- error handler
export function notFoundHandler(req, _res, next) {
  next(new ApiError(404, 'not_found', `No route for ${req.method} ${req.originalUrl}`));
}

// eslint-disable-next-line no-unused-vars -- Express identifies handlers by arity
export function errorHandler(err, req, res, _next) {
  const status = err.status || 500;
  if (status >= 500) console.error('[error]', err);
  res.status(status).json({
    error: {
      code: err.code || 'internal_error',
      message: status >= 500 && config.env === 'production' ? 'Something went wrong' : err.message,
      details: err.details,
    },
  });
}
