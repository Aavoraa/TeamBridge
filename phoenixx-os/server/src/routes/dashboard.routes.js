import { Router } from 'express';
import { z } from 'zod';
import { get, all, run } from '../db/index.js';
import { nowIso, monthIso, monthsBack, todayIso, addMonths, startOfMonth, endOfMonth, pct } from '../lib/util.js';
import { ok, validate, notFound, audit } from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import { DEFAULT_TZ, todayInTz } from '../lib/dueTime.js';
import { PENDING, dayKind, decorate, scheduleFor, workDayFor } from '../services/attendance.js';
import { totalUnread } from '../services/chat.js';
import {
  overviewDashboard, laggingIndicators, trendSeries, detectImprovementFlags, snapshotMetrics,
} from '../services/analytics.js';

const router = Router();

/**
 * Due and overdue are asked of the stored instant, never of the date string.
 * A task due at 4pm today is still "due today" at 3pm and overdue at 4:01pm,
 * and one carrying no time keeps its old meaning because it is stored as the
 * end of its own day. `DUE_TODAY` takes (date, now); `IS_OVERDUE` takes (now).
 */
const DUE_TODAY = '(a.due_date = ? AND (a.due_at IS NULL OR a.due_at >= ?))';
const IS_OVERDUE = '(a.due_at IS NOT NULL AND a.due_at < ?)';

/**
 * Which day "due today" means. A due date is a day on the workspace calendar,
 * so the question has to be asked on the workspace clock - on UTC it would be
 * the wrong day for the first five and a half hours of every Indian morning.
 * Attendance and daily updates keep their own UTC day; those are stored that
 * way and reading them differently from how they are written would be worse.
 */
const dueDayOf = (req) => todayInTz(req.tenant?.timezone || DEFAULT_TZ);


/** H1 - the Overview Traction Dashboard: clients, revenue, HR, cost, profit. */
router.get('/overview', requires('dashboard', 'view'), async (req, res) => {
  const month = req.query.month || monthIso();
  const compare = req.query.compare === 'qoq' ? 'qoq' : 'mom';
  return ok(res, await overviewDashboard(req.auth.tenantId, { month, compare }));
});

/** H5 - condensed card set for the mobile dashboard. */
router.get('/mobile', requires('dashboard', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const d = await overviewDashboard(tenantId, { month: monthIso() });
  const today = todayIso();
  const dueToday = dueDayOf(req);
  const now = nowIso();

  return ok(res, {
    pillars: [
      { key: 'clients', label: 'Clients', value: d.clients.active.value, change: d.clients.active.change, sub: `${d.clients.total_leads} leads` },
      { key: 'revenue', label: 'Revenue', value_minor: d.revenue.revenue.value, change_pct: d.revenue.revenue.change_pct, sub: `MRR ${d.revenue.mrr_minor / 100}` },
      { key: 'hr', label: 'Team', value: d.hr.headcount, sub: `${d.hr.attendance_pct}% attendance` },
      { key: 'cost', label: 'Cost', value_minor: d.cost.total.value, change_pct: d.cost.total.change_pct },
      { key: 'profit', label: 'Profit', value_minor: d.profit.gross_profit.value, sub: `${d.profit.margin_pct.value}% margin` },
    ],
    lagging: d.lagging,
    my_work: {
      due_today: Number((await get(
        `SELECT COUNT(*) AS n FROM action_items a WHERE a.tenant_id = ? AND a.owner_id = ? AND a.deleted_at IS NULL
           AND a.status NOT IN ('done','cancelled') AND ${DUE_TODAY}`, [tenantId, userId, dueToday, now],
      ))?.n || 0),
      overdue: Number((await get(
        `SELECT COUNT(*) AS n FROM action_items a WHERE a.tenant_id = ? AND a.owner_id = ? AND a.deleted_at IS NULL
           AND a.status NOT IN ('done','cancelled') AND ${IS_OVERDUE}`, [tenantId, userId, now],
      ))?.n || 0),
      unread_notifications: Number((await get(
        "SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND user_id = ? AND channel = 'in_app' AND read_at IS NULL",
        [tenantId, userId],
      ))?.n || 0),
      checked_in: !!(await get('SELECT check_in_at FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
        [tenantId, userId, today]))?.check_in_at,
    },
    improvement_flags: d.improvement_flags.slice(0, 5),
  });
});

/** H2 */
router.get('/lagging', requires('dashboard', 'view'), async (req, res) =>
  ok(res, await laggingIndicators(req.auth.tenantId)));

/** H4 - MoM / QoQ comparison series. */
router.get('/trend', requires('dashboard', 'view'), async (req, res) => {
  const months = Math.min(24, Math.max(2, Number(req.query.months) || 6));
  return ok(res, await trendSeries(req.auth.tenantId, months));
});

// ------------------------------------------------------- H3 improvement flags
router.get('/improvement-flags', requires('dashboard', 'view'), async (req, res) => {
  const status = req.query.status || 'open';
  return ok(res, await all(
    `SELECT * FROM improvement_flags WHERE tenant_id = ? AND status = ?
      ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, detected_at DESC`,
    [req.auth.tenantId, status],
  ));
});

router.post('/improvement-flags/refresh', requires('dashboard', 'view'), async (req, res) => {
  const found = await detectImprovementFlags(req.auth.tenantId);
  await snapshotMetrics(req.auth.tenantId);
  return ok(res, { detected: found });
});

router.post('/improvement-flags/:id/acknowledge', requires('dashboard', 'view'), async (req, res) => {
  const flag = await get('SELECT * FROM improvement_flags WHERE id = ? AND tenant_id = ?',
    [req.params.id, req.auth.tenantId]);
  if (!flag) throw notFound('Improvement flag');

  const { status } = validate(z.object({ status: z.enum(['acknowledged', 'resolved']).optional() }), req.body || {});
  const next = status || 'acknowledged';
  await run('UPDATE improvement_flags SET status = ?, acknowledged_by = ?, resolved_at = ? WHERE id = ?',
    [next, req.auth.userId, next === 'resolved' ? nowIso() : null, flag.id]);

  await audit(req, { entity: 'improvement_flag', entityId: flag.id, action: 'update', after: { status: next } });
  return ok(res, await get('SELECT * FROM improvement_flags WHERE id = ?', [flag.id]));
});

// ------------------------------------------------------------ H4 drill-downs
/**
 * Every dashboard widget drills through to the records behind it. This one
 * endpoint resolves a widget key to its underlying rows.
 */
const DRILLDOWNS = {
  active_clients: async (t) => await all(
    `SELECT id, name, industry, engagement_model, mrr_minor, health_score, retention_score, owner_id
       FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY mrr_minor DESC`,
    [t],
  ),
  retention_risk: async (t) => await all(
    `SELECT c.id, c.name, c.health_score, c.risk_score, c.retention_score, rc.label AS reason
       FROM clients c LEFT JOIN reason_codes rc ON rc.id = c.retention_reason_code_id
      WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.retention_risk = 1
      ORDER BY c.retention_score`,
    [t],
  ),
  overdue_items: async (t) => await all(
    `SELECT a.id, a.title, a.due_date, a.due_time, a.due_at, a.priority, a.status,
            u.name AS owner_name, c.name AS client_name
       FROM action_items a LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.tenant_id = ? AND a.deleted_at IS NULL AND a.status NOT IN ('done','cancelled')
        AND ${IS_OVERDUE} ORDER BY a.due_at`,
    [t, nowIso()],
  ),
  open_escalations: async (t) => await all(
    `SELECT e.*, uf.name AS from_name, ut.name AS to_name FROM escalations e
       LEFT JOIN users uf ON uf.id = e.from_user_id LEFT JOIN users ut ON ut.id = e.to_user_id
      WHERE e.tenant_id = ? AND e.resolved_at IS NULL ORDER BY e.created_at DESC`,
    [t],
  ),
  overdue_invoices: async (t) => await all(
    `SELECT i.id, i.number, i.due_date, i.total_minor, i.balance_minor, c.name AS client_name
       FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.balance_minor > 0 AND i.due_date < ?
        AND i.status NOT IN ('draft','written_off') ORDER BY i.due_date`,
    [t, todayIso()],
  ),
  leads_without_next_action: async (t) => await all(
    `SELECT c.id, c.name, c.status, c.created_at, u.name AS owner_name FROM clients c
       LEFT JOIN users u ON u.id = c.owner_id
      WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.status IN ('lead','active')
        AND (c.next_action IS NULL OR c.next_action = '' OR c.next_action_date IS NULL)`,
    [t],
  ),
  revenue: async (t, month) => await all(
    `SELECT i.id, i.number, i.issue_date, i.taxable_minor, i.total_minor, i.status, c.name AS client_name
       FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.status NOT IN ('draft','written_off')
        AND i.issue_date >= ? AND i.issue_date <= ? ORDER BY i.taxable_minor DESC`,
    [t, startOfMonth(month).slice(0, 10), endOfMonth(month).slice(0, 10)],
  ),
  costs: async (t, month) => await all(
    `SELECT co.*, c.name AS client_name FROM costs co LEFT JOIN clients c ON c.id = co.client_id
      WHERE co.tenant_id = ? AND co.deleted_at IS NULL AND co.period_month = ?
      ORDER BY co.amount_minor DESC`,
    [t, month],
  ),
  headcount: async (t) => await all(
    `SELECT u.id, u.name, u.role, u.designation, u.date_of_joining, sl.name AS service_line_name
       FROM users u LEFT JOIN service_lines sl ON sl.id = u.service_line_id
      WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status = 'active' AND u.role != 'client'
      ORDER BY u.name`,
    [t],
  ),
  open_roles: async (t) => await all(
    `SELECT j.*, u.name AS hiring_manager_name FROM job_openings j
       LEFT JOIN users u ON u.id = j.hiring_manager_id
      WHERE j.tenant_id = ? AND j.deleted_at IS NULL AND j.status = 'open'`,
    [t],
  ),
};

router.get('/drilldown/:key', requires('dashboard', 'view'), async (req, res) => {
  const fn = DRILLDOWNS[req.params.key];
  if (!fn) throw notFound(`Drill-down "${req.params.key}"`);
  const month = req.query.month || monthIso();
  return ok(res, await fn(req.auth.tenantId, month), { key: req.params.key, month });
});

// -------------------------------------------------------- personal home page
/** On this person's plate: accountable for it, or working it with someone else. */
const ASSIGNED = `(a.owner_id = ? OR EXISTS (
  SELECT 1 FROM action_assignees aa WHERE aa.action_item_id = a.id AND aa.user_id = ?))`;

/** The landing view: what this specific person has to do today. */
router.get('/home', async (req, res) => {
  const { tenantId, userId } = req.auth;
  const today = todayIso();
  const dueToday = dueDayOf(req);
  const now = nowIso();
  const attendanceDay = await workDayFor(tenantId);
  const attendanceKind = await dayKind(tenantId, attendanceDay);

  return ok(res, {
    greeting_name: req.auth.name.split(' ')[0],
    // Today's attendance, and everything My Day needs to talk about it: the
    // hours this person is expected to work, and whether today is a day
    // anybody is expected at all.
    attendance: await decorate(tenantId, await get(
      'SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
      [tenantId, userId, attendanceDay],
    )) || null,
    attendance_day: {
      work_date: attendanceDay,
      kind: attendanceKind.kind,
      holiday: attendanceKind.holiday,
      schedule: await scheduleFor(tenantId, userId),
    },
    counters: {
      due_today: Number((await get(
        `SELECT COUNT(*) AS n FROM action_items a WHERE a.tenant_id = ? AND ${ASSIGNED} AND a.deleted_at IS NULL
           AND a.status NOT IN ('done','cancelled') AND ${DUE_TODAY}`, [tenantId, userId, userId, dueToday, now],
      ))?.n || 0),
      overdue: Number((await get(
        `SELECT COUNT(*) AS n FROM action_items a WHERE a.tenant_id = ? AND ${ASSIGNED} AND a.deleted_at IS NULL
           AND a.status NOT IN ('done','cancelled') AND ${IS_OVERDUE}`, [tenantId, userId, userId, now],
      ))?.n || 0),
      in_progress: Number((await get(
        `SELECT COUNT(*) AS n FROM action_items a WHERE a.tenant_id = ? AND ${ASSIGNED} AND a.deleted_at IS NULL
           AND a.status = 'in_progress'`, [tenantId, userId, userId],
      ))?.n || 0),
      follow_ups: Number((await get(
        `SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL
           AND next_action_date <= ? AND status IN ('lead','active')`, [tenantId, userId, today],
      ))?.n || 0),
      escalations: Number((await get(
        'SELECT COUNT(*) AS n FROM escalations WHERE tenant_id = ? AND to_user_id = ? AND resolved_at IS NULL',
        [tenantId, userId],
      ))?.n || 0),
      unread: Number((await get(
        "SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND user_id = ? AND channel = 'in_app' AND read_at IS NULL",
        [tenantId, userId],
      ))?.n || 0),
      chat: await totalUnread(tenantId, userId),
      // Open work assigned to this person with nothing written about it today.
      needs_update: Number((await get(
        `SELECT COUNT(*) AS n FROM action_items a
          WHERE a.tenant_id = ? AND a.deleted_at IS NULL AND a.status NOT IN ('done','cancelled')
            AND (a.owner_id = ? OR EXISTS (SELECT 1 FROM action_assignees aa
                   WHERE aa.action_item_id = a.id AND aa.user_id = ?))
            AND NOT EXISTS (SELECT 1 FROM action_updates au WHERE au.action_item_id = a.id
                   AND au.user_id = ? AND au.update_date = ? AND au.deleted_at IS NULL)`,
        [tenantId, userId, userId, userId, today],
      ))?.n || 0),
    },
    /**
     * What is on this person today. Includes work assigned to them alongside
     * somebody else, and says which rows still owe a daily update, so My Day
     * answers "what do I owe" and not only "what is due".
     */
    today_items: (await all(
      `SELECT a.*, c.name AS client_name, ac.name AS category_name, ac.color AS category_color,
              u.name AS owner_name, cb.name AS created_by_name,
              (a.owner_id = ?) AS accountable,
              EXISTS (SELECT 1 FROM action_updates au WHERE au.action_item_id = a.id
                        AND au.user_id = ? AND au.update_date = ? AND au.deleted_at IS NULL) AS has_update_today
         FROM action_items a
         LEFT JOIN clients c ON c.id = a.client_id
         LEFT JOIN users u ON u.id = a.owner_id
         LEFT JOIN users cb ON cb.id = a.created_by
         LEFT JOIN action_categories ac ON ac.id = a.category_id
        WHERE a.tenant_id = ? AND a.deleted_at IS NULL
          AND (a.owner_id = ? OR EXISTS (SELECT 1 FROM action_assignees aa
                 WHERE aa.action_item_id = a.id AND aa.user_id = ?))
          AND a.status NOT IN ('done','cancelled') AND (a.due_date <= ? OR a.status = 'in_progress')
        ORDER BY a.due_at IS NULL, a.due_at LIMIT 12`,
      [userId, userId, today, tenantId, userId, userId, dueToday],
    // SQLite hands back 0/1 for a boolean expression; the rest of the API
    // speaks true/false, and a client should not have to know the difference.
    )).map((r) => ({ ...r, accountable: !!r.accountable, has_update_today: !!r.has_update_today })),
    follow_ups: await all(
      `SELECT id, name, next_action, next_action_date, health_score FROM clients
        WHERE tenant_id = ? AND owner_id = ? AND deleted_at IS NULL AND next_action_date <= ?
          AND status IN ('lead','active') ORDER BY next_action_date LIMIT 10`,
      [tenantId, userId, today],
    ),
    meetings: await all(
      `SELECT DISTINCT m.id, m.title, m.scheduled_at, m.duration_minutes, m.location, c.name AS client_name
         FROM meetings m
         LEFT JOIN meeting_attendees ma ON ma.meeting_id = m.id
         LEFT JOIN clients c ON c.id = m.client_id
        WHERE m.tenant_id = ? AND m.deleted_at IS NULL AND m.status = 'scheduled'
          AND date(m.scheduled_at) = ? AND (m.organizer_id = ? OR ma.user_id = ?)
        ORDER BY m.scheduled_at`,
      [tenantId, today, userId, userId],
    ),
    pending_approvals: {
      leave: Number((await get(
        // Step one sits with the reporting manager; step two, once they have
        // verified it, with HR.
        `SELECT COUNT(*) AS n FROM leave_requests WHERE tenant_id = ? AND status = 'pending' AND user_id != ?
           AND ((COALESCE(stage, 'hr') = 'manager' AND manager_id = ?)
             OR (COALESCE(stage, 'hr') = 'hr' AND (approver_id = ? OR ? = 1)))`,
        [tenantId, userId, userId, userId, ['hr', 'owner', 'super_admin'].includes(req.auth.role) ? 1 : 0],
      ))?.n || 0),
      regularizations: Number((await get(
        `SELECT COUNT(*) AS n FROM attendance_regularizations WHERE tenant_id = ? AND status = 'pending' AND approver_id = ?`,
        [tenantId, userId],
      ))?.n || 0),
      // Late arrivals waiting on a ruling. Workspace-wide rather than assigned
      // to one approver: the queue belongs to whoever holds the right, and a
      // day sitting in it unanswered is the thing that must not go unnoticed.
      late_check_ins: await can(req.auth, 'hr_attendance', 'approve')
        ? Number((await get(
          'SELECT COUNT(*) AS n FROM attendance WHERE tenant_id = ? AND status = ?',
          [tenantId, PENDING],
        ))?.n || 0)
        : 0,
      invoices: Number((await get(
        "SELECT COUNT(*) AS n FROM invoices WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'draft' AND approved_at IS NULL",
        [tenantId],
      ))?.n || 0),
    },
    recent_notifications: await all(
      `SELECT id, title, body, link, created_at, read_at FROM notifications
        WHERE tenant_id = ? AND user_id = ? AND channel = 'in_app'
        ORDER BY created_at DESC LIMIT 8`,
      [tenantId, userId],
    ),
  });
});

// ------------------------------------------------------- overview analytics
/**
 * The Dashboard's "Overview Analytics", chart and sales funnel. Each block is
 * only computed for people who may see what it is built from (invoices for
 * revenue, proposals for conversion, the CRM for leads and the funnel); the
 * rest come back null and the page leaves them out.
 *
 * Figures compare the last 30 days with the 30 before. Money is in the
 * workspace currency, in minor units, converted at each invoice's rate.
 */
const RANGES = {
  '1M': { buckets: 30, unit: 'day' },
  '3M': { buckets: 13, unit: 'week' },
  '6M': { buckets: 6, unit: 'month' },
  '1Y': { buckets: 12, unit: 'month' },
};
const DAY = 86_400_000;

function bucketStarts(range, now = new Date()) {
  const { buckets, unit } = RANGES[range];
  const starts = [];
  if (unit === 'month') {
    const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    for (let i = buckets * 2 - 1; i >= 0; i--) starts.push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() - i, 1)));
    starts.push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 1)));
  } else {
    const step = unit === 'week' ? 7 * DAY : DAY;
    const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) + DAY;
    for (let i = buckets * 2; i >= 0; i--) starts.push(new Date(end - i * step));
  }
  return starts; // 2N+1 edges: N previous-period buckets, then N current
}

router.get('/overview-analytics', async (req, res) => {
  const { tenantId } = req.auth;
  const range = RANGES[req.query.range] ? String(req.query.range) : '1M';
  const now = Date.now();
  const w0 = new Date(now - 30 * DAY).toISOString();
  const wPrev = new Date(now - 60 * DAY).toISOString();
  const tenant = await get('SELECT currency FROM tenants WHERE id = ?', [tenantId]);
  const change = (cur, prev) => (prev ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);
  const out = { currency: tenant?.currency || 'INR', range, revenue: null, conversion: null, leads: null, pipeline: null, funnel: null, series: null };

  if (await can(req.auth, 'invoices', 'view')) {
    const paid = async (from, to) => Number((await get(
      `SELECT COALESCE(SUM(p.amount_minor * COALESCE(i.exchange_rate, 1)), 0) AS v FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.paid_at >= ? AND p.paid_at < ?`, [tenantId, from, to],
    )).v);
    const cur = await paid(w0, new Date(now + DAY).toISOString());
    const prev = await paid(wPrev, w0);
    out.revenue = { value: Math.round(cur), previous: Math.round(prev), change: change(cur, prev) };

    // The chart: this period against the one before, bucket by bucket.
    const edges = bucketStarts(range, new Date(now));
    const rows = await all(
      `SELECT p.paid_at, p.amount_minor * COALESCE(i.exchange_rate, 1) AS v FROM payments p JOIN invoices i ON i.id = p.invoice_id
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.paid_at >= ? AND p.paid_at < ?`,
      [tenantId, edges[0].toISOString(), edges.at(-1).toISOString()],
    );
    const n = RANGES[range].buckets;
    const sums = new Array(n * 2).fill(0);
    for (const r of rows) {
      const t = Date.parse(r.paid_at);
      let k = 0;
      while (k < sums.length - 1 && t >= edges[k + 1].getTime()) k++;
      sums[k] += Number(r.v);
    }
    out.series = {
      unit: RANGES[range].unit,
      points: Array.from({ length: n }, (_, i) => ({
        start: edges[n + i].toISOString(), current: Math.round(sums[n + i]), previous: Math.round(sums[i]),
      })),
      total: Math.round(sums.slice(n).reduce((a, v) => a + v, 0)),
      previous_total: Math.round(sums.slice(0, n).reduce((a, v) => a + v, 0)),
    };
    out.series.change = change(out.series.total, out.series.previous_total);
  }

  if (await can(req.auth, 'proposals', 'view')) {
    const rate = async (from, to) => {
      const r = await get(
        `SELECT SUM(CASE WHEN sent_at >= ? AND sent_at < ? THEN 1 ELSE 0 END) AS sent,
                SUM(CASE WHEN accepted_at >= ? AND accepted_at < ? THEN 1 ELSE 0 END) AS won
           FROM proposals WHERE tenant_id = ? AND deleted_at IS NULL`, [from, to, from, to, tenantId],
      );
      const sent = Number(r?.sent || 0);
      return sent ? Math.min(100, Math.round((Number(r.won || 0) / sent) * 1000) / 10) : null;
    };
    const cur = await rate(w0, new Date(now + DAY).toISOString());
    const prev = await rate(wPrev, w0);
    out.conversion = { value: cur, previous: prev, change: cur != null && prev != null ? Math.round((cur - prev) * 10) / 10 : null };
  }

  if (await can(req.auth, 'crm', 'view')) {
    const openLeads = await get(
      `SELECT COUNT(*) AS n, COALESCE(SUM(deal_value_minor), 0) AS v FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'lead'`, [tenantId],
    );
    const created = async (from, to) => Number((await get(
      'SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL AND created_at >= ? AND created_at < ?', [tenantId, from, to],
    )).n);
    const newCur = await created(w0, new Date(now + DAY).toISOString());
    const newPrev = await created(wPrev, w0);
    out.leads = { value: Number(openLeads.n), new_this_period: newCur, new_previous: newPrev, change: change(newCur, newPrev) };
    out.pipeline = { value: Number(openLeads.v), deals: Number(openLeads.n) };

    // The funnel: everyone who became a lead in the last year, counted at the
    // furthest step they reached - so each bar contains the ones below it.
    const proposalSort = (await get(`SELECT sort FROM pipeline_stages WHERE tenant_id = ? AND code = 'proposal' AND deleted_at IS NULL`, [tenantId]))?.sort;
    const firstSort = (await get('SELECT MIN(sort) AS s FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL', [tenantId]))?.s ?? 0;
    const people = await all(
      `SELECT c.id, c.status, s.sort, s.is_won, s.is_lost,
              EXISTS (SELECT 1 FROM proposals p WHERE p.client_id = c.id AND p.deleted_at IS NULL AND p.sent_at IS NOT NULL) AS sent,
              EXISTS (SELECT 1 FROM proposals p WHERE p.client_id = c.id AND p.deleted_at IS NULL
                        AND (p.first_viewed_at IS NOT NULL OR p.status IN ('accepted', 'rejected'))) AS negotiated
         FROM clients c LEFT JOIN pipeline_stages s ON s.id = c.stage_id
        WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.created_at >= ?`,
      [tenantId, new Date(now - 365 * DAY).toISOString()],
    );
    const yes = (v) => v === true || Number(v) === 1;
    const steps = { total: 0, qualified: 0, proposals: 0, negotiations: 0, closed: 0 };
    for (const c of people) {
      const won = ['active', 'churned'].includes(c.status) || yes(c.is_won);
      const sort = c.sort == null ? null : Number(c.sort);
      const negotiation = won || yes(c.negotiated) || (proposalSort != null && sort != null && sort > proposalSort && !yes(c.is_lost));
      const proposal = negotiation || yes(c.sent) || (proposalSort != null && sort != null && sort >= proposalSort);
      const qualified = proposal || (sort != null && sort > firstSort);
      steps.total++;
      if (qualified) steps.qualified++;
      if (proposal) steps.proposals++;
      if (negotiation) steps.negotiations++;
      if (won) steps.closed++;
    }
    out.funnel = {
      steps: [
        { key: 'total', label: 'Total leads', value: steps.total },
        { key: 'qualified', label: 'Qualified leads', value: steps.qualified },
        { key: 'proposals', label: 'Proposals sent', value: steps.proposals },
        { key: 'negotiations', label: 'Negotiations', value: steps.negotiations },
        { key: 'closed', label: 'Closed deals', value: steps.closed },
      ],
      conversion: steps.total ? Math.round((steps.closed / steps.total) * 1000) / 10 : null,
    };
  }
  return ok(res, out);
});

export { router as dashboardRouter };
