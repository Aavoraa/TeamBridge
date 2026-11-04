import { get, all, run } from '../db/index.js';
import { uuid, nowIso, todayIso, monthIso, startOfMonth, endOfMonth, round1 } from '../lib/util.js';
import { badRequest } from '../lib/http.js';

/**
 * Performance scorecards (Module C3, v2).
 *
 * Every person except the workspace Owner gets one scorecard a month, scored
 * 0-100 from records the system already holds - nobody types a number in. It
 * is built from "pillars" (delivery, quality, ...), each scored on its own and
 * then blended by weight. The manager's 1-5 rating is the only human input,
 * and it is a fixed share of the overall.
 *
 * Two shapes of card:
 *   employee - how well their own work went
 *   manager  - their own work, plus how their team and projects went
 * Anyone with the Manager role, or anyone else with direct reports, gets the
 * manager card.
 *
 * Fairness rules that run through all of it:
 *   - A pillar with too little evidence is "not enough data" and drops out;
 *     its weight is shared across the pillars that do have data. It never
 *     counts as zero.
 *   - Weekly offs, company holidays and approved leave are not working days,
 *     so they can never count against anyone.
 *   - A month in progress is scored up to today. Work not yet due is left
 *     out rather than counted as missed.
 *
 * Every pillar carries its raw inputs and the specific records that pulled it
 * down ("drivers"), so a score can always be explained line by line.
 */

// ------------------------------------------------------------------ config
export const DEFAULT_WEIGHTS = {
  employee: { delivery: 35, quality: 20, reporting: 15, attendance: 15, process: 15 },
  manager: { own_work: 20, team_delivery: 25, project_health: 20, responsiveness: 15, team_discipline: 10, escalations: 10 },
  /** Share of the overall that comes from the manager's 1-5 rating. */
  rating_share: 20,
};

export const PILLARS = {
  delivery: 'Delivery',
  quality: 'Quality',
  reporting: 'Reporting discipline',
  attendance: 'Attendance & punctuality',
  process: 'Process (SOP)',
  own_work: 'Own delivery & quality',
  team_delivery: 'Team delivery',
  project_health: 'Project health',
  responsiveness: 'Responsiveness',
  team_discipline: 'Team discipline',
  escalations: 'Escalations',
};

/** Minimum evidence before a pillar is scored at all. */
export const MIN_SAMPLE = {
  delivery: 5, // tasks due in the period that can be judged
  quality: 3, // tasks reviewed by someone else
  reporting: 5, // working days with open tasks
  attendance: 5, // working days already over
  responsiveness: 3, // approvals and validations decided
  project_days: 3, // working days a managed project was active
};

export const PRIORITY_WEIGHT = { urgent: 3, high: 2, medium: 1, low: 0.5 };

export const BANDS = [
  { min: 90, id: 'outstanding', label: 'Outstanding' },
  { min: 75, id: 'strong', label: 'Strong' },
  { min: 60, id: 'meets', label: 'Meets expectations' },
  { min: 45, id: 'needs_improvement', label: 'Needs improvement' },
  { min: 0, id: 'concern', label: 'Concern' },
];
/**
 * Below this share of the card's weight backed by data, the score is shown as
 * provisional and no band is given - one or two areas are not a verdict on a
 * person, and early in a month that is all there is.
 */
export const MIN_COVERAGE = 60;
export const bandFor = (score, coverage = 100) =>
  (score == null || coverage < MIN_COVERAGE ? null : BANDS.find((b) => score >= b.min).id);

/** Responsiveness: decided within this many hours scores 100, by the second 0. */
const FAST_HOURS = 24;
const SLOW_HOURS = 120;

const parse = (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };

export async function weightsFor(tenantId) {
  const saved = parse((await get('SELECT performance_weights FROM tenants WHERE id = ?', [tenantId]))?.performance_weights, {});
  return {
    employee: { ...DEFAULT_WEIGHTS.employee, ...(saved.employee || {}) },
    manager: { ...DEFAULT_WEIGHTS.manager, ...(saved.manager || {}) },
    rating_share: saved.rating_share ?? DEFAULT_WEIGHTS.rating_share,
  };
}

export async function saveWeights(tenantId, weights) {
  for (const kind of ['employee', 'manager']) {
    const set = weights[kind];
    const keys = Object.keys(DEFAULT_WEIGHTS[kind]);
    if (!set || keys.some((k) => typeof set[k] !== 'number' || set[k] < 0)) {
      throw badRequest(`Every ${kind} weight must be a number of zero or more`);
    }
    const sum = keys.reduce((n, k) => n + set[k], 0);
    if (Math.round(sum) !== 100) throw badRequest(`The ${kind} weights add up to ${sum}, not 100`);
  }
  const share = weights.rating_share;
  if (typeof share !== 'number' || share < 0 || share > 50) throw badRequest('The rating share must be between 0 and 50');
  const clean = {
    employee: Object.fromEntries(Object.keys(DEFAULT_WEIGHTS.employee).map((k) => [k, weights.employee[k]])),
    manager: Object.fromEntries(Object.keys(DEFAULT_WEIGHTS.manager).map((k) => [k, weights.manager[k]])),
    rating_share: share,
  };
  await run('UPDATE tenants SET performance_weights = ?, updated_at = ? WHERE id = ?', [JSON.stringify(clean), nowIso(), tenantId]);
  return clean;
}

// ------------------------------------------------------------------ helpers
const clamp = (n) => Math.max(0, Math.min(100, n));
const pctOf = (a, b) => (b ? (a / b) * 100 : 0);
const addDay = (d, n = 1) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const hoursBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 3_600_000;
const dayOf = (iso) => (iso ? String(iso).slice(0, 10) : null);

/** Blend whichever parts are present, by weight. Null when none are. */
function blend(parts) {
  const have = parts.filter((p) => p.score != null && p.weight > 0);
  const w = have.reduce((n, p) => n + p.weight, 0);
  return w ? have.reduce((n, p) => n + p.score * p.weight, 0) / w : null;
}

const pillar = (key, weight, score, inputs, drivers = [], note = null) => ({
  key,
  label: PILLARS[key],
  weight,
  score: score == null ? null : round1(clamp(score)),
  status: score == null ? 'insufficient' : 'scored',
  inputs,
  drivers: drivers.slice(0, 8),
  note,
});

/**
 * The period being scored. A past month runs first to last day; the current
 * month runs to today; a future month is refused.
 */
export function periodFor(month = monthIso()) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw badRequest('Months are YYYY-MM');
  const from = startOfMonth(month).slice(0, 10);
  const monthEnd = endOfMonth(month).slice(0, 10);
  const today = todayIso();
  if (from > today) throw badRequest('That month has not started yet');
  return { month, from, to: monthEnd < today ? monthEnd : today, monthEnd, inProgress: monthEnd >= today };
}

/** Working days for the workspace in [from, to]: no weekly offs, no company holidays. */
async function workspaceDays(tenantId, from, to) {
  const offs = parse((await get('SELECT week_off_days FROM tenants WHERE id = ?', [tenantId]))?.week_off_days, [0]);
  const holidays = new Set((await all(
    `SELECT holiday_date FROM holidays WHERE tenant_id = ? AND deleted_at IS NULL
        AND kind = 'company_holiday' AND holiday_date BETWEEN ? AND ?`,
    [tenantId, from, to],
  )).map((h) => h.holiday_date));
  const days = [];
  for (let d = from; d <= to; d = addDay(d)) {
    const weekday = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (!offs.includes(weekday) && !holidays.has(d)) days.push(d);
  }
  return days;
}

/** Days this person was on approved full-day leave in the period. */
async function leaveDays(tenantId, userId, from, to) {
  const rows = await all(
    `SELECT from_date, to_date FROM leave_requests
      WHERE tenant_id = ? AND user_id = ? AND status = 'approved' AND kind = 'leave'
        AND from_date <= ? AND to_date >= ?`,
    [tenantId, userId, to, from],
  );
  const out = new Set();
  for (const r of rows) for (let d = r.from_date; d <= r.to_date; d = addDay(d)) out.add(d);
  return out;
}

/** Every task this person is on - as the owner or a co-assignee. */
async function tasksOf(tenantId, userId, where, params) {
  return await all(
    `SELECT DISTINCT a.id, a.title, a.priority, a.status, a.due_date, a.due_at, a.completed_at, a.created_at,
            a.validation_status, a.validated_by, a.validated_at, a.completed_by, a.rework_count
       FROM action_items a
       LEFT JOIN action_assignees aa ON aa.action_item_id = a.id AND aa.user_id = ?
      WHERE a.tenant_id = ? AND a.deleted_at IS NULL AND a.status != 'cancelled'
        AND (a.owner_id = ? OR aa.user_id IS NOT NULL) AND ${where}`,
    [userId, tenantId, userId, ...params],
  );
}

// ------------------------------------------------------- employee pillars
async function deliveryPillar(ctx, user, weight) {
  const { tenantId, period, now } = ctx;
  const tasks = await tasksOf(tenantId, user.id, 'a.due_date BETWEEN ? AND ?', [period.from, period.monthEnd]);
  let earned = 0;
  let possible = 0;
  const counts = { on_time: 0, late: 0, overdue: 0, not_yet_due: 0 };
  const drivers = [];

  for (const t of tasks) {
    const due = t.due_at || `${t.due_date}T23:59:59Z`;
    const w = PRIORITY_WEIGHT[t.priority] ?? 1;
    let credit;
    if (t.status === 'done' && t.completed_at) {
      if (t.completed_at <= due) { credit = 1; counts.on_time += 1; } else {
        credit = 0.5; counts.late += 1;
        drivers.push({ text: `Finished late: ${t.title}`, detail: `due ${dayOf(due)}, done ${dayOf(t.completed_at)}`, ref: `/action-items?open=${t.id}` });
      }
    } else if (due < now) {
      credit = 0; counts.overdue += 1;
      drivers.push({ text: `Overdue: ${t.title}`, detail: `was due ${dayOf(due)} (${t.priority})`, ref: `/action-items?open=${t.id}` });
    } else {
      counts.not_yet_due += 1;
      continue;
    }
    earned += credit * w;
    possible += w;
  }
  const judged = counts.on_time + counts.late + counts.overdue;
  const score = judged >= MIN_SAMPLE.delivery ? pctOf(earned, possible) : null;
  // Overdue first - it is the one still costing something.
  drivers.sort((a, b) => (a.text.startsWith('Overdue') ? -1 : 0) - (b.text.startsWith('Overdue') ? -1 : 0));
  return pillar('delivery', weight, score, { ...counts, judged, weighted_earned: round1(earned), weighted_possible: round1(possible) }, drivers);
}

async function qualityPillar(ctx, user, weight) {
  const { tenantId, period } = ctx;
  const toEnd = `${period.to}T23:59:59.999Z`;
  // Judged by somebody else: self-raised work signs itself off and proves nothing.
  const reviewed = await tasksOf(tenantId, user.id,
    `a.validated_by IS NOT NULL AND a.validated_by != COALESCE(a.completed_by, '')
       AND a.validation_status = 'validated' AND a.validated_at BETWEEN ? AND ?`,
    [`${period.from}T00:00:00Z`, toEnd]);
  const sentBack = await tasksOf(tenantId, user.id,
    `a.validation_status = 'changes_requested' AND a.updated_at BETWEEN ? AND ?`,
    [`${period.from}T00:00:00Z`, toEnd]);

  const firstPass = reviewed.filter((t) => !t.rework_count).length;
  const total = reviewed.length + sentBack.length;
  const reworks = reviewed.reduce((n, t) => n + (t.rework_count || 0), 0) + sentBack.length;
  const drivers = [
    ...sentBack.map((t) => ({ text: `Sent back for changes: ${t.title}`, detail: 'still waiting on rework', ref: `/action-items?open=${t.id}` })),
    ...reviewed.filter((t) => t.rework_count).map((t) => ({
      text: `Needed ${t.rework_count} round(s) of rework: ${t.title}`, detail: 'validated in the end', ref: `/action-items?open=${t.id}`,
    })),
  ];
  const score = total >= MIN_SAMPLE.quality ? pctOf(firstPass, total) : null;
  return pillar('quality', weight, score, { reviewed: total, first_time_pass: firstPass, rework_rounds: reworks }, drivers);
}

async function reportingPillar(ctx, user, weight, days) {
  const { tenantId, period } = ctx;
  const tasks = await tasksOf(tenantId, user.id, `a.created_at <= ? AND (a.completed_at IS NULL OR a.completed_at >= ?)`,
    [`${period.to}T23:59:59.999Z`, `${period.from}T00:00:00Z`]);
  const filed = new Set((await all(
    `SELECT DISTINCT update_date FROM action_updates WHERE tenant_id = ? AND user_id = ?
        AND deleted_at IS NULL AND update_date BETWEEN ? AND ?`,
    [tenantId, user.id, period.from, period.to],
  )).map((r) => r.update_date));

  const today = todayIso();
  let expected = 0;
  let done = 0;
  const missed = [];
  for (const d of days) {
    // Today is not over - an update filed at 6pm still counts, so do not judge it yet.
    if (d === today) continue;
    const open = tasks.some((t) => dayOf(t.created_at) <= d && (!t.completed_at || dayOf(t.completed_at) >= d));
    if (!open) continue;
    expected += 1;
    if (filed.has(d)) done += 1; else missed.push(d);
  }
  const score = expected >= MIN_SAMPLE.reporting ? pctOf(done, expected) : null;
  const drivers = missed.length
    ? [{ text: `No daily update on ${missed.length} working day(s) with open tasks`, detail: missed.slice(-6).join(', ') }]
    : [];
  return pillar('reporting', weight, score, { days_expected: expected, days_filed: done }, drivers);
}

async function attendancePillar(ctx, user, weight, days) {
  const { tenantId, period } = ctx;
  const rows = await all(
    `SELECT work_date, status, late_minutes, permission_id, approved_by FROM attendance
      WHERE tenant_id = ? AND user_id = ? AND work_date BETWEEN ? AND ?`,
    [tenantId, user.id, period.from, period.to],
  );
  const byDay = new Map(rows.map((r) => [r.work_date, r]));
  const today = todayIso();
  let counted = 0;
  let credit = 0;
  let attended = 0;
  let late = 0;
  const absentDays = [];
  const lateDays = [];

  for (const d of days) {
    const r = byDay.get(d);
    if (r && ['leave', 'holiday', 'weekoff'].includes(r.status)) continue;
    if (!r) {
      if (d >= today) continue; // the day is not over
      counted += 1;
      absentDays.push(d);
      continue;
    }
    counted += 1;
    const c = { present: 1, wfh: 1, pending_approval: 1, half_day: 0.5 }[r.status] ?? 0;
    credit += c;
    if (c > 0) attended += 1; else absentDays.push(d);
    // Late counts only when nobody excused it: no approved permission, no HR approval.
    if (r.late_minutes > 0 && !r.permission_id && !r.approved_by && ['pending_approval', 'not_approved'].includes(r.status)) {
      late += 1;
      lateDays.push(`${d} (${r.late_minutes} min)`);
    }
  }
  const attendancePct = pctOf(credit, counted);
  const punctualityPct = attended ? 100 - pctOf(late, attended) : 100;
  const score = counted >= MIN_SAMPLE.attendance ? attendancePct * 0.8 + punctualityPct * 0.2 : null;
  const drivers = [
    ...(absentDays.length ? [{ text: `Absent or not approved on ${absentDays.length} working day(s)`, detail: absentDays.slice(-6).join(', ') }] : []),
    ...(late ? [{ text: `${late} unexcused late arrival(s)`, detail: lateDays.slice(-5).join(', ') }] : []),
  ];
  return pillar('attendance', weight, score, {
    working_days: counted, attendance_pct: round1(attendancePct), unexcused_late: late, punctuality_pct: round1(punctualityPct),
  }, drivers);
}

async function processPillar(ctx, user, weight) {
  const { tenantId, period } = ctx;
  const runs = await get(
    `SELECT COUNT(*) AS n, AVG(adherence_pct) AS avg FROM sop_runs
      WHERE tenant_id = ? AND user_id = ? AND started_at BETWEEN ? AND ?`,
    [tenantId, user.id, `${period.from}T00:00:00Z`, `${period.to}T23:59:59.999Z`],
  );
  const sops = await all(
    `SELECT s.id, s.title, s.current_version,
            EXISTS (SELECT 1 FROM sop_acknowledgements k WHERE k.sop_id = s.id AND k.version = s.current_version
                      AND k.user_id = ?) AS acked
       FROM sops s
      WHERE s.tenant_id = ? AND s.deleted_at IS NULL AND s.status = 'published' AND s.requires_ack = 1
        AND s.current_version > 0 AND (s.service_line_id IS NULL OR s.service_line_id = ?)`,
    [user.id, tenantId, user.service_line_id ?? ''],
  );
  const acked = sops.filter((s) => s.acked).length;
  const adherence = Number(runs?.n) ? Number(runs.avg) : null;
  const ackRate = sops.length ? pctOf(acked, sops.length) : null;
  const score = blend([{ score: adherence, weight: 70 }, { score: ackRate, weight: 30 }]);
  const drivers = sops.filter((s) => !s.acked).map((s) => ({
    text: `SOP not acknowledged: ${s.title}`, detail: `version ${s.current_version}`, ref: `/sop/${s.id}`,
  }));
  return pillar('process', weight, score, {
    sop_runs: Number(runs?.n || 0), avg_adherence_pct: adherence == null ? null : round1(adherence),
    sops_to_acknowledge: sops.length, acknowledged: acked,
  }, drivers);
}

// -------------------------------------------------------- manager pillars
async function projectHealthPillar(ctx, user, weight) {
  const { tenantId, period } = ctx;
  const projects = await all(
    `SELECT p.id, p.name, p.created_at FROM project_members pm
       JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
      WHERE pm.tenant_id = ? AND pm.user_id = ? AND pm.deleted_at IS NULL AND pm.seat = 'manager'
        AND p.status IN ('active','completed') AND p.created_at <= ?`,
    [tenantId, user.id, `${period.to}T23:59:59.999Z`],
  );
  const today = todayIso();
  const statusScore = { on_track: 100, at_risk: 50, blocked: 0 };
  let healthSum = 0;
  let healthDays = 0;
  let expected = 0;
  let filed = 0;
  const drivers = [];
  let scoredProjects = 0;

  for (const p of projects) {
    const start = dayOf(p.created_at) > period.from ? dayOf(p.created_at) : period.from;
    const days = ctx.days.filter((d) => d >= start && d < today);
    if (days.length < MIN_SAMPLE.project_days) continue;
    scoredProjects += 1;
    const ups = await all(
      `SELECT update_date, user_id, status FROM project_updates
        WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL AND update_date BETWEEN ? AND ?`,
      [tenantId, p.id, period.from, period.to],
    );
    const worst = {};
    for (const u of ups) {
      if (worst[u.update_date] == null || statusScore[u.status] < worst[u.update_date]) worst[u.update_date] = statusScore[u.status];
    }
    const flaggedDays = Object.values(worst).filter((s) => s < 100).length;
    for (const s of Object.values(worst)) { healthSum += s; healthDays += 1; }
    const mine = new Set(ups.filter((u) => u.user_id === user.id).map((u) => u.update_date));
    const myFiled = days.filter((d) => mine.has(d)).length;
    expected += days.length;
    filed += myFiled;
    if (flaggedDays) drivers.push({ text: `${p.name}: at risk or blocked on ${flaggedDays} day(s)`, ref: `/projects/${p.id}` });
    if (myFiled < days.length) drivers.push({ text: `${p.name}: your daily update missing on ${days.length - myFiled} of ${days.length} day(s)`, ref: `/projects/${p.id}` });
  }

  const health = healthDays ? healthSum / healthDays : null;
  const filing = expected ? pctOf(filed, expected) : null;
  const score = scoredProjects ? blend([{ score: health, weight: 60 }, { score: filing, weight: 40 }]) : null;
  return pillar('project_health', weight, score, {
    projects_managed: scoredProjects, health_pct: health == null ? null : round1(health),
    update_days_expected: expected, update_days_filed: filed,
  }, drivers);
}

async function responsivenessPillar(ctx, user, weight) {
  const { tenantId, period } = ctx;
  const from = `${period.from}T00:00:00Z`;
  const to = `${period.to}T23:59:59.999Z`;
  const waits = [];

  // Task sign-offs: from the latest submission to this person's ruling.
  for (const v of await all(
    `SELECT v.action_item_id, v.created_at, a.title,
            (SELECT MAX(s.created_at) FROM action_validations s WHERE s.action_item_id = v.action_item_id
               AND s.event = 'submitted' AND s.created_at <= v.created_at) AS submitted_at
       FROM action_validations v JOIN action_items a ON a.id = v.action_item_id
      WHERE v.tenant_id = ? AND v.actor_id = ? AND v.event IN ('validated','changes_requested')
        AND v.created_at BETWEEN ? AND ?`,
    [tenantId, user.id, from, to],
  )) {
    if (v.submitted_at) waits.push({ kind: 'Task sign-off', what: v.title, hours: hoursBetween(v.submitted_at, v.created_at) });
  }
  for (const l of await all(
    `SELECT l.created_at, l.decided_at, u.name FROM leave_requests l JOIN users u ON u.id = l.user_id
      WHERE l.tenant_id = ? AND l.approver_id = ? AND l.decided_at BETWEEN ? AND ?`,
    [tenantId, user.id, from, to],
  )) waits.push({ kind: 'Leave', what: l.name, hours: hoursBetween(l.created_at, l.decided_at) });
  for (const a of await all(
    `SELECT a.check_in_at, a.approved_at, u.name FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = ? AND a.approved_by = ? AND a.approved_at BETWEEN ? AND ? AND a.check_in_at IS NOT NULL`,
    [tenantId, user.id, from, to],
  )) waits.push({ kind: 'Attendance', what: a.name, hours: hoursBetween(a.check_in_at, a.approved_at) });
  for (const r of await all(
    `SELECT e.created_at, r.number,
            (SELECT MAX(s.created_at) FROM reimbursement_events s WHERE s.reimbursement_id = e.reimbursement_id
               AND s.action = 'submitted' AND s.created_at <= e.created_at) AS submitted_at
       FROM reimbursement_events e JOIN reimbursements r ON r.id = e.reimbursement_id
      WHERE e.tenant_id = ? AND e.actor_id = ? AND e.action IN ('manager_approved','manager_rejected')
        AND e.created_at BETWEEN ? AND ?`,
    [tenantId, user.id, from, to],
  )) {
    if (r.submitted_at) waits.push({ kind: 'Reimbursement', what: r.number, hours: hoursBetween(r.submitted_at, r.created_at) });
  }

  const valid = waits.filter((w) => w.hours >= 0);
  const avg = valid.length ? valid.reduce((n, w) => n + w.hours, 0) / valid.length : null;
  const score = valid.length >= MIN_SAMPLE.responsiveness
    ? (avg <= FAST_HOURS ? 100 : 100 - ((avg - FAST_HOURS) / (SLOW_HOURS - FAST_HOURS)) * 100)
    : null;
  const drivers = valid.filter((w) => w.hours > FAST_HOURS).sort((a, b) => b.hours - a.hours)
    .map((w) => ({ text: `${w.kind} took ${round1(w.hours)}h to decide`, detail: w.what }));
  return pillar('responsiveness', weight, score, {
    decisions: valid.length, avg_hours: avg == null ? null : round1(avg),
    within_24h: valid.filter((w) => w.hours <= FAST_HOURS).length,
  }, drivers);
}

async function escalationsPillar(ctx, user, weight, teamSize, hasScope) {
  const { tenantId, period } = ctx;
  const rows = await all(
    `SELECT reason, created_at FROM escalations WHERE tenant_id = ? AND to_user_id = ? AND created_at BETWEEN ? AND ?`,
    [tenantId, user.id, `${period.from}T00:00:00Z`, `${period.to}T23:59:59.999Z`],
  );
  // 20 points per escalation per person on the team, so a big team is not punished for being big.
  const score = hasScope ? 100 - (20 * rows.length) / Math.max(teamSize, 1) : null;
  const drivers = rows.map((r) => ({ text: `Escalated to you: ${r.reason || 'no reason given'}`, detail: dayOf(r.created_at) }));
  return pillar('escalations', weight, score, { escalations: rows.length, team_size: teamSize }, drivers);
}

// -------------------------------------------------------------- the cards
async function employeePillars(ctx, user) {
  const w = ctx.weights.employee;
  const leave = await leaveDays(ctx.tenantId, user.id, ctx.period.from, ctx.period.to);
  const days = ctx.days.filter((d) => !leave.has(d));
  return [
    await deliveryPillar(ctx, user, w.delivery),
    await qualityPillar(ctx, user, w.quality),
    await reportingPillar(ctx, user, w.reporting, days),
    await attendancePillar(ctx, user, w.attendance, days),
    await processPillar(ctx, user, w.process),
  ];
}

const pick = (pillars, key) => pillars.find((p) => p.key === key);
const avgOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

async function managerPillars(ctx, user, own, reports) {
  const w = ctx.weights.manager;
  const ew = ctx.weights.employee;
  const ownWork = blend([
    { score: pick(own, 'delivery').score, weight: ew.delivery },
    { score: pick(own, 'quality').score, weight: ew.quality },
  ]);
  const teamDeliveryEach = reports.map((r) => ({
    name: r.user.name,
    score: blend([{ score: pick(r.pillars, 'delivery').score, weight: ew.delivery }, { score: pick(r.pillars, 'quality').score, weight: ew.quality }]),
  })).filter((r) => r.score != null);
  const disciplineEach = reports.map((r) => ({
    name: r.user.name,
    score: blend([{ score: pick(r.pillars, 'reporting').score, weight: ew.reporting }, { score: pick(r.pillars, 'attendance').score, weight: ew.attendance }]),
  })).filter((r) => r.score != null);

  const low = (each, label) => each.filter((r) => r.score < 60).sort((a, b) => a.score - b.score)
    .map((r) => ({ text: `${r.name}: ${label} ${round1(r.score)}` }));
  const projects = await projectHealthPillar(ctx, user, w.project_health);
  const hasScope = reports.length > 0 || projects.inputs.projects_managed > 0;

  return [
    pillar('own_work', w.own_work, ownWork, {
      delivery: pick(own, 'delivery').score, quality: pick(own, 'quality').score,
    }, [...pick(own, 'delivery').drivers, ...pick(own, 'quality').drivers]),
    pillar('team_delivery', w.team_delivery, avgOf(teamDeliveryEach.map((r) => r.score)), {
      direct_reports: reports.length, scored: teamDeliveryEach.length,
      members: teamDeliveryEach.map((r) => ({ name: r.name, score: round1(r.score) })),
    }, low(teamDeliveryEach, 'delivery & quality')),
    projects,
    await responsivenessPillar(ctx, user, w.responsiveness),
    pillar('team_discipline', w.team_discipline, avgOf(disciplineEach.map((r) => r.score)), {
      direct_reports: reports.length, scored: disciplineEach.length,
      members: disciplineEach.map((r) => ({ name: r.name, score: round1(r.score) })),
    }, low(disciplineEach, 'reporting & attendance')),
    await escalationsPillar(ctx, user, w.escalations, reports.length, hasScope),
  ];
}

function finish(user, kind, pillars, extra = {}) {
  const system = blend(pillars.map((p) => ({ score: p.score, weight: p.weight })));
  const scoredWeight = pillars.filter((p) => p.score != null).reduce((n, p) => n + p.weight, 0);
  return {
    user, kind, pillars,
    system_score: system == null ? null : round1(system),
    // How much of the card had data - 100 means every pillar was scored.
    coverage_pct: round1(pctOf(scoredWeight, pillars.reduce((n, p) => n + p.weight, 0))),
    ...extra,
  };
}

const STAFF_SELECT = `SELECT id, name, role, manager_id, service_line_id, designation, avatar_url FROM users
  WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role NOT IN ('client','owner','super_admin')`;

/**
 * Compute scorecards for the period. `onlyUserIds` limits which cards come
 * back; the team needed to score a manager is computed regardless.
 */
export async function computeScorecards(tenantId, month, onlyUserIds = null) {
  const period = periodFor(month);
  const ctx = {
    tenantId, period, now: nowIso(), weights: await weightsFor(tenantId),
    days: await workspaceDays(tenantId, period.from, period.to),
  };
  const staff = await all(STAFF_SELECT, [tenantId]);
  const reportsOf = (id) => staff.filter((u) => u.manager_id === id);
  const isManager = (u) => u.role === 'manager' || reportsOf(u.id).length > 0;

  const wanted = onlyUserIds ? staff.filter((u) => onlyUserIds.includes(u.id)) : staff;
  // Everyone whose employee pillars are needed: the wanted people and their reports.
  const needed = new Map();
  for (const u of wanted) {
    needed.set(u.id, u);
    if (isManager(u)) for (const r of reportsOf(u.id)) needed.set(r.id, r);
  }
  const own = new Map(await Promise.all([...needed.values()].map(async (u) => [u.id, await employeePillars(ctx, u)])));

  return {
    period,
    weights: ctx.weights,
    cards: await Promise.all(wanted.map(async (u) => {
      if (!isManager(u)) return finish(u, 'employee', own.get(u.id));
      const reports = reportsOf(u.id).map((r) => ({ user: r, pillars: own.get(r.id) }));
      return finish(u, 'manager', await managerPillars(ctx, u, own.get(u.id), reports), { direct_reports: reports.length });
    })),
  };
}

/** Overall = system score blended with the manager's rating; the system score alone until rated. */
export function overallFor(systemScore, rating, ratingShare) {
  if (systemScore == null) return rating ? round1(rating * 20) : null;
  if (!rating) return systemScore;
  const s = ratingShare / 100;
  return round1(systemScore * (1 - s) + rating * 20 * s);
}

/**
 * Store the month's scorecards on performance_reviews. Idempotent: re-running
 * refreshes the computed half and keeps the manager's rating, notes and status.
 */
export async function generateReviews(tenantId, month, onlyUserIds = null) {
  const { period, weights, cards } = await computeScorecards(tenantId, month, onlyUserIds);
  const at = nowIso();
  for (const card of cards) {
    const u = card.user;
    const existing = await get('SELECT * FROM performance_reviews WHERE tenant_id = ? AND user_id = ? AND period_month = ?',
      [tenantId, u.id, month]);
    const id = existing?.id || uuid();
    const d = pick(card.pillars, 'delivery') || pick(card.pillars, 'own_work');
    const att = pick(card.pillars, 'attendance');
    const di = d?.key === 'delivery' ? d.inputs : null;
    const overall = overallFor(card.system_score, existing?.manager_rating, weights.rating_share);
    const legacy = {
      items_assigned: di ? di.judged + di.not_yet_due : 0,
      items_completed: di ? di.on_time + di.late : 0,
      items_on_time: di ? di.on_time : 0,
      completion_pct: di && di.judged ? round1(pctOf(di.on_time + di.late, di.judged)) : 0,
      attendance_pct: att?.inputs.attendance_pct ?? 0,
    };
    const fields = [
      legacy.items_assigned, legacy.items_completed, legacy.items_on_time, legacy.completion_pct, legacy.attendance_pct,
      card.system_score ?? 0, overall, card.kind, card.system_score, bandFor(overall, card.coverage_pct),
      JSON.stringify({ pillars: card.pillars, coverage_pct: card.coverage_pct, direct_reports: card.direct_reports ?? 0 }),
      at, period.to,
    ];
    if (existing) {
      await run(
        `UPDATE performance_reviews SET items_assigned = ?, items_completed = ?, items_on_time = ?, completion_pct = ?,
           attendance_pct = ?, kpi_score = ?, overall_score = ?, scorecard_kind = ?, system_score = ?, band = ?,
           pillars = ?, computed_at = ?, period_end = ?, updated_at = ? WHERE id = ?`,
        [...fields, at, id],
      );
    } else {
      await run(
        `INSERT INTO performance_reviews (id, tenant_id, user_id, period_month, items_assigned, items_completed,
           items_on_time, completion_pct, attendance_pct, kpi_score, overall_score, scorecard_kind, system_score,
           band, pillars, computed_at, period_end, status, reviewer_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', ?,?,?)`,
        [id, tenantId, u.id, month, ...fields, u.manager_id, at, at],
      );
    }
    await writeKpiScores(tenantId, id, u, card);
  }
  return { generated: cards.length, month, period };
}

/** KPI/KRA definitions with an automatic source get their actuals from the card. */
async function writeKpiScores(tenantId, reviewId, user, card) {
  await run('DELETE FROM performance_kpi_scores WHERE review_id = ?', [reviewId]);
  const kpis = await all(
    `SELECT * FROM kpis WHERE tenant_id = ? AND deleted_at IS NULL AND active = 1
       AND (applies_role IS NULL OR applies_role = ?)`,
    [tenantId, user.role],
  );
  if (!kpis.length) return;
  const del = pick(card.pillars, 'delivery');
  const att = pick(card.pillars, 'attendance');
  const pro = pick(card.pillars, 'process');
  const actuals = {
    'action_items.completion': del && del.inputs.judged ? round1(pctOf(del.inputs.on_time + del.inputs.late, del.inputs.judged)) : null,
    'action_items.on_time': del && (del.inputs.on_time + del.inputs.late) ? round1(pctOf(del.inputs.on_time, del.inputs.on_time + del.inputs.late)) : null,
    'attendance.pct': att?.inputs.attendance_pct ?? null,
    'sop.adherence': pro?.inputs.avg_adherence_pct ?? null,
  };
  for (const k of kpis) {
    const actual = actuals[k.source] ?? null;
    await run(
      `INSERT INTO performance_kpi_scores (id, tenant_id, review_id, kpi_id, kpi_name, target_value,
         actual_value, achievement_pct, weight, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, reviewId, k.id, k.name, k.target_value, actual,
        actual != null && k.target_value ? round1((actual / k.target_value) * 100) : null, k.weight, nowIso()],
    );
  }
}

/** Previous calendar month, YYYY-MM. */
export function previousMonth(d = new Date()) {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
  return x.toISOString().slice(0, 7);
}

/** The stored JSON breakdown on a review row. */
export const parseDetail = (raw) => parse(raw, {});
