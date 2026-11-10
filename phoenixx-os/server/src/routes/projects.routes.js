import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso, toCsv } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, conflict, forbidden, audit } from '../lib/http.js';
import { requires, invalidatePersonAccess } from '../middleware/rbac.js';
import { syncProjectChannel } from '../services/chat.js';
import { clientIdForName } from '../services/clientAccounts.js';
import {
  OWNER_ROLES, ownersFor, setProjectOwners, seesAllProjects, associatedSql, canSeeProject,
} from '../services/projectOversight.js';

const router = Router();

/**
 * Employees and managers only ever see the projects they are on or own. Every
 * `/:id` route goes through this first, and a project outside their reach is
 * reported as not found rather than forbidden - its existence is not theirs to
 * know either.
 */
router.param('id', async (req, res, next, id) => {
  if (!await canSeeProject(req.auth, id)) return next(notFound('Project'));
  return next();
});

/**
 * Module F - projects and the delivery team behind each one.
 *
 * A project's team is a list of `project_members` rows, each holding a seat:
 * one manager (accountable for the engagement), one lead (runs the day-to-day),
 * then seniors and everyone else. Seats are ranked so every view - list, drawer,
 * workload - orders people the same way without each caller inventing an order.
 *
 * Mounted twice: at `/projects` (canonical) and at `/finance/projects` so the
 * older path used by the cost & profit screens keeps working.
 *
 * Permissions come from the `projects` module rather than `crm`, because who
 * may run a project is a different question from who may work a deal. An
 * employee holds `view` only: they can see the projects they are associated
 * with (on the team, or an owner) and those teams, but cannot create, edit,
 * restaff or delete one. Managers are held to the same visibility. Managers, finance-side admins
 * and owners hold the write actions. Both mounts carry these guards, and every
 * write path below is guarded server-side - hiding the buttons is presentation,
 * not enforcement.
 */

// ------------------------------------------------------------------- seats
export const SEATS = [
  { id: 'manager', label: 'Project manager', rank: 1, single: true, blurb: 'Accountable for scope, budget and the client relationship' },
  { id: 'lead', label: 'Team lead', rank: 2, single: true, blurb: 'Runs delivery day to day and unblocks the team' },
  { id: 'senior', label: 'Senior', rank: 3, single: false, blurb: 'Owns a workstream and reviews juniors' },
  { id: 'member', label: 'Team member', rank: 4, single: false, blurb: 'Executes assigned work' },
  { id: 'junior', label: 'Junior / trainee', rank: 5, single: false, blurb: 'Works under supervision' },
  { id: 'reviewer', label: 'Reviewer / QA', rank: 6, single: false, blurb: 'Signs off quality before it reaches the client' },
  { id: 'observer', label: 'Observer', rank: 7, single: false, blurb: 'Read-only visibility, no delivery load' },
];
const SEAT_IDS = SEATS.map((s) => s.id);
const SEAT_RANK = Object.fromEntries(SEATS.map((s) => [s.id, s.rank]));
/** Seats that may only be held by one person - assigning replaces the incumbent. */
const SINGLE_SEATS = SEATS.filter((s) => s.single).map((s) => s.id);
/** The project column each single seat mirrors into, for cheap list queries. */
const SEAT_COLUMN = { manager: 'manager_id', lead: 'lead_id' };

const seatSql = `CASE pm.seat ${SEATS.map((s) => `WHEN '${s.id}' THEN ${s.rank}`).join(' ')} ELSE 99 END`;

// ---------------------------------------------------------------- projects
const projectSchema = z.object({
  client_id: z.string(),
  name: z.string().min(2).max(160),
  code: z.string().optional().nullable(),
  service_line_id: z.string().optional().nullable(),
  model: z.enum(['retainer', 'project', 'hybrid']).optional(),
  /** delivery, or marketing - a marketing project carries a lead pipeline. */
  kind: z.enum(['delivery', 'marketing']).optional(),
  status: z.enum(['planned', 'active', 'on_hold', 'completed', 'cancelled']).optional(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  budget_minor: z.number().int().min(0).optional(),
  manager_id: z.string().optional().nullable(),
  lead_id: z.string().optional().nullable(),
  scope_total: z.number().int().min(0).optional(),
  scope_delivered: z.number().int().min(0).optional(),
  /** Who the project answers to. Owners and Managers only; at least one. */
  owner_ids: z.array(z.string()).max(20).optional(),
});

const PROJECT_SELECT = `
  SELECT p.*, c.name AS client_name, sl.name AS service_line_name,
         u.name AS manager_name, u.avatar_url AS manager_avatar, u.designation AS manager_designation,
         l.name AS lead_name, l.avatar_url AS lead_avatar, l.designation AS lead_designation,
         (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id AND pm.deleted_at IS NULL) AS team_size,
         (SELECT COALESCE(SUM(pm.allocation_pct),0) FROM project_members pm
            WHERE pm.project_id = p.id AND pm.deleted_at IS NULL) AS allocation_total,
         (SELECT COALESCE(SUM(i.taxable_minor),0) FROM invoices i WHERE i.project_id = p.id
            AND i.deleted_at IS NULL AND i.status NOT IN ('draft','written_off')) AS invoiced_minor,
         (SELECT COALESCE(SUM(co.amount_minor),0) FROM costs co WHERE co.project_id = p.id
            AND co.deleted_at IS NULL) AS cost_minor
    FROM projects p
    JOIN clients c ON c.id = p.client_id
    LEFT JOIN service_lines sl ON sl.id = p.service_line_id
    LEFT JOIN users u ON u.id = p.manager_id
    LEFT JOIN users l ON l.id = p.lead_id`;

const MEMBER_SELECT = `
  SELECT pm.*, u.name, u.email, u.avatar_url, u.designation, u.role AS org_role,
         u.phone, u.service_line_id, sl.name AS service_line_name,
         mgr.name AS reports_to_name, ${seatSql} AS seat_rank
    FROM project_members pm
    JOIN users u ON u.id = pm.user_id
    LEFT JOIN service_lines sl ON sl.id = u.service_line_id
    LEFT JOIN users mgr ON mgr.id = u.manager_id`;

const membersOf = async (tenantId, projectId) => await all(
  `${MEMBER_SELECT} WHERE pm.tenant_id = ? AND pm.project_id = ? AND pm.deleted_at IS NULL
    ORDER BY seat_rank, u.name`,
  [tenantId, projectId],
);

/** A compact roster (a few people per project) so the list view can show faces. */
async function rosterFor(tenantId, projectIds) {
  if (!projectIds.length) return {};
  const rows = await all(
    `SELECT pm.project_id, pm.user_id, pm.seat, pm.allocation_pct, pm.responsibility,
            u.name, u.avatar_url, u.designation,
            ${seatSql} AS seat_rank
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.tenant_id = ? AND pm.deleted_at IS NULL
        AND pm.project_id IN (${projectIds.map(() => '?').join(',')})
      ORDER BY seat_rank, u.name`,
    [tenantId, ...projectIds],
  );
  const byProject = {};
  for (const r of rows) (byProject[r.project_id] ||= []).push(r);
  return byProject;
}

router.get('/', requires('projects', 'view'), async (req, res) => {
  const filters = ['p.tenant_id = ?', 'p.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  if (!seesAllProjects(req.auth)) {
    filters.push(associatedSql('p'));
    params.push(req.auth.userId, req.auth.userId);
  }
  if (req.query.client_id) { filters.push('p.client_id = ?'); params.push(req.query.client_id); }
  if (req.query.status) { filters.push('p.status = ?'); params.push(req.query.status); }
  if (req.query.kind) { filters.push('p.kind = ?'); params.push(req.query.kind); }
  if (req.query.manager_id) { filters.push('p.manager_id = ?'); params.push(req.query.manager_id); }
  if (req.query.service_line_id) { filters.push('p.service_line_id = ?'); params.push(req.query.service_line_id); }
  if (req.query.owner_id) {
    filters.push('EXISTS (SELECT 1 FROM project_owners po WHERE po.project_id = p.id AND po.user_id = ?)');
    params.push(req.query.owner_id);
  }
  if (req.query.member_id) {
    filters.push(`EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id
                            AND pm.user_id = ? AND pm.deleted_at IS NULL)`);
    params.push(req.query.member_id);
  }
  if (req.query.search) {
    filters.push('(p.name LIKE ? OR p.code LIKE ? OR c.name LIKE ?)');
    const q = `%${req.query.search}%`;
    params.push(q, q, q);
  }

  const projects = await all(`${PROJECT_SELECT} WHERE ${filters.join(' AND ')} ORDER BY p.created_at DESC`, params);
  const ids = projects.map((p) => p.id);
  const roster = await rosterFor(req.auth.tenantId, ids);
  const owners = await ownersFor(req.auth.tenantId, ids);
  return ok(res, projects.map((p) => ({ ...p, team: roster[p.id] || [], owners: owners[p.id] || [] })));
});

router.get('/seats', (req, res) => ok(res, SEATS));

/** Who is on what, across every project - the staffing view. */
router.get('/workload', requires('projects', 'view'), async (req, res) => {
  const people = await all(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.designation, u.role, sl.name AS service_line_name
       FROM users u
       LEFT JOIN service_lines sl ON sl.id = u.service_line_id
      WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status != 'disabled' AND u.role != 'client'
      ORDER BY u.name`,
    [req.auth.tenantId],
  );
  const rows = await all(
    `SELECT pm.user_id, pm.seat, pm.allocation_pct, pm.responsibility,
            p.id AS project_id, p.name AS project_name, p.status AS project_status,
            c.name AS client_name, ${seatSql} AS seat_rank
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
       JOIN clients c ON c.id = p.client_id
      WHERE pm.tenant_id = ? AND pm.deleted_at IS NULL
        ${seesAllProjects(req.auth) ? '' : `AND ${associatedSql('p')}`}
      ORDER BY seat_rank, p.name`,
    seesAllProjects(req.auth) ? [req.auth.tenantId] : [req.auth.tenantId, req.auth.userId, req.auth.userId],
  );
  const byUser = {};
  for (const r of rows) (byUser[r.user_id] ||= []).push(r);

  return ok(res, people.map((u) => {
    const projects = byUser[u.id] || [];
    return {
      ...u,
      projects,
      project_count: projects.length,
      allocation_pct: projects.reduce((n, p) => n + Number(p.allocation_pct || 0), 0),
      leads: projects.filter((p) => p.seat === 'manager' || p.seat === 'lead').length,
    };
  }));
});

/**
 * A manager's own people: everyone who reports to them (for the workspace
 * owner, everyone), with the projects each is on, how much of their week is
 * spoken for, and their open and overdue tasks - plus the projects the caller
 * runs, which are the ones they can put someone on.
 */
router.get('/my-team', requires('projects', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const everyone = staffsAnyProject(req.auth);
  const people = await all(
    `SELECT u.id, u.name, u.email, u.avatar_url, u.designation, u.role, sl.name AS service_line_name
       FROM users u LEFT JOIN service_lines sl ON sl.id = u.service_line_id
      WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status != 'disabled' AND u.role != 'client'
        AND u.id != ? ${everyone ? '' : 'AND u.manager_id = ?'}
      ORDER BY u.name`,
    everyone ? [tenantId, userId] : [tenantId, userId, userId],
  );
  const ids = people.map((u) => u.id);
  const marks = ids.map(() => '?').join(',');
  const seats = ids.length ? await all(
    `SELECT pm.id AS member_id, pm.user_id, pm.seat, pm.allocation_pct, pm.responsibility,
            p.id AS project_id, p.name AS project_name, p.status AS project_status, c.name AS client_name,
            ${seatSql} AS seat_rank
       FROM project_members pm
       JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
       JOIN clients c ON c.id = p.client_id
      WHERE pm.tenant_id = ? AND pm.deleted_at IS NULL AND pm.user_id IN (${marks})
      ORDER BY seat_rank, p.name`,
    [tenantId, ...ids],
  ) : [];
  const now = nowIso();
  const tasks = ids.length ? await all(
    `SELECT owner_id, COUNT(*) AS open_tasks,
            SUM(CASE WHEN due_at IS NOT NULL AND due_at < ? THEN 1 ELSE 0 END) AS overdue_tasks
       FROM action_items
      WHERE tenant_id = ? AND deleted_at IS NULL AND status NOT IN ('done', 'cancelled') AND owner_id IN (${marks})
      GROUP BY owner_id`,
    [now, tenantId, ...ids],
  ) : [];
  const byUser = {};
  for (const r of seats) (byUser[r.user_id] ||= []).push(r);
  const taskBy = Object.fromEntries(tasks.map((t) => [t.owner_id, t]));

  const runs = await all(
    `SELECT p.id, p.name, p.status, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND p.status IN ('planned', 'active', 'on_hold')
        ${everyone ? '' : `AND ${RUNS_SQL('p')}`}
      ORDER BY p.name`,
    everyone ? [tenantId] : [tenantId, ...runsParams(req.auth)],
  );

  return ok(res, {
    scope: everyone ? 'everyone' : 'reports',
    people: people.map((u) => {
      const projects = byUser[u.id] || [];
      return {
        ...u,
        projects,
        allocation_pct: projects.reduce((n, p) => n + Number(p.allocation_pct || 0), 0),
        open_tasks: Number(taskBy[u.id]?.open_tasks || 0),
        overdue_tasks: Number(taskBy[u.id]?.overdue_tasks || 0),
      };
    }),
    projects_i_run: runs,
  });
});

router.get('/:id', requires('projects', 'view'), async (req, res) => {
  const project = await get(`${PROJECT_SELECT} WHERE p.id = ? AND p.tenant_id = ? AND p.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!project) throw notFound('Project');

  const team = await membersOf(req.auth.tenantId, project.id);
  return ok(res, {
    ...project,
    team,
    owners: (await ownersFor(req.auth.tenantId, [project.id]))[project.id] || [],
    /** Same people, bucketed by seat, so the UI does not have to group them. */
    team_by_seat: SEATS.map((s) => ({ ...s, members: team.filter((m) => m.seat === s.id) }))
      .filter((s) => s.members.length),
    open_items: Number((await get(
      `SELECT COUNT(*) AS n FROM action_items
        WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL AND status != 'done'`,
      [req.auth.tenantId, project.id],
    ))?.n || 0),
  });
});

/** On create the client may be typed by name instead of picked: reused if it exists, added if not. */
const createProjectSchema = projectSchema.extend({
  client_id: z.string().optional().nullable(),
  client_name: z.string().max(160).optional().nullable(),
});

router.post('/', requires('projects', 'create'), async (req, res) => {
  const body = validate(createProjectSchema, req.body);
  if (!body.client_id && !String(body.client_name || '').trim()) {
    throw badRequest('Enter the client name', [{ field: 'client_name', message: 'Enter the client name' }]);
  }
  const id = uuid();
  const at = nowIso();

  await tx(async () => {
    if (!body.client_id) body.client_id = await clientIdForName(req.auth.tenantId, req.auth.userId, body.client_name);
    await run(
      `INSERT INTO projects (id, tenant_id, client_id, name, code, service_line_id, model, status,
         start_date, end_date, budget_minor, manager_id, lead_id, scope_total, scope_delivered, kind, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, req.auth.tenantId, body.client_id, body.name, body.code ?? null, body.service_line_id ?? null,
        body.model || 'project', body.status || 'active', body.start_date ?? null, body.end_date ?? null,
        body.budget_minor || 0, body.manager_id ?? null, body.lead_id ?? null,
        body.scope_total || 0, body.scope_delivered || 0, body.kind || 'delivery', at, at],
    );
    // Whoever was named at creation joins the team in that seat straight away.
    if (body.manager_id) await addMember(req, id, { user_id: body.manager_id, seat: 'manager' });
    if (body.lead_id && body.lead_id !== body.manager_id) await addMember(req, id, { user_id: body.lead_id, seat: 'lead' });
    // Nobody named: whoever is creating it owns it, if they are allowed to.
    // setProjectOwners refuses an empty list, so a project is never ownerless.
    const ownerIds = body.owner_ids?.length ? body.owner_ids
      : (OWNER_ROLES.includes(req.auth.role) ? [req.auth.userId] : []);
    await setProjectOwners({ tenantId: req.auth.tenantId, actorId: req.auth.userId }, id, ownerIds);
  });

  invalidatePersonAccess(); // its manager and lead now run a project
  // The team gets a room the moment the project exists (Module B).
  await syncProjectChannel(req.auth.tenantId, id, { actorId: req.auth.userId });

  await audit(req, { entity: 'project', entityId: id, action: 'create', after: { name: body.name } });
  return created(res, await get(`${PROJECT_SELECT} WHERE p.id = ?`, [id]));
});

router.patch('/:id', requires('projects', 'edit'), async (req, res) => {
  const r = repo('projects', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Project');

  const { owner_ids: ownerIds, ...body } = validate(projectSchema.partial().omit({ client_id: true }), req.body);
  const after = await tx(async () => {
    const row = await r.update(req.params.id, { ...body, updated_at: nowIso() });
    if (ownerIds !== undefined) {
      await setProjectOwners({ tenantId: req.auth.tenantId, actorId: req.auth.userId }, row.id, ownerIds);
    }
    // Naming a manager or lead here is the same act as seating them on the team.
    for (const seat of SINGLE_SEATS) {
      const key = SEAT_COLUMN[seat];
      if (body[key] === undefined || body[key] === before[key]) continue;
      if (body[key]) await addMember(req, row.id, { user_id: body[key], seat });
      else await clearSeat(req.auth.tenantId, row.id, seat);
    }
    return row;
  });

  // E7: project scope rolls up to the client's delivered-vs-committed view.
  const totals = await get(
    `SELECT COALESCE(SUM(scope_total),0) AS t, COALESCE(SUM(scope_delivered),0) AS d
       FROM projects WHERE tenant_id = ? AND client_id = ? AND deleted_at IS NULL`,
    [req.auth.tenantId, after.client_id],
  );
  await run('UPDATE clients SET scope_total = ?, scope_delivered = ?, updated_at = ? WHERE id = ?',
    [Number(totals.t), Number(totals.d), nowIso(), after.client_id]);

  await syncProjectChannel(req.auth.tenantId, after.id, { actorId: req.auth.userId });

  await audit(req, { entity: 'project', entityId: after.id, action: 'update', before, after });
  return ok(res, await get(`${PROJECT_SELECT} WHERE p.id = ?`, [after.id]));
});

router.delete('/:id', requires('projects', 'delete'), async (req, res) => {
  const before = await repo('projects', req.auth.tenantId).findById(req.params.id);
  if (!before) throw notFound('Project');
  // Deleting is final for everyone on the project, so a manager may only delete
  // one they run or own; the workspace owner may delete any.
  if (!['owner', 'super_admin'].includes(req.auth.role)) {
    const theirs = before.manager_id === req.auth.userId
      || !!await get('SELECT id FROM project_owners WHERE project_id = ? AND user_id = ? AND tenant_id = ?',
        [before.id, req.auth.userId, req.auth.tenantId]);
    if (!theirs) throw forbidden('Only the workspace owner, or this project\'s manager or owner, can delete it');
  }
  const at = nowIso();
  await tx(async () => {
    await repo('projects', req.auth.tenantId).softDelete(req.params.id, at);
    await run('UPDATE project_members SET deleted_at = ? WHERE project_id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [at, req.params.id, req.auth.tenantId]);
  });
  invalidatePersonAccess(); // a lead or manager seat may have changed
  await syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  await audit(req, { entity: 'project', entityId: req.params.id, action: 'delete', before });
  return ok(res, { ok: true });
});

// ------------------------------------------------------------- the owners
router.get('/:id/owners', requires('projects', 'view'), async (req, res) => {
  await projectOr404(req.auth.tenantId, req.params.id);
  return ok(res, (await ownersFor(req.auth.tenantId, [req.params.id]))[req.params.id] || []);
});

/** Replace the owner list in one go - the picker sends the whole set. */
router.put('/:id/owners', requires('projects', 'edit'), async (req, res) => {
  await projectOr404(req.auth.tenantId, req.params.id);
  const body = validate(z.object({ user_ids: z.array(z.string()).max(20) }), req.body);
  const change = await tx(async () => await setProjectOwners({ tenantId: req.auth.tenantId, actorId: req.auth.userId },
    req.params.id, body.user_ids));

  await audit(req, { entity: 'project', entityId: req.params.id, action: 'update', after: { owners: change } });
  return ok(res, (await ownersFor(req.auth.tenantId, [req.params.id]))[req.params.id] || []);
});

// -------------------------------------------------------------- the team
const memberSchema = z.object({
  user_id: z.string(),
  seat: z.enum(SEAT_IDS).optional(),
  responsibility: z.string().max(240).optional().nullable(),
  allocation_pct: z.number().int().min(0).max(100).optional(),
  billable: z.boolean().optional(),
  start_date: z.string().optional().nullable(),
  end_date: z.string().optional().nullable(),
  notes: z.string().max(2000).optional().nullable(),
});

async function projectOr404(tenantId, id) {
  const p = await get('SELECT * FROM projects WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [id, tenantId]);
  if (!p) throw notFound('Project');
  return p;
}

/** SQL: projects this person runs - manager or lead seat, or one of its owners. */
const RUNS_SQL = (alias = 'p') => `(
  ${alias}.manager_id = ? OR ${alias}.lead_id = ?
  OR EXISTS (SELECT 1 FROM project_members pr WHERE pr.project_id = ${alias}.id AND pr.user_id = ?
               AND pr.deleted_at IS NULL AND pr.seat IN ('manager', 'lead'))
  OR EXISTS (SELECT 1 FROM project_owners po2 WHERE po2.project_id = ${alias}.id AND po2.user_id = ?))`;
const runsParams = (auth) => [auth.userId, auth.userId, auth.userId, auth.userId];
const staffsAnyProject = (auth) => ['owner', 'super_admin'].includes(auth.role);

/**
 * Who joins a project team, and in what seat, is decided by the people running
 * it. The workspace owner staffs any project; a manager staffs the ones they
 * manage, lead or own - not a colleague's.
 */
async function staffableOr403(req) {
  const p = await projectOr404(req.auth.tenantId, req.params.id);
  if (staffsAnyProject(req.auth)) return p;
  const runs = await get(`SELECT 1 AS y FROM projects p WHERE p.id = ? AND ${RUNS_SQL('p')}`, [p.id, ...runsParams(req.auth)]);
  if (!runs) throw forbidden('Only the people running this project, or the workspace owner, can change its team');
  return p;
}

/** Keep `projects.manager_id` / `lead_id` pointing at whoever holds that seat. */
async function syncSeatColumn(tenantId, projectId, seat) {
  const column = SEAT_COLUMN[seat];
  if (!column) return;
  const holder = await get(
    'SELECT user_id FROM project_members WHERE project_id = ? AND tenant_id = ? AND seat = ? AND deleted_at IS NULL',
    [projectId, tenantId, seat],
  );
  await run(`UPDATE projects SET ${column} = ?, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    [holder?.user_id ?? null, nowIso(), projectId, tenantId]);
}

/** Vacate a single-holder seat: the incumbent stays on the team as a member. */
async function clearSeat(tenantId, projectId, seat, exceptUserId) {
  const rows = (await all(
    'SELECT id, user_id FROM project_members WHERE project_id = ? AND tenant_id = ? AND seat = ? AND deleted_at IS NULL',
    [projectId, tenantId, seat],
  )).filter((r) => r.user_id !== exceptUserId);
  for (const r of rows) {
    await run('UPDATE project_members SET seat = ?, updated_at = ? WHERE id = ?', ['member', nowIso(), r.id]);
  }
  await syncSeatColumn(tenantId, projectId, seat);
}

/**
 * Seat someone on a project. Idempotent: an existing member is moved into the
 * new seat rather than duplicated, which is what "make Priya the lead" means
 * when Priya is already on the team.
 */
async function addMember(req, projectId, body) {
  const { tenantId } = req.auth;
  const seat = body.seat || 'member';
  const at = nowIso();

  const user = await get(
    "SELECT id, name, role FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND role != 'client'",
    [body.user_id, tenantId],
  );
  if (!user) throw badRequest('That person is not in this workspace');

  if (SINGLE_SEATS.includes(seat)) await clearSeat(tenantId, projectId, seat, body.user_id);

  const existing = await get(
    'SELECT * FROM project_members WHERE project_id = ? AND user_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [projectId, body.user_id, tenantId],
  );

  let id;
  if (existing) {
    id = existing.id;
    await run(
      `UPDATE project_members SET seat = ?, responsibility = ?, allocation_pct = ?, billable = ?,
         start_date = ?, end_date = ?, notes = ?, updated_at = ? WHERE id = ?`,
      [seat,
        body.responsibility ?? existing.responsibility,
        body.allocation_pct ?? existing.allocation_pct,
        body.billable === undefined ? existing.billable : (body.billable ? 1 : 0),
        body.start_date ?? existing.start_date,
        body.end_date ?? existing.end_date,
        body.notes ?? existing.notes,
        at, id],
    );
  } else {
    id = uuid();
    await run(
      `INSERT INTO project_members (id, tenant_id, project_id, user_id, seat, responsibility,
         allocation_pct, billable, start_date, end_date, notes, added_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, projectId, body.user_id, seat, body.responsibility ?? null,
        body.allocation_pct ?? 0, body.billable === false ? 0 : 1,
        body.start_date ?? null, body.end_date ?? null, body.notes ?? null,
        req.auth.userId ?? null, at, at],
    );
  }

  await syncSeatColumn(tenantId, projectId, seat);
  return { id, user, existed: !!existing };
}

router.get('/:id/members', requires('projects', 'view'), async (req, res) => {
  await projectOr404(req.auth.tenantId, req.params.id);
  return ok(res, await membersOf(req.auth.tenantId, req.params.id));
});

/** Everyone who could still be added - the directory minus the current team. */
router.get('/:id/available', requires('projects', 'view'), async (req, res) => {
  await projectOr404(req.auth.tenantId, req.params.id);
  return ok(res, await all(
    `SELECT u.id, u.name, u.email, u.role, u.designation, u.avatar_url, u.service_line_id,
            sl.name AS service_line_name, mgr.name AS reports_to_name,
            (SELECT COUNT(*) FROM project_members pm2
               JOIN projects p2 ON p2.id = pm2.project_id AND p2.deleted_at IS NULL
              WHERE pm2.user_id = u.id AND pm2.deleted_at IS NULL) AS project_count,
            (SELECT COALESCE(SUM(pm3.allocation_pct),0) FROM project_members pm3
               JOIN projects p3 ON p3.id = pm3.project_id AND p3.deleted_at IS NULL
              WHERE pm3.user_id = u.id AND pm3.deleted_at IS NULL) AS allocation_pct
       FROM users u
       LEFT JOIN service_lines sl ON sl.id = u.service_line_id
       LEFT JOIN users mgr ON mgr.id = u.manager_id
      WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status != 'disabled' AND u.role != 'client'
        AND NOT EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = ?
                          AND pm.user_id = u.id AND pm.deleted_at IS NULL)
      ORDER BY u.name`,
    [req.auth.tenantId, req.params.id],
  ));
});

router.post('/:id/members', requires('projects', 'edit'), async (req, res) => {
  await staffableOr403(req);
  const body = validate(memberSchema, req.body);
  const { id, user, existed } = await tx(async () => await addMember(req, req.params.id, body));

  invalidatePersonAccess(); // a lead or manager seat may have changed
  await syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  await audit(req, {
    entity: 'project_member',
    entityId: id,
    action: existed ? 'update' : 'create',
    after: { project_id: req.params.id, user: user.name, seat: body.seat || 'member' },
  });
  return created(res, await get(`${MEMBER_SELECT} WHERE pm.id = ?`, [id]));
});

/** Bulk add - staffing a new project one seat at a time is tedious. */
router.post('/:id/members/bulk', requires('projects', 'edit'), async (req, res) => {
  await staffableOr403(req);
  const body = validate(z.object({ members: z.array(memberSchema).min(1).max(50) }), req.body);
  await tx(async () => { for (const m of body.members) await addMember(req, req.params.id, m); });

  invalidatePersonAccess(); // a lead or manager seat may have changed
  await syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  await audit(req, { entity: 'project', entityId: req.params.id, action: 'update', after: { added: body.members.length } });
  return created(res, await membersOf(req.auth.tenantId, req.params.id));
});

router.patch('/:id/members/:memberId', requires('projects', 'edit'), async (req, res) => {
  await staffableOr403(req);
  const before = await get(
    'SELECT * FROM project_members WHERE id = ? AND project_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.memberId, req.params.id, req.auth.tenantId],
  );
  if (!before) throw notFound('Team member');

  const body = validate(memberSchema.partial().omit({ user_id: true }), req.body);
  await tx(async () => {
    if (body.seat && SINGLE_SEATS.includes(body.seat)) await clearSeat(req.auth.tenantId, req.params.id, body.seat, before.user_id);
    const patch = { ...body, updated_at: nowIso() };
    if (patch.billable !== undefined) patch.billable = patch.billable ? 1 : 0;
    await repo('project_members', req.auth.tenantId).update(before.id, patch);
    // The seat they left, and the seat they moved into, both need re-mirroring.
    for (const seat of new Set([before.seat, body.seat].filter(Boolean))) {
      await syncSeatColumn(req.auth.tenantId, req.params.id, seat);
    }
  });

  invalidatePersonAccess(); // a lead or manager seat may have changed
  await syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  await audit(req, { entity: 'project_member', entityId: before.id, action: 'update', before, after: body });
  return ok(res, await get(`${MEMBER_SELECT} WHERE pm.id = ?`, [before.id]));
});

router.delete('/:id/members/:memberId', requires('projects', 'edit'), async (req, res) => {
  await staffableOr403(req);
  const before = await get(
    'SELECT * FROM project_members WHERE id = ? AND project_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.memberId, req.params.id, req.auth.tenantId],
  );
  if (!before) throw notFound('Team member');

  // Open work would silently lose its owner, so say so instead of guessing.
  const openItems = Number((await get(
    `SELECT COUNT(*) AS n FROM action_items WHERE tenant_id = ? AND project_id = ?
       AND owner_id = ? AND deleted_at IS NULL AND status != 'done'`,
    [req.auth.tenantId, req.params.id, before.user_id],
  ))?.n || 0);
  if (openItems && req.query.force !== 'true') {
    throw conflict(`They still own ${openItems} open item(s) on this project. Reassign those first, or confirm to remove anyway.`,
      [{ field: 'open_items', message: String(openItems) }]);
  }

  await tx(async () => {
    await repo('project_members', req.auth.tenantId).softDelete(before.id, nowIso());
    await syncSeatColumn(req.auth.tenantId, req.params.id, before.seat);
  });

  invalidatePersonAccess(); // a lead or manager seat may have changed
  await syncProjectChannel(req.auth.tenantId, req.params.id, { actorId: req.auth.userId });

  await audit(req, { entity: 'project_member', entityId: before.id, action: 'delete', before });
  return ok(res, { ok: true, open_items: openItems });
});

router.get('/:id/members/export/csv', requires('projects', 'view'), async (req, res) => {
  const project = await projectOr404(req.auth.tenantId, req.params.id);
  const rows = (await membersOf(req.auth.tenantId, req.params.id)).map((m) => ({
    project: project.name,
    name: m.name,
    email: m.email,
    seat: SEATS.find((s) => s.id === m.seat)?.label || m.seat,
    designation: m.designation || '',
    service_line: m.service_line_name || '',
    reports_to: m.reports_to_name || '',
    responsibility: m.responsibility || '',
    allocation_pct: m.allocation_pct,
    billable: m.billable ? 'yes' : 'no',
    start_date: m.start_date || '',
    end_date: m.end_date || '',
  }));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="project-team.csv"');
  return res.send(toCsv(rows));
});

export { router as projectsRouter, SEAT_RANK };
