/**
 * F1 - Indian GST computation.
 *
 * Rules applied:
 *  - Supplier state == place-of-supply state  -> CGST + SGST, each rate/2.
 *  - Different state                          -> IGST at the full rate.
 *  - Export / SEZ (is_export)                 -> zero-rated, no GST columns.
 *  - Every amount is an integer in minor units; rounding happens once per line
 *    so line totals always add up to the invoice total.
 */

const r = (n) => Math.round(n);

export function computeLine(line, { isInterstate, isExport }) {
  const qty = Number(line.qty ?? 1);
  const rate = Number(line.rate_minor ?? 0);
  const discountPct = Number(line.discount_pct ?? 0);
  const gstRate = isExport ? 0 : Number(line.gst_rate ?? 18);

  const gross = r(qty * rate);
  const discount = r((gross * discountPct) / 100);
  const taxable = gross - discount;

  let cgst = 0;
  let sgst = 0;
  let igst = 0;
  if (gstRate > 0) {
    if (isInterstate) {
      igst = r((taxable * gstRate) / 100);
    } else {
      const half = (taxable * gstRate) / 200;
      cgst = r(half);
      sgst = r((taxable * gstRate) / 100) - cgst; // keeps CGST+SGST exactly equal to the full rate
    }
  }

  return {
    ...line,
    qty,
    rate_minor: rate,
    discount_pct: discountPct,
    gst_rate: gstRate,
    taxable_minor: taxable,
    cgst_minor: cgst,
    sgst_minor: sgst,
    igst_minor: igst,
    amount_minor: taxable + cgst + sgst + igst,
    _gross_minor: gross,
    _discount_minor: discount,
  };
}

/**
 * Totals an invoice from its lines, including the rupee round-off line that
 * Indian invoices carry.
 */
export function computeInvoiceTotals(lines, { supplierStateCode, placeOfSupplyStateCode, isExport = false }) {
  const isInterstate = !isExport
    && !!placeOfSupplyStateCode
    && String(placeOfSupplyStateCode) !== String(supplierStateCode);

  const computed = lines.map((l) => computeLine(l, { isInterstate, isExport }));

  const subtotal = computed.reduce((a, l) => a + l._gross_minor, 0);
  const discount = computed.reduce((a, l) => a + l._discount_minor, 0);
  const taxable = computed.reduce((a, l) => a + l.taxable_minor, 0);
  const cgst = computed.reduce((a, l) => a + l.cgst_minor, 0);
  const sgst = computed.reduce((a, l) => a + l.sgst_minor, 0);
  const igst = computed.reduce((a, l) => a + l.igst_minor, 0);

  const beforeRounding = taxable + cgst + sgst + igst;
  const total = Math.round(beforeRounding / 100) * 100;   // round to the nearest whole rupee
  const roundOff = total - beforeRounding;

  return {
    is_interstate: isInterstate ? 1 : 0,
    is_export: isExport ? 1 : 0,
    subtotal_minor: subtotal,
    discount_minor: discount,
    taxable_minor: taxable,
    cgst_minor: cgst,
    sgst_minor: sgst,
    igst_minor: igst,
    round_off_minor: roundOff,
    total_minor: total,
    lines: computed.map(({ _gross_minor, _discount_minor, ...l }) => l),
  };
}

/** GST state codes used for place-of-supply selection. */
export const STATE_CODES = {
  '01': 'Jammu & Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh',
  '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh',
  10: 'Bihar', 11: 'Sikkim', 12: 'Arunachal Pradesh', 13: 'Nagaland', 14: 'Manipur',
  15: 'Mizoram', 16: 'Tripura', 17: 'Meghalaya', 18: 'Assam', 19: 'West Bengal',
  20: 'Jharkhand', 21: 'Odisha', 22: 'Chhattisgarh', 23: 'Madhya Pradesh', 24: 'Gujarat',
  26: 'Dadra & Nagar Haveli and Daman & Diu', 27: 'Maharashtra', 29: 'Karnataka',
  30: 'Goa', 31: 'Lakshadweep', 32: 'Kerala', 33: 'Tamil Nadu', 34: 'Puducherry',
  35: 'Andaman & Nicobar Islands', 36: 'Telangana', 37: 'Andhra Pradesh', 38: 'Ladakh',
  97: 'Other Territory', 99: 'Other Country',
};

/** Common SAC codes for agency service lines (F1 HSN/SAC). */
export const SAC_CODES = [
  { code: '998311', label: 'Management consulting services' },
  { code: '998361', label: 'Advertising services' },
  { code: '998365', label: 'Sale of internet advertising space' },
  { code: '998371', label: 'Market research services' },
  { code: '998313', label: 'IT consulting and support services' },
  { code: '998314', label: 'IT design and development services' },
  { code: '998391', label: 'Specialty design services (branding)' },
  { code: '999293', label: 'Commercial training and coaching' },
];

/** Structural GSTIN check: 2-digit state + 10-char PAN + entity + Z + checksum. */
export function isValidGstin(gstin) {
  if (!gstin) return false;
  return /^[0-3][0-9][A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(gstin).toUpperCase());
}
