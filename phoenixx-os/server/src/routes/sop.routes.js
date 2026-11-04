import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso, parseJson, pct, round1, addDays, todayIso } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit, paginate, pageMeta } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { notifyRole } from '../services/notifications.js';

const router = Router();

export const WORKFLOWS = [
  'outreach_pitch', 'follow_up', 'grievance', 'onboarding', 'execution', 'invoicing', 'retention', 'internal',
];

const sopSchema = z.object({
  title: z.string().min(2).max(200),
  code: z.string().optional().nullable(),
  service_line_id: z.string().optional().nullable(),
  workflow: z.enum(WORKFLOWS),
  summary: z.string().optional().nullable(),
  owner_id: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  requires_ack: z.boolean().optional(),
  content: z.string().optional(),
  checklist: z.array(z.object({
    id: z.string().optional(),
    text: z.string(),
    required: z.boolean().optional(),
  })).optional(),
});

const SELECT = `
  SELECT s.*, sl.name AS service_line_name, sl.color AS service_line_color, u.name AS owner_name,
         (SELECT COUNT(*) FROM sop_acknowledgements a WHERE a.sop_id = s.id AND a.version = s.current_version) AS ack_count,
         (SELECT AVG(r.adherence_pct) FROM sop_runs r WHERE r.sop_id = s.id) AS avg_adherence
    FROM sops s
    LEFT JOIN service_lines sl ON sl.id = s.service_line_id
    LEFT JOIN users u ON u.id = s.owner_id`;

const hydrate = (s) => (s ? { ...s, tags: parseJson(s.tags, []) } : s);

// -------------------------------------------------------------------- list
router.get('/', requires('sop', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req, { defaultLimit: 50 });
  const filters = ['s.tenant_id = ?', 's.deleted_at IS NULL'];
  const params = [req.auth.tenantId];

  if (req.query.service_line_id) { filters.push('s.service_line_id = ?'); params.push(req.query.service_line_id); }
  if (req.query.workflow) { filters.push('s.workflow = ?'); params.push(req.query.workflow); }
  if (req.query.status) { filters.push('s.status = ?'); params.push(req.query.status); }
  if (req.query.search) { filters.push('(s.title LIKE ? OR s.summary LIKE ? OR s.code LIKE ?)'); const t = `%${req.query.search}%`; params.push(t, t, t); }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM sops s WHERE ${where}`, params))?.n || 0);
  const rows = (await all(`${SELECT} WHERE ${where} ORDER BY s.workflow, s.title LIMIT ? OFFSET ?`,
    [...params, limit, offset])).map(hydrate);

  // Flag SOPs the caller has not yet acknowledged at the current version (D2).
  const acked = new Set((await all(
    'SELECT sop_id, version FROM sop_acknowledgements WHERE tenant_id = ? AND user_id = ?',
    [req.auth.tenantId, req.auth.userId],
  )).map((a) => `${a.sop_id}:${a.version}`));

  return ok(res, rows.map((s) => ({
    ...s,
    acknowledged: acked.has(`${s.id}:${s.current_version}`),
    avg_adherence: s.avg_adherence != null ? round1(s.avg_adherence) : null,
  })), pageMeta(page, limit, total));
});

router.get('/workflows', requires('sop', 'view'), async (req, res) => ok(res, await Promise.all(WORKFLOWS.map(async (w) => ({
  code: w,
  label: w.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
  count: Number((await get('SELECT COUNT(*) AS n FROM sops WHERE tenant_id = ? AND workflow = ? AND deleted_at IS NULL',
    [req.auth.tenantId, w]))?.n || 0),
})))));

router.get('/:id', requires('sop', 'view'), async (req, res) => {
  const sop = await get(`${SELECT} WHERE s.id = ? AND s.tenant_id = ? AND s.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!sop) throw notFound('SOP');

  const versionNum = req.query.version ? Number(req.query.version) : sop.current_version;
  const version = await get('SELECT * FROM sop_versions WHERE sop_id = ? AND version = ?', [sop.id, versionNum]);

  return ok(res, {
    ...hydrate(sop),
    version: version ? { ...version, checklist: parseJson(version.checklist, []) } : null,
    versions: await all(
      `SELECT v.version, v.change_note, v.status, v.published_at, v.created_at, u.name AS created_by_name
         FROM sop_versions v LEFT JOIN users u ON u.id = v.created_by
        WHERE v.sop_id = ? ORDER BY v.version DESC`,
      [sop.id],
    ),
    acknowledged: !!await get(
      'SELECT id FROM sop_acknowledgements WHERE sop_id = ? AND version = ? AND user_id = ?',
      [sop.id, sop.current_version, req.auth.userId],
    ),
    acknowledgements: await all(
      `SELECT a.*, u.name, u.avatar_url FROM sop_acknowledgements a JOIN users u ON u.id = a.user_id
        WHERE a.sop_id = ? AND a.version = ? ORDER BY a.acknowledged_at DESC`,
      [sop.id, sop.current_version],
    ),
  });
});

// ------------------------------------------------------------------ create
router.post('/', requires('sop', 'create'), async (req, res) => {
  const body = validate(sopSchema, req.body);
  const { tenantId, userId } = req.auth;
  const id = uuid();
  const ts = nowIso();

  await tx(async () => {
    await run(
      `INSERT INTO sops (id, tenant_id, title, code, service_line_id, workflow, summary, owner_id,
         status, current_version, tags, requires_ack, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?, 'draft', 1, ?,?,?,?)`,
      [id, tenantId, body.title, body.code ?? null, body.service_line_id ?? null, body.workflow,
        body.summary ?? null, body.owner_id || userId, JSON.stringify(body.tags || []),
        body.requires_ack === false ? 0 : 1, ts, ts],
    );
    await run(
      `INSERT INTO sop_versions (id, tenant_id, sop_id, version, content, checklist, change_note,
         status, created_by, created_at) VALUES (?,?,?,1,?,?, 'Initial version', 'draft', ?, ?)`,
      [uuid(), tenantId, id, body.content || '',
        JSON.stringify((body.checklist || []).map((c, i) => ({ id: c.id || `c${i + 1}`, text: c.text, required: c.required !== false }))),
        userId, ts],
    );
  });

  await audit(req, { entity: 'sop', entityId: id, action: 'create', after: { title: body.title } });
  return created(res, hydrate(await get(`${SELECT} WHERE s.id = ?`, [id])));
});

router.patch('/:id', requires('sop', 'edit'), async (req, res) => {
  const r = repo('sops', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('SOP');

  const body = validate(sopSchema.partial(), req.body);
  const patch = { updated_at: nowIso() };
  for (const k of ['title', 'code', 'service_line_id', 'workflow', 'summary', 'owner_id']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (body.tags) patch.tags = JSON.stringify(body.tags);
  if (body.requires_ack !== undefined) patch.requires_ack = body.requires_ack ? 1 : 0;

  const after = await r.update(req.params.id, patch);
  await audit(req, { entity: 'sop', entityId: after.id, action: 'update', before, after });
  return ok(res, hydrate(await get(`${SELECT} WHERE s.id = ?`, [after.id])));
});

router.delete('/:id', requires('sop', 'delete'), async (req, res) => {
  await repo('sops', req.auth.tenantId).softDelete(req.params.id, nowIso());
  await audit(req, { entity: 'sop', entityId: req.params.id, action: 'delete' });
  return ok(res, { ok: true });
});

// =============================================================== VERSIONING
/**
 * D2 - version control. Editing a published SOP never mutates the published
 * version; it opens (or updates) the next draft, which becomes live only on
 * publish. That keeps acknowledgements and adherence tied to exact content.
 */
router.post('/:id/versions', requires('sop', 'edit'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const sop = await get('SELECT * FROM sops WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!sop) throw notFound('SOP');

  const body = validate(z.object({
    content: z.string(),
    checklist: z.array(z.object({ id: z.string().optional(), text: z.string(), required: z.boolean().optional() })).optional(),
    change_note: z.string().optional().nullable(),
  }), req.body);

  const latest = await get('SELECT * FROM sop_versions WHERE sop_id = ? ORDER BY version DESC LIMIT 1', [sop.id]);
  const checklist = JSON.stringify(
    (body.checklist || []).map((c, i) => ({ id: c.id || `c${i + 1}`, text: c.text, required: c.required !== false })),
  );

  // An unpublished draft is edited in place rather than stacking versions.
  if (latest && latest.status === 'draft') {
    await run('UPDATE sop_versions SET content = ?, checklist = ?, change_note = ? WHERE id = ?',
      [body.content, checklist, body.change_note ?? latest.change_note, latest.id]);
    return ok(res, { ...await get('SELECT * FROM sop_versions WHERE id = ?', [latest.id]), checklist: parseJson(checklist, []) });
  }

  const version = (latest?.version || 0) + 1;
  const id = uuid();
  await run(
    `INSERT INTO sop_versions (id, tenant_id, sop_id, version, content, checklist, change_note,
       status, created_by, created_at) VALUES (?,?,?,?,?,?,?, 'draft', ?, ?)`,
    [id, tenantId, sop.id, version, body.content, checklist, body.change_note ?? null, userId, nowIso()],
  );
  return created(res, { ...await get('SELECT * FROM sop_versions WHERE id = ?', [id]), checklist: parseJson(checklist, []) });
});

router.post('/:id/publish', requires('sop', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  const sop = await get('SELECT * FROM sops WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!sop) throw notFound('SOP');

  const draft = await get("SELECT * FROM sop_versions WHERE sop_id = ? AND status = 'draft' ORDER BY version DESC LIMIT 1",
    [sop.id]);
  if (!draft) throw badRequest('There is no draft version to publish');

  await tx(async () => {
    await run("UPDATE sop_versions SET status = 'published', published_at = ? WHERE id = ?", [nowIso(), draft.id]);
    await run("UPDATE sops SET status = 'published', current_version = ?, updated_at = ? WHERE id = ?",
      [draft.version, nowIso(), sop.id]);
  });

  await notifyRole({
    tenantId, roles: ['employee', 'manager', 'finance', 'hr'], eventKey: 'sop.published',
    vars: { title: sop.title, version: draft.version },
    link: `/sop/${sop.id}`,
    dedupeKey: `sop:${sop.id}:v${draft.version}`,
  }).catch(() => {});

  await audit(req, { entity: 'sop', entityId: sop.id, action: 'approve', after: { version: draft.version } });
  return ok(res, hydrate(await get(`${SELECT} WHERE s.id = ?`, [sop.id])));
});

/** D2 - restore an older version by copying it forward as a new draft. */
router.post('/:id/versions/:version/restore', requires('sop', 'edit'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const sop = await get('SELECT * FROM sops WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!sop) throw notFound('SOP');

  const source = await get('SELECT * FROM sop_versions WHERE sop_id = ? AND version = ?',
    [sop.id, Number(req.params.version)]);
  if (!source) throw notFound('SOP version');

  const latest = await get('SELECT MAX(version) AS v FROM sop_versions WHERE sop_id = ?', [sop.id]);
  const version = Number(latest.v) + 1;
  const id = uuid();

  await run(
    `INSERT INTO sop_versions (id, tenant_id, sop_id, version, content, checklist, change_note,
       status, created_by, created_at) VALUES (?,?,?,?,?,?,?, 'draft', ?, ?)`,
    [id, tenantId, sop.id, version, source.content, source.checklist,
      `Restored from version ${source.version}`, userId, nowIso()],
  );
  await audit(req, { entity: 'sop', entityId: sop.id, action: 'update', after: { restored_from: source.version } });
  return created(res, await get('SELECT * FROM sop_versions WHERE id = ?', [id]));
});

// ------------------------------------------------------------ acknowledge
router.post('/:id/acknowledge', requires('sop', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const sop = await get('SELECT * FROM sops WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!sop) throw notFound('SOP');
  if (sop.status !== 'published') throw badRequest('Only a published SOP can be acknowledged');

  await run(
    `INSERT INTO sop_acknowledgements (id, tenant_id, sop_id, version, user_id, acknowledged_at)
     VALUES (?,?,?,?,?,?) ON CONFLICT (sop_id, version, user_id) DO NOTHING`,
    [uuid(), tenantId, sop.id, sop.current_version, userId, nowIso()],
  );
  return ok(res, { acknowledged: true, version: sop.current_version });
});

/** D2 - who has read which SOP version. */
router.get('/reports/acknowledgement', requires('sop', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const sops = await all(
    "SELECT id, title, current_version, workflow FROM sops WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'published' AND requires_ack = 1",
    [tenantId],
  );
  const users = await all(
    "SELECT id, name, role, avatar_url FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'",
    [tenantId],
  );
  const acks = await all('SELECT sop_id, version, user_id, acknowledged_at FROM sop_acknowledgements WHERE tenant_id = ?', [tenantId]);
  const index = new Set(acks.map((a) => `${a.sop_id}:${a.version}:${a.user_id}`));

  return ok(res, {
    sops: sops.map((s) => {
      const done = users.filter((u) => index.has(`${s.id}:${s.current_version}:${u.id}`));
      return {
        ...s,
        acknowledged: done.length,
        pending: users.length - done.length,
        pending_users: users.filter((u) => !index.has(`${s.id}:${s.current_version}:${u.id}`)),
        coverage_pct: pct(done.length, users.length),
      };
    }),
    overall_coverage_pct: pct(
      sops.reduce((a, s) => a + users.filter((u) => index.has(`${s.id}:${s.current_version}:${u.id}`)).length, 0),
      sops.length * users.length,
    ),
  });
});

// ============================================================ D4 SOP RUNS
router.get('/:id/runs', requires('sop', 'view'), async (req, res) => ok(res, (await all(
  `SELECT r.*, u.name AS user_name FROM sop_runs r LEFT JOIN users u ON u.id = r.user_id
    WHERE r.tenant_id = ? AND r.sop_id = ? ORDER BY r.started_at DESC LIMIT 100`,
  [req.auth.tenantId, req.params.id],
)).map((r) => ({ ...r, checklist_state: parseJson(r.checklist_state, {}) }))));

/** Starts a checklist run of an SOP against a record (a client onboarding, say). */
router.post('/:id/runs', requires('sop', 'create'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const sop = await get('SELECT * FROM sops WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!sop) throw notFound('SOP');
  if (sop.status !== 'published') throw badRequest('Only a published SOP can be run');

  const body = validate(z.object({
    entity: z.string().optional().nullable(),
    entity_id: z.string().optional().nullable(),
  }), req.body || {});

  const version = await get('SELECT * FROM sop_versions WHERE sop_id = ? AND version = ?', [sop.id, sop.current_version]);
  const checklist = parseJson(version?.checklist, []) || [];
  const id = uuid();

  await run(
    `INSERT INTO sop_runs (id, tenant_id, sop_id, version, entity, entity_id, user_id,
       checklist_state, total_items, completed_items, adherence_pct, started_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?, '{}', ?, 0, 0, ?, ?, ?)`,
    [id, tenantId, sop.id, sop.current_version, body.entity ?? null, body.entity_id ?? null,
      userId, checklist.length, nowIso(), nowIso(), nowIso()],
  );

  return created(res, { ...await get('SELECT * FROM sop_runs WHERE id = ?', [id]), checklist });
});

router.patch('/runs/:runId', requires('sop', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const run_ = await get('SELECT * FROM sop_runs WHERE id = ? AND tenant_id = ?', [req.params.runId, tenantId]);
  if (!run_) throw notFound('SOP run');

  const { checklist_state: state } = validate(
    z.object({ checklist_state: z.record(z.string(), z.boolean()) }), req.body,
  );
  const completed = Object.values(state).filter(Boolean).length;
  const adherence = run_.total_items ? round1((completed / run_.total_items) * 100) : 0;
  const done = completed >= run_.total_items && run_.total_items > 0;

  await run(
    `UPDATE sop_runs SET checklist_state = ?, completed_items = ?, adherence_pct = ?,
       completed_at = ?, updated_at = ? WHERE id = ?`,
    [JSON.stringify(state), completed, adherence, done ? nowIso() : null, nowIso(), run_.id],
  );
  return ok(res, {
    ...await get('SELECT * FROM sop_runs WHERE id = ?', [run_.id]),
    checklist_state: state,
  });
});

/** D4 - adherence surfaced for the weekly report. */
router.get('/reports/adherence', requires('sop', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const since = req.query.since || addDays(new Date(), -30).toISOString();

  const bySop = (await all(
    `SELECT s.id, s.title, s.workflow, sl.name AS service_line_name,
            COUNT(r.id) AS runs, AVG(r.adherence_pct) AS avg_adherence,
            COUNT(CASE WHEN r.completed_at IS NOT NULL THEN 1 END) AS completed_runs
       FROM sops s
       LEFT JOIN sop_runs r ON r.sop_id = s.id AND r.started_at >= ?
       LEFT JOIN service_lines sl ON sl.id = s.service_line_id
      WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND s.status = 'published'
      GROUP BY s.id ORDER BY avg_adherence ASC NULLS LAST`,
    [since, tenantId],
  )).map((r) => ({
    ...r,
    runs: Number(r.runs),
    completed_runs: Number(r.completed_runs),
    avg_adherence: r.avg_adherence != null ? round1(r.avg_adherence) : null,
  }));

  const byUser = (await all(
    `SELECT u.id, u.name, COUNT(r.id) AS runs, AVG(r.adherence_pct) AS avg_adherence
       FROM users u JOIN sop_runs r ON r.user_id = u.id AND r.started_at >= ?
      WHERE u.tenant_id = ? GROUP BY u.id ORDER BY avg_adherence ASC`,
    [since, tenantId],
  )).map((r) => ({ ...r, runs: Number(r.runs), avg_adherence: round1(r.avg_adherence) }));

  const overall = await get(
    'SELECT AVG(adherence_pct) AS a, COUNT(*) AS n FROM sop_runs WHERE tenant_id = ? AND started_at >= ?',
    [tenantId, since],
  );

  return ok(res, {
    since,
    overall_adherence: overall?.a != null ? round1(overall.a) : null,
    total_runs: Number(overall?.n || 0),
    by_sop: bySop,
    by_user: byUser,
  });
});

// ================================================================ D3 KPIs
const kpiSchema = z.object({
  name: z.string().min(2).max(160),
  code: z.string().min(1).max(40),
  kind: z.enum(['kpi', 'kra']).optional(),
  description: z.string().optional().nullable(),
  applies_role: z.enum(['owner', 'manager', 'employee', 'finance', 'hr']).optional().nullable(),
  service_line_id: z.string().optional().nullable(),
  unit: z.enum(['number', 'percent', 'currency', 'ratio']).optional(),
  source: z.string().optional().nullable(),
  formula: z.string().optional().nullable(),
  target_value: z.number().optional().nullable(),
  direction: z.enum(['higher', 'lower']).optional(),
  cadence: z.enum(['weekly', 'monthly', 'quarterly']).optional(),
  weight: z.number().min(0).max(10).optional(),
  active: z.boolean().optional(),
});

const kpiRouter = Router();

kpiRouter.get('/', requires('kpi', 'view'), async (req, res) => {
  const filters = ['k.tenant_id = ?', 'k.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  if (req.query.role) { filters.push('(k.applies_role IS NULL OR k.applies_role = ?)'); params.push(req.query.role); }
  if (req.query.kind) { filters.push('k.kind = ?'); params.push(req.query.kind); }
  if (req.query.service_line_id) { filters.push('k.service_line_id = ?'); params.push(req.query.service_line_id); }

  return ok(res, await all(
    `SELECT k.*, sl.name AS service_line_name FROM kpis k
       LEFT JOIN service_lines sl ON sl.id = k.service_line_id
      WHERE ${filters.join(' AND ')} ORDER BY k.kind, k.applies_role, k.name`,
    params,
  ));
});

kpiRouter.post('/', requires('kpi', 'create'), async (req, res) => {
  const body = validate(kpiSchema, req.body);
  const id = uuid();
  await run(
    `INSERT INTO kpis (id, tenant_id, name, code, kind, description, applies_role, service_line_id,
       unit, source, formula, target_value, direction, cadence, weight, version, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`,
    [id, req.auth.tenantId, body.name, body.code, body.kind || 'kpi', body.description ?? null,
      body.applies_role ?? null, body.service_line_id ?? null, body.unit || 'number',
      body.source ?? null, body.formula ?? null, body.target_value ?? null,
      body.direction || 'higher', body.cadence || 'monthly', body.weight ?? 1, nowIso(), nowIso()],
  );
  await audit(req, { entity: 'kpi', entityId: id, action: 'create', after: { name: body.name } });
  return created(res, await get('SELECT * FROM kpis WHERE id = ?', [id]));
});

kpiRouter.patch('/:id', requires('kpi', 'edit'), async (req, res) => {
  const r = repo('kpis', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('KPI');

  const body = validate(kpiSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.active !== undefined) patch.active = body.active ? 1 : 0;
  // D3: definitions are versioned - a changed target or formula bumps the version.
  if (body.target_value !== undefined || body.formula !== undefined || body.source !== undefined) {
    patch.version = before.version + 1;
  }

  const after = await r.update(req.params.id, patch);
  await audit(req, { entity: 'kpi', entityId: after.id, action: 'update', before, after });
  return ok(res, after);
});

kpiRouter.delete('/:id', requires('kpi', 'delete'), async (req, res) => {
  await repo('kpis', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

export { router as sopRouter, kpiRouter };
