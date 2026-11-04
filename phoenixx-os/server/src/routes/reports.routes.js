import { Router } from 'express';
import { sendStoredFile } from '../services/storage.js';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, all, run, repo } from '../db/index.js';
import { uuid, nowIso, todayIso, monthIso, addMonths, parseJson, toCsv } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit, paginate, pageMeta } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { seesAllProjects, visibleProjectIds, canSeeProject } from '../services/projectOversight.js';
import {
  generateDailyReport, generateWeeklyReport, generateMonthlyReport,
  generateClientMonthlyReport, runCustomReport, dispatchReport, AVAILABLE_METRICS,
} from '../services/reports.js';
import { renderClientReportPdf, renderInternalReportPdf } from '../services/pdf.js';
import { nextRunFor } from '../services/jobs.js';
import { config } from '../config.js';

const router = Router();

// -------------------------------------------------------------------- runs
router.get('/', requires('reports', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['r.tenant_id = ?'];
  const params = [req.auth.tenantId];

  if (req.query.kind) { filters.push('r.kind = ?'); params.push(req.query.kind); }
  if (req.query.client_id) { filters.push('r.client_id = ?'); params.push(req.query.client_id); }
  if (req.query.status) { filters.push('r.status = ?'); params.push(req.query.status); }
  // Portal users only ever see their own client's reports.
  if (req.auth.role === 'client') { filters.push('r.client_id = ?'); params.push(req.auth.clientId || '__none__'); }
  // A report about one project is for the people who can see that project.
  if (!seesAllProjects(req.auth)) {
    const ids = await visibleProjectIds(req.auth);
    filters.push(`(r.project_id IS NULL${ids.length ? ` OR r.project_id IN (${ids.map(() => '?').join(',')})` : ''})`);
    params.push(...ids);
  }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM report_runs r WHERE ${where}`, params))?.n || 0);

  return ok(res, await all(
    `SELECT r.id, r.kind, r.title, r.client_id, r.period_start, r.period_end, r.status,
            r.pdf_path, r.generated_at, r.dispatched_at, c.name AS client_name
       FROM report_runs r LEFT JOIN clients c ON c.id = r.client_id
      WHERE ${where} ORDER BY r.generated_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ), pageMeta(page, limit, total));
});

router.get('/metrics', requires('reports', 'view'), (req, res) => ok(res, {
  metrics: AVAILABLE_METRICS.map((m) => ({ key: m, label: m.replace(/_/g, ' ') })),
  kinds: ['daily', 'weekly', 'monthly', 'client_monthly', 'custom'],
  schedules: ['daily@03:30', 'weekly@mon-03:30', 'monthly@1-03:30'],
}));

router.get('/:id', requires('reports', 'view'), async (req, res) => {
  const report = await get(
    `SELECT r.*, c.name AS client_name FROM report_runs r LEFT JOIN clients c ON c.id = r.client_id
      WHERE r.id = ? AND r.tenant_id = ?`,
    [req.params.id, req.auth.tenantId],
  );
  if (!report) throw notFound('Report');
  if (req.auth.role === 'client' && report.client_id !== req.auth.clientId) throw notFound('Report');
  if (report.project_id && !await canSeeProject(req.auth, report.project_id)) throw notFound('Report');

  return ok(res, { ...report, payload: parseJson(report.payload, {}) });
});

// -------------------------------------------------------------- generation
router.post('/generate', requires('reports', 'create'), async (req, res) => {
  const body = validate(z.object({
    kind: z.enum(['daily', 'weekly', 'monthly', 'client_monthly']),
    date: z.string().optional(),
    month: z.string().optional(),
    client_id: z.string().optional(),
    all_clients: z.boolean().optional(),
  }), req.body);
  const { tenantId } = req.auth;

  let result;
  if (body.kind === 'daily') result = await generateDailyReport(tenantId, { date: body.date || todayIso() });
  else if (body.kind === 'weekly') result = await generateWeeklyReport(tenantId, { endDate: body.date || todayIso() });
  else if (body.kind === 'monthly') result = await generateMonthlyReport(tenantId, { month: body.month || monthIso(addMonths(new Date(), -1)) });
  else {
    const month = body.month || monthIso(addMonths(new Date(), -1));
    if (body.all_clients) {
      const clients = await all("SELECT id FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'", [tenantId]);
      const generated = (await Promise.all(clients.map(async (c) => await generateClientMonthlyReport(tenantId, c.id, { month })))).filter(Boolean);
      await audit(req, { entity: 'report', action: 'create', after: { kind: body.kind, count: generated.length } });
      return created(res, { generated: generated.length, reports: generated.map((r) => ({ id: r.id, title: r.title })) });
    }
    if (!body.client_id) throw badRequest('A client-facing report needs client_id (or all_clients: true)');
    result = await generateClientMonthlyReport(tenantId, body.client_id, { month });
    if (!result) throw notFound('Client');
  }

  await audit(req, { entity: 'report', entityId: result.id, action: 'create', after: { kind: body.kind } });
  return created(res, { ...result, payload: parseJson(result.payload, {}) });
});

// -------------------------------------------------------------------- PDF
router.get('/:id/pdf', requires('reports', 'view'), async (req, res, next) => {
  try {
    const { tenantId } = req.auth;
    const report = await get('SELECT * FROM report_runs WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
    if (!report) throw notFound('Report');
    if (req.auth.role === 'client' && report.client_id !== req.auth.clientId) throw notFound('Report');

    const tenant = await get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    const hydrated = { ...report, payload: parseJson(report.payload, {}) };

    const rel = report.kind === 'client_monthly'
      ? await renderClientReportPdf({
        tenant, client: await get('SELECT * FROM clients WHERE id = ?', [report.client_id]), report: hydrated,
      })
      : await renderInternalReportPdf({ tenant, report: hydrated });

    await run('UPDATE report_runs SET pdf_path = ? WHERE id = ?', [rel, report.id]);

    if (!(await sendStoredFile(res, rel, { filename: `${report.kind}-${report.period_start}.pdf` }))) throw notFound('PDF');
  } catch (err) { next(err); }
});

router.get('/:id/csv', requires('reports', 'export'), async (req, res) => {
  const report = await get('SELECT * FROM report_runs WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!report) throw notFound('Report');

  const payload = parseJson(report.payload, {});
  const section = (payload.sections || []).find((s) => s.rows?.length)
    || { rows: payload.metrics || [], columns: [{ key: 'label' }, { key: 'value' }] };

  const rows = section.rows || [];
  const cols = section.columns?.map((c) => c.key) || (rows[0] ? Object.keys(rows[0]) : []);

  await audit(req, { entity: 'report', entityId: report.id, action: 'export' });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="${report.kind}-${report.period_start}.csv"`);
  return res.send(toCsv(rows, cols));
});

// --------------------------------------------------------- approve/dispatch
/** G2 - client-facing reports are queued for approval, then dispatched. */
router.post('/:id/approve', requires('reports', 'approve'), async (req, res) => {
  const report = await get('SELECT * FROM report_runs WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!report) throw notFound('Report');

  await run("UPDATE report_runs SET status = 'approved', approved_by = ?, approved_at = ? WHERE id = ?",
    [req.auth.userId, nowIso(), report.id]);
  await audit(req, { entity: 'report', entityId: report.id, action: 'approve' });
  return ok(res, await get('SELECT * FROM report_runs WHERE id = ?', [report.id]));
});

router.post('/:id/dispatch', requires('reports', 'approve'), async (req, res) => {
  const body = validate(z.object({
    recipients: z.array(z.string()).optional(),
    channels: z.array(z.enum(['in_app', 'email', 'whatsapp', 'teams'])).optional(),
  }), req.body || {});

  const result = await dispatchReport(req.auth.tenantId, req.params.id, {
    recipients: body.recipients || [],
    channels: body.channels || ['in_app', 'email'],
  });
  if (!result) throw notFound('Report');

  await audit(req, { entity: 'report', entityId: req.params.id, action: 'update', after: { dispatched: true } });
  return ok(res, result);
});

// ================================================== G3 REPORT BUILDER (LITE)
const definitionSchema = z.object({
  name: z.string().min(2).max(160),
  kind: z.enum(['daily', 'weekly', 'monthly', 'client_monthly', 'custom']).optional(),
  module: z.string().optional().nullable(),
  metrics: z.array(z.string()).optional(),
  filters: z.record(z.string(), z.any()).optional(),
  schedule: z.string().optional().nullable(),
  channels: z.array(z.enum(['in_app', 'email', 'whatsapp', 'teams'])).optional(),
  recipients: z.array(z.string()).optional(),
  client_scope: z.string().optional().nullable(),
  active: z.boolean().optional(),
});

const hydrateDef = (d) => ({
  ...d,
  metrics: parseJson(d.metrics, []),
  filters: parseJson(d.filters, {}),
  channels: parseJson(d.channels, []),
  recipients: parseJson(d.recipients, []),
});

router.get('/definitions/all', requires('reports', 'view'), async (req, res) => ok(res, (await all(
  'SELECT * FROM report_definitions WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name',
  [req.auth.tenantId],
)).map(hydrateDef)));

router.post('/definitions', requires('reports', 'create'), async (req, res) => {
  const body = validate(definitionSchema, req.body);
  const unknown = (body.metrics || []).filter((m) => !AVAILABLE_METRICS.includes(m));
  if (unknown.length) throw badRequest(`Unknown metric(s): ${unknown.join(', ')}`);

  const id = uuid();
  await run(
    `INSERT INTO report_definitions (id, tenant_id, name, kind, module, metrics, filters, schedule,
       channels, recipients, client_scope, next_run_at, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.name, body.kind || 'custom', body.module ?? null,
      JSON.stringify(body.metrics || []), JSON.stringify(body.filters || {}), body.schedule ?? null,
      JSON.stringify(body.channels || ['in_app']), JSON.stringify(body.recipients || []),
      body.client_scope ?? null, body.schedule ? nextRunFor(body.schedule) : null,
      req.auth.userId, nowIso(), nowIso()],
  );

  await audit(req, { entity: 'report_definition', entityId: id, action: 'create', after: { name: body.name } });
  return created(res, hydrateDef(await get('SELECT * FROM report_definitions WHERE id = ?', [id])));
});

router.patch('/definitions/:id', requires('reports', 'edit'), async (req, res) => {
  const r = repo('report_definitions', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Report definition');

  const body = validate(definitionSchema.partial(), req.body);
  const patch = { updated_at: nowIso() };
  for (const k of ['name', 'kind', 'module', 'schedule', 'client_scope']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (body.metrics) patch.metrics = JSON.stringify(body.metrics);
  if (body.filters) patch.filters = JSON.stringify(body.filters);
  if (body.channels) patch.channels = JSON.stringify(body.channels);
  if (body.recipients) patch.recipients = JSON.stringify(body.recipients);
  if (body.active !== undefined) patch.active = body.active ? 1 : 0;
  if (body.schedule !== undefined) patch.next_run_at = body.schedule ? nextRunFor(body.schedule) : null;

  return ok(res, hydrateDef(await r.update(req.params.id, patch)));
});

router.delete('/definitions/:id', requires('reports', 'delete'), async (req, res) => {
  await repo('report_definitions', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

router.post('/definitions/:id/run', requires('reports', 'create'), async (req, res) => {
  const def = await get('SELECT * FROM report_definitions WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!def) throw notFound('Report definition');

  const body = validate(z.object({
    period_start: z.string().optional(), period_end: z.string().optional(),
  }), req.body || {});

  const result = await runCustomReport(req.auth.tenantId, def, {
    periodStart: body.period_start, periodEnd: body.period_end,
  });
  await run('UPDATE report_definitions SET last_run_at = ?, next_run_at = ? WHERE id = ?',
    [nowIso(), def.schedule ? nextRunFor(def.schedule) : null, def.id]);

  return created(res, { ...result, payload: parseJson(result.payload, {}) });
});

export { router as reportsRouter };
