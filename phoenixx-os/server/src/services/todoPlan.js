import { everySeq, filterSeq, forEachSeq } from '../lib/util.js';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso, parseJson } from '../lib/util.js';
import { badRequest, forbidden, notFound, unprocessable } from '../lib/http.js';
import { DEFAULT_TZ, todayInTz, timeInTz, localToUtc, formatDueTime, dueAtIso } from '../lib/dueTime.js';
import { notify, channelsFor } from './notifications.js';
import { syncDeadline } from '../routes/actionItems.routes.js';
import { can } from '../middleware/rbac.js';
import { visibleProjectIds } from './projectOversight.js';

/**
 * Advance Planner - the plan each person files for their next working day.
 *
 * This file owns both halves of the module. The clock: the workspace schedule
 * (open -> reminder -> deadline -> escalation), the working-day calendar the
 * schedule runs on, and the notifications each rung sends. Every time is
 * workspace-local wall clock read through the tenant's timezone, never the
 * server's and never the browser's. The plan: saving, submitting and the
 * reporting person's review, with every permission checked here rather than
 * trusted from the client.
 *
 * The reporting person is `users.manager_id`, which only the owner edits.
 * Someone with no manager reports to the workspace owners.
 */

// ---------------------------------------------------------------- statuses
export const STATUSES = [
  'DRAFT', 'SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'LATE', 'OVERDUE', 'MISSED',
];
/** A plan in any of these has reached the reporting person, so no more nudges. */
export const FILED = ['SUBMITTED', 'UNDER_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'LATE'];

/** Notification event keys, one per rung and review outcome. */
export const EVENTS = {
  open: 'todo.submission_open',
  reminder: 'todo.reminder',
  overdue: 'todo.overdue',
  escalation: 'todo.escalation',
  submitted: 'todo.submitted',
  approved: 'todo.approved',
  changes: 'todo.changes_requested',
  comment: 'todo.comment',
  task_added: 'todo.task_added',
  carried_over: 'todo.carried_over',
  converted: 'todo.converted',
};

const PLAN_LINK = '/';
const planLink = (id) => `/?plan=${id}`;

// ---------------------------------------------------------------- settings
export const CHANNEL_OPTIONS = ['in_app', 'email', 'whatsapp'];

export const DEFAULT_SETTINGS = {
  /** Off until an owner switches it on, so a new workspace is not nudged before anyone can file. */
  enabled: false,
  /** Workspace-local HH:MM; each must come after the one before. */
  open_time: '17:30',
  reminder_time: '17:50',
  deadline_time: '18:00',
  escalation_time: '18:15',
  /** Weekday numbers, 0 = Sunday. NULL follows the workspace week-off days. */
  working_days: null,
  allow_late: true,
  notify_employees: true,
  notify_managers: true,
  escalate_to_owner: false,
  /** In-app always goes; these are the extra channels, still subject to each person's preferences. */
  channels: ['in_app', 'email'],
  /** Managers may take unassigned people (or the owner's direct reports) into their own team. Only the owner moves anyone off a team. */
  managers_can_assign: false,
  /** People the owner has let see every plan in the workspace. View only: reviewing stays with the reporting person. */
  full_view_user_ids: [],
};

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

async function workspaceWorkingDays(tenantId) {
  const offs = parseJson((await get('SELECT week_off_days FROM tenants WHERE id = ?', [tenantId]))?.week_off_days, [0]);
  return [0, 1, 2, 3, 4, 5, 6].filter((d) => !(Array.isArray(offs) ? offs : [0]).includes(d));
}

export async function settingsFor(tenantId) {
  const saved = parseJson((await get('SELECT todo_settings FROM tenants WHERE id = ?', [tenantId]))?.todo_settings, {}) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  return { ...s, working_days: s.working_days ?? await workspaceWorkingDays(tenantId) };
}

export async function saveSettings(tenantId, body) {
  const s = { ...await settingsFor(tenantId), ...body };
  const times = ['open_time', 'reminder_time', 'deadline_time', 'escalation_time'];
  for (const k of times) {
    if (!HHMM.test(String(s[k]))) throw badRequest(`${k.replace(/_/g, ' ')} must be HH:MM`);
  }
  if (!(s.open_time < s.reminder_time && s.reminder_time < s.deadline_time && s.deadline_time < s.escalation_time)) {
    throw badRequest('The schedule must run in order: open < reminder < deadline < escalation');
  }
  const days = Array.isArray(s.working_days) ? [...new Set(s.working_days)] : null;
  if (!days?.length || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    throw badRequest('Pick at least one working day (0 = Sunday ... 6 = Saturday)');
  }
  const channels = Array.isArray(s.channels) ? [...new Set(['in_app', ...s.channels])] : null;
  if (!channels || channels.some((c) => !CHANNEL_OPTIONS.includes(c))) {
    throw badRequest(`channels must be drawn from ${CHANNEL_OPTIONS.join(', ')}`);
  }
  for (const k of ['enabled', 'allow_late', 'notify_employees', 'notify_managers', 'escalate_to_owner', 'managers_can_assign']) {
    if (typeof s[k] !== 'boolean') throw badRequest(`${k.replace(/_/g, ' ')} must be true or false`);
  }
  // Any staff member can be granted it; owners already see everything.
  const isStaff = async (id) => typeof id === 'string'
    && !!await get(`SELECT id FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL
                AND role NOT IN ('owner','client','super_admin')`, [id, tenantId]);
  if (body.full_view_user_ids !== undefined
    && (!Array.isArray(body.full_view_user_ids) || !(await everySeq(body.full_view_user_ids, isStaff)))) {
    throw badRequest('Only people in this workspace can be given a view of everyone');
  }
  // A grant saved earlier for someone who has since left is dropped, not an error.
  const viewers = await filterSeq([...new Set(Array.isArray(s.full_view_user_ids) ? s.full_view_user_ids : [])], isStaff);
  const clean = Object.fromEntries(Object.keys(DEFAULT_SETTINGS).map((k) => [k, s[k]]));
  clean.working_days = days.sort();
  clean.channels = channels;
  clean.full_view_user_ids = viewers;
  await run('UPDATE tenants SET todo_settings = ?, updated_at = ? WHERE id = ?', [JSON.stringify(clean), nowIso(), tenantId]);
  return clean;
}

// ---------------------------------------------------------------- calendar
const tzOf = async (tenantId) => (await get('SELECT timezone FROM tenants WHERE id = ?', [tenantId]))?.timezone || DEFAULT_TZ;
const addDay = (d, n = 1) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
/** '2026-10-07' -> 'Wed, 7 Oct', for notification copy. */
export const dayLabel = (d) => (d
  ? new Intl.DateTimeFormat('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${d}T12:00:00Z`))
  : '');

/** Restricted holidays are optional for the person, so they do not stop the plan. */
const isHoliday = async (tenantId, day) => !!await get(
  "SELECT id FROM holidays WHERE tenant_id = ? AND holiday_date = ? AND kind = 'company_holiday' AND deleted_at IS NULL",
  [tenantId, day],
);

export async function isWorkingDay(tenantId, day, settings) {
  settings ??= await settingsFor(tenantId);
  return settings.working_days.includes(weekday(day)) && !await isHoliday(tenantId, day);
}

/** The day a plan filed on `day` is for: Friday's plan is Monday's when the weekend is off. */
export async function nextWorkingDay(tenantId, day, settings) {
  settings ??= await settingsFor(tenantId);
  let d = addDay(day);
  for (let i = 0; i < 60; i++, d = addDay(d)) if (await isWorkingDay(tenantId, d, settings)) return d;
  return null;
}

/** Where today sits in the schedule, on the workspace clock. */
export async function windowFor(tenantId, now = new Date()) {
  const settings = await settingsFor(tenantId);
  const tz = await tzOf(tenantId);
  const today = todayInTz(tz, now);
  const time = timeInTz(tz, now);
  const working = settings.enabled && await isWorkingDay(tenantId, today, settings);
  const target = working ? await nextWorkingDay(tenantId, today, settings) : null;
  let phase = 'closed';
  if (working) {
    if (time >= settings.deadline_time) phase = 'past_deadline';
    else if (time >= settings.open_time) phase = 'open';
    else phase = 'not_open';
  }
  return {
    tz,
    today,
    time,
    working,
    todo_date: target,
    phase,
    deadline_at: working ? localToUtc(today, settings.deadline_time, tz).toISOString() : null,
    settings,
  };
}

// ---------------------------------------------------------------- people
/** Everyone expected to file a plan: active staff other than the owners themselves. */
/**
 * Logins that do not file a plan: the owner, and the HR and Finance management
 * logins. They can still be given a view of everyone's plans.
 */
export const NON_PLANNERS = ['owner', 'client', 'super_admin', 'hr', 'finance'];
export const filesPlans = (role) => !NON_PLANNERS.includes(role);

export const plannersOf = async (tenantId) => await all(
  `SELECT * FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
      AND role NOT IN (${NON_PLANNERS.map((r) => `'${r}'`).join(',')})`,
  [tenantId],
);

const ownerIds = async (tenantId) => (await all(
  "SELECT id FROM users WHERE tenant_id = ? AND role = 'owner' AND deleted_at IS NULL AND status = 'active'",
  [tenantId],
)).map((u) => u.id);

/** Read at the moment of use, so an owner's reassignment applies from the next plan on. */
export async function reportingPersonIds(tenantId, user) {
  if (user.manager_id) {
    const m = await get(
      "SELECT id FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND status = 'active'",
      [user.manager_id, tenantId],
    );
    if (m) return [m.id];
  }
  return await ownerIds(tenantId);
}

/** Planners who have not filed for `todoDate` yet. */
async function pendingFor(tenantId, todoDate) {
  const filed = new Set((await all(
    `SELECT user_id FROM todo_submissions WHERE tenant_id = ? AND todo_date = ?
        AND status IN (${FILED.map(() => '?').join(',')})`,
    [tenantId, todoDate, ...FILED],
  )).map((r) => r.user_id));
  return (await plannersOf(tenantId)).filter((u) => !filed.has(u.id));
}

// ---------------------------------------------------------------- sending
/**
 * In-app always; email/WhatsApp only when the workspace has switched them on
 * for To-Do AND the person has not muted them. Returns whether anything new
 * went out, so a re-run of a rung that already fired reports nothing.
 */
async function tell(tenantId, user, eventKey, vars, dedupeKey, settings, link = PLAN_LINK) {
  const channels = channelsFor(user, eventKey).filter((c) => settings.channels.includes(c));
  if (!channels.includes('in_app')) channels.unshift('in_app');
  const out = await notify({ tenantId, user, eventKey, vars, link, channels, dedupeKey });
  return out.length > 0;
}

async function systemAudit(tenantId, entity, entityId, action, after) {
  await run(
    `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_name, entity, entity_id, action, before_json, after_json, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, null, 'System', entity, entityId, action, null, JSON.stringify(after), null, nowIso()],
  );
}

/** One row per planner per target day; created by the clock when it has to record OVERDUE. */
async function markOverdue(tenantId, user, win) {
  const row = await get('SELECT id, status FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?',
    [tenantId, user.id, win.todo_date]);
  if (row) {
    if (row.status === 'DRAFT') {
      await run("UPDATE todo_submissions SET status = 'OVERDUE', updated_at = ? WHERE id = ?", [nowIso(), row.id]);
    }
    return;
  }
  await run(
    `INSERT INTO todo_submissions (id, tenant_id, user_id, reporting_person_id, todo_date, plan_date, status,
       deadline_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?, 'OVERDUE', ?,?,?)`,
    [uuid(), tenantId, user.id, (await reportingPersonIds(tenantId, user))[0] ?? null, win.todo_date, win.today,
      win.deadline_at, nowIso(), nowIso()],
  );
}

// ---------------------------------------------------------------- the clock
/**
 * Runs every minute. Each rung fires once per target day - the dedupe key on
 * the notification row guarantees that across restarts - and only to people
 * who have not filed yet. A server that comes up after the deadline skips the
 * open and reminder messages rather than sending stale ones.
 */
export async function todoTick(tenantIds, now = new Date()) {
  let n = 0;
  for (const tenantId of tenantIds) {
    const win = await windowFor(tenantId, now);
    const s = win.settings;

    // The day a plan was for has arrived: anything still unfiled is missed.
    const missed = await run(
      `UPDATE todo_submissions SET status = 'MISSED', updated_at = ?
        WHERE tenant_id = ? AND status IN ('DRAFT','OVERDUE') AND todo_date <= ?`,
      [nowIso(), tenantId, win.today],
    );
    n += Number(missed.changes || 0);

    // Yesterday is over: what was not finished moves to the next working day.
    if (s.enabled) n += await carryOver(tenantId, win.today, s);

    // Approved work belongs in Action Items: catches plans approved before
    // approval converted them, and tasks added to an approved plan since.
    n += await convertApproved(tenantId, win.today);

    if (!win.working || !win.todo_date) continue;
    const t = win.time;
    if (t < s.open_time) continue;

    const target = win.todo_date;
    const pending = await pendingFor(tenantId, target);
    const deadline = formatDueTime(s.deadline_time);
    const base = { todo_date: target, todo_day: dayLabel(target), deadline, late_note: s.allow_late ? ' Late plans are still accepted but marked late.' : ' Late plans are not accepted.' };

    const rung = async (stage, eventKey, users, varsFor = () => base, dedupe = () => `todo_${stage}:${target}`) => {
      const reached = [];
      for (const u of users) {
        if (await tell(tenantId, u.recipient || u, eventKey, varsFor(u), dedupe(u), s)) reached.push(u.id);
      }
      if (reached.length) await systemAudit(tenantId, 'todo_schedule', `${tenantId}:${target}`, `${stage}_sent`, { todo_date: target, users: reached });
      n += reached.length;
    };

    if (t < s.deadline_time) {
      if (!await get("SELECT id FROM audit_logs WHERE tenant_id = ? AND entity = 'todo_schedule' AND entity_id = ? AND action = 'opened'",
        [tenantId, `${tenantId}:${target}`])) {
        await systemAudit(tenantId, 'todo_schedule', `${tenantId}:${target}`, 'opened', { todo_date: target, plan_date: win.today });
      }
      if (s.notify_employees) {
        if (t < s.reminder_time) await rung('open', EVENTS.open, pending);
        else await rung('reminder', EVENTS.reminder, pending);
      }
      continue;
    }

    // Past the deadline.
    for (const u of pending) await markOverdue(tenantId, u, win);
    if (s.notify_employees) await rung('overdue', EVENTS.overdue, pending);

    if (t >= s.escalation_time) {
      const sends = [];
      for (const u of pending) {
        const to = new Set();
        if (s.notify_managers) (await reportingPersonIds(tenantId, u)).forEach((id) => to.add(id));
        if (s.escalate_to_owner) (await ownerIds(tenantId)).forEach((id) => to.add(id));
        for (const id of to) {
          const recipient = await get('SELECT * FROM users WHERE id = ?', [id]);
          if (recipient) sends.push({ id: `${u.id}>${id}`, recipient, employee: u });
        }
      }
      await rung(
        'escalation',
        EVENTS.escalation,
        sends,
        (x) => ({ ...base, person: x.employee.name, status: 'Overdue' }),
        (x) => `todo_escalation:${target}:${x.employee.id}`,
      );
    }
  }
  return n;
}

// ================================================================ the plan
/** The Action Items scale, so a planned task keeps its priority when it becomes one. */
export const PRIORITIES = ['urgent', 'high', 'medium', 'low'];
/** The reporting person is working on it or has decided: the employee's copy is frozen. */
const LOCKED = ['UNDER_REVIEW', 'APPROVED', 'MISSED'];
const AWAITING_REVIEW = ['SUBMITTED', 'LATE', 'UNDER_REVIEW'];
/**
 * A plan being worked: filed (or missed, but still today's), and its day has
 * not gone by. Its tasks can be ticked off and added to - no re-approval.
 */
const WORKABLE = ['SUBMITTED', 'LATE', 'UNDER_REVIEW', 'APPROVED', 'MISSED'];
const workable = (sub, today) => WORKABLE.includes(sub.status) && sub.todo_date >= today;

/**
 * The owner sees and reviews every plan. Decided by the role itself, never by a
 * permission: a custom role that happens to carry settings access must not turn
 * an employee into someone who reads everyone's plans.
 */
export const isAdmin = (auth) => ['owner', 'super_admin'].includes(auth.role);

/** Who may hold a team and see the Team Advance Planner: managers and owners only. */
export const LEADS = ['owner', 'manager'];
const isLead = (auth) => isAdmin(auth) || auth.role === 'manager';

/** The owner, or a manager the owner has granted a view of every plan. */
export const seesEveryone = async (auth) => isAdmin(auth)
  || (!['client', 'super_admin'].includes(auth.role)
    && (await settingsFor(auth.tenantId)).full_view_user_ids.includes(auth.userId));

const userName = async (id) => (id ? (await get('SELECT name FROM users WHERE id = ?', [id]))?.name : null) || null;
const userRow = async (id) => await get('SELECT * FROM users WHERE id = ?', [id]);

export async function canView(auth, sub) {
  if (!sub) return false;
  if (sub.user_id === auth.userId || sub.reporting_person_id === auth.userId || await seesEveryone(auth)) return true;
  // The employee's current reporting person may read their history too.
  return (await userRow(sub.user_id))?.manager_id === auth.userId;
}

export const canReview = (auth, sub) => !!sub && sub.user_id !== auth.userId
  && (sub.reporting_person_id === auth.userId || isAdmin(auth));

async function loadSubmission(auth, id) {
  const sub = await get('SELECT * FROM todo_submissions WHERE id = ? AND tenant_id = ?', [id, auth.tenantId]);
  // Not-found rather than forbidden, so an id cannot be probed for existence.
  if (!sub || !await canView(auth, sub)) throw notFound('Plan');
  return sub;
}

/** What the person may pick from: projects they can see, and clients if they can see the CRM. */
export async function optionsFor(auth) {
  const pids = await visibleProjectIds(auth);
  const projects = pids.length
    ? await all(
      `SELECT id, name FROM projects WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
          AND id IN (${pids.map(() => '?').join(',')}) ORDER BY name`,
      [auth.tenantId, ...pids],
    )
    : [];
  const clients = await can(auth, 'crm', 'view')
    ? await all("SELECT id, name FROM client_accounts WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' ORDER BY name",
      [auth.tenantId])
    : [];
  return { projects, clients };
}

/** Whether the employee may still change this plan, and if not, why. */
async function editState(auth, sub, win) {
  if (sub.user_id !== auth.userId) return { can_edit: false, reason: null };
  if (sub.status === 'MISSED') return { can_edit: false, reason: 'The planned day has arrived.' };
  // Saving replaces every task row, which would cut the converted ones loose
  // from their action items.
  if ((await linkedItems(sub.tenant_id, sub.id)).size) {
    return { can_edit: false, reason: 'Tasks from this plan are tracked in Action Items now.' };
  }
  if (LOCKED.includes(sub.status)) return { can_edit: false, reason: 'Your reporting person has this plan now.' };
  if (sub.todo_date < win.today || (sub.todo_date === win.today && sub.status !== 'CHANGES_REQUESTED')) {
    return { can_edit: false, reason: 'The planned day has arrived.' };
  }
  const ticked = (await all('SELECT done_at, checklist FROM todo_tasks WHERE submission_id = ?', [sub.id]))
    .some((t) => t.done_at || parseJson(t.checklist, []).some((c) => c.done));
  if (ticked) {
    return { can_edit: false, reason: 'Work has started on this plan.' };
  }
  if (sub.status === 'CHANGES_REQUESTED') return { can_edit: true, reason: null };
  const past = sub.deadline_at && Date.now() > Date.parse(sub.deadline_at);
  if (past && ['SUBMITTED', 'LATE'].includes(sub.status)) return { can_edit: false, reason: 'Submitted plans can be edited until the deadline.' };
  if (past && !win.settings.allow_late) return { can_edit: false, reason: 'The deadline has passed and late plans are not accepted.' };
  return { can_edit: true, reason: null };
}

export async function detail(auth, sub, win) {
  win ??= await windowFor(auth.tenantId);
  const tasks = (await all(
    `SELECT t.id, t.task, t.project_id, p.name AS project_name, t.client_id, c.name AS client_name,
            t.priority, t.expected_time, t.notes, t.done_at, t.checklist,
            t.added_at, t.added_by, ab.name AS added_by_name, t.carried_from_date, t.carried_to_date
       FROM todo_tasks t
       LEFT JOIN users ab ON ab.id = t.added_by
       LEFT JOIN projects p ON p.id = t.project_id
       LEFT JOIN client_accounts c ON c.id = t.client_id
      WHERE t.submission_id = ? ORDER BY t.sort`,
    [sub.id],
  )).map((t) => ({ ...t, checklist: parseJson(t.checklist, []) }));
  const linked = await linkedItems(sub.tenant_id, sub.id);
  for (const t of tasks) {
    const a = linked.get(t.id);
    t.action_item = a ? {
      id: a.id, status: a.status, validation_status: a.validation_status, deleted: !!a.deleted_at,
    } : null;
    t.conversion_block = a ? null : conversionBlock(t);
  }
  const comments = await all(
    `SELECT tc.id, tc.kind, tc.body, tc.created_at, tc.user_id, u.name AS user_name
       FROM todo_comments tc LEFT JOIN users u ON u.id = tc.user_id
      WHERE tc.submission_id = ? ORDER BY tc.created_at`,
    [sub.id],
  );
  return {
    ...sub,
    employee_name: await userName(sub.user_id),
    reporting_person_name: await userName(sub.reporting_person_id),
    reviewed_by_name: await userName(sub.reviewed_by),
    tasks,
    comments,
    ...await editState(auth, sub, win),
    can_review: canReview(auth, sub),
    can_tick: sub.user_id === auth.userId && workable(sub, win.today),
    can_add_task: canAddTask(auth, sub, win.today),
    options: canAddTask(auth, sub, win.today) ? await optionsFor(auth) : undefined,
    conversion: await conversionSummary(auth, sub, tasks),
  };
}

/** The person, their reporting person or the owner may add to a plan being worked. */
const canAddTask = (auth, sub, today) => workable(sub, today)
  && (sub.user_id === auth.userId || sub.reporting_person_id === auth.userId || isAdmin(auth));

export async function mine(auth) {
  const win = await windowFor(auth.tenantId);
  const me = await userRow(auth.userId);
  // A plan sent back for changes stays the one in front of the person until it is fixed.
  const sub = await get(
    `SELECT * FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date >= ?
        AND (todo_date = ? OR status = 'CHANGES_REQUESTED')
      ORDER BY CASE status WHEN 'CHANGES_REQUESTED' THEN 0 ELSE 1 END, todo_date LIMIT 1`,
    [auth.tenantId, auth.userId, win.today, win.todo_date ?? ''],
  );
  const reporting = (await reportingPersonIds(auth.tenantId, me))[0] ?? null;
  const { settings, ...window } = win;
  return {
    window,
    settings: {
      enabled: settings.enabled, open_time: settings.open_time, deadline_time: settings.deadline_time,
      allow_late: settings.allow_late,
    },
    expected: filesPlans(me.role),
    plan: sub ? await detail(auth, sub, win) : null,
    // The plan being worked today: filed yesterday, or carried into.
    today_plan: (async () => {
      const t = await get('SELECT * FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?',
        [auth.tenantId, auth.userId, win.today]);
      return t && t.id !== sub?.id ? await detail(auth, t, win) : null;
    })(),
    reporting_person: reporting ? { id: reporting, name: await userName(reporting) } : null,
    options: await optionsFor(auth),
    history: (await all(
      `SELECT s.id, s.todo_date, s.status, s.submitted_at, s.minutes_late,
              (SELECT COUNT(*) FROM todo_tasks t WHERE t.submission_id = s.id) AS task_count
         FROM todo_submissions s WHERE s.tenant_id = ? AND s.user_id = ?
        ORDER BY s.todo_date DESC LIMIT 14`,
      [auth.tenantId, auth.userId],
    )).map((h) => ({ ...h, task_count: Number(h.task_count) })),
  };
}

const HHMM_OPT = /^([01]\d|2[0-3]):[0-5]\d$/;

async function cleanTasks(auth, tasks, submitting) {
  if (!Array.isArray(tasks)) throw badRequest('tasks must be a list');
  if (tasks.length > 30) throw badRequest('A plan can hold at most 30 tasks');
  const opts = await optionsFor(auth);
  const projectIds = new Set(opts.projects.map((p) => p.id));
  const clientIds = new Set(opts.clients.map((c) => c.id));
  const out = tasks
    .map((t) => ({
      id: typeof t?.id === 'string' ? t.id : null,
      task: String(t?.task ?? '').trim(),
      project_id: t?.project_id || null,
      client_id: t?.client_id || null,
      priority: t?.priority || 'medium',
      expected_time: t?.expected_time || null,
      notes: String(t?.notes ?? '').trim() || null,
      checklist: Array.isArray(t?.checklist)
        ? t.checklist.map((c) => ({ text: String(c?.text ?? '').trim(), done: c?.done === true })).filter((c) => c.text)
        : [],
    }))
    // A row the person added and never touched is not a task.
    .filter((t) => t.task || t.notes || t.project_id || t.client_id || t.checklist.length);
  out.forEach((t, i) => {
    const n = `Task ${i + 1}`;
    if (!t.task) throw badRequest(`${n}: describe the task`);
    if (t.task.length > 300) throw badRequest(`${n}: keep the task under 300 characters`);
    if (t.notes && t.notes.length > 1000) throw badRequest(`${n}: keep notes under 1000 characters`);
    if (t.checklist.length > 20) throw badRequest(`${n}: a checklist can hold at most 20 items`);
    if (t.checklist.some((c) => c.text.length > 200)) throw badRequest(`${n}: keep checklist items under 200 characters`);
    if (!PRIORITIES.includes(t.priority)) throw badRequest(`${n}: priority must be urgent, high, medium or low`);    if (t.expected_time && !HHMM_OPT.test(t.expected_time)) throw badRequest(`${n}: expected time must be HH:MM`);
    if (t.project_id && !projectIds.has(t.project_id)) throw badRequest(`${n}: that project is not available to you`);
    if (t.client_id && !clientIds.has(t.client_id)) throw badRequest(`${n}: that client is not available to you`);
  });
  if (submitting && !out.length) throw badRequest('Add at least one task before submitting');
  return out;
}

async function addThread(tenantId, submissionId, userId, kind, body) {
  await run('INSERT INTO todo_comments (id, tenant_id, submission_id, user_id, kind, body, created_at) VALUES (?,?,?,?,?,?,?)',
    [uuid(), tenantId, submissionId, userId, kind, body || null, nowIso()]);
}

async function auditAs(auth, entityId, action, before, after) {
  await run(
    `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_name, entity, entity_id, action, before_json, after_json, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), auth.tenantId, auth.userId, auth.name ?? await userName(auth.userId), 'todo_submission', entityId, action,
      before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, null, nowIso()],
  );
}

/**
 * Save (and optionally submit) the caller's own plan for `todoDate`. The
 * reporting person is never taken from the request: it is read from the
 * employee's record at the moment of submission.
 */
export async function savePlan(auth, todoDate, { tasks = [], submit = false } = {}) {
  if (!filesPlans(auth.role)) throw forbidden('This login does not use the Advance Planner');
  const win = await windowFor(auth.tenantId);
  const s = win.settings;
  let sub = await get('SELECT * FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?',
    [auth.tenantId, auth.userId, todoDate]);

  if (!sub) {
    if (!win.todo_date || todoDate !== win.todo_date) {
      throw badRequest(win.todo_date ? `Plans can only be filed for ${win.todo_date} today` : 'There is no plan to file today');
    }
    if (Date.now() > Date.parse(win.deadline_at) && !s.allow_late) {
      throw forbidden('The deadline has passed and late plans are not accepted');
    }
  } else {
    const state = await editState(auth, sub, win);
    if (!state.can_edit) throw forbidden(state.reason || 'This plan can no longer be edited');
  }

  const clean = await cleanTasks(auth, tasks, submit);
  const me = await userRow(auth.userId);
  // The reporting person reviews the plan and later validates its action items,
  // so a plan cannot be filed to nobody.
  if (submit && !(await reportingPersonIds(auth.tenantId, me)).length) {
    throw unprocessable('Validation failed', [{
      field: 'reporting_person_id',
      message: 'You have no reporting person on record - ask the owner to set one before submitting',
    }]);
  }
  const now = nowIso();
  const before = sub
    ? { status: sub.status, tasks: await all('SELECT task, priority FROM todo_tasks WHERE submission_id = ? ORDER BY sort', [sub.id]) }
    : null;
  const resubmission = sub?.status === 'CHANGES_REQUESTED';

  const id = await tx(async () => {
    if (!sub) {
      const newId = uuid();
      await run(
        `INSERT INTO todo_submissions (id, tenant_id, user_id, reporting_person_id, todo_date, plan_date, status,
           deadline_at, created_at, updated_at) VALUES (?,?,?,?,?,?, 'DRAFT', ?,?,?)`,
        [newId, auth.tenantId, auth.userId, (await reportingPersonIds(auth.tenantId, me))[0] ?? null, todoDate, win.today,
          win.deadline_at, now, now],
      );
      sub = await get('SELECT * FROM todo_submissions WHERE id = ?', [newId]);
    }
    // Rows are replaced as a set, but a task that was added later or carried
    // over keeps saying so.
    const prior = new Map((await all('SELECT * FROM todo_tasks WHERE submission_id = ?', [sub.id])).map((r) => [r.id, r]));
    await run('DELETE FROM todo_tasks WHERE submission_id = ?', [sub.id]);
    await forEachSeq(clean, async (t, i) => {
      const was = (t.id && prior.get(t.id)) || {};
      await run(
        `INSERT INTO todo_tasks (id, tenant_id, submission_id, task, project_id, client_id, priority, expected_time, notes,
           checklist, sort, added_at, added_by, carried_from_date, carried_from_task_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), auth.tenantId, sub.id, t.task, t.project_id, t.client_id, t.priority, t.expected_time, t.notes,
          JSON.stringify(t.checklist), i, was.added_at ?? null, was.added_by ?? null, was.carried_from_date ?? null,
          was.carried_from_task_id ?? null, now, now],
      );
    });

    if (submit) {
      // A resubmission answers the reviewer; it is not late against the original deadline.
      const late = !resubmission && sub.deadline_at && Date.now() > Date.parse(sub.deadline_at);
      const minutesLate = late ? Math.ceil((Date.now() - Date.parse(sub.deadline_at)) / 60_000) : sub.minutes_late;
      await run(
        `UPDATE todo_submissions SET status = ?, submitted_at = ?, minutes_late = ?, reporting_person_id = ?, updated_at = ?
          WHERE id = ?`,
        [late ? 'LATE' : 'SUBMITTED', now, minutesLate ?? null, (await reportingPersonIds(auth.tenantId, me))[0] ?? null, now, sub.id],
      );
      await addThread(auth.tenantId, sub.id, auth.userId, 'submitted', resubmission ? 'Resubmitted with changes' : null);
    } else {
      // A plain save never changes the status: a draft stays a draft, an overdue plan stays overdue.
      await run('UPDATE todo_submissions SET updated_at = ? WHERE id = ?', [now, sub.id]);
    }
    return sub.id;
  });

  const saved = await get('SELECT * FROM todo_submissions WHERE id = ?', [id]);
  const action = submit
    ? (resubmission ? 'resubmit' : saved.status === 'LATE' ? 'submit_late' : 'submit')
    : (before ? 'edit' : 'create');
  await auditAs(auth, id, action, before, { status: saved.status, tasks: clean.map((t) => ({ task: t.task, priority: t.priority })) });

  if (submit) {
    const late = saved.status === 'LATE' ? ` (${saved.minutes_late} min late)` : '';
    for (const rid of await reportingPersonIds(auth.tenantId, me)) {
      const recipient = await userRow(rid);
      if (recipient) {
        await tell(auth.tenantId, recipient, EVENTS.submitted,
          { person: `${me.name}${late}`, todo_date: saved.todo_date, todo_day: dayLabel(saved.todo_date), count: clean.length }, null, s, planLink(id));
      }
    }
  }
  return await detail(auth, saved, win);
}

/** The reporting person opening a plan moves it to UNDER_REVIEW, so it cannot change underneath them. */
export async function startReview(auth, id) {
  const sub = await loadSubmission(auth, id);
  if (canReview(auth, sub) && ['SUBMITTED', 'LATE'].includes(sub.status)) {
    await run("UPDATE todo_submissions SET status = 'UNDER_REVIEW', updated_at = ? WHERE id = ?", [nowIso(), sub.id]);
    await auditAs(auth, sub.id, 'review_start', { status: sub.status }, { status: 'UNDER_REVIEW' });
  }
  return await detail(auth, await get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id]));
}

export async function decide(auth, id, { approve, note }) {
  const sub = await loadSubmission(auth, id);
  if (!canReview(auth, sub)) throw forbidden('Only the reporting person or an owner can review this plan');
  if (!AWAITING_REVIEW.includes(sub.status)) {
    throw badRequest(`This plan is ${sub.status.toLowerCase().replace(/_/g, ' ')}, not awaiting review`);
  }
  const text = String(note ?? '').trim();
  // Sending the plan back would reopen it for editing, and editing replaces
  // the task rows the action items point at.
  if (!approve && (await linkedItems(sub.tenant_id, sub.id)).size) {
    throw badRequest('Tasks from this plan are already action items - send the individual items back from Action Items instead');
  }
  if (!approve && !text) throw badRequest('Say what needs to change');
  if (text.length > 2000) throw badRequest('Keep the note under 2000 characters');

  const now = nowIso();
  const status = approve ? 'APPROVED' : 'CHANGES_REQUESTED';
  await tx(async () => {
    await run(
      'UPDATE todo_submissions SET status = ?, reviewed_by = ?, reviewed_at = ?, approved_at = ?, updated_at = ? WHERE id = ?',
      [status, auth.userId, now, approve ? now : null, now, sub.id],
    );
    await addThread(auth.tenantId, sub.id, auth.userId, approve ? 'approved' : 'changes_requested', text || null);
  });
  await auditAs(auth, sub.id, approve ? 'approve' : 'request_changes', { status: sub.status }, { status, note: text || null });

  await tell(auth.tenantId, await userRow(sub.user_id), approve ? EVENTS.approved : EVENTS.changes,
    { reviewer: await userName(auth.userId), todo_date: sub.todo_date, todo_day: dayLabel(sub.todo_date), note: text }, null, await settingsFor(auth.tenantId), planLink(sub.id));

  // An approved plan is agreed work, so its tasks move to Action Items there
  // and then. The approval stands even if that cannot happen - the plan then
  // says why, and "Create Action Items" retries once it is fixed.
  let conversion = null;
  if (approve) {
    try {
      const { plan: _plan, ...outcome } = await convertPlan(auth, sub.id);
      conversion = outcome;
    } catch (err) {
      conversion = { error: err.message };
    }
  }
  return { ...await detail(auth, await get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id])), conversion_result: conversion };
}

export async function addComment(auth, id, body) {
  const sub = await loadSubmission(auth, id);
  const text = String(body ?? '').trim();
  if (!text) throw badRequest('Write a comment');
  if (text.length > 2000) throw badRequest('Keep the comment under 2000 characters');
  await addThread(auth.tenantId, sub.id, auth.userId, 'comment', text);
  await auditAs(auth, sub.id, 'comment', null, { body: text });

  // The other side of the conversation hears about it.
  const to = sub.user_id === auth.userId ? [sub.reporting_person_id].filter(Boolean) : [sub.user_id];
  for (const rid of to.filter((x) => x !== auth.userId)) {
    const recipient = await userRow(rid);
    if (recipient) {
      await tell(auth.tenantId, recipient, EVENTS.comment,
        { person: await userName(auth.userId), todo_date: sub.todo_date, todo_day: dayLabel(sub.todo_date), note: text.slice(0, 300) }, null, await settingsFor(auth.tenantId), planLink(sub.id));
    }
  }
  return await detail(auth, await get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id]));
}

export const getPlan = async (auth, id) => await detail(auth, await loadSubmission(auth, id));


/**
 * The employee ticks a task done (or reopens it). Only their own plan, only
 * once it has been filed, and each tick goes on the activity feed so the
 * reporting person sees progress where they comment.
 */
export async function setTaskDone(auth, id, taskId, done) {
  const sub = await loadSubmission(auth, id);
  if (sub.user_id !== auth.userId) throw forbidden('Only the person who planned it can tick a task off');
  if (!workable(sub, (await windowFor(auth.tenantId)).today)) throw badRequest('Only a submitted plan whose day has not passed can be ticked off');
  const task = await get('SELECT * FROM todo_tasks WHERE id = ? AND submission_id = ?', [taskId, sub.id]);
  if (!task) throw notFound('Task');
  if (task.carried_to_date) throw badRequest(`This task moved to ${task.carried_to_date}; tick it there`);
  await assertNotConverted(sub, task);
  if (!!task.done_at === !!done) return await detail(auth, sub);

  const now = nowIso();
  await tx(async () => {
    await run('UPDATE todo_tasks SET done_at = ?, done_by = ?, updated_at = ? WHERE id = ?',
      [done ? now : null, done ? auth.userId : null, now, task.id]);
    await addThread(auth.tenantId, sub.id, auth.userId, done ? 'task_done' : 'task_reopened', task.task);
  });
  await auditAs(auth, sub.id, done ? 'task_done' : 'task_reopened', null, { task: task.task });
  return await detail(auth, await get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id]));
}

/**
 * The reviewer's view of one planned day: each of their people and where their
 * plan stands, plus every plan still waiting on them. An owner sees everyone.
 * Someone with nobody reporting to them gets `is_reviewer: false`.
 */
export async function team(auth, day, wantAll = false) {
  const win = await windowFor(auth.tenantId);
  const s = win.settings;
  const target = day || win.todo_date || await nextWorkingDay(auth.tenantId, win.today, s);
  const admin = isAdmin(auth);
  // Employees see only their own plan - unless the owner has granted them the view of everyone.
  if (!isLead(auth) && !await seesEveryone(auth)) {
    // Employees (and finance, HR...) only ever see their own plan.
    return {
      todo_date: target, deadline_time: s.deadline_time, is_reviewer: false, is_admin: false, scope: 'none',
      counts: { total: 0, not_submitted: 0 }, rows: [], pending: [], reporting_options: [], assignable: [], can_assign: false,
    };
  }
  // Someone with a team of their own starts on it; "everyone" is a switch for
  // those allowed it. An employee granted the view has no team, so it is all they see.
  const canSeeAll = await seesEveryone(auth);
  const everyone = canSeeAll && (wantAll || !isLead(auth));
  const managerAssigns = !admin && s.managers_can_assign;

  // The owner's own team: people with no manager, or whose manager is an owner.
  const mine = async (u) => u.manager_id === auth.userId || (admin && await isUnclaimed(auth.tenantId, u));
  const people = await filterSeq(await plannersOf(auth.tenantId), async (u) => u.id !== auth.userId && (everyone || await mine(u)));

  const plans = await all(
    `SELECT s.*, (SELECT COUNT(*) FROM todo_tasks t WHERE t.submission_id = s.id) AS task_count
       FROM todo_submissions s WHERE s.tenant_id = ? AND s.todo_date = ?`,
    [auth.tenantId, target],
  );
  const byUser = new Map(plans.map((p) => [p.user_id, p]));
  // Someone reassigned away since filing still shows to the person their plan went to.
  const extra = (await Promise.all(plans
    .filter((p) => p.reporting_person_id === auth.userId && !people.some((u) => u.id === p.user_id))
    .map(async (p) => await userRow(p.user_id)))).filter(Boolean);

  const rows = (await Promise.all([...people, ...extra].map(async (u) => {
    const p = byUser.get(u.id);
    return {
      user: { id: u.id, name: u.name, designation: u.designation },
      manager_id: u.manager_id || null,
      reporting_person_name: await userName((await reportingPersonIds(auth.tenantId, u))[0]),
      plan: p ? {
        id: p.id, status: p.status, submitted_at: p.submitted_at, minutes_late: p.minutes_late,
        task_count: Number(p.task_count),
      } : null,
    };
  }))).sort((a, b) => a.user.name.localeCompare(b.user.name));

  const counts = { total: rows.length, not_submitted: 0 };
  for (const st of STATUSES) counts[st] = 0;
  for (const r of rows) {
    if (!r.plan || ['DRAFT', 'OVERDUE', 'MISSED'].includes(r.plan.status)) counts.not_submitted += 1;
    if (r.plan) counts[r.plan.status] += 1;
  }

  const rowIds = new Set(rows.map((r) => r.user.id));
  const pending = (await all(
    `SELECT s.id, s.user_id, s.reporting_person_id, u.name AS employee_name, s.todo_date, s.status, s.submitted_at, s.minutes_late,
            (SELECT COUNT(*) FROM todo_tasks t WHERE t.submission_id = s.id) AS task_count
       FROM todo_submissions s JOIN users u ON u.id = s.user_id
      WHERE s.tenant_id = ? AND s.status IN ('SUBMITTED','LATE','UNDER_REVIEW') AND s.todo_date >= ?
        AND s.user_id != ? ${admin ? '' : 'AND s.reporting_person_id = ?'}
      ORDER BY s.submitted_at`,
    admin ? [auth.tenantId, win.today, auth.userId] : [auth.tenantId, win.today, auth.userId, auth.userId],
  )).map((p) => ({ ...p, task_count: Number(p.task_count) }))
    // On "my team", only what is mine to review; on "everyone", the owner's whole queue.
    .filter((p) => (admin && everyone) || p.reporting_person_id === auth.userId || rowIds.has(p.user_id));

  const manages = managerAssigns && auth.role === 'manager';
  return {
    todo_date: target,
    deadline_time: s.deadline_time,
    is_reviewer: everyone || manages || rows.length > 0 || pending.length > 0,
    is_admin: admin,
    scope: everyone ? 'everyone' : 'team',
    can_see_all: canSeeAll && isLead(auth),
    counts,
    rows,
    pending,
    // The owner picks anyone's reporting person from this list.
    reporting_options: admin ? await reportingCandidates(auth.tenantId) : [],
    // A manager the owner allows to build a team picks from people nobody else manages.
    assignable: manages
      ? (await filterSeq(await plannersOf(auth.tenantId), async (u) => u.id !== auth.userId && await isUnclaimed(auth.tenantId, u)))
        .map((u) => ({ id: u.id, name: u.name, designation: u.designation }))
        .sort((a, b) => a.name.localeCompare(b.name))
      : [],
    can_assign: manages,
  };
}

// ================================================================ reporting structure
/** Anyone who can hold a team: active staff, owners included. */
export const reportingCandidates = async (tenantId) => await all(
  `SELECT id, name, role FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
      AND role IN ('owner','manager') ORDER BY name`,
  [tenantId],
);

/** Nobody's but the owner's: no manager on record, or one of the owners. */
async function isUnclaimed(tenantId, user) {
  if (!user.manager_id) return true;
  return (await get("SELECT role FROM users WHERE id = ? AND tenant_id = ?", [user.manager_id, tenantId]))?.role === 'owner';
}

/** Would `managerId` end up reporting (directly or not) to `userId`? */
async function wouldLoop(tenantId, userId, managerId) {
  let cur = managerId;
  for (let i = 0; cur && i < 50; i++) {
    if (cur === userId) return true;
    cur = (await get('SELECT manager_id FROM users WHERE id = ? AND tenant_id = ?', [cur, tenantId]))?.manager_id;
  }
  return false;
}

/**
 * Change who someone reports to. The owner may set anyone's. A manager may,
 * only when the owner has switched it on, take someone unclaimed into their
 * own team or hand one of their own back to the owner - never take someone
 * from another manager. Nobody sets their own. Plans already filed keep the
 * person they went to; the next one follows the new line.
 */
export async function setReporting(auth, userId, managerId) {
  const target = await get("SELECT * FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL", [userId, auth.tenantId]);
  if (!target || ['client', 'super_admin'].includes(target.role)) throw notFound('Person');
  if (userId === auth.userId) throw forbidden('You cannot change your own reporting person');
  const next = managerId || null;

  // Who may ask comes before whether the request is well-formed.
  if (!isAdmin(auth)) {
    const s = await settingsFor(auth.tenantId);
    if (!s.managers_can_assign || auth.role !== 'manager') throw forbidden('Only the owner can change reporting persons');
    // Adding only: taking someone off a team is the owner's call.
    const takingIn = next === auth.userId && await isUnclaimed(auth.tenantId, target);
    if (!takingIn) throw forbidden('You can add people nobody else manages. Only the owner can move someone off a team.');
  }

  if (next) {
    const m = await get("SELECT id, role FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND status = 'active'", [next, auth.tenantId]);
    if (!m || !LEADS.includes(m.role)) throw badRequest('A reporting person must be a manager or the owner');
    if (next === userId) throw badRequest('Someone cannot report to themselves');
    if (await wouldLoop(auth.tenantId, userId, next)) throw badRequest('That would make a reporting loop');
  }

  await run('UPDATE users SET manager_id = ?, updated_at = ? WHERE id = ?', [next, nowIso(), userId]);
  await run(
    `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_name, entity, entity_id, action, before_json, after_json, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), auth.tenantId, auth.userId, auth.name ?? await userName(auth.userId), 'user', userId, 'reporting_change',
      JSON.stringify({ manager_id: target.manager_id, manager: await userName(target.manager_id) }),
      JSON.stringify({ manager_id: next, manager: await userName(next) }), null, nowIso()],
  );
  return { user_id: userId, manager_id: next, manager_name: await userName(next) };
}

/** The employee ticks one checklist item under a task, on their own filed plan. */
export async function setChecklistItem(auth, id, taskId, index, done) {
  const sub = await loadSubmission(auth, id);
  if (sub.user_id !== auth.userId) throw forbidden('Only the person who planned it can tick a checklist item');
  if (!workable(sub, (await windowFor(auth.tenantId)).today)) throw badRequest('Only a submitted plan whose day has not passed can be ticked off');
  const task = await get('SELECT * FROM todo_tasks WHERE id = ? AND submission_id = ?', [taskId, sub.id]);
  if (!task) throw notFound('Task');
  if (task.carried_to_date) throw badRequest(`This task moved to ${task.carried_to_date}; tick it there`);
  await assertNotConverted(sub, task);
  const list = parseJson(task.checklist, []);
  const item = list[index];
  if (!item) throw notFound('Checklist item');
  if (!!item.done === !!done) return await detail(auth, sub);

  item.done = !!done;
  const now = nowIso();
  await tx(async () => {
    await run('UPDATE todo_tasks SET checklist = ?, updated_at = ? WHERE id = ?', [JSON.stringify(list), now, task.id]);
    await addThread(auth.tenantId, sub.id, auth.userId, done ? 'check_done' : 'check_reopened', item.text);
  });
  await auditAs(auth, sub.id, done ? 'check_done' : 'check_reopened', null, { task: task.task, item: item.text });
  return await detail(auth, await get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id]));
}

// ================================================================ adding and carrying over
/**
 * Add one task to a plan that is being worked - today's, or tomorrow's after
 * it was filed. No re-approval: the task is marked as added later, by whom,
 * and the other side hears about it.
 */
export async function addTask(auth, id, body) {
  const sub = await loadSubmission(auth, id);
  const win = await windowFor(auth.tenantId);
  if (!canAddTask(auth, sub, win.today)) {
    throw forbidden(workable(sub, win.today)
      ? 'Only the person, their reporting person or the owner can add to this plan'
      : 'Tasks can be added to a filed plan whose day has not passed');
  }
  const [t] = await cleanTasks(auth, [body || {}], true);
  const count = Number((await get('SELECT COUNT(*) AS n FROM todo_tasks WHERE submission_id = ?', [sub.id]))?.n || 0);
  if (count >= 30) throw badRequest('A plan can hold at most 30 tasks');
  const sort = Number((await get('SELECT COALESCE(MAX(sort), -1) AS m FROM todo_tasks WHERE submission_id = ?', [sub.id]))?.m ?? -1) + 1;
  const now = nowIso();
  await tx(async () => {
    await run(
      `INSERT INTO todo_tasks (id, tenant_id, submission_id, task, project_id, client_id, priority, expected_time, notes,
         checklist, sort, added_at, added_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), auth.tenantId, sub.id, t.task, t.project_id, t.client_id, t.priority, t.expected_time, t.notes,
        JSON.stringify(t.checklist), sort, now, auth.userId, now, now],
    );
    await addThread(auth.tenantId, sub.id, auth.userId, 'task_added', t.task);
  });
  await auditAs(auth, sub.id, 'task_added', null, { task: t.task, priority: t.priority });

  const to = sub.user_id === auth.userId ? [sub.reporting_person_id].filter(Boolean) : [sub.user_id];
  for (const rid of to.filter((x) => x !== auth.userId)) {
    const recipient = await userRow(rid);
    if (recipient) {
      await tell(auth.tenantId, recipient, EVENTS.task_added,
        { person: await userName(auth.userId), todo_date: sub.todo_date, todo_day: dayLabel(sub.todo_date), note: t.task },
        null, win.settings, planLink(sub.id));
    }
  }
  return await detail(auth, await get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id]), win);
}

/**
 * The day after: every task left unfinished on a plan whose day has passed is
 * copied onto the plan for the next working day (made if there is none) and
 * the original is marked as moved, so it is carried exactly once. A task
 * carried again keeps the day it was first planned. Looks back two weeks, so
 * a server that was down for a while still catches up.
 */
export async function carryOver(tenantId, today, settings) {
  settings ??= await settingsFor(tenantId);
  const rows = await all(
    `SELECT t.*, s.user_id, s.todo_date AS plan_day, s.reporting_person_id
       FROM todo_tasks t JOIN todo_submissions s ON s.id = t.submission_id
      WHERE t.tenant_id = ? AND s.todo_date < ? AND s.todo_date >= ?
        AND t.done_at IS NULL AND t.carried_to_date IS NULL
        -- An action item carries its own deadline and overdue ladder; copying
        -- the task forward too would put the same work in two places.
        AND NOT EXISTS (SELECT 1 FROM action_items a WHERE a.tenant_id = t.tenant_id
                          AND a.source_type = 'advance_planner' AND a.source_id = t.id)
      ORDER BY s.user_id, s.todo_date, t.sort`,
    [tenantId, today, addDay(today, -14)],
  );
  if (!rows.length) return 0;

  const firstFromToday = await isWorkingDay(tenantId, today, settings) ? today : await nextWorkingDay(tenantId, today, settings);
  const moved = new Map(); // user_id -> { dest, titles[] }
  const now = nowIso();

  await tx(async () => {
    for (const r of rows) {
      let dest = await nextWorkingDay(tenantId, r.plan_day, settings);
      if (!dest || dest < firstFromToday) dest = firstFromToday;
      if (!dest) continue;

      let plan = await get('SELECT * FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?', [tenantId, r.user_id, dest]);
      if (!plan) {
        const pid = uuid();
        await run(
          `INSERT INTO todo_submissions (id, tenant_id, user_id, reporting_person_id, todo_date, plan_date, status, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?)`,
          [pid, tenantId, r.user_id, r.reporting_person_id, dest, r.plan_day, dest <= today ? 'MISSED' : 'OVERDUE', now, now],
        );
        plan = await get('SELECT * FROM todo_submissions WHERE id = ?', [pid]);
      }
      const sort = Number((await get('SELECT COALESCE(MAX(sort), -1) AS m FROM todo_tasks WHERE submission_id = ?', [plan.id]))?.m ?? -1) + 1;
      await run(
        `INSERT INTO todo_tasks (id, tenant_id, submission_id, task, project_id, client_id, priority, expected_time, notes,
           checklist, sort, added_at, carried_from_date, carried_from_task_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), tenantId, plan.id, r.task, r.project_id, r.client_id, r.priority, r.expected_time, r.notes,
          r.checklist, sort, now, r.carried_from_date || r.plan_day, r.id, now, now],
      );
      await run('UPDATE todo_tasks SET carried_to_date = ?, updated_at = ? WHERE id = ?', [dest, now, r.id]);
      await addThread(tenantId, plan.id, null, 'carried_over', r.task);
      await addThread(tenantId, r.submission_id, null, 'moved_on', `${r.task} → ${dayLabel(dest)}`);

      const m = moved.get(r.user_id) || { dest, titles: [], planId: plan.id };
      m.titles.push(r.task);
      moved.set(r.user_id, m);
    }
  });

  for (const [userId, m] of moved) {
    const user = await userRow(userId);
    if (!user) continue;
    const list = m.titles.slice(0, 4).join(', ') + (m.titles.length > 4 ? ` and ${m.titles.length - 4} more` : '');
    await tell(tenantId, user, EVENTS.carried_over,
      { count: m.titles.length, todo_date: m.dest, todo_day: dayLabel(m.dest), tasks: list },
      `todo_carry:${today}`, settings, planLink(m.planId));
  }
  return rows.length;
}

// ================================================================ to action items
/**
 * A filed plan's tasks become action items: one per task, assigned to the
 * person who planned them, validated by the reporting person the plan went
 * to. From then on the action item is where the work is tracked - its status,
 * daily updates, sign-off and deadline ladder - and the plan only reads it back.
 *
 * Field mapping onto the existing action item columns, no new ones:
 *  - `owner_id`   the assignee: the plan's employee.
 *  - `created_by` the validator: the plan's reporting person. Sign-off on an
 *                 action item belongs to whoever raised it, so this is the
 *                 column that makes the reporting person the one who validates.
 *  - `source_type` 'advance_planner', `source_id` the task, `source_plan_id`
 *                 the plan. A unique index on the task makes a second item
 *                 for the same task impossible, whoever asks and however often.
 */
export const SOURCE_TYPE = 'advance_planner';
/** Plans that have gone to the reporting person and are not being reworked. */
const CONVERTIBLE = ['SUBMITTED', 'LATE', 'UNDER_REVIEW', 'APPROVED'];
const TITLE_MAX = 240;

/** task id -> the action item made from it. Deleted ones count: a task converts once. */
async function linkedItems(tenantId, submissionId) {
  return new Map((await all(
    `SELECT id, source_id, status, validation_status, deleted_at FROM action_items
      WHERE tenant_id = ? AND source_type = ? AND source_plan_id = ?`,
    [tenantId, SOURCE_TYPE, submissionId],
  )).map((a) => [a.source_id, a]));
}

async function assertNotConverted(sub, task) {
  if (await get('SELECT id FROM action_items WHERE tenant_id = ? AND source_type = ? AND source_id = ?',
    [sub.tenant_id, SOURCE_TYPE, task.id])) {
    throw badRequest('This task is tracked in Action Items now - update its progress there');
  }
}

/** Why one task cannot become an action item, or null when it can. */
function conversionBlock(t) {
  if (t.carried_to_date) return `Moved to ${dayLabel(t.carried_to_date)} - convert it from that plan`;
  if (t.done_at) return 'Already ticked off in the planner';
  if (String(t.task || '').trim().length < 2) return 'The title needs at least 2 characters';
  return null;
}

function planProblem(sub) {
  if (CONVERTIBLE.includes(sub.status)) return null;
  if (sub.status === 'CHANGES_REQUESTED') return 'Resubmit the plan before turning it into action items';
  if (sub.status === 'MISSED') return 'This plan was never submitted, so it cannot be turned into action items';
  return 'Submit the plan before turning it into action items';
}

/**
 * The reporting person on the plan - the one it was filed to - and nobody
 * else. If they cannot validate, the conversion stops and says so rather than
 * quietly handing the work to someone the employee never reported to.
 */
async function reviewerFor(sub) {
  if (!sub.reporting_person_id) {
    return { problem: 'This plan has no reporting person on record, so nobody could validate its action items. Ask the owner to set one.' };
  }
  const r = await get('SELECT id, name, role, status, deleted_at FROM users WHERE id = ? AND tenant_id = ?',
    [sub.reporting_person_id, sub.tenant_id]);
  if (!r || r.deleted_at || r.status !== 'active' || ['client', 'super_admin'].includes(r.role)) {
    return { problem: `${r?.name || 'The reporting person on this plan'} is no longer active, so they cannot validate its action items. Ask the owner to set a new reporting person.` };
  }
  if (r.id === sub.user_id) return { problem: 'The person who filed a plan cannot also validate its action items' };
  return { user: r };
}

/** The person who filed it, the reporting person it went to, or the owner - and only with the right to create action items. */
const mayConvert = async (auth, sub) => (sub.user_id === auth.userId || sub.reporting_person_id === auth.userId || isAdmin(auth))
  && await can(auth, 'action_items', 'create');

async function conversionSummary(auth, sub, tasks) {
  const converted = tasks.filter((t) => t.action_item).length;
  const blocked = tasks.filter((t) => !t.action_item && t.conversion_block).length;
  const ready = tasks.length - converted - blocked;
  const rev = await reviewerFor(sub);
  const problem = planProblem(sub) || rev.problem || null;
  return {
    total: tasks.length,
    converted,
    not_converted: tasks.length - converted,
    ready,
    blocked,
    problem,
    can_convert: await mayConvert(auth, sub) && !problem && ready > 0,
    assignee: { id: sub.user_id, name: await userName(sub.user_id) },
    reviewer: rev.user ? { id: rev.user.id, name: rev.user.name } : null,
  };
}

/** The action item columns for one planner task. */
async function itemFrom(t, sub, tz) {
  const task = t.task.trim();
  const title = task.length > TITLE_MAX ? `${task.slice(0, TITLE_MAX - 1)}…` : task;
  // The client register Action Items links to is the pipeline; a planner client
  // is the account behind it. No pipeline row, no link - the name still travels.
  const lead = t.client_id
    ? await get('SELECT id FROM clients WHERE tenant_id = ? AND client_account_id = ? AND deleted_at IS NULL ORDER BY created_at LIMIT 1',
      [sub.tenant_id, t.client_id])
    : null;
  const checklist = parseJson(t.checklist, []);
  const description = [
    title !== task ? task : null,
    t.notes || null,
    checklist.length ? `Checklist:\n${checklist.map((c) => `- [${c.done ? 'x' : ' '}] ${c.text}`).join('\n')}` : null,
    t.client_id && !lead && t.client_name ? `Client: ${t.client_name}` : null,
    `From the Advance Planner for ${dayLabel(sub.todo_date)}.`,
  ].filter(Boolean).join('\n\n');
  return {
    title,
    description,
    client_id: lead?.id ?? null,
    project_id: t.project_id || null,
    priority: PRIORITIES.includes(t.priority) ? t.priority : 'medium',
    due_date: sub.todo_date,
    due_time: t.expected_time || null,
    // Straight from the planned day and time. The same-day "pick a time that
    // has not passed" rule is for someone typing a deadline; a plan made
    // yesterday for today records what was agreed, late or not.
    due_at: dueAtIso(sub.todo_date, t.expected_time || null, tz),
  };
}

/**
 * Turns every task on the plan that is not an action item yet into one.
 * Repeatable: what was converted before is reported, not made again, so a
 * retry after a partial run just finishes the job.
 *
 * Everything happens under one write lock (BEGIN IMMEDIATE), and the
 * "already converted?" read happens inside it, so a second click waits for
 * the first and then finds its rows. The unique index backs that up. Each
 * task gets its own savepoint: one that fails is reported and the rest still
 * go through.
 */
export async function convertPlan(auth, id) {
  const sub = await loadSubmission(auth, id);
  if (!await mayConvert(auth, sub)) {
    throw forbidden('Only the person who filed this plan, their reporting person or the owner can turn it into action items');
  }
  const problem = planProblem(sub);
  if (problem) throw badRequest(problem);
  const rev = await reviewerFor(sub);
  if (rev.problem) throw unprocessable(rev.problem, [{ field: 'reporting_person_id', message: rev.problem }]);
  const assignee = await get("SELECT * FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND status = 'active'",
    [sub.user_id, auth.tenantId]);
  if (!assignee) {
    throw unprocessable(`${await userName(sub.user_id) || 'The person who filed this plan'} is no longer active, so the tasks cannot be assigned to them`);
  }

  const reviewer = rev.user;
  const tz = await tzOf(auth.tenantId);
  const result = { created: [], already_converted: [], skipped: [], failed: [] };

  await tx(async () => {
    const linked = await linkedItems(auth.tenantId, sub.id);
    const tasks = await all(
      `SELECT t.*, ca.name AS client_name FROM todo_tasks t
         LEFT JOIN client_accounts ca ON ca.id = t.client_id
        WHERE t.submission_id = ? ORDER BY t.sort`,
      [sub.id],
    );
    for (const t of tasks) {
      const ref = { task_id: t.id, task: t.task };
      const prior = linked.get(t.id);
      if (prior) {
        result.already_converted.push({ ...ref, action_item_id: prior.id, status: prior.status, deleted: !!prior.deleted_at });
        continue;
      }
      const block = conversionBlock(t);
      if (block) { result.skipped.push({ ...ref, reason: block }); continue; }

      const f = await itemFrom(t, sub, tz);
      const itemId = uuid();
      const ts = nowIso();
      await run('SAVEPOINT plan_task');
      try {
        const out = await run(
          `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id, project_id,
             priority, status, due_date, due_time, due_at, source_type, source_id, source_plan_id, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?, 'open', ?,?,?,?,?,?,?,?)
           ON CONFLICT DO NOTHING`,
          [itemId, auth.tenantId, f.title, f.description, sub.user_id, reviewer.id, f.client_id, f.project_id,
            f.priority, f.due_date, f.due_time, f.due_at, SOURCE_TYPE, t.id, sub.id, ts, ts],
        );
        await run('RELEASE plan_task');
        if (Number(out.changes) === 0) {
          const a = await get('SELECT id, status FROM action_items WHERE tenant_id = ? AND source_type = ? AND source_id = ?',
            [auth.tenantId, SOURCE_TYPE, t.id]);
          result.already_converted.push({ ...ref, action_item_id: a?.id ?? null, status: a?.status ?? null, deleted: false });
        } else {
          result.created.push({ ...ref, action_item_id: itemId });
        }
      } catch (err) {
        await run('ROLLBACK TO plan_task');
        await run('RELEASE plan_task');
        result.failed.push({ ...ref, reason: err.message || 'Could not be saved' });
      }
    }
    if (result.created.length) {
      await addThread(auth.tenantId, sub.id, auth.userId, 'converted',
        `${result.created.length} task(s) → action items for ${reviewer.name} to validate`);
    }
  });

  // Each new item joins the deadline ladder and the audit trail like one made by hand.
  for (const c of result.created) {
    const item = await get('SELECT * FROM action_items WHERE id = ?', [c.action_item_id]);
    await syncDeadline(auth.tenantId, item);
    await run(
      `INSERT INTO audit_logs (id, tenant_id, actor_id, actor_name, entity, entity_id, action, before_json, after_json, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), auth.tenantId, auth.userId, auth.name ?? await userName(auth.userId), 'action_item', item.id, 'create',
        null, JSON.stringify(item), null, nowIso()],
    );
  }
  await auditAs(auth, sub.id, 'convert_to_action_items', null, {
    created: result.created.map((c) => ({ task: c.task, action_item_id: c.action_item_id })),
    already_converted: result.already_converted.length,
    skipped: result.skipped.length,
    failed: result.failed.length,
    assignee_id: sub.user_id,
    reviewer_id: reviewer.id,
  });

  // The assignee and the validator hear about it, unless they are the one who did it.
  if (result.created.length) {
    const s = await settingsFor(auth.tenantId);
    for (const rid of [...new Set([sub.user_id, reviewer.id])].filter((x) => x !== auth.userId)) {
      const recipient = await userRow(rid);
      if (recipient) {
        await tell(auth.tenantId, recipient, EVENTS.converted, {
          person: await userName(auth.userId), count: result.created.length, todo_date: sub.todo_date,
          todo_day: dayLabel(sub.todo_date), employee: assignee.name, reviewer: reviewer.name,
        }, null, s, `/action-items?source_plan_id=${sub.id}`);
      }
    }
  }

  return { ...result, plan: await detail(auth, await get('SELECT * FROM todo_submissions WHERE id = ?', [sub.id])) };
}

/**
 * Every approved plan whose day has not passed and that still holds a task
 * that could be an action item, converted on behalf of whoever approved it.
 * Only plans with something to do are touched, so a quiet minute costs one
 * query; a plan that cannot convert (its reporting person left, say) is left
 * for the plan to explain and is tried again on the next tick.
 */
export async function convertApproved(tenantId, today) {
  const plans = await all(
    `SELECT s.* FROM todo_submissions s
      WHERE s.tenant_id = ? AND s.status = 'APPROVED' AND s.todo_date >= ?
        AND EXISTS (SELECT 1 FROM todo_tasks t
                     WHERE t.submission_id = s.id AND t.done_at IS NULL AND t.carried_to_date IS NULL
                       AND LENGTH(TRIM(t.task)) >= 2
                       AND NOT EXISTS (SELECT 1 FROM action_items a WHERE a.tenant_id = s.tenant_id
                                         AND a.source_type = ? AND a.source_id = t.id))`,
    [tenantId, today, SOURCE_TYPE],
  );
  let n = 0;
  for (const sub of plans) {
    const actor = await get(
      "SELECT * FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND status = 'active'",
      [sub.reviewed_by || sub.reporting_person_id, tenantId],
    );
    if (!actor) continue;
    const auth = {
      userId: actor.id, tenantId, name: actor.name, role: actor.role, customRoleId: actor.custom_role_id,
    };
    try {
      n += (await convertPlan(auth, sub.id)).created.length;
    } catch {
      // Shown on the plan itself (conversion.problem); nothing to do here.
    }
  }
  return n;
}
