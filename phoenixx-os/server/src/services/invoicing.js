import { forEachSeq } from '../lib/util.js';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso, todayIso, addDays, parseJson } from '../lib/util.js';
import { allocateNumber } from './numbering.js';
import { computeInvoiceTotals } from './gst.js';
import { notFound, badRequest } from '../lib/http.js';

/**
 * Module F - invoice creation shared by the API and the recurring-invoice job,
 * so both paths use one numbering allocation and one GST computation.
 *
 * Callers must wrap this in a transaction: the number allocation and the row
 * insert have to commit together for the "zero numbering errors" guarantee.
 */

export async function createInvoice(tenantId, {
  clientId, projectId = null, issueDate = todayIso(), dueDate = null, paymentTermsDays = 15,
  items = [], notes = null, terms = null, placeOfSupply = null, isExport = false,
  currency = null, recurringId = null, createdBy = null, status = 'draft',
}) {
  const tenant = await get('SELECT * FROM tenants WHERE id = ? AND deleted_at IS NULL', [tenantId]);
  if (!tenant) throw notFound('Tenant');

  const client = await get('SELECT * FROM clients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [clientId, tenantId]);
  if (!client) throw notFound('Client');
  if (!items.length) throw badRequest('An invoice needs at least one line item');

  const supplyStateCode = placeOfSupply || client.state_code || tenant.state_code;
  const totals = computeInvoiceTotals(items, {
    supplierStateCode: tenant.state_code,
    placeOfSupplyStateCode: supplyStateCode,
    isExport: isExport || (client.country && client.country !== 'India'),
  });

  const { number, seq, fy } = await allocateNumber({ tenantId, docType: 'invoice', date: issueDate, tenant });
  const due = dueDate || addDays(issueDate, paymentTermsDays).toISOString().slice(0, 10);
  const id = uuid();

  await run(
    `INSERT INTO invoices (id, tenant_id, client_id, project_id, number, seq, fy, status, issue_date,
       due_date, currency, place_of_supply, supply_state_code, is_interstate, is_export,
       subtotal_minor, discount_minor, taxable_minor, cgst_minor, sgst_minor, igst_minor,
       round_off_minor, total_minor, paid_minor, balance_minor, notes, terms, recurring_id,
       created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`,
    [id, tenantId, clientId, projectId, number, seq, fy, status, issueDate, due,
      currency || client.currency || tenant.currency, supplyStateCode, supplyStateCode,
      totals.is_interstate, totals.is_export, totals.subtotal_minor, totals.discount_minor,
      totals.taxable_minor, totals.cgst_minor, totals.sgst_minor, totals.igst_minor,
      totals.round_off_minor, totals.total_minor, totals.total_minor, notes, terms, recurringId,
      createdBy, nowIso(), nowIso()],
  );

  await forEachSeq(totals.lines, async (line, i) => {
    await run(
      `INSERT INTO invoice_items (id, tenant_id, invoice_id, description, hsn_sac, qty, unit,
         rate_minor, discount_pct, taxable_minor, gst_rate, cgst_minor, sgst_minor, igst_minor,
         amount_minor, service_line_id, sort)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, id, line.description, line.hsn_sac || null, line.qty, line.unit || 'nos',
        line.rate_minor, line.discount_pct, line.taxable_minor, line.gst_rate, line.cgst_minor,
        line.sgst_minor, line.igst_minor, line.amount_minor, line.service_line_id || null, i],
    );
  });

  return await get('SELECT * FROM invoices WHERE id = ?', [id]);
}

/** Recompute totals after line items change on a draft. */
export async function recalcInvoice(tenantId, invoiceId) {
  const invoice = await get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ?', [invoiceId, tenantId]);
  if (!invoice) throw notFound('Invoice');
  const tenant = await get('SELECT * FROM tenants WHERE id = ?', [tenantId]);
  const items = await all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort', [invoiceId]);

  const totals = computeInvoiceTotals(items, {
    supplierStateCode: tenant.state_code,
    placeOfSupplyStateCode: invoice.supply_state_code,
    isExport: !!invoice.is_export,
  });

  for (const line of totals.lines) {
    await run(
      `UPDATE invoice_items SET taxable_minor = ?, cgst_minor = ?, sgst_minor = ?, igst_minor = ?, amount_minor = ?
        WHERE id = ?`,
      [line.taxable_minor, line.cgst_minor, line.sgst_minor, line.igst_minor, line.amount_minor, line.id],
    );
  }

  const paid = Number((await get(
    'SELECT COALESCE(SUM(amount_minor),0) AS v FROM payments WHERE invoice_id = ? AND deleted_at IS NULL',
    [invoiceId],
  ))?.v || 0);

  await run(
    `UPDATE invoices SET subtotal_minor = ?, discount_minor = ?, taxable_minor = ?, cgst_minor = ?,
       sgst_minor = ?, igst_minor = ?, round_off_minor = ?, total_minor = ?, paid_minor = ?,
       balance_minor = ?, is_interstate = ?, updated_at = ? WHERE id = ?`,
    [totals.subtotal_minor, totals.discount_minor, totals.taxable_minor, totals.cgst_minor,
      totals.sgst_minor, totals.igst_minor, totals.round_off_minor, totals.total_minor, paid,
      totals.total_minor - paid, totals.is_interstate, nowIso(), invoiceId],
  );

  return await get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
}

/** F3 - materialise one cycle of a retainer template. */
export async function createInvoiceFromTemplate(tenantId, recurring) {
  const template = parseJson(recurring.template, {}) || {};
  return await createInvoice(tenantId, {
    clientId: recurring.client_id,
    projectId: recurring.project_id,
    issueDate: recurring.next_run_date,
    paymentTermsDays: recurring.payment_terms_days,
    items: template.items || [],
    notes: template.notes || `${recurring.title} - ${recurring.next_run_date.slice(0, 7)}`,
    terms: template.terms || null,
    recurringId: recurring.id,
    status: 'draft',
  });
}

/** Applies a payment and moves the invoice through its lifecycle (F2). */
export async function applyPayment(tenantId, invoiceId, {
  // node:sqlite refuses `undefined` bindings, so every optional field defaults
  // to null here rather than relying on each caller to pass explicit nulls.
  amountMinor, paidAt = null, method = 'neft', reference = null, notes = null, userId = null,
}) {
  const invoice = await get('SELECT * FROM invoices WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [invoiceId, tenantId]);
  if (!invoice) throw notFound('Invoice');
  if (invoice.status === 'draft') throw badRequest('Send the invoice before recording a payment');
  if (amountMinor <= 0) throw badRequest('Payment amount must be positive');
  if (amountMinor > invoice.balance_minor) {
    throw badRequest(`Payment exceeds the outstanding balance of ${invoice.balance_minor / 100}`);
  }

  await run(
    `INSERT INTO payments (id, tenant_id, invoice_id, client_id, amount_minor, paid_at, method,
       reference, notes, recorded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, invoiceId, invoice.client_id, amountMinor, paidAt || nowIso(), method,
      reference, notes, userId, nowIso()],
  );

  const paid = invoice.paid_minor + amountMinor;
  const balance = invoice.total_minor - paid;
  const status = balance <= 0 ? 'paid' : 'partially_paid';

  await run(
    `UPDATE invoices SET paid_minor = ?, balance_minor = ?, status = ?, paid_at = ?, updated_at = ? WHERE id = ?`,
    [paid, balance, status, balance <= 0 ? (paidAt || nowIso()) : null, nowIso(), invoiceId],
  );

  return await get('SELECT * FROM invoices WHERE id = ?', [invoiceId]);
}

/** F4 - roll employee salary bands into the monthly HR cost line (C5 -> F4). */
export async function syncHrCosts(tenantId, month) {
  const staff = await all(
    `SELECT id, name, monthly_cost_minor, service_line_id FROM users
      WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active'
        AND role != 'client' AND monthly_cost_minor > 0`,
    [tenantId],
  );
  let n = 0;
  for (const u of staff) {
    const existing = await get(
      "SELECT id FROM costs WHERE tenant_id = ? AND period_month = ? AND category = 'hr' AND user_id = ? AND deleted_at IS NULL",
      [tenantId, month, u.id],
    );
    if (existing) {
      await run('UPDATE costs SET amount_minor = ?, updated_at = ? WHERE id = ?', [u.monthly_cost_minor, nowIso(), existing.id]);
    } else {
      await run(
        `INSERT INTO costs (id, tenant_id, category, label, amount_minor, period_month, user_id,
           service_line_id, recurring, created_at, updated_at)
         VALUES (?,?, 'hr', ?, ?, ?, ?, ?, 1, ?, ?)`,
        [uuid(), tenantId, `Salary - ${u.name}`, u.monthly_cost_minor, month, u.id,
          u.service_line_id, nowIso(), nowIso()],
      );
    }
    n++;
  }
  return n;
}

/** F6 - Tally / Zoho Books CSV export shape. */
export async function exportInvoicesForAccounting(tenantId, { from, to }) {
  return await all(
    `SELECT i.number AS "Invoice Number", i.issue_date AS "Invoice Date", i.due_date AS "Due Date",
            c.name AS "Customer Name", c.gstin AS "GST Identification Number (GSTIN)",
            i.place_of_supply AS "Place of Supply", i.currency AS "Currency",
            i.taxable_minor / 100.0 AS "Taxable Value", i.cgst_minor / 100.0 AS "CGST",
            i.sgst_minor / 100.0 AS "SGST", i.igst_minor / 100.0 AS "IGST",
            i.total_minor / 100.0 AS "Invoice Total", i.paid_minor / 100.0 AS "Amount Received",
            i.balance_minor / 100.0 AS "Balance", i.status AS "Status"
       FROM invoices i JOIN clients c ON c.id = i.client_id
      WHERE i.tenant_id = ? AND i.deleted_at IS NULL AND i.status != 'draft'
        AND i.issue_date >= ? AND i.issue_date <= ?
      ORDER BY i.issue_date, i.seq`,
    [tenantId, from, to],
  );
}
