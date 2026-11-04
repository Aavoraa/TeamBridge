import test from 'node:test';
import assert from 'node:assert/strict';
import { computeLine, computeInvoiceTotals, isValidGstin } from '../src/services/gst.js';

const line = (over = {}) => ({ description: 'Retainer', qty: 1, rate_minor: 10_000_00, gst_rate: 18, ...over });

test('intrastate supply splits GST evenly into CGST and SGST', () => {
  const t = computeInvoiceTotals([line()], { supplierStateCode: '33', placeOfSupplyStateCode: '33' });

  assert.equal(t.is_interstate, 0);
  assert.equal(t.igst_minor, 0);
  assert.equal(t.cgst_minor, 90_000);          // 9% of 10,000.00
  assert.equal(t.sgst_minor, 90_000);
  assert.equal(t.cgst_minor + t.sgst_minor, 180_000, 'halves must add back to the full 18%');
  assert.equal(t.total_minor, 11_800_00);
});

test('interstate supply charges IGST at the full rate and no CGST/SGST', () => {
  const t = computeInvoiceTotals([line()], { supplierStateCode: '33', placeOfSupplyStateCode: '29' });

  assert.equal(t.is_interstate, 1);
  assert.equal(t.igst_minor, 180_000);
  assert.equal(t.cgst_minor, 0);
  assert.equal(t.sgst_minor, 0);
  assert.equal(t.total_minor, 11_800_00);
});

test('export supply is zero-rated regardless of the line GST rate', () => {
  const t = computeInvoiceTotals([line({ gst_rate: 18 })], {
    supplierStateCode: '33', placeOfSupplyStateCode: '99', isExport: true,
  });

  assert.equal(t.is_export, 1);
  assert.equal(t.is_interstate, 0, 'an export is not an interstate supply');
  assert.equal(t.cgst_minor + t.sgst_minor + t.igst_minor, 0);
  assert.equal(t.total_minor, 10_000_00);
});

test('an odd tax amount still splits so CGST + SGST equals the full rate', () => {
  // 333.33 at 18% = 59.9994 -> the halves must not both round down and lose a paisa.
  const t = computeInvoiceTotals([line({ rate_minor: 33_333 })], {
    supplierStateCode: '33', placeOfSupplyStateCode: '33',
  });

  const fullRate = Math.round((t.taxable_minor * 18) / 100);
  assert.equal(t.cgst_minor + t.sgst_minor, fullRate);
});

test('line discounts reduce the taxable value before tax is applied', () => {
  const t = computeInvoiceTotals([line({ discount_pct: 10 })], {
    supplierStateCode: '33', placeOfSupplyStateCode: '33',
  });

  assert.equal(t.subtotal_minor, 10_000_00);
  assert.equal(t.discount_minor, 1_000_00);
  assert.equal(t.taxable_minor, 9_000_00);
  assert.equal(t.cgst_minor + t.sgst_minor, 162_000);   // 18% of 9,000.00
});

test('line amounts always sum back to the invoice total', () => {
  const lines = [
    line({ rate_minor: 12_345_67, gst_rate: 18 }),
    line({ rate_minor: 7_777_00, gst_rate: 12, qty: 3 }),
    line({ rate_minor: 999_99, gst_rate: 5, discount_pct: 7.5 }),
  ];
  const t = computeInvoiceTotals(lines, { supplierStateCode: '33', placeOfSupplyStateCode: '33' });

  const lineSum = t.lines.reduce((a, l) => a + l.amount_minor, 0);
  assert.equal(lineSum + t.round_off_minor, t.total_minor,
    'the printed line amounts plus round-off must reconcile to the total');
});

test('the invoice total is rounded to a whole rupee and the difference recorded', () => {
  const t = computeInvoiceTotals([line({ rate_minor: 1_234_56 })], {
    supplierStateCode: '33', placeOfSupplyStateCode: '33',
  });

  assert.equal(t.total_minor % 100, 0, 'totals are whole rupees');
  const beforeRounding = t.taxable_minor + t.cgst_minor + t.sgst_minor + t.igst_minor;
  assert.equal(beforeRounding + t.round_off_minor, t.total_minor);
  assert.ok(Math.abs(t.round_off_minor) < 100, 'round-off never exceeds a rupee');
});

test('a zero-rate line produces no tax but still contributes to the total', () => {
  const t = computeInvoiceTotals([line({ gst_rate: 0 })], {
    supplierStateCode: '33', placeOfSupplyStateCode: '33',
  });
  assert.equal(t.cgst_minor + t.sgst_minor + t.igst_minor, 0);
  assert.equal(t.total_minor, 10_000_00);
});

test('quantity multiplies the rate before discount and tax', () => {
  const l = computeLine(line({ qty: 2.5, rate_minor: 1_000_00, discount_pct: 20 }),
    { isInterstate: false, isExport: false });

  assert.equal(l.taxable_minor, 2_000_00);      // 2.5 x 1000 = 2500, less 20%
  assert.equal(l.cgst_minor + l.sgst_minor, 36_000);
});

test('GSTIN validation accepts a well-formed number and rejects malformed ones', () => {
  assert.equal(isValidGstin('33AAKCP1234R1Z5'), true);
  assert.equal(isValidGstin('33aakcp1234r1z5'), true, 'case is normalised');
  assert.equal(isValidGstin('33AAKCP1234R1X5'), false, 'the 14th character must be Z');
  assert.equal(isValidGstin('3AAKCP1234R1Z5'), false, 'too short');
  assert.equal(isValidGstin(''), false);
  assert.equal(isValidGstin(null), false);
});
