import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { get, all, run, repo } from '../db/index.js';
import { uuid, nowIso, token, parseJson, toCsv, pct, monthIso, startOfMonth, endOfMonth } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, conflict, forbidden, audit, paginate, pageMeta } from '../lib/http.js';
import {
  requires, can, MODULES, ACTIONS, normaliseAccess, roleAccess, permissionMatrix, invalidatePersonAccess,
} from '../middleware/rbac.js';
import { notifyMany } from '../services/notifications.js';
import { assignableIds } from '../services/taskAssignment.js';
import { config } from '../config.js';
import { emailConfigured, inviteEmail, sendMail } from '../services/mailer.js';

const router = Router();

const ROLES = ['owner', 'manager', 'employee', 'finance', 'hr', 'client'];

/**
 * Whose details a caller may see on the Team pages. The owner, HR and finance
 * see everyone; a manager sees themselves, the people who report to them and
 * the people on projects they run; anyone else only themselves. (The plain name
 * list behind chat and pickers is /users/directory and stays open to all.)
 * Returns null for "everyone".
 */
async function visibleIds(auth) {
  if (['owner', 'super_admin', 'hr', 'finance'].includes(auth.role)) return null;
  if (auth.role === 'manager') return [auth.userId, ...(await assignableIds(auth) || [])];
  return [auth.userId];
}

/**
 * Who may reset whose password. Passwords are stored one-way, so nobody can
 * read one back - a reset hands out a fresh temporary password instead.
 *  - Nobody resets their own here; they change it in their profile.
 *  - The owner resets anyone in the workspace.
 *  - HR (with Team edit access) resets anyone except the owner, so HR can
 *    never take over the owner's account.
 *  - A manager resets the people who report to them, except owners and HR.
 */
async function canResetPassword(auth, target) {
  if (!target || target.id === auth.userId) return false;
  if (target.role === 'super_admin') return false;
  if (auth.role === 'owner' || auth.role === 'super_admin') return true;
  if (target.role === 'owner') return false;
  if (auth.role === 'hr') return can(auth, 'users', 'edit');
  if (auth.role === 'manager') return target.manager_id === auth.userId && !['hr', 'client'].includes(target.role);
  return false;
}

const userSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  role: z.enum(ROLES),
  custom_role_id: z.string().optional().nullable(),
  designation: z.string().optional().nullable(),
  department: z.string().trim().max(80).optional().nullable(),
  phone: z.string().optional().nullable(),
  whatsapp: z.string().optional().nullable(),
  service_line_id: z.string().optional().nullable(),
  manager_id: z.string().optional().nullable(),
  client_id: z.string().optional().nullable(),
  employment_type: z.enum(['full_time', 'part_time', 'contract', 'intern']).optional(),
  date_of_joining: z.string().optional().nullable(),
  monthly_cost_minor: z.number().int().min(0).optional(),
  status: z.enum(['active', 'invited', 'disabled']).optional(),
});

/**
 * Creating someone is not the same shape as editing them. A password may be set
 * at creation but is never a field you can PATCH - that goes through
 * /:id/reset-password, which also revokes existing sessions. Keeping it off
 * userSchema is load-bearing: PATCH builds its UPDATE from those same keys, so a
 * `password` there would try to write a column that does not exist.
 */
const createUserSchema = userSchema.extend({
  password: z.string().min(8, 'Password must be at least 8 characters').optional(),
});

const SELECT = `
  SELECT u.id, u.name, u.email, u.role, u.custom_role_id, u.designation, u.department, u.phone, u.whatsapp,
         u.service_line_id, u.manager_id, u.client_id, u.employment_type, u.date_of_joining,
         u.monthly_cost_minor, u.avatar_url, u.status, u.twofa_enabled, u.last_login_at, u.created_at,
         (u.security_answer_hash IS NOT NULL) AS has_security_question,
         m.name AS manager_name, sl.name AS service_line_name, cr.name AS custom_role_name,
         cl.name AS portal_client_name
    FROM users u
    LEFT JOIN users m ON m.id = u.manager_id
    LEFT JOIN service_lines sl ON sl.id = u.service_line_id
    LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id
    LEFT JOIN clients cl ON cl.id = u.client_id`;

// -------------------------------------------------------------------- list
router.get('/', requires('employees', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req, { defaultLimit: 100 });
  const filters = ['u.tenant_id = ?', 'u.deleted_at IS NULL'];
  const params = [req.auth.tenantId];

  if (req.query.role) { const r = String(req.query.role).split(','); filters.push(`u.role IN (${r.map(() => '?').join(',')})`); params.push(...r); }
  else filters.push("u.role != 'client'");
  if (req.query.status) { filters.push('u.status = ?'); params.push(req.query.status); }
  if (req.query.manager_id) { filters.push('u.manager_id = ?'); params.push(req.query.manager_id); }
  if (req.query.service_line_id) { filters.push('u.service_line_id = ?'); params.push(req.query.service_line_id); }
  if (req.query.search) { filters.push('(u.name LIKE ? OR u.email LIKE ? OR u.designation LIKE ?)'); const t = `%${req.query.search}%`; params.push(t, t, t); }
  const visible = await visibleIds(req.auth);
  if (visible) { filters.push(`u.id IN (${visible.map(() => '?').join(',')})`); params.push(...visible); }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM users u WHERE ${where}`, params))?.n || 0);
  const rows = await all(`${SELECT} WHERE ${where} ORDER BY u.name LIMIT ? OFFSET ?`, [...params, limit, offset]);

  // Salary bands are finance/HR/owner information only.
  const canSeeCost = ['owner', 'finance', 'hr', 'super_admin'].includes(req.auth.role);
  return ok(res, rows.map((u) => (canSeeCost ? u : { ...u, monthly_cost_minor: undefined })),
    pageMeta(page, limit, total));
});

/** Lightweight directory for assignee pickers - available to every signed-in user. */
router.get('/directory', async (req, res) => ok(res, await all(
  `SELECT id, name, email, role, designation, avatar_url, service_line_id FROM users
    WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'
    ORDER BY name`,
  [req.auth.tenantId],
)));

/** Whether invitations will be emailed (an SMTP server is set) or only shown as links. */
router.get('/invite/email-status', requires('users', 'create'), async (req, res) => ok(res, {
  email_configured: emailConfigured(),
  from: emailConfigured() ? config.providers.smtp.from : null,
}));

router.get('/:id', requires('employees', 'view'), async (req, res) => {
  const visible = await visibleIds(req.auth);
  if (visible && !visible.includes(req.params.id)) throw notFound('User');
  const user = await get(`${SELECT} WHERE u.id = ? AND u.tenant_id = ? AND u.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!user) throw notFound('User');

  const month = monthIso();
  const from = startOfMonth(month).slice(0, 10);
  const to = endOfMonth(month).slice(0, 10);
  const items = await get(
    `SELECT COUNT(*) AS assigned, COUNT(CASE WHEN status='done' THEN 1 END) AS done
       FROM action_items WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL
         AND due_date BETWEEN ? AND ?`,
    [req.auth.tenantId, user.id, from, to],
  ) || {};

  const canSeeCost = ['owner', 'finance', 'hr', 'super_admin'].includes(req.auth.role);
  const extra = normaliseAccess(parseJson((await get('SELECT extra_access FROM users WHERE id = ?', [user.id]))?.extra_access, {}));
  return ok(res, {
    ...(canSeeCost ? user : { ...user, monthly_cost_minor: undefined }),
    /** What their role gives, what the owner added for them, and the two together (Team > person). */
    access: {
      role: normaliseAccess(await roleAccess(req.auth.tenantId, user.role)),
      extra: Object.fromEntries(Object.entries(extra).filter(([, a]) => a.length)),
      effective: await permissionMatrix({ userId: user.id, tenantId: req.auth.tenantId, role: user.role, customRoleId: user.custom_role_id }),
      editable: ['manager', 'employee', 'finance', 'hr'].includes(user.role),
    },
    can_reset_password: await canResetPassword(req.auth, user),
    reports: await all("SELECT id, name, role, designation, avatar_url FROM users WHERE manager_id = ? AND deleted_at IS NULL AND status = 'active'",
      [user.id]),
    this_month: {
      assigned: Number(items.assigned || 0),
      done: Number(items.done || 0),
      completion_pct: pct(Number(items.done || 0), Number(items.assigned || 0)),
      attendance_pct: await (async () => {
        const a = await get(
          `SELECT COUNT(*) AS n, COUNT(CASE WHEN status IN ('present','wfh') THEN 1 END) AS p
             FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date BETWEEN ? AND ?`,
          [req.auth.tenantId, user.id, from, to],
        ) || {};
        return pct(Number(a.p || 0), Number(a.n || 0));
      })(),
    },
    clients: await all(
      "SELECT id, name, status, health_score FROM clients WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL ORDER BY name",
      [req.auth.tenantId, user.id],
    ),
    // Which delivery teams they sit on, and in what seat (Module F).
    projects: await all(
      `SELECT p.id, p.name, p.status, c.name AS client_name,
              pm.seat, pm.responsibility, pm.allocation_pct
         FROM project_members pm
         JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
         JOIN clients c ON c.id = p.client_id
        WHERE pm.tenant_id = ? AND pm.user_id = ? AND pm.deleted_at IS NULL
        ORDER BY p.name`,
      [req.auth.tenantId, user.id],
    ),
  });
});

/**
 * Extra access for one person, on top of their role - say, Clients & pipeline
 * for the one employee who does business development. The owner decides.
 */
router.put('/:id/access', async (req, res) => {
  if (!['owner', 'super_admin'].includes(req.auth.role)) throw forbidden('Only the workspace owner gives someone extra access');
  const target = await get('SELECT id, role FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [req.params.id, req.auth.tenantId]);
  if (!target) throw notFound('User');
  if (!['manager', 'employee', 'finance', 'hr'].includes(target.role)) throw badRequest('Owners already have everything, and portal users keep their fixed access');
  const { extra } = validate(z.object({ extra: z.record(z.string(), z.array(z.string())) }), req.body);
  for (const [mod, actions] of Object.entries(extra)) {
    if (!MODULES.includes(mod) || mod === 'platform') throw badRequest(`Unknown area "${mod}"`);
    if (actions.some((a) => !ACTIONS.includes(a))) throw badRequest(`Unknown action on ${mod}`);
  }
  const clean = Object.fromEntries(Object.entries(normaliseAccess(extra)).filter(([m, a]) => a.length && m !== 'notifications'));
  const before = (await get('SELECT extra_access FROM users WHERE id = ?', [target.id]))?.extra_access || null;
  await run('UPDATE users SET extra_access = ?, updated_at = ? WHERE id = ?',
    [Object.keys(clean).length ? JSON.stringify(clean) : null, nowIso(), target.id]);
  invalidatePersonAccess(target.id);
  await audit(req, { entity: 'user_access', entityId: target.id, action: 'update', before: parseJson(before, {}), after: clean });
  return ok(res, { extra: clean });
});

// -------------------------------------------------------------- add a member
router.post('/', requires('users', 'create'), async (req, res) => {
  const body = validate(createUserSchema, req.body);
  const { tenantId } = req.auth;
  const email = body.email.toLowerCase();

  if (await get('SELECT id FROM users WHERE tenant_id = ? AND email = ? AND deleted_at IS NULL', [tenantId, email])) {
    throw conflict('Someone with that email is already in this workspace');
  }
  if (body.role === 'owner' && req.auth.role !== 'owner') throw forbidden('Only an owner can create another owner');
  if (body.role === 'client' && !body.client_id) throw badRequest('A portal user must be linked to a client');

  // S1/S2 - enforce the plan's user band before adding a seat.
  const seatCount = Number((await get(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client' AND status != 'disabled'",
    [tenantId],
  ))?.n || 0);
  const bandMax = req.subscription?.band_max_users;
  if (bandMax && body.role !== 'client' && seatCount >= bandMax && req.query.allow_addon !== 'true') {
    throw badRequest(
      `The ${req.subscription.plan_name} plan covers up to ${bandMax} users and you have ${seatCount}. Upgrade, or re-send with ?allow_addon=true to add a per-user add-on seat.`,
    );
  }

  /**
   * Two ways in. Send an invitation and let them pick their own password, or set
   * one now and hand it over. The second exists because nothing is actually
   * delivered while EMAIL_PROVIDER is `log` - somebody is carrying the
   * credential across by hand either way, so the invite round-trip only adds a
   * step. A password here means the account is active immediately; without one
   * the behaviour is unchanged.
   */
  const id = uuid();
  const direct = body.password ?? null;
  const inviteToken = direct ? null : token(24);
  await run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, phone, whatsapp, role, custom_role_id,
       designation, department, service_line_id, manager_id, client_id, employment_type, date_of_joining,
       monthly_cost_minor, status, invite_token, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, email, bcrypt.hashSync(direct || token(16), 10), body.name, body.phone ?? null,
      body.whatsapp ?? body.phone ?? null, body.role, body.custom_role_id ?? null,
      body.designation ?? null, body.department || null, body.service_line_id ?? null, body.manager_id ?? null,
      body.client_id ?? null, body.employment_type || 'full_time', body.date_of_joining ?? null,
      body.monthly_cost_minor || 0, direct ? 'active' : 'invited', inviteToken, nowIso(), nowIso()],
  );

  // The password itself is never written to the audit trail, only how they joined.
  await audit(req, {
    entity: 'user',
    entityId: id,
    action: 'create',
    after: { email, role: body.role, onboarding: direct ? 'password set by admin' : 'invited' },
  });
  const inviteUrl = inviteToken ? `${config.webBaseUrl}/accept-invite?token=${inviteToken}` : null;
  const mail = inviteUrl ? await emailInvite(req, { name: body.name, email, role: body.role }, inviteUrl) : {};
  return created(res, {
    ...await get(`${SELECT} WHERE u.id = ?`, [id]),
    ...(inviteUrl
      ? { invite_url: inviteUrl, ...mail }
      : { note: 'The account is active. Share the password over a secure channel and ask them to change it after signing in.' }),
  });
});

router.post('/:id/resend-invite', requires('users', 'edit'), async (req, res) => {
  const user = await get("SELECT * FROM users WHERE id = ? AND tenant_id = ? AND status = 'invited' AND deleted_at IS NULL",
    [req.params.id, req.auth.tenantId]);
  if (!user) throw notFound('Pending invitation');

  const inviteToken = token(24);
  await run('UPDATE users SET invite_token = ?, updated_at = ? WHERE id = ?', [inviteToken, nowIso(), user.id]);
  const inviteUrl = `${config.webBaseUrl}/accept-invite?token=${inviteToken}`;
  const mail = await emailInvite(req, user, inviteUrl);
  return ok(res, { invite_url: inviteUrl, ...mail });
});

// ------------------------------------------------------------ invite emails
/** Sends one invitation email. Returns { email_status, email_error }. */
async function emailInvite(req, person, inviteUrl, ctx = null) {
  if (!emailConfigured()) return { email_status: 'not_configured', email_error: null };
  const c = ctx || await inviteContext(req);
  const msg = inviteEmail({
    name: person.name, workspace: c.workspace, invitedBy: c.inviter?.name,
    role: titleCaseRole(person.role), url: inviteUrl,
  });
  const res = await sendMail({ to: person.email, ...msg, replyTo: c.inviter?.email });
  return res.ok ? { email_status: 'sent', email_error: null } : { email_status: 'failed', email_error: res.error };
}

async function inviteContext(req) {
  const [tenant, inviter] = await Promise.all([
    get('SELECT name FROM tenants WHERE id = ?', [req.auth.tenantId]),
    get('SELECT name, email FROM users WHERE id = ?', [req.auth.userId]),
  ]);
  return { workspace: tenant?.name || 'your team', inviter };
}

const createdRes = created;
const titleCaseRole =(r) => ({ hr: 'HR' }[r] || (r ? r[0].toUpperCase() + r.slice(1) : ''));

// ------------------------------------------------------------- bulk invite
const bulkPersonSchema = z.object({
  name: z.string().trim().min(2, 'Name needs at least 2 characters').max(120),
  email: z.string().trim().toLowerCase().email('Not a valid email'),
  role: z.enum(['manager', 'employee', 'finance', 'hr']).default('employee'),
  designation: z.string().trim().max(120).optional().nullable(),
  department: z.string().trim().max(80).optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
  manager_email: z.string().trim().toLowerCase().email('Manager email is not valid').optional().nullable()
    .or(z.literal('').transform(() => null)),
});
const bulkSchema = z.object({
  people: z.array(z.any()).min(1, 'Add at least one person').max(200, 'Up to 200 people at a time'),
  send_email: z.boolean().default(true),
});

/**
 * Invite many people at once. Rows are checked one by one: a bad row or an
 * email already in the workspace is reported and skipped, the rest go through.
 * Managers can be named by email - someone already here or someone in the
 * same batch. Each new person gets their own one-time link, emailed when an
 * SMTP server is configured; the links come back either way so they can be
 * shared by hand.
 */
router.post('/bulk-invite', requires('users', 'create'), async (req, res) => {
  const body = validate(bulkSchema, req.body);
  const { tenantId } = req.auth;

  const existing = new Map((await all(
    'SELECT id, email FROM users WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId],
  )).map((u) => [u.email.toLowerCase(), u.id]));

  const results = [];
  const accepted = [];
  const seen = new Set();
  body.people.forEach((raw, i) => {
    const parsed = bulkPersonSchema.safeParse(raw || {});
    const email = String(raw?.email || '').trim().toLowerCase();
    if (!parsed.success) {
      results.push({ row: i + 1, email, name: raw?.name || '', status: 'skipped', reason: parsed.error.issues[0]?.message || 'Invalid row' });
    } else if (existing.has(parsed.data.email)) {
      results.push({ row: i + 1, email, name: parsed.data.name, status: 'skipped', reason: 'Already in this workspace' });
    } else if (seen.has(parsed.data.email)) {
      results.push({ row: i + 1, email, name: parsed.data.name, status: 'skipped', reason: 'Listed twice' });
    } else {
      seen.add(parsed.data.email);
      accepted.push({ row: i + 1, id: uuid(), ...parsed.data });
    }
  });

  // Seats: the whole batch has to fit, or be explicitly added as extra seats.
  const seatCount = Number((await get(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client' AND status != 'disabled'",
    [tenantId],
  ))?.n || 0);
  const bandMax = req.subscription?.band_max_users;
  if (bandMax && accepted.length && seatCount + accepted.length > bandMax && req.query.allow_addon !== 'true') {
    throw badRequest(
      `The ${req.subscription.plan_name} plan covers up to ${bandMax} users and you have ${seatCount}; this would add ${accepted.length}. Upgrade, or re-send with ?allow_addon=true to add per-user add-on seats.`,
    );
  }

  const batchIds = new Map(accepted.map((p) => [p.email, p.id]));
  const ctx = body.send_email ? await inviteContext(req) : null;
  const created = []; // shadows the http helper inside this handler; see createdRes
  for (const p of accepted) {
    const inviteToken = token(24);
    await run(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, phone, whatsapp, role, designation, department,
         employment_type, status, invite_token, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [p.id, tenantId, p.email, bcrypt.hashSync(token(16), 10), p.name, p.phone || null, p.phone || null, p.role,
        p.designation || null, p.department || null, 'full_time', 'invited', inviteToken, nowIso(), nowIso()],
    );
    await audit(req, { entity: 'user', entityId: p.id, action: 'create', after: { email: p.email, role: p.role, onboarding: 'bulk invite' } });
    created.push({ p, inviteUrl: `${config.webBaseUrl}/accept-invite?token=${inviteToken}`, managerMissing: false });
  }
  // Second pass: a manager may be someone further down the same list.
  for (const c of created) {
    if (!c.p.manager_email) continue;
    const managerId = existing.get(c.p.manager_email) || batchIds.get(c.p.manager_email) || null;
    if (managerId && managerId !== c.p.id) {
      await run('UPDATE users SET manager_id = ? WHERE id = ?', [managerId, c.p.id]);
    } else c.managerMissing = true;
  }

  // Emails after every row is saved, so a slow mail server never leaves half a batch.
  for (const { p, inviteUrl, managerMissing } of created) {
    const mail = body.send_email ? await emailInvite(req, p, inviteUrl, ctx) : { email_status: 'not_sent', email_error: null };
    results.push({
      row: p.row, email: p.email, name: p.name, role: p.role, status: 'invited', invite_url: inviteUrl, ...mail,
      reason: managerMissing ? `Manager ${p.manager_email} not found - set it later from Team` : null,
    });
  }

  results.sort((a, b) => a.row - b.row);
  const summary = {
    invited: created.length,
    skipped: results.filter((r) => r.status === 'skipped').length,
    emailed: results.filter((r) => r.email_status === 'sent').length,
    email_configured: emailConfigured(),
    results,
  };
  return created.length ? createdRes(res, summary) : ok(res, summary);
});

// ------------------------------------------------------------------ update
router.patch('/:id', requires('users', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const r = repo('users', tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('User');

  const body = validate(userSchema.partial().omit({ email: true }), req.body);
  if (body.role === 'owner' && req.auth.role !== 'owner') throw forbidden('Only an owner can grant owner access');
  if (before.role === 'owner' && body.role && body.role !== 'owner') {
    const owners = Number((await get("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'owner' AND deleted_at IS NULL AND status = 'active'",
      [tenantId]))?.n || 0);
    if (owners <= 1) throw badRequest('A workspace must always have at least one owner');
  }
  if (body.manager_id === req.params.id) throw badRequest('Someone cannot report to themselves');

  const after = await r.update(req.params.id, { ...body, updated_at: nowIso() });
  await audit(req, { entity: 'user', entityId: after.id, action: 'update', before, after });
  return ok(res, await get(`${SELECT} WHERE u.id = ?`, [after.id]));
});

router.delete('/:id', requires('users', 'delete'), async (req, res) => {
  const { tenantId } = req.auth;
  if (req.params.id === req.auth.userId) throw badRequest('You cannot remove your own account');

  const r = repo('users', tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('User');
  if (before.role === 'owner') {
    const owners = Number((await get("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND role = 'owner' AND deleted_at IS NULL AND status = 'active'",
      [tenantId]))?.n || 0);
    if (owners <= 1) throw badRequest('A workspace must always have at least one owner');
  }

  // Open work is reassigned to the manager rather than orphaned.
  const openItems = await all(
    "SELECT id FROM action_items WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL AND status NOT IN ('done','cancelled')",
    [tenantId, before.id],
  );
  if (openItems.length && before.manager_id) {
    await run(
      `UPDATE action_items SET owner_id = ?, updated_at = ? WHERE tenant_id = ? AND owner_id = ?
         AND deleted_at IS NULL AND status NOT IN ('done','cancelled')`,
      [before.manager_id, nowIso(), tenantId, before.id],
    );
  }

  await r.update(req.params.id, { status: 'disabled', deleted_at: nowIso(), updated_at: nowIso() });
  await run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), before.id]);

  await audit(req, { entity: 'user', entityId: req.params.id, action: 'delete', before });
  return ok(res, { ok: true, reassigned_items: openItems.length && before.manager_id ? openItems.length : 0 });
});

/** Admin-initiated password reset - forces a change on next sign-in. */
router.post('/:id/reset-password', async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!user) throw notFound('User');
  if (user.id === req.auth.userId) throw badRequest('Change your own password from your profile.');
  if (!await canResetPassword(req.auth, user)) {
    throw forbidden(req.auth.role === 'manager'
      ? 'Managers can reset passwords only for the people who report to them'
      : "You can't reset this person's password");
  }

  const temp = token(9);
  await run('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?',
    [bcrypt.hashSync(temp, 10), nowIso(), user.id]);
  await run('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL', [nowIso(), user.id]);

  await audit(req, { entity: 'user', entityId: user.id, action: 'update', after: { password: 'reset by admin' } });
  return ok(res, { temporary_password: temp, note: 'Share this over a secure channel. Ask them to change it after signing in.' });
});

router.get('/export/csv', requires('employees', 'export'), async (req, res) => {
  const rows = (await all(
    `${SELECT} WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.role != 'client' ORDER BY u.name`,
    [req.auth.tenantId],
  )).map((u) => ({
    name: u.name, email: u.email, role: u.role, designation: u.designation,
    service_line: u.service_line_name, manager: u.manager_name,
    employment_type: u.employment_type, date_of_joining: u.date_of_joining,
    monthly_cost: ['owner', 'finance', 'hr'].includes(req.auth.role) ? (u.monthly_cost_minor || 0) / 100 : '',
    status: u.status,
  }));
  await audit(req, { entity: 'user', action: 'export', after: { count: rows.length } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="team.csv"');
  return res.send(toCsv(rows));
});

/** Org chart for the HR view. */
router.get('/org/chart', requires('employees', 'view'), async (req, res) => {
  const users = await all(
    `SELECT id, name, role, designation, avatar_url, manager_id, service_line_id FROM users
      WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'`,
    [req.auth.tenantId],
  );
  const byManager = new Map();
  for (const u of users) {
    const key = u.manager_id || '__root__';
    if (!byManager.has(key)) byManager.set(key, []);
    byManager.get(key).push(u);
  }
  const build = (id) => (byManager.get(id) || []).map((u) => ({ ...u, reports: build(u.id) }));
  const visible = await visibleIds(req.auth);
  if (!visible) return ok(res, build('__root__'));
  // A manager sees their own branch: themselves and everyone under them.
  const me = users.find((u) => u.id === req.auth.userId);
  return ok(res, me ? [{ ...me, reports: build(me.id) }] : []);
});

export { router as usersRouter };
