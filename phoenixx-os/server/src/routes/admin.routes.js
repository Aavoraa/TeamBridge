import { filterSeq } from '../lib/util.js';
import { Router } from 'express';
import { z } from 'zod';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso, todayIso, monthIso, addDays, addMonths, parseJson, daysBetween, monthsBack } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit } from '../lib/http.js';
import { signAccessToken } from '../middleware/auth.js';
import { JOB_REGISTRY } from '../services/jobs.js';

const router = Router();

/**
 * S9 - Super Admin console. Every route here is already behind
 * `requireSuperAdmin` in routes/index.js, and operates across tenants rather
 * than inside one.
 */

// -------------------------------------------------------------- platform KPIs
router.get('/metrics', async (req, res) => {
  const tenants = await all('SELECT * FROM tenants WHERE deleted_at IS NULL');
  const subs = await all(
    `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.price_monthly_minor, p.price_yearly_minor
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id`,
  );

  const active = subs.filter((s) => s.status === 'active');
  const mrr = active.reduce((a, s) => a + (s.billing_cycle === 'yearly'
    ? Math.round(s.price_yearly_minor / 12) : s.price_monthly_minor), 0);

  const byPlan = {};
  for (const s of subs) {
    byPlan[s.plan_code] ||= { plan: s.plan_code, name: s.plan_name, total: 0, active: 0, trial: 0, mrr_minor: 0 };
    byPlan[s.plan_code].total++;
    if (s.status === 'active') {
      byPlan[s.plan_code].active++;
      byPlan[s.plan_code].mrr_minor += s.billing_cycle === 'yearly'
        ? Math.round(s.price_yearly_minor / 12) : s.price_monthly_minor;
    }
    if (s.status === 'trial') byPlan[s.plan_code].trial++;
  }

  const cancelledThisMonth = subs.filter(
    (s) => s.cancelled_at && s.cancelled_at.slice(0, 7) === monthIso(),
  ).length;

  // Activation = a tenant that has created real records, not just signed up.
  const activated = (await filterSeq(tenants, async (t) => Number((await get(
    'SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL', [t.id],
  ))?.n || 0) >= 3)).length;

  return ok(res, {
    tenants: {
      total: tenants.length,
      active: tenants.filter((t) => t.status === 'active').length,
      suspended: tenants.filter((t) => t.status === 'suspended').length,
      cancelled: tenants.filter((t) => t.status === 'cancelled').length,
      new_this_month: tenants.filter((t) => t.created_at.slice(0, 7) === monthIso()).length,
    },
    subscriptions: {
      trial: subs.filter((s) => s.status === 'trial').length,
      active: active.length,
      past_due: subs.filter((s) => s.status === 'past_due').length,
      cancelled: subs.filter((s) => s.status === 'cancelled').length,
    },
    mrr_minor: mrr,
    arr_minor: mrr * 12,
    arpa_minor: active.length ? Math.round(mrr / active.length) : 0,
    logo_churn_pct: active.length + cancelledThisMonth
      ? Math.round((cancelledThisMonth / (active.length + cancelledThisMonth)) * 1000) / 10 : 0,
    trial_conversion_pct: (() => {
      const converted = subs.filter((s) => s.status === 'active').length;
      const everTrialed = subs.length;
      return everTrialed ? Math.round((converted / everTrialed) * 1000) / 10 : 0;
    })(),
    activation_pct: tenants.length ? Math.round((activated / tenants.length) * 1000) / 10 : 0,
    by_plan: Object.values(byPlan),
    signups_trend: monthsBack(6).map((month) => ({
      month,
      signups: tenants.filter((t) => t.created_at.slice(0, 7) === month).length,
    })),
    total_users: Number((await get("SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND role != 'super_admin'"))?.n || 0),
  });
});

// ------------------------------------------------------------------ tenants
router.get('/tenants', async (req, res) => {
  const rows = await all(
    `SELECT t.*, s.status AS subscription_status, s.billing_cycle, s.trial_ends_at, s.current_period_end,
            p.code AS plan_code, p.name AS plan_name, p.band_max_users
       FROM tenants t
       LEFT JOIN subscriptions s ON s.tenant_id = t.id
       LEFT JOIN plans p ON p.id = s.plan_id
      WHERE t.deleted_at IS NULL ORDER BY t.created_at DESC`,
  );

  return ok(res, await Promise.all(rows.map(async (t) => {
    const users = Number((await get("SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client'", [t.id]))?.n || 0);
    const clients = Number((await get('SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL', [t.id]))?.n || 0);
    const lastActivity = (await get(
      'SELECT MAX(created_at) AS t FROM audit_logs WHERE tenant_id = ?', [t.id],
    ))?.t;

    // A simple health read: is the workspace actually being used?
    const daysIdle = lastActivity ? daysBetween(lastActivity, new Date()) : 999;
    const health = t.status !== 'active' ? 'inactive'
      : daysIdle <= 3 && clients >= 3 ? 'healthy'
        : daysIdle <= 14 ? 'watch' : 'at_risk';

    return {
      ...t,
      settings: undefined,
      usage: {
        users,
        clients,
        invoices: Number((await get('SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND deleted_at IS NULL', [t.id]))?.n || 0),
        action_items: Number((await get('SELECT COUNT(*) AS n FROM action_items WHERE tenant_id = ? AND deleted_at IS NULL', [t.id]))?.n || 0),
        storage_mb: Math.round(Number((await get('SELECT COALESCE(SUM(size_bytes),0) AS b FROM attachments WHERE tenant_id = ?', [t.id]))?.b || 0) / 1_048_576),
      },
      last_activity_at: lastActivity,
      days_idle: daysIdle === 999 ? null : daysIdle,
      health,
      over_band: t.band_max_users ? users > t.band_max_users : false,
    };
  })));
});

router.get('/tenants/:id', async (req, res) => {
  const tenant = await get('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
  if (!tenant) throw notFound('Tenant');

  return ok(res, {
    ...tenant,
    settings: parseJson(tenant.settings, {}),
    subscription: await get(
      `SELECT s.*, p.code AS plan_code, p.name AS plan_name FROM subscriptions s
         JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`,
      [tenant.id],
    ),
    users: await all(
      "SELECT id, name, email, role, status, last_login_at FROM users WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY role, name",
      [tenant.id],
    ),
    feature_flags: await all('SELECT flag_key, enabled FROM tenant_feature_flags WHERE tenant_id = ?', [tenant.id]),
    subscription_invoices: await all('SELECT * FROM subscription_invoices WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 12', [tenant.id]),
    recent_activity: await all('SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 25', [tenant.id]),
  });
});

router.post('/tenants/:id/status', async (req, res) => {
  const { status, reason } = validate(
    z.object({ status: z.enum(['active', 'suspended', 'cancelled']), reason: z.string().optional() }), req.body,
  );
  const tenant = await get('SELECT * FROM tenants WHERE id = ?', [req.params.id]);
  if (!tenant) throw notFound('Tenant');

  await run('UPDATE tenants SET status = ?, updated_at = ? WHERE id = ?', [status, nowIso(), tenant.id]);
  if (status !== 'active') {
    await run("UPDATE subscriptions SET status = ?, updated_at = ? WHERE tenant_id = ?",
      [status === 'suspended' ? 'suspended' : 'cancelled', nowIso(), tenant.id]);
  }

  await audit(req, { entity: 'tenant', entityId: tenant.id, action: 'update', before: { status: tenant.status }, after: { status, reason } });
  return ok(res, await get('SELECT * FROM tenants WHERE id = ?', [tenant.id]));
});

/** S2 - per-tenant feature-flag override on top of the plan matrix. */
router.put('/tenants/:id/flags', async (req, res) => {
  const { flag_key: key, enabled } = validate(
    z.object({ flag_key: z.string().min(2), enabled: z.boolean() }), req.body,
  );
  if (!await get('SELECT id FROM tenants WHERE id = ?', [req.params.id])) throw notFound('Tenant');

  await run(
    `INSERT INTO tenant_feature_flags (id, tenant_id, flag_key, enabled, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT (tenant_id, flag_key) DO UPDATE SET enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [uuid(), req.params.id, key, enabled ? 1 : 0, nowIso()],
  );
  await audit(req, { entity: 'tenant', entityId: req.params.id, action: 'update', after: { flag: key, enabled } });
  return ok(res, { flag_key: key, enabled });
});

/**
 * S9 - impersonate-with-consent. A short-lived token, only for a tenant that
 * has switched support access on, and always written to the audit log of the
 * tenant being entered.
 */
router.post('/tenants/:id/impersonate', async (req, res) => {
  const { reason } = validate(z.object({ reason: z.string().min(5) }), req.body);
  const tenant = await get('SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL', [req.params.id]);
  if (!tenant) throw notFound('Tenant');

  const settings = parseJson(tenant.settings, {}) || {};
  if (!settings.support_access_enabled) {
    throw badRequest('This tenant has not granted support access. Ask an owner to enable it in Settings first.');
  }

  const owner = await get("SELECT * FROM users WHERE tenant_id = ? AND role = 'owner' AND deleted_at IS NULL ORDER BY created_at LIMIT 1",
    [tenant.id]);
  if (!owner) throw notFound('Tenant owner');

  await audit({ ...req, auth: { ...req.auth, tenantId: tenant.id } }, {
    entity: 'tenant', entityId: tenant.id, action: 'login',
    after: { impersonated_by: req.auth.email, reason },
  });

  return ok(res, {
    access_token: signAccessToken(owner),
    impersonating: { tenant: tenant.name, user: owner.name, email: owner.email },
    expires_in: '15m',
    notice: 'This session is logged in the tenant audit trail.',
  });
});

// -------------------------------------------------------------------- plans
router.get('/plans', async (req, res) => ok(res, (await all('SELECT * FROM plans ORDER BY sort'))
  .map((p) => ({ ...p, features: parseJson(p.features, {}), limits: parseJson(p.limits, {}) }))));

const planSchema = z.object({
  code: z.string().min(2).max(30),
  name: z.string().min(2).max(60),
  band_min_users: z.number().int().min(1).optional(),
  band_max_users: z.number().int().min(1),
  price_monthly_minor: z.number().int().min(0),
  price_yearly_minor: z.number().int().min(0),
  addon_user_monthly_minor: z.number().int().min(0).optional(),
  features: z.record(z.string(), z.boolean()).optional(),
  limits: z.record(z.string(), z.number().nullable()).optional(),
  sort: z.number().int().optional(),
  active: z.boolean().optional(),
});

router.post('/plans', async (req, res) => {
  const body = validate(planSchema, req.body);
  if (await get('SELECT id FROM plans WHERE code = ?', [body.code])) throw badRequest('That plan code already exists');

  const id = uuid();
  await run(
    `INSERT INTO plans (id, code, name, band_min_users, band_max_users, price_monthly_minor,
       price_yearly_minor, addon_user_monthly_minor, features, limits, sort, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, body.code, body.name, body.band_min_users ?? 1, body.band_max_users, body.price_monthly_minor,
      body.price_yearly_minor, body.addon_user_monthly_minor ?? 0, JSON.stringify(body.features || {}),
      JSON.stringify(body.limits || {}), body.sort ?? 99, nowIso()],
  );
  return created(res, await get('SELECT * FROM plans WHERE id = ?', [id]));
});

router.patch('/plans/:id', async (req, res) => {
  const plan = await get('SELECT * FROM plans WHERE id = ?', [req.params.id]);
  if (!plan) throw notFound('Plan');

  const body = validate(planSchema.partial(), req.body);
  const patch = { ...body };
  if (body.features) patch.features = JSON.stringify(body.features);
  if (body.limits) patch.limits = JSON.stringify(body.limits);
  if (body.active !== undefined) patch.active = body.active ? 1 : 0;

  const cols = Object.keys(patch);
  if (cols.length) {
    await run(`UPDATE plans SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => patch[c]), plan.id]);
  }
  await audit(req, { entity: 'plan', entityId: plan.id, action: 'update', before: plan, after: patch });
  return ok(res, await get('SELECT * FROM plans WHERE id = ?', [plan.id]));
});

// ------------------------------------------------------------------ coupons
router.get('/coupons', async (req, res) => ok(res, await all('SELECT * FROM coupons ORDER BY created_at DESC')));

router.post('/coupons', async (req, res) => {
  const body = validate(z.object({
    code: z.string().min(3).max(30),
    kind: z.enum(['percent', 'amount', 'free_months']),
    value: z.number().int().min(1),
    duration_months: z.number().int().min(1).optional(),
    max_redemptions: z.number().int().min(1).optional(),
    valid_until: z.string().optional(),
  }), req.body);

  const code = body.code.toUpperCase();
  if (await get('SELECT id FROM coupons WHERE code = ?', [code])) throw badRequest('That coupon code already exists');

  const id = uuid();
  await run(
    `INSERT INTO coupons (id, code, kind, value, duration_months, max_redemptions, valid_until, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [id, code, body.kind, body.value, body.duration_months ?? null, body.max_redemptions ?? null,
      body.valid_until ?? null, nowIso()],
  );
  await audit(req, { entity: 'coupon', entityId: id, action: 'create', after: { code } });
  return created(res, await get('SELECT * FROM coupons WHERE id = ?', [id]));
});

router.delete('/coupons/:id', async (req, res) => {
  await run('UPDATE coupons SET active = 0 WHERE id = ?', [req.params.id]);
  return ok(res, { ok: true });
});

// ------------------------------------------------------------ announcements
router.get('/announcements', async (req, res) => ok(res, await all('SELECT * FROM announcements ORDER BY created_at DESC LIMIT 50')));

router.post('/announcements', async (req, res) => {
  const body = validate(z.object({
    title: z.string().min(2).max(160),
    body: z.string().optional().nullable(),
    level: z.enum(['info', 'warning', 'critical']).optional(),
    active_from: z.string().optional(),
    active_to: z.string().optional(),
  }), req.body);

  const id = uuid();
  await run(
    'INSERT INTO announcements (id, title, body, level, active_from, active_to, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, body.title, body.body ?? null, body.level || 'info',
      body.active_from || nowIso(), body.active_to ?? null, nowIso()],
  );
  return created(res, await get('SELECT * FROM announcements WHERE id = ?', [id]));
});

router.delete('/announcements/:id', async (req, res) => {
  await run('DELETE FROM announcements WHERE id = ?', [req.params.id]);
  return ok(res, { ok: true });
});

// ------------------------------------------------------------ platform health
router.get('/health', async (req, res) => ok(res, {
  jobs: await all('SELECT job_key, status, started_at, finished_at, processed, error FROM job_runs ORDER BY started_at DESC LIMIT 40'),
  job_summary: await all(
    `SELECT job_key, COUNT(*) AS runs, COUNT(CASE WHEN status = 'error' THEN 1 END) AS errors,
            MAX(started_at) AS last_run FROM job_runs GROUP BY job_key ORDER BY last_run DESC`,
  ),
  notifications_24h: (await all(
    `SELECT channel, status, COUNT(*) AS n FROM notifications WHERE created_at >= ?
      GROUP BY channel, status`,
    [addDays(new Date(), -1).toISOString()],
  )).map((r) => ({ ...r, n: Number(r.n) })),
  webhook_failures: Number((await get("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE status = 'failed'"))?.n || 0),
  available_jobs: Object.keys(JOB_REGISTRY),
}));

router.post('/jobs/:key/run', async (req, res) => {
  const fn = JOB_REGISTRY[req.params.key];
  if (!fn) throw notFound(`Job "${req.params.key}"`);

  const result = await fn();
  await audit(req, { entity: 'job', entityId: req.params.key, action: 'update', after: { result } });
  return ok(res, { job: req.params.key, result });
});

export { router as adminRouter };
