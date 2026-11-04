import { get, all, run } from '../db/index.js';
import {
  uuid, nowIso, todayIso, monthIso, addDays, addMonths, startOfMonth, endOfMonth,
  pct, round1, sum, formatMoney,
} from '../lib/util.js';
import { profitability, laggingIndicators, overviewDashboard } from './analytics.js';
import { notifyMany, notifyRole } from './notifications.js';
import { renderClientReportPdf, renderInternalReportPdf } from './pdf.js';

/**
 * Module G - report generation.
 *
 * G1 internal reports (daily / weekly / monthly), G2 the client-facing monthly
 * report, G3 the saved-definition "report builder lite". Generation is always
 * async work driven by the job runner so it never blocks a request (AR9).
 */

const tenantOf = async (id) => await get('SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL', [id]);

async function persistRun(tenantId, { definitionId = null, kind, title, clientId = null, periodStart, periodEnd, payload }) {
  const id = uuid();
  await run(
    `INSERT INTO report_runs (id, tenant_id, definition_id, kind, title, client_id, period_start,
       period_end, status, payload, generated_at, created_at)
     VALUES (?,?,?,?,?,?,?,?,'generated',?,?,?)`,
    [id, tenantId, definitionId, kind, title, clientId, periodStart, periodEnd,
      JSON.stringify(payload), nowIso(), nowIso()],
  );
  return await get('SELECT * FROM report_runs WHERE id = ?', [id]);
}

// ------------------------------------------------------------- G1: DAILY
export async function generateDailyReport(tenantId, { date = todayIso() } = {}) {
  const tenant = await tenantOf(tenantId);
  const money = (m) => formatMoney(m, tenant.currency, tenant.number_format);

  const dueToday = await all(
    `SELECT a.*, u.name AS owner_name, c.name AS client_name
       FROM action_items a
       LEFT JOIN users u ON u.id = a.owner_id
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.tenant_id = ? AND a.deleted_at IS NULL
        AND a.status NOT IN ('done','cancelled') AND a.due_date = ?`,
    [tenantId, date],
  );
  const overdue = await all(
    `SELECT a.*, u.name AS owner_name, c.name AS client_name
       FROM action_items a
       LEFT JOIN users u ON u.id = a.owner_id
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.tenant_id = ? AND a.deleted_at IS NULL
        AND a.status NOT IN ('done','cancelled') AND a.due_date < ?
      ORDER BY a.due_date`,
    [tenantId, date],
  );
  const attendance = await all(
    `SELECT at.*, u.name FROM attendance at JOIN users u ON u.id = at.user_id
      WHERE at.tenant_id = ? AND at.work_date = ?`,
    [tenantId, date],
  );
  const headcount = Number((await get(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status='active' AND role != 'client'",
    [tenantId],
  ))?.n || 0);
  const followUps = await all(
    `SELECT c.id, c.name, c.next_action, c.next_action_date, u.name AS owner_name
       FROM clients c LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.next_action_date <= ?
        AND c.status IN ('lead','active') ORDER BY c.next_action_date`,
    [tenantId, date],
  );
  const invoicesDue = await all(
    `SELECT i.number, i.due_date, i.balance_minor, c.name AS client_name
       FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.balance_minor > 0
        AND i.status NOT IN ('draft','written_off') AND i.due_date <= ?
      ORDER BY i.due_date`,
    [tenantId, addDays(date, 3).toISOString().slice(0, 10)],
  );

  const payload = {
    period: date,
    period_label: date,
    sections: [
      {
        heading: 'At a glance',
        stats: [
          { label: 'Due today', value: dueToday.length },
          { label: 'Overdue', value: overdue.length },
          { label: 'Follow-ups due', value: followUps.length },
          { label: 'Attendance', value: `${pct(attendance.filter((a) => ['present', 'wfh'].includes(a.status)).length, headcount)}%` },
        ],
      },
      {
        heading: 'Overdue action items',
        columns: [
          { key: 'title', label: 'Item', width: 44, strong: true },
          { key: 'owner_name', label: 'Owner', width: 20 },
          { key: 'client_name', label: 'Client', width: 20 },
          { key: 'due_date', label: 'Due', width: 16, align: 'right' },
        ],
        rows: overdue.slice(0, 25).map((r) => ({ ...r, client_name: r.client_name || '-', owner_name: r.owner_name || '-' })),
      },
      {
        heading: 'Follow-ups due',
        columns: [
          { key: 'name', label: 'Client', width: 30, strong: true },
          { key: 'next_action', label: 'Next action', width: 42 },
          { key: 'owner_name', label: 'Owner', width: 16 },
          { key: 'next_action_date', label: 'Date', width: 12, align: 'right' },
        ],
        rows: followUps.slice(0, 25).map((r) => ({ ...r, owner_name: r.owner_name || '-' })),
      },
      {
        heading: 'Invoices due or overdue',
        columns: [
          { key: 'number', label: 'Invoice', width: 26, strong: true },
          { key: 'client_name', label: 'Client', width: 38 },
          { key: 'due_date', label: 'Due', width: 18 },
          { key: 'balance', label: 'Balance', width: 18, align: 'right' },
        ],
        rows: invoicesDue.slice(0, 20).map((i) => ({ ...i, balance: money(i.balance_minor) })),
      },
    ],
    counts: {
      due_today: dueToday.length,
      overdue: overdue.length,
      follow_ups: followUps.length,
      invoices_due: invoicesDue.length,
      attendance_pct: pct(attendance.filter((a) => ['present', 'wfh'].includes(a.status)).length, headcount),
    },
  };

  return await persistRun(tenantId, {
    kind: 'daily',
    title: `Daily operations report - ${date}`,
    periodStart: date,
    periodEnd: date,
    payload,
  });
}

// ------------------------------------------------------------ G1: WEEKLY
export async function generateWeeklyReport(tenantId, { endDate = todayIso() } = {}) {
  const start = addDays(endDate, -6).toISOString().slice(0, 10);

  const items = await get(
    `SELECT COUNT(*) AS assigned, COUNT(CASE WHEN status='done' THEN 1 END) AS done,
            COUNT(CASE WHEN status='done' AND completed_at <= due_date || 'T23:59:59Z' THEN 1 END) AS on_time
       FROM action_items WHERE tenant_id = ? AND deleted_at IS NULL AND due_date BETWEEN ? AND ?`,
    [tenantId, start, endDate],
  ) || {};

  const sop = await get(
    'SELECT AVG(adherence_pct) AS avg_adherence, COUNT(*) AS runs FROM sop_runs WHERE tenant_id = ? AND started_at >= ?',
    [tenantId, start],
  ) || {};

  const followUps = await get(
    `SELECT COUNT(*) AS due, COUNT(CASE WHEN last_activity_at >= ? THEN 1 END) AS actioned
       FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
         AND next_action_date BETWEEN ? AND ?`,
    [start, tenantId, start, endDate],
  ) || {};

  const movement = (await all(
    `SELECT sh.to_stage AS stage, COUNT(*) AS moves FROM stage_history sh
      WHERE sh.tenant_id = ? AND sh.changed_at >= ? GROUP BY sh.to_stage ORDER BY moves DESC`,
    [tenantId, `${start}T00:00:00Z`],
  )).map((r) => ({ ...r, moves: Number(r.moves) }));

  const escalations = await all(
    `SELECT e.*, uf.name AS from_name, ut.name AS to_name FROM escalations e
       LEFT JOIN users uf ON uf.id = e.from_user_id
       LEFT JOIN users ut ON ut.id = e.to_user_id
      WHERE e.tenant_id = ? AND e.created_at >= ? ORDER BY e.created_at DESC`,
    [tenantId, `${start}T00:00:00Z`],
  );

  const perOwner = (await all(
    `SELECT u.id, u.name, COUNT(a.id) AS assigned,
            COUNT(CASE WHEN a.status='done' THEN 1 END) AS done
       FROM users u LEFT JOIN action_items a
         ON a.owner_id = u.id AND a.deleted_at IS NULL AND a.due_date BETWEEN ? AND ?
      WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.role NOT IN ('client')
      GROUP BY u.id HAVING COUNT(a.id) > 0
      ORDER BY COUNT(CASE WHEN a.status='done' THEN 1 END) * 1.0 / COUNT(a.id) ASC`,
    [start, endDate, tenantId],
  )).map((r) => ({ ...r, assigned: Number(r.assigned), done: Number(r.done), completion: `${pct(Number(r.done), Number(r.assigned))}%` }));

  const payload = {
    period: `${start}..${endDate}`,
    period_label: `${start} to ${endDate}`,
    sections: [
      {
        heading: 'Weekly scorecard',
        stats: [
          { label: 'Completion', value: `${pct(Number(items.done || 0), Number(items.assigned || 0))}%` },
          { label: 'On-time', value: `${pct(Number(items.on_time || 0), Number(items.done || 0))}%` },
          { label: 'SOP adherence', value: `${round1(sop.avg_adherence || 0)}%` },
          { label: 'Escalations', value: escalations.length },
        ],
      },
      {
        heading: 'Completion by owner',
        columns: [
          { key: 'name', label: 'Team member', width: 44, strong: true },
          { key: 'assigned', label: 'Assigned', width: 18, align: 'right' },
          { key: 'done', label: 'Done', width: 18, align: 'right' },
          { key: 'completion', label: 'Rate', width: 20, align: 'right' },
        ],
        rows: perOwner,
      },
      {
        heading: 'Escalations raised',
        columns: [
          { key: 'source_type', label: 'Source', width: 20 },
          { key: 'reason', label: 'Reason', width: 34 },
          { key: 'from_name', label: 'From', width: 16 },
          { key: 'to_name', label: 'To', width: 16 },
          { key: 'state', label: 'State', width: 14, align: 'right' },
        ],
        rows: escalations.slice(0, 20).map((e) => ({
          ...e, from_name: e.from_name || '-', to_name: e.to_name || '-',
          state: e.resolved_at ? 'resolved' : `open L${e.level}`,
        })),
      },
      {
        heading: 'Pipeline movement',
        columns: [
          { key: 'stage', label: 'Moved into stage', width: 70, strong: true },
          { key: 'moves', label: 'Count', width: 30, align: 'right' },
        ],
        rows: movement,
      },
    ],
    counts: {
      completion_pct: pct(Number(items.done || 0), Number(items.assigned || 0)),
      on_time_pct: pct(Number(items.on_time || 0), Number(items.done || 0)),
      sop_adherence: round1(sop.avg_adherence || 0),
      sop_runs: Number(sop.runs || 0),
      follow_up_pct: pct(Number(followUps.actioned || 0), Number(followUps.due || 0)),
      escalations: escalations.length,
      escalations_open: escalations.filter((e) => !e.resolved_at).length,
    },
  };

  return await persistRun(tenantId, {
    kind: 'weekly',
    title: `Weekly operations report - week ending ${endDate}`,
    periodStart: start,
    periodEnd: endDate,
    payload,
  });
}

// ----------------------------------------------------------- G1: MONTHLY
export async function generateMonthlyReport(tenantId, { month = monthIso(addMonths(new Date(), -1)) } = {}) {
  const tenant = await tenantOf(tenantId);
  const money = (m) => formatMoney(m, tenant.currency, tenant.number_format);
  const from = startOfMonth(month).slice(0, 10);
  const to = endOfMonth(month).slice(0, 10);

  const prof = await profitability(tenantId, { months: 1, endMonth: month });
  const dash = await overviewDashboard(tenantId, { month });

  const reviews = await all(
    `SELECT r.*, u.name FROM performance_reviews r JOIN users u ON u.id = r.user_id
      WHERE r.tenant_id = ? AND r.period_month = ? ORDER BY r.overall_score DESC`,
    [tenantId, month],
  );

  const clientProfit = prof.by_client.slice(0, 15).map((c) => ({
    name: c.name,
    revenue: money(c.revenue),
    cost: money(c.cost),
    profit: money(c.gross_profit),
    margin: `${c.margin_pct}%`,
  }));

  const payload = {
    period: month,
    period_label: month,
    sections: [
      {
        heading: 'Company scorecard',
        stats: [
          { label: 'Revenue', value: money(prof.company.revenue_minor) },
          { label: 'Cost', value: money(prof.company.cost_minor) },
          { label: 'Gross profit', value: money(prof.company.gross_profit_minor) },
          { label: 'Margin', value: `${prof.company.margin_pct}%` },
        ],
      },
      {
        heading: 'Client profitability',
        columns: [
          { key: 'name', label: 'Client', width: 32, strong: true },
          { key: 'revenue', label: 'Revenue', width: 18, align: 'right' },
          { key: 'cost', label: 'Allocated cost', width: 20, align: 'right' },
          { key: 'profit', label: 'Gross profit', width: 18, align: 'right' },
          { key: 'margin', label: 'Margin', width: 12, align: 'right' },
        ],
        rows: clientProfit,
      },
      {
        heading: 'KPI / KRA review',
        columns: [
          { key: 'name', label: 'Employee', width: 34, strong: true },
          { key: 'completion', label: 'Completion', width: 18, align: 'right' },
          { key: 'attendance', label: 'Attendance', width: 18, align: 'right' },
          { key: 'kpi', label: 'KPI score', width: 15, align: 'right' },
          { key: 'rating', label: 'Rating', width: 15, align: 'right' },
        ],
        rows: reviews.map((r) => ({
          name: r.name,
          completion: `${round1(r.completion_pct)}%`,
          attendance: `${round1(r.attendance_pct)}%`,
          kpi: round1(r.kpi_score),
          rating: r.manager_rating ?? '-',
        })),
      },
      {
        heading: 'Dashboard review',
        text: [
          `Active clients ${dash.clients.active.value} (${dash.clients.active.change >= 0 ? '+' : ''}${dash.clients.active.change} vs previous period).`,
          `MRR ${money(dash.revenue.mrr_minor)}; outstanding ${money(dash.revenue.outstanding_minor)} of which ${money(dash.revenue.overdue_minor)} is overdue.`,
          `Headcount ${dash.hr.headcount}, utilisation ${dash.hr.utilization_pct}%, attendance ${dash.hr.attendance_pct}%.`,
          `${dash.lagging.overdue_action_items} overdue action item(s), ${dash.lagging.open_escalations} open escalation(s).`,
        ].join(' '),
      },
    ],
    counts: {
      revenue_minor: prof.company.revenue_minor,
      cost_minor: prof.company.cost_minor,
      profit_minor: prof.company.gross_profit_minor,
      margin_pct: prof.company.margin_pct,
      reviews: reviews.length,
    },
  };

  return await persistRun(tenantId, {
    kind: 'monthly',
    title: `Monthly business review - ${month}`,
    periodStart: from,
    periodEnd: to,
    payload,
  });
}

// ------------------------------------------------- G2: CLIENT-FACING MONTHLY
export async function generateClientMonthlyReport(tenantId, clientId, { month = monthIso(addMonths(new Date(), -1)) } = {}) {
  const client = await get('SELECT * FROM clients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [clientId, tenantId]);
  if (!client) return null;
  const from = startOfMonth(month);
  const to = endOfMonth(month);

  const delivered = await all(
    `SELECT a.title, a.completed_at, ac.name AS category
       FROM action_items a LEFT JOIN action_categories ac ON ac.id = a.category_id
      WHERE a.tenant_id = ? AND a.client_id = ? AND a.deleted_at IS NULL
        AND a.status = 'done' AND a.completed_at >= ? AND a.completed_at <= ?
      ORDER BY a.completed_at`,
    [tenantId, clientId, from, to],
  );
  const assigned = Number((await get(
    `SELECT COUNT(*) AS n FROM action_items WHERE tenant_id = ? AND client_id = ? AND deleted_at IS NULL
       AND due_date >= ? AND due_date <= ?`,
    [tenantId, clientId, from.slice(0, 10), to.slice(0, 10)],
  ))?.n || 0);

  const meetings = Number((await get(
    `SELECT COUNT(*) AS n FROM meetings WHERE tenant_id = ? AND client_id = ? AND deleted_at IS NULL
       AND scheduled_at >= ? AND scheduled_at <= ?`,
    [tenantId, clientId, from, to],
  ))?.n || 0);

  const invoiced = Number((await get(
    `SELECT COALESCE(SUM(taxable_minor),0) AS v FROM invoices WHERE tenant_id = ? AND client_id = ?
       AND deleted_at IS NULL AND status NOT IN ('draft','written_off')
       AND issue_date >= ? AND issue_date <= ?`,
    [tenantId, clientId, from.slice(0, 10), to.slice(0, 10)],
  ))?.v || 0);

  const nextMonth = await all(
    `SELECT title FROM action_items WHERE tenant_id = ? AND client_id = ? AND deleted_at IS NULL
       AND status NOT IN ('done','cancelled') AND due_date > ? ORDER BY due_date LIMIT 10`,
    [tenantId, clientId, to.slice(0, 10)],
  );

  // KPI-style client metrics sourced from the delivery record.
  const metrics = [
    { name: 'Deliverables completed', target: assigned || delivered.length, actual: delivered.length },
    { name: 'On-time completion', target: '100%', actual: `${pct(delivered.length, assigned || delivered.length)}%` },
    { name: 'Review meetings held', target: 1, actual: meetings },
    { name: 'Scope delivered', target: client.scope_total || '-', actual: client.scope_delivered || '-' },
  ];

  const payload = {
    period: month,
    period_label: month,
    client_id: clientId,
    client_name: client.name,
    delivered_count: delivered.length,
    completion_pct: pct(delivered.length, assigned || delivered.length),
    meetings,
    invoiced_minor: invoiced,
    summary: `During ${month} we completed ${delivered.length} deliverable(s) for ${client.name} across ${meetings} review meeting(s).`,
    delivered,
    metrics,
    next_month: nextMonth,
  };

  return await persistRun(tenantId, {
    kind: 'client_monthly',
    title: `${client.name} - monthly report ${month}`,
    clientId,
    periodStart: from.slice(0, 10),
    periodEnd: to.slice(0, 10),
    payload,
  });
}

// ---------------------------------------------------- G3: BUILDER-LITE
const METRIC_SOURCES = {
  action_items_total: async (t, f, to) => Number((await get("SELECT COUNT(*) AS n FROM action_items WHERE tenant_id=? AND deleted_at IS NULL AND created_at BETWEEN ? AND ?", [t, f, to]))?.n || 0),
  action_items_done: async (t, f, to) => Number((await get("SELECT COUNT(*) AS n FROM action_items WHERE tenant_id=? AND deleted_at IS NULL AND status='done' AND completed_at BETWEEN ? AND ?", [t, f, to]))?.n || 0),
  action_items_overdue: async (t) => Number((await get("SELECT COUNT(*) AS n FROM action_items WHERE tenant_id=? AND deleted_at IS NULL AND status NOT IN ('done','cancelled') AND due_date < ?", [t, todayIso()]))?.n || 0),
  clients_new: async (t, f, to) => Number((await get('SELECT COUNT(*) AS n FROM clients WHERE tenant_id=? AND deleted_at IS NULL AND created_at BETWEEN ? AND ?', [t, f, to]))?.n || 0),
  clients_active: async (t) => Number((await get("SELECT COUNT(*) AS n FROM clients WHERE tenant_id=? AND deleted_at IS NULL AND status='active'", [t]))?.n || 0),
  clients_at_risk: async (t) => Number((await get('SELECT COUNT(*) AS n FROM clients WHERE tenant_id=? AND deleted_at IS NULL AND retention_risk=1', [t]))?.n || 0),
  revenue: async (t, f, to) => Number((await get("SELECT COALESCE(SUM(taxable_minor),0) AS v FROM invoices WHERE tenant_id=? AND deleted_at IS NULL AND status NOT IN ('draft','written_off') AND issue_date BETWEEN ? AND ?", [t, f.slice(0, 10), to.slice(0, 10)]))?.v || 0),
  collected: async (t, f, to) => Number((await get('SELECT COALESCE(SUM(amount_minor),0) AS v FROM payments WHERE tenant_id=? AND deleted_at IS NULL AND paid_at BETWEEN ? AND ?', [t, f, to]))?.v || 0),
  outstanding: async (t) => Number((await get("SELECT COALESCE(SUM(balance_minor),0) AS v FROM invoices WHERE tenant_id=? AND deleted_at IS NULL AND status NOT IN ('draft','paid','written_off')", [t]))?.v || 0),
  costs: async (t, f) => Number((await get('SELECT COALESCE(SUM(amount_minor),0) AS v FROM costs WHERE tenant_id=? AND deleted_at IS NULL AND period_month=?', [t, f.slice(0, 7)]))?.v || 0),
  escalations: async (t, f, to) => Number((await get('SELECT COUNT(*) AS n FROM escalations WHERE tenant_id=? AND created_at BETWEEN ? AND ?', [t, f, to]))?.n || 0),
  proposals_sent: async (t, f, to) => Number((await get('SELECT COUNT(*) AS n FROM proposals WHERE tenant_id=? AND deleted_at IS NULL AND sent_at BETWEEN ? AND ?', [t, f, to]))?.n || 0),
  proposals_accepted: async (t, f, to) => Number((await get('SELECT COUNT(*) AS n FROM proposals WHERE tenant_id=? AND deleted_at IS NULL AND accepted_at BETWEEN ? AND ?', [t, f, to]))?.n || 0),
  attendance_pct: async (t, f, to) => {
    const r = await get("SELECT COUNT(*) AS n, COUNT(CASE WHEN status IN ('present','wfh') THEN 1 END) AS p FROM attendance WHERE tenant_id=? AND work_date BETWEEN ? AND ?", [t, f.slice(0, 10), to.slice(0, 10)]) || {};
    return pct(Number(r.p || 0), Number(r.n || 0));
  },
  sop_adherence: async (t, f) => round1(Number((await get('SELECT AVG(adherence_pct) AS a FROM sop_runs WHERE tenant_id=? AND started_at >= ?', [t, f]))?.a || 0)),
};

export const AVAILABLE_METRICS = Object.keys(METRIC_SOURCES);

export async function runCustomReport(tenantId, definition, { periodStart, periodEnd } = {}) {
  const filters = typeof definition.filters === 'string' ? JSON.parse(definition.filters || '{}') : (definition.filters || {});
  const metrics = typeof definition.metrics === 'string' ? JSON.parse(definition.metrics || '[]') : (definition.metrics || []);
  const from = periodStart || filters.from || startOfMonth(monthIso());
  const to = periodEnd || filters.to || nowIso();

  const values = [];
  for (const m of metrics.filter((k) => METRIC_SOURCES[k])) {
    values.push({ key: m, label: m.replace(/_/g, ' '), value: await METRIC_SOURCES[m](tenantId, from, to) });
  }

  const payload = {
    period: `${from.slice(0, 10)}..${to.slice(0, 10)}`,
    period_label: `${from.slice(0, 10)} to ${to.slice(0, 10)}`,
    sections: [
      { heading: definition.name, stats: values.slice(0, 4).map((v) => ({ label: v.label, value: v.value })) },
      {
        heading: 'All metrics',
        columns: [
          { key: 'label', label: 'Metric', width: 70, strong: true },
          { key: 'value', label: 'Value', width: 30, align: 'right' },
        ],
        rows: values,
      },
    ],
    metrics: values,
  };

  return await persistRun(tenantId, {
    definitionId: definition.id,
    kind: 'custom',
    title: definition.name,
    periodStart: from.slice(0, 10),
    periodEnd: to.slice(0, 10),
    payload,
  });
}

// ------------------------------------------------------------------ dispatch
/** G2/G4 - render the PDF and deliver through the configured channels. */
export async function dispatchReport(tenantId, reportId, { recipients = [], channels = ['in_app', 'email'] } = {}) {
  const report = await get('SELECT * FROM report_runs WHERE id = ? AND tenant_id = ?', [reportId, tenantId]);
  if (!report) return null;
  const tenant = await tenantOf(tenantId);
  const payload = JSON.parse(report.payload);
  const hydrated = { ...report, payload };

  let pdfPath = report.pdf_path;
  try {
    if (report.kind === 'client_monthly') {
      const client = await get('SELECT * FROM clients WHERE id = ?', [report.client_id]);
      pdfPath = await renderClientReportPdf({ tenant, client, report: hydrated });
    } else {
      pdfPath = await renderInternalReportPdf({ tenant, report: hydrated });
    }
  } catch (err) {
    console.error('[report] pdf failed', err.message);
  }

  await run(
    `UPDATE report_runs SET pdf_path = ?, status = 'dispatched', dispatched_at = ?, dispatch_status = 'sent' WHERE id = ?`,
    [pdfPath, nowIso(), reportId],
  );

  const vars = { title: report.title, period: payload.period_label || payload.period };
  if (recipients.length) {
    await notifyMany({ tenantId, userIds: recipients, eventKey: 'report.ready', vars, link: `/reports/${reportId}`, channels });
  } else {
    await notifyRole({ tenantId, roles: ['owner', 'manager'], eventKey: 'report.ready', vars, link: `/reports/${reportId}`, channels });
  }

  return await get('SELECT * FROM report_runs WHERE id = ?', [reportId]);
}

// ------------------------------------------------------------- daily digest
/** B4 - per-user morning summary of what is due and overdue. */
export async function sendDailyDigests(tenantId) {
  const today = todayIso();
  const users = await all(
    "SELECT * FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'",
    [tenantId],
  );
  let sent = 0;

  for (const user of users) {
    const dueToday = Number((await get(
      `SELECT COUNT(*) AS n FROM action_items WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL
         AND status NOT IN ('done','cancelled') AND due_date = ?`,
      [tenantId, user.id, today],
    ))?.n || 0);
    const overdue = Number((await get(
      `SELECT COUNT(*) AS n FROM action_items WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL
         AND status NOT IN ('done','cancelled') AND due_date < ?`,
      [tenantId, user.id, today],
    ))?.n || 0);
    const followUps = Number((await get(
      `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL
         AND next_action_date <= ? AND status IN ('lead','active')`,
      [tenantId, user.id, today],
    ))?.n || 0);
    const meetings = Number((await get(
      `SELECT COUNT(*) AS n FROM meetings m
         LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
        WHERE m.tenant_id = ? AND m.deleted_at IS NULL AND m.status = 'scheduled'
          AND date(m.scheduled_at) = ? AND (m.organizer_id = ? OR ma.user_id = ?)`,
      [tenantId, today, user.id, user.id],
    ))?.n || 0);

    if (!dueToday && !overdue && !followUps && !meetings) continue;

    await notifyMany({
      tenantId,
      userIds: [user.id],
      eventKey: 'digest.daily',
      vars: { due_today: dueToday, overdue, follow_ups: followUps, meetings },
      link: '/',
      dedupeKey: `digest:${today}:${user.id}`,
    });
    sent++;
  }
  return sent;
}

/** B4 - weekly escalation report to each manager. */
export async function sendWeeklyEscalationReports(tenantId) {
  const managers = await all(
    "SELECT * FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role IN ('manager','owner') AND status = 'active'",
    [tenantId],
  );
  const weekAgo = addDays(new Date(), -7).toISOString();
  const weekly = await generateWeeklyReport(tenantId);
  const counts = JSON.parse(weekly.payload).counts;
  let sent = 0;

  for (const m of managers) {
    const escalations = Number((await get(
      'SELECT COUNT(*) AS n FROM escalations WHERE tenant_id = ? AND to_user_id = ? AND created_at >= ?',
      [tenantId, m.id, weekAgo],
    ))?.n || 0);
    const overdue = Number((await get(
      `SELECT COUNT(*) AS n FROM action_items a JOIN users u ON u.id = a.owner_id
        WHERE a.tenant_id = ? AND (u.manager_id = ? OR a.owner_id = ?) AND a.deleted_at IS NULL
          AND a.status NOT IN ('done','cancelled') AND a.due_date < ?`,
      [tenantId, m.id, m.id, todayIso()],
    ))?.n || 0);

    await notifyMany({
      tenantId,
      userIds: [m.id],
      eventKey: 'digest.weekly_escalation',
      vars: {
        escalations,
        overdue,
        sop_adherence: counts.sop_adherence,
        follow_up_pct: counts.follow_up_pct,
      },
      link: `/reports/${weekly.id}`,
      dedupeKey: `weekly:${todayIso()}:${m.id}`,
    });
    sent++;
  }
  return sent;
}
