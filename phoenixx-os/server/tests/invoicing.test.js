import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
const {
  createInvoice, recalcInvoice, applyPayment, syncHrCosts, createInvoiceFromTemplate,
  exportInvoicesForAccounting,
} = await import('../src/services/invoicing.js');
const { uuid, nowIso, todayIso, addDays, monthIso } = await import('../src/lib/util.js');

await db.migrate();

const TENANT = 'tenant-invoicing';
await db.run(
  `INSERT INTO tenants (id, name, slug, state_code, invoice_prefix, invoice_scheme, fy_start_month,
     currency, created_at, updated_at)
   VALUES (?, 'Invoicing Test', 'invoicing-test', '33', 'INV', '{prefix}/{fy}/{seq:4}', 4, 'INR', ?, ?)`,
  [TENANT, nowIso(), nowIso()],
);

const LOCAL = 'client-local';
const OUTSTATE = 'client-outstate';
const FOREIGN = 'client-foreign';

for (const [id, name, stateCode, country] of [
  [LOCAL, 'Local Client', '33', 'India'],
  [OUTSTATE, 'Karnataka Client', '29', 'India'],
  [FOREIGN, 'Dubai Client', null, 'UAE'],
]) {
  await db.run(
    `INSERT INTO clients (id, tenant_id, name, state_code, country, currency, created_at, updated_at)
     VALUES (?,?,?,?,?, 'INR', ?, ?)`,
    [id, TENANT, name, stateCode, country, nowIso(), nowIso()],
  );
}

const line = (over = {}) => ({ description: 'Retainer', qty: 1, rate_minor: 10_000_00, gst_rate: 18, hsn_sac: '998361', ...over });

describe('creating invoices', () => {
  test('an in-state client is charged CGST and SGST', async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, { clientId: LOCAL, items: [line()] }));

    assert.equal(inv.is_interstate, 0);
    assert.equal(inv.cgst_minor, 90_000);
    assert.equal(inv.sgst_minor, 90_000);
    assert.equal(inv.igst_minor, 0);
    assert.equal(inv.total_minor, 11_800_00);
    assert.equal(inv.balance_minor, inv.total_minor, 'a new invoice is fully outstanding');
    assert.equal(inv.status, 'draft');
  });

  test('an out-of-state client is charged IGST', async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, { clientId: OUTSTATE, items: [line()] }));

    assert.equal(inv.is_interstate, 1);
    assert.equal(inv.igst_minor, 180_000);
    assert.equal(inv.cgst_minor + inv.sgst_minor, 0);
  });

  test('a client outside India is treated as a zero-rated export', async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, { clientId: FOREIGN, items: [line()] }));

    assert.equal(inv.is_export, 1);
    assert.equal(inv.cgst_minor + inv.sgst_minor + inv.igst_minor, 0);
    assert.equal(inv.total_minor, 10_000_00);
  });

  test('the due date follows the payment terms', async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, {
      clientId: LOCAL, items: [line()], issueDate: '2026-08-01', paymentTermsDays: 30,
    }));
    assert.equal(inv.due_date, '2026-08-31');
  });

  test('an explicit due date overrides the payment terms', async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, {
      clientId: LOCAL, items: [line()], issueDate: '2026-08-01', dueDate: '2026-09-15', paymentTermsDays: 15,
    }));
    assert.equal(inv.due_date, '2026-09-15');
  });

  test('line items are stored with their computed tax split', async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, {
      clientId: LOCAL,
      items: [line({ description: 'Design', rate_minor: 5_000_00 }), line({ description: 'Ads', rate_minor: 3_000_00, gst_rate: 12 })],
    }));

    const items = await db.all('SELECT * FROM invoice_items WHERE invoice_id = ? ORDER BY sort', [inv.id]);
    assert.equal(items.length, 2);
    assert.equal(items[0].description, 'Design');
    assert.equal(items[0].hsn_sac, '998361', 'the SAC code is retained for the GST return');
    assert.equal(items[1].gst_rate, 12, 'per-line rates are respected');

    const lineTotal = items.reduce((a, i) => a + i.amount_minor, 0);
    assert.equal(lineTotal + inv.round_off_minor, inv.total_minor);
  });

  test('an invoice with no line items is rejected', async () => {
    await assert.rejects(
      async () => await db.tx(async () => await createInvoice(TENANT, { clientId: LOCAL, items: [] })),
      /at least one line item/i,
    );
  });

  test('an unknown client is rejected', async () => {
    await assert.rejects(
      async () => await db.tx(async () => await createInvoice(TENANT, { clientId: 'does-not-exist', items: [line()] })),
      /not found/i,
    );
  });

  test("a client from another tenant cannot be invoiced", async () => {
    await db.run(`INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('other-inv', 'Other', 'other-inv', ?, ?)`,
      [nowIso(), nowIso()]);
    await db.run(`INSERT INTO clients (id, tenant_id, name, created_at, updated_at) VALUES ('other-client', 'other-inv', 'Theirs', ?, ?)`,
      [nowIso(), nowIso()]);

    await assert.rejects(
      async () => await db.tx(async () => await createInvoice(TENANT, { clientId: 'other-client', items: [line()] })),
      /not found/i,
      'tenant isolation holds at the service layer, not just the API',
    );
  });

  test('each invoice gets the next number in an unbroken sequence', async () => {
    const a = await db.tx(async () => await createInvoice(TENANT, { clientId: LOCAL, items: [line()], issueDate: '2026-08-10' }));
    const b = await db.tx(async () => await createInvoice(TENANT, { clientId: LOCAL, items: [line()], issueDate: '2026-08-10' }));

    assert.equal(b.seq, a.seq + 1);
    assert.notEqual(a.number, b.number);
    assert.match(a.number, /^INV\/2026-27\/\d{4}$/);
  });
});

describe('payments', () => {
  const freshSentInvoice = async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, { clientId: LOCAL, items: [line()], status: 'sent' }));
    return inv;
  };

  test('a full payment settles the invoice', async () => {
    const inv = await freshSentInvoice();
    const after = await db.tx(async () => await applyPayment(TENANT, inv.id, {
      amountMinor: inv.total_minor, method: 'neft', paidAt: nowIso(),
    }));

    assert.equal(after.status, 'paid');
    assert.equal(after.balance_minor, 0);
    assert.equal(after.paid_minor, inv.total_minor);
    assert.ok(after.paid_at, 'the settlement date is recorded');
  });

  test('a part payment leaves the remainder outstanding', async () => {
    const inv = await freshSentInvoice();
    const after = await db.tx(async () => await applyPayment(TENANT, inv.id, { amountMinor: 500_000, method: 'upi' }));

    assert.equal(after.status, 'partially_paid');
    assert.equal(after.balance_minor, inv.total_minor - 500_000);
    assert.equal(after.paid_at, null, 'not settled, so no settlement date');
  });

  test('two part payments together settle the invoice', async () => {
    const inv = await freshSentInvoice();
    await db.tx(async () => await applyPayment(TENANT, inv.id, { amountMinor: 800_000 }));
    const after = await db.tx(async () => await applyPayment(TENANT, inv.id, { amountMinor: inv.total_minor - 800_000 }));

    assert.equal(after.status, 'paid');
    assert.equal(after.balance_minor, 0);

    const payments = await db.all('SELECT * FROM payments WHERE invoice_id = ?', [inv.id]);
    assert.equal(payments.length, 2, 'both payments stay on the record');
  });

  test('a payment larger than the balance is refused', async () => {
    const inv = await freshSentInvoice();
    await assert.rejects(
      async () => await db.tx(async () => await applyPayment(TENANT, inv.id, { amountMinor: inv.total_minor + 1 })),
      /exceeds the outstanding balance/i,
    );

    const unchanged = await db.get('SELECT paid_minor FROM invoices WHERE id = ?', [inv.id]);
    assert.equal(unchanged.paid_minor, 0, 'the rejected payment left nothing behind');
  });

  test('a zero or negative payment is refused', async () => {
    const inv = await freshSentInvoice();
    await assert.rejects(async () => await db.tx(async () => await applyPayment(TENANT, inv.id, { amountMinor: 0 })), /must be positive/i);
    await assert.rejects(async () => await db.tx(async () => await applyPayment(TENANT, inv.id, { amountMinor: -100 })), /must be positive/i);
  });

  test('a draft invoice cannot receive a payment', async () => {
    const draft = await db.tx(async () => await createInvoice(TENANT, { clientId: LOCAL, items: [line()] }));
    await assert.rejects(
      async () => await db.tx(async () => await applyPayment(TENANT, draft.id, { amountMinor: 1000 })),
      /Send the invoice before recording a payment/i,
    );
  });

  test('a payment against another tenant\'s invoice is refused', async () => {
    const inv = await freshSentInvoice();
    await assert.rejects(
      async () => await db.tx(async () => await applyPayment('other-inv', inv.id, { amountMinor: 1000 })),
      /not found/i,
    );
  });
});

describe('recalculation', () => {
  test('recalc keeps totals consistent after line items change', async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, { clientId: LOCAL, items: [line()] }));

    await db.run(
      `INSERT INTO invoice_items (id, tenant_id, invoice_id, description, qty, rate_minor, gst_rate, sort)
       VALUES (?,?,?, 'Extra work', 1, 200000, 18, 1)`,
      [uuid(), TENANT, inv.id],
    );

    const after = await recalcInvoice(TENANT, inv.id);
    assert.equal(after.taxable_minor, 12_000_00);
    assert.equal(after.cgst_minor + after.sgst_minor, 216_000);
    assert.equal(after.balance_minor, after.total_minor, 'nothing was paid, so the balance follows the total');
  });

  test('recalc preserves payments already recorded', async () => {
    const inv = await db.tx(async () => await createInvoice(TENANT, { clientId: LOCAL, items: [line()], status: 'sent' }));
    await db.tx(async () => await applyPayment(TENANT, inv.id, { amountMinor: 400_000 }));

    const after = await recalcInvoice(TENANT, inv.id);
    assert.equal(after.paid_minor, 400_000);
    assert.equal(after.balance_minor, after.total_minor - 400_000);
  });
});

describe('recurring invoices', () => {
  test('a retainer template materialises into a real invoice', async () => {
    const recurring = {
      id: uuid(), tenant_id: TENANT, client_id: LOCAL, project_id: null,
      title: 'Monthly retainer', next_run_date: '2026-09-05', payment_terms_days: 15,
      template: JSON.stringify({
        items: [{ description: 'Monthly retainer', qty: 1, rate_minor: 15_000_00, gst_rate: 18, hsn_sac: '998361' }],
        notes: 'As per agreement',
      }),
    };

    const inv = await db.tx(async () => await createInvoiceFromTemplate(TENANT, recurring));

    assert.equal(inv.issue_date, '2026-09-05');
    assert.equal(inv.due_date, '2026-09-20');
    assert.equal(inv.taxable_minor, 15_000_00);
    assert.equal(inv.recurring_id, recurring.id, 'the invoice points back at its schedule');
    assert.equal(inv.status, 'draft', 'generated invoices wait for review, they are not auto-sent');
  });
});

describe('HR cost sync', () => {
  test('salary bands become the monthly HR cost line', async () => {
    await db.run(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role, monthly_cost_minor, created_at, updated_at)
       VALUES (?,?, 'a@x.com', 'x', 'Employee A', 'employee', 5_000_00, ?, ?)`,
      [uuid(), TENANT, nowIso(), nowIso()],
    );
    await db.run(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, role, monthly_cost_minor, created_at, updated_at)
       VALUES (?,?, 'b@x.com', 'x', 'Employee B', 'employee', 7_000_00, ?, ?)`,
      [uuid(), TENANT, nowIso(), nowIso()],
    );

    const month = monthIso();
    const n = await syncHrCosts(TENANT, month);
    assert.equal(n, 2);

    const total = await db.get(
      "SELECT COALESCE(SUM(amount_minor),0) AS v FROM costs WHERE tenant_id = ? AND period_month = ? AND category = 'hr'",
      [TENANT, month],
    );
    assert.equal(Number(total.v), 12_000_00);
  });

  test('running the sync again updates rather than duplicating', async () => {
    const month = monthIso();
    await syncHrCosts(TENANT, month);
    await syncHrCosts(TENANT, month);

    const rows = await db.all(
      "SELECT * FROM costs WHERE tenant_id = ? AND period_month = ? AND category = 'hr'",
      [TENANT, month],
    );
    assert.equal(rows.length, 2, 'still one cost row per person');
  });
});

describe('accounting export', () => {
  test('the export carries the columns an accountant needs', async () => {
    const rows = await exportInvoicesForAccounting(TENANT, { from: '2020-01-01', to: '2030-12-31' });
    assert.ok(rows.length > 0);

    const first = rows[0];
    for (const column of ['Invoice Number', 'Invoice Date', 'Customer Name', 'Taxable Value',
      'CGST', 'SGST', 'IGST', 'Invoice Total', 'Status']) {
      assert.ok(column in first, `missing column: ${column}`);
    }
    assert.equal(typeof first['Taxable Value'], 'number', 'amounts are exported in rupees, not paise');
  });

  test('drafts are excluded from the accounting export', async () => {
    const rows = await exportInvoicesForAccounting(TENANT, { from: '2020-01-01', to: '2030-12-31' });
    assert.ok(rows.every((r) => r.Status !== 'draft'));
  });
});
