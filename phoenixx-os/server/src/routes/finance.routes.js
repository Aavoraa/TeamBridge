import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo } from '../db/index.js';
import { uuid, nowIso, monthIso, todayIso, toCsv, round1 } from '../lib/util.js';
import { ok, created, validate, notFound, audit, paginate, pageMeta } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { profitability } from '../services/analytics.js';
import { projectsRouter } from './projects.routes.js';
import { syncHrCosts } from '../services/invoicing.js';
import { reimbursementsRouter } from './reimbursements.routes.js';

const router = Router();

// ================================================================== F4 COSTS
const costSchema = z.object({
  category: z.enum(['hr', 'tools', 'rent', 'maintenance', 'marketing', 'misc']),
  label: z.string().min(2).max(160),
  vendor: z.string().optional().nullable(),
  amount_minor: z.number().int().min(0),
  period_month: z.string().regex(/^\d{4}-\d{2}$/),
  client_id: z.string().optional().nullable(),
  project_id: z.string().optional().nullable(),
  service_line_id: z.string().optional().nullable(),
  recurring: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

const COST_SELECT = `
  SELECT co.*, c.name AS client_name, p.name AS project_name, sl.name AS service_line_name,
         u.name AS user_name
    FROM costs co
    LEFT JOIN clients c ON c.id = co.client_id
    LEFT JOIN projects p ON p.id = co.project_id
    LEFT JOIN service_lines sl ON sl.id = co.service_line_id
    LEFT JOIN users u ON u.id = co.user_id`;

router.get('/costs', requires('costs', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['co.tenant_id = ?', 'co.deleted_at IS NULL'];
  const params = [req.auth.tenantId];

  if (req.query.period_month) { filters.push('co.period_month = ?'); params.push(req.query.period_month); }
  if (req.query.from) { filters.push('co.period_month >= ?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('co.period_month <= ?'); params.push(req.query.to); }
  if (req.query.category) { filters.push('co.category = ?'); params.push(req.query.category); }
  if (req.query.client_id) { filters.push('co.client_id = ?'); params.push(req.query.client_id); }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM costs co WHERE ${where}`, params))?.n || 0);
  const rows = await all(`${COST_SELECT} WHERE ${where} ORDER BY co.period_month DESC, co.amount_minor DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]);

  return ok(res, rows, {
    ...pageMeta(page, limit, total),
    summary: {
      total_minor: Number((await get(`SELECT COALESCE(SUM(co.amount_minor),0) AS v FROM costs co WHERE ${where}`, params))?.v || 0),
      by_category: (await all(
        `SELECT co.category, COALESCE(SUM(co.amount_minor),0) AS amount_minor, COUNT(*) AS n
           FROM costs co WHERE ${where} GROUP BY co.category ORDER BY amount_minor DESC`,
        params,
      )).map((r) => ({ ...r, amount_minor: Number(r.amount_minor), n: Number(r.n) })),
    },
  });
});

router.post('/costs', requires('costs', 'create'), async (req, res) => {
  const body = validate(costSchema, req.body);
  const id = uuid();
  await run(
    `INSERT INTO costs (id, tenant_id, category, label, vendor, amount_minor, period_month, client_id,
       project_id, service_line_id, recurring, notes, recorded_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.category, body.label, body.vendor ?? null, body.amount_minor,
      body.period_month, body.client_id ?? null, body.project_id ?? null, body.service_line_id ?? null,
      body.recurring ? 1 : 0, body.notes ?? null, req.auth.userId, nowIso(), nowIso()],
  );
  await audit(req, { entity: 'cost', entityId: id, action: 'create', after: body });
  return created(res, await get(`${COST_SELECT} WHERE co.id = ?`, [id]));
});

router.patch('/costs/:id', requires('costs', 'edit'), async (req, res) => {
  const r = repo('costs', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Cost entry');

  const body = validate(costSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.recurring !== undefined) patch.recurring = body.recurring ? 1 : 0;

  const after = await r.update(req.params.id, patch);
  await audit(req, { entity: 'cost', entityId: after.id, action: 'update', before, after });
  return ok(res, await get(`${COST_SELECT} WHERE co.id = ?`, [after.id]));
});

router.delete('/costs/:id', requires('costs', 'delete'), async (req, res) => {
  const r = repo('costs', req.auth.tenantId);
  if (!await r.findById(req.params.id)) throw notFound('Cost entry');
  await r.softDelete(req.params.id, nowIso());
  await audit(req, { entity: 'cost', entityId: req.params.id, action: 'delete' });
  return ok(res, { ok: true });
});

/** Copies last month's recurring cost rows into the target month. */
router.post('/costs/roll-forward', requires('costs', 'create'), async (req, res) => {
  const { period_month: month } = validate(
    z.object({ period_month: z.string().regex(/^\d{4}-\d{2}$/) }), req.body,
  );
  const { tenantId } = req.auth;
  const [y, m] = month.split('-').map(Number);
  const prev = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}`;

  const source = await all(
    "SELECT * FROM costs WHERE tenant_id = ? AND period_month = ? AND recurring = 1 AND deleted_at IS NULL AND category != 'hr'",
    [tenantId, prev],
  );
  let copied = 0;
  for (const c of source) {
    const exists = await get(
      'SELECT id FROM costs WHERE tenant_id = ? AND period_month = ? AND label = ? AND category = ? AND deleted_at IS NULL',
      [tenantId, month, c.label, c.category],
    );
    if (exists) continue;
    await run(
      `INSERT INTO costs (id, tenant_id, category, label, vendor, amount_minor, period_month, client_id,
         project_id, service_line_id, recurring, notes, recorded_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`,
      [uuid(), tenantId, c.category, c.label, c.vendor, c.amount_minor, month, c.client_id,
        c.project_id, c.service_line_id, c.notes, req.auth.userId, nowIso(), nowIso()],
    );
    copied++;
  }

  // C5 -> F4: pull salary bands in as the HR cost line.
  const hr = await syncHrCosts(tenantId, month);
  await audit(req, { entity: 'cost', action: 'create', after: { rolled_forward: copied, hr_rows: hr, month } });
  return ok(res, { copied, hr_rows: hr, from: prev, to: month });
});

// ========================================================== F5 PROFITABILITY
router.get('/profitability', requires('profitability', 'view'), async (req, res) => {
  const months = Math.min(24, Math.max(1, Number(req.query.months) || 6));
  const endMonth = req.query.end_month || monthIso();
  return ok(res, await profitability(req.auth.tenantId, { months, endMonth }));
});

router.get('/profitability/export', requires('profitability', 'export'), async (req, res) => {
  const data = await profitability(req.auth.tenantId, {
    months: Math.min(24, Number(req.query.months) || 6),
    endMonth: req.query.end_month || monthIso(),
  });
  const rows = data.by_client.map((c) => ({
    client: c.name,
    revenue: c.revenue / 100,
    allocated_cost: c.cost / 100,
    gross_profit: c.gross_profit / 100,
    margin_pct: c.margin_pct,
  }));
  await audit(req, { entity: 'profitability', action: 'export', after: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="profitability.csv"');
  return res.send(toCsv(rows));
});

// ============================================================ AR / COLLECTION
router.get('/receivables', requires('invoices', 'view'), async (req, res) => {
  const today = todayIso();
  const invoices = await all(
    `SELECT i.id, i.number, i.issue_date, i.due_date, i.total_minor, i.paid_minor, i.balance_minor,
            i.status, c.id AS client_id, c.name AS client_name
       FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.balance_minor > 0
        AND i.status NOT IN ('draft','written_off')
      ORDER BY i.due_date`,
    [req.auth.tenantId],
  );

  const bucketFor = (dueDate) => {
    const days = Math.floor((new Date(today) - new Date(dueDate)) / 86_400_000);
    if (days < 0) return 'current';
    if (days <= 30) return '1-30';
    if (days <= 60) return '31-60';
    if (days <= 90) return '61-90';
    return '90+';
  };

  const buckets = { current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
  const byClient = new Map();

  for (const inv of invoices) {
    const b = bucketFor(inv.due_date);
    buckets[b] += inv.balance_minor;
    const entry = byClient.get(inv.client_id)
      || { client_id: inv.client_id, client_name: inv.client_name, total: 0, current: 0, '1-30': 0, '31-60': 0, '61-90': 0, '90+': 0 };
    entry[b] += inv.balance_minor;
    entry.total += inv.balance_minor;
    byClient.set(inv.client_id, entry);
  }

  // Days sales outstanding over the trailing 90 days.
  const revenue90 = Number((await get(
    `SELECT COALESCE(SUM(taxable_minor),0) AS v FROM invoices
      WHERE tenant_id = ? AND deleted_at IS NULL AND status NOT IN ('draft','written_off')
        AND issue_date >= date(?, '-90 day')`,
    [req.auth.tenantId, today],
  ))?.v || 0);
  const outstanding = invoices.reduce((a, i) => a + i.balance_minor, 0);

  return ok(res, {
    aging_buckets: Object.entries(buckets).map(([bucket, amount_minor]) => ({ bucket, amount_minor })),
    by_client: [...byClient.values()].sort((a, b) => b.total - a.total),
    invoices,
    total_outstanding_minor: outstanding,
    dso_days: revenue90 ? round1((outstanding / revenue90) * 90) : 0,
  });
});

// ======================================================== I: REIMBURSEMENTS
// Employee expense claims and the approval chain behind them. Mounted here so
// the whole finance surface sits under one prefix.
router.use('/reimbursements', reimbursementsRouter);

// ============================================================== F: PROJECTS
// Projects and their delivery teams live in their own module now; keeping the
// old `/finance/projects/*` paths mounted means the cost & profit screens and
// any existing integrations carry on working unchanged.
router.use('/projects', projectsRouter);

export { router as financeRouter };
