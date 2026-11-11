import { Router } from 'express';
import { z } from 'zod';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso, parseJson } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, conflict, forbidden, audit } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { DUE_DATE_RE, DUE_TIME_RE, formatDue } from '../lib/dueTime.js';
import { notifyMany } from '../services/notifications.js';
import { createActionItem, validateTaskBody } from './actionItems.routes.js';

/**
 * Task requests: someone asks to take a task on themselves.
 *
 * Only owners and managers hand work to other people, so an employee who wants
 * a task of their own on the board - with a due date, reminders and a sign-off -
 * asks for it here. It goes to their reporting manager and, when it is for a
 * project, that project's manager and lead. Any one of them approves or rejects
 * it; approval creates an ordinary task owned by the requester and raised by the
 * approver. Private to-dos on My Day need no approval and do not come through here.
 */
export const taskRequestsRouter = Router();

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];
const dateish = z.union([z.string().regex(DUE_DATE_RE, 'Use a date like 2026-09-03'), z.literal('')]).optional().nullable();
const timeish = z.union([z.string().regex(DUE_TIME_RE, 'Use a time like 16:00'), z.literal('')]).optional().nullable();

const requestSchema = z.object({
  title: z.string().trim().min(2, 'Say what the task is').max(240),
  description: z.string().max(8000).optional().nullable(),
  project_id: z.string().optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
  due_date: dateish,
  due_time: timeish,
});

const decisionSchema = z.object({
  /** The approver may edit the request before approving it: wording, priority and timing. */
  title: z.string().trim().min(2, 'Say what the task is').max(240).optional(),
  description: z.string().max(8000).optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
  due_date: dateish,
  due_time: timeish,
  note: z.string().trim().max(1000).optional().nullable(),
});

const SELECT = `
  SELECT r.*, u.name AS requester_name, u.designation AS requester_designation, u.avatar_url AS requester_avatar,
         p.name AS project_name, d.name AS decided_by_name
    FROM task_requests r
    JOIN users u ON u.id = r.requester_id
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN users d ON d.id = r.decided_by`;

/** The approver list, with names, on every row the API returns. */
async function hydrate(tenantId, rows) {
  const ids = [...new Set(rows.flatMap((r) => parseJson(r.approver_ids, [])))];
  const people = ids.length ? await all(
    `SELECT id, name FROM users WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')})`, [tenantId, ...ids],
  ) : [];
  const name = Object.fromEntries(people.map((p) => [p.id, p.name]));
  return rows.map((r) => {
    const approverIds = parseJson(r.approver_ids, []);
    return {
      ...r, approver_ids: approverIds, approvers: approverIds.map((id) => ({ id, name: name[id] || 'Former member' })),
      approved_changes: r.approved_changes ? parseJson(r.approved_changes, null) : null,
    };
  });
}

/**
 * Who decides: the requester's reporting manager, plus the project's manager and
 * lead when it is for a project. Nobody in those seats: the workspace owners.
 */
async function approversFor(tenantId, requesterId, projectId) {
  const ids = [];
  const me = await get('SELECT manager_id FROM users WHERE id = ? AND tenant_id = ?', [requesterId, tenantId]);
  if (me?.manager_id) ids.push(me.manager_id);
  if (projectId) {
    const p = await get('SELECT manager_id, lead_id FROM projects WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [projectId, tenantId]);
    if (!p) throw badRequest('That project was not found', [{ field: 'project_id', message: 'Choose one of your projects' }]);
    ids.push(p.manager_id, p.lead_id);
    const seats = await all(
      `SELECT user_id FROM project_members WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL AND seat IN ('manager', 'lead')`,
      [tenantId, projectId],
    );
    ids.push(...seats.map((s) => s.user_id));
  }
  const active = async (list) => {
    const unique = [...new Set(list.filter((id) => id && id !== requesterId))];
    if (!unique.length) return [];
    return (await all(
      `SELECT id FROM users WHERE tenant_id = ? AND id IN (${unique.map(() => '?').join(',')})
         AND deleted_at IS NULL AND status = 'active' AND role != 'client'`,
      [tenantId, ...unique],
    )).map((u) => u.id);
  };
  let approvers = await active(ids);
  if (!approvers.length) {
    approvers = await active((await all(
      "SELECT id FROM users WHERE tenant_id = ? AND role = 'owner' AND deleted_at IS NULL", [tenantId],
    )).map((u) => u.id));
  }
  return approvers;
}

const mayDecide = (auth, request) => request.requester_id !== auth.userId
  && (auth.role === 'owner' || auth.role === 'super_admin' || parseJson(request.approver_ids, []).includes(auth.userId));

const reviewFilter = (auth) => (auth.role === 'owner' || auth.role === 'super_admin'
  ? { sql: 'r.requester_id != ?', params: [auth.userId] }
  : { sql: "r.requester_id != ? AND r.approver_ids LIKE ?", params: [auth.userId, `%"${auth.userId}"%`] });

// ------------------------------------------------------------------- read
/** `box=mine` (default): what I asked for. `box=review`: what is waiting on me. */
taskRequestsRouter.get('/', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const box = req.query.box === 'review' ? 'review' : 'mine';
  const where = ['r.tenant_id = ?'];
  const params = [tenantId];
  if (box === 'mine') { where.push('r.requester_id = ?'); params.push(userId); } else {
    const f = reviewFilter(req.auth);
    where.push(f.sql); params.push(...f.params);
  }
  const status = String(req.query.status || (box === 'review' ? 'pending' : ''));
  if (status && status !== 'all') { where.push('r.status = ?'); params.push(status); }
  const rows = await all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 200`, params);
  return ok(res, await hydrate(tenantId, rows));
});

/** The badge count: requests waiting on me. */
taskRequestsRouter.get('/count', requires('action_items', 'view'), async (req, res) => {
  const f = reviewFilter(req.auth);
  const n = await get(`SELECT COUNT(*) AS n FROM task_requests r WHERE r.tenant_id = ? AND r.status = 'pending' AND ${f.sql}`,
    [req.auth.tenantId, ...f.params]);
  return ok(res, { review: Number(n?.n || 0) });
});

/** The projects a request can be for: the ones the caller is on. */
taskRequestsRouter.get('/projects', requires('action_items', 'view'), async (req, res) => {
  return ok(res, await all(
    `SELECT DISTINCT p.id, p.name FROM projects p
       JOIN project_members pm ON pm.project_id = p.id AND pm.deleted_at IS NULL AND pm.user_id = ?
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.status IN ('planned', 'active', 'on_hold')
      ORDER BY p.name`,
    [req.auth.userId, req.auth.tenantId],
  ));
});

// ----------------------------------------------------------------- create
taskRequestsRouter.post('/', requires('action_items', 'create'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(requestSchema, req.body);
  if (body.project_id) {
    const onIt = await get('SELECT 1 AS x FROM project_members WHERE tenant_id = ? AND project_id = ? AND user_id = ? AND deleted_at IS NULL',
      [tenantId, body.project_id, userId]);
    if (!onIt) throw badRequest('You can only request tasks on projects you are part of', [{ field: 'project_id', message: 'Choose one of your projects' }]);
  }
  const approvers = await approversFor(tenantId, userId, body.project_id);
  if (!approvers.length) throw badRequest('There is nobody to approve this yet. Ask the workspace owner to set your reporting manager.');

  const id = uuid();
  const ts = nowIso();
  await run(
    `INSERT INTO task_requests (id, tenant_id, requester_id, title, description, project_id, priority,
       due_date, due_time, approver_ids, status, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?, 'pending', ?, ?)`,
    [id, tenantId, userId, body.title, body.description || null, body.project_id || null, body.priority || 'medium',
      body.due_date || null, body.due_date ? (body.due_time || null) : null, JSON.stringify(approvers), ts, ts],
  );
  await audit(req, { entity: 'task_request', entityId: id, action: 'create', after: { title: body.title, approvers } });
  await notifyMany({
    tenantId, userIds: approvers, eventKey: 'task_request.submitted',
    vars: {
      person: req.auth.name, title: body.title,
      due_line: body.due_date ? `Wanted by ${formatDue(body.due_date, body.due_time)}.` : 'No due date given.',
    },
    link: '/action-items?tab=requests',
  }).catch(() => {});

  const [row] = await hydrate(tenantId, [await get(`${SELECT} WHERE r.id = ?`, [id])]);
  return created(res, row);
});

async function pendingOr404(req) {
  const row = await get('SELECT * FROM task_requests WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!row) throw notFound('Task request');
  if (row.status !== 'pending') {
    throw conflict(row.status === 'withdrawn' ? 'This request was withdrawn' : 'Someone has already decided this request');
  }
  return row;
}

// --------------------------------------------------------------- decisions
taskRequestsRouter.post('/:id/approve', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const request = await pendingOr404(req);
  if (!mayDecide(req.auth, request)) throw forbidden('Only the manager or lead this was sent to can approve it');
  const body = validate(decisionSchema, req.body);

  // Claim it first, so two approvers clicking at once make one task, not two.
  const ts = nowIso();
  const claimed = await run(
    `UPDATE task_requests SET status = 'approved', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
    [userId, ts, body.note || null, ts, request.id, tenantId],
  );
  if (!claimed.changes) throw conflict('Someone has already decided this request');

  const dueDate = body.due_date !== undefined ? (body.due_date || null) : request.due_date;
  const dueTime = dueDate ? (body.due_time !== undefined ? (body.due_time || null) : request.due_time) : null;
  // What actually goes on their list, after any edits by the approver.
  const final = {
    title: body.title ?? request.title,
    description: body.description !== undefined ? (body.description?.trim() || null) : (request.description || null),
    priority: body.priority || request.priority,
    due_date: dueDate || null,
    due_time: dueTime || null,
  };
  const changes = Object.fromEntries(Object.entries(final)
    .filter(([k, v]) => (v ?? null) !== (request[k] ?? null))
    .map(([k, v]) => [k, { from: request[k] ?? null, to: v }]));
  const edited = Object.keys(changes).length > 0;
  let item;
  try {
    const task = validateTaskBody({
      title: final.title,
      description: final.description,
      owner_id: request.requester_id,
      project_id: request.project_id || null,
      priority: final.priority,
      due_date: final.due_date || '',
      due_time: final.due_date ? (final.due_time || '') : '',
    });
    task.source_type = 'task_request';
    task.source_id = request.id;
    item = await createActionItem(req, task, {
      notify: { eventKey: 'task_request.approved', vars: { person: req.auth.name, changes: edited ? ' with some changes' : '' } },
    });
  } catch (e) {
    await run("UPDATE task_requests SET status = 'pending', decided_by = NULL, decided_at = NULL, decision_note = NULL WHERE id = ?",
      [request.id]);
    throw e;
  }
  // The request now reads as approved; what it said before is kept in approved_changes.
  await run(
    `UPDATE task_requests SET action_item_id = ?, title = ?, description = ?, priority = ?, due_date = ?, due_time = ?,
       approved_changes = ? WHERE id = ?`,
    [item.id, final.title, final.description, final.priority, final.due_date, final.due_time,
      edited ? JSON.stringify(changes) : null, request.id],
  );
  await audit(req, {
    entity: 'task_request', entityId: request.id, action: 'approve',
    after: { action_item_id: item.id, ...(edited ? { changes } : {}) },
  });

  const [row] = await hydrate(tenantId, [await get(`${SELECT} WHERE r.id = ?`, [request.id])]);
  return ok(res, { ...row, action_item: item });
});

taskRequestsRouter.post('/:id/reject', requires('action_items', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const request = await pendingOr404(req);
  if (!mayDecide(req.auth, request)) throw forbidden('Only the manager or lead this was sent to can reject it');
  const { note } = validate(z.object({ note: z.string().trim().min(2, 'Give a short reason').max(1000) }), req.body);
  const ts = nowIso();
  const claimed = await run(
    `UPDATE task_requests SET status = 'rejected', decided_by = ?, decided_at = ?, decision_note = ?, updated_at = ?
      WHERE id = ? AND tenant_id = ? AND status = 'pending'`,
    [userId, ts, note, ts, request.id, tenantId],
  );
  if (!claimed.changes) throw conflict('Someone has already decided this request');
  await audit(req, { entity: 'task_request', entityId: request.id, action: 'reject', after: { note } });
  await notifyMany({
    tenantId, userIds: [request.requester_id], eventKey: 'task_request.rejected',
    vars: { person: req.auth.name, title: request.title, note },
    link: '/action-items?tab=requests',
  }).catch(() => {});
  const [row] = await hydrate(tenantId, [await get(`${SELECT} WHERE r.id = ?`, [request.id])]);
  return ok(res, row);
});

/** The requester changes their mind while it is still waiting. */
taskRequestsRouter.post('/:id/withdraw', requires('action_items', 'view'), async (req, res) => {
  const request = await pendingOr404(req);
  if (request.requester_id !== req.auth.userId) throw forbidden('Only the person who asked can withdraw it');
  const ts = nowIso();
  await run("UPDATE task_requests SET status = 'withdrawn', updated_at = ? WHERE id = ? AND status = 'pending'", [ts, request.id]);
  await audit(req, { entity: 'task_request', entityId: request.id, action: 'withdraw' });
  return ok(res, { id: request.id, status: 'withdrawn' });
});
