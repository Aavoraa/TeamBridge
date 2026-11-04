import { uuid, nowIso } from './util.js';
import { run } from '../db/index.js';

// --------------------------------------------------------------------- errors
export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}
export const badRequest = (msg, details) => new ApiError(400, 'bad_request', msg, details);
export const unauthorized = (msg = 'Authentication required') => new ApiError(401, 'unauthorized', msg);
export const forbidden = (msg = 'You do not have permission to do that') => new ApiError(403, 'forbidden', msg);
export const notFound = (what = 'Resource') => new ApiError(404, 'not_found', `${what} not found`);
export const conflict = (msg, details) => new ApiError(409, 'conflict', msg, details);
export const unprocessable = (msg, details) => new ApiError(422, 'unprocessable', msg, details);

// ------------------------------------------------------------------- envelope
// AR2: one consistent envelope across every endpoint.
export const ok = (res, data, meta) =>
  res.json(meta ? { data, meta } : { data });
export const created = (res, data) => res.status(201).json({ data });

export function paginate(req, { defaultLimit = 25, maxLimit = 200 } = {}) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(maxLimit, Math.max(1, Number(req.query.limit) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export const pageMeta = (page, limit, total) => ({
  page,
  limit,
  total,
  pages: Math.max(1, Math.ceil(total / limit)),
  has_more: page * limit < total,
});

/**
 * Whitelisted sort. `allowed` maps an API field name to a SQL expression, so a
 * client can never inject arbitrary SQL through ?sort=.
 */
export function sortClause(req, allowed, fallback) {
  const raw = String(req.query.sort || '');
  const desc = raw.startsWith('-');
  const key = desc ? raw.slice(1) : raw;
  const col = allowed[key];
  if (!col) return fallback;
  return `${col} ${desc ? 'DESC' : 'ASC'}`;
}

// ---------------------------------------------------------------------- audit
export async function audit(req, { entity, entityId, action, before, after }) {
  await run(
    `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_name, entity, entity_id, action,
       before_json, after_json, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      uuid(),
      req.auth?.tenantId ?? null,
      req.auth?.userId ?? null,
      req.auth?.name ?? null,
      entity,
      entityId ?? null,
      action,
      before ? JSON.stringify(before) : null,
      after ? JSON.stringify(after) : null,
      req.ip ?? null,
      nowIso(),
    ],
  );
}

// ------------------------------------------------------------------ validation
/** Zod-schema validator that raises a 422 with field-level details. */
export function validate(schema, payload) {
  const result = schema.safeParse(payload);
  if (!result.success) {
    const details = result.error.issues.map((i) => ({
      field: i.path.join('.') || '(root)',
      message: i.message,
    }));
    throw unprocessable('Validation failed', details);
  }
  return result.data;
}
