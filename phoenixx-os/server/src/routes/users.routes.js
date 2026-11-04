import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { get, all, run, repo } from '../db/index.js';
import { uuid, nowIso, token, parseJson, toCsv, pct, monthIso, startOfMonth, endOfMonth } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, conflict, forbidden, audit, paginate, pageMeta } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { notifyMany } from '../services/notifications.js';
import { config } from '../config.js';

const router = Router();

const ROLES = ['owner', 'manager', 'employee', 'finance', 'hr', 'client'];

const userSchema = z.object({
  name: z.string().min(2).max(120),
  email: z.string().email(),
  role: z.enum(ROLES),
  custom_role_id: z.string().optional().nullable(),
  designation: z.string().optional().nullable(),
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
  SELECT u.id, u.name, u.email, u.role, u.custom_role_id, u.designation, u.phone, u.whatsapp,
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

router.get('/:id', requires('employees', 'view'), async (req, res) => {
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
  return ok(res, {
    ...(canSeeCost ? user : { ...user, monthly_cost_minor: undefined }),
    reports: await all("SELECT id, name, role, designation, avatar_url FROM users WHERE manager_id = ? AND deleted_at IS NULL AND status = 'active'",
      [user.id]),
    this_month: {
      assigned: Number(items.assigned || 0),
      done: Number(items.done || 0),
      completion_pct: pct(Number(items.done || 0), Number(items.assigned || 0)),
      attendance_pct: (async () => {
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
       designation, service_line_id, manager_id, client_id, employment_type, date_of_joining,
       monthly_cost_minor, status, invite_token, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, email, bcrypt.hashSync(direct || token(16), 10), body.name, body.phone ?? null,
      body.whatsapp ?? body.phone ?? null, body.role, body.custom_role_id ?? null,
      body.designation ?? null, body.service_line_id ?? null, body.manager_id ?? null,
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
  return created(res, {
    ...await get(`${SELECT} WHERE u.id = ?`, [id]),
    ...(inviteToken
      ? { invite_url: `${config.webBaseUrl}/accept-invite?token=${inviteToken}` }
      : { note: 'The account is active. Share the password over a secure channel and ask them to change it after signing in.' }),
  });
});

router.post('/:id/resend-invite', requires('users', 'edit'), async (req, res) => {
  const user = await get("SELECT * FROM users WHERE id = ? AND tenant_id = ? AND status = 'invited' AND deleted_at IS NULL",
    [req.params.id, req.auth.tenantId]);
  if (!user) throw notFound('Pending invitation');

  const inviteToken = token(24);
  await run('UPDATE users SET invite_token = ?, updated_at = ? WHERE id = ?', [inviteToken, nowIso(), user.id]);
  return ok(res, { invite_url: `${config.webBaseUrl}/accept-invite?token=${inviteToken}` });
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
router.post('/:id/reset-password', requires('users', 'edit'), async (req, res) => {
  const user = await get('SELECT * FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!user) throw notFound('User');

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
  return ok(res, build('__root__'));
});

export { router as usersRouter };
