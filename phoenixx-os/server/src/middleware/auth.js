import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { get, all } from '../db/index.js';
import { ApiError, unauthorized, forbidden } from '../lib/http.js';
import { ROLE_SCOPE } from './rbac.js';

export function signAccessToken(user) {
  // AR1: the token carries tenant_id + role; every query is filtered by tenant.
  return jwt.sign(
    {
      sub: user.id,
      tid: user.tenant_id,
      role: user.role,
      crid: user.custom_role_id || null,
      name: user.name,
      cid: user.client_id || null,
    },
    config.jwt.accessSecret,
    { expiresIn: config.jwt.accessTtl, issuer: 'phoenixx-os' },
  );
}

export function signRefreshToken(user, jti) {
  return jwt.sign({ sub: user.id, tid: user.tenant_id, jti }, config.jwt.refreshSecret, {
    expiresIn: config.jwt.refreshTtl,
    issuer: 'phoenixx-os',
  });
}

export function verifyRefreshToken(tok) {
  try {
    return jwt.verify(tok, config.jwt.refreshSecret, { issuer: 'phoenixx-os' });
  } catch {
    throw unauthorized('Refresh token is invalid or expired');
  }
}

function readToken(req) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return null;
}

/** Populates req.auth. Rejects requests whose tenant is suspended/cancelled. */
export async function authenticate(req, _res, next) {
  const tok = readToken(req);
  if (!tok) return next(unauthorized());

  let payload;
  try {
    payload = jwt.verify(tok, config.jwt.accessSecret, { issuer: 'phoenixx-os' });
  } catch (err) {
    return next(new ApiError(401, err.name === 'TokenExpiredError' ? 'token_expired' : 'unauthorized',
      err.name === 'TokenExpiredError' ? 'Access token expired' : 'Invalid access token'));
  }

  const user = await get(
    'SELECT id, tenant_id, email, name, role, custom_role_id, manager_id, client_id, status, service_line_id FROM users WHERE id = ? AND deleted_at IS NULL',
    [payload.sub],
  );
  if (!user) return next(unauthorized('User no longer exists'));
  if (user.status === 'disabled') return next(forbidden('This account has been disabled'));

  req.auth = {
    userId: user.id,
    tenantId: user.tenant_id,
    email: user.email,
    name: user.name,
    role: user.role,
    customRoleId: user.custom_role_id,
    managerId: user.manager_id,
    clientId: user.client_id,
    serviceLineId: user.service_line_id,
    scope: ROLE_SCOPE[user.role] || 'own',
  };

  if (user.tenant_id) {
    const tenant = await get('SELECT id, name, status, timezone, currency, number_format, brand_primary, brand_accent, invoice_prefix, invoice_scheme, fy_start_month, state_code, gstin FROM tenants WHERE id = ? AND deleted_at IS NULL', [user.tenant_id]);
    if (!tenant) return next(unauthorized('Tenant not found'));
    req.tenant = tenant;

    const sub = await get(
      `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.features, p.limits, p.band_max_users
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
        WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`,
      [user.tenant_id],
    );
    req.subscription = sub || null;

    // S5: suspended tenants are read-only.
    const readOnly = sub && ['suspended', 'cancelled'].includes(sub.status);
    if (readOnly && !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      return next(new ApiError(402, 'subscription_read_only',
        `Subscription is ${sub.status}. The workspace is read-only until billing is restored.`));
    }
  }

  next();
}

/** Platform-only routes (Super Admin console, S9). */
export function requireSuperAdmin(req, _res, next) {
  if (req.auth?.role !== 'super_admin') return next(forbidden('Platform administrators only'));
  next();
}

/** S2: gate a route behind a plan feature flag. */
export function requireFeature(flag) {
  return async (req, _res, next) => {
    const features = req.subscription ? JSON.parse(req.subscription.features || '{}') : {};
    const override = await get('SELECT enabled FROM tenant_feature_flags WHERE tenant_id = ? AND flag_key = ?', [
      req.auth.tenantId, flag,
    ]);
    const enabled = override ? !!override.enabled : !!features[flag];
    if (!enabled) {
      return next(new ApiError(402, 'feature_not_in_plan',
        `"${flag}" is not available on the ${req.subscription?.plan_name || 'current'} plan`));
    }
    next();
  };
}

/**
 * Row visibility helper. Returns a SQL fragment + params restricting rows to
 * what the caller's scope allows for an owner-style column.
 */
export async function scopeFilter(req, ownerColumn = 'owner_id') {
  const { scope, userId } = req.auth;
  if (scope === 'all') return { where: '', params: [] };
  if (scope === 'team') {
    const team = (await all('SELECT id FROM users WHERE tenant_id = ? AND (manager_id = ? OR id = ?) AND deleted_at IS NULL',
      [req.auth.tenantId, userId, userId])).map((u) => u.id);
    const ids = team.length ? team : [userId];
    return { where: `${ownerColumn} IN (${ids.map(() => '?').join(',')})`, params: ids };
  }
  if (scope === 'client') return { where: 'client_id = ?', params: [req.auth.clientId || '__none__'] };
  return { where: `${ownerColumn} = ?`, params: [userId] };
}
