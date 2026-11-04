import { Router } from 'express';
import { get, all } from '../db/index.js';
import { ok, audit, badRequest } from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import * as P from '../services/todoPlan.js';

const router = Router();
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Where today's To-Do window stands and the caller's own plan for it. Every
 * signed-in person reads this; only someone who can edit workspace settings
 * sees the edit controls.
 */
router.get('/schedule', async (req, res) => {
  const { settings, ...win } = await P.windowFor(req.auth.tenantId);
  const mine = win.todo_date
    ? await get('SELECT id, status, submitted_at, minutes_late FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?',
      [req.auth.tenantId, req.auth.userId, win.todo_date])
    : null;
  return ok(res, {
    window: win,
    settings,
    defaults: P.DEFAULT_SETTINGS,
    channel_options: P.CHANNEL_OPTIONS,
    mine: mine || null,
    can_edit_settings: await can(req.auth, 'settings', 'edit'),
    // For the owner's access settings: everyone who can be given a view of everyone.
    people: await can(req.auth, 'settings', 'edit')
      ? await all(`SELECT id, name, role FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
               AND role NOT IN ('owner','client','super_admin') ORDER BY name`, [req.auth.tenantId])
      : [],
  });
});

router.put('/settings', requires('settings', 'edit'), async (req, res) => {
  const before = await P.settingsFor(req.auth.tenantId);
  const after = await P.saveSettings(req.auth.tenantId, req.body || {});
  await audit(req, { entity: 'todo_settings', entityId: req.auth.tenantId, action: 'update', before, after });
  return ok(res, after);
});

/** Runs this workspace's clock now - the same pass the minute job makes. Safe to repeat. */
router.post('/run', requires('settings', 'edit'), async (req, res) => {
  const sent = await P.todoTick([req.auth.tenantId]);
  return ok(res, { sent, window: (({ settings, ...w }) => w)(await P.windowFor(req.auth.tenantId)) });
});

// ------------------------------------------------------------- employee
/** The caller's current plan, their history, and what they can pick from. */
router.get('/mine', async (req, res) => ok(res, await P.mine(req.auth)));

/** Save a draft, or submit with `submit: true`. Only ever the caller's own plan. */
router.put('/mine/:todoDate', async (req, res) => {
  if (!DAY.test(req.params.todoDate)) throw badRequest('Date must be YYYY-MM-DD');
  const { tasks, submit } = req.body || {};
  return ok(res, await P.savePlan(req.auth, req.params.todoDate, { tasks, submit: submit === true }));
});

// ------------------------------------------------------------- reviewer
/** One planned day for the caller's people (everyone, for an owner) plus the review queue. */
router.get('/team', async (req, res) => {
  const day = req.query.date ? String(req.query.date) : null;
  if (day && !DAY.test(day)) throw badRequest('date must be YYYY-MM-DD');
  return ok(res, await P.team(req.auth, day, req.query.scope === 'all'));
});

/** Change who someone reports to. The rules (owner, or a manager the owner allows) live in the service. */
router.put('/reporting/:userId', async (req, res) => ok(res, await P.setReporting(req.auth, req.params.userId, req.body?.manager_id ?? null)));

router.get('/submissions/:id', async (req, res) => ok(res, await P.getPlan(req.auth, req.params.id)));

router.post('/submissions/:id/open', async (req, res) => ok(res, await P.startReview(req.auth, req.params.id)));

router.post('/submissions/:id/approve', async (req, res) =>
  ok(res, await P.decide(req.auth, req.params.id, { approve: true, note: req.body?.note })));

router.post('/submissions/:id/request-changes', async (req, res) =>
  ok(res, await P.decide(req.auth, req.params.id, { approve: false, note: req.body?.note })));

/** Add a task to a plan being worked - no re-approval. */
router.post('/submissions/:id/tasks', async (req, res) => ok(res, await P.addTask(req.auth, req.params.id, req.body)));

router.post('/submissions/:id/tasks/:taskId', async (req, res) =>
  ok(res, await P.setTaskDone(req.auth, req.params.id, req.params.taskId, req.body?.done === true)));

router.post('/submissions/:id/tasks/:taskId/checklist/:index', async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0) throw badRequest('index must be a whole number');
  return ok(res, await P.setChecklistItem(req.auth, req.params.id, req.params.taskId, index, req.body?.done === true));
});

router.post('/submissions/:id/comments', async (req, res) =>
  ok(res, await P.addComment(req.auth, req.params.id, req.body?.body)));

/**
 * "Create Action Items": one action item per task not converted yet. Safe to
 * repeat - the reply lists what was created, what already was, and what could
 * not be. Who may ask and who the items go to are decided in the service.
 */
router.post('/submissions/:id/action-items', requires('action_items', 'create'), async (req, res) =>
  ok(res, await P.convertPlan(req.auth, req.params.id)));

export { router as todoPlanRouter };
