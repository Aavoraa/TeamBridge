import test, { before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
const { renderNumber, allocateNumber, peekNumber, numberingAudit } = await import('../src/services/numbering.js');
const { financialYear, uuid, nowIso } = await import('../src/lib/util.js');

await db.migrate();

const TENANT = {
  id: 'tenant-numbering-test',
  invoice_prefix: 'PHX',
  invoice_scheme: '{prefix}/{fy}/{seq:4}',
  fy_start_month: 4,
};

before(async () => {
  await db.run(
    `INSERT INTO tenants (id, name, slug, invoice_prefix, invoice_scheme, fy_start_month, created_at, updated_at)
     VALUES (?, 'Numbering Test', 'numbering-test', 'PHX', '{prefix}/{fy}/{seq:4}', 4, ?, ?)`,
    [TENANT.id, nowIso(), nowIso()],
  );
});

describe('scheme rendering', () => {
  test('placeholders are substituted and the sequence zero-padded', () => {
    const n = renderNumber('{prefix}/{fy}/{seq:4}', {
      prefix: 'PHX', fy: '2026-27', seq: 7, date: '2026-08-21',
    });
    assert.equal(n, 'PHX/2026-27/0007');
  });

  test('date placeholders resolve against the issue date, not today', () => {
    const n = renderNumber('{prefix}-{yyyy}{mm}{dd}-{seq:3}', {
      prefix: 'INV', fy: '2025-26', seq: 42, date: '2025-11-09',
    });
    assert.equal(n, 'INV-20251109-042');
  });

  test('an unpadded sequence is left as-is', () => {
    assert.equal(renderNumber('{prefix}{seq}', { prefix: 'A', fy: '2026-27', seq: 5 }), 'A5');
  });

  test('an unknown placeholder is left untouched rather than blanked', () => {
    const n = renderNumber('{prefix}/{nope}/{seq:2}', { prefix: 'X', fy: '2026-27', seq: 1 });
    assert.equal(n, 'X/{nope}/01');
  });
});

describe('financial year boundaries', () => {
  test('April starts a new Indian financial year', () => {
    assert.equal(financialYear('2026-04-01', 4), '2026-27');
    assert.equal(financialYear('2027-03-31', 4), '2026-27');
    assert.equal(financialYear('2027-04-01', 4), '2027-28');
  });

  test('a January date belongs to the financial year that began the previous April', () => {
    assert.equal(financialYear('2027-01-15', 4), '2026-27');
  });

  test('a calendar-year tenant rolls over in January', () => {
    assert.equal(financialYear('2026-01-01', 1), '2026-27');
    assert.equal(financialYear('2026-12-31', 1), '2026-27');
  });
});

describe('sequence allocation', () => {
  test('sequential allocations never repeat a number', async () => {
    const issued = [];
    for (let i = 0; i < 50; i++) {
      issued.push((await allocateNumber({ tenantId: TENANT.id, tenant: TENANT, date: '2026-08-21' })).number);
    }
    assert.equal(new Set(issued).size, 50, 'every allocated number is unique');
    assert.equal(issued[0], 'PHX/2026-27/0001');
    assert.equal(issued[49], 'PHX/2026-27/0050');
  });

  test('sequences are independent per financial year', async () => {
    const nextFy = await allocateNumber({ tenantId: TENANT.id, tenant: TENANT, date: '2027-05-10' });
    assert.equal(nextFy.fy, '2027-28');
    assert.equal(nextFy.seq, 1, 'a new financial year restarts at one');
    assert.equal(nextFy.number, 'PHX/2027-28/0001');
  });

  test('sequences are independent per tenant', async () => {
    await db.run(
      `INSERT INTO tenants (id, name, slug, invoice_prefix, invoice_scheme, fy_start_month, created_at, updated_at)
       VALUES ('other-tenant', 'Other', 'other-tenant', 'OTH', '{prefix}/{fy}/{seq:4}', 4, ?, ?)`,
      [nowIso(), nowIso()],
    );
    const other = await allocateNumber({
      tenantId: 'other-tenant',
      tenant: { invoice_prefix: 'OTH', invoice_scheme: '{prefix}/{fy}/{seq:4}', fy_start_month: 4 },
      date: '2026-08-21',
    });
    assert.equal(other.seq, 1, "another tenant's counter is unaffected");
    assert.equal(other.number, 'OTH/2026-27/0001');
  });

  test('proposals and invoices keep separate counters', async () => {
    const proposal = await allocateNumber({
      tenantId: TENANT.id, docType: 'proposal',
      tenant: { ...TENANT, proposal_prefix: 'PHXP' }, date: '2026-08-21',
    });
    assert.equal(proposal.seq, 1, 'the proposal counter starts fresh');
    assert.equal(proposal.prefix, 'PHXP');
  });

  test('peek shows the next number without consuming it', async () => {
    const before = await peekNumber({ tenantId: TENANT.id, tenant: TENANT, date: '2026-08-21' });
    const after = await peekNumber({ tenantId: TENANT.id, tenant: TENANT, date: '2026-08-21' });
    assert.equal(before.number, after.number, 'peeking twice returns the same number');

    const allocated = await allocateNumber({ tenantId: TENANT.id, tenant: TENANT, date: '2026-08-21' });
    assert.equal(allocated.number, before.number, 'the peeked number is the one actually issued');
  });

  test('peek can preview a different scheme without changing the stored one', async () => {
    const preview = await peekNumber({
      tenantId: TENANT.id, tenant: TENANT, date: '2026-08-21',
      scheme: '{prefix}-{fyshort}-{seq:5}',
    });
    assert.match(preview.number, /^PHX-202627-\d{5}$/);

    const stored = await peekNumber({ tenantId: TENANT.id, tenant: TENANT, date: '2026-08-21' });
    assert.match(stored.number, /^PHX\/2026-27\/\d{4}$/, 'the tenant scheme is untouched');
  });
});

describe('numbering audit', () => {
  test('a clean sequence reports no duplicates and no gaps', async () => {
    const tenantId = 'audit-clean';
    await db.run(
      `INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?, 'Audit', 'audit-clean', ?, ?)`,
      [tenantId, nowIso(), nowIso()],
    );
    await db.run(`INSERT INTO clients (id, tenant_id, name, created_at, updated_at) VALUES ('ac-1', ?, 'C', ?, ?)`,
      [tenantId, nowIso(), nowIso()]);

    for (let seq = 1; seq <= 5; seq++) {
      await db.run(
        `INSERT INTO invoices (id, tenant_id, client_id, number, seq, fy, issue_date, due_date,
           status, created_at, updated_at)
         VALUES (?,?, 'ac-1', ?, ?, '2026-27', '2026-08-01', '2026-08-16', 'sent', ?, ?)`,
        [uuid(), tenantId, `AC/2026-27/000${seq}`, seq, nowIso(), nowIso()],
      );
    }

    const audit = await numberingAudit(tenantId);
    assert.equal(audit.total_invoices, 5);
    assert.equal(audit.duplicate_numbers, 0);
    assert.equal(audit.sequence_gaps, 0);
    assert.equal(audit.clean, true);
  });

  test('a missing sequence number is reported as a gap', async () => {
    const tenantId = 'audit-gap';
    await db.run(
      `INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?, 'Gap', 'audit-gap', ?, ?)`,
      [tenantId, nowIso(), nowIso()],
    );
    await db.run(`INSERT INTO clients (id, tenant_id, name, created_at, updated_at) VALUES ('ag-1', ?, 'C', ?, ?)`,
      [tenantId, nowIso(), nowIso()]);

    for (const seq of [1, 2, 4]) {          // 3 is missing
      await db.run(
        `INSERT INTO invoices (id, tenant_id, client_id, number, seq, fy, issue_date, due_date,
           status, created_at, updated_at)
         VALUES (?,?, 'ag-1', ?, ?, '2026-27', '2026-08-01', '2026-08-16', 'sent', ?, ?)`,
        [uuid(), tenantId, `AG/2026-27/000${seq}`, seq, nowIso(), nowIso()],
      );
    }

    const audit = await numberingAudit(tenantId);
    assert.equal(audit.sequence_gaps, 1);
    assert.equal(audit.clean, false);
  });
});

describe('database-level protection', () => {
  test('the unique constraint rejects a duplicate number even if code tries', async () => {
    const tenantId = 'dup-guard';
    await db.run(
      `INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES (?, 'Dup', 'dup-guard', ?, ?)`,
      [tenantId, nowIso(), nowIso()],
    );
    await db.run(`INSERT INTO clients (id, tenant_id, name, created_at, updated_at) VALUES ('dg-1', ?, 'C', ?, ?)`,
      [tenantId, nowIso(), nowIso()]);

    const insert = async (id) => await db.run(
      `INSERT INTO invoices (id, tenant_id, client_id, number, seq, fy, issue_date, due_date,
         status, created_at, updated_at)
       VALUES (?,?, 'dg-1', 'DUP/2026-27/0001', 1, '2026-27', '2026-08-01', '2026-08-16', 'sent', ?, ?)`,
      [id, tenantId, nowIso(), nowIso()],
    );

    await insert(uuid());
    // This is the backstop the "Cotton India" defect needed: the database itself
    // refuses a second invoice carrying a number already issued in this tenant.
    await assert.rejects(async () => await insert(uuid()), /UNIQUE|constraint/i);
  });
});
