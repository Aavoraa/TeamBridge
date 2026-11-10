import { all } from '../db/index.js';
import { forbidden } from '../lib/http.js';

/**
 * Who may hand a task to somebody else.
 *
 * Owners assign anyone in the workspace. A manager assigns the people who
 * report to them and the people on projects they run (manager, lead or owner
 * seat). Everyone else - employees, finance, HR - does not hand out work: they
 * keep private to-dos on My Day, and ask for a task of their own through a task
 * request, which their manager or project lead approves (routes/taskRequests).
 *
 * Tasks created by the system's own flows - an approved meeting item, an
 * approved Advance Planner line, an approved task request - are checked where
 * they are approved, not here.
 */
export const ASSIGNING_ROLES = ['owner', 'manager', 'super_admin'];

export const canAssignOthers = (auth) => ASSIGNING_ROLES.includes(auth?.role);

/** The ids this caller may assign to, or null for "anyone in the workspace". */
export async function assignableIds(auth) {
  if (!canAssignOthers(auth)) return [];
  if (auth.role !== 'manager') return null;
  const rows = await all(
    `SELECT id FROM users WHERE tenant_id = ? AND manager_id = ? AND deleted_at IS NULL
     UNION
     SELECT pm.user_id FROM project_members pm
       JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
      WHERE pm.tenant_id = ? AND pm.deleted_at IS NULL
        AND (p.manager_id = ? OR p.lead_id = ?
             OR pm.project_id IN (SELECT project_id FROM project_members
                                   WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL AND seat IN ('manager', 'lead'))
             OR pm.project_id IN (SELECT project_id FROM project_owners WHERE tenant_id = ? AND user_id = ?))`,
    [auth.tenantId, auth.userId, auth.tenantId, auth.userId, auth.userId,
      auth.tenantId, auth.userId, auth.tenantId, auth.userId],
  );
  return rows.map((r) => r.id).filter((id) => id !== auth.userId);
}

/**
 * Throws unless every id is someone this caller may assign. The caller's own id
 * is ignored here: whether you may own your own item is decided elsewhere.
 */
export async function assertCanAssign(auth, ids) {
  const others = [...new Set((ids || []).filter((id) => id && id !== auth.userId))];
  if (!others.length) return;
  if (!canAssignOthers(auth)) {
    throw forbidden('Only owners and managers assign tasks to other people. Add it to your to-dos, or request a task for yourself.');
  }
  const allowed = await assignableIds(auth);
  if (allowed === null) return;
  if (others.some((id) => !allowed.includes(id))) {
    throw forbidden('You can assign tasks only to your own reports and the people on projects you run');
  }
}
