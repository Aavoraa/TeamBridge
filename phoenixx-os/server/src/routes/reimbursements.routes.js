import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso, todayIso, monthIso, toCsv, toMajor } from '../lib/util.js';
import {
  ok, created, validate, notFound, badRequest, forbidden, audit, paginate, pageMeta,
} from '../lib/http.js';
import { can, requires } from '../middleware/rbac.js';
import { notifyMany } from '../services/notifications.js';
import { EXPENSE_CATEGORY_PACK } from '../services/provisioning.js';

const router = Router();

/**
 * Module I - employee expense reimbursement.
 *
 * The lifecycle is a two-gate approval:
 *
 *   draft -> submitted -> manager_approved -> approved -> paid
 *              (manager)     (finance)       (finance)   (finance)
 *
 * with `rejected` reachable from either gate and `cancelled` reachable by the
 * claimant while nobody has decided yet. `status` says where a request sits
 * now; reimbursement_events keeps the whole trail, because a money decision
 * should never have to be reconstructed from a set of timestamps.
 *
 * Three questions decide what a caller may do, and all three are answered on
 * the server for every request:
 *   - whose rows can they see?          -> visibilityFilter()
 *   - may they act at the manager gate? -> can(auth, 'reimbursements', 'approve')
 *   - may they act at the finance desk? -> can(auth, 'reimbursement_finance', ...)
 * Hiding a button in the UI is presentation. These are the enforcement.
 */

// ------------------------------------------------------------------ statuses
const OPEN_FOR_MANAGER = 'submitted';
const OPEN_FOR_FINANCE = 'manager_approved';
const TERMINAL = ['paid', 'rejected', 'cancelled'];

/** Human-facing stage labels, kept beside the statuses that produce them. */
export const STAGES = [
  { status: 'draft', label: 'Draft', stage: 'Draft' },
  { status: 'submitted', label: 'Awaiting manager', stage: 'Manager approval' },
  { status: 'manager_approved', label: 'Awaiting finance', stage: 'Finance review' },
  { status: 'approved', label: 'Approved for payment', stage: 'Approved' },
  { status: 'paid', label: 'Paid', stage: 'Paid' },
  { status: 'rejected', label: 'Rejected', stage: 'Rejected' },
  { status: 'cancelled', label: 'Withdrawn', stage: 'Withdrawn' },
];

// ---------------------------------------------------------------- categories
/**
 * Seeds the starter categories the first time a workspace touches the module.
 * New tenants get them at provisioning; this covers the ones that already
 * existed before the module shipped.
 */
export async function ensureExpenseCategories(tenantId) {
  const n = Number((await get('SELECT COUNT(*) AS n FROM expense_categories WHERE tenant_id = ?', [tenantId]))?.n || 0);
  if (n) return;
  const at = nowIso();
  for (const [i, c] of EXPENSE_CATEGORY_PACK.entries()) {
    await run(
      `INSERT INTO expense_categories (id, tenant_id, name, code, description,
         requires_receipt, cap_minor, color, sort, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
      [uuid(), tenantId, c.name, c.code, c.description ?? null, c.requires_receipt ?? 1,
        c.cap_minor ?? null, c.color, i, at],
    );
  }
}

router.get('/categories', requires('reimbursements', 'view'), async (req, res) => {
  await ensureExpenseCategories(req.auth.tenantId);
  return ok(res, await all(
    `SELECT * FROM expense_categories WHERE tenant_id = ?${req.query.include_inactive === 'true' ? '' : ' AND active = 1'}
      ORDER BY sort, name`,
    [req.auth.tenantId],
  ));
});

const categorySchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().min(2).max(30).regex(/^[a-z0-9_]+$/i, 'Letters, digits and underscores only'),
  description: z.string().max(400).optional().nullable(),
  requires_receipt: z.boolean().optional(),
  cap_minor: z.number().int().min(0).optional().nullable(),
  color: z.string().max(20).optional(),
  active: z.boolean().optional(),
});

router.post('/categories', requires('reimbursement_finance', 'edit'), async (req, res) => {
  const body = validate(categorySchema, req.body);
  const id = uuid();
  const dup = await get('SELECT id FROM expense_categories WHERE tenant_id = ? AND code = ?', [req.auth.tenantId, body.code]);
  if (dup) throw badRequest(`A category with the code "${body.code}" already exists`);

  await run(
    `INSERT INTO expense_categories (id, tenant_id, name, code, description, requires_receipt,
       cap_minor, color, active, sort, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.name, body.code, body.description ?? null,
      body.requires_receipt === false ? 0 : 1, body.cap_minor ?? null, body.color || '#3B82F6',
      body.active === false ? 0 : 1, 99, nowIso()],
  );
  await audit(req, { entity: 'expense_category', entityId: id, action: 'create', after: body });
  return created(res, await get('SELECT * FROM expense_categories WHERE id = ?', [id]));
});

router.patch('/categories/:id', requires('reimbursement_finance', 'edit'), async (req, res) => {
  const before = await get('SELECT * FROM expense_categories WHERE id = ? AND tenant_id = ?',
    [req.params.id, req.auth.tenantId]);
  if (!before) throw notFound('Expense category');

  const body = validate(categorySchema.partial().omit({ code: true }), req.body);
  const patch = { ...body };
  if (body.requires_receipt !== undefined) patch.requires_receipt = body.requires_receipt ? 1 : 0;
  if (body.active !== undefined) patch.active = body.active ? 1 : 0;

  const cols = Object.keys(patch);
  if (cols.length) {
    await run(`UPDATE expense_categories SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
      [...cols.map((c) => patch[c]), before.id, req.auth.tenantId]);
  }
  await audit(req, { entity: 'expense_category', entityId: before.id, action: 'update', before, after: patch });
  return ok(res, await get('SELECT * FROM expense_categories WHERE id = ?', [before.id]));
});

// ------------------------------------------------------------------ visibility
/**
 * Which rows this caller may see at all.
 *
 * Finance and admins: everything. A manager: their own claims plus their team's
 * (both people reporting to them and anything routed to them for decision).
 * Everyone else: strictly their own. The same filter guards the list, the
 * detail, the reports and the export - there is no path around it.
 */
async function visibilityFilter(auth) {
  const { userId, tenantId } = auth;
  if (await can(auth, 'reimbursement_finance', 'view')) return { where: '', params: [], scope: 'all' };
  if (await can(auth, 'reimbursements', 'approve')) {
    return {
      where: `(r.user_id = ? OR r.manager_id = ?
               OR r.user_id IN (SELECT id FROM users WHERE tenant_id = ? AND manager_id = ? AND deleted_at IS NULL))`,
      params: [userId, userId, tenantId, userId],
      scope: 'team',
    };
  }
  return { where: 'r.user_id = ?', params: [userId], scope: 'own' };
}

const SELECT_BASE = `
  SELECT r.*, u.name AS user_name, u.avatar_url, u.designation, u.email AS user_email,
         ec.name AS category_name, ec.code AS category_code, ec.color AS category_color,
         ec.requires_receipt,
         m.name AS manager_name, fd.name AS finance_decided_by_name,
         md.name AS manager_decided_by_name, pb.name AS paid_by_name,
         c.name AS client_name, p.name AS project_name,
         (SELECT COUNT(*) FROM attachments a
           WHERE a.entity = 'reimbursement' AND a.entity_id = r.id AND a.deleted_at IS NULL) AS document_count
    FROM reimbursements r
    JOIN users u ON u.id = r.user_id
    LEFT JOIN expense_categories ec ON ec.id = r.category_id
    LEFT JOIN users m ON m.id = r.manager_id
    LEFT JOIN users md ON md.id = r.manager_decided_by
    LEFT JOIN users fd ON fd.id = r.finance_decided_by
    LEFT JOIN users pb ON pb.id = r.paid_by
    LEFT JOIN clients c ON c.id = r.client_id
    LEFT JOIN projects p ON p.id = r.project_id`;

/** Loads a request the caller is allowed to see, or 404s as if it did not exist. */
async function visibleOr404(req, id) {
  const v = await visibilityFilter(req.auth);
  const row = await get(
    `${SELECT_BASE} WHERE r.id = ? AND r.tenant_id = ? AND r.deleted_at IS NULL${v.where ? ` AND ${v.where}` : ''}`,
    [id, req.auth.tenantId, ...v.params],
  );
  if (!row) throw notFound('Reimbursement request');
  return row;
}

/**
 * Exported for the attachment endpoints: a receipt is only as private as the
 * claim it hangs off, so /files checks this before listing or accepting one.
 */
export async function canAccessReimbursement(auth, id) {
  const v = await visibilityFilter(auth);
  return !!await get(
    `SELECT r.id FROM reimbursements r
      WHERE r.id = ? AND r.tenant_id = ? AND r.deleted_at IS NULL${v.where ? ` AND ${v.where}` : ''}`,
    [id, auth.tenantId, ...v.params],
  );
}

// ---------------------------------------------------------------- audit trail
async function logEvent(req, reimbursementId, { action, from, to, note = null, meta = null }) {
  await run(
    `INSERT INTO reimbursement_events (id, tenant_id, reimbursement_id, actor_id, actor_name,
       action, from_status, to_status, note, meta, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), req.auth.tenantId, reimbursementId, req.auth.userId, req.auth.name, action,
      from ?? null, to ?? null, note, meta ? JSON.stringify(meta) : null, nowIso()],
  );
}

const historyFor = async (tenantId, id) => await all(
  `SELECT e.*, u.avatar_url FROM reimbursement_events e
     LEFT JOIN users u ON u.id = e.actor_id
    WHERE e.tenant_id = ? AND e.reimbursement_id = ? ORDER BY e.created_at`,
  [tenantId, id],
);

const documentsFor = async (tenantId, id) => (await all(
  `SELECT a.id, a.filename, a.mime, a.size_bytes, a.storage_path, a.created_at,
          u.name AS uploaded_by_name
     FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
    WHERE a.tenant_id = ? AND a.entity = 'reimbursement' AND a.entity_id = ? AND a.deleted_at IS NULL
    ORDER BY a.created_at`,
  [tenantId, id],
)).map((a) => ({ ...a, url: `/api/v1/files/${a.storage_path}` }));

/**
 * Who to tell when something reaches the finance desk. Role-based rather than
 * permission-derived: this only decides who gets a message, never who may act,
 * and there is no index that would make "everyone whose custom role grants
 * reimbursement_finance:approve" a cheap query.
 */
const financeTeam = async (tenantId) => (await all(
  `SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
     AND role IN ('finance', 'owner', 'super_admin')`,
  [tenantId],
)).map((u) => u.id);

/**
 * REIMB-2026-0007. Assigned on submit, so a draft never burns a number.
 *
 * Allocated the same way invoice numbers are (services/numbering.js): a single
 * atomic UPDATE ... RETURNING inside the caller's transaction, so two people
 * submitting at once cannot read the same sequence.
 */
async function nextNumber(tenantId) {
  const year = todayIso().slice(0, 4);
  await run(`INSERT INTO reimbursement_counters (tenant_id, year, next_number) VALUES (?,?,0)
       ON CONFLICT (tenant_id, year) DO NOTHING`, [tenantId, year]);
  const row = await get(
    `UPDATE reimbursement_counters SET next_number = next_number + 1
      WHERE tenant_id = ? AND year = ? RETURNING next_number`,
    [tenantId, year],
  );
  if (!row) throw badRequest('Could not allocate a reimbursement number');
  return `REIMB-${year}-${String(Number(row.next_number)).padStart(4, '0')}`;
}

// --------------------------------------------------------------------- list
router.get('/', requires('reimbursements', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const v = await visibilityFilter(req.auth);
  const filters = ['r.tenant_id = ?', 'r.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  if (v.where) { filters.push(v.where); params.push(...v.params); }

  // `mine=true` narrows a manager's or finance user's view back to their own
  // claims - "My reimbursements" means mine even when you can see everyone's.
  if (req.query.mine === 'true') { filters.push('r.user_id = ?'); params.push(req.auth.userId); }

  // The two work queues. Both are further restricted by the visibility filter
  // above, so `queue=manager` cannot be used to read another manager's team.
  if (req.query.queue === 'manager') {
    if (!await can(req.auth, 'reimbursements', 'approve')) throw forbidden('You cannot review reimbursement requests');
    filters.push('r.status = ?');
    params.push(OPEN_FOR_MANAGER);
  }
  if (req.query.queue === 'finance') {
    if (!await can(req.auth, 'reimbursement_finance', 'view')) throw forbidden('Finance review is restricted to the finance team');
    filters.push(`r.status IN ('${OPEN_FOR_FINANCE}', 'approved')`);
  }

  if (req.query.status) {
    const wanted = String(req.query.status).split(',').filter(Boolean);
    filters.push(`r.status IN (${wanted.map(() => '?').join(',')})`);
    params.push(...wanted);
  }
  if (req.query.user_id) { filters.push('r.user_id = ?'); params.push(req.query.user_id); }
  if (req.query.category_id) { filters.push('r.category_id = ?'); params.push(req.query.category_id); }
  if (req.query.from) { filters.push('r.expense_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('r.expense_date <= ?'); params.push(req.query.to); }
  if (req.query.search) {
    filters.push('(r.description LIKE ? OR r.merchant LIKE ? OR r.number LIKE ? OR u.name LIKE ?)');
    const q = `%${req.query.search}%`;
    params.push(q, q, q, q);
  }

  const where = filters.join(' AND ');
  const countSql = `SELECT COUNT(*) AS n FROM reimbursements r JOIN users u ON u.id = r.user_id WHERE ${where}`;
  const total = Number((await get(countSql, params))?.n || 0);

  const rows = await all(
    `${SELECT_BASE} WHERE ${where} ORDER BY r.expense_date DESC, r.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const byStatus = (await all(
    `SELECT r.status, COUNT(*) AS n, COALESCE(SUM(r.amount_minor),0) AS amount_minor
       FROM reimbursements r JOIN users u ON u.id = r.user_id
      WHERE ${where} GROUP BY r.status`,
    params,
  )).map((s) => ({ ...s, n: Number(s.n), amount_minor: Number(s.amount_minor) }));

  return ok(res, rows, {
    ...pageMeta(page, limit, total),
    scope: v.scope,
    by_status: byStatus,
    total_minor: byStatus.reduce((a, s) => a + s.amount_minor, 0),
  });
});

/** Badge counts for the two approval queues, cheap enough to poll. */
router.get('/queues', requires('reimbursements', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const isManager = await can(req.auth, 'reimbursements', 'approve');
  const isFinance = await can(req.auth, 'reimbursement_finance', 'view');
  const v = await visibilityFilter(req.auth);

  return ok(res, {
    mine_open: Number((await get(
      `SELECT COUNT(*) AS n FROM reimbursements WHERE tenant_id = ? AND user_id = ? AND deleted_at IS NULL
         AND status NOT IN ('paid','rejected','cancelled')`,
      [tenantId, userId],
    ))?.n || 0),
    manager_pending: isManager ? Number((await get(
      `SELECT COUNT(*) AS n FROM reimbursements r WHERE r.tenant_id = ? AND r.deleted_at IS NULL
         AND r.status = ?${v.where ? ` AND ${v.where}` : ''}`,
      [tenantId, OPEN_FOR_MANAGER, ...v.params],
    ))?.n || 0) : 0,
    finance_pending: isFinance ? Number((await get(
      "SELECT COUNT(*) AS n FROM reimbursements WHERE tenant_id = ? AND deleted_at IS NULL AND status = ?",
      [tenantId, OPEN_FOR_FINANCE],
    ))?.n || 0) : 0,
    awaiting_payment: isFinance ? Number((await get(
      "SELECT COUNT(*) AS n FROM reimbursements WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'approved'",
      [tenantId],
    ))?.n || 0) : 0,
  });
});

// ------------------------------------------------------------------- reports
/**
 * Expense & reimbursement reporting. Aggregates over exactly the rows the
 * caller may see, so a manager's report covers their team and nobody else's.
 */
router.get('/reports', requires('reimbursements', 'export'), async (req, res) => {
  const v = await visibilityFilter(req.auth);
  const filters = ['r.tenant_id = ?', 'r.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  if (v.where) { filters.push(v.where); params.push(...v.params); }

  const from = req.query.from || `${monthIso()}-01`;
  const to = req.query.to || todayIso();
  filters.push('r.expense_date >= ?', 'r.expense_date <= ?');
  params.push(from, to);

  if (req.query.status) {
    const wanted = String(req.query.status).split(',').filter(Boolean);
    filters.push(`r.status IN (${wanted.map(() => '?').join(',')})`);
    params.push(...wanted);
  }
  if (req.query.category_id) { filters.push('r.category_id = ?'); params.push(req.query.category_id); }
  if (req.query.user_id) { filters.push('r.user_id = ?'); params.push(req.query.user_id); }

  const where = filters.join(' AND ');
  const numeric = (rows) => rows.map((r) => ({
    ...r,
    n: Number(r.n),
    claimed_minor: Number(r.claimed_minor || 0),
    paid_minor: Number(r.paid_minor || 0),
  }));

  const totals = await get(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(r.amount_minor),0) AS claimed_minor,
            COALESCE(SUM(CASE WHEN r.status = 'paid' THEN COALESCE(r.paid_minor, r.approved_minor, r.amount_minor) ELSE 0 END),0) AS paid_minor,
            COALESCE(SUM(CASE WHEN r.status = 'approved' THEN COALESCE(r.approved_minor, r.amount_minor) ELSE 0 END),0) AS awaiting_payment_minor,
            COALESCE(SUM(CASE WHEN r.status IN ('submitted','manager_approved') THEN r.amount_minor ELSE 0 END),0) AS in_flight_minor,
            COALESCE(SUM(CASE WHEN r.status = 'rejected' THEN r.amount_minor ELSE 0 END),0) AS rejected_minor
       FROM reimbursements r WHERE ${where}`,
    params,
  ) || {};

  return ok(res, {
    from,
    to,
    scope: v.scope,
    totals: Object.fromEntries(Object.entries(totals).map(([k, val]) => [k, Number(val || 0)])),
    by_status: numeric(await all(
      `SELECT r.status, COUNT(*) AS n, COALESCE(SUM(r.amount_minor),0) AS claimed_minor,
              COALESCE(SUM(COALESCE(r.paid_minor,0)),0) AS paid_minor
         FROM reimbursements r WHERE ${where} GROUP BY r.status`,
      params,
    )),
    by_category: numeric(await all(
      `SELECT COALESCE(ec.name, 'Uncategorised') AS category, ec.color,
              COUNT(*) AS n, COALESCE(SUM(r.amount_minor),0) AS claimed_minor,
              COALESCE(SUM(COALESCE(r.paid_minor,0)),0) AS paid_minor
         FROM reimbursements r LEFT JOIN expense_categories ec ON ec.id = r.category_id
        WHERE ${where} GROUP BY r.category_id, ec.name, ec.color ORDER BY claimed_minor DESC`,
      params,
    )),
    by_month: numeric(await all(
      `SELECT substr(r.expense_date, 1, 7) AS month, COUNT(*) AS n,
              COALESCE(SUM(r.amount_minor),0) AS claimed_minor,
              COALESCE(SUM(COALESCE(r.paid_minor,0)),0) AS paid_minor
         FROM reimbursements r WHERE ${where} GROUP BY month ORDER BY month`,
      params,
    )),
    by_user: numeric(await all(
      `SELECT u.id AS user_id, u.name, u.avatar_url, u.designation, COUNT(*) AS n,
              COALESCE(SUM(r.amount_minor),0) AS claimed_minor,
              COALESCE(SUM(COALESCE(r.paid_minor,0)),0) AS paid_minor
         FROM reimbursements r JOIN users u ON u.id = r.user_id
        WHERE ${where} GROUP BY u.id ORDER BY claimed_minor DESC`,
      params,
    )),
  });
});

router.get('/reports/export', requires('reimbursements', 'export'), async (req, res) => {
  const v = await visibilityFilter(req.auth);
  const filters = ['r.tenant_id = ?', 'r.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  if (v.where) { filters.push(v.where); params.push(...v.params); }
  if (req.query.from) { filters.push('r.expense_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('r.expense_date <= ?'); params.push(req.query.to); }
  if (req.query.status) {
    const wanted = String(req.query.status).split(',').filter(Boolean);
    filters.push(`r.status IN (${wanted.map(() => '?').join(',')})`);
    params.push(...wanted);
  }

  const rows = (await all(`${SELECT_BASE} WHERE ${filters.join(' AND ')} ORDER BY r.expense_date DESC`, params))
    .map((r) => ({
      number: r.number || '',
      employee: r.user_name,
      email: r.user_email,
      expense_date: r.expense_date,
      category: r.category_name || '',
      description: r.description,
      merchant: r.merchant || '',
      claimed: toMajor(r.amount_minor),
      approved: r.approved_minor == null ? '' : toMajor(r.approved_minor),
      paid: r.paid_minor == null ? '' : toMajor(r.paid_minor),
      status: r.status,
      submitted_at: r.submitted_at || '',
      manager: r.manager_decided_by_name || r.manager_name || '',
      manager_decided_at: r.manager_decided_at || '',
      finance_reviewer: r.finance_decided_by_name || '',
      finance_decided_at: r.finance_decided_at || '',
      paid_at: r.paid_at || '',
      payment_method: r.payment_method || '',
      payment_reference: r.payment_reference || '',
      documents: r.document_count,
      rejection_reason: r.rejection_reason || '',
    }));

  await audit(req, { entity: 'reimbursement', action: 'export', after: { rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="reimbursements.csv"');
  return res.send(toCsv(rows));
});

// ------------------------------------------------------------------- detail
router.get('/:id', requires('reimbursements', 'view'), async (req, res) => {
  const r = await visibleOr404(req, req.params.id);
  return ok(res, {
    ...r,
    documents: await documentsFor(req.auth.tenantId, r.id),
    history: await historyFor(req.auth.tenantId, r.id),
    /** What this caller may do next, so the UI never has to guess the rules. */
    permissions: {
      edit: r.user_id === req.auth.userId && ['draft', 'rejected'].includes(r.status),
      submit: r.user_id === req.auth.userId && ['draft', 'rejected'].includes(r.status),
      withdraw: r.user_id === req.auth.userId && [OPEN_FOR_MANAGER, OPEN_FOR_FINANCE].includes(r.status),
      manager_decide: r.status === OPEN_FOR_MANAGER && await canDecideAsManager(req.auth, r),
      finance_decide: r.status === OPEN_FOR_FINANCE && await can(req.auth, 'reimbursement_finance', 'approve'),
      pay: r.status === 'approved' && await can(req.auth, 'reimbursement_finance', 'approve'),
      delete: r.user_id === req.auth.userId && r.status === 'draft',
      upload: r.user_id === req.auth.userId && !TERMINAL.includes(r.status),
    },
  });
});

// ------------------------------------------------------------------- create
const requestSchema = z.object({
  category_id: z.string().optional().nullable(),
  expense_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount_minor: z.number().int().min(1, 'Enter the amount you spent'),
  description: z.string().trim().min(3).max(2000),
  merchant: z.string().max(160).optional().nullable(),
  client_id: z.string().optional().nullable(),
  project_id: z.string().optional().nullable(),
  payment_mode: z.enum(['cash', 'card', 'upi', 'netbanking', 'other']).optional().nullable(),
});

/** Shared checks that hold whoever is writing and whatever the status. */
function assertSane(body) {
  if (body.expense_date && body.expense_date > todayIso()) {
    throw badRequest('An expense cannot be dated in the future');
  }
}

router.post('/', requires('reimbursements', 'create'), async (req, res) => {
  const body = validate(requestSchema.extend({ submit: z.boolean().optional() }), req.body);
  assertSane(body);
  await ensureExpenseCategories(req.auth.tenantId);

  const { tenantId, userId, managerId } = req.auth;
  const at = nowIso();
  const id = uuid();

  if (body.category_id && !await get('SELECT id FROM expense_categories WHERE id = ? AND tenant_id = ?',
    [body.category_id, tenantId])) throw badRequest('That expense category does not exist');

  await run(
    `INSERT INTO reimbursements (id, tenant_id, user_id, category_id, expense_date, amount_minor,
       description, merchant, client_id, project_id, payment_mode, status, manager_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?, 'draft', ?, ?, ?)`,
    [id, tenantId, userId, body.category_id ?? null, body.expense_date, body.amount_minor,
      body.description, body.merchant ?? null, body.client_id ?? null, body.project_id ?? null,
      body.payment_mode ?? null, managerId ?? null, at, at],
  );
  await logEvent(req, id, { action: 'created', from: null, to: 'draft' });
  await audit(req, { entity: 'reimbursement', entityId: id, action: 'create', after: { amount_minor: body.amount_minor } });

  // Saving and submitting in one go is the common case; a draft is for the
  // person who still has to go and find the receipt. One transaction, so a
  // failure cannot leave a claim holding a number it never used.
  if (body.submit) await tx(async () => await submitRequest(req, await get('SELECT * FROM reimbursements WHERE id = ?', [id])));

  return created(res, await get(`${SELECT_BASE} WHERE r.id = ?`, [id]));
});

router.patch('/:id', requires('reimbursements', 'edit'), async (req, res) => {
  const before = await visibleOr404(req, req.params.id);
  // Editing is the claimant's alone: once submitted, the numbers a manager or
  // finance is looking at must not move under them.
  if (before.user_id !== req.auth.userId) throw forbidden('Only the person who raised a claim can edit it');
  if (!['draft', 'rejected'].includes(before.status)) {
    throw badRequest('A submitted request cannot be edited. Withdraw it first, or raise a new one.');
  }

  const body = validate(requestSchema.partial(), req.body);
  assertSane(body);
  if (body.category_id && !await get('SELECT id FROM expense_categories WHERE id = ? AND tenant_id = ?',
    [body.category_id, req.auth.tenantId])) throw badRequest('That expense category does not exist');

  const patch = { ...body, updated_at: nowIso() };
  const cols = Object.keys(patch);
  await run(`UPDATE reimbursements SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
    [...cols.map((c) => patch[c]), before.id, req.auth.tenantId]);

  await logEvent(req, before.id, { action: 'updated', from: before.status, to: before.status });
  await audit(req, { entity: 'reimbursement', entityId: before.id, action: 'update', before, after: body });
  return ok(res, await get(`${SELECT_BASE} WHERE r.id = ?`, [before.id]));
});

router.delete('/:id', requires('reimbursements', 'delete'), async (req, res) => {
  const before = await visibleOr404(req, req.params.id);
  if (before.user_id !== req.auth.userId) throw forbidden('Only the person who raised a claim can delete it');
  if (before.status !== 'draft') throw badRequest('Only a draft can be deleted. Withdraw a submitted request instead.');

  await run('UPDATE reimbursements SET deleted_at = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
    [nowIso(), nowIso(), before.id, req.auth.tenantId]);
  await audit(req, { entity: 'reimbursement', entityId: before.id, action: 'delete', before });
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------- submit
/**
 * Draft -> submitted. With no manager on file the request skips straight to
 * the finance desk rather than sitting in a queue nobody owns.
 */
async function submitRequest(req, row) {
  const { tenantId } = req.auth;
  const at = nowIso();
  const manager = row.manager_id || req.auth.managerId || null;
  const to = manager ? OPEN_FOR_MANAGER : OPEN_FOR_FINANCE;
  const number = row.number || await nextNumber(tenantId);

  await run(
    `UPDATE reimbursements SET status = ?, number = ?, submitted_at = ?, manager_id = ?,
       rejection_reason = NULL, updated_at = ? WHERE id = ? AND tenant_id = ?`,
    [to, number, at, manager, at, row.id, tenantId],
  );

  await logEvent(req, row.id, {
    action: 'submitted',
    from: row.status,
    to,
    note: manager ? null : 'No reporting manager on file - routed straight to the finance desk',
    meta: { amount_minor: row.amount_minor },
  });

  const vars = {
    number,
    employee: req.auth.name,
    amount: toMajor(row.amount_minor).toFixed(2),
    expense_date: row.expense_date,
    description: row.description,
  };
  await notifyMany({
    tenantId,
    userIds: manager ? [manager] : await financeTeam(tenantId),
    eventKey: 'reimbursement.submitted',
    vars,
    link: `/finance/reimbursements/${manager ? 'approvals' : 'review'}`,
  }).catch(() => {});

  return to;
}

router.post('/:id/submit', requires('reimbursements', 'create'), async (req, res) => {
  const before = await visibleOr404(req, req.params.id);
  if (before.user_id !== req.auth.userId) throw forbidden('Only the person who raised a claim can submit it');
  if (!['draft', 'rejected'].includes(before.status)) throw badRequest('This request has already been submitted');

  const category = before.category_id
    ? await get('SELECT * FROM expense_categories WHERE id = ?', [before.category_id]) : null;
  const docs = Number((await get(
    `SELECT COUNT(*) AS n FROM attachments WHERE tenant_id = ? AND entity = 'reimbursement'
       AND entity_id = ? AND deleted_at IS NULL`,
    [req.auth.tenantId, before.id],
  ))?.n || 0);
  if (category?.requires_receipt && !docs) {
    throw badRequest(`${category.name} claims need a bill or receipt attached before they can be submitted`);
  }

  const to = await tx(async () => await submitRequest(req, before));
  await audit(req, { entity: 'reimbursement', entityId: before.id, action: 'update', after: { status: to } });
  return ok(res, await get(`${SELECT_BASE} WHERE r.id = ?`, [before.id]));
});

/** The claimant pulling a request back out of the queue. */
router.post('/:id/withdraw', requires('reimbursements', 'create'), async (req, res) => {
  const before = await visibleOr404(req, req.params.id);
  if (before.user_id !== req.auth.userId) throw forbidden('Only the person who raised a claim can withdraw it');
  if (![OPEN_FOR_MANAGER, OPEN_FOR_FINANCE].includes(before.status)) {
    throw badRequest('Only a request still awaiting a decision can be withdrawn');
  }
  const { note } = validate(z.object({ note: z.string().max(1000).optional() }), req.body || {});

  await run("UPDATE reimbursements SET status = 'cancelled', updated_at = ? WHERE id = ? AND tenant_id = ?",
    [nowIso(), before.id, req.auth.tenantId]);
  await logEvent(req, before.id, { action: 'withdrawn', from: before.status, to: 'cancelled', note: note ?? null });
  await audit(req, { entity: 'reimbursement', entityId: before.id, action: 'update', after: { status: 'cancelled' } });
  return ok(res, await get(`${SELECT_BASE} WHERE r.id = ?`, [before.id]));
});

// --------------------------------------------------------- gate 1: manager
/**
 * A manager decides on their own team's claims. Holding the `approve` action is
 * not enough on its own: the request has to be routed to them, or belong to
 * somebody who reports to them. Finance-side admins can always step in, which
 * is what keeps a claim moving when a manager is away.
 */
async function canDecideAsManager(auth, row) {
  if (row.user_id === auth.userId && !await can(auth, 'reimbursement_finance', 'approve')) return false;
  if (await can(auth, 'reimbursement_finance', 'approve')) return true;
  if (!await can(auth, 'reimbursements', 'approve')) return false;
  if (row.manager_id === auth.userId) return true;
  return !!await get('SELECT id FROM users WHERE id = ? AND tenant_id = ? AND manager_id = ? AND deleted_at IS NULL',
    [row.user_id, auth.tenantId, auth.userId]);
}

const decisionSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(2000).optional().nullable(),
});

router.post('/:id/manager-decision', requires('reimbursements', 'approve'), async (req, res) => {
  const before = await visibleOr404(req, req.params.id);
  const { decision, note } = validate(decisionSchema, req.body);

  if (before.status !== OPEN_FOR_MANAGER) throw badRequest('This request is not waiting on a manager decision');
  if (!await canDecideAsManager(req.auth, before)) throw forbidden('This request is not yours to approve');
  if (decision === 'rejected' && !note?.trim()) throw badRequest('Tell the claimant why it was rejected');

  const at = nowIso();
  const to = decision === 'approved' ? OPEN_FOR_FINANCE : 'rejected';
  await run(
    `UPDATE reimbursements SET status = ?, manager_decision = ?, manager_decided_at = ?,
       manager_decided_by = ?, manager_note = ?, rejection_reason = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
    [to, decision, at, req.auth.userId, note ?? null, decision === 'rejected' ? note : null,
      at, before.id, req.auth.tenantId],
  );
  await logEvent(req, before.id, {
    action: decision === 'approved' ? 'manager_approved' : 'manager_rejected',
    from: before.status, to, note: note ?? null,
  });

  const vars = {
    number: before.number, employee: before.user_name, decided_by: req.auth.name,
    amount: toMajor(before.amount_minor).toFixed(2), stage: 'manager',
    status: decision, note: note ? ` Note: ${note}` : '',
  };
  await notifyMany({
    tenantId: req.auth.tenantId, userIds: [before.user_id],
    eventKey: 'reimbursement.decided', vars, link: `/finance/reimbursements/history?open=${before.id}`,
  }).catch(() => {});
  if (decision === 'approved') {
    await notifyMany({
      tenantId: req.auth.tenantId, userIds: await financeTeam(req.auth.tenantId),
      eventKey: 'reimbursement.finance_review', vars, link: '/finance/reimbursements/review',
    }).catch(() => {});
  }

  await audit(req, { entity: 'reimbursement', entityId: before.id, action: decision === 'approved' ? 'approve' : 'reject' });
  return ok(res, await get(`${SELECT_BASE} WHERE r.id = ?`, [before.id]));
});

// --------------------------------------------------------- gate 2: finance
router.post('/:id/finance-decision', requires('reimbursement_finance', 'approve'), async (req, res) => {
  const before = await visibleOr404(req, req.params.id);
  const { decision, note, approved_minor: approved } = validate(
    decisionSchema.extend({ approved_minor: z.number().int().min(0).optional() }), req.body,
  );

  if (before.status !== OPEN_FOR_FINANCE) throw badRequest('This request is not in finance review');
  if (decision === 'rejected' && !note?.trim()) throw badRequest('Tell the claimant why it was rejected');
  if (approved != null && approved > before.amount_minor) {
    throw badRequest('The approved amount cannot exceed what was claimed');
  }

  const at = nowIso();
  const to = decision === 'approved' ? 'approved' : 'rejected';
  const settled = decision === 'approved' ? (approved ?? before.amount_minor) : null;

  await run(
    `UPDATE reimbursements SET status = ?, finance_decision = ?, finance_decided_at = ?,
       finance_decided_by = ?, finance_note = ?, approved_minor = ?, rejection_reason = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
    [to, decision, at, req.auth.userId, note ?? null, settled,
      decision === 'rejected' ? note : null, at, before.id, req.auth.tenantId],
  );
  await logEvent(req, before.id, {
    action: decision === 'approved' ? 'finance_approved' : 'finance_rejected',
    from: before.status, to, note: note ?? null,
    meta: settled != null && settled !== before.amount_minor
      ? { claimed_minor: before.amount_minor, approved_minor: settled } : null,
  });

  await notifyMany({
    tenantId: req.auth.tenantId, userIds: [before.user_id],
    eventKey: 'reimbursement.decided',
    vars: {
      number: before.number, employee: before.user_name, decided_by: req.auth.name,
      amount: toMajor(settled ?? before.amount_minor).toFixed(2), stage: 'finance',
      status: decision, note: note ? ` Note: ${note}` : '',
    },
    link: `/finance/reimbursements/history?open=${before.id}`,
  }).catch(() => {});

  await audit(req, { entity: 'reimbursement', entityId: before.id, action: decision === 'approved' ? 'approve' : 'reject' });
  return ok(res, await get(`${SELECT_BASE} WHERE r.id = ?`, [before.id]));
});

// ---------------------------------------------------------------- payment
const paymentSchema = z.object({
  paid_minor: z.number().int().min(0).optional(),
  payment_method: z.enum(['bank_transfer', 'upi', 'cash', 'cheque', 'payroll', 'other']),
  payment_reference: z.string().max(120).optional().nullable(),
  paid_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  note: z.string().max(1000).optional().nullable(),
});

router.post('/:id/pay', requires('reimbursement_finance', 'approve'), async (req, res) => {
  const before = await visibleOr404(req, req.params.id);
  const body = validate(paymentSchema, req.body);

  if (before.status !== 'approved') throw badRequest('Only an approved request can be marked paid');
  const amount = body.paid_minor ?? before.approved_minor ?? before.amount_minor;
  if (amount > (before.approved_minor ?? before.amount_minor)) {
    throw badRequest('The payment cannot exceed the approved amount');
  }

  const at = body.paid_at ? `${body.paid_at}T00:00:00.000Z` : nowIso();
  await run(
    `UPDATE reimbursements SET status = 'paid', paid_at = ?, paid_by = ?, paid_minor = ?,
       payment_method = ?, payment_reference = ?, payment_note = ?, updated_at = ?
     WHERE id = ? AND tenant_id = ?`,
    [at, req.auth.userId, amount, body.payment_method, body.payment_reference ?? null,
      body.note ?? null, nowIso(), before.id, req.auth.tenantId],
  );
  await logEvent(req, before.id, {
    action: 'paid', from: before.status, to: 'paid', note: body.note ?? null,
    meta: { paid_minor: amount, method: body.payment_method, reference: body.payment_reference ?? null },
  });

  await notifyMany({
    tenantId: req.auth.tenantId, userIds: [before.user_id],
    eventKey: 'reimbursement.paid',
    vars: {
      number: before.number, amount: toMajor(amount).toFixed(2),
      method: body.payment_method.replace('_', ' '),
      reference: body.payment_reference ? ` (ref ${body.payment_reference})` : '',
    },
    link: `/finance/reimbursements/history?open=${before.id}`,
  }).catch(() => {});

  await audit(req, {
    entity: 'reimbursement', entityId: before.id, action: 'update',
    after: { status: 'paid', paid_minor: amount, method: body.payment_method },
  });
  return ok(res, await get(`${SELECT_BASE} WHERE r.id = ?`, [before.id]));
});

export { router as reimbursementsRouter };
