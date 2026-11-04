import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso, todayIso, parseJson, toCsv } from '../lib/util.js';
import {
  ok, created, validate, notFound, badRequest, forbidden, unprocessable, audit, paginate, pageMeta,
  sortClause,
} from '../lib/http.js';
import {
  DEFAULT_TZ, DUE_DATE_RE, DUE_TIME_RE, dueAtIso, todayInTz, timeInTz, formatDueTime, formatDue,
} from '../lib/dueTime.js';
import { requires, can } from '../middleware/rbac.js';
import { scopeFilter } from '../middleware/auth.js';
import { upsertDeadline, resolveDeadline, resolveEscalations, raiseEscalation } from '../services/deadlines.js';
import { notifyMany } from '../services/notifications.js';
import { emitWebhook } from '../services/webhooks.js';

const router = Router();

const STATUSES = ['open', 'in_progress', 'blocked', 'done', 'cancelled'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const itemSchema = z.object({
  title: z.string().min(2).max(240),
  description: z.string().max(8000).optional().nullable(),
  /** The one person accountable. Everything downstream - the reminder ladder,
   *  the escalation target, the overdue counters - reads this one column. */
  owner_id: z.string().optional().nullable(),
  /** Everyone else working the task. The owner is implicit and never needs
   *  listing here; sending an empty array clears the extras. */
  assignee_ids: z.array(z.string()).max(40).optional(),
  /** Staff the task from a project team in one go: every seated member becomes
   *  an assignee, and `owner_id` names which of them answers for it. */
  assign_from_project_id: z.string().optional().nullable(),
  client_id: z.string().optional().nullable(),
  project_id: z.string().optional().nullable(),
  category_id: z.string().optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(STATUSES).optional(),
  /** The workspace-local day it is wanted by. */
  due_date: z.union([z.string().regex(DUE_DATE_RE, 'Use a date like 2026-09-03'), z.literal('')])
    .optional().nullable(),
  /** The workspace-local time on that day, 24-hour. Optional except today. */
  due_time: z.union([z.string().regex(DUE_TIME_RE, 'Use a time like 16:00'), z.literal('')])
    .optional().nullable(),
  recurrence: z.enum(['none', 'daily', 'weekly', 'monthly']).optional().nullable(),
  recurrence_until: z.string().optional().nullable(),
  estimate_minutes: z.number().int().min(0).optional().nullable(),
  watchers: z.array(z.string()).optional(),
  // 'advance_planner' is written only by the plan conversion: a forged link
  // would claim a planner task and stop the real conversion of it.
  source_type: z.string().refine((s) => s !== 'advance_planner', 'That source is set by the Advance Planner only')
    .optional().nullable(),
  source_id: z.string().optional().nullable(),
  sop_id: z.string().optional().nullable(),
  blocked_reason: z.string().optional().nullable(),
});

const SORTS = {
  // Sorting by "due" means by the moment it is due, so two tasks on the same
  // day come back in the order they are actually wanted.
  due_date: 'a.due_at',
  due_at: 'a.due_at',
  created_at: 'a.created_at',
  updated_at: 'a.updated_at',
  priority: `CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
  title: 'a.title',
  status: 'a.status',
};

const SELECT = `
  SELECT a.*, u.name AS owner_name, u.avatar_url AS owner_avatar, u.designation AS owner_designation,
         cb.name AS created_by_name, cb.avatar_url AS created_by_avatar,
         cpb.name AS completed_by_name, cpb.avatar_url AS completed_by_avatar,
         vb.name AS validated_by_name,
         c.name AS client_name, ac.name AS category_name, ac.color AS category_color,
         p.name AS project_name,
         (SELECT COUNT(*) FROM action_assignees aa WHERE aa.action_item_id = a.id) AS extra_assignee_count,
         (SELECT COUNT(*) FROM comments cm WHERE cm.entity = 'action_item' AND cm.entity_id = a.id AND cm.deleted_at IS NULL) AS comment_count,
         (SELECT COUNT(*) FROM attachments at WHERE at.entity = 'action_item' AND at.entity_id = a.id AND at.deleted_at IS NULL) AS attachment_count
    FROM action_items a
    LEFT JOIN users u ON u.id = a.owner_id
    LEFT JOIN users cb ON cb.id = a.created_by
    LEFT JOIN users cpb ON cpb.id = a.completed_by
    LEFT JOIN users vb ON vb.id = a.validated_by
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN projects p ON p.id = a.project_id
    LEFT JOIN action_categories ac ON ac.id = a.category_id`;

// ======================================================== DUE DATE + TIME
/** The workspace clock. Every due-time rule is read against this, not the
 *  server's timezone and not the browser's. */
const tzOf = (req) => req.tenant?.timezone || DEFAULT_TZ;

/**
 * Works out the three due columns from whatever the caller sent, and enforces
 * the two rules that only bite on the day somebody is standing in:
 *
 *  - a task due *today* has to say what time today, because "today" on its own
 *    is not a plan once the morning is gone; and
 *  - that time cannot already have passed.
 *
 * A future day may carry a time or not - both are ordinary - and a past day is
 * left alone entirely, because backdating is how work that was always late gets
 * recorded honestly. The rules are checked only when the due date or time is
 * actually changing, so editing the priority of a task whose 4pm slot went by
 * an hour ago is not blocked by a field nobody touched.
 *
 * Returns a patch of the three columns, or `{}` when neither was sent.
 */
function resolveDue(req, body, before = null) {
  const touchesDate = body.due_date !== undefined;
  const touchesTime = body.due_time !== undefined;
  if (!touchesDate && !touchesTime) return {};

  const tz = tzOf(req);
  const dueDate = (touchesDate ? body.due_date : before?.due_date) || null;
  const dueTime = (touchesTime ? body.due_time : before?.due_time) || null;

  // No date means no deadline at all - a stray time would be a time on nothing.
  if (!dueDate) return { due_date: null, due_time: null, due_at: null };

  const changed = !before
    || dueDate !== (before.due_date || null)
    || dueTime !== (before.due_time || null);

  if (changed && dueDate === todayInTz(tz)) {
    const now = timeInTz(tz);
    if (!dueTime) {
      throw unprocessable('Validation failed', [{
        field: 'due_time',
        message: 'A task due today needs a time — say when today it is wanted by',
      }]);
    }
    // 'HH:MM' on a 24-hour clock compares correctly as plain text.
    if (dueTime < now) {
      throw unprocessable('Validation failed', [{
        field: 'due_time',
        message: `${formatDueTime(dueTime)} has already passed — it is ${formatDueTime(now)} now`,
      }]);
    }
  }

  return { due_date: dueDate, due_time: dueTime, due_at: dueAtIso(dueDate, dueTime, tz) };
}

/**
 * Overdue is a question about an instant, never about a day: a task due at 4pm
 * is late at 4:01pm, and one due "Tuesday" is late once Tuesday is out. Both
 * fall out of the same comparison because an untimed task stores the end of its
 * own day as its instant.
 */
const OVERDUE_SQL = "a.due_at IS NOT NULL AND a.due_at < ? AND a.status NOT IN ('done','cancelled')";

/** SQL that is true when :user is on the task, as owner or as an extra. */
const IS_ASSIGNED = `(a.owner_id = ? OR EXISTS (
  SELECT 1 FROM action_assignees aa WHERE aa.action_item_id = a.id AND aa.user_id = ?))`;

/**
 * The whole team on a task: the accountable owner first, then everyone else,
 * so the UI never has to merge two lists or decide who leads.
 */
async function assigneesOf(tenantId, item) {
  const rows = (await all(
    `SELECT aa.user_id, u.name, u.avatar_url, u.designation, u.email, ab.name AS assigned_by_name,
            aa.created_at AS assigned_at
       FROM action_assignees aa
       JOIN users u ON u.id = aa.user_id
       LEFT JOIN users ab ON ab.id = aa.assigned_by
      WHERE aa.tenant_id = ? AND aa.action_item_id = ?
      ORDER BY u.name`,
    [tenantId, item.id],
  )).filter((r) => r.user_id !== item.owner_id);

  const owner = item.owner_id
    ? await get('SELECT id AS user_id, name, avatar_url, designation, email FROM users WHERE id = ?', [item.owner_id])
    : null;

  return [
    ...(owner ? [{ ...owner, accountable: true }] : []),
    ...rows.map((r) => ({ ...r, accountable: false })),
  ];
}

/** Everyone assigned, as plain ids - for notifications and update checks. */
const assigneeIds = async (tenantId, itemId, ownerId) => [...new Set([
  ownerId,
  ...(await all('SELECT user_id FROM action_assignees WHERE tenant_id = ? AND action_item_id = ?',
    [tenantId, itemId])).map((r) => r.user_id),
].filter(Boolean))];

/**
 * Replaces the extra-assignee list. The owner is never stored here: they are
 * already accountable through `owner_id`, and holding them in both places is
 * how the two would eventually disagree.
 */
async function setAssignees(req, itemId, userIds, ownerId) {
  const { tenantId, userId } = req.auth;
  const wanted = [...new Set(userIds.filter((id) => id && id !== ownerId))];

  if (wanted.length) {
    const real = (await all(
      `SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client'
         AND id IN (${wanted.map(() => '?').join(',')})`,
      [tenantId, ...wanted],
    )).map((u) => u.id);
    const missing = wanted.filter((id) => !real.includes(id));
    if (missing.length) throw badRequest('One of those people is not in this workspace');
  }

  await run('DELETE FROM action_assignees WHERE action_item_id = ? AND tenant_id = ?', [itemId, tenantId]);
  for (const id of wanted) {
    await run(
      `INSERT INTO action_assignees (id, tenant_id, action_item_id, user_id, assigned_by, created_at)
       VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [uuid(), tenantId, itemId, id, userId, nowIso()],
    );
  }
  return wanted;
}

/** Everyone seated on a project, for "assign this to the delivery team". */
const projectTeamIds = async (tenantId, projectId) => (await all(
  `SELECT pm.user_id FROM project_members pm
     JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
    WHERE pm.tenant_id = ? AND pm.project_id = ? AND pm.deleted_at IS NULL`,
  [tenantId, projectId],
)).map((r) => r.user_id);

/** Tells people they have been put on a task. Never the person doing it. */
async function notifyAssigned(req, item, userIds) {
  const targets = userIds.filter((id) => id && id !== req.auth.userId);
  if (!targets.length) return;
  await notifyMany({
    tenantId: req.auth.tenantId,
    userIds: targets,
    eventKey: 'action_item.assigned',
    vars: {
      title: item.title,
      priority: item.priority,
      due_date: item.due_date || 'no date',
      due_time: formatDueTime(item.due_time),
      /** Date and time in one phrase, for templates that want the whole thing. */
      due: formatDue(item.due_date, item.due_time),
      assigned_by: req.auth.name,
    },
    link: `/action-items?open=${item.id}`,
  }).catch(() => {});
}

// ==================================================== CREATOR VALIDATION
/**
 * Done is not the end of a task. When the assignee marks an item done it goes
 * to whoever raised it for sign-off: approve and the task is finished, ask for
 * changes and it goes back to the assignee as live work. The rules:
 *
 *  - `status` still says 'done' while sign-off is outstanding. Everything else
 *    in the product - the deadline ladder, the daily-update chase, the overdue
 *    counters - already keys off `status`, and a task whose work is finished
 *    should not keep chasing the person who finished it. What is outstanding is
 *    the creator's review, and that is `validation_status`, not the task.
 *  - A task somebody raised for themselves needs no ceremony: it validates on
 *    the spot, which is also what keeps every pre-existing task behaving as it
 *    did before this workflow existed.
 */
const VALIDATION_STATES = ['pending', 'validated', 'changes_requested'];

/** Appends to the item's sign-off ledger. Append-only - never updated. */
async function logValidation(tenantId, itemId, event, actorId, note, round) {
  await run(
    `INSERT INTO action_validations (id, tenant_id, action_item_id, event, actor_id, note, round, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, itemId, event, actorId ?? null, note ?? null, round ?? 1, nowIso()],
  );
}

const validationHistory = async (tenantId, itemId) => await all(
  `SELECT v.*, u.name AS actor_name, u.avatar_url AS actor_avatar
     FROM action_validations v
     LEFT JOIN users u ON u.id = v.actor_id
    WHERE v.tenant_id = ? AND v.action_item_id = ?
    ORDER BY v.created_at, v.seq`,
  [tenantId, itemId],
);

/**
 * Who may rule on a completed task: the person who raised it, full stop.
 *
 * The one exception is a creator who has since left the workspace - somebody
 * with the approval right closes the loop instead, because the alternative is
 * work that can never be signed off.
 */
async function canValidate(auth, item) {
  if (!item) return false;
  if (item.created_by && item.created_by === auth.userId) return true;
  const creatorPresent = item.created_by
    && await get('SELECT id FROM users WHERE id = ? AND deleted_at IS NULL', [item.created_by]);
  return !creatorPresent && await can(auth, 'action_items', 'approve');
}

/** Row decoration the UI needs but SQL should not be asked to compute. */
const withValidation = async (req, row) => (row ? {
  ...row,
  can_validate: row.status === 'done' && row.validation_status === 'pending' && await canValidate(req.auth, row),
  awaiting_validation: row.status === 'done' && row.validation_status === 'pending',
  // Decided once, here, against the stored instant. Every screen that shades a
  // row red reads this rather than re-deriving "late" from a date string and
  // getting a 4pm task wrong for the rest of its own afternoon.
  is_overdue: !!row.due_at && row.due_at < nowIso()
    && !['done', 'cancelled'].includes(row.status),
} : row);

/**
 * The state changes that ride along with "the assignee marked this done".
 * Returned as a patch rather than written here so the caller keeps it inside
 * its own transaction, and so bulk and single updates cannot drift apart.
 */
function completionPatch(req, before, ts) {
  const selfRaised = !before.created_by || before.created_by === req.auth.userId;
  return {
    completed_at: ts,
    completed_by: req.auth.userId,
    validation_status: selfRaised ? 'validated' : 'pending',
    validated_by: selfRaised ? req.auth.userId : null,
    validated_at: selfRaised ? ts : null,
  };
}

/** Tells the creator their sign-off is wanted. */
async function notifySubmitted(req, item) {
  if (!item.created_by || item.created_by === req.auth.userId) return;
  await notifyMany({
    tenantId: req.auth.tenantId,
    userIds: [item.created_by],
    eventKey: 'action_item.awaiting_validation',
    vars: { title: item.title, person: req.auth.name },
    link: `/action-items?open=${item.id}`,
  }).catch(() => {});
}

/** Registers the item's due date with the central deadline engine (B1). */
async function syncDeadline(tenantId, item) {
  if (['done', 'cancelled'].includes(item.status) || !item.due_date) {
    await resolveDeadline(tenantId, 'action_item', item.id, item.status === 'done' ? 'met' : 'cancelled');
    return;
  }
  const category = item.category_id
    ? await get('SELECT escalation_days FROM action_categories WHERE id = ?', [item.category_id])
    : null;
  const owner = item.owner_id ? await get('SELECT manager_id FROM users WHERE id = ?', [item.owner_id]) : null;
  const client = item.client_id ? await get('SELECT name FROM clients WHERE id = ?', [item.client_id]) : null;

  await upsertDeadline({
    tenantId,
    sourceType: 'action_item',
    sourceId: item.id,
    title: item.title,
    // The instant, not the day: a task due at 4pm has to reach the ladder as
    // 4pm or the reminder before it and the breach after it both land wrong.
    dueAt: item.due_at || item.due_date,
    ownerId: item.owner_id,
    escalateToId: owner?.manager_id,
    escalationDays: category?.escalation_days ?? 3,
    severity: item.priority === 'urgent' ? 'high' : 'normal',
    meta: {
      priority: item.priority,
      client: client?.name,
      // Tells the ladder whether this deadline names a time somebody chose or
      // just the end of a day, which is what separates a 30-minute warning
      // from a three-day one.
      timed: !!item.due_time,
      due_date: item.due_date,
      due_time: item.due_time || null,
    },
  });
}

// ------------------------------------------------------------------ list
router.get('/', requires('action_items', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const { page, limit, offset } = paginate(req);
  const filters = ['a.tenant_id = ?', 'a.deleted_at IS NULL'];
  const params = [tenantId];

  const scope = await scopeFilter(req, 'a.owner_id');
  if (scope.where) {
    // Employees also see items they are assigned to alongside someone else,
    // plus anything they watch or raised themselves.
    filters.push(`(${scope.where}
      OR a.created_by = ?
      OR EXISTS (SELECT 1 FROM action_assignees aa WHERE aa.action_item_id = a.id AND aa.user_id = ?)
      OR a.id IN (SELECT action_item_id FROM action_watchers WHERE user_id = ?))`);
    params.push(...scope.params, req.auth.userId, req.auth.userId, req.auth.userId);
  }

  const q = req.query;
  if (q.status) { const s = String(q.status).split(','); filters.push(`a.status IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  // The working list and the completed list are two different questions, and
  // an item the assignee has marked done belongs to the second one from that
  // moment - not once the creator gets round to signing it off.
  if (q.bucket === 'active') filters.push("a.status != 'done'");
  if (q.bucket === 'completed') filters.push("a.status = 'done'");
  if (q.validation) {
    const s = String(q.validation).split(',');
    filters.push(`a.validation_status IN (${s.map(() => '?').join(',')})`);
    params.push(...s);
  }
  // "Waiting on me to sign off" - the queue belonging to whoever raised them.
  if (q.to_validate === 'true') {
    filters.push("a.status = 'done' AND a.validation_status = 'pending' AND a.created_by = ?");
    params.push(req.auth.userId);
  }
  if (q.priority) { const s = String(q.priority).split(','); filters.push(`a.priority IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (q.owner_id) { filters.push('a.owner_id = ?'); params.push(q.owner_id); }
  // "On my plate" - accountable for it, or working it with someone else.
  if (q.assigned_to) { filters.push(IS_ASSIGNED); params.push(q.assigned_to, q.assigned_to); }
  if (q.assigned_to_me === 'true') { filters.push(IS_ASSIGNED); params.push(req.auth.userId, req.auth.userId); }
  if (q.needs_update === 'true') {
    filters.push(`a.status NOT IN ('done','cancelled') AND ${IS_ASSIGNED}
      AND NOT EXISTS (SELECT 1 FROM action_updates au WHERE au.action_item_id = a.id
                        AND au.user_id = ? AND au.update_date = ? AND au.deleted_at IS NULL)`);
    params.push(req.auth.userId, req.auth.userId, req.auth.userId, todayIso());
  }
  if (q.client_id) { filters.push('a.client_id = ?'); params.push(q.client_id); }
  if (q.project_id) { filters.push('a.project_id = ?'); params.push(q.project_id); }
  // Everything made from one Advance Planner plan - the plan's "view in Action Items" link.
  if (q.source_plan_id) { filters.push('a.source_plan_id = ?'); params.push(q.source_plan_id); }
  if (q.category_id) { filters.push('a.category_id = ?'); params.push(q.category_id); }
  if (q.due_before) { filters.push('a.due_date <= ?'); params.push(q.due_before); }
  if (q.due_after) { filters.push('a.due_date >= ?'); params.push(q.due_after); }
  if (q.overdue === 'true') { filters.push(OVERDUE_SQL); params.push(nowIso()); }
  if (q.escalated === 'true') filters.push('a.escalation_level > 0');
  if (q.search) { filters.push('(a.title LIKE ? OR a.description LIKE ?)'); params.push(`%${q.search}%`, `%${q.search}%`); }

  const where = filters.join(' AND ');
  const order = sortClause(req, SORTS, "a.due_at IS NULL, a.due_at ASC, CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END");
  const total = Number((await get(`SELECT COUNT(*) AS n FROM action_items a WHERE ${where}`, params))?.n || 0);
  const rows = await all(`${SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);

  return ok(res, await Promise.all(rows.map(async (r) => await withValidation(req, r))), {
    ...pageMeta(page, limit, total),
    summary: await get(
      `SELECT COUNT(*) AS total,
              COUNT(CASE WHEN a.status = 'open' THEN 1 END) AS open,
              COUNT(CASE WHEN a.status = 'in_progress' THEN 1 END) AS in_progress,
              COUNT(CASE WHEN a.status = 'blocked' THEN 1 END) AS blocked,
              COUNT(CASE WHEN a.status = 'done' THEN 1 END) AS done,
              COUNT(CASE WHEN a.status = 'done' AND a.validation_status = 'pending' THEN 1 END) AS awaiting_validation,
              COUNT(CASE WHEN a.validation_status = 'validated' THEN 1 END) AS validated,
              COUNT(CASE WHEN a.validation_status = 'changes_requested' THEN 1 END) AS changes_requested,
              COUNT(CASE WHEN ${OVERDUE_SQL} THEN 1 END) AS overdue
         FROM action_items a WHERE ${where}`,
      [nowIso(), ...params],
    ),
    // Deliberately outside the filters: the sign-off badge has to read the same
    // on every tab, or it stops being something anyone trusts.
    my_validation_queue: Number((await get(
      `SELECT COUNT(*) AS n FROM action_items a
        WHERE a.tenant_id = ? AND a.deleted_at IS NULL AND a.created_by = ?
          AND a.status = 'done' AND a.validation_status = 'pending'`,
      [tenantId, req.auth.userId],
    ))?.n || 0),
  });
});

router.get('/export', requires('action_items', 'export'), async (req, res) => {
  const rows = (await all(
    `${SELECT} WHERE a.tenant_id = ? AND a.deleted_at IS NULL ORDER BY a.due_at`,
    [req.auth.tenantId],
  )).map((r) => ({
    title: r.title, status: r.status, priority: r.priority, due_date: r.due_date,
    due_time: r.due_time ? formatDueTime(r.due_time) : '',
    owner: r.owner_name, client: r.client_name, category: r.category_name,
    completed_at: r.completed_at, escalation_level: r.escalation_level,
  }));
  await audit(req, { entity: 'action_item', action: 'export', after: { count: rows.length } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="action-items.csv"');
  return res.send(toCsv(rows));
});

// ======================================================== A: DAILY UPDATES
/**
 * The daily update is the standup written down: what moved today, what is
 * moving, what has not started, what is in the way, and what happens next.
 *
 * One row per person per task per day, upserted - somebody who logs at noon and
 * again at six has one update for the day, not two. `update_date` is the day
 * being reported on, which is why it is a date and not derived from created_at:
 * writing up yesterday at 9am tomorrow should still land on yesterday.
 */
const UPDATE_SELECT = `
  SELECT au.*, u.name AS user_name, u.avatar_url, u.designation,
         a.title AS task_title, a.status AS task_status, a.priority,
         a.due_date, a.due_time, a.due_at,
         a.owner_id, c.name AS client_name
    FROM action_updates au
    JOIN users u ON u.id = au.user_id
    JOIN action_items a ON a.id = au.action_item_id
    LEFT JOIN clients c ON c.id = a.client_id`;

const updatesForItem = async (tenantId, itemId) => await all(
  `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.action_item_id = ? AND au.deleted_at IS NULL
    ORDER BY au.update_date DESC, au.created_at DESC LIMIT 60`,
  [tenantId, itemId],
);

const updateSchema = z.object({
  update_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  completed_today: z.string().max(4000).optional().nullable(),
  in_progress: z.string().max(4000).optional().nullable(),
  pending: z.string().max(4000).optional().nullable(),
  blockers: z.string().max(4000).optional().nullable(),
  next_action: z.string().max(4000).optional().nullable(),
  remarks: z.string().max(4000).optional().nullable(),
  progress_pct: z.number().int().min(0).max(100).optional().nullable(),
  hours_spent: z.number().min(0).max(24).optional().nullable(),
  /** Moving the task on as part of writing the update, so it is one action. */
  status: z.enum(STATUSES).optional(),
});

/** The task, if this caller is on it. Only assignees write updates. */
async function assignedItemOr404(req, id) {
  const item = await get(
    'SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [id, req.auth.tenantId],
  );
  if (!item) throw notFound('Action item');
  return item;
}

router.post('/:id/updates', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const item = await assignedItemOr404(req, req.params.id);
  const body = validate(updateSchema, req.body);

  if (!(await assigneeIds(tenantId, item.id, item.owner_id)).includes(userId)) {
    throw forbidden('Only the people assigned to a task can post its daily update');
  }

  const day = body.update_date || todayIso();
  if (day > todayIso()) throw badRequest('You cannot log an update for a day that has not happened');

  const at = nowIso();
  const existing = await get(
    `SELECT * FROM action_updates WHERE tenant_id = ? AND action_item_id = ? AND user_id = ?
       AND update_date = ? AND deleted_at IS NULL`,
    [tenantId, item.id, userId, day],
  );

  // Something has to be said. An empty update is worse than none: it reads as
  // progress on the manager's board while telling them nothing. Judged on what
  // the update will hold once merged, so topping up an existing one is fine.
  const PROSE = ['completed_today', 'in_progress', 'pending', 'blockers', 'next_action', 'remarks'];
  const said = PROSE.some((k) => String(body[k] !== undefined ? body[k] : existing?.[k] ?? '').trim());
  if (!said) throw badRequest('Fill in at least one part of the update');

  // A merge, not a replace. Somebody adding a blocker at four o'clock must not
  // wipe what they wrote at ten. Omit a field to keep it; send null to clear it.
  const keep = (k) => (body[k] !== undefined ? body[k] : (existing?.[k] ?? null));
  const fields = {
    completed_today: keep('completed_today'),
    in_progress: keep('in_progress'),
    pending: keep('pending'),
    blockers: keep('blockers'),
    next_action: keep('next_action'),
    remarks: keep('remarks'),
    progress_pct: keep('progress_pct'),
    hours_spent: keep('hours_spent'),
  };

  const id = existing?.id || uuid();
  await tx(async () => {
    if (existing) {
      await run(
        `UPDATE action_updates SET completed_today = ?, in_progress = ?, pending = ?, blockers = ?,
           next_action = ?, remarks = ?, progress_pct = ?, hours_spent = ?, status_at_update = ?, updated_at = ?
         WHERE id = ?`,
        [...Object.values(fields), body.status || item.status, at, id],
      );
    } else {
      await run(
        `INSERT INTO action_updates (id, tenant_id, action_item_id, user_id, update_date,
           completed_today, in_progress, pending, blockers, next_action, remarks,
           progress_pct, hours_spent, status_at_update, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, item.id, userId, day, ...Object.values(fields),
          body.status || item.status, at, at],
      );
    }

    // Writing "I finished it" and leaving the task open is the commonest way a
    // board goes stale, so the status moves with the update when asked.
    if (body.status && body.status !== item.status) {
      const patch = { status: body.status, updated_at: at };
      if (body.status === 'done') patch.completed_at = at;
      if (body.status === 'in_progress' && !item.started_at) patch.started_at = at;
      if (body.status !== 'blocked') patch.blocked_reason = null;
      if (body.status === 'blocked') patch.blocked_reason = body.blockers || item.blocked_reason;
      await repo('action_items', tenantId).update(item.id, patch);
    }
  });

  const after = await get('SELECT * FROM action_items WHERE id = ?', [item.id]);
  if (body.status && body.status !== item.status) {
    await syncDeadline(tenantId, after);
    if (after.status === 'done') await resolveEscalations(tenantId, 'action_item', after.id, 'Item completed');
  }

  // A blocker is the one part of an update somebody else has to act on, so the
  // accountable owner and the reporting manager hear about it the same day.
  if (body.blockers?.trim()) {
    const manager = (await get('SELECT manager_id FROM users WHERE id = ?', [userId]))?.manager_id;
    await notifyMany({
      tenantId,
      userIds: [item.owner_id, manager].filter((uid) => uid && uid !== userId),
      eventKey: 'action_item.blocked_reported',
      vars: { title: item.title, person: req.auth.name, blockers: body.blockers.trim().slice(0, 300) },
      link: `/action-items?open=${item.id}`,
      dedupeKey: `blocker:${item.id}:${userId}:${day}`,
    }).catch(() => {});
  }

  await audit(req, {
    entity: 'action_update', entityId: id, action: existing ? 'update' : 'create',
    after: { action_item_id: item.id, update_date: day, status: body.status ?? null },
  });

  return (existing ? ok : created)(res, await get(`${UPDATE_SELECT} WHERE au.id = ?`, [id]));
});

/** Every update written on a task, newest first. */
router.get('/:id/updates', requires('action_items', 'view'), async (req, res) => {
  await assignedItemOr404(req, req.params.id);
  return ok(res, await updatesForItem(req.auth.tenantId, req.params.id));
});

/** Withdraw an update you wrote. Only your own, only the day it belongs to. */
router.delete('/updates/:updateId', requires('action_items', 'view'), async (req, res) => {
  const row = await get(
    'SELECT * FROM action_updates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.updateId, req.auth.tenantId],
  );
  if (!row) throw notFound('Daily update');
  if (row.user_id !== req.auth.userId) throw forbidden('You can only remove your own update');
  await run('UPDATE action_updates SET deleted_at = ? WHERE id = ?', [nowIso(), row.id]);
  await audit(req, { entity: 'action_update', entityId: row.id, action: 'delete' });
  return ok(res, { ok: true });
});

/**
 * The employee view: what is on my plate, what still owes an update today, and
 * what I have already written.
 */
router.get('/updates/mine', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIso();

  const mine = await all(
    `${SELECT} WHERE a.tenant_id = ? AND a.deleted_at IS NULL
       AND a.status NOT IN ('done','cancelled') AND ${IS_ASSIGNED}
     ORDER BY a.due_at IS NULL, a.due_at,
       CASE a.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`,
    [tenantId, userId, userId],
  );

  const logged = await all(
    `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.user_id = ? AND au.update_date = ?
       AND au.deleted_at IS NULL ORDER BY au.updated_at DESC`,
    [tenantId, userId, day],
  );
  const loggedFor = new Set(logged.map((u) => u.action_item_id));
  const today = todayInTz(tzOf(req));

  return ok(res, {
    date: day,
    tasks: mine.map((t) => ({ ...t, has_update_today: loggedFor.has(t.id) })),
    needs_update: mine.filter((t) => !loggedFor.has(t.id)),
    submitted: logged,
    /** Due today or already past it - the "today's pending work" bucket. */
    due_today: mine.filter((t) => t.due_date && t.due_date <= today),
    recent: await all(
      `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.user_id = ? AND au.update_date < ?
         AND au.deleted_at IS NULL ORDER BY au.update_date DESC, au.updated_at DESC LIMIT 30`,
      [tenantId, userId, day],
    ),
  });
});

/**
 * The manager view: for one day, everyone I am responsible for, the tasks on
 * them, and what each person said. People who wrote nothing are listed too -
 * silence is the thing a manager most needs to see.
 */
router.get('/updates/team', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIso();
  const wide = req.auth.scope === 'all';

  if (req.auth.scope === 'own') throw forbidden('Only managers and admins can review team updates');

  // Whose updates this caller may read: everybody for an admin, direct reports
  // (and themselves) for a manager.
  const people = wide
    ? await all(
      `SELECT id, name, avatar_url, designation, email FROM users
        WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'
        ORDER BY name`,
      [tenantId],
    )
    : await all(
      `SELECT id, name, avatar_url, designation, email FROM users
        WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
          AND (manager_id = ? OR id = ?) ORDER BY name`,
      [tenantId, userId, userId],
    );

  if (req.query.user_id && people.some((u) => u.id === req.query.user_id)) {
    people.splice(0, people.length, ...people.filter((u) => u.id === req.query.user_id));
  }
  const ids = people.map((u) => u.id);
  if (!ids.length) return ok(res, { date: day, people: [], summary: { updated: 0, silent: 0, blocked: 0 } });

  const placeholders = ids.map(() => '?').join(',');

  const updates = await all(
    `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.update_date = ? AND au.deleted_at IS NULL
       AND au.user_id IN (${placeholders}) ORDER BY au.updated_at DESC`,
    [tenantId, day, ...ids],
  );

  // Open work per person, so "no update" can be told apart from "nothing to
  // update on" - a quiet day with no tasks is not a missed update.
  const openTasks = await all(
    `SELECT a.id, a.title, a.status, a.priority, a.due_date, a.owner_id,
            COALESCE(aa.user_id, a.owner_id) AS assignee_id, c.name AS client_name
       FROM action_items a
       LEFT JOIN action_assignees aa ON aa.action_item_id = a.id
       LEFT JOIN clients c ON c.id = a.client_id
      WHERE a.tenant_id = ? AND a.deleted_at IS NULL AND a.status NOT IN ('done','cancelled')
        AND (a.owner_id IN (${placeholders}) OR aa.user_id IN (${placeholders}))`,
    [tenantId, ...ids, ...ids],
  );

  const byPerson = Object.fromEntries(ids.map((id) => [id, { updates: [], tasks: new Map() }]));
  for (const u of updates) byPerson[u.user_id]?.updates.push(u);
  for (const t of openTasks) {
    for (const uid of [t.owner_id, t.assignee_id]) {
      if (uid && byPerson[uid]) byPerson[uid].tasks.set(t.id, t);
    }
  }

  const rows = people.map((u) => {
    const bucket = byPerson[u.id];
    const tasks = [...bucket.tasks.values()];
    const updatedIds = new Set(bucket.updates.map((x) => x.action_item_id));
    const blockers = bucket.updates.filter((x) => x.blockers?.trim());
    const progress = bucket.updates.filter((x) => x.progress_pct != null).map((x) => x.progress_pct);

    return {
      user: u,
      open_tasks: tasks.length,
      overdue_tasks: tasks.filter((t) => t.due_date && t.due_date < todayIso()).length,
      updates: bucket.updates,
      /** What they are on but said nothing about today. */
      missing: tasks.filter((t) => !updatedIds.has(t.id)),
      blockers,
      avg_progress_pct: progress.length
        ? Math.round(progress.reduce((a, b) => a + b, 0) / progress.length) : null,
      hours_logged: bucket.updates.reduce((a, x) => a + Number(x.hours_spent || 0), 0),
      status: bucket.updates.length ? 'updated' : tasks.length ? 'silent' : 'no_open_tasks',
    };
  });

  return ok(res, {
    date: day,
    scope: wide ? 'all' : 'team',
    people: rows,
    summary: {
      people: rows.length,
      updated: rows.filter((r) => r.status === 'updated').length,
      silent: rows.filter((r) => r.status === 'silent').length,
      blocked: rows.filter((r) => r.blockers.length).length,
      updates: updates.length,
      hours_logged: Math.round(rows.reduce((a, r) => a + r.hours_logged, 0) * 10) / 10,
    },
  });
});

/** The team board as a CSV, for a weekly review that happens in a spreadsheet. */
router.get('/updates/export', requires('action_items', 'export'), async (req, res) => {
  const { tenantId } = req.auth;
  const from = req.query.from || todayIso();
  const to = req.query.to || todayIso();
  const scoped = req.auth.scope === 'all'
    ? { where: '', params: [] }
    : {
      where: `AND au.user_id IN (SELECT id FROM users WHERE tenant_id = ? AND (manager_id = ? OR id = ?))`,
      params: [tenantId, req.auth.userId, req.auth.userId],
    };

  const rows = (await all(
    `${UPDATE_SELECT} WHERE au.tenant_id = ? AND au.deleted_at IS NULL
       AND au.update_date >= ? AND au.update_date <= ? ${scoped.where}
     ORDER BY au.update_date DESC, u.name`,
    [tenantId, from, to, ...scoped.params],
  )).map((u) => ({
    date: u.update_date,
    employee: u.user_name,
    task: u.task_title,
    client: u.client_name || '',
    task_status: u.task_status,
    due_date: u.due_date || '',
    due_time: formatDueTime(u.due_time),
    completed_today: u.completed_today || '',
    in_progress: u.in_progress || '',
    pending: u.pending || '',
    blockers: u.blockers || '',
    next_action: u.next_action || '',
    remarks: u.remarks || '',
    progress_pct: u.progress_pct ?? '',
    hours_spent: u.hours_spent ?? '',
  }));

  await audit(req, { entity: 'action_update', action: 'export', after: { rows: rows.length, from, to } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="daily-updates.csv"');
  return res.send(toCsv(rows));
});

// --------------------------------------------------------------- single
router.get('/:id', requires('action_items', 'view'), async (req, res) => {
  const item = await get(`${SELECT} WHERE a.id = ? AND a.tenant_id = ? AND a.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!item) throw notFound('Action item');

  return ok(res, {
    ...await withValidation(req, item),
    /** Every submission, approval and rejection, oldest first. */
    validations: await validationHistory(req.auth.tenantId, item.id),
    assignees: await assigneesOf(req.auth.tenantId, item),
    watchers: await all(
      `SELECT w.user_id, u.name, u.avatar_url FROM action_watchers w
         JOIN users u ON u.id = w.user_id WHERE w.action_item_id = ?`,
      [item.id],
    ),
    comments: (await all(
      `SELECT c.*, u.name AS author_name, u.avatar_url FROM comments c
         JOIN users u ON u.id = c.author_id
        WHERE c.entity = 'action_item' AND c.entity_id = ? AND c.deleted_at IS NULL
        ORDER BY c.created_at`,
      [item.id],
    )).map((c) => ({ ...c, mentions: parseJson(c.mentions, []) })),
    attachments: await all(
      `SELECT * FROM attachments WHERE entity = 'action_item' AND entity_id = ? AND deleted_at IS NULL ORDER BY created_at`,
      [item.id],
    ),
    escalations: await all(
      `SELECT e.*, u.name AS to_name FROM escalations e LEFT JOIN users u ON u.id = e.to_user_id
        WHERE e.tenant_id = ? AND e.source_type = 'action_item' AND e.source_id = ? ORDER BY e.level`,
      [req.auth.tenantId, item.id],
    ),
    deadline: await get(
      "SELECT * FROM deadlines WHERE tenant_id = ? AND source_type = 'action_item' AND source_id = ?",
      [req.auth.tenantId, item.id],
    ),
    updates: await updatesForItem(req.auth.tenantId, item.id),
    /** The Advance Planner plan this was made from, for the link back. */
    source_plan: item.source_plan_id ? await get(
      `SELECT s.id, s.todo_date, u.name AS employee_name FROM todo_submissions s
         LEFT JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.tenant_id = ?`,
      [item.source_plan_id, req.auth.tenantId],
    ) || null : null,
    /** Whether this caller still owes an update on it today. */
    my_update_today: await get(
      `SELECT * FROM action_updates WHERE tenant_id = ? AND action_item_id = ? AND user_id = ?
         AND update_date = ? AND deleted_at IS NULL`,
      [req.auth.tenantId, item.id, req.auth.userId, todayIso()],
    ) || null,
  });
});

// --------------------------------------------------------------- create
router.post('/', requires('action_items', 'create'), async (req, res) => {
  const body = validate(itemSchema, req.body);
  const { tenantId, userId } = req.auth;
  const ts = nowIso();
  const id = uuid();

  // An action item is work handed to somebody else. Nobody assigns one to
  // themselves - their own to-dos live on the personal list on My Day - so
  // the creator is never the owner, and is left out when a team is pulled in.
  const fromTeam = body.assign_from_project_id
    ? (await projectTeamIds(tenantId, body.assign_from_project_id)).filter((id) => id !== userId) : [];
  if (body.assign_from_project_id && !fromTeam.length) {
    throw badRequest('That project has nobody else on its team yet - staff the project first');
  }
  const ownerId = body.owner_id || fromTeam[0];
  if (!ownerId) throw badRequest('Choose who this is assigned to');
  if (ownerId === userId) {
    throw badRequest('You cannot assign an action item to yourself - add it to your personal to-dos on My Day instead');
  }
  const extras = [...(body.assignee_ids || []), ...fromTeam].filter((id) => id !== userId);
  const due = resolveDue(req, body);

  const item = await tx(async () => {
    await run(
      `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
         project_id, category_id, priority, status, due_date, due_time, due_at, recurrence, recurrence_until,
         source_type, source_id, sop_id, estimate_minutes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, body.title, body.description ?? null, ownerId, userId,
        body.client_id ?? null, body.project_id ?? body.assign_from_project_id ?? null,
        body.category_id ?? null,
        body.priority || 'medium', body.status || 'open',
        due.due_date ?? null, due.due_time ?? null, due.due_at ?? null,
        body.recurrence ?? null, body.recurrence_until ?? null, body.source_type ?? 'manual',
        body.source_id ?? null, body.sop_id ?? null, body.estimate_minutes ?? null, ts, ts],
    );
    if (extras.length) await setAssignees(req, id, extras, ownerId);
    for (const w of body.watchers || []) {
      await run('INSERT INTO action_watchers (id, tenant_id, action_item_id, user_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
        [uuid(), tenantId, id, w, ts]);
    }
    return await get('SELECT * FROM action_items WHERE id = ?', [id]);
  });

  await syncDeadline(tenantId, item);
  await audit(req, { entity: 'action_item', entityId: id, action: 'create', after: item });
  await notifyAssigned(req, item, await assigneeIds(tenantId, id, item.owner_id));

  return created(res, await withValidation(req, await get(`${SELECT} WHERE a.id = ?`, [id])));
});

// --------------------------------------------------------------- update
router.patch('/:id', requires('action_items', 'edit'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const r = repo('action_items', tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Action item');

  const body = validate(itemSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  delete patch.watchers;
  delete patch.assignee_ids;
  delete patch.assign_from_project_id;
  // An item's link back to the planner task it came from is permanent.
  if (before.source_type === 'advance_planner') { delete patch.source_type; delete patch.source_id; }
  // The three due columns are derived together or not at all - sending a bare
  // time, or a date the caller has already missed, is settled here.
  delete patch.due_date;
  delete patch.due_time;
  Object.assign(patch, resolveDue(req, body, before));

  if (body.status && body.status !== before.status) {
    const ts = nowIso();
    // Signed-off work is closed. Reopening it is the creator's call to make -
    // otherwise "validated" would mean nothing the moment someone disagreed.
    if (before.validation_status === 'validated' && !await canValidate(req.auth, before)) {
      throw forbidden('This task has been validated by whoever raised it - only they can reopen it');
    }
    if (body.status === 'done') Object.assign(patch, completionPatch(req, before, ts));
    if (body.status !== 'done' && before.status === 'done') {
      // Pulled back out of done: the sign-off question goes away with it.
      Object.assign(patch, {
        completed_at: null, validation_status: null, validated_by: null, validated_at: null,
      });
    }
    if (body.status === 'in_progress' && !before.started_at) patch.started_at = ts;
    if (body.status !== 'blocked') patch.blocked_reason = null;
    if (body.status === 'blocked' && !body.blocked_reason && !before.blocked_reason) {
      throw badRequest('A blocked item needs a reason so the manager knows what to unblock');
    }
  }

  // The same rule as creating it: whoever raised the item cannot hand it to
  // themselves afterwards either.
  if (body.owner_id && body.owner_id !== before.owner_id && body.owner_id === userId
    && before.created_by === userId) {
    throw badRequest('You cannot assign an action item you raised to yourself');
  }
  if (body.assignee_ids?.includes(userId) && before.created_by === userId) {
    body.assignee_ids = body.assignee_ids.filter((id) => id !== userId);
  }
  const wasAssigned = await assigneeIds(tenantId, before.id, before.owner_id);
  const nextOwner = body.owner_id !== undefined ? body.owner_id : before.owner_id;
  const fromTeam = body.assign_from_project_id
    ? await projectTeamIds(tenantId, body.assign_from_project_id) : [];

  const round = (before.rework_count || 0) + 1;
  const after = await tx(async () => {
    const updated = await r.update(req.params.id, patch);
    if (patch.validation_status === 'pending') {
      await logValidation(tenantId, before.id, 'submitted', userId, null, round);
    } else if (patch.validation_status === 'validated') {
      await logValidation(tenantId, before.id, 'validated', userId,
        'Raised and completed by the same person - signed off automatically', round);
    } else if ('validation_status' in patch && patch.validation_status === null) {
      await logValidation(tenantId, before.id, 'reopened', userId, null, round);
    }
    // Re-staffing is explicit: send `assignee_ids` (or a project to pull from)
    // and the list is replaced; omit both and the team is left alone.
    if (body.assignee_ids || body.assign_from_project_id) {
      await setAssignees(req, req.params.id, [...(body.assignee_ids || []), ...fromTeam], nextOwner);
    } else if (body.owner_id && body.owner_id !== before.owner_id) {
      // A new owner must not also linger in the extras list.
      await run('DELETE FROM action_assignees WHERE action_item_id = ? AND user_id = ?',
        [req.params.id, body.owner_id]);
    }
    if (body.watchers) {
      await run('DELETE FROM action_watchers WHERE action_item_id = ?', [req.params.id]);
      for (const w of body.watchers) {
        await run('INSERT INTO action_watchers (id, tenant_id, action_item_id, user_id, created_at) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
          [uuid(), tenantId, req.params.id, w, nowIso()]);
      }
    }
    return updated;
  });

  await syncDeadline(tenantId, after);
  if (after.status === 'done' && before.status !== 'done') {
    await resolveEscalations(tenantId, 'action_item', after.id, 'Item completed');
    await emitWebhook(tenantId, 'action_item.completed', {
      id: after.id, title: after.title, owner_id: after.owner_id,
      completed_by: after.completed_by, validation_status: after.validation_status,
    });
    await notifySubmitted(req, after);
  }
  await audit(req, { entity: 'action_item', entityId: after.id, action: 'update', before, after });

  // Tell whoever is newly on the task - not the whole team every time it is
  // edited, or the notification stops meaning anything.
  const nowAssigned = await assigneeIds(tenantId, after.id, after.owner_id);
  const added = nowAssigned.filter((uid) => uid !== before.owner_id && !wasAssigned.includes(uid));
  await notifyAssigned(req, after, added);

  return ok(res, await withValidation(req, await get(`${SELECT} WHERE a.id = ?`, [after.id])));
});

// ----------------------------------------------------- creator sign-off
/**
 * The creator's ruling on completed work. Approve and the task is finished for
 * good; ask for changes and it goes back to the assignee as live work, with the
 * reason attached - a rejection with no reason is just a task bouncing.
 *
 * Guarded on three things, in this order: the item is actually waiting for a
 * ruling, the caller is the person entitled to make it, and a rejection carries
 * a reason. The middle guard is the one that matters - it is what stops an
 * assignee signing off their own work.
 */
router.post('/:id/validate', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const item = await get('SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!item) throw notFound('Action item');

  const { decision, note } = validate(z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(2000).optional().nullable(),
  }), req.body);

  if (item.status !== 'done' || item.validation_status !== 'pending') {
    throw badRequest(item.validation_status === 'validated'
      ? 'This task has already been validated'
      : 'Only a task the assignee has marked done can be validated');
  }
  if (!await canValidate(req.auth, item)) {
    throw forbidden('Only the person who raised this task can validate it');
  }
  const reason = (note || '').trim();
  if (decision === 'reject' && reason.length < 3) {
    throw badRequest('Say what needs changing - the task goes back to the assignee with this note');
  }

  const ts = nowIso();
  const round = (item.rework_count || 0) + 1;
  const r = repo('action_items', tenantId);

  const after = await tx(async () => {
    const patch = decision === 'approve'
      ? {
        validation_status: 'validated',
        validated_by: userId,
        validated_at: ts,
        validation_note: reason || null,
        updated_at: ts,
      }
      : {
        // Back to live work. `completed_by` is left standing: it is who last
        // said it was finished, and the ledger below carries the rest.
        status: 'in_progress',
        completed_at: null,
        validation_status: 'changes_requested',
        validated_by: userId,
        validated_at: ts,
        validation_note: reason,
        rework_count: round,
        started_at: item.started_at || ts,
        updated_at: ts,
      };
    await logValidation(tenantId, item.id, decision === 'approve' ? 'validated' : 'changes_requested',
      userId, reason || null, round);
    return await r.update(item.id, patch);
  });

  // A rejected task is open work again, so it goes back on the deadline ladder.
  await syncDeadline(tenantId, after);
  await emitWebhook(tenantId, decision === 'approve' ? 'action_item.validated' : 'action_item.changes_requested',
    { id: after.id, title: after.title, validated_by: userId, note: reason || null });
  await audit(req, {
    entity: 'action_item',
    entityId: after.id,
    action: 'update',
    before: item,
    after,
  });

  await notifyMany({
    tenantId,
    userIds: (await assigneeIds(tenantId, after.id, after.owner_id)).filter((id) => id !== userId),
    eventKey: decision === 'approve' ? 'action_item.validated' : 'action_item.changes_requested',
    vars: { title: after.title, person: req.auth.name, note: reason || 'no note' },
    link: `/action-items?open=${after.id}`,
  }).catch(() => {});

  return ok(res, {
    ...await withValidation(req, await get(`${SELECT} WHERE a.id = ?`, [after.id])),
    validations: await validationHistory(tenantId, after.id),
  });
});

router.delete('/:id', requires('action_items', 'delete'), async (req, res) => {
  const r = repo('action_items', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Action item');

  await r.softDelete(req.params.id, nowIso());
  await resolveDeadline(req.auth.tenantId, 'action_item', req.params.id, 'cancelled');
  await audit(req, { entity: 'action_item', entityId: req.params.id, action: 'delete', before });
  return ok(res, { ok: true });
});

// ------------------------------------------------------ manual escalation
router.post('/:id/escalate', requires('action_items', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const item = await get('SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!item) throw notFound('Action item');

  const { reason, to_user_id: toUserId } = validate(
    z.object({ reason: z.string().min(3), to_user_id: z.string().optional() }), req.body,
  );
  const owner = item.owner_id ? await get('SELECT manager_id FROM users WHERE id = ?', [item.owner_id]) : null;
  const target = toUserId || owner?.manager_id;
  if (!target) throw badRequest('No reporting manager is set for this owner - pick someone to escalate to');

  const id = await raiseEscalation({
    tenantId,
    sourceType: 'action_item',
    sourceId: item.id,
    title: item.title,
    fromUserId: req.auth.userId,
    toUserId: target,
    reason,
    link: `/action-items/${item.id}`,
  });
  await audit(req, { entity: 'action_item', entityId: item.id, action: 'update', after: { escalated_to: target, reason } });
  return ok(res, { escalation_id: id });
});

// ------------------------------------------------------------- comments
router.post('/:id/comments', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const item = await get('SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!item) throw notFound('Action item');

  const { body, mentions = [] } = validate(
    z.object({ body: z.string().min(1).max(4000), mentions: z.array(z.string()).optional() }), req.body,
  );
  const id = uuid();
  await run(
    `INSERT INTO comments (id, tenant_id, entity, entity_id, author_id, body, mentions, created_at, updated_at)
     VALUES (?,?, 'action_item', ?,?,?,?,?,?)`,
    [id, tenantId, item.id, userId, body, JSON.stringify(mentions), nowIso(), nowIso()],
  );

  // A5: @mentions notify the mentioned user.
  if (mentions.length) {
    await notifyMany({
      tenantId,
      userIds: mentions.filter((m) => m !== userId),
      eventKey: 'mention.comment',
      vars: { from: req.auth.name, entity: item.title, excerpt: body.slice(0, 120) },
      link: `/action-items/${item.id}`,
    }).catch(() => {});
  }

  return created(res, await get(
    'SELECT c.*, u.name AS author_name, u.avatar_url FROM comments c JOIN users u ON u.id = c.author_id WHERE c.id = ?',
    [id],
  ));
});

// ------------------------------------------------------- bulk operations
router.post('/bulk', requires('action_items', 'edit'), async (req, res) => {
  const { ids, patch } = validate(
    z.object({ ids: z.array(z.string()).min(1).max(200), patch: itemSchema.partial() }), req.body,
  );
  const { tenantId } = req.auth;
  const r = repo('action_items', tenantId);
  const updated = [];
  const submitted = [];
  let skipped = 0;

  await tx(async () => {
    for (const id of ids) {
      const before = await r.findById(id);
      if (!before) continue;
      const ts = nowIso();
      const fields = { ...patch, updated_at: ts };
      delete fields.watchers;
      if (before.source_type === 'advance_planner') { delete fields.source_type; delete fields.source_id; }
      // Each row is measured against its own current due date, so moving fifty
      // tasks to Friday afternoon settles fifty instants rather than one.
      delete fields.due_date;
      delete fields.due_time;
      Object.assign(fields, resolveDue(req, patch, before));
      if (patch.status && patch.status !== before.status) {
        // Signed-off work is not something a bulk action gets to reopen. One
        // item that cannot move must not fail the other ninety-nine, so it is
        // counted out and reported rather than thrown.
        if (before.validation_status === 'validated' && !await canValidate(req.auth, before)) {
          skipped += 1;
          continue;
        }
        if (patch.status === 'done') {
          Object.assign(fields, completionPatch(req, before, ts));
          await logValidation(tenantId, id, fields.validation_status === 'pending' ? 'submitted' : 'validated',
            req.auth.userId, null, (before.rework_count || 0) + 1);
        } else if (before.status === 'done') {
          Object.assign(fields, {
            completed_at: null, validation_status: null, validated_by: null, validated_at: null,
          });
          await logValidation(tenantId, id, 'reopened', req.auth.userId, null, (before.rework_count || 0) + 1);
        }
      }
      const row = await r.update(id, fields);
      updated.push(row);
      if (fields.validation_status === 'pending') submitted.push(row);
    }
  });
  for (const item of updated) await syncDeadline(tenantId, item);
  for (const item of submitted) await notifySubmitted(req, item);
  await audit(req, { entity: 'action_item', action: 'update', after: { bulk: ids.length, patch, skipped } });

  return ok(res, { updated: updated.length, skipped });
});

// ------------------------------------------------------- my work (mobile)
router.get('/me/today', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  // The workspace calendar day, not UTC's - see resolveDue above.
  const today = todayInTz(tzOf(req));
  const now = nowIso();
  const mine = `${SELECT} WHERE a.tenant_id = ? AND a.owner_id = ? AND a.deleted_at IS NULL
       AND a.status NOT IN ('done','cancelled')`;
  return ok(res, {
    // A same-day task whose time has gone by is late, not still "today" - which
    // is the whole point of having asked for a time.
    overdue: await all(`${mine} AND ${OVERDUE_SQL} ORDER BY a.due_at`, [tenantId, userId, now]),
    today: await all(`${mine} AND a.due_date = ? AND (a.due_at IS NULL OR a.due_at >= ?)
       ORDER BY a.due_at`, [tenantId, userId, today, now]),
    upcoming: await all(`${mine} AND a.due_date > ? ORDER BY a.due_at LIMIT 10`,
      [tenantId, userId, today]),
  });
});

export { router as actionItemsRouter, SELECT as ACTION_ITEM_SELECT, syncDeadline };
