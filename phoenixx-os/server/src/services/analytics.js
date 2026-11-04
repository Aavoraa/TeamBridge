import { get, all, run } from '../db/index.js';
import {
  uuid, nowIso, todayIso, monthIso, monthsBack, addMonths, addDays,
  startOfMonth, endOfMonth, pct, round1, sum, parseJson, daysBetween,
} from '../lib/util.js';

/**
 * Modules F5 + H - profitability and the Overview Traction Dashboard.
 *
 * Everything here is a read model computed from source records; nothing is
 * denormalised except `metric_snapshots`, which exists purely so MoM/QoQ
 * comparisons (H4) do not have to replay history on every request.
 */

const monthRange = (month) => [startOfMonth(month), endOfMonth(month)];

// ============================================================ PROFITABILITY
/**
 * F5 - revenue minus allocated cost, at client / project / service-line /
 * company level.
 *
 * Cost allocation: a cost row pinned to a client or project is charged
 * directly; unpinned overheads (rent, tools, HR without a client) are spread
 * across clients in proportion to the revenue they produced that month.
 */
export async function profitability(tenantId, { months = 6, endMonth = monthIso() } = {}) {
  const list = monthsBack(months, new Date(`${endMonth}-01T00:00:00Z`));
  const serviceLines = await all('SELECT id, name, code, color FROM service_lines WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]);
  const slName = Object.fromEntries(serviceLines.map((s) => [s.id, s.name]));

  const byMonth = [];
  const clientTotals = new Map();
  const projectTotals = new Map();
  const serviceLineTotals = new Map();

  for (const month of list) {
    const [from, to] = monthRange(month);

    // Revenue = invoices issued in the month, excluding drafts and write-offs.
    const invoices = await all(
      `SELECT i.*, c.name AS client_name FROM invoices i
         JOIN clients c ON c.id = i.client_id
        WHERE i.tenant_id = ? AND i.deleted_at IS NULL
          AND i.status NOT IN ('draft','written_off')
          AND i.issue_date >= ? AND i.issue_date <= ?`,
      [tenantId, from.slice(0, 10), to.slice(0, 10)],
    );

    // Service-line revenue comes off the line items, which carry the line id.
    const lineRevenue = await all(
      `SELECT ii.service_line_id, SUM(ii.taxable_minor) AS rev
         FROM invoice_items ii JOIN invoices i ON i.id = ii.invoice_id
        WHERE i.tenant_id = ? AND i.deleted_at IS NULL
          AND i.status NOT IN ('draft','written_off')
          AND i.issue_date >= ? AND i.issue_date <= ?
        GROUP BY ii.service_line_id`,
      [tenantId, from.slice(0, 10), to.slice(0, 10)],
    );

    const costs = await all(
      'SELECT * FROM costs WHERE tenant_id = ? AND deleted_at IS NULL AND period_month = ?',
      [tenantId, month],
    );

    const revenue = sum(invoices, (i) => i.taxable_minor);
    const collected = sum(invoices, (i) => i.paid_minor);
    const directCost = sum(costs.filter((c) => c.client_id || c.project_id), (c) => c.amount_minor);
    const overhead = sum(costs.filter((c) => !c.client_id && !c.project_id), (c) => c.amount_minor);
    const totalCost = directCost + overhead;

    // -- per client -----------------------------------------------------
    const perClient = new Map();
    for (const inv of invoices) {
      const e = perClient.get(inv.client_id) || { id: inv.client_id, name: inv.client_name, revenue: 0, cost: 0 };
      e.revenue += inv.taxable_minor;
      perClient.set(inv.client_id, e);
    }
    for (const c of costs.filter((x) => x.client_id)) {
      const e = perClient.get(c.client_id) || { id: c.client_id, name: '(cost only)', revenue: 0, cost: 0 };
      e.cost += c.amount_minor;
      perClient.set(c.client_id, e);
    }
    // Spread overhead by revenue share.
    for (const e of perClient.values()) {
      e.allocated_overhead = revenue ? Math.round((e.revenue / revenue) * overhead) : 0;
      e.total_cost = e.cost + e.allocated_overhead;
      e.gross_profit = e.revenue - e.total_cost;
      e.margin_pct = e.revenue ? round1((e.gross_profit / e.revenue) * 100) : 0;

      const acc = clientTotals.get(e.id) || { id: e.id, name: e.name, revenue: 0, cost: 0, gross_profit: 0 };
      acc.name = e.name !== '(cost only)' ? e.name : acc.name;
      acc.revenue += e.revenue;
      acc.cost += e.total_cost;
      acc.gross_profit += e.gross_profit;
      clientTotals.set(e.id, acc);
    }

    // -- per project ----------------------------------------------------
    for (const inv of invoices.filter((i) => i.project_id)) {
      const acc = projectTotals.get(inv.project_id) || { id: inv.project_id, revenue: 0, cost: 0 };
      acc.revenue += inv.taxable_minor;
      projectTotals.set(inv.project_id, acc);
    }
    for (const c of costs.filter((x) => x.project_id)) {
      const acc = projectTotals.get(c.project_id) || { id: c.project_id, revenue: 0, cost: 0 };
      acc.cost += c.amount_minor;
      projectTotals.set(c.project_id, acc);
    }

    // -- per service line ----------------------------------------------
    for (const lr of lineRevenue) {
      if (!lr.service_line_id) continue;
      const acc = serviceLineTotals.get(lr.service_line_id)
        || { id: lr.service_line_id, name: slName[lr.service_line_id] || 'Unassigned', revenue: 0, cost: 0 };
      acc.revenue += Number(lr.rev || 0);
      serviceLineTotals.set(lr.service_line_id, acc);
    }
    for (const c of costs.filter((x) => x.service_line_id)) {
      const acc = serviceLineTotals.get(c.service_line_id)
        || { id: c.service_line_id, name: slName[c.service_line_id] || 'Unassigned', revenue: 0, cost: 0 };
      acc.cost += c.amount_minor;
      serviceLineTotals.set(c.service_line_id, acc);
    }

    byMonth.push({
      month,
      revenue_minor: revenue,
      collected_minor: collected,
      cost_minor: totalCost,
      direct_cost_minor: directCost,
      overhead_minor: overhead,
      gross_profit_minor: revenue - totalCost,
      margin_pct: revenue ? round1(((revenue - totalCost) / revenue) * 100) : 0,
      cost_breakdown: ['hr', 'tools', 'rent', 'maintenance', 'marketing', 'misc'].map((cat) => ({
        category: cat,
        amount_minor: sum(costs.filter((c) => c.category === cat), (c) => c.amount_minor),
      })),
      clients: [...perClient.values()].sort((a, b) => b.gross_profit - a.gross_profit),
    });
  }

  const finish = (m) => [...m.values()].map((e) => ({
    ...e,
    gross_profit: e.gross_profit ?? e.revenue - e.cost,
    margin_pct: e.revenue ? round1((((e.gross_profit ?? e.revenue - e.cost)) / e.revenue) * 100) : 0,
  })).sort((a, b) => b.revenue - a.revenue);

  const projects = finish(projectTotals);
  const projectNames = projects.length
    ? Object.fromEntries((await all(
      `SELECT id, name FROM projects WHERE tenant_id = ? AND id IN (${projects.map(() => '?').join(',')})`,
      [tenantId, ...projects.map((p) => p.id)],
    )).map((p) => [p.id, p.name]))
    : {};

  const company = {
    revenue_minor: sum(byMonth, (m) => m.revenue_minor),
    cost_minor: sum(byMonth, (m) => m.cost_minor),
  };
  company.gross_profit_minor = company.revenue_minor - company.cost_minor;
  company.margin_pct = company.revenue_minor
    ? round1((company.gross_profit_minor / company.revenue_minor) * 100) : 0;

  return {
    months: byMonth,
    by_client: finish(clientTotals),
    by_project: projects.map((p) => ({ ...p, name: projectNames[p.id] || 'Project' })),
    by_service_line: finish(serviceLineTotals),
    company,
  };
}

// ============================================================== DASHBOARD (H)
export async function overviewDashboard(tenantId, { month = monthIso(), compare = 'mom' } = {}) {
  const prevMonth = compare === 'qoq'
    ? monthIso(addMonths(new Date(`${month}-01T00:00:00Z`), -3))
    : monthIso(addMonths(new Date(`${month}-01T00:00:00Z`), -1));

  return {
    period: { month, compare_to: prevMonth, mode: compare },
    clients: await clientsPillar(tenantId, month, prevMonth),
    revenue: await revenuePillar(tenantId, month, prevMonth),
    hr: await hrPillar(tenantId, month, prevMonth),
    cost: await costPillar(tenantId, month, prevMonth),
    profit: await profitPillar(tenantId, month, prevMonth),
    lagging: await laggingIndicators(tenantId),
    improvement_flags: await all(
      "SELECT * FROM improvement_flags WHERE tenant_id = ? AND status = 'open' ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, detected_at DESC LIMIT 12",
      [tenantId],
    ),
    trend: await trendSeries(tenantId, 6),
  };
}

const delta = (curr, prev) => ({
  value: curr,
  previous: prev,
  change: round1(curr - prev),
  change_pct: prev ? round1(((curr - prev) / Math.abs(prev)) * 100) : (curr ? 100 : 0),
});

async function clientsPillar(tenantId, month, prevMonth) {
  const [, to] = monthRange(month);
  const [, prevTo] = monthRange(prevMonth);

  const activeAt = async (iso) => Number((await get(
    `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
       AND status = 'active' AND created_at <= ? AND (churned_at IS NULL OR churned_at > ?)`,
    [tenantId, iso, iso],
  ))?.n || 0);

  const pipeline = (await all(
    `SELECT s.id, s.name, s.code, s.sort, COUNT(c.id) AS count,
            COALESCE(SUM(c.deal_value_minor),0) AS value_minor
       FROM pipeline_stages s
       LEFT JOIN clients c ON c.stage_id = s.id AND c.deleted_at IS NULL AND c.status IN ('lead','active')
      WHERE s.tenant_id = ? AND s.deleted_at IS NULL
      GROUP BY s.id ORDER BY s.sort`,
    [tenantId],
  )).map((r) => ({ ...r, count: Number(r.count), value_minor: Number(r.value_minor) }));

  const won = Number((await get(
    `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
       AND onboarded_at >= ? AND onboarded_at <= ?`,
    [tenantId, startOfMonth(month), endOfMonth(month)],
  ))?.n || 0);
  const created = Number((await get(
    `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
       AND created_at >= ? AND created_at <= ?`,
    [tenantId, startOfMonth(month), endOfMonth(month)],
  ))?.n || 0);

  const atRisk = await all(
    `SELECT id, name, health_score, retention_score, risk_score, retention_risk
       FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND retention_risk = 1
      ORDER BY retention_score ASC LIMIT 10`,
    [tenantId],
  );

  const noNextAction = Number((await get(
    `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
       AND status IN ('lead','active') AND (next_action IS NULL OR next_action = '' OR next_action_date IS NULL)`,
    [tenantId],
  ))?.n || 0);

  return {
    active: delta(await activeAt(to), await activeAt(prevTo)),
    total_leads: Number((await get("SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'lead'", [tenantId]))?.n || 0),
    new_this_period: created,
    won_this_period: won,
    conversion_ratio: pct(won, created || won),
    pipeline,
    pipeline_value_minor: sum(pipeline, (p) => p.value_minor),
    retention_risk_count: atRisk.length,
    retention_risk: atRisk,
    leads_without_next_action: noNextAction,
    avg_health: round1(Number((await get(
      "SELECT AVG(health_score) AS a FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'",
      [tenantId],
    ))?.a || 0)),
  };
}

async function revenuePillar(tenantId, month, prevMonth) {
  const revFor = async (m) => {
    const [from, to] = monthRange(m);
    return Number((await get(
      `SELECT COALESCE(SUM(taxable_minor),0) AS v FROM invoices
        WHERE tenant_id = ? AND deleted_at IS NULL AND status NOT IN ('draft','written_off')
          AND issue_date >= ? AND issue_date <= ?`,
      [tenantId, from.slice(0, 10), to.slice(0, 10)],
    ))?.v || 0);
  };

  const mrr = Number((await get(
    "SELECT COALESCE(SUM(mrr_minor),0) AS v FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'",
    [tenantId],
  ))?.v || 0);

  const [from, to] = monthRange(month);
  // The join to invoices must not widen the sum: a LEFT JOIN keeps the line item
  // even when its invoice falls outside the period, so the amount is taken only
  // when the invoice actually matched. Service lines with no revenue still list.
  const byServiceLine = (await all(
    `SELECT sl.id, sl.name, sl.color,
            COALESCE(SUM(CASE WHEN i.id IS NOT NULL THEN ii.taxable_minor ELSE 0 END),0) AS value_minor
       FROM service_lines sl
       LEFT JOIN invoice_items ii ON ii.service_line_id = sl.id
       LEFT JOIN invoices i ON i.id = ii.invoice_id AND i.deleted_at IS NULL
            AND i.status NOT IN ('draft','written_off') AND i.issue_date >= ? AND i.issue_date <= ?
      WHERE sl.tenant_id = ? AND sl.deleted_at IS NULL
      GROUP BY sl.id ORDER BY value_minor DESC`,
    [from.slice(0, 10), to.slice(0, 10), tenantId],
  )).map((r) => ({ ...r, value_minor: Number(r.value_minor) }));

  const byModel = (await all(
    `SELECT c.engagement_model AS model, COALESCE(SUM(i.taxable_minor),0) AS value_minor, COUNT(DISTINCT c.id) AS clients
       FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.status NOT IN ('draft','written_off')
        AND i.issue_date >= ? AND i.issue_date <= ?
      GROUP BY c.engagement_model`,
    [tenantId, from.slice(0, 10), to.slice(0, 10)],
  )).map((r) => ({ ...r, value_minor: Number(r.value_minor), clients: Number(r.clients) }));

  const outstanding = await get(
    `SELECT COALESCE(SUM(balance_minor),0) AS total,
            COALESCE(SUM(CASE WHEN due_date < ? THEN balance_minor ELSE 0 END),0) AS overdue,
            COUNT(CASE WHEN due_date < ? AND balance_minor > 0 THEN 1 END) AS overdue_count
       FROM invoices WHERE tenant_id = ? AND deleted_at IS NULL
         AND status NOT IN ('draft','paid','written_off')`,
    [todayIso(), todayIso(), tenantId],
  ) || {};

  return {
    revenue: delta(await revFor(month), await revFor(prevMonth)),
    mrr_minor: mrr,
    arr_minor: mrr * 12,
    collected_minor: Number((await get(
      `SELECT COALESCE(SUM(amount_minor),0) AS v FROM payments
        WHERE tenant_id = ? AND deleted_at IS NULL AND paid_at >= ? AND paid_at <= ?`,
      [tenantId, from, to],
    ))?.v || 0),
    outstanding_minor: Number(outstanding.total || 0),
    overdue_minor: Number(outstanding.overdue || 0),
    overdue_count: Number(outstanding.overdue_count || 0),
    by_service_line: byServiceLine,
    by_model: byModel,
  };
}

async function hrPillar(tenantId, month, prevMonth) {
  const headcount = Number((await get(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'",
    [tenantId],
  ))?.n || 0);

  const [from, to] = monthRange(month);
  const attendance = await get(
    `SELECT COUNT(*) AS records,
            COUNT(CASE WHEN status IN ('present','wfh') THEN 1 END) AS present,
            COALESCE(AVG(work_minutes),0) AS avg_minutes
       FROM attendance WHERE tenant_id = ? AND work_date >= ? AND work_date <= ?`,
    [tenantId, from.slice(0, 10), to.slice(0, 10)],
  ) || {};

  const openRoles = Number((await get(
    "SELECT COALESCE(SUM(headcount - filled),0) AS n FROM job_openings WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'open'",
    [tenantId],
  ))?.n || 0);

  const completion = await get(
    `SELECT COUNT(*) AS assigned, COUNT(CASE WHEN status = 'done' THEN 1 END) AS done
       FROM action_items WHERE tenant_id = ? AND deleted_at IS NULL
         AND due_date >= ? AND due_date <= ?`,
    [tenantId, from.slice(0, 10), to.slice(0, 10)],
  ) || {};

  const prevCompletion = (async () => {
    const [pf, pt] = monthRange(prevMonth);
    const r = await get(
      `SELECT COUNT(*) AS assigned, COUNT(CASE WHEN status = 'done' THEN 1 END) AS done
         FROM action_items WHERE tenant_id = ? AND deleted_at IS NULL AND due_date >= ? AND due_date <= ?`,
      [tenantId, pf.slice(0, 10), pt.slice(0, 10)],
    ) || {};
    return pct(Number(r.done || 0), Number(r.assigned || 0));
  })();

  // Utilisation: billable action-item minutes against a 8h x 22d capacity.
  const capacityMinutes = headcount * 22 * 480;
  const loggedMinutes = Number((await get(
    `SELECT COALESCE(SUM(estimate_minutes),0) AS m FROM action_items
      WHERE tenant_id = ? AND deleted_at IS NULL AND client_id IS NOT NULL
        AND due_date >= ? AND due_date <= ?`,
    [tenantId, from.slice(0, 10), to.slice(0, 10)],
  ))?.m || 0);

  const pendingLeave = Number((await get(
    "SELECT COUNT(*) AS n FROM leave_requests WHERE tenant_id = ? AND status = 'pending'",
    [tenantId],
  ))?.n || 0);

  return {
    headcount,
    open_roles: openRoles,
    candidates_in_pipeline: Number((await get(
      "SELECT COUNT(*) AS n FROM candidates WHERE tenant_id = ? AND deleted_at IS NULL AND stage NOT IN ('hired','rejected')",
      [tenantId],
    ))?.n || 0),
    attendance_pct: pct(Number(attendance.present || 0), Number(attendance.records || 0)),
    avg_work_hours: round1(Number(attendance.avg_minutes || 0) / 60),
    utilization_pct: capacityMinutes ? pct(loggedMinutes, capacityMinutes) : 0,
    completion: delta(pct(Number(completion.done || 0), Number(completion.assigned || 0)), prevCompletion),
    pending_leave_requests: pendingLeave,
  };
}

async function costPillar(tenantId, month, prevMonth) {
  const totalFor = async (m) => Number((await get(
    'SELECT COALESCE(SUM(amount_minor),0) AS v FROM costs WHERE tenant_id = ? AND deleted_at IS NULL AND period_month = ?',
    [tenantId, m],
  ))?.v || 0);

  const breakdown = (await all(
    `SELECT category, COALESCE(SUM(amount_minor),0) AS amount_minor FROM costs
      WHERE tenant_id = ? AND deleted_at IS NULL AND period_month = ?
      GROUP BY category ORDER BY amount_minor DESC`,
    [tenantId, month],
  )).map((r) => ({ ...r, amount_minor: Number(r.amount_minor) }));

  return {
    total: delta(await totalFor(month), await totalFor(prevMonth)),
    breakdown,
    hr_cost_minor: Number(breakdown.find((b) => b.category === 'hr')?.amount_minor || 0),
    tools_cost_minor: Number(breakdown.find((b) => b.category === 'tools')?.amount_minor || 0),
  };
}

async function profitPillar(tenantId, month, prevMonth) {
  const calc = async (m) => {
    const [from, to] = monthRange(m);
    const revenue = Number((await get(
      `SELECT COALESCE(SUM(taxable_minor),0) AS v FROM invoices
        WHERE tenant_id = ? AND deleted_at IS NULL AND status NOT IN ('draft','written_off')
          AND issue_date >= ? AND issue_date <= ?`,
      [tenantId, from.slice(0, 10), to.slice(0, 10)],
    ))?.v || 0);
    const cost = Number((await get(
      'SELECT COALESCE(SUM(amount_minor),0) AS v FROM costs WHERE tenant_id = ? AND deleted_at IS NULL AND period_month = ?',
      [tenantId, m],
    ))?.v || 0);
    return { revenue, cost, profit: revenue - cost, margin: revenue ? round1(((revenue - cost) / revenue) * 100) : 0 };
  };
  const curr = await calc(month);
  const prev = await calc(prevMonth);
  return {
    gross_profit: delta(curr.profit, prev.profit),
    margin_pct: delta(curr.margin, prev.margin),
    revenue_minor: curr.revenue,
    cost_minor: curr.cost,
  };
}

/** H2 - lagging indicators. */
export async function laggingIndicators(tenantId) {
  const today = todayIso();
  const overdueItems = Number((await get(
    `SELECT COUNT(*) AS n FROM action_items WHERE tenant_id = ? AND deleted_at IS NULL
       AND status NOT IN ('done','cancelled') AND due_date < ?`,
    [tenantId, today],
  ))?.n || 0);

  const openEscalations = Number((await get(
    'SELECT COUNT(*) AS n FROM escalations WHERE tenant_id = ? AND resolved_at IS NULL',
    [tenantId],
  ))?.n || 0);

  const breached = Number((await get(
    "SELECT COUNT(*) AS n FROM deadlines WHERE tenant_id = ? AND status = 'breached'",
    [tenantId],
  ))?.n || 0);

  // SLA: escalations closed within their sla_hours window.
  const resolved = await all(
    'SELECT created_at, resolved_at, sla_hours FROM escalations WHERE tenant_id = ? AND resolved_at IS NOT NULL',
    [tenantId],
  );
  const withinSla = resolved.filter(
    (e) => (new Date(e.resolved_at) - new Date(e.created_at)) / 3.6e6 <= (e.sla_hours || 24),
  ).length;

  return {
    overdue_action_items: overdueItems,
    open_escalations: openEscalations,
    sla_breaches: breached,
    // A percentage of nothing is not zero - it is unknown. Returning 0 here made
    // a workspace with no closed escalations look like a total SLA failure.
    escalation_sla_pct: resolved.length ? pct(withinSla, resolved.length) : null,
    escalations_resolved: resolved.length,
    overdue_invoices: Number((await get(
      `SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND deleted_at IS NULL
         AND balance_minor > 0 AND due_date < ? AND status NOT IN ('draft','written_off')`,
      [tenantId, today],
    ))?.n || 0),
    stale_leads: Number((await get(
      `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
         AND status = 'lead' AND (next_action_date IS NULL OR next_action_date < ?)`,
      [tenantId, today],
    ))?.n || 0),
    leads_without_next_action: Number((await get(
      `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
         AND status IN ('lead','active') AND (next_action IS NULL OR next_action = '' OR next_action_date IS NULL)`,
      [tenantId],
    ))?.n || 0),
  };
}

/** 6-month series backing the dashboard sparklines. */
export async function trendSeries(tenantId, months = 6) {
  return await Promise.all(monthsBack(months).map(async (month) => {
    const [from, to] = monthRange(month);
    const revenue = Number((await get(
      `SELECT COALESCE(SUM(taxable_minor),0) AS v FROM invoices WHERE tenant_id = ? AND deleted_at IS NULL
         AND status NOT IN ('draft','written_off') AND issue_date >= ? AND issue_date <= ?`,
      [tenantId, from.slice(0, 10), to.slice(0, 10)],
    ))?.v || 0);
    const cost = Number((await get(
      'SELECT COALESCE(SUM(amount_minor),0) AS v FROM costs WHERE tenant_id = ? AND deleted_at IS NULL AND period_month = ?',
      [tenantId, month],
    ))?.v || 0);
    const items = await get(
      `SELECT COUNT(*) AS assigned, COUNT(CASE WHEN status='done' THEN 1 END) AS done
         FROM action_items WHERE tenant_id = ? AND deleted_at IS NULL AND due_date >= ? AND due_date <= ?`,
      [tenantId, from.slice(0, 10), to.slice(0, 10)],
    ) || {};
    return {
      month,
      revenue_minor: revenue,
      cost_minor: cost,
      profit_minor: revenue - cost,
      margin_pct: revenue ? round1(((revenue - cost) / revenue) * 100) : 0,
      completion_pct: pct(Number(items.done || 0), Number(items.assigned || 0)),
      new_clients: Number((await get(
        'SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND created_at >= ? AND created_at <= ?',
        [tenantId, from, to],
      ))?.n || 0),
    };
  }));
}

// ==================================================== H3 IMPROVEMENT FLAGS
/**
 * Auto-surfaces weak points with a drill-down path. Re-run daily; an existing
 * open flag of the same key+entity is refreshed rather than duplicated.
 */
export async function detectImprovementFlags(tenantId) {
  const found = [];
  const push = (f) => found.push(f);

  // 1. Service line with the lowest retention among its clients.
  const slRetention = (await all(
    `SELECT sl.id, sl.name, AVG(c.retention_score) AS avg_retention, COUNT(c.id) AS n
       FROM service_lines sl
       JOIN clients c ON c.service_lines LIKE '%' || sl.id || '%'
            AND c.deleted_at IS NULL AND c.status = 'active'
      WHERE sl.tenant_id = ? AND sl.deleted_at IS NULL
      GROUP BY sl.id HAVING COUNT(c.id) >= 2 ORDER BY avg_retention ASC LIMIT 1`,
    [tenantId],
  ))[0];
  if (slRetention && Number(slRetention.avg_retention) < 60) {
    push({
      flag_key: 'service_line.low_retention',
      severity: Number(slRetention.avg_retention) < 45 ? 'high' : 'medium',
      title: `${slRetention.name} has the weakest retention`,
      detail: `Average retention score ${round1(slRetention.avg_retention)} across ${slRetention.n} active clients.`,
      entity: 'service_line',
      entity_id: slRetention.id,
      metric_value: round1(slRetention.avg_retention),
      drill_path: `/dashboard/service-lines/${slRetention.id}`,
    });
  }

  // 2. Clients whose risk score is climbing.
  const risingRisk = (await all(
    `SELECT c.id, c.name, c.risk_score,
            (SELECT h.risk FROM client_score_history h
              WHERE h.client_id = c.id AND h.snapshot_date <= ?
              ORDER BY h.snapshot_date DESC LIMIT 1) AS prev_risk
       FROM clients c
      WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.status = 'active' AND c.risk_score > 50`,
    [todayIso(addDays(new Date(), -14)), tenantId],
  )).filter((c) => c.prev_risk != null && c.risk_score - c.prev_risk >= 10);
  for (const c of risingRisk.slice(0, 5)) {
    push({
      flag_key: 'client.rising_risk',
      severity: c.risk_score > 70 ? 'high' : 'medium',
      title: `${c.name}: risk score rising`,
      detail: `Risk moved from ${round1(c.prev_risk)} to ${round1(c.risk_score)} in the last 14 days.`,
      entity: 'client',
      entity_id: c.id,
      metric_value: round1(c.risk_score),
      drill_path: `/crm/${c.id}`,
    });
  }

  // 3. Employees whose completion rate is falling.
  const thisMonth = monthIso();
  const lastMonth = monthIso(addMonths(new Date(), -1));
  const staff = await all(
    "SELECT id, name FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role IN ('employee','manager')",
    [tenantId],
  );
  for (const u of staff) {
    const rate = async (m) => {
      const [f, t] = monthRange(m);
      const r = await get(
        `SELECT COUNT(*) AS assigned, COUNT(CASE WHEN status='done' THEN 1 END) AS done
           FROM action_items WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL
             AND due_date >= ? AND due_date <= ?`,
        [tenantId, u.id, f.slice(0, 10), t.slice(0, 10)],
      ) || {};
      return { pct: pct(Number(r.done || 0), Number(r.assigned || 0)), n: Number(r.assigned || 0) };
    };
    const curr = await rate(thisMonth);
    const prev = await rate(lastMonth);
    if (prev.n >= 3 && curr.n >= 3 && prev.pct - curr.pct >= 20) {
      push({
        flag_key: 'employee.falling_completion',
        severity: curr.pct < 50 ? 'high' : 'medium',
        title: `${u.name}: completion rate down`,
        detail: `Completion fell from ${prev.pct}% to ${curr.pct}% month over month.`,
        entity: 'user',
        entity_id: u.id,
        metric_value: curr.pct,
        drill_path: `/hr/performance?user=${u.id}`,
      });
    }
  }

  // 4. Leads sitting without a next action (E4).
  const noNext = Number((await get(
    `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL
       AND status IN ('lead','active') AND (next_action IS NULL OR next_action = '')`,
    [tenantId],
  ))?.n || 0);
  if (noNext > 0) {
    push({
      flag_key: 'crm.leads_without_next_action',
      severity: noNext > 5 ? 'high' : 'medium',
      title: `${noNext} lead(s) have no next action`,
      detail: 'Every lead must always carry a next action and date.',
      entity: 'crm',
      entity_id: null,
      metric_value: noNext,
      drill_path: '/crm?filter=no_next_action',
    });
  }

  // 5. Margin slipping below target.
  const p = await profitability(tenantId, { months: 2 });
  const [prevM, currM] = p.months;
  if (currM && prevM && currM.margin_pct < 30 && currM.margin_pct < prevM.margin_pct - 5) {
    push({
      flag_key: 'finance.margin_drop',
      severity: currM.margin_pct < 15 ? 'high' : 'medium',
      title: `Gross margin down to ${currM.margin_pct}%`,
      detail: `Margin fell from ${prevM.margin_pct}% in ${prevM.month} to ${currM.margin_pct}% in ${currM.month}.`,
      entity: 'finance',
      entity_id: null,
      metric_value: currM.margin_pct,
      drill_path: '/finance/profitability',
    });
  }

  // 6. SOP adherence below 80%.
  const adherence = await get(
    'SELECT AVG(adherence_pct) AS a, COUNT(*) AS n FROM sop_runs WHERE tenant_id = ? AND started_at >= ?',
    [tenantId, todayIso(addDays(new Date(), -30))],
  );
  if (adherence && Number(adherence.n) >= 3 && Number(adherence.a) < 80) {
    push({
      flag_key: 'sop.low_adherence',
      severity: Number(adherence.a) < 60 ? 'high' : 'medium',
      title: `SOP adherence at ${round1(adherence.a)}%`,
      detail: `Across ${adherence.n} SOP runs in the last 30 days.`,
      entity: 'sop',
      entity_id: null,
      metric_value: round1(adherence.a),
      drill_path: '/sop?tab=adherence',
    });
  }

  // Persist: refresh matching open flags, insert the rest, close what healed.
  const seen = new Set();
  for (const f of found) {
    const key = `${f.flag_key}:${f.entity_id || ''}`;
    seen.add(key);
    const existing = await get(
      `SELECT id FROM improvement_flags WHERE tenant_id = ? AND flag_key = ?
         AND COALESCE(entity_id,'') = ? AND status = 'open'`,
      [tenantId, f.flag_key, f.entity_id || ''],
    );
    if (existing) {
      await run(
        'UPDATE improvement_flags SET title = ?, detail = ?, severity = ?, metric_value = ?, detected_at = ? WHERE id = ?',
        [f.title, f.detail, f.severity, f.metric_value, nowIso(), existing.id],
      );
    } else {
      await run(
        `INSERT INTO improvement_flags (id, tenant_id, flag_key, severity, title, detail, entity, entity_id,
           metric_value, drill_path, status, detected_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'open',?,?)`,
        [uuid(), tenantId, f.flag_key, f.severity, f.title, f.detail, f.entity, f.entity_id,
          f.metric_value, f.drill_path, nowIso(), nowIso()],
      );
    }
  }
  for (const openFlag of await all("SELECT * FROM improvement_flags WHERE tenant_id = ? AND status = 'open'", [tenantId])) {
    if (!seen.has(`${openFlag.flag_key}:${openFlag.entity_id || ''}`)) {
      await run("UPDATE improvement_flags SET status = 'resolved', resolved_at = ? WHERE id = ?", [nowIso(), openFlag.id]);
    }
  }
  return found.length;
}

/** Persists today's headline numbers so trends survive record mutation. */
export async function snapshotMetrics(tenantId) {
  const month = monthIso();
  const d = await overviewDashboard(tenantId, { month });
  const metrics = {
    active_clients: d.clients.active.value,
    pipeline_value: d.clients.pipeline_value_minor,
    mrr: d.revenue.mrr_minor,
    revenue: d.revenue.revenue.value,
    cost: d.cost.total.value,
    gross_profit: d.profit.gross_profit.value,
    headcount: d.hr.headcount,
    completion_pct: d.hr.completion.value,
    overdue_items: d.lagging.overdue_action_items,
    open_escalations: d.lagging.open_escalations,
  };
  for (const [key, value] of Object.entries(metrics)) {
    await run(
      `INSERT INTO metric_snapshots (id, tenant_id, snapshot_date, metric_key, value_num, dims, created_at)
       VALUES (?,?,?,?,?,'{}',?)
       ON CONFLICT (tenant_id, snapshot_date, metric_key, dims) DO UPDATE SET value_num = excluded.value_num`,
      [uuid(), tenantId, todayIso(), key, Number(value) || 0, nowIso()],
    );
  }
  return Object.keys(metrics).length;
}
