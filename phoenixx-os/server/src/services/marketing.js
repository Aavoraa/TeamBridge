import { get, all, run } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { badRequest } from '../lib/http.js';
import { DEFAULT_TZ, todayInTz, timeInTz } from '../lib/dueTime.js';
import { notifyMany } from './notifications.js';
import { raiseEscalation } from './deadlines.js';
import { canSeeProject } from './projectOversight.js';

/**
 * Marketing projects and their leads.
 *
 * A marketing project (projects.kind = 'marketing') owns a lead pipeline kept
 * in its own `leads` table. The rules that run through everything here:
 *
 *   - A lead is entered once. ⭐ Progressive, My leads, Follow-up today and the
 *     other views are filters over the same rows.
 *   - Everything that happens to a lead is written to `lead_activities`, so the
 *     timeline and every report are built from one append-only record.
 *   - ⭐ is an attention flag on top of a status, never a status of its own,
 *     and only the project manager and team lead may set or clear it.
 *   - A lead given up on is marked dead with a reason. It is recorded in
 *     `dead_leads`; the lead row and its history are kept, and it can be revived.
 *   - Health is computed on read and never stored, so it is never stale.
 */

// ---------------------------------------------------------------- catalogue
export const STATUSES = [
  { id: 'new', label: 'New' },
  { id: 'contacted', label: 'Contacted' },
  { id: 'interested', label: 'Interested' },
  { id: 'qualified', label: 'Qualified' },
  { id: 'proposal', label: 'Proposal' },
  { id: 'negotiation', label: 'Negotiation' },
  { id: 'won', label: 'Won' },
];
export const OPEN_STATUSES = ['new', 'contacted', 'interested', 'qualified', 'proposal', 'negotiation'];
const STATUS_RANK = Object.fromEntries(STATUSES.map((s, i) => [s.id, i]));
export const statusLabel = (id) => (id === 'dead' ? 'Dead' : STATUSES.find((s) => s.id === id)?.label || id);

export const SOURCES = ['email', 'linkedin', 'website', 'referral', 'campaign', 'cold_call', 'event', 'other'];
export const TEMPERATURES = ['cold', 'warm', 'hot'];
export const PRIORITIES = ['critical', 'high', 'normal'];

export const PROGRESSIVE_REASONS = [
  { id: 'quotation_requested', label: 'Requested quotation' },
  { id: 'meeting_requested', label: 'Requested meeting' },
  { id: 'pricing_asked', label: 'Asked for pricing' },
  { id: 'decision_maker_engaged', label: 'Decision maker engaged' },
  { id: 'proposal_requested', label: 'Proposal requested' },
  { id: 'negotiation', label: 'Negotiation' },
  { id: 'strong_buying_signal', label: 'Strong buying signal' },
  { id: 'other', label: 'Other' },
];

/**
 * Why a lead died. Marketing's own list - the CRM's reason codes describe why
 * a paying client left, which is a different question from why a prospect
 * never became one.
 */
export const DEAD_REASONS = [
  { id: 'no_response', label: 'No response after repeated follow-ups' },
  { id: 'not_interested', label: 'Not interested' },
  { id: 'no_budget', label: 'No budget' },
  { id: 'lost_to_competitor', label: 'Went with a competitor' },
  { id: 'no_requirement', label: 'No current requirement' },
  { id: 'postponed', label: 'Project postponed indefinitely' },
  { id: 'wrong_contact', label: 'Wrong or invalid contact' },
  { id: 'duplicate', label: 'Duplicate lead' },
  { id: 'other', label: 'Other' },
];

/** What happened today, as the daily update asks it - and where it moves the lead. */
export const OUTCOMES = [
  { id: 'no_response', label: 'No response', moves_to: null },
  { id: 'follow_up_done', label: 'Follow-up completed', moves_to: 'contacted' },
  { id: 'interested', label: 'Client interested', moves_to: 'interested' },
  { id: 'meeting_done', label: 'Meeting completed', moves_to: null },
  { id: 'proposal_sent', label: 'Proposal sent', moves_to: 'proposal' },
  { id: 'negotiation', label: 'Negotiation', moves_to: 'negotiation' },
  { id: 'converted', label: 'Converted', moves_to: 'won' },
  { id: 'waiting', label: 'Waiting on the client', moves_to: null },
  { id: 'other', label: 'Other', moves_to: null },
];
const RESPONSE_OUTCOMES = ['interested', 'meeting_done', 'proposal_sent', 'negotiation', 'converted'];

/** Things logged by hand from the lead drawer. */
export const ACTIVITY_TYPES = ['call', 'email', 'whatsapp', 'meeting', 'note'];

// ---------------------------------------------------------------- settings
export const DEFAULT_SETTINGS = {
  /** No activity for this many working days makes a ⭐ lead stalled. */
  stalled_days: 5,
  /** The escalation ladder for ⭐ leads, in working days without activity. */
  remind_after_days: 1, // assignee: follow-up pending
  warn_after_days: 3, // assignee: inactive warning
  escalate_after_days: 6, // + project owners, and an escalation is raised
  /** Workspace-local times. */
  watch_time: '10:00',
  update_reminder_time: '18:30',
  daily_report_time: '19:15',
  weekly_report_day: 1, // 0 = Sunday ... 1 = Monday
  weekly_report_time: '09:30',
};

const parse = (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };

export async function settingsFor(tenantId) {
  const saved = parse((await get('SELECT marketing_settings FROM tenants WHERE id = ?', [tenantId]))?.marketing_settings, {});
  return { ...DEFAULT_SETTINGS, ...saved };
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export async function saveSettings(tenantId, body) {
  const s = { ...await settingsFor(tenantId), ...body };
  const days = ['remind_after_days', 'warn_after_days', 'stalled_days', 'escalate_after_days'];
  for (const k of days) {
    if (!Number.isInteger(s[k]) || s[k] < 1 || s[k] > 60) throw badRequest(`${k.replace(/_/g, ' ')} must be a whole number of days from 1 to 60`);
  }
  if (!(s.remind_after_days < s.warn_after_days && s.warn_after_days < s.stalled_days && s.stalled_days < s.escalate_after_days)) {
    throw badRequest('The ladder must climb: remind < warn < stalled < escalate');
  }
  for (const k of ['watch_time', 'update_reminder_time', 'daily_report_time', 'weekly_report_time']) {
    if (!HHMM.test(String(s[k]))) throw badRequest(`${k.replace(/_/g, ' ')} must be HH:MM`);
  }
  if (!Number.isInteger(s.weekly_report_day) || s.weekly_report_day < 0 || s.weekly_report_day > 6) {
    throw badRequest('weekly report day must be 0 (Sunday) to 6 (Saturday)');
  }
  const clean = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]]));
  await run('UPDATE tenants SET marketing_settings = ?, updated_at = ? WHERE id = ?', [JSON.stringify(clean), nowIso(), tenantId]);
  return clean;
}

// ------------------------------------------------------------------- clock
export const tzOf = async (tenantId) => (await get('SELECT timezone FROM tenants WHERE id = ?', [tenantId]))?.timezone || DEFAULT_TZ;
const weekOffs = async (tenantId) => parse((await get('SELECT week_off_days FROM tenants WHERE id = ?', [tenantId]))?.week_off_days, [0]);
const addDay = (d, n = 1) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();

/** Working days strictly after `fromDay` up to and including `today`. */
export function workingDaysSince(fromDay, today, offs) {
  if (!fromDay || fromDay >= today) return 0;
  let n = 0;
  for (let d = addDay(fromDay); d <= today; d = addDay(d)) if (!offs.includes(weekday(d))) n += 1;
  return n;
}

// ------------------------------------------------------------------ health
export const HEALTH = {
  moving: { label: 'Moving', rank: 4 },
  waiting: { label: 'Waiting', rank: 3 },
  needs_followup: { label: 'Needs follow-up', rank: 2 },
  stalled: { label: 'Stalled', rank: 1 },
};

/**
 * First match wins: stalled, then needs follow-up, then waiting, then moving.
 * A lead with no next action always needs follow-up - a plan that is not
 * written down is not a plan.
 */
export function healthOf(lead, ctx) {
  if (!OPEN_STATUSES.includes(lead.status)) return null;
  const lastLocal = (lead.last_activity_at || lead.created_at) ? todayInTz(ctx.tz, new Date(lead.last_activity_at || lead.created_at)) : null;
  const inactive = workingDaysSince(lastLocal, ctx.today, ctx.offs);
  let id;
  let why;
  if (inactive >= ctx.settings.stalled_days) { id = 'stalled'; why = `No activity for ${inactive} working day(s)`; }
  else if (!lead.next_action) { id = 'needs_followup'; why = 'Next action not recorded'; }
  else if (!lead.next_followup_date || lead.next_followup_date <= ctx.today) {
    id = 'needs_followup';
    why = !lead.next_followup_date ? 'No follow-up date' : lead.next_followup_date < ctx.today ? `Follow-up overdue since ${lead.next_followup_date}` : 'Follow-up due today';
  } else if (['no_response', 'waiting'].includes(lead.last_outcome)) { id = 'waiting'; why = 'Waiting on the client'; }
  else { id = 'moving'; why = 'Recent activity and a follow-up scheduled'; }
  return { id, label: HEALTH[id].label, rank: HEALTH[id].rank, why, inactive_days: inactive };
}

export async function healthContext(tenantId) {
  const tz = await tzOf(tenantId);
  return { tz, today: todayInTz(tz), offs: await weekOffs(tenantId), settings: await settingsFor(tenantId) };
}

// ------------------------------------------------------------ permissions
/** The marketing project, if this person may see it. */
export async function marketingProjectFor(auth, projectId) {
  const p = await get(
    `SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id
      WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL`,
    [projectId, auth.tenantId],
  );
  if (!p || p.kind !== 'marketing' || !await canSeeProject(auth, p.id)) return null;
  return p;
}

const seatOf = async (tenantId, projectId, userId) => (await get(
  'SELECT seat FROM project_members WHERE tenant_id = ? AND project_id = ? AND user_id = ? AND deleted_at IS NULL',
  [tenantId, projectId, userId],
))?.seat ?? null;
const isProjectOwner = async (tenantId, projectId, userId) => !!await get(
  'SELECT 1 AS y FROM project_owners WHERE tenant_id = ? AND project_id = ? AND user_id = ?', [tenantId, projectId, userId],
);
const isWorkspaceOwner = (auth) => ['owner', 'super_admin'].includes(auth.role);

/** Working a lead - add, edit, log, update, move status: anyone on the project, its owners, or the assignee. */
export async function canWorkLead(auth, projectId, lead = null) {
  if (isWorkspaceOwner(auth)) return true;
  if (lead && lead.assigned_to === auth.userId) return true;
  return !!await seatOf(auth.tenantId, projectId, auth.userId) || await isProjectOwner(auth.tenantId, projectId, auth.userId);
}

/** ⭐ on/off, priority, dead, revive, delete: the project manager and team lead (and the workspace Owner). */
export async function canSteerLead(auth, projectId) {
  if (isWorkspaceOwner(auth)) return true;
  return ['manager', 'lead'].includes(await seatOf(auth.tenantId, projectId, auth.userId));
}

// ------------------------------------------------------------- timeline
export async function logActivity(tenantId, lead, userId, eventType, description, meta = {}, at = nowIso()) {
  await run(
    `INSERT INTO lead_activities (id, tenant_id, lead_id, project_id, user_id, event_type, description, meta, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, lead.id, lead.project_id, userId ?? null, eventType, description ?? null, JSON.stringify(meta), at],
  );
}

/** Touch the lead's clock - anything a person did with it counts as activity. */
export async function touch(leadId, at = nowIso()) {
  await run('UPDATE leads SET last_activity_at = ?, updated_at = ? WHERE id = ?', [at, at, leadId]);
}

export async function historyEntry(tenantId, leadId, action, { reason = null, priority = null, by = null } = {}) {
  await run(
    `INSERT INTO progressive_lead_history (id, tenant_id, lead_id, action, reason, priority, changed_by, changed_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, leadId, action, reason, priority, by, nowIso()],
  );
}

/** Statuses only move forward on their own - an update never drags a lead backwards. */
export const isForward = (from, to) => to && STATUS_RANK[to] != null && (STATUS_RANK[from] ?? -1) < STATUS_RANK[to];

// ------------------------------------------------------------ duplicates
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9@.+]/g, '');
const digits = (s) => String(s || '').replace(/\D/g, '').slice(-10);

/**
 * An existing live lead in the workspace that looks like the same company and
 * contact - same company name and the same phone or email, or the same email
 * on its own. Dead leads are included: re-entering a dead lead is a revival,
 * not a new lead.
 */
export async function findDuplicate(tenantId, { company_name: company, phone, email }, exceptId = null) {
  const rows = await all(
    `SELECT l.id, l.company_name, l.phone, l.email, l.status, l.project_id, p.name AS project_name
       FROM leads l JOIN projects p ON p.id = l.project_id
      WHERE l.tenant_id = ? AND l.deleted_at IS NULL ${exceptId ? 'AND l.id != ?' : ''}`,
    exceptId ? [tenantId, exceptId] : [tenantId],
  );
  const c = norm(company);
  const ph = digits(phone);
  const em = norm(email);
  return rows.find((r) => (em && norm(r.email) === em)
    || (c && norm(r.company_name) === c && ((ph && digits(r.phone) === ph) || (!ph && !em && !r.phone && !r.email)))) || null;
}

/** RFC-4180-ish CSV: quoted fields, embedded commas and quotes, CRLF. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const s = String(text || '').replace(/^﻿/, '');
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i += 1; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((v) => v.trim())) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((v) => v.trim())) rows.push(row);
  return rows;
}

// ------------------------------------------------------------- notifying
/** The people steering a project: its manager and lead seats. */
export const steerersOf = async (tenantId, projectId) => (await all(
  `SELECT user_id FROM project_members WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL
      AND seat IN ('manager','lead')`,
  [tenantId, projectId],
)).map((r) => r.user_id);
export const ownersOf = async (tenantId, projectId) => (await all(
  'SELECT user_id FROM project_owners WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId],
)).map((r) => r.user_id);

export function tell({ tenantId, userIds, except = null, eventKey, vars, lead, dedupeKey }) {
  const ids = [...new Set(userIds.filter((u) => u && u !== except))];
  if (!ids.length) return Promise.resolve([]);
  return notifyMany({
    tenantId, userIds: ids, eventKey, vars, channels: ['in_app'], dedupeKey,
    link: `/marketing/${lead.project_id}?lead=${lead.id}`,
  }).catch(() => []);
}

// ------------------------------------------------------------- the numbers
const ACTIVITY_COUNTS_SQL = `
  SELECT event_type, meta FROM lead_activities
   WHERE tenant_id = ? AND project_id = ? AND created_at >= ? AND created_at < ?`;

/** Lead activity in [fromIso, toIso): what the dashboard and reports count. */
export async function activityCounts(tenantId, projectId, fromIso, toIso) {
  const rows = await all(ACTIVITY_COUNTS_SQL, [tenantId, projectId, fromIso, toIso]);
  const c = {
    new_leads: 0, follow_ups: 0, responses: 0, contacted: 0, interested: 0, qualified: 0, progressive_added: 0,
    proposals: 0, negotiations: 0, meetings: 0, won: 0, dead: 0,
  };
  for (const r of rows) {
    const m = parse(r.meta, {});
    switch (r.event_type) {
      case 'lead_created': c.new_leads += 1; break;
      case 'call': case 'email': case 'whatsapp': c.follow_ups += 1; break;
      case 'meeting': c.follow_ups += 1; c.meetings += 1; break;
      case 'daily_update':
        c.follow_ups += 1;
        if (RESPONSE_OUTCOMES.includes(m.outcome)) c.responses += 1;
        if (m.outcome === 'meeting_done') c.meetings += 1;
        break;
      case 'status_changed':
        if (m.to === 'contacted') c.contacted += 1;
        if (m.to === 'interested') c.interested += 1;
        if (m.to === 'qualified') c.qualified += 1;
        if (m.to === 'proposal') c.proposals += 1;
        if (m.to === 'negotiation') c.negotiations += 1;
        if (m.to === 'won') c.won += 1;
        break;
      case 'progressive_enabled': c.progressive_added += 1; break;
      case 'marked_dead': c.dead += 1; break;
      default: break;
    }
  }
  return c;
}

/** Local midnight of `day` in `tz`, as a UTC instant - for "today" in the workspace's own clock. */
function localDayStartIso(day, tz) {
  // Walk from UTC midnight to the instant whose local date is `day` and local time 00:00.
  const guess = Date.parse(`${day}T00:00:00Z`);
  for (let h = -14; h <= 14; h += 0.5) {
    const t = new Date(guess + h * 3_600_000);
    if (todayInTz(tz, t) === day && timeInTz(tz, t) === '00:00') return t.toISOString();
  }
  return new Date(guess).toISOString();
}
export const dayWindow = (day, tz) => [localDayStartIso(day, tz), localDayStartIso(addDay(day), tz)];

export function decorateLeads(rows, ctx) {
  return rows.map((l) => ({
    ...l,
    is_progressive: !!l.is_progressive,
    owner_action_required: !!l.owner_action_required,
    progressive_reasons: parse(l.progressive_reasons, []),
    health: healthOf(l, ctx),
  }));
}

export const LEAD_SELECT = `
  SELECT l.*, u.name AS assigned_name, u.avatar_url AS assigned_avatar, p.name AS project_name
    FROM leads l
    LEFT JOIN users u ON u.id = l.assigned_to
    JOIN projects p ON p.id = l.project_id`;

/** The project's marketing dashboard. */
export async function overviewFor(tenantId, project) {
  const ctx = await healthContext(tenantId);
  const leads = decorateLeads(await all(`${LEAD_SELECT} WHERE l.tenant_id = ? AND l.project_id = ? AND l.deleted_at IS NULL`,
    [tenantId, project.id]), ctx);
  const byStatus = Object.fromEntries([...STATUSES.map((s) => [s.id, 0]), ['dead', 0]]);
  for (const l of leads) byStatus[l.status] = (byStatus[l.status] || 0) + 1;
  const stars = leads.filter((l) => l.is_progressive && OPEN_STATUSES.includes(l.status));
  const starHealth = { stalled: 0, needs_followup: 0, waiting: 0, moving: 0 };
  for (const l of stars) if (l.health) starHealth[l.health.id] += 1;
  const [from, to] = dayWindow(ctx.today, ctx.tz);
  const open = leads.filter((l) => OPEN_STATUSES.includes(l.status));

  return {
    project: { id: project.id, name: project.name, scope_total: project.scope_total, scope_delivered: project.scope_delivered },
    today: ctx.today,
    totals: {
      total: leads.length,
      open: open.length,
      progressive: stars.length,
      // "Contacted" in the funnel sense: everyone who got past New.
      reached: leads.filter((l) => l.status !== 'new').length,
      pipeline_value_minor: open.reduce((n, l) => n + (l.expected_value_minor || 0), 0),
      followups_due_today: open.filter((l) => l.next_followup_date && l.next_followup_date <= ctx.today).length,
      owner_actions_open: open.filter((l) => l.owner_action_required).length,
    },
    by_status: byStatus,
    progressive_health: starHealth,
    progressive_by_priority: {
      critical: stars.filter((l) => l.progressive_priority === 'critical').length,
      high: stars.filter((l) => l.progressive_priority === 'high').length,
      normal: stars.filter((l) => l.progressive_priority === 'normal').length,
    },
    today_counts: await activityCounts(tenantId, project.id, from, to),
    campaign_progress_pct: project.scope_total ? Math.round((project.scope_delivered / project.scope_total) * 100) : null,
    team: await teamTable(tenantId, project.id, leads, null, null),
  };
}

/** Per-member performance on a project, over a window (or all time when from is null). */
export async function teamTable(tenantId, projectId, leads, fromIso, toIso) {
  const members = await all(
    `SELECT u.id, u.name FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.tenant_id = ? AND pm.project_id = ? AND pm.deleted_at IS NULL ORDER BY u.name`,
    [tenantId, projectId],
  );
  const acts = await all(
    `SELECT user_id, event_type, meta FROM lead_activities WHERE tenant_id = ? AND project_id = ?
       ${fromIso ? 'AND created_at >= ? AND created_at < ?' : ''}`,
    fromIso ? [tenantId, projectId, fromIso, toIso] : [tenantId, projectId],
  );
  return members.map((m) => {
    const mine = acts.filter((a) => a.user_id === m.id);
    const metas = mine.map((a) => ({ t: a.event_type, m: parse(a.meta, {}) }));
    return {
      user_id: m.id,
      name: m.name,
      assigned: leads.filter((l) => l.assigned_to === m.id && l.status !== 'dead').length,
      progressive: leads.filter((l) => l.assigned_to === m.id && l.is_progressive && OPEN_STATUSES.includes(l.status)).length,
      touches: metas.filter((x) => ['call', 'email', 'whatsapp', 'meeting', 'daily_update'].includes(x.t)).length,
      responses: metas.filter((x) => x.t === 'daily_update' && RESPONSE_OUTCOMES.includes(x.m.outcome)).length,
      meetings: metas.filter((x) => x.t === 'meeting' || (x.t === 'daily_update' && x.m.outcome === 'meeting_done')).length,
      proposals: metas.filter((x) => x.t === 'status_changed' && x.m.to === 'proposal').length,
      won: metas.filter((x) => x.t === 'status_changed' && x.m.to === 'won').length,
    };
  });
}

// ---------------------------------------------------------------- reports
const fmtDate = (iso) => (iso ? String(iso).slice(0, 10) : '—');

async function persistReport(tenantId, project, kind, title, periodStart, periodEnd, payload) {
  const id = uuid();
  await run(
    `INSERT INTO report_runs (id, tenant_id, kind, title, project_id, period_start, period_end, status, payload,
       generated_at, created_at) VALUES (?,?,?,?,?,?,?, 'generated', ?,?,?)`,
    [id, tenantId, kind, title, project.id, periodStart, periodEnd, JSON.stringify(payload), nowIso(), nowIso()],
  );
  return await get('SELECT * FROM report_runs WHERE id = ?', [id]);
}

const starRows = (leads) => leads.map((l) => ({
  lead: `⭐ ${l.company_name}`,
  status: statusLabel(l.status),
  priority: l.progressive_priority || '—',
  health: l.health?.label || '—',
  last_activity: fmtDate(l.last_activity_at),
  next_action: l.next_action || 'Not recorded',
  assignee: l.assigned_name || 'Unassigned',
}));
const STAR_COLUMNS = [
  { key: 'lead', label: 'Lead', strong: true }, { key: 'status', label: 'Status' }, { key: 'priority', label: 'Priority' },
  { key: 'health', label: 'Health' }, { key: 'last_activity', label: 'Last activity' },
  { key: 'next_action', label: 'Next action' }, { key: 'assignee', label: 'Owner' },
];

export async function generateDailyReport(tenantId, project, day = null) {
  const ctx = await healthContext(tenantId);
  const d = day || ctx.today;
  const [from, to] = dayWindow(d, ctx.tz);
  const c = await activityCounts(tenantId, project.id, from, to);
  const leads = decorateLeads(await all(`${LEAD_SELECT} WHERE l.tenant_id = ? AND l.project_id = ? AND l.deleted_at IS NULL`,
    [tenantId, project.id]), ctx);
  const stars = leads.filter((l) => l.is_progressive && OPEN_STATUSES.includes(l.status))
    .sort((a, b) => (a.health?.rank ?? 0) - (b.health?.rank ?? 0));
  const stalled = stars.filter((l) => l.health?.id === 'stalled');
  const noNext = stars.filter((l) => !l.next_action);
  const actions = leads.filter((l) => l.owner_action_required && OPEN_STATUSES.includes(l.status));

  const attention = [
    stalled.length && `${stalled.length} ⭐ lead(s) stalled with no activity for ${ctx.settings.stalled_days}+ working days.`,
    noNext.length && `${noNext.length} ⭐ lead(s) have no scheduled next action.`,
    actions.length && `${actions.length} lead(s) are waiting on an owner decision.`,
  ].filter(Boolean);

  return await persistReport(tenantId, project, 'marketing_daily', `Marketing daily update · ${project.name}`, d, d, {
    project: project.name,
    sections: [
      {
        heading: 'Lead activity today',
        stats: [
          { label: 'New leads', value: c.new_leads }, { label: 'Follow-ups', value: c.follow_ups },
          { label: 'Responses', value: c.responses }, { label: 'Interested', value: c.interested },
          { label: '⭐ Progressive added', value: c.progressive_added }, { label: 'Proposals', value: c.proposals },
          { label: 'Meetings', value: c.meetings }, { label: 'Won', value: c.won }, { label: 'Marked dead', value: c.dead },
        ],
      },
      {
        heading: `⭐ Progressive leads (${stars.length})`,
        text: stars.length ? null : 'No ⭐ progressive leads on this project.',
        columns: STAR_COLUMNS,
        rows: starRows(stars),
      },
      {
        heading: 'Management attention',
        text: attention.length ? attention.join(' ') : 'Nothing needs management attention today.',
        columns: actions.length ? [
          { key: 'lead', label: 'Lead', strong: true }, { key: 'action', label: 'Owner action' },
          { key: 'due', label: 'Due' }, { key: 'priority', label: 'Priority' },
        ] : [],
        rows: actions.map((l) => ({ lead: l.company_name, action: l.owner_action_text, due: l.owner_action_due || '—', priority: l.owner_action_priority || 'normal' })),
      },
    ],
  });
}

export async function generateWeeklyReport(tenantId, project, endDay = null) {
  const ctx = await healthContext(tenantId);
  // The seven days ending yesterday - the week just finished.
  const end = endDay || addDay(ctx.today, -1);
  const start = addDay(end, -6);
  const [from] = dayWindow(start, ctx.tz);
  const [, to] = dayWindow(end, ctx.tz);
  const c = await activityCounts(tenantId, project.id, from, to);
  const leads = decorateLeads(await all(`${LEAD_SELECT} WHERE l.tenant_id = ? AND l.project_id = ? AND l.deleted_at IS NULL`,
    [tenantId, project.id]), ctx);
  const startingLeads = leads.filter((l) => l.created_at < from).length;
  const hist = await all(
    `SELECT h.action FROM progressive_lead_history h JOIN leads l ON l.id = h.lead_id
      WHERE h.tenant_id = ? AND l.project_id = ? AND h.changed_at >= ? AND h.changed_at < ?`,
    [tenantId, project.id, from, to],
  );
  const stars = leads.filter((l) => l.is_progressive && OPEN_STATUSES.includes(l.status));

  // Average gap between consecutive touches on ⭐ leads, in hours.
  const touches = await all(
    `SELECT a.lead_id, a.created_at FROM lead_activities a JOIN leads l ON l.id = a.lead_id
      WHERE a.tenant_id = ? AND a.project_id = ? AND l.is_progressive = 1
        AND a.event_type IN ('call','email','whatsapp','meeting','daily_update') AND a.created_at >= ? AND a.created_at < ?
      ORDER BY a.lead_id, a.created_at`,
    [tenantId, project.id, from, to],
  );
  const gaps = [];
  for (let i = 1; i < touches.length; i += 1) {
    if (touches[i].lead_id === touches[i - 1].lead_id) gaps.push((Date.parse(touches[i].created_at) - Date.parse(touches[i - 1].created_at)) / 3_600_000);
  }
  const avgGap = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;

  const team = await teamTable(tenantId, project.id, leads, from, to);
  return await persistReport(tenantId, project, 'marketing_weekly', `Weekly marketing report · ${project.name}`, start, end, {
    project: project.name,
    sections: [
      {
        heading: 'Lead metrics',
        stats: [
          { label: 'Starting leads', value: startingLeads }, { label: 'New leads', value: c.new_leads },
          { label: 'Contacted', value: c.contacted }, { label: 'Responses', value: c.responses },
          { label: 'Interested', value: c.interested }, { label: '⭐ Progressive (now)', value: stars.length },
          { label: 'Qualified', value: c.qualified }, { label: 'Proposals', value: c.proposals },
          { label: 'Negotiations', value: c.negotiations }, { label: 'Won', value: c.won }, { label: 'Dead', value: c.dead },
        ],
      },
      {
        heading: '⭐ Progressive lead metrics',
        stats: [
          { label: 'Created', value: hist.filter((h) => h.action === 'enabled').length },
          { label: 'Active now', value: stars.length },
          { label: 'Converted', value: hist.filter((h) => h.action === 'converted').length },
          { label: 'Dead', value: hist.filter((h) => h.action === 'dead').length },
          { label: 'Stalled now', value: stars.filter((l) => l.health?.id === 'stalled').length },
          { label: 'Avg hours between follow-ups', value: avgGap ?? '—' },
        ],
      },
      {
        heading: 'Team performance',
        columns: [
          { key: 'name', label: 'Member', strong: true }, { key: 'assigned', label: 'Leads assigned', align: 'right' },
          { key: 'touches', label: 'Follow-ups', align: 'right' }, { key: 'responses', label: 'Responses', align: 'right' },
          { key: 'progressive', label: '⭐ leads', align: 'right' }, { key: 'meetings', label: 'Meetings', align: 'right' },
          { key: 'proposals', label: 'Proposals', align: 'right' }, { key: 'won', label: 'Conversions', align: 'right' },
        ],
        rows: team,
      },
    ],
  });
}

// ------------------------------------------------------------- the watch
/**
 * The daily look at every open ⭐ lead. Each rung of the ladder notifies once
 * per lead per day; the top rung also raises an escalation to the project's
 * owner. Filing an update or logging any activity resets the clock.
 */
export async function watchProgressive(tenantId) {
  const ctx = await healthContext(tenantId);
  const s = ctx.settings;
  const leads = decorateLeads(await all(
    `${LEAD_SELECT} WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND l.is_progressive = 1
       AND l.status IN (${OPEN_STATUSES.map(() => '?').join(',')}) AND p.deleted_at IS NULL`,
    [tenantId, ...OPEN_STATUSES],
  ), ctx);
  let sent = 0;
  for (const l of leads) {
    const d = l.health?.inactive_days ?? 0;
    const vars = { lead: l.company_name, project: l.project_name, days: d, assignee: l.assigned_name || 'Unassigned', next_action: l.next_action || 'not recorded' };
    const key = (rung) => `mkt:${rung}:${l.id}:${ctx.today}`;
    if (d >= s.escalate_after_days) {
      const owners = await ownersOf(tenantId, l.project_id);
      await tell({ tenantId, userIds: [l.assigned_to, ...await steerersOf(tenantId, l.project_id), ...owners], eventKey: 'marketing.progressive_escalated', vars, lead: l, dedupeKey: key('escalated') });
      await raiseEscalation({
        tenantId, sourceType: 'lead', sourceId: l.id, title: `⭐ ${l.company_name}`, fromUserId: l.assigned_to,
        toUserId: owners[0], reason: `⭐ lead inactive for ${d} working days`, link: `/marketing/${l.project_id}?lead=${l.id}`, slaHours: 48,
      }).catch(() => null);
      sent += 1;
    } else if (d >= s.stalled_days) {
      await tell({ tenantId, userIds: [l.assigned_to, ...await steerersOf(tenantId, l.project_id)], eventKey: 'marketing.progressive_stalled', vars, lead: l, dedupeKey: key('stalled') });
      sent += 1;
    } else if (d >= s.warn_after_days) {
      await tell({ tenantId, userIds: [l.assigned_to], eventKey: 'marketing.progressive_inactive', vars, lead: l, dedupeKey: key('inactive') });
      sent += 1;
    } else if (d >= s.remind_after_days || (l.next_followup_date && l.next_followup_date <= ctx.today)) {
      await tell({ tenantId, userIds: [l.assigned_to], eventKey: 'marketing.followup_pending', vars: { ...vars, due: l.next_followup_date || 'not set' }, lead: l, dedupeKey: key('pending') });
      sent += 1;
    }
  }
  return sent;
}

/** 6:30 PM: assignees with a ⭐ lead and no update on it today. */
export async function remindMissingUpdates(tenantId) {
  const ctx = await healthContext(tenantId);
  const rows = await all(
    `SELECT l.assigned_to AS user_id, COUNT(*) AS n, STRING_AGG(l.company_name, ', ') AS names, MIN(l.project_id) AS project_id, MIN(l.id) AS id
       FROM leads l JOIN projects p ON p.id = l.project_id AND p.deleted_at IS NULL
      WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND l.is_progressive = 1 AND l.assigned_to IS NOT NULL
        AND l.status IN (${OPEN_STATUSES.map(() => '?').join(',')})
        AND NOT EXISTS (SELECT 1 FROM lead_updates u WHERE u.lead_id = l.id AND u.user_id = l.assigned_to
                          AND u.update_date = ? AND u.deleted_at IS NULL)
      GROUP BY l.assigned_to`,
    [tenantId, ...OPEN_STATUSES, ctx.today],
  );
  for (const r of rows) {
    await tell({ tenantId, userIds: [r.user_id], eventKey: 'marketing.update_missing', vars: { count: Number(r.n), leads: r.names }, lead: { id: r.id, project_id: r.project_id }, dedupeKey: `mkt:update_missing:${ctx.today}` });
  }
  return rows.length;
}

const ranToday = new Map();
/**
 * Runs every 15 minutes. Each workspace's own clock decides what is due: the
 * ⭐ watch, the 6:30 PM update reminder, the daily report and the weekly one,
 * each at the time set in Settings → Marketing. Reports are deduplicated on
 * the report table itself, so a restart never sends one twice.
 */
export async function marketingTick(tenantIds) {
  let n = 0;
  for (const tenantId of tenantIds) {
    const projects = await all("SELECT * FROM projects WHERE tenant_id = ? AND kind = 'marketing' AND deleted_at IS NULL AND status = 'active'", [tenantId]);
    if (!projects.length) continue;
    const ctx = await healthContext(tenantId);
    const s = ctx.settings;
    const now = timeInTz(ctx.tz);
    const working = !ctx.offs.includes(weekday(ctx.today));
    const once = async (what, fn) => {
      const k = `${tenantId}:${what}:${ctx.today}`;
      if (ranToday.get(k)) return;
      ranToday.set(k, true);
      n += Number(await fn()) || 0;
    };
    if (working && now >= s.watch_time) await once('watch', () => watchProgressive(tenantId));
    if (working && now >= s.update_reminder_time) await once('remind', () => remindMissingUpdates(tenantId));
    for (const p of projects) {
      if (working && now >= s.daily_report_time
        && !await get("SELECT id FROM report_runs WHERE tenant_id = ? AND project_id = ? AND kind = 'marketing_daily' AND period_start = ?", [tenantId, p.id, ctx.today])) {
        await notifyReport(tenantId, p, await generateDailyReport(tenantId, p));
        n += 1;
      }
      const weekEnd = addDay(ctx.today, -1);
      if (weekday(ctx.today) === s.weekly_report_day && now >= s.weekly_report_time
        && !await get("SELECT id FROM report_runs WHERE tenant_id = ? AND project_id = ? AND kind = 'marketing_weekly' AND period_end = ?", [tenantId, p.id, weekEnd])) {
        await notifyReport(tenantId, p, await generateWeeklyReport(tenantId, p, weekEnd));
        n += 1;
      }
    }
  }
  return n;
}

async function notifyReport(tenantId, project, report) {
  return notifyMany({
    tenantId,
    userIds: [...await ownersOf(tenantId, project.id), ...await steerersOf(tenantId, project.id)],
    eventKey: 'report.ready',
    vars: { title: report.title, period: report.period_start === report.period_end ? report.period_start : `${report.period_start} – ${report.period_end}` },
    link: `/reports/${report.id}`,
    channels: ['in_app'],
    dedupeKey: `mkt_report:${report.id}`,
  }).catch(() => []);
}

export { addDay };
