import { forEachSeq } from '../lib/util.js';
import { sendStoredFile } from '../services/storage.js';
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso, todayIso, addDays, toCsv, financialYear } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit, paginate, pageMeta, sortClause } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { idempotency } from '../middleware/common.js';
import { createInvoice, recalcInvoice, applyPayment, exportInvoicesForAccounting } from '../services/invoicing.js';
import { allocateNumber, peekNumber, numberingAudit } from '../services/numbering.js';
import { STATE_CODES, SAC_CODES, isValidGstin } from '../services/gst.js';
import { renderInvoicePdf } from '../services/pdf.js';
import { upsertDeadline, resolveDeadline } from '../services/deadlines.js';
import { notifyMany, notifyRole } from '../services/notifications.js';
import { emitWebhook } from '../services/webhooks.js';
import { scoreClient } from '../services/scoring.js';
import { config } from '../config.js';

const router = Router();

const lineSchema = z.object({
  description: z.string().min(1).max(240),
  hsn_sac: z.string().optional().nullable(),
  qty: z.number().min(0).optional(),
  unit: z.string().optional(),
  rate_minor: z.number().int().min(0),
  discount_pct: z.number().min(0).max(100).optional(),
  gst_rate: z.number().min(0).max(28).optional(),
  service_line_id: z.string().optional().nullable(),
});

const invoiceSchema = z.object({
  client_id: z.string(),
  project_id: z.string().optional().nullable(),
  issue_date: z.string().optional(),
  due_date: z.string().optional().nullable(),
  payment_terms_days: z.number().int().min(0).max(180).optional(),
  items: z.array(lineSchema).min(1),
  notes: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
  place_of_supply: z.string().optional().nullable(),
  is_export: z.boolean().optional(),
  currency: z.string().optional(),
});

const SELECT = `
  SELECT i.*, c.name AS client_name, c.gstin AS client_gstin, p.name AS project_name,
         u.name AS created_by_name
    FROM invoices i
    JOIN clients c ON c.id = i.client_id
    LEFT JOIN projects p ON p.id = i.project_id
    LEFT JOIN users u ON u.id = i.created_by`;

const SORTS = {
  issue_date: 'i.issue_date', due_date: 'i.due_date', number: 'i.seq',
  total: 'i.total_minor', balance: 'i.balance_minor', status: 'i.status',
};

// ------------------------------------------------------------------ lookups
router.get('/meta', requires('invoices', 'view'), async (req, res) => ok(res, {
  state_codes: Object.entries(STATE_CODES).map(([code, name]) => ({ code, name })),
  sac_codes: SAC_CODES,
  gst_rates: [0, 5, 12, 18, 28],
  next_number: await peekNumber({ tenantId: req.auth.tenantId, tenant: req.tenant }),
  numbering_audit: await numberingAudit(req.auth.tenantId),
  financial_year: financialYear(new Date(), req.tenant?.fy_start_month || 4),
}));

// -------------------------------------------------------------------- list
router.get('/', requires('invoices', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['i.tenant_id = ?', 'i.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  const q = req.query;

  if (q.status) { const s = String(q.status).split(','); filters.push(`i.status IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (q.client_id) { filters.push('i.client_id = ?'); params.push(q.client_id); }
  if (q.project_id) { filters.push('i.project_id = ?'); params.push(q.project_id); }
  if (q.fy) { filters.push('i.fy = ?'); params.push(q.fy); }
  if (q.from) { filters.push('i.issue_date >= ?'); params.push(q.from); }
  if (q.to) { filters.push('i.issue_date <= ?'); params.push(q.to); }
  if (q.overdue === 'true') { filters.push("i.balance_minor > 0 AND i.due_date < ? AND i.status NOT IN ('draft','written_off')"); params.push(todayIso()); }
  if (q.unpaid === 'true') filters.push("i.balance_minor > 0 AND i.status NOT IN ('draft','written_off')");
  if (q.search) { filters.push('(i.number LIKE ? OR c.name LIKE ?)'); const t = `%${q.search}%`; params.push(t, t); }

  const where = filters.join(' AND ');
  const order = sortClause(req, SORTS, 'i.issue_date DESC, i.seq DESC');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM invoices i JOIN clients c ON c.id = i.client_id WHERE ${where}`, params))?.n || 0);
  const rows = await all(`${SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]);

  return ok(res, rows, {
    ...pageMeta(page, limit, total),
    summary: await get(
      `SELECT COALESCE(SUM(i.total_minor),0) AS total_minor,
              COALESCE(SUM(i.paid_minor),0) AS paid_minor,
              COALESCE(SUM(i.balance_minor),0) AS balance_minor,
              COALESCE(SUM(CASE WHEN i.due_date < ? AND i.balance_minor > 0
                                 AND i.status NOT IN ('draft','written_off')
                            THEN i.balance_minor ELSE 0 END),0) AS overdue_minor,
              COUNT(CASE WHEN i.status = 'draft' THEN 1 END) AS drafts
         FROM invoices i JOIN clients c ON c.id = i.client_id WHERE ${where}`,
      [todayIso(), ...params],
    ),
  });
});

router.get('/export', requires('invoices', 'export'), async (req, res) => {
  // F6 - CSV shaped for Tally / Zoho Books import.
  const rows = await exportInvoicesForAccounting(req.auth.tenantId, {
    from: req.query.from || `${new Date().getUTCFullYear()}-01-01`,
    to: req.query.to || todayIso(),
  });
  await audit(req, { entity: 'invoice', action: 'export', after: { count: rows.length } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="invoices-accounting.csv"');
  return res.send(toCsv(rows));
});

router.get('/:id', requires('invoices', 'view'), async (req, res) => {
  const inv = await get(`${SELECT} WHERE i.id = ? AND i.tenant_id = ? AND i.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!inv) throw notFound('Invoice');

  return ok(res, {
    ...inv,
    items: await all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort', [inv.id]),
    payments: await all(
      `SELECT p.*, u.name AS recorded_by_name FROM payments p LEFT JOIN users u ON u.id = p.recorded_by
        WHERE p.invoice_id = ? AND p.deleted_at IS NULL ORDER BY p.paid_at DESC`,
      [inv.id],
    ),
    credit_notes: await all('SELECT * FROM credit_notes WHERE invoice_id = ? ORDER BY issued_at DESC', [inv.id]),
  });
});

// ------------------------------------------------------------------ create
router.post('/', requires('invoices', 'create'), idempotency, async (req, res) => {
  const body = validate(invoiceSchema, req.body);
  const { tenantId, userId } = req.auth;

  // The number allocation and the row insert must commit together (F1).
  const invoice = await tx(async () => await createInvoice(tenantId, {
    clientId: body.client_id,
    projectId: body.project_id ?? null,
    issueDate: body.issue_date || todayIso(),
    dueDate: body.due_date ?? null,
    paymentTermsDays: body.payment_terms_days ?? 15,
    items: body.items,
    notes: body.notes ?? null,
    terms: body.terms ?? null,
    placeOfSupply: body.place_of_supply ?? null,
    isExport: body.is_export ?? false,
    currency: body.currency ?? null,
    createdBy: userId,
  }));

  await audit(req, { entity: 'invoice', entityId: invoice.id, action: 'create', after: { number: invoice.number, total: invoice.total_minor } });
  return created(res, await get(`${SELECT} WHERE i.id = ?`, [invoice.id]));
});

// ------------------------------------------------------------------ update
router.patch('/:id', requires('invoices', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const r = repo('invoices', tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Invoice');
  if (before.status !== 'draft' && req.body.items) {
    throw badRequest('Line items can only be changed while the invoice is a draft. Issue a credit note instead.');
  }

  const body = validate(invoiceSchema.partial().omit({ client_id: true }), req.body);
  const patch = {
    ...(body.issue_date && { issue_date: body.issue_date }),
    ...(body.due_date && { due_date: body.due_date }),
    ...(body.notes !== undefined && { notes: body.notes }),
    ...(body.terms !== undefined && { terms: body.terms }),
    ...(body.project_id !== undefined && { project_id: body.project_id }),
    ...(body.place_of_supply && { place_of_supply: body.place_of_supply, supply_state_code: body.place_of_supply }),
    updated_at: nowIso(),
  };

  await tx(async () => {
    await r.update(req.params.id, patch);
    if (body.items) {
      await run('DELETE FROM invoice_items WHERE invoice_id = ?', [req.params.id]);
      await forEachSeq(body.items, async (it, i) => {
        await run(
          `INSERT INTO invoice_items (id, tenant_id, invoice_id, description, hsn_sac, qty, unit,
             rate_minor, discount_pct, gst_rate, service_line_id, sort)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [uuid(), tenantId, req.params.id, it.description, it.hsn_sac ?? null, it.qty ?? 1,
            it.unit || 'nos', it.rate_minor, it.discount_pct ?? 0, it.gst_rate ?? 18,
            it.service_line_id ?? null, i],
        );
      });
    }
  });

  const after = await recalcInvoice(tenantId, req.params.id);
  await audit(req, { entity: 'invoice', entityId: after.id, action: 'update', before, after });
  return ok(res, await get(`${SELECT} WHERE i.id = ?`, [after.id]));
});

router.delete('/:id', requires('invoices', 'delete'), async (req, res) => {
  const r = repo('invoices', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Invoice');
  // A number that has left draft is never reused - void it with a credit note.
  if (before.status !== 'draft') throw badRequest('Only draft invoices can be deleted. Use a credit note or write-off.');

  await r.softDelete(req.params.id, nowIso());
  await audit(req, { entity: 'invoice', entityId: req.params.id, action: 'delete', before });
  return ok(res, { ok: true });
});

// ----------------------------------------------------------------- approve
router.post('/:id/approve', requires('invoices', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const inv = await get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'draft') throw badRequest('Only a draft invoice needs approval');

  const client = await get('SELECT gstin, country FROM clients WHERE id = ?', [inv.client_id]);
  const warnings = [];
  if (client?.gstin && !isValidGstin(client.gstin)) warnings.push('The client GSTIN does not look valid');
  if (!inv.is_export && !inv.supply_state_code) warnings.push('Place of supply is not set');
  const missingSac = await all('SELECT id FROM invoice_items WHERE invoice_id = ? AND (hsn_sac IS NULL OR hsn_sac = "")', [inv.id]);
  if (missingSac.length) warnings.push(`${missingSac.length} line item(s) have no HSN/SAC code`);

  await run('UPDATE invoices SET approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?',
    [userId, nowIso(), nowIso(), inv.id]);
  await audit(req, { entity: 'invoice', entityId: inv.id, action: 'approve' });

  return ok(res, { ...await get(`${SELECT} WHERE i.id = ?`, [inv.id]), warnings });
});

// -------------------------------------------------------------------- send
router.post('/:id/send', requires('invoices', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const inv = await get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!inv) throw notFound('Invoice');
  if (!['draft', 'sent', 'overdue'].includes(inv.status)) throw badRequest(`An invoice that is ${inv.status} cannot be re-sent`);

  const tenant = await get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  const client = await get('SELECT * FROM clients WHERE id = ?', [inv.client_id]);
  const items = await all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort', [inv.id]);

  let pdfPath = inv.pdf_path;
  try {
    pdfPath = await renderInvoicePdf({ tenant, invoice: inv, items, client });
  } catch (err) {
    console.error('[invoice] pdf failed', err.message);
  }

  await run(
    `UPDATE invoices SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END,
       sent_at = COALESCE(sent_at, ?), pdf_path = ?, updated_at = ? WHERE id = ?`,
    [nowIso(), pdfPath, nowIso(), inv.id],
  );

  // F2 - the due date joins the central deadline engine and its reminder ladder.
  await upsertDeadline({
    tenantId,
    sourceType: 'invoice',
    sourceId: inv.id,
    title: `Invoice ${inv.number} - ${client.name}`,
    dueAt: inv.due_date,
    ownerId: inv.created_by,
    escalationDays: 5,
    severity: 'high',
    meta: { number: inv.number, client: client.name, amount_minor: inv.total_minor, balance_minor: inv.balance_minor },
  });

  await run(
    `INSERT INTO activities (id, tenant_id, client_id, type, subject, body, occurred_at, user_id, meta, created_at)
     VALUES (?,?,?, 'invoice', ?, ?, ?, ?, ?, ?)`,
    [uuid(), tenantId, inv.client_id, `Invoice ${inv.number} sent`, `Due ${inv.due_date}`,
      nowIso(), req.auth.userId, JSON.stringify({ invoice_id: inv.id, total_minor: inv.total_minor }), nowIso()],
  );

  await notifyRole({
    tenantId, roles: ['finance'], eventKey: 'invoice.sent',
    vars: {
      number: inv.number, client: client.name, due_date: inv.due_date,
      amount: new Intl.NumberFormat('en-IN', { style: 'currency', currency: inv.currency }).format(inv.total_minor / 100),
    },
    link: `/invoices/${inv.id}`,
  }).catch(() => {});

  await emitWebhook(tenantId, 'invoice.sent', {
    invoice_id: inv.id, number: inv.number, client_id: inv.client_id, total_minor: inv.total_minor,
  });
  await audit(req, { entity: 'invoice', entityId: inv.id, action: 'update', after: { status: 'sent' } });

  return ok(res, { ...await get(`${SELECT} WHERE i.id = ?`, [inv.id]), pdf_path: pdfPath });
});

// --------------------------------------------------------------------- PDF
router.get('/:id/pdf', requires('invoices', 'view'), async (req, res, next) => {
  try {
    const { tenantId } = req.auth;
    const inv = await get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [req.params.id, tenantId]);
    if (!inv) throw notFound('Invoice');

    const tenant = await get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
    const client = await get('SELECT * FROM clients WHERE id = ?', [inv.client_id]);
    const items = await all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort', [inv.id]);
    const payments = await all('SELECT * FROM payments WHERE invoice_id = ? AND deleted_at IS NULL ORDER BY paid_at', [inv.id]);

    const rel = await renderInvoicePdf({ tenant, invoice: inv, items, client, payments });
    await run('UPDATE invoices SET pdf_path = ? WHERE id = ?', [rel, inv.id]);

    if (!(await sendStoredFile(res, rel, { filename: `${inv.number.replace(/[^\w-]/g, '_')}.pdf` }))) throw notFound('PDF');
  } catch (err) { next(err); }
});

// ---------------------------------------------------------------- payments
router.post('/:id/payments', requires('invoices', 'edit'), idempotency, async (req, res) => {
  const body = validate(z.object({
    amount_minor: z.number().int().positive(),
    paid_at: z.string().optional(),
    method: z.enum(['upi', 'neft', 'imps', 'cheque', 'card', 'cash', 'razorpay', 'stripe', 'other']).optional(),
    reference: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
  }), req.body);
  const { tenantId, userId } = req.auth;

  const invoice = await tx(async () => await applyPayment(tenantId, req.params.id, {
    amountMinor: body.amount_minor,
    paidAt: body.paid_at || nowIso(),
    method: body.method || 'neft',
    reference: body.reference ?? null,
    notes: body.notes ?? null,
    userId,
  }));

  if (invoice.status === 'paid') {
    await resolveDeadline(tenantId, 'invoice', invoice.id, 'met');
    await emitWebhook(tenantId, 'invoice.paid', {
      invoice_id: invoice.id, number: invoice.number, client_id: invoice.client_id,
      total_minor: invoice.total_minor, paid_at: invoice.paid_at,
    });
  }

  const client = await get('SELECT name FROM clients WHERE id = ?', [invoice.client_id]);
  await run(
    `INSERT INTO activities (id, tenant_id, client_id, type, subject, body, outcome, occurred_at, user_id, meta, created_at)
     VALUES (?,?,?, 'invoice', ?, ?, 'positive', ?, ?, ?, ?)`,
    [uuid(), tenantId, invoice.client_id, `Payment received - ${invoice.number}`,
      `${body.amount_minor / 100} via ${body.method || 'neft'}`, body.paid_at || nowIso(), userId,
      JSON.stringify({ invoice_id: invoice.id, amount_minor: body.amount_minor }), nowIso()],
  );

  await notifyRole({
    tenantId, roles: ['finance', 'owner'], eventKey: 'invoice.paid',
    vars: {
      number: invoice.number, client: client?.name,
      amount: new Intl.NumberFormat('en-IN', { style: 'currency', currency: invoice.currency }).format(body.amount_minor / 100),
    },
    link: `/invoices/${invoice.id}`,
  }).catch(() => {});

  await scoreClient(tenantId, invoice.client_id);
  await audit(req, { entity: 'invoice', entityId: invoice.id, action: 'update', after: { payment: body.amount_minor } });

  return created(res, await get(`${SELECT} WHERE i.id = ?`, [invoice.id]));
});

router.delete('/:id/payments/:paymentId', requires('invoices', 'delete'), async (req, res) => {
  const { tenantId } = req.auth;
  const payment = await get('SELECT * FROM payments WHERE id = ? AND invoice_id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.paymentId, req.params.id, tenantId]);
  if (!payment) throw notFound('Payment');

  await tx(async () => {
    await run('UPDATE payments SET deleted_at = ? WHERE id = ?', [nowIso(), payment.id]);
    await recalcInvoice(tenantId, req.params.id);
    const inv = await get('SELECT * FROM invoices WHERE id = ?', [req.params.id]);
    const status = inv.paid_minor <= 0
      ? (inv.due_date < todayIso() ? 'overdue' : 'sent')
      : (inv.balance_minor > 0 ? 'partially_paid' : 'paid');
    await run('UPDATE invoices SET status = ?, paid_at = ?, updated_at = ? WHERE id = ?',
      [status, status === 'paid' ? inv.paid_at : null, nowIso(), inv.id]);
  });

  await audit(req, { entity: 'invoice', entityId: req.params.id, action: 'delete', before: payment });
  return ok(res, await get(`${SELECT} WHERE i.id = ?`, [req.params.id]));
});

// ------------------------------------------------------------- write-off
router.post('/:id/write-off', requires('invoices', 'approve'), async (req, res) => {
  const { reason } = validate(z.object({ reason: z.string().min(3) }), req.body);
  const { tenantId } = req.auth;
  const inv = await get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'paid') throw badRequest('A fully paid invoice cannot be written off');

  await run(`UPDATE invoices SET status = 'written_off', written_off_at = ?, written_off_reason = ?, updated_at = ? WHERE id = ?`,
    [nowIso(), reason, nowIso(), inv.id]);
  await resolveDeadline(tenantId, 'invoice', inv.id, 'cancelled');
  await audit(req, { entity: 'invoice', entityId: inv.id, action: 'approve', after: { written_off: reason } });

  return ok(res, await get(`${SELECT} WHERE i.id = ?`, [inv.id]));
});

// ----------------------------------------------------------- credit notes
router.post('/:id/credit-notes', requires('invoices', 'create'), async (req, res) => {
  const body = validate(z.object({
    reason: z.string().min(3),
    amount_minor: z.number().int().positive(),
    tax_minor: z.number().int().min(0).optional(),
  }), req.body);
  const { tenantId, userId } = req.auth;

  const inv = await get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!inv) throw notFound('Invoice');
  if (body.amount_minor > inv.total_minor) throw badRequest('A credit note cannot exceed the invoice total');

  const note = await tx(async () => {
    const { number, seq, fy } = await allocateNumber({
      tenantId, docType: 'credit_note', tenant: { ...req.tenant, invoice_prefix: 'CN', invoice_scheme: '{prefix}/{fy}/{seq:4}' },
    });
    const id = uuid();
    await run(
      `INSERT INTO credit_notes (id, tenant_id, invoice_id, client_id, number, seq, fy, reason,
         amount_minor, tax_minor, total_minor, issued_at, created_by, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, inv.id, inv.client_id, number, seq, fy, body.reason, body.amount_minor,
        body.tax_minor || 0, body.amount_minor + (body.tax_minor || 0), nowIso(), userId, nowIso()],
    );
    return await get('SELECT * FROM credit_notes WHERE id = ?', [id]);
  });

  await audit(req, { entity: 'credit_note', entityId: note.id, action: 'create', after: note });
  return created(res, note);
});

// ------------------------------------------------- F3 recurring invoices
const recurringSchema = z.object({
  client_id: z.string(),
  project_id: z.string().optional().nullable(),
  title: z.string().min(2),
  frequency: z.enum(['monthly', 'quarterly', 'yearly']).optional(),
  day_of_month: z.number().int().min(1).max(28).optional(),
  next_run_date: z.string(),
  payment_terms_days: z.number().int().min(0).max(180).optional(),
  items: z.array(lineSchema).min(1),
  notes: z.string().optional().nullable(),
  terms: z.string().optional().nullable(),
});

router.get('/recurring/all', requires('invoices', 'view'), async (req, res) => ok(res, (await all(
  `SELECT r.*, c.name AS client_name FROM recurring_invoices r JOIN clients c ON c.id = r.client_id
    WHERE r.tenant_id = ? AND r.deleted_at IS NULL ORDER BY r.next_run_date`,
  [req.auth.tenantId],
)).map((r) => ({ ...r, template: JSON.parse(r.template || '{}') }))));

router.post('/recurring', requires('invoices', 'create'), async (req, res) => {
  const body = validate(recurringSchema, req.body);
  const { tenantId } = req.auth;
  if (!await get('SELECT id FROM clients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [body.client_id, tenantId])) {
    throw notFound('Client');
  }
  const id = uuid();
  await run(
    `INSERT INTO recurring_invoices (id, tenant_id, client_id, project_id, title, frequency,
       day_of_month, next_run_date, payment_terms_days, template, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, body.client_id, body.project_id ?? null, body.title, body.frequency || 'monthly',
      body.day_of_month || 1, body.next_run_date, body.payment_terms_days ?? 15,
      JSON.stringify({ items: body.items, notes: body.notes, terms: body.terms }), nowIso(), nowIso()],
  );
  await audit(req, { entity: 'recurring_invoice', entityId: id, action: 'create', after: { title: body.title } });
  return created(res, await get('SELECT * FROM recurring_invoices WHERE id = ?', [id]));
});

router.patch('/recurring/:id', requires('invoices', 'edit'), async (req, res) => {
  const r = repo('recurring_invoices', req.auth.tenantId);
  if (!await r.findById(req.params.id)) throw notFound('Recurring invoice');

  const body = validate(recurringSchema.partial().extend({ active: z.boolean().optional() }), req.body);
  const patch = { updated_at: nowIso() };
  for (const k of ['title', 'frequency', 'day_of_month', 'next_run_date', 'payment_terms_days', 'project_id']) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (body.active !== undefined) patch.active = body.active ? 1 : 0;
  if (body.items) patch.template = JSON.stringify({ items: body.items, notes: body.notes, terms: body.terms });

  return ok(res, await r.update(req.params.id, patch));
});

router.delete('/recurring/:id', requires('invoices', 'delete'), async (req, res) => {
  await repo('recurring_invoices', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

export { router as invoicesRouter };
