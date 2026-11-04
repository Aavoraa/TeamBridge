import { get, all, run } from '../db/index.js';
import { uuid, nowIso, todayIso } from '../lib/util.js';
import { badRequest } from '../lib/http.js';

/**
 * Project oversight - who a project answers to, who reports on it, and the
 * numbers the report is checked against.
 *
 * Owners are the people the daily project update is *for*: one or more
 * workspace Owners or Managers per project. The update itself is filed by the
 * two seats that run the project - the project manager and the team lead -
 * because they are the ones who can speak for the whole of it.
 */

/** Workspace roles allowed to own a project. */
export const OWNER_ROLES = ['owner', 'manager'];
/** Team seats that file the daily project update. */
export const FILER_SEATS = ['manager', 'lead'];
export const UPDATE_STATUSES = ['on_track', 'at_risk', 'blocked'];
export const BLOCKER_TYPES = ['technical', 'client', 'resource', 'dependency', 'other'];

const placeholders = (n) => Array.from({ length: n }, () => '?').join(',');

/** Owners per project, with enough of the person to render a face. */
export async function ownersFor(tenantId, projectIds) {
  if (!projectIds.length) return {};
  const rows = await all(
    `SELECT po.project_id, po.user_id, u.name, u.avatar_url, u.designation, u.role AS org_role
       FROM project_owners po JOIN users u ON u.id = po.user_id
      WHERE po.tenant_id = ? AND po.project_id IN (${placeholders(projectIds.length)})
      ORDER BY u.name`,
    [tenantId, ...projectIds],
  );
  const byProject = {};
  for (const r of rows) (byProject[r.project_id] ||= []).push(r);
  return byProject;
}

export const isProjectOwner = async (tenantId, projectId, userId) => !!await get(
  'SELECT 1 AS y FROM project_owners WHERE tenant_id = ? AND project_id = ? AND user_id = ?',
  [tenantId, projectId, userId],
);

/**
 * Replace a project's owners with exactly `userIds`. At least one, and every
 * one of them a live Owner or Manager in this workspace - anything else is
 * refused whole rather than half-applied. Returns what changed, for the audit.
 */
export async function setProjectOwners({ tenantId, actorId }, projectId, userIds) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) throw badRequest('Every project needs at least one owner', [{ field: 'owner_ids', message: 'Pick at least one owner' }]);

  const eligible = (await all(
    `SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status != 'disabled'
        AND role IN (${placeholders(OWNER_ROLES.length)}) AND id IN (${placeholders(ids.length)})`,
    [tenantId, ...OWNER_ROLES, ...ids],
  )).map((u) => u.id);
  const refused = ids.filter((id) => !eligible.includes(id));
  if (refused.length) {
    throw badRequest('Only workspace Owners and Managers can own a project',
      [{ field: 'owner_ids', message: 'Pick Owners or Managers only' }]);
  }

  const current = (await all('SELECT user_id FROM project_owners WHERE tenant_id = ? AND project_id = ?', [tenantId, projectId]))
    .map((r) => r.user_id);
  const added = ids.filter((id) => !current.includes(id));
  const removed = current.filter((id) => !ids.includes(id));

  for (const uid of removed) {
    await run('DELETE FROM project_owners WHERE tenant_id = ? AND project_id = ? AND user_id = ?', [tenantId, projectId, uid]);
  }
  for (const uid of added) {
    await run('INSERT INTO project_owners (id, tenant_id, project_id, user_id, added_by, created_at) VALUES (?,?,?,?,?,?)',
      [uuid(), tenantId, projectId, uid, actorId ?? null, nowIso()]);
  }
  return { added, removed };
}

/** The seat this person files from on this project, or null if they do not file. */
export async function filerSeat(tenantId, projectId, userId) {
  return (await get(
    `SELECT seat FROM project_members WHERE tenant_id = ? AND project_id = ? AND user_id = ?
        AND deleted_at IS NULL AND seat IN (${placeholders(FILER_SEATS.length)})`,
    [tenantId, projectId, userId, ...FILER_SEATS],
  ))?.seat ?? null;
}

/** Manager and lead per project - the people expected to file each day. */
export async function filersFor(tenantId, projectIds) {
  if (!projectIds.length) return {};
  const rows = await all(
    `SELECT pm.project_id, pm.user_id, pm.seat, u.name, u.avatar_url
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.tenant_id = ? AND pm.deleted_at IS NULL AND u.deleted_at IS NULL
        AND pm.seat IN (${placeholders(FILER_SEATS.length)})
        AND pm.project_id IN (${placeholders(projectIds.length)})
      ORDER BY CASE pm.seat WHEN 'manager' THEN 1 ELSE 2 END`,
    [tenantId, ...FILER_SEATS, ...projectIds],
  );
  const byProject = {};
  for (const r of rows) (byProject[r.project_id] ||= []).push(r);
  return byProject;
}

/**
 * What the tasks say, to sit beside what the filer says. A self-reported 75%
 * next to 30% of tasks done is the conversation the owner needs to have, so
 * the two are always shown together and neither replaces the other.
 */
export async function taskProgressFor(tenantId, projectIds) {
  if (!projectIds.length) return {};
  const now = nowIso();
  const rows = await all(
    `SELECT project_id,
            COUNT(*) AS total,
            SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
            SUM(CASE WHEN status = 'blocked' THEN 1 ELSE 0 END) AS blocked,
            SUM(CASE WHEN status NOT IN ('done','cancelled') AND due_at IS NOT NULL AND due_at < ? THEN 1 ELSE 0 END) AS overdue
       FROM action_items
      WHERE tenant_id = ? AND deleted_at IS NULL AND status != 'cancelled'
        AND project_id IN (${placeholders(projectIds.length)})
      GROUP BY project_id`,
    [now, tenantId, ...projectIds],
  );
  const out = {};
  for (const id of projectIds) out[id] = { total: 0, done: 0, blocked: 0, overdue: 0, pct: null };
  for (const r of rows) {
    const total = Number(r.total) || 0;
    const done = Number(r.done) || 0;
    out[r.project_id] = {
      total, done,
      blocked: Number(r.blocked) || 0,
      overdue: Number(r.overdue) || 0,
      pct: total ? Math.round((done / total) * 100) : null,
    };
  }
  return out;
}

/**
 * Employees and managers see only the projects they are associated with - on
 * the team in any seat, or one of its owners. Everyone else (workspace Owner,
 * finance, HR, platform admin) sees every project, because costs, invoicing
 * and staffing are cross-project by nature.
 */
const OWN_PROJECTS_ONLY = ['employee', 'manager'];
export const seesAllProjects = (auth) => !OWN_PROJECTS_ONLY.includes(auth.role);

/** SQL predicate over a projects alias: "this person is associated with p". */
export const associatedSql = (alias = 'p') => `(
  EXISTS (SELECT 1 FROM project_owners po WHERE po.project_id = ${alias}.id AND po.user_id = ?)
  OR EXISTS (SELECT 1 FROM project_members pm_a WHERE pm_a.project_id = ${alias}.id
               AND pm_a.user_id = ? AND pm_a.deleted_at IS NULL))`;

export const canSeeProject = async (auth, projectId) => seesAllProjects(auth) || !!await get(
  `SELECT 1 AS y FROM projects p WHERE p.id = ? AND p.tenant_id = ? AND ${associatedSql('p')}`,
  [projectId, auth.tenantId, auth.userId, auth.userId],
);

/** The projects this person may see - and so read the updates of. */
export async function visibleProjectIds(auth) {
  if (seesAllProjects(auth)) {
    return (await all('SELECT id FROM projects WHERE tenant_id = ? AND deleted_at IS NULL', [auth.tenantId])).map((r) => r.id);
  }
  return (await all(
    `SELECT p.id FROM projects p WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND ${associatedSql('p')}`,
    [auth.tenantId, auth.userId, auth.userId],
  )).map((r) => r.id);
}

/** Is today a weekly off for this workspace? Reminders and digests skip it. */
export async function isWeekOff(tenantId, day = todayIso()) {
  const raw = (await get('SELECT week_off_days FROM tenants WHERE id = ?', [tenantId]))?.week_off_days;
  let offs = [0];
  try { offs = JSON.parse(raw || '[0]'); } catch { /* keep Sunday */ }
  const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
  return Array.isArray(offs) && offs.includes(weekday);
}
