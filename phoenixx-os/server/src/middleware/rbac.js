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
    crm: RW,
    proposals: RW,
    // Read-only on projects and teams: an employee sees what they are on and
    // who else is, but cannot create, edit, restaff or delete a project.
    projects: RO,
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
    platform: [],
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

const permsCache = new Map();

async function permissionsFor(auth) {
  const base = ROLE_TEMPLATES[auth.role] || {};
  if (!auth.customRoleId) return base;
  const cacheKey = auth.customRoleId;
  if (!permsCache.has(cacheKey)) {
    const row = await get('SELECT permissions, base_role FROM custom_roles WHERE id = ? AND deleted_at IS NULL', [
      auth.customRoleId,
    ]);
    permsCache.set(cacheKey, row ? { ...(ROLE_TEMPLATES[row.base_role] || {}), ...parseJson(row.permissions, {}) } : null);
  }
  return permsCache.get(cacheKey) || base;
}
export const invalidateRoleCache = (id) => (id ? permsCache.delete(id) : permsCache.clear());

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
