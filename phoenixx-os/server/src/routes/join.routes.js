import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso, token } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, conflict, forbidden, audit } from '../lib/http.js';
import { config } from '../config.js';
import { notifyRole } from '../services/notifications.js';
import { approvedEmail, emailConfigured, joinInviteEmail, sendMail } from '../services/mailer.js';
import {
  QUESTION_MIN, QUESTION_MAX, ANSWER_MIN, ANSWER_MAX, hashAnswer, rejectWeakAnswer,
} from '../lib/securityQuestions.js';

/**
 * Invite -> sign up -> owner or HR approves.
 *
 * The owner invites specific people by email. Each gets a personal, one-use
 * link (join_invites). Opening it, the person creates their own account - name,
 * role, designation, password - for that email only. Nothing is granted yet:
 * the sign-up waits in join_requests until the owner approves it (optionally
 * changing the role or adding a manager), and only then does a real user exist.
 */
const JOIN_ROLES = ['manager', 'employee', 'finance', 'hr'];
/** Who invites people and approves their sign-ups. */
const ONBOARDERS = ['owner', 'hr'];
/** Managers also decide sign-ups, but only for people joining as an employee. */
const DECIDERS = [...ONBOARDERS, 'manager'];
const ROLE_LABEL = { manager: 'Manager', employee: 'Employee', finance: 'Finance', hr: 'HR' };

const joinUrl = (t) => `${config.webBaseUrl}/join/${t}`;

/** A live personal invitation and its workspace, or null. */
async function inviteForToken(t) {
  if (!t || t.length < 16) return null;
  return get(
    `SELECT i.id, i.tenant_id, i.email, i.name, t.name AS workspace, t.logo_url, u.name AS invited_by
       FROM join_invites i
       JOIN tenants t ON t.id = i.tenant_id AND t.deleted_at IS NULL AND t.status = 'active'
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token = ? AND i.status = 'sent'`,
    [t],
  );
}

// ======================================================= public (no sign-in)
export const publicJoinRouter = Router();

publicJoinRouter.get('/:token', async (req, res) => {
  const inv = await inviteForToken(req.params.token);
  if (!inv) throw notFound('Invitation');
  return ok(res, {
    workspace: inv.workspace, logo_url: inv.logo_url, invited_by: inv.invited_by,
    email: inv.email, name: inv.name, roles: JOIN_ROLES,
  });
});

const requestSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name').max(120),
  phone: z.string().trim().max(20).optional().nullable(),
  role: z.enum(JOIN_ROLES, { message: 'Choose your role' }),
  designation: z.string().trim().max(120).optional().nullable(),
  department: z.string().trim().max(80).optional().nullable(),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  security_question: z.string().trim().min(QUESTION_MIN).max(QUESTION_MAX),
  security_answer: z.string().trim().min(ANSWER_MIN).max(ANSWER_MAX),
});

publicJoinRouter.post('/:token', async (req, res) => {
  const inv = await inviteForToken(req.params.token);
  if (!inv) throw notFound('Invitation');
  const body = validate(requestSchema, req.body);

  const weak = rejectWeakAnswer(body.security_question, body.security_answer);
  if (weak) throw badRequest(weak, [{ field: 'security_answer', message: weak }]);

  // The account is for the invited address - never one typed in on the form.
  const email = inv.email;
  if (await get('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [email])) {
    throw conflict('This email already has a TeamBridge account. Sign in instead.');
  }
  if (await get("SELECT id FROM join_requests WHERE tenant_id = ? AND email = ? AND status = 'pending'", [inv.tenant_id, email])) {
    throw conflict('Your account is already waiting for approval.');
  }

  const id = uuid();
  const ts = nowIso();
  await run(
    `INSERT INTO join_requests (id, tenant_id, invite_id, name, email, phone, requested_role, designation, department,
       password_hash, security_question, security_answer_hash, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, inv.tenant_id, inv.id, body.name, email, body.phone || null, body.role, body.designation || null,
      body.department || null, bcrypt.hashSync(body.password, 10), body.security_question,
      hashAnswer(body.security_answer), 'pending', ts, ts],
  );
  // One use: the link stops working the moment the account is created.
  await run("UPDATE join_invites SET status = 'used', used_at = ?, request_id = ?, updated_at = ? WHERE id = ?",
    [ts, id, ts, inv.id]);

  await notifyRole({
    tenantId: inv.tenant_id,
    roles: body.role === 'employee' ? DECIDERS : ONBOARDERS,
    eventKey: 'team.join_request',
    channels: ['in_app', 'email'],
    link: '/team?tab=requests',
    vars: {
      person: body.name, email, role: ROLE_LABEL[body.role],
      designation: body.designation ? `, ${body.designation}` : '',
    },
  }).catch(() => {}); // a notification hiccup must not lose the sign-up

  return created(res, { status: 'pending', workspace: inv.workspace, email });
});

// ================================================== owner and HR (signed in)
export const joinAdminRouter = Router();

/**
 * The workspace owner (founder) and HR invite people and decide requests. A
 * paid add-on seat beyond the plan stays the owner's call (see approve).
 */
function onboardersOnly(req) {
  if (!ONBOARDERS.includes(req.auth.role)) throw forbidden('Only the workspace owner or HR can invite people and approve them');
}

/** Who decides sign-ups: the owner and HR for any role, a manager for employees. */
function decidersOnly(req) {
  if (!DECIDERS.includes(req.auth.role)) throw forbidden('Only the owner, HR or a manager can approve people joining');
}
const MANAGER_LIMIT = 'A manager approves people joining as an employee. The owner or HR decides Manager, Finance and HR roles.';
function managerMayDecide(req, ...roles) {
  if (req.auth.role === 'manager' && roles.some((r) => r && r !== 'employee')) throw forbidden(MANAGER_LIMIT);
}

async function sendInviteEmail(req, invite) {
  if (!emailConfigured()) return { email_status: 'not_configured', email_error: null };
  const [tenant, me] = await Promise.all([
    get('SELECT name FROM tenants WHERE id = ?', [req.auth.tenantId]),
    get('SELECT name, email FROM users WHERE id = ?', [req.auth.userId]),
  ]);
  const sent = await sendMail({
    to: invite.email,
    replyTo: me?.email,
    ...joinInviteEmail({ name: invite.name, workspace: tenant?.name || 'our team', invitedBy: me?.name, url: joinUrl(invite.token) }),
  });
  return sent.ok ? { email_status: 'sent', email_error: null } : { email_status: 'failed', email_error: sent.error };
}

// Rows are checked one by one below, so one bad address never blocks the rest.
const inviteSchema = z.object({
  people: z.array(z.any()).min(1, 'Add at least one email').max(200, 'Up to 200 people at a time'),
});

/**
 * Invite people by email. Each address gets its own one-use link, emailed when
 * a mail server is set up; the links come back either way so they can also be
 * sent over WhatsApp. Inviting an address that already has a live invitation
 * sends it again with a fresh link.
 */
joinAdminRouter.post('/invites', async (req, res) => {
  onboardersOnly(req);
  const { people } = validate(inviteSchema, req.body);
  const { tenantId } = req.auth;
  const results = [];
  const seen = new Set();

  for (const [i, raw] of people.entries()) {
    const email = String(raw?.email || '').trim().toLowerCase();
    const name = String(raw?.name || '').trim() || null;
    const row = { row: i + 1, email, name };
    if (!/^\S+@\S+\.\S+$/.test(email)) { results.push({ ...row, status: 'skipped', reason: 'Not a valid email' }); continue; }
    if (seen.has(email)) { results.push({ ...row, status: 'skipped', reason: 'Listed twice' }); continue; }
    seen.add(email);
    if (await get('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [email])) {
      results.push({ ...row, status: 'skipped', reason: 'Already has an account' }); continue;
    }
    if (await get("SELECT id FROM join_requests WHERE tenant_id = ? AND email = ? AND status = 'pending'", [tenantId, email])) {
      results.push({ ...row, status: 'skipped', reason: 'Already signed up - waiting for your approval' }); continue;
    }

    const ts = nowIso();
    const t = token(24);
    const live = await get("SELECT id FROM join_invites WHERE tenant_id = ? AND email = ? AND status = 'sent'", [tenantId, email]);
    let id;
    if (live) {
      id = live.id;
      await run('UPDATE join_invites SET token = ?, name = COALESCE(?, name), invited_by = ?, updated_at = ? WHERE id = ?',
        [t, name, req.auth.userId, ts, id]);
    } else {
      id = uuid();
      await run(
        `INSERT INTO join_invites (id, tenant_id, email, name, token, status, invited_by, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, email, name, t, 'sent', req.auth.userId, ts, ts],
      );
    }
    const mail = await sendInviteEmail(req, { email, name, token: t });
    results.push({ ...row, id, status: live ? 'resent' : 'invited', invite_url: joinUrl(t), ...mail });
  }

  await audit(req, {
    entity: 'join_invite', entityId: tenantId, action: 'create',
    after: { invited: results.filter((r) => r.invite_url).map((r) => r.email) },
  });
  const sentCount = results.filter((r) => r.invite_url).length;
  const summary = {
    invited: sentCount,
    skipped: results.length - sentCount,
    emailed: results.filter((r) => r.email_status === 'sent').length,
    email_configured: emailConfigured(),
    results,
  };
  return sentCount ? created(res, summary) : ok(res, summary);
});

/** Invitations not used yet - the people who have not created their account. */
joinAdminRouter.get('/invites', async (req, res) => {
  onboardersOnly(req);
  return ok(res, await all(
    `SELECT i.id, i.email, i.name, i.token, i.created_at, i.updated_at, u.name AS invited_by_name
       FROM join_invites i LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.tenant_id = ? AND i.status = 'sent'
      ORDER BY i.updated_at DESC LIMIT 500`,
    [req.auth.tenantId],
  ).then((rows) => rows.map(({ token: t, ...r }) => ({ ...r, invite_url: joinUrl(t) }))));
});

async function liveInvite(req) {
  const inv = await get("SELECT * FROM join_invites WHERE id = ? AND tenant_id = ? AND status = 'sent'",
    [req.params.id, req.auth.tenantId]);
  if (!inv) throw notFound('Open invitation');
  return inv;
}

/** Send again with a fresh link (the old one stops working). */
joinAdminRouter.post('/invites/:id/resend', async (req, res) => {
  onboardersOnly(req);
  const inv = await liveInvite(req);
  const t = token(24);
  await run('UPDATE join_invites SET token = ?, updated_at = ? WHERE id = ?', [t, nowIso(), inv.id]);
  const mail = await sendInviteEmail(req, { ...inv, token: t });
  return ok(res, { id: inv.id, invite_url: joinUrl(t), ...mail });
});

joinAdminRouter.post('/invites/:id/revoke', async (req, res) => {
  onboardersOnly(req);
  const inv = await liveInvite(req);
  await run("UPDATE join_invites SET status = 'revoked', updated_at = ? WHERE id = ?", [nowIso(), inv.id]);
  await audit(req, { entity: 'join_invite', entityId: inv.id, action: 'delete', after: { email: inv.email } });
  return ok(res, { id: inv.id, status: 'revoked' });
});

// ---------------------------------------------------------------- requests
joinAdminRouter.get('/requests', async (req, res) => {
  decidersOnly(req);
  const status = ['pending', 'approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  // A manager sees only the employee sign-ups, the ones they can decide.
  const onlyEmployees = req.auth.role === 'manager' ? " AND r.requested_role = 'employee'" : '';
  const rows = await all(
    `SELECT r.id, r.name, r.email, r.phone, r.requested_role, r.designation, r.department, r.status,
            r.decision_note, r.decided_at, r.created_at, r.user_id, d.name AS decided_by_name
       FROM join_requests r LEFT JOIN users d ON d.id = r.decided_by
      WHERE r.tenant_id = ? AND r.status = ?${onlyEmployees}
      ORDER BY r.created_at DESC LIMIT 200`,
    [req.auth.tenantId, status],
  );
  const pending = Number((await get(
    `SELECT COUNT(*) AS n FROM join_requests r WHERE r.tenant_id = ? AND r.status = 'pending'${onlyEmployees}`, [req.auth.tenantId],
  ))?.n || 0);
  return ok(res, rows, { pending });
});

async function pendingRequest(req) {
  const r = await get("SELECT * FROM join_requests WHERE id = ? AND tenant_id = ? AND status = 'pending'",
    [req.params.id, req.auth.tenantId]);
  if (!r) throw notFound('Pending join request');
  return r;
}

const approveSchema = z.object({
  role: z.enum(JOIN_ROLES).optional(),
  manager_id: z.string().optional().nullable(),
  designation: z.string().trim().max(120).optional().nullable(),
  department: z.string().trim().max(80).optional().nullable(),
});

joinAdminRouter.post('/requests/:id/approve', async (req, res) => {
  decidersOnly(req);
  const r = await pendingRequest(req);
  const body = validate(approveSchema, req.body || {});
  const { tenantId } = req.auth;
  managerMayDecide(req, r.requested_role, body.role);
  // A manager who approves someone becomes their manager unless they pick another.
  if (req.auth.role === 'manager' && !body.manager_id) body.manager_id = req.auth.userId;

  if (await get('SELECT id FROM users WHERE email = ? AND deleted_at IS NULL', [r.email])) {
    throw conflict('Someone with this email already has an account. Reject this request instead.');
  }
  if (body.manager_id && !await get(
    "SELECT id FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND role != 'client'", [body.manager_id, tenantId],
  )) throw badRequest('That manager is not in this workspace');

  // Same seat rule as adding someone by hand.
  const seatCount = Number((await get(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client' AND status != 'disabled'",
    [tenantId],
  ))?.n || 0);
  const bandMax = req.subscription?.band_max_users;
  if (bandMax && seatCount >= bandMax && req.query.allow_addon === 'true' && req.auth.role !== 'owner') {
    throw forbidden(`The plan's ${bandMax} users are all taken. Adding a paid seat is the workspace owner's decision - ask them to approve this one.`);
  }
  if (bandMax && seatCount >= bandMax && req.query.allow_addon !== 'true') {
    throw badRequest(
      `The ${req.subscription.plan_name} plan covers up to ${bandMax} users and you have ${seatCount}. Upgrade, or re-send with ?allow_addon=true to add a per-user add-on seat.`,
    );
  }

  const role = body.role || r.requested_role;
  const userId = uuid();
  const ts = nowIso();
  await run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, phone, whatsapp, role, designation, department,
       manager_id, employment_type, date_of_joining, status, security_question, security_answer_hash,
       security_updated_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [userId, tenantId, r.email, r.password_hash, r.name, r.phone, r.phone, role,
      body.designation !== undefined ? body.designation || null : r.designation,
      body.department !== undefined ? body.department || null : r.department,
      body.manager_id || null, 'full_time', ts.slice(0, 10), 'active',
      r.security_question, r.security_answer_hash, r.security_question ? ts : null, ts, ts],
  );
  await run(
    "UPDATE join_requests SET status = 'approved', decided_by = ?, decided_at = ?, user_id = ?, updated_at = ? WHERE id = ?",
    [req.auth.userId, ts, userId, ts, r.id],
  );
  await audit(req, {
    entity: 'user', entityId: userId, action: 'create',
    after: { email: r.email, role, onboarding: 'invited, signed up, approved', requested_role: r.requested_role },
  });

  let email_status = 'not_configured';
  if (emailConfigured()) {
    const tenant = await get('SELECT name FROM tenants WHERE id = ?', [tenantId]);
    const sent = await sendMail({
      to: r.email,
      ...approvedEmail({ name: r.name, workspace: tenant?.name || 'your team', role: ROLE_LABEL[role], url: `${config.webBaseUrl}/login` }),
    });
    email_status = sent.ok ? 'sent' : 'failed';
  }
  return ok(res, { id: r.id, status: 'approved', user_id: userId, role, email_status });
});

joinAdminRouter.post('/requests/:id/reject', async (req, res) => {
  decidersOnly(req);
  const r = await pendingRequest(req);
  managerMayDecide(req, r.requested_role);
  const body = validate(z.object({ note: z.string().trim().max(300).optional().nullable() }), req.body || {});
  const ts = nowIso();
  await run(
    `UPDATE join_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?,
       password_hash = '', security_answer_hash = NULL, updated_at = ? WHERE id = ?`,
    [req.auth.userId, ts, body.note || null, ts, r.id],
  );
  await audit(req, { entity: 'join_request', entityId: r.id, action: 'update', after: { status: 'rejected', email: r.email } });
  return ok(res, { id: r.id, status: 'rejected' });
});
