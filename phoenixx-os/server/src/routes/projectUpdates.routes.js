import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso, todayIso } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, forbidden, audit } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { notifyMany } from '../services/notifications.js';
import {
  FILER_SEATS, UPDATE_STATUSES, BLOCKER_TYPES,
  ownersFor, filersFor, filerSeat, taskProgressFor, visibleProjectIds,
} from '../services/projectOversight.js';

const router = Router();

/**
 * The daily project update - the project-level standup, written down.
 *
 * Filed by the project manager and the team lead (nobody else: they are the
 * two who can speak for the whole project), read by the project's owners.
 * One row per person per project per day, upserted, so topping up at six what
 * was written at noon is one update, not two. Omit a field to keep it, send
 * null to clear it - the same merge rules as the per-task daily update.
 *
 * Owners hear about every update in-app; an at-risk or blocked one is sent as
 * its own, louder notice so it does not wait for the evening digest.
 *
 * Mounted at `/projects` ahead of the main projects router, so `/updates/...`
 * resolves here before `/:id` gets a chance to read "updates" as an id.
 */

const STATUS_LABEL = { on_track: 'On track', at_risk: 'At risk', blocked: 'Blocked' };
const STATUS_RANK = { on_track: 1, at_risk: 2, blocked: 3 };
const SEAT_LABEL = { manager: 'Project manager', lead: 'Team lead' };

const UPDATE_SELECT = `
  SELECT pu.*, u.name AS user_name, u.avatar_url, u.designation
    FROM project_updates pu JOIN users u ON u.id = pu.user_id`;

const shape = (row) => (row ? { ...row, has_blocker: !!row.has_blocker } : row);

/** The worst status filed for a project that day - one red update makes the project red. */
const worstStatus = (updates) => updates.reduce(
  (worst, u) => (!worst || STATUS_RANK[u.status] > STATUS_RANK[worst] ? u.status : worst), null);

const dayParam = (raw) => {
  const day = raw || todayIso();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw badRequest('Dates are YYYY-MM-DD');
  return day;
};

async function canRead(auth, projectId) {
  return (await visibleProjectIds(auth)).includes(projectId);
}

// ------------------------------------------------------------ what to file
/** The projects this person files for, each with what they have filed today. */
router.get('/updates/to-file', requires('projects', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = dayParam(req.query.date);
  const projects = await all(
    `SELECT p.id, p.name, p.code, p.status, p.end_date, c.name AS client_name, pm.seat
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
       JOIN clients c ON c.id = p.client_id
      WHERE pm.tenant_id = ? AND pm.user_id = ? AND pm.deleted_at IS NULL
        AND pm.seat IN (${FILER_SEATS.map(() => '?').join(',')})
        AND p.status = 'active'
      ORDER BY p.name`,
    [tenantId, userId, ...FILER_SEATS],
  );
  const ids = projects.map((p) => p.id);
  const tasks = await taskProgressFor(tenantId, ids);
  const owners = await ownersFor(tenantId, ids);
  const mine = ids.length ? await all(
    `${UPDATE_SELECT} WHERE pu.tenant_id = ? AND pu.user_id = ? AND pu.update_date = ? AND pu.deleted_at IS NULL
        AND pu.project_id IN (${ids.map(() => '?').join(',')})`,
    [tenantId, userId, day, ...ids],
  ) : [];
  // The last thing they said, so tomorrow's form can start from yesterday's plan.
  const lastFor = async (pid) => shape(await get(
    `${UPDATE_SELECT} WHERE pu.tenant_id = ? AND pu.user_id = ? AND pu.project_id = ? AND pu.update_date < ?
        AND pu.deleted_at IS NULL ORDER BY pu.update_date DESC LIMIT 1`,
    [tenantId, userId, pid, day],
  ));

  return ok(res, {
    date: day,
    projects: await Promise.all(projects.map(async (p) => ({
      ...p,
      owners: owners[p.id] || [],
      tasks: tasks[p.id],
      update: shape(mine.find((u) => u.project_id === p.id)) || null,
      previous: await lastFor(p.id) || null,
    }))),
  });
});

// ------------------------------------------------------------ owner's feed
/**
 * Every active project the caller can see, for one day: who was meant to
 * file, what they said, who has not, and the task numbers beside it.
 * `mine=true` narrows it to the projects the caller owns.
 */
router.get('/updates/feed', requires('projects', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const day = dayParam(req.query.date);
  let ids = await visibleProjectIds(req.auth);
  if (req.query.mine === 'true') {
    const owned = (await all('SELECT project_id FROM project_owners WHERE tenant_id = ? AND user_id = ?', [tenantId, userId]))
      .map((r) => r.project_id);
    ids = ids.filter((id) => owned.includes(id));
  }
  if (!ids.length) {
    return ok(res, { date: day, summary: { projects: 0, expected: 0, filed: 0, missing: 0, on_track: 0, at_risk: 0, blocked: 0, no_update: 0 }, projects: [] });
  }

  const projects = await all(
    `SELECT p.id, p.name, p.code, p.status, p.end_date, p.client_id, c.name AS client_name
       FROM projects p JOIN clients c ON c.id = p.client_id
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.status = 'active'
        AND p.id IN (${ids.map(() => '?').join(',')})
      ORDER BY p.name`,
    [tenantId, ...ids],
  );
  const pids = projects.map((p) => p.id);
  const owners = await ownersFor(tenantId, pids);
  const filers = await filersFor(tenantId, pids);
  const tasks = await taskProgressFor(tenantId, pids);
  const updates = pids.length ? (await all(
    `${UPDATE_SELECT} WHERE pu.tenant_id = ? AND pu.update_date = ? AND pu.deleted_at IS NULL
        AND pu.project_id IN (${pids.map(() => '?').join(',')})
      ORDER BY pu.updated_at DESC`,
    [tenantId, day, ...pids],
  )).map(shape) : [];

  const summary = { projects: projects.length, expected: 0, filed: 0, missing: 0, on_track: 0, at_risk: 0, blocked: 0, no_update: 0 };
  const rows = projects.map((p) => {
    const own = updates.filter((u) => u.project_id === p.id);
    const expected = filers[p.id] || [];
    const seats = expected.map((f) => ({ ...f, update: own.find((u) => u.user_id === f.user_id) || null }));
    // Someone who filed but has since left the seat still counts as having said something.
    const extra = own.filter((u) => !expected.some((f) => f.user_id === u.user_id));
    const missing = seats.filter((s) => !s.update);
    const status = worstStatus(own);
    const reported = own.map((u) => u.progress_pct).filter((n) => n != null);

    summary.expected += seats.length;
    summary.filed += seats.length - missing.length;
    summary.missing += missing.length;
    if (status) summary[status] += 1; else summary.no_update += 1;

    return {
      ...p,
      owners: owners[p.id] || [],
      status_today: status,
      reported_progress: reported.length ? Math.round(reported.reduce((a, b) => a + b, 0) / reported.length) : null,
      tasks: tasks[p.id],
      seats,
      other_updates: extra,
      missing: missing.map((m) => ({ user_id: m.user_id, name: m.name, seat: m.seat })),
      unstaffed: !expected.length,
    };
  });

  // Worst first: blocked, at risk, silent, then on track - the order an owner reads in.
  const order = (r) => (r.status_today ? 4 - STATUS_RANK[r.status_today] : 2.5);
  rows.sort((a, b) => order(a) - order(b) || a.name.localeCompare(b.name));

  return ok(res, { date: day, summary, projects: rows });
});

// ----------------------------------------------------------- one project
router.get('/:id/updates', requires('projects', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const project = await get('SELECT id FROM projects WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [req.params.id, tenantId]);
  if (!project) throw notFound('Project');
  if (!await canRead(req.auth, project.id)) throw forbidden('Only the project\'s owners and team can read its updates');

  const limit = Math.min(Number(req.query.limit) || 60, 200);
  return ok(res, (await all(
    `${UPDATE_SELECT} WHERE pu.tenant_id = ? AND pu.project_id = ? AND pu.deleted_at IS NULL
      ORDER BY pu.update_date DESC, pu.updated_at DESC LIMIT ?`,
    [tenantId, project.id, limit],
  )).map(shape));
});

const text = z.string().max(4000).optional().nullable();
const updateSchema = z.object({
  update_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  todays_work: text,
  completed_today: text,
  tomorrow_plan: text,
  progress_pct: z.number().int().min(0).max(100).optional().nullable(),
  has_blocker: z.boolean().optional(),
  blocker_type: z.enum(BLOCKER_TYPES).optional().nullable(),
  blocker_description: text,
  help_required: text,
  estimated_delay_days: z.number().int().min(0).max(365).optional().nullable(),
  status: z.enum(UPDATE_STATUSES),
});

router.post('/:id/updates', requires('projects', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const project = await get(
    `SELECT p.*, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id
      WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL`,
    [req.params.id, tenantId],
  );
  if (!project) throw notFound('Project');

  const seat = await filerSeat(tenantId, project.id, userId);
  if (!seat) throw forbidden('Only the project manager and the team lead file the daily project update');

  const body = validate(updateSchema, req.body);
  const day = body.update_date || todayIso();
  if (day > todayIso()) throw badRequest('You cannot file an update for a day that has not happened');

  const existing = await get(
    `SELECT * FROM project_updates WHERE tenant_id = ? AND project_id = ? AND user_id = ?
       AND update_date = ? AND deleted_at IS NULL`,
    [tenantId, project.id, userId, day],
  );
  const keep = (k) => (body[k] !== undefined ? body[k] : (existing?.[k] ?? null));
  const clean = (v) => (typeof v === 'string' ? (v.trim() || null) : v);

  const hasBlocker = body.has_blocker !== undefined ? body.has_blocker : !!existing?.has_blocker;
  const fields = {
    todays_work: clean(keep('todays_work')),
    completed_today: clean(keep('completed_today')),
    tomorrow_plan: clean(keep('tomorrow_plan')),
    progress_pct: keep('progress_pct'),
    has_blocker: hasBlocker ? 1 : 0,
    // No blocker means no blocker detail - stale text from the morning would
    // otherwise sit on an update that now says everything is fine.
    blocker_type: hasBlocker ? keep('blocker_type') : null,
    blocker_description: hasBlocker ? clean(keep('blocker_description')) : null,
    help_required: hasBlocker ? clean(keep('help_required')) : null,
    estimated_delay_days: hasBlocker ? keep('estimated_delay_days') : null,
    status: body.status,
  };

  // An update that says nothing reads as progress on the owner's screen while
  // telling them nothing, so the work itself has to be in it.
  if (!fields.todays_work && !fields.completed_today) {
    throw badRequest('Say what was worked on or completed today',
      [{ field: 'todays_work', message: 'Fill in today\'s work or what was completed' }]);
  }
  if (hasBlocker && (!fields.blocker_type || !fields.blocker_description)) {
    throw badRequest('A blocker needs its type and a description',
      [{ field: 'blocker_description', message: 'Describe the blocker' }]);
  }
  if (fields.status === 'blocked' && !hasBlocker) {
    throw badRequest('A blocked project needs the blocker described',
      [{ field: 'has_blocker', message: 'Mark the blocker and describe it' }]);
  }

  const at = nowIso();
  const id = existing?.id || uuid();
  await tx(async () => {
    if (existing) {
      await run(
        `UPDATE project_updates SET seat = ?, todays_work = ?, completed_today = ?, tomorrow_plan = ?,
           progress_pct = ?, has_blocker = ?, blocker_type = ?, blocker_description = ?, help_required = ?,
           estimated_delay_days = ?, status = ?, updated_at = ? WHERE id = ?`,
        [seat, ...Object.values(fields), at, id],
      );
    } else {
      await run(
        `INSERT INTO project_updates (id, tenant_id, project_id, user_id, update_date, seat, todays_work,
           completed_today, tomorrow_plan, progress_pct, has_blocker, blocker_type, blocker_description,
           help_required, estimated_delay_days, status, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, project.id, userId, day, seat, ...Object.values(fields), at, at],
      );
    }
  });

  // Tell the owners. In-app only, by the owner's choice of channel for this.
  const ownerIds = (await all('SELECT user_id FROM project_owners WHERE tenant_id = ? AND project_id = ?', [tenantId, project.id]))
    .map((r) => r.user_id).filter((uid) => uid !== userId);
  const flagged = fields.status !== 'on_track' || hasBlocker;
  const vars = {
    project: project.name,
    client: project.client_name,
    person: req.auth.name,
    seat: SEAT_LABEL[seat] || seat,
    status_label: STATUS_LABEL[fields.status],
    progress: fields.progress_pct ?? '—',
    completed: (fields.completed_today || fields.todays_work || '').slice(0, 200),
    next: (fields.tomorrow_plan || '—').slice(0, 200),
    blocker_type: fields.blocker_type || 'unspecified',
    blocker: (fields.blocker_description || 'not described').slice(0, 300),
    help: (fields.help_required || 'none stated').slice(0, 200),
    delay: fields.estimated_delay_days != null ? `${fields.estimated_delay_days} day(s)` : 'not estimated',
  };
  if (ownerIds.length) {
    await notifyMany({
      tenantId,
      userIds: ownerIds,
      eventKey: flagged ? 'project.update_flagged' : 'project.update_filed',
      vars,
      link: `/projects?tab=updates&open=${project.id}`,
      channels: ['in_app'],
      // Filed: once per person per project per day, however often it is edited.
      // Flagged: again whenever the status gets worse within the day.
      dedupeKey: flagged
        ? `pflag:${project.id}:${userId}:${day}:${fields.status}:${hasBlocker ? 1 : 0}`
        : `pupdate:${project.id}:${userId}:${day}`,
    }).catch(() => {});
  }

  await audit(req, {
    entity: 'project_update', entityId: id, action: existing ? 'update' : 'create',
    after: { project_id: project.id, update_date: day, status: fields.status, has_blocker: hasBlocker },
  });

  const saved = shape(await get(`${UPDATE_SELECT} WHERE pu.id = ?`, [id]));
  return existing ? ok(res, saved) : created(res, saved);
});

export { router as projectUpdatesRouter };
