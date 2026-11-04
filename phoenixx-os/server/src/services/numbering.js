import { get, run } from '../db/index.js';
import { nowIso, financialYear } from '../lib/util.js';
import { conflict } from '../lib/http.js';

/**
 * F1 - document numbering.
 *
 * The reference defect this fixes (the "Cotton India" case) is a duplicate /
 * out-of-order invoice number produced by numbering documents by hand. Two
 * guarantees replace that:
 *
 *   1. The sequence is allocated by an atomic UPDATE ... RETURNING against
 *      `invoice_counters`, inside the caller's transaction. Two concurrent
 *      requests cannot read the same last_seq.
 *   2. `invoices.number` carries UNIQUE (tenant_id, number), so even a bug
 *      elsewhere surfaces as a constraint violation rather than a duplicate.
 *
 * The scheme itself is tenant-editable, e.g.
 *   "{prefix}/{fy}/{seq:4}"   -> PHX/2026-27/0007
 *   "{prefix}-{yyyy}{mm}-{seq:3}" -> INV-202608-007
 */

const PLACEHOLDER = /\{(\w+)(?::(\d+))?\}/g;

export function renderNumber(scheme, { prefix, fy, seq, date = new Date() }) {
  const d = new Date(date);
  const values = {
    prefix,
    fy,
    fyshort: fy.replace('-', ''),
    yyyy: String(d.getUTCFullYear()),
    yy: String(d.getUTCFullYear()).slice(-2),
    mm: String(d.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(d.getUTCDate()).padStart(2, '0'),
    seq: String(seq),
  };
  return scheme.replace(PLACEHOLDER, (match, key, pad) => {
    const val = values[key];
    if (val == null) return match;
    return pad ? String(val).padStart(Number(pad), '0') : val;
  });
}

/**
 * Allocate the next sequence for (tenant, docType, fy, prefix).
 * MUST be called inside a transaction together with the INSERT that consumes it.
 */
export async function allocateNumber({ tenantId, docType = 'invoice', date = new Date(), tenant }) {
  const fyStart = tenant?.fy_start_month || 4;
  const fy = financialYear(date, fyStart);
  const prefix = (docType === 'invoice' ? tenant?.invoice_prefix : tenant?.proposal_prefix) || 'INV';
  const scheme = (docType === 'invoice' ? tenant?.invoice_scheme : '{prefix}/{fy}/{seq:4}') || '{prefix}/{fy}/{seq:4}';

  await run(
    `INSERT INTO invoice_counters (tenant_id, doc_type, fy, prefix, last_seq, updated_at)
     VALUES (?,?,?,?,0,?)
     ON CONFLICT (tenant_id, doc_type, fy, prefix) DO NOTHING`,
    [tenantId, docType, fy, prefix, nowIso()],
  );

  const row = await get(
    `UPDATE invoice_counters SET last_seq = last_seq + 1, updated_at = ?
      WHERE tenant_id = ? AND doc_type = ? AND fy = ? AND prefix = ?
      RETURNING last_seq`,
    [nowIso(), tenantId, docType, fy, prefix],
  );
  if (!row) throw conflict('Could not allocate a document number');

  const seq = Number(row.last_seq);
  return { number: renderNumber(scheme, { prefix, fy, seq, date }), seq, fy, prefix };
}

/** Preview the next number without consuming it (settings UI). */
export async function peekNumber({ tenantId, docType = 'invoice', date = new Date(), tenant, scheme }) {
  const fyStart = tenant?.fy_start_month || 4;
  const fy = financialYear(date, fyStart);
  const prefix = (docType === 'invoice' ? tenant?.invoice_prefix : tenant?.proposal_prefix) || 'INV';
  const current = await get(
    'SELECT last_seq FROM invoice_counters WHERE tenant_id = ? AND doc_type = ? AND fy = ? AND prefix = ?',
    [tenantId, docType, fy, prefix],
  );
  const seq = Number(current?.last_seq || 0) + 1;
  const useScheme = scheme || tenant?.invoice_scheme || '{prefix}/{fy}/{seq:4}';
  return { number: renderNumber(useScheme, { prefix, fy, seq, date }), seq, fy, prefix };
}

/**
 * Audit helper backing the "zero numbering errors" success metric: reports
 * duplicates and gaps per financial year.
 */
export async function numberingAudit(tenantId) {
  const rows = await get(
    `SELECT COUNT(*) AS total, COUNT(DISTINCT number) AS distinct_numbers
       FROM invoices WHERE tenant_id = ? AND deleted_at IS NULL`,
    [tenantId],
  ) || { total: 0, distinct_numbers: 0 };

  const perFy = await get(
    `SELECT fy, MIN(seq) AS min_seq, MAX(seq) AS max_seq, COUNT(*) AS n
       FROM invoices WHERE tenant_id = ? AND deleted_at IS NULL GROUP BY fy ORDER BY fy DESC LIMIT 1`,
    [tenantId],
  );

  const duplicates = Number(rows.total) - Number(rows.distinct_numbers);
  const gaps = perFy ? Number(perFy.max_seq) - Number(perFy.min_seq) + 1 - Number(perFy.n) : 0;
  return {
    total_invoices: Number(rows.total),
    duplicate_numbers: duplicates,
    sequence_gaps: Math.max(0, gaps),
    latest_fy: perFy?.fy || null,
    clean: duplicates === 0 && gaps <= 0,
  };
}
