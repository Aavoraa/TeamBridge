import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { get, run, all } from '../db/index.js';
import { uuid, nowIso, sha256, token, parseJson } from '../lib/util.js';
import { ok, created, validate, unauthorized, badRequest, forbidden, audit, ApiError } from '../lib/http.js';
import {
  signAccessToken, signRefreshToken, verifyRefreshToken, authenticate,
} from '../middleware/auth.js';
import { permissionMatrix } from '../middleware/rbac.js';
import { onMarketingProject } from '../services/marketing.js';
import { provisionTenant } from '../services/provisioning.js';
import { rateLimit } from '../middleware/common.js';
import {
  SUGGESTED_QUESTIONS, QUESTION_MIN, QUESTION_MAX, ANSWER_MIN, ANSWER_MAX,
  hashAnswer, answerMatches, rejectWeakAnswer,
  MAX_ATTEMPTS, LOCKOUT_MINUTES, RESET_TOKEN_MINUTES,
} from '../lib/securityQuestions.js';

const router = Router();

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp: z.string().optional(),
});

const signupSchema = z.object({
  agency_name: z.string().min(2).max(120),
  owner_name: z.string().min(2).max(120),
  email: z.string().email(),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  phone: z.string().optional(),
  city: z.string().optional(),
  plan_code: z.enum(['starter', 'growth', 'scale']).optional(),
  // Optional on the API so an existing integration keeps working; the signup
  // form asks for both, because an owner locked out of the workspace they just
  // created has nobody above them to reset it.
  security_question: z.string().min(QUESTION_MIN).max(QUESTION_MAX).optional(),
  security_answer: z.string().min(ANSWER_MIN).max(ANSWER_MAX).optional(),
});

async function sessionPayload(user) {
  const tenant = user.tenant_id
    ? await get('SELECT id, name, slug, timezone, currency, number_format, brand_primary, brand_accent, logo_url, invoice_prefix, invoice_scheme, fy_start_month, state_code, gstin, city, address, phone, email, settings FROM tenants WHERE id = ?', [user.tenant_id])
    : null;
  const subscription = user.tenant_id
    ? await get(`SELECT s.status, s.billing_cycle, s.trial_ends_at, s.current_period_end, p.code AS plan_code,
                  p.name AS plan_name, p.features, p.limits, p.band_max_users
             FROM subscriptions s JOIN plans p ON p.id = s.plan_id
            WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`, [user.tenant_id])
    : null;

  return {
    user: {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      designation: user.designation,
      avatar_url: user.avatar_url,
      phone: user.phone,
      manager_id: user.manager_id,
      service_line_id: user.service_line_id,
      client_id: user.client_id,
      twofa_enabled: !!user.twofa_enabled,
      notification_prefs: parseJson(user.notification_prefs, {}),
    },
    tenant: tenant ? { ...tenant, settings: parseJson(tenant.settings, {}) } : null,
    /** Opens Marketing leads for someone on a marketing project's team, CRM access or not. */
    on_marketing_project: user.tenant_id ? await onMarketingProject({ userId: user.id, tenantId: user.tenant_id, role: user.role }) : false,
    subscription: subscription
      ? {
        ...subscription,
        features: parseJson(subscription.features, {}),
        limits: parseJson(subscription.limits, {}),
      }
      : null,
    permissions: await permissionMatrix({
      userId: user.id,
      tenantId: user.tenant_id,
      role: user.role,
      customRoleId: user.custom_role_id,
    }),
  };
}

async function issueSession(res, user, req) {
  const jti = uuid();
  const refresh = signRefreshToken(user, jti);
  await run(
    `INSERT INTO refresh_tokens (id, user_id, tenant_id, token_hash, expires_at, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?)`,
    [jti, user.id, user.tenant_id, sha256(refresh),
      new Date(Date.now() + 30 * 86_400_000).toISOString(),
      req.headers['user-agent'] || null, nowIso()],
  );
  await run('UPDATE users SET last_login_at = ? WHERE id = ?', [nowIso(), user.id]);
  return { access_token: signAccessToken(user), refresh_token: refresh, ...await sessionPayload(user) };
}

// ------------------------------------------------------------------- signup
// S7: tenant self-signup wizard, 14-day trial, no card.
router.post('/signup', rateLimit({ max: 10, windowMs: 60 * 60_000 }), async (req, res) => {
  const body = validate(signupSchema, req.body);
  const { tenantId, ownerId } = await provisionTenant({
    agencyName: body.agency_name,
    ownerName: body.owner_name,
    ownerEmail: body.email.toLowerCase(),
    password: body.password,
    phone: body.phone,
    city: body.city,
    planCode: body.plan_code || 'growth',
  });

  if (body.security_question && body.security_answer) {
    await setSecurityQuestion(ownerId, body.security_question, body.security_answer);
  }

  const user = await get('SELECT * FROM users WHERE id = ?', [ownerId]);
  req.auth = { tenantId, userId: ownerId, name: user.name };
  await audit(req, { entity: 'tenant', entityId: tenantId, action: 'create', after: { name: body.agency_name } });

  return created(res, await issueSession(res, user, req));
});

// -------------------------------------------------------------------- login
router.post('/login', rateLimit({ max: 20, windowMs: 15 * 60_000 }), async (req, res) => {
  const { email, password, totp } = validate(loginSchema, req.body);
  const user = await get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', [email.toLowerCase()]);

  // Constant-ish work whether or not the account exists.
  const hash = user?.password_hash
    || '$2b$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidin';
  const valid = bcrypt.compareSync(password, hash);

  if (!user) {
    // Signed up through a join link but not approved yet: say so - only to
    // someone who knows the password they chose, so nothing leaks to others.
    const pending = await get(
      `SELECT r.password_hash, t.name AS workspace FROM join_requests r JOIN tenants t ON t.id = r.tenant_id
        WHERE r.email = ? AND r.status = 'pending' ORDER BY r.created_at DESC LIMIT 1`,
      [email.toLowerCase()],
    );
    if (pending?.password_hash && bcrypt.compareSync(password, pending.password_hash)) {
      throw new ApiError(403, 'pending_approval',
        `Your request to join ${pending.workspace} is waiting for approval from the owner, HR or a manager. You can sign in once it is approved.`);
    }
  }
  if (!user || !valid) throw unauthorized('Email or password is incorrect');
  if (user.status === 'disabled') throw forbidden('This account has been disabled');

  // NFR security: 2FA (TOTP) for Admin/Finance.
  if (user.twofa_enabled) {
    if (!totp) throw new ApiError(401, 'totp_required', 'Enter the 6-digit code from your authenticator app');
    if (!verifyTotp(user.twofa_secret, totp)) throw unauthorized('That code is not valid');
  }

  req.auth = { tenantId: user.tenant_id, userId: user.id, name: user.name };
  await audit(req, { entity: 'user', entityId: user.id, action: 'login' });

  return ok(res, await issueSession(res, user, req));
});

// ------------------------------------------------------------------ refresh
router.post('/refresh', async (req, res) => {
  const { refresh_token: refreshToken } = req.body || {};
  if (!refreshToken) throw badRequest('refresh_token is required');

  const payload = verifyRefreshToken(refreshToken);
  const stored = await get('SELECT * FROM refresh_tokens WHERE id = ?', [payload.jti]);
  if (!stored || stored.revoked_at || stored.token_hash !== sha256(refreshToken)) {
    throw unauthorized('Refresh token has been revoked');
  }
  if (stored.expires_at < nowIso()) throw unauthorized('Refresh token expired');

  const user = await get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [payload.sub]);
  if (!user) throw unauthorized('User no longer exists');

  // Rotate: the presented token is retired as the new one is issued.
  await run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [nowIso(), payload.jti]);
  return ok(res, await issueSession(res, user, req));
});

// ------------------------------------------------------------------- logout
router.post('/logout', async (req, res) => {
  const { refresh_token: refreshToken } = req.body || {};
  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      await run('UPDATE refresh_tokens SET revoked_at = ? WHERE id = ?', [nowIso(), payload.jti]);
    } catch { /* already invalid - nothing to revoke */ }
  }
  return ok(res, { ok: true });
});

// ---------------------------------------------------------------------- me
router.get('/me', authenticate, async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  return ok(res, await sessionPayload(user));
});

router.patch('/me', authenticate, async (req, res) => {
  const schema = z.object({
    name: z.string().min(1).optional(),
    phone: z.string().optional(),
    whatsapp: z.string().optional(),
    avatar_url: z.string().optional(),
    notification_prefs: z.record(z.string(), z.any()).optional(),
  });
  const body = validate(schema, req.body);
  const fields = { ...body, updated_at: nowIso() };
  if (body.notification_prefs) fields.notification_prefs = JSON.stringify(body.notification_prefs);

  const cols = Object.keys(fields);
  await run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => fields[c]), req.auth.userId]);

  const user = await get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  return ok(res, await sessionPayload(user));
});

router.post('/change-password', authenticate, async (req, res) => {
  const schema = z.object({ current_password: z.string(), new_password: z.string().min(8) });
  const body = validate(schema, req.body);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);

  if (!bcrypt.compareSync(body.current_password, user.password_hash)) {
    throw badRequest('Your current password is incorrect');
  }
  await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    [bcrypt.hashSync(body.new_password, 10), nowIso(), user.id]);
  await run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    [nowIso(), user.id]);

  await audit(req, { entity: 'user', entityId: user.id, action: 'update', after: { password: 'changed' } });
  return ok(res, { ok: true, message: 'Password changed. Other sessions have been signed out.' });
});

router.get('/sessions', authenticate, async (req, res) => ok(res, await all(
  `SELECT id, user_agent, created_at, expires_at, revoked_at FROM refresh_tokens
    WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
  [req.auth.userId],
)));

// ---------------------------------------------------------------------- 2FA
// RFC 6238 TOTP over SHA-1, 30-second step, 6 digits - what authenticator apps expect.
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input) {
  let bits = '';
  for (const ch of input.replace(/=+$/, '').toUpperCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function base32Encode(buf) {
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += BASE32[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

function totpAt(secret, counter) {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
    | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

export function verifyTotp(secret, code) {
  if (!secret || !code) return false;
  const counter = Math.floor(Date.now() / 30_000);
  // +/- one step tolerance for clock drift.
  return [-1, 0, 1].some((d) => totpAt(secret, counter + d) === String(code).trim());
}

router.post('/2fa/setup', authenticate, async (req, res) => {
  const secret = base32Encode(crypto.randomBytes(20));
  await run('UPDATE users SET twofa_secret = ?, updated_at = ? WHERE id = ?', [secret, nowIso(), req.auth.userId]);
  const label = encodeURIComponent(`Phoenixx OS:${req.auth.email}`);
  return ok(res, {
    secret,
    otpauth_url: `otpauth://totp/${label}?secret=${secret}&issuer=Phoenixx%20OS&algorithm=SHA1&digits=6&period=30`,
  });
});

router.post('/2fa/enable', authenticate, async (req, res) => {
  const { code } = validate(z.object({ code: z.string().length(6) }), req.body);
  const user = await get('SELECT twofa_secret FROM users WHERE id = ?', [req.auth.userId]);
  if (!verifyTotp(user.twofa_secret, code)) throw badRequest('That code is not valid. Try the next one.');

  await run('UPDATE users SET twofa_enabled = 1, updated_at = ? WHERE id = ?', [nowIso(), req.auth.userId]);
  await audit(req, { entity: 'user', entityId: req.auth.userId, action: 'update', after: { twofa: 'enabled' } });
  return ok(res, { twofa_enabled: true });
});

router.post('/2fa/disable', authenticate, async (req, res) => {
  const { password } = validate(z.object({ password: z.string() }), req.body);
  const user = await get('SELECT password_hash FROM users WHERE id = ?', [req.auth.userId]);
  if (!bcrypt.compareSync(password, user.password_hash)) throw badRequest('Password is incorrect');

  await run('UPDATE users SET twofa_enabled = 0, twofa_secret = NULL, updated_at = ? WHERE id = ?',
    [nowIso(), req.auth.userId]);
  return ok(res, { twofa_enabled: false });
});

// ----------------------------------------------------------- invite accept
router.post('/accept-invite', async (req, res) => {
  const schema = z.object({
    token: z.string(),
    password: z.string().min(8),
    name: z.string().optional(),
    // Required here and nowhere else. This is the one moment a workspace user
    // sets their own account up, and asking later means most people never do.
    security_question: z.string().min(QUESTION_MIN).max(QUESTION_MAX),
    security_answer: z.string().min(ANSWER_MIN).max(ANSWER_MAX),
  });
  const body = validate(schema, req.body);
  const user = await get("SELECT * FROM users WHERE invite_token = ? AND status = 'invited' AND deleted_at IS NULL",
    [body.token]);
  if (!user) throw badRequest('This invitation is invalid or has already been used');

  const weak = rejectWeakAnswer(body.security_question, body.security_answer);
  if (weak) throw badRequest(weak, [{ field: 'security_answer', message: weak }]);

  await run(
    `UPDATE users SET password_hash = ?, name = COALESCE(?, name), status = 'active',
       invite_token = NULL, updated_at = ? WHERE id = ?`,
    [bcrypt.hashSync(body.password, 10), body.name || null, nowIso(), user.id],
  );
  await setSecurityQuestion(user.id, body.security_question, body.security_answer);
  const fresh = await get('SELECT * FROM users WHERE id = ?', [user.id]);
  return ok(res, await issueSession(res, fresh, req));
});

/* ==========================================================================
 * Security-question account recovery
 *
 * Three steps, deliberately separate requests: ask for the question, answer it,
 * then set a new password. The middle step is the only one that can fail in a
 * way worth counting, and the token it hands out is what authorises the third -
 * so the new password never travels alongside the answer, and a leaked answer
 * on its own buys an attacker RESET_TOKEN_MINUTES.
 *
 * Enumeration: showing somebody their own question necessarily confirms the
 * address is registered. That is inherent to the feature, so the goal here is
 * the narrower one - every OTHER outcome (no such user, no question set,
 * disabled account) returns the same `available: false` shape, and the answer
 * step never says which part was wrong.
 * ========================================================================== */

/** Writes the question and the hashed answer, clearing any recovery in flight. */
async function setSecurityQuestion(userId, question, answer) {
  const ts = nowIso();
  await run(
    `UPDATE users SET security_question = ?, security_answer_hash = ?, security_updated_at = ?,
       recovery_failed_attempts = 0, recovery_locked_until = NULL,
       recovery_token = NULL, recovery_token_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
    [question.trim(), hashAnswer(answer), ts, ts, userId],
  );
  return ts;
}

const lockedUntil = (user) => (user.recovery_locked_until && user.recovery_locked_until > nowIso()
  ? user.recovery_locked_until
  : null);

/** The suggestion list for the pickers. Public: it is the same for everyone. */
router.get('/security-questions', (req, res) => ok(res, { questions: SUGGESTED_QUESTIONS }));

/** What the signed-in user has set, if anything. The answer is never returned. */
router.get('/security-question', authenticate, async (req, res) => {
  const user = await get('SELECT security_question, security_updated_at FROM users WHERE id = ?', [req.auth.userId]);
  return ok(res, {
    configured: !!user?.security_question,
    question: user?.security_question || null,
    updated_at: user?.security_updated_at || null,
  });
});

/**
 * Set or change it. The current password is required: a hijacked session must
 * not be able to quietly plant a recovery answer the real owner does not know.
 */
router.put('/security-question', authenticate, async (req, res) => {
  const schema = z.object({
    question: z.string().min(QUESTION_MIN).max(QUESTION_MAX),
    answer: z.string().min(ANSWER_MIN).max(ANSWER_MAX),
    password: z.string().min(1),
  });
  const body = validate(schema, req.body);
  const user = await get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);

  if (!bcrypt.compareSync(body.password, user.password_hash)) {
    throw badRequest('Your password is incorrect', [{ field: 'password', message: 'Your password is incorrect' }]);
  }
  const weak = rejectWeakAnswer(body.question, body.answer);
  if (weak) throw badRequest(weak, [{ field: 'answer', message: weak }]);

  const updatedAt = await setSecurityQuestion(user.id, body.question, body.answer);
  await audit(req, { entity: 'user', entityId: user.id, action: 'update', after: { security_question: 'set' } });
  return ok(res, { configured: true, question: body.question.trim(), updated_at: updatedAt });
});

// Recovery is unauthenticated and always aimed at one named account, so the
// window is counted per account rather than per IP: a whole office behind one
// address must not be able to exhaust each other's budget, and spraying many
// accounts from one IP is what the per-row lockout below already stops.
const recoveryLimit = rateLimit({
  max: 20,
  windowMs: 15 * 60_000,
  keyBy: (req) => `recovery:${String(req.body?.email || req.body?.reset_token || req.ip || '').toLowerCase()}`,
});

const UNAVAILABLE = 'No security question is set up for that email. Ask an owner or HR to reset your password.';

/** Step 1 - hand back the question to answer. */
router.post('/recovery/start', recoveryLimit, async (req, res) => {
  const { email } = validate(z.object({ email: z.string().email() }), req.body);
  const user = await get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', [email.toLowerCase()]);

  if (!user || user.status === 'disabled' || !user.security_question) {
    return ok(res, { available: false, message: UNAVAILABLE });
  }
  // Only reachable by someone who already got the question out of this same
  // endpoint, so naming the lockout reveals nothing step 1 has not revealed.
  const locked = lockedUntil(user);
  if (locked) {
    return ok(res, {
      available: false,
      locked: true,
      locked_until: locked,
      message: 'Too many wrong answers. Recovery is locked for a few minutes.',
    });
  }
  return ok(res, {
    available: true,
    question: user.security_question,
    totp_required: !!user.twofa_enabled,
  });
});

/** Step 2 - check the answer and issue a short-lived, single-use reset token. */
router.post('/recovery/verify', recoveryLimit, async (req, res) => {
  const body = validate(z.object({
    email: z.string().email(),
    answer: z.string().min(1).max(ANSWER_MAX),
    totp: z.string().optional(),
  }), req.body);
  const user = await get('SELECT * FROM users WHERE email = ? AND deleted_at IS NULL', [body.email.toLowerCase()]);

  if (!user || user.status === 'disabled' || !user.security_answer_hash) throw badRequest(UNAVAILABLE);

  const locked = lockedUntil(user);
  if (locked) {
    throw new ApiError(429, 'recovery_locked',
      'Too many wrong answers. Recovery is locked for a few minutes.',
      [{ field: 'answer', locked_until: locked }]);
  }

  if (!answerMatches(body.answer, user.security_answer_hash)) {
    const attempts = Number(user.recovery_failed_attempts || 0) + 1;
    const lockTo = attempts >= MAX_ATTEMPTS
      ? new Date(Date.now() + LOCKOUT_MINUTES * 60_000).toISOString()
      : null;
    await run('UPDATE users SET recovery_failed_attempts = ?, recovery_locked_until = ? WHERE id = ?',
      [attempts, lockTo, user.id]);

    if (lockTo) {
      throw new ApiError(429, 'recovery_locked',
        `That answer is not right. Recovery is locked for ${LOCKOUT_MINUTES} minutes.`,
        [{ field: 'answer', locked_until: lockTo }]);
    }
    const left = MAX_ATTEMPTS - attempts;
    throw badRequest(
      `That answer is not right. ${left} more ${left === 1 ? 'try' : 'tries'} before recovery locks.`,
      [{ field: 'answer', message: 'That answer is not right' }],
    );
  }

  // A question is a weak factor and must never stand in for the second one.
  if (user.twofa_enabled) {
    if (!body.totp) throw new ApiError(401, 'totp_required', 'Enter the 6-digit code from your authenticator app');
    if (!verifyTotp(user.twofa_secret, body.totp)) throw unauthorized('That code is not valid');
  }

  const raw = token(24);
  const expiresAt = new Date(Date.now() + RESET_TOKEN_MINUTES * 60_000).toISOString();
  await run(
    `UPDATE users SET recovery_token = ?, recovery_token_expires_at = ?,
       recovery_failed_attempts = 0, recovery_locked_until = NULL WHERE id = ?`,
    [sha256(raw), expiresAt, user.id],
  );

  req.auth = { tenantId: user.tenant_id, userId: user.id, name: user.name };
  await audit(req, { entity: 'user', entityId: user.id, action: 'update', after: { recovery: 'answer verified' } });

  return ok(res, { reset_token: raw, expires_at: expiresAt });
});

/**
 * Step 3 - set the new password. No session is issued: an account with 2FA on
 * must still go through the authenticator at the next sign-in, and signing
 * somebody in here would skip it.
 */
router.post('/recovery/reset', recoveryLimit, async (req, res) => {
  const body = validate(z.object({
    reset_token: z.string().min(1),
    new_password: z.string().min(8, 'Password must be at least 8 characters'),
  }), req.body);

  const user = await get('SELECT * FROM users WHERE recovery_token = ? AND deleted_at IS NULL', [sha256(body.reset_token)]);
  if (!user || !user.recovery_token_expires_at || user.recovery_token_expires_at <= nowIso()) {
    throw badRequest('This recovery session has expired. Start again from the sign-in page.');
  }
  if (user.status === 'disabled') throw forbidden('This account has been disabled');

  await run(
    `UPDATE users SET password_hash = ?, recovery_token = NULL, recovery_token_expires_at = NULL,
       recovery_failed_attempts = 0, recovery_locked_until = NULL, updated_at = ? WHERE id = ?`,
    [bcrypt.hashSync(body.new_password, 10), nowIso(), user.id],
  );
  // Whoever was signed in as this account no longer should be.
  await run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), user.id]);

  req.auth = { tenantId: user.tenant_id, userId: user.id, name: user.name };
  await audit(req, { entity: 'user', entityId: user.id, action: 'update', after: { password: 'reset via security question' } });

  return ok(res, {
    ok: true,
    message: 'Password updated. Sign in with your new password - every other session has been signed out.',
  });
});

export { router as authRouter, sessionPayload };
