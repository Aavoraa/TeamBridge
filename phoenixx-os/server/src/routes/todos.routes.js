import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo } from '../db/index.js';
import { uuid, nowIso, todayIso } from '../lib/util.js';
import { ok, created, validate, notFound, paginate, pageMeta } from '../lib/http.js';

const router = Router();

/**
 * My Day - the personal to-do list.
 *
 * These are somebody's own reminders for the day: call the client back, write
 * the EOD report. They are not company work, so they are deliberately kept
 * apart from action_items - nothing here is assigned, escalated, reported on,
 * or rolled into anyone's dashboard.
 *
 * Privacy is structural rather than a permission: every statement below pins
 * `user_id = req.auth.userId`, and there is no query parameter, role or module
 * action that widens it. An owner reading someone else's list would need a new
 * endpoint, not a new permission.
 */

const PRIORITIES = ['low', 'normal', 'high'];

const todoSchema = z.object({
  title: z.string().trim().min(1).max(200),
  todo_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // "17:30", or cleared by sending null.
  due_time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional().nullable(),
  priority: z.enum(PRIORITIES).optional(),
  status: z.enum(['pending', 'completed']).optional(),
});

/** The caller's own row, or a 404 - never another person's, whatever their role. */
async function mineOr404(req, id) {
  const row = await get(
    'SELECT * FROM personal_todos WHERE id = ? AND tenant_id = ? AND user_id = ? AND deleted_at IS NULL',
    [id, req.auth.tenantId, req.auth.userId],
  );
  if (!row) throw notFound('To-do');
  return row;
}

/** Highest priority first within a day, then by time, then by entry order. */
const ORDER = `CASE priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
               CASE WHEN due_time IS NULL THEN 1 ELSE 0 END, due_time, sort, created_at`;

/**
 * The day's list. Defaults to today; `date=` picks another day and
 * `include_carry_over=false` drops anything still open from earlier days.
 */
router.get('/', async (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIso();
  const carry = req.query.include_carry_over !== 'false';

  const rows = await all(
    `SELECT * FROM personal_todos
      WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
        AND (todo_date = ?${carry ? " OR (todo_date < ? AND status = 'pending')" : ''})
      ORDER BY todo_date, ${ORDER}`,
    carry ? [tenantId, userId, day, day] : [tenantId, userId, day],
  );

  const pending = rows.filter((t) => t.status === 'pending');
  return ok(res, rows, {
    date: day,
    pending: pending.length,
    completed: rows.filter((t) => t.status === 'completed').length,
    // Yesterday's unfinished business, counted separately so it is visible
    // rather than silently mixed into today's list.
    carried_over: pending.filter((t) => t.todo_date < day).length,
  });
});

/**
 * What is coming up after `date` (default today): open to-dos and reminders
 * saved for a later day, soonest first, so the card can show them without a
 * second screen.
 */
router.get('/upcoming', async (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.date || '')) ? String(req.query.date) : todayIso();
  return ok(res, await all(
    `SELECT * FROM personal_todos
      WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL AND status = 'pending' AND todo_date > ?
      ORDER BY todo_date, ${ORDER} LIMIT 50`,
    [tenantId, userId, day],
  ));
});

/** Everything, for the "all my to-dos" view. Still only ever the caller's own. */
router.get('/all', async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['tenant_id = ?', 'user_id = ?', 'deleted_at IS NULL'];
  const params = [req.auth.tenantId, req.auth.userId];

  if (req.query.status === 'pending' || req.query.status === 'completed') {
    filters.push('status = ?');
    params.push(req.query.status);
  }
  if (req.query.from) { filters.push('todo_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('todo_date <= ?'); params.push(req.query.to); }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM personal_todos WHERE ${where}`, params))?.n || 0);
  const rows = await all(
    `SELECT * FROM personal_todos WHERE ${where} ORDER BY todo_date DESC, ${ORDER} LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return ok(res, rows, pageMeta(page, limit, total));
});

router.post('/', async (req, res) => {
  const body = validate(todoSchema, req.body);
  const { tenantId, userId } = req.auth;
  const day = body.todo_date || todayIso();
  const at = nowIso();

  // New items land at the end of their day rather than jostling the existing
  // order; ORDER above then sorts by priority and time within that.
  const lastSort = Number((await get(
    'SELECT COALESCE(MAX(sort), 0) AS s FROM personal_todos WHERE tenant_id = ? AND user_id = ? AND todo_date = ?',
    [tenantId, userId, day],
  ))?.s || 0);

  const id = uuid();
  await run(
    `INSERT INTO personal_todos (id, tenant_id, user_id, title, todo_date, due_time, priority,
       status, sort, completed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, userId, body.title, day, body.due_time ?? null, body.priority || 'normal',
      body.status || 'pending', lastSort + 1, body.status === 'completed' ? at : null, at, at],
  );
  return created(res, await get('SELECT * FROM personal_todos WHERE id = ?', [id]));
});

router.patch('/:id', async (req, res) => {
  const before = await mineOr404(req, req.params.id);
  const body = validate(todoSchema.partial(), req.body);

  const patch = { ...body, updated_at: nowIso() };
  // Completing stamps the time; reopening clears it, so "done at" never lies.
  if (body.status && body.status !== before.status) {
    patch.completed_at = body.status === 'completed' ? nowIso() : null;
  }

  return ok(res, await repo('personal_todos', req.auth.tenantId).update(before.id, patch));
});

/** The checkbox. No body, so the caller does not have to know the current state. */
router.post('/:id/toggle', async (req, res) => {
  const before = await mineOr404(req, req.params.id);
  const next = before.status === 'completed' ? 'pending' : 'completed';
  await run('UPDATE personal_todos SET status = ?, completed_at = ?, updated_at = ? WHERE id = ?',
    [next, next === 'completed' ? nowIso() : null, nowIso(), before.id]);
  return ok(res, await get('SELECT * FROM personal_todos WHERE id = ?', [before.id]));
});

/** Move an unfinished item to another day - usually today, from yesterday. */
router.post('/:id/move', async (req, res) => {
  const before = await mineOr404(req, req.params.id);
  const { todo_date: day } = validate(
    z.object({ todo_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }), req.body,
  );
  await run("UPDATE personal_todos SET todo_date = ?, status = 'pending', completed_at = NULL, updated_at = ? WHERE id = ?",
    [day, nowIso(), before.id]);
  return ok(res, await get('SELECT * FROM personal_todos WHERE id = ?', [before.id]));
});

router.delete('/:id', async (req, res) => {
  const before = await mineOr404(req, req.params.id);
  // Soft delete, in step with AR7 and the rest of the schema.
  await run('UPDATE personal_todos SET deleted_at = ? WHERE id = ?', [nowIso(), before.id]);
  return ok(res, { ok: true });
});

/** Clears the day's finished items out of the way. */
router.post('/clear-completed', async (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(req.body?.date || '')) ? String(req.body.date) : todayIso();
  const rows = await all(
    `SELECT id FROM personal_todos WHERE tenant_id = ? AND user_id = ? AND todo_date = ?
       AND status = 'completed' AND deleted_at IS NULL`,
    [tenantId, userId, day],
  );
  for (const r of rows) await run('UPDATE personal_todos SET deleted_at = ? WHERE id = ?', [nowIso(), r.id]);
  return ok(res, { cleared: rows.length, date: day });
});

export { router as todosRouter };
