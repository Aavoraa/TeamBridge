import { forbidden } from '../lib/http.js';
import { parseJson } from '../lib/util.js';
import { get } from '../db/index.js';

/**
 * PRD 2.2 - granular permissions expressed as module x action, driven by role
 * templates. `custom_roles.permissions` overlays this map on higher plans.
 */
export const MODULES = [
  'action_items', 'meetings', 'deadlines', 'notifications', 'chat',
  'hr_attendance', 'hr_leave', 'hr_performance', 'hr_hiring', 'employees',
  'sop', 'kpi',
  'crm', 'proposals', 'projects',
  'invoices', 'costs', 'profitability',
  'reimbursements', 'reimbursement_finance',
  'reports', 'dashboard',
  'settings', 'users', 'billing', 'audit', 'platform',
  // AI Meeting Intelligence: upload recordings/transcripts and approve the
  // tasks extracted from them. Not on the employee templates: meetings can be
  // confidential, so only roles that hand out work see it unless granted.
  'meeting_intelligence',
];

export const ACTIONS = ['view', 'create', 'edit', 'approve', 'delete', 'export'];

const ALL = ['view', 'create', 'edit', 'approve', 'delete', 'export'];
const RW = ['view', 'create', 'edit'];
const RO = ['view'];

/** role -> module -> allowed actions */
export const ROLE_TEMPLATES = {
  super_admin: Object.fromEntries(MODULES.map((m) => [m, ALL])),

  owner: {
    ...Object.fromEntries(MODULES.map((m) => [m, ALL])),
    platform: [],
  },

  manager: {
    action_items: [...RW, 'approve', 'delete', 'export'],
    chat: [...RW, 'delete'],
    meetings: [...RW, 'delete'],
    deadlines: [...RW, 'approve'],
    notifications: RW,
    // A manager is an employee too: they check in and apply for leave like
    // everyone else (`create` covers only their own records).
    hr_attendance: [...RO, 'create', 'approve', 'export'],
    hr_leave: [...RO, 'create', 'approve', 'export'],
    hr_performance: [...RW, 'approve', 'export'],
    hr_hiring: [...RW, 'approve'],
    employees: RO,
    sop: [...RW, 'approve'],
    kpi: RW,
    crm: [...RW, 'approve', 'export'],
    proposals: [...RW, 'approve', 'export'],
    // A manager owns the projects and teams they run: create, edit, staff, close.
    projects: [...RW, 'approve', 'delete', 'export'],
    invoices: [...RO, 'create', 'export'],
    costs: RO,
    profitability: [...RO, 'export'],
    // Claims their own expenses, and decides their team's first approval gate.
    reimbursements: [...RW, 'approve', 'delete', 'export'],
    reimbursement_finance: [],
    reports: [...RW, 'export'],
    dashboard: RO,
    settings: RO,
    users: RO,
    billing: [],
    audit: RO,
    platform: [],
    meeting_intelligence: ['view', 'create', 'approve'],
  },

  employee: {
    action_items: RW,
    chat: RW,
    meetings: RW,
    deadlines: RO,
    notifications: RW,
    hr_attendance: RW,
    hr_leave: RW,
    hr_performance: RO,
    hr_hiring: [],
    employees: RO,
    sop: RO,
    kpi: RO,
    // Clients, pipeline, proposals and projects are not an employee's by
    // default. The owner opens them to one person (Team > person > extra
    // access), and an employee seated as a project's lead or manager keeps
    // Projects automatically so they can run it and file its daily update.
    crm: [],
    proposals: [],
    projects: [],
    invoices: [],
    costs: [],
    profitability: [],
    // Their own claims only - the row filter in the routes does the rest.
    reimbursements: [...RW, 'delete'],
    reimbursement_finance: [],
    reports: RO,
    dashboard: RO,
    settings: [],
    users: [],
    billing: [],
    audit: [],
    platform: [],
    meeting_intelligence: [],
  },

  finance: {
    action_items: RW,
    chat: RW,
    meetings: RO,
    deadlines: RO,
    notifications: RW,
    hr_attendance: RO,
    hr_leave: [],
    hr_performance: [],
    hr_hiring: [],
    employees: RO,
    sop: RO,
    kpi: RO,
    crm: RO,
    proposals: [...RO, 'export'],
    projects: RO,
    invoices: ALL,
    costs: ALL,
    profitability: [...RO, 'export'],
    // The finance desk: verify, approve or reject, record payment, report.
    reimbursements: [...RW, 'approve', 'export'],
    reimbursement_finance: ALL,
    reports: [...RW, 'export'],
    dashboard: RO,
    settings: RO,
    users: [],
    billing: [...RO, 'edit'],
    audit: RO,
    platform: [],
    meeting_intelligence: [],
  },

  hr: {
    action_items: RW,
    chat: [...RW, 'delete'],
    meetings: RW,
    deadlines: RO,
    notifications: RW,
    hr_attendance: ALL,
    hr_leave: ALL,
    hr_performance: ALL,
    hr_hiring: ALL,
    employees: [...RW, 'delete', 'export'],
    sop: RW,
    kpi: RW,
    crm: [],
    proposals: [],
    projects: RO,
    invoices: [],
    costs: [...RO, 'create'],
    profitability: [],
    reimbursements: [...RW, 'delete'],
    reimbursement_finance: [],
    reports: [...RW, 'export'],
    dashboard: RO,
    settings: RO,
    users: RW,
    billing: [],
    audit: RO,
    platform: [],
    meeting_intelligence: [],
  },

  // Portal user - read-only on their own reports/proposals/invoices (PRD 2.2)
  client: {
    action_items: [], meetings: [], deadlines: [], notifications: RO, chat: [],
    hr_attendance: [], hr_leave: [], hr_performance: [], hr_hiring: [], employees: [],
    sop: [], kpi: [],
    crm: [], proposals: [...RO, 'approve'], projects: [],
    invoices: RO, costs: [], profitability: [],
    reimbursements: [], reimbursement_finance: [],
    reports: RO, dashboard: [], settings: [], users: [], billing: [], audit: [],
    platform: [], meeting_intelligence: [],
  },
};

/** Data visibility scope per role: what rows they may see by default. */
export const ROLE_SCOPE = {
  super_admin: 'all',
  owner: 'all',
  manager: 'team',
  finance: 'all',
  hr: 'all',
  employee: 'own',
  client: 'client',
};

/** The roles whose access the workspace owner can change (Settings > Roles). */
export const EDITABLE_ROLES = ['manager', 'employee', 'finance', 'hr'];

/** Every role keeps these: the bell, and nobody but the platform team gets the platform console. */
export function normaliseAccess(perms) {
  const out = {};
  for (const m of MODULES) {
    let actions = [...new Set((perms?.[m] || []).filter((a) => ACTIONS.includes(a)))];
    if (actions.length && !actions.includes('view')) actions.unshift('view'); // doing anything needs seeing it
    if (m === 'notifications' && !actions.includes('view')) actions.unshift('view');
    if (m === 'platform') actions = [];
    out[m] = ACTIONS.filter((a) => actions.includes(a));
  }
  return out;
}

const permsCache = new Map();
const accessCache = new Map(); // `${tenantId}:${role}` -> the owner's map, or null for the template

/** The role's access in this workspace: what the owner set, else the built-in template. */
async function roleAccess(tenantId, role) {
  const template = ROLE_TEMPLATES[role] || {};
  if (!tenantId || !EDITABLE_ROLES.includes(role)) return template;
  const key = `${tenantId}:${role}`;
  if (!accessCache.has(key)) {
    const row = await get('SELECT permissions FROM role_access WHERE tenant_id = ? AND role = ?', [tenantId, role]);
    accessCache.set(key, row ? normaliseAccess(parseJson(row.permissions, {})) : null);
  }
  return accessCache.get(key) || template;
}
export { roleAccess };

/**
 * What this one person has on top of their role: the areas the owner opened to
 * them, and Projects for anyone seated as a project's lead or manager. Cached
 * briefly; changing someone's extra access clears their entry.
 */
const personCache = new Map();
const PERSON_TTL = 30_000;
async function personalAccess(auth) {
  if (!auth.userId || !auth.tenantId) return null;
  const hit = personCache.get(auth.userId);
  if (hit && hit.at > Date.now() - PERSON_TTL) return hit.access;
  const row = await get('SELECT extra_access FROM users WHERE id = ? AND tenant_id = ?', [auth.userId, auth.tenantId]);
  const access = { ...parseJson(row?.extra_access, {}) };
  const leads = await get(
    `SELECT 1 AS y FROM project_members pm JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
      WHERE pm.tenant_id = ? AND pm.user_id = ? AND pm.deleted_at IS NULL AND pm.seat IN ('manager', 'lead') LIMIT 1`,
    [auth.tenantId, auth.userId],
  );
  if (leads) access.projects = [...new Set([...(access.projects || []), 'view'])];
  personCache.set(auth.userId, { at: Date.now(), access });
  return access;
}
export const invalidatePersonAccess = (userId) => (userId ? personCache.delete(userId) : personCache.clear());

/** Role access, widened by what this person has been given. Never narrowed. */
async function permissionsFor(auth) {
  const base = await roleOrCustomAccess(auth);
  if (['owner', 'super_admin', 'client'].includes(auth.role)) return base;
  const extra = await personalAccess(auth);
  if (!extra || !Object.keys(extra).length) return base;
  const out = { ...base };
  for (const [m, actions] of Object.entries(extra)) {
    if (!MODULES.includes(m) || m === 'platform') continue;
    out[m] = ACTIONS.filter((a) => (base[m] || []).includes(a) || actions.includes(a));
  }
  return out;
}

async function roleOrCustomAccess(auth) {
  const base = await roleAccess(auth.tenantId, auth.role);
  if (!auth.customRoleId) return base;
  const cacheKey = auth.customRoleId;
  if (!permsCache.has(cacheKey)) {
    const row = await get('SELECT permissions, base_role FROM custom_roles WHERE id = ? AND deleted_at IS NULL', [
      auth.customRoleId,
    ]);
    permsCache.set(cacheKey, row ? { base_role: row.base_role, overrides: parseJson(row.permissions, {}) } : null);
  }
  const custom = permsCache.get(cacheKey);
  if (!custom) return base;
  return { ...(await roleAccess(auth.tenantId, custom.base_role)), ...custom.overrides };
}
export const invalidateRoleCache = (id) => (id ? permsCache.delete(id) : permsCache.clear());
/** After the owner changes a role's access, the next request uses it. */
export const invalidateRoleAccess = (tenantId, role) => accessCache.delete(`${tenantId}:${role}`);

export async function can(auth, module, action) {
  if (!auth) return false;
  const perms = await permissionsFor(auth);
  return Array.isArray(perms[module]) && perms[module].includes(action);
}

/** Express guard: `router.get('/x', requires('crm','view'), handler)`. */
export function requires(module, action) {
  return async (req, _res, next) => {
    if (!await can(req.auth, module, action)) {
      return next(forbidden(`Role "${req.auth?.role}" cannot ${action} ${module}`));
    }
    next();
  };
}

export async function permissionMatrix(auth) {
  const perms = await permissionsFor(auth);
  return Object.fromEntries(MODULES.map((m) => [m, perms[m] || []]));
}
