import { forEachSeq } from '../lib/util.js';
import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo } from '../db/index.js';
import { uuid, nowIso, parseJson, toCsv } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit, paginate, pageMeta } from '../lib/http.js';
import { requires, MODULES, ACTIONS, ROLE_TEMPLATES, invalidateRoleCache } from '../middleware/rbac.js';
import { peekNumber, numberingAudit } from '../services/numbering.js';
import { STATE_CODES } from '../services/gst.js';
import { seedTenantContent } from '../services/provisioning.js';

const router = Router();

// ============================================================ TENANT PROFILE
router.get('/tenant', requires('settings', 'view'), async (req, res) => {
  const tenant = await get('SELECT * FROM tenants WHERE id = ?', [req.auth.tenantId]);
  return ok(res, {
    ...tenant,
    settings: parseJson(tenant.settings, {}),
    numbering_preview: await peekNumber({ tenantId: tenant.id, tenant }),
    numbering_audit: await numberingAudit(tenant.id),
    state_codes: Object.entries(STATE_CODES).map(([code, name]) => ({ code, name })),
  });
});

const tenantSchema = z.object({
  name: z.string().min(2).max(120).optional(),
  legal_name: z.string().optional().nullable(),
  timezone: z.string().optional(),
  currency: z.string().length(3).optional(),
  number_format: z.enum(['indian', 'international']).optional(),
  logo_url: z.string().optional().nullable(),
  brand_primary: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  brand_accent: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  gstin: z.string().optional().nullable(),
  pan: z.string().optional().nullable(),
  state_code: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  email: z.string().email().optional().nullable(),
  website: z.string().optional().nullable(),
  invoice_prefix: z.string().min(1).max(10).optional(),
  invoice_scheme: z.string().min(3).max(60).optional(),
  proposal_prefix: z.string().min(1).max(10).optional(),
  fy_start_month: z.number().int().min(1).max(12).optional(),
  settings: z.record(z.string(), z.any()).optional(),
});

router.patch('/tenant', requires('settings', 'edit'), async (req, res) => {
  const body = validate(tenantSchema, req.body);
  const before = await get('SELECT * FROM tenants WHERE id = ?', [req.auth.tenantId]);

  // F1: changing the numbering scheme mid-year would break sequence continuity.
  if (body.invoice_scheme && body.invoice_scheme !== before.invoice_scheme) {
    if (!/\{seq(?::\d+)?\}/.test(body.invoice_scheme)) {
      throw badRequest('The numbering scheme must include a {seq} placeholder');
    }
    const issued = Number((await get(
      "SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND deleted_at IS NULL AND status != 'draft'",
      [req.auth.tenantId],
    ))?.n || 0);
    if (issued > 0 && req.query.force !== 'true') {
      throw badRequest(
        `${issued} invoice(s) have already been issued under the current scheme. Changing it now risks duplicate numbers. Re-send with ?force=true if this is intentional and you have reconciled with your accountant.`,
      );
    }
  }

  const patch = { ...body, updated_at: nowIso() };
  if (body.settings) patch.settings = JSON.stringify({ ...parseJson(before.settings, {}), ...body.settings });

  const cols = Object.keys(patch);
  await run(`UPDATE tenants SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => patch[c]), req.auth.tenantId]);

  const after = await get('SELECT * FROM tenants WHERE id = ?', [req.auth.tenantId]);
  await audit(req, { entity: 'tenant', entityId: req.auth.tenantId, action: 'update', before, after });
  return ok(res, { ...after, settings: parseJson(after.settings, {}) });
});

/** Preview a numbering scheme before committing to it. */
router.post('/tenant/numbering-preview', requires('settings', 'view'), async (req, res) => {
  const { scheme } = validate(z.object({ scheme: z.string().min(3) }), req.body);
  const tenant = await get('SELECT * FROM tenants WHERE id = ?', [req.auth.tenantId]);
  return ok(res, await peekNumber({ tenantId: tenant.id, tenant, scheme }));
});

// ============================================================ SERVICE LINES
const serviceLineSchema = z.object({
  name: z.string().min(2).max(80),
  code: z.string().min(2).max(30),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  description: z.string().optional().nullable(),
  sort: z.number().int().optional(),
  active: z.boolean().optional(),
});

router.get('/service-lines', async (req, res) => ok(res, await all(
  'SELECT * FROM service_lines WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort, name',
  [req.auth.tenantId],
)));

router.post('/service-lines', requires('settings', 'create'), async (req, res) => {
  const body = validate(serviceLineSchema, req.body);
  const id = uuid();
  await run(
    `INSERT INTO service_lines (id, tenant_id, name, code, color, description, sort, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.name, body.code, body.color || '#3B82F6',
      body.description ?? null, body.sort ?? 99, nowIso(), nowIso()],
  );
  await audit(req, { entity: 'service_line', entityId: id, action: 'create', after: body });
  return created(res, await get('SELECT * FROM service_lines WHERE id = ?', [id]));
});

router.patch('/service-lines/:id', requires('settings', 'edit'), async (req, res) => {
  const r = repo('service_lines', req.auth.tenantId);
  if (!await r.findById(req.params.id)) throw notFound('Service line');
  const body = validate(serviceLineSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.active !== undefined) patch.active = body.active ? 1 : 0;
  return ok(res, await r.update(req.params.id, patch));
});

router.delete('/service-lines/:id', requires('settings', 'delete'), async (req, res) => {
  await repo('service_lines', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

// =========================================================== PIPELINE STAGES
const stageSchema = z.object({
  name: z.string().min(2).max(60),
  code: z.string().min(2).max(40),
  sort: z.number().int().optional(),
  probability: z.number().int().min(0).max(100).optional(),
  is_won: z.boolean().optional(),
  is_lost: z.boolean().optional(),
  sla_days: z.number().int().min(1).optional().nullable(),
});

router.get('/pipeline-stages', async (req, res) => ok(res, await all(
  'SELECT * FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort',
  [req.auth.tenantId],
)));

router.post('/pipeline-stages', requires('settings', 'create'), async (req, res) => {
  const body = validate(stageSchema, req.body);
  const id = uuid();
  await run(
    `INSERT INTO pipeline_stages (id, tenant_id, name, code, sort, probability, is_won, is_lost, sla_days, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.name, body.code, body.sort ?? 99, body.probability ?? 0,
      body.is_won ? 1 : 0, body.is_lost ? 1 : 0, body.sla_days ?? null, nowIso(), nowIso()],
  );
  return created(res, await get('SELECT * FROM pipeline_stages WHERE id = ?', [id]));
});

router.patch('/pipeline-stages/:id', requires('settings', 'edit'), async (req, res) => {
  const r = repo('pipeline_stages', req.auth.tenantId);
  if (!await r.findById(req.params.id)) throw notFound('Pipeline stage');
  const body = validate(stageSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.is_won !== undefined) patch.is_won = body.is_won ? 1 : 0;
  if (body.is_lost !== undefined) patch.is_lost = body.is_lost ? 1 : 0;
  return ok(res, await r.update(req.params.id, patch));
});

router.post('/pipeline-stages/reorder', requires('settings', 'edit'), async (req, res) => {
  const { order } = validate(z.object({ order: z.array(z.string()) }), req.body);
  await forEachSeq(order, async (id, i) => {
    await run('UPDATE pipeline_stages SET sort = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [i, nowIso(), id, req.auth.tenantId]);
  });
  return ok(res, await all('SELECT * FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort',
    [req.auth.tenantId]));
});

router.delete('/pipeline-stages/:id', requires('settings', 'delete'), async (req, res) => {
  const inUse = Number((await get('SELECT COUNT(*) AS n FROM clients WHERE stage_id = ? AND deleted_at IS NULL',
    [req.params.id]))?.n || 0);
  if (inUse) throw badRequest(`${inUse} client(s) are in this stage. Move them first.`);
  await repo('pipeline_stages', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

// ========================================================= ACTION CATEGORIES
router.get('/action-categories', async (req, res) => ok(res, await all(
  'SELECT * FROM action_categories WHERE tenant_id = ? AND active = 1 ORDER BY name',
  [req.auth.tenantId],
)));

router.post('/action-categories', requires('settings', 'create'), async (req, res) => {
  const body = validate(z.object({
    name: z.string().min(2).max(60),
    code: z.string().min(2).max(40),
    escalation_days: z.number().int().min(0).max(60).optional(),
    color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  }), req.body);

  const id = uuid();
  await run(
    'INSERT INTO action_categories (id, tenant_id, name, code, escalation_days, color, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, req.auth.tenantId, body.name, body.code, body.escalation_days ?? 3, body.color || '#64748B', nowIso()],
  );
  return created(res, await get('SELECT * FROM action_categories WHERE id = ?', [id]));
});

router.patch('/action-categories/:id', requires('settings', 'edit'), async (req, res) => {
  const body = validate(z.object({
    name: z.string().optional(),
    escalation_days: z.number().int().min(0).max(60).optional(),
    color: z.string().optional(),
    active: z.boolean().optional(),
  }), req.body);

  const cat = await get('SELECT * FROM action_categories WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!cat) throw notFound('Category');

  const patch = { ...body };
  if (body.active !== undefined) patch.active = body.active ? 1 : 0;
  const cols = Object.keys(patch);
  if (cols.length) {
    await run(`UPDATE action_categories SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => patch[c]), cat.id]);
  }
  return ok(res, await get('SELECT * FROM action_categories WHERE id = ?', [cat.id]));
});

// ============================================================== REASON CODES
router.get('/reason-codes', async (req, res) => {
  const filters = ['tenant_id = ?', 'active = 1'];
  const params = [req.auth.tenantId];
  if (req.query.category) { filters.push('category = ?'); params.push(req.query.category); }
  return ok(res, await all(
    `SELECT * FROM reason_codes WHERE ${filters.join(' AND ')} ORDER BY category, severity DESC, label`,
    params,
  ));
});

router.post('/reason-codes', requires('settings', 'create'), async (req, res) => {
  const body = validate(z.object({
    category: z.enum(['retention_risk', 'churn', 'score_adjust', 'grievance']),
    code: z.string().min(2).max(40).regex(/^[A-Z0-9_]+$/, 'Use uppercase letters, digits and underscores'),
    label: z.string().min(2).max(120),
    severity: z.number().int().min(1).max(3).optional(),
  }), req.body);

  const id = uuid();
  await run('INSERT INTO reason_codes (id, tenant_id, category, code, label, severity, created_at) VALUES (?,?,?,?,?,?,?)',
    [id, req.auth.tenantId, body.category, body.code, body.label, body.severity ?? 1, nowIso()]);
  await audit(req, { entity: 'reason_code', entityId: id, action: 'create', after: body });
  return created(res, await get('SELECT * FROM reason_codes WHERE id = ?', [id]));
});

router.delete('/reason-codes/:id', requires('settings', 'delete'), async (req, res) => {
  // Deactivated rather than deleted so historical references stay resolvable.
  await run('UPDATE reason_codes SET active = 0 WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  return ok(res, { ok: true, deactivated: true });
});

// ================================================================ LEAVE TYPES
router.post('/leave-types', requires('settings', 'create'), async (req, res) => {
  const body = validate(z.object({
    name: z.string().min(2).max(60),
    code: z.string().min(1).max(10),
    annual_quota: z.number().min(0).optional(),
    paid: z.boolean().optional(),
    color: z.string().optional(),
  }), req.body);

  const id = uuid();
  await run(
    'INSERT INTO leave_types (id, tenant_id, name, code, annual_quota, paid, color, created_at) VALUES (?,?,?,?,?,?,?,?)',
    [id, req.auth.tenantId, body.name, body.code, body.annual_quota ?? 0,
      body.paid === false ? 0 : 1, body.color || '#3B82F6', nowIso()],
  );
  return created(res, await get('SELECT * FROM leave_types WHERE id = ?', [id]));
});

// =============================================================== CUSTOM ROLES
router.get('/roles', requires('users', 'view'), async (req, res) => ok(res, {
  modules: MODULES,
  actions: ACTIONS,
  templates: ROLE_TEMPLATES,
  custom: (await all('SELECT * FROM custom_roles WHERE tenant_id = ? AND deleted_at IS NULL', [req.auth.tenantId]))
    .map((r) => ({ ...r, permissions: parseJson(r.permissions, {}) })),
}));

router.post('/roles', requires('users', 'create'), async (req, res) => {
  const body = validate(z.object({
    name: z.string().min(2).max(60),
    base_role: z.enum(['manager', 'employee', 'finance', 'hr']),
    permissions: z.record(z.string(), z.array(z.string())),
  }), req.body);

  for (const [mod, actions] of Object.entries(body.permissions)) {
    if (!MODULES.includes(mod)) throw badRequest(`Unknown module "${mod}"`);
    const bad = actions.filter((a) => !ACTIONS.includes(a));
    if (bad.length) throw badRequest(`Unknown action(s) on ${mod}: ${bad.join(', ')}`);
  }

  const id = uuid();
  await run(
    'INSERT INTO custom_roles (id, tenant_id, name, base_role, permissions, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
    [id, req.auth.tenantId, body.name, body.base_role, JSON.stringify(body.permissions), nowIso(), nowIso()],
  );
  await audit(req, { entity: 'custom_role', entityId: id, action: 'create', after: { name: body.name } });
  return created(res, await get('SELECT * FROM custom_roles WHERE id = ?', [id]));
});

router.patch('/roles/:id', requires('users', 'edit'), async (req, res) => {
  const r = repo('custom_roles', req.auth.tenantId);
  if (!await r.findById(req.params.id)) throw notFound('Custom role');

  const body = validate(z.object({
    name: z.string().optional(),
    permissions: z.record(z.string(), z.array(z.string())).optional(),
  }), req.body);

  const patch = { updated_at: nowIso() };
  if (body.name) patch.name = body.name;
  if (body.permissions) patch.permissions = JSON.stringify(body.permissions);

  const after = await r.update(req.params.id, patch);
  invalidateRoleCache(req.params.id);
  return ok(res, { ...after, permissions: parseJson(after.permissions, {}) });
});

router.delete('/roles/:id', requires('users', 'delete'), async (req, res) => {
  const inUse = Number((await get('SELECT COUNT(*) AS n FROM users WHERE custom_role_id = ? AND deleted_at IS NULL',
    [req.params.id]))?.n || 0);
  if (inUse) throw badRequest(`${inUse} user(s) hold this role. Reassign them first.`);
  await repo('custom_roles', req.auth.tenantId).softDelete(req.params.id, nowIso());
  invalidateRoleCache(req.params.id);
  return ok(res, { ok: true });
});

// ================================================================= AUDIT LOG
router.get('/audit', requires('audit', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req, { defaultLimit: 50 });
  const filters = ['tenant_id = ?'];
  const params = [req.auth.tenantId];

  if (req.query.entity) { filters.push('entity = ?'); params.push(req.query.entity); }
  if (req.query.entity_id) { filters.push('entity_id = ?'); params.push(req.query.entity_id); }
  if (req.query.actor_id) { filters.push('actor_id = ?'); params.push(req.query.actor_id); }
  if (req.query.action) { filters.push('action = ?'); params.push(req.query.action); }
  if (req.query.from) { filters.push('created_at >= ?'); params.push(req.query.from); }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM audit_logs WHERE ${where}`, params))?.n || 0);

  return ok(res, (await all(
    `SELECT * FROM audit_logs WHERE ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )).map((r) => ({ ...r, before: parseJson(r.before_json, null), after: parseJson(r.after_json, null) })),
  pageMeta(page, limit, total));
});

// ============================================= DPDP: per-tenant export/delete
/** NFR security - per-tenant data export (DPDP Act 2023). */
router.get('/data-export', requires('settings', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const tables = [
    'clients', 'contacts', 'activities', 'projects', 'proposals', 'proposal_items',
    'invoices', 'invoice_items', 'payments', 'costs', 'action_items', 'meetings', 'mom_points',
    'users', 'attendance', 'leave_requests', 'performance_reviews', 'sops', 'sop_versions',
    'kpis', 'service_lines', 'pipeline_stages', 'reason_codes',
  ];

  const dump = { exported_at: nowIso(), tenant: await get('SELECT * FROM tenants WHERE id = ?', [tenantId]) };
  for (const table of tables) {
    const rows = await all(`SELECT * FROM ${table} WHERE tenant_id = ?`, [tenantId]);
    // Credentials never leave the system, even in an owner-initiated export.
    dump[table] = table === 'users'
      ? rows.map(({ password_hash, twofa_secret, invite_token, ...u }) => u)
      : rows;
  }

  await audit(req, { entity: 'tenant', entityId: tenantId, action: 'export', after: { tables: tables.length } });
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="phoenixx-export-${tenantId.slice(0, 8)}.json"`);
  return res.send(JSON.stringify(dump, null, 2));
});

/** S8 - re-apply the starter content packs (safe on an empty workspace). */
router.post('/seed-content', requires('settings', 'create'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const existing = Number((await get('SELECT COUNT(*) AS n FROM service_lines WHERE tenant_id = ? AND deleted_at IS NULL',
    [tenantId]))?.n || 0);
  if (existing > 0 && req.query.force !== 'true') {
    throw badRequest('This workspace already has content. Re-send with ?force=true to add the starter packs again.');
  }

  await seedTenantContent(tenantId, { ownerId: userId });
  await audit(req, { entity: 'tenant', entityId: tenantId, action: 'create', after: { seeded: true } });
  return ok(res, { seeded: true });
});

export { router as settingsRouter };
