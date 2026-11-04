import { forEachSeq } from '../src/lib/util.js';
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
const { uuid, nowIso, addDays, addMonths } = await import('../src/lib/util.js');

await db.migrate();

/** Three bands, so upgrades, downgrades and band caps can all be exercised. */
const PLANS = [
  { code: 'starter', name: 'Starter', min: 1, max: 2, monthly: 799_900, yearly: 7_999_000, addon: 49_900 },
  { code: 'growth', name: 'Growth', min: 3, max: 30, monthly: 1_399_900, yearly: 13_999_000, addon: 44_900 },
  { code: 'scale', name: 'Scale', min: 31, max: 50, monthly: 2_299_900, yearly: 22_999_000, addon: 39_900 },
];

await forEachSeq(PLANS, async (p, i) => {
  await db.run(
    `INSERT INTO plans (id, code, name, band_min_users, band_max_users, price_monthly_minor,
       price_yearly_minor, addon_user_monthly_minor, features, limits, sort, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), p.code, p.name, p.min, p.max, p.monthly, p.yearly, p.addon,
      JSON.stringify({ custom_roles: p.code !== 'starter', api_access: p.code === 'scale' }),
      JSON.stringify({ clients: p.code === 'scale' ? null : 200, storage_mb: 20_000, wa_credits: 5_000 }),
      i, nowIso()],
  );
});

await db.run(
  `INSERT INTO coupons (id, code, kind, value, max_redemptions, created_at)
   VALUES (?, 'HALFOFF', 'percent', 50, 10, ?)`, [uuid(), nowIso()],
);
await db.run(
  `INSERT INTO coupons (id, code, kind, value, max_redemptions, valid_until, created_at)
   VALUES (?, 'EXPIRED', 'percent', 90, 10, ?, ?)`,
  [uuid(), addDays(new Date(), -1).toISOString(), nowIso()],
);
await db.run(
  `INSERT INTO coupons (id, code, kind, value, max_redemptions, redeemed, created_at)
   VALUES (?, 'USEDUP', 'percent', 30, 1, 1, ?)`, [uuid(), nowIso()],
);

const api = await startServer();
after(() => api.close());

const session = await signUpTenant(api, { agency_name: 'Billing Co', email: 'billing@test.test', plan_code: 'growth' });
const token = session.access_token;
const tenantId = session.tenant.id;

const subscription = async () => await db.get('SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1', [tenantId]);

describe('quoting a plan', () => {
  test('GST is added on top of the plan price', async () => {
    const q = (await api.post('/billing/subscription/quote', {
      plan_code: 'growth', billing_cycle: 'monthly',
    }, { token })).body.data;

    assert.equal(q.base_minor, 1_399_900);
    assert.equal(q.gst_minor, Math.round(q.taxable_minor * 0.18));
    assert.equal(q.total_minor, q.taxable_minor + q.gst_minor);
    assert.equal(q.currency, 'INR');
  });

  test('a percentage coupon reduces the taxable amount before GST', async () => {
    const plain = (await api.post('/billing/subscription/quote', { plan_code: 'growth' }, { token })).body.data;
    const discounted = (await api.post('/billing/subscription/quote', {
      plan_code: 'growth', coupon_code: 'HALFOFF',
    }, { token })).body.data;

    assert.equal(discounted.coupon.discount_minor, Math.round(plain.taxable_minor * 0.5));
    assert.equal(discounted.taxable_minor, plain.taxable_minor - discounted.coupon.discount_minor);
    assert.equal(discounted.gst_minor, Math.round(discounted.taxable_minor * 0.18),
      'GST is charged on the discounted amount, not the list price');
  });

  test('an expired coupon is refused', async () => {
    const res = await api.post('/billing/subscription/quote', {
      plan_code: 'growth', coupon_code: 'EXPIRED',
    }, { token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /expired/i);
  });

  test('a fully redeemed coupon is refused', async () => {
    const res = await api.post('/billing/subscription/quote', {
      plan_code: 'growth', coupon_code: 'USEDUP',
    }, { token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /fully redeemed/i);
  });

  test('a coupon code is matched case-insensitively', async () => {
    const res = await api.post('/billing/subscription/quote', {
      plan_code: 'growth', coupon_code: 'halfoff',
    }, { token });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.coupon);
  });

  test('a trial has no unused time to credit back', async () => {
    const q = (await api.post('/billing/subscription/quote', { plan_code: 'growth' }, { token })).body.data;
    assert.equal(q.proration_credit_minor, 0, 'there is nothing to prorate out of a free trial');
  });
});

describe('changing plan', () => {
  test('a change moves the subscription to awaiting payment and raises an invoice', async () => {
    const res = await api.post('/billing/subscription/change', {
      plan_code: 'growth', billing_cycle: 'monthly',
    }, { token, headers: { 'Idempotency-Key': 'change-1' } });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'awaiting_payment');
    assert.ok(res.body.data.subscription_invoice_id);

    const sub = await subscription();
    assert.equal(sub.status, 'past_due', 'the plan is not active until it is paid for');

    const invoice = await db.get('SELECT * FROM subscription_invoices WHERE id = ?', [res.body.data.subscription_invoice_id]);
    assert.equal(invoice.status, 'due');
    assert.equal(invoice.total_minor, res.body.data.quote.total_minor);
  });

  test('confirming payment activates the subscription', async () => {
    const invoiceId = (await db.get(
      "SELECT id FROM subscription_invoices WHERE tenant_id = ? AND status = 'due' ORDER BY created_at DESC LIMIT 1",
      [tenantId],
    )).id;

    const res = await api.post('/billing/subscription/confirm-payment', {
      subscription_invoice_id: invoiceId, gateway_payment_id: 'pay_test_123',
    }, { token, headers: { 'Idempotency-Key': 'confirm-1' } });

    assert.equal(res.status, 200);
    assert.equal((await subscription()).status, 'active');
    assert.equal((await db.get('SELECT status FROM subscription_invoices WHERE id = ?', [invoiceId])).status, 'paid');
    assert.equal((await db.get('SELECT status FROM tenants WHERE id = ?', [tenantId])).status, 'active');
  });

  test('confirming the same invoice twice is a no-op, not a double charge', async () => {
    const invoiceId = (await db.get(
      "SELECT id FROM subscription_invoices WHERE tenant_id = ? AND status = 'paid' ORDER BY created_at DESC LIMIT 1",
      [tenantId],
    )).id;

    const res = await api.post('/billing/subscription/confirm-payment', {
      subscription_invoice_id: invoiceId,
    }, { token, headers: { 'Idempotency-Key': 'confirm-repeat' } });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.already_paid, true);
  });

  test('an active plan credits back its unused time when changing', async () => {
    const q = (await api.post('/billing/subscription/quote', {
      plan_code: 'scale', billing_cycle: 'monthly',
    }, { token })).body.data;

    assert.ok(q.proration_credit_minor > 0,
      'a plan paid for through month-end is credited when swapped mid-cycle');
    assert.ok(q.taxable_minor < q.base_minor);
  });

  test('a coupon redemption count increases when the change is committed', async () => {
    const before = (await db.get("SELECT redeemed FROM coupons WHERE code = 'HALFOFF'")).redeemed;

    await api.post('/billing/subscription/change', {
      plan_code: 'growth', billing_cycle: 'yearly', coupon_code: 'HALFOFF',
    }, { token, headers: { 'Idempotency-Key': 'change-coupon' } });

    const after = (await db.get("SELECT redeemed FROM coupons WHERE code = 'HALFOFF'")).redeemed;
    assert.equal(after, before + 1);
  });

  test('an unknown plan is rejected', async () => {
    const res = await api.post('/billing/subscription/change', { plan_code: 'nope' }, { token });
    assert.equal(res.status, 404);
  });
});

describe('band caps and add-on seats', () => {
  test('a plan smaller than the current headcount is refused when it has no add-on pricing', async () => {
    await db.run("UPDATE plans SET addon_user_monthly_minor = 0 WHERE code = 'starter'");

    // Put four active users in the workspace; Starter allows two.
    for (let i = 0; i < 3; i++) {
      await db.run(
        `INSERT INTO users (id, tenant_id, email, password_hash, name, role, status, created_at, updated_at)
         VALUES (?,?,?, 'x', ?, 'employee', 'active', ?, ?)`,
        [uuid(), tenantId, `seat${i}@billing.test`, `Seat ${i}`, nowIso(), nowIso()],
      );
    }

    const res = await api.post('/billing/subscription/change', { plan_code: 'starter' }, { token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /covers up to/i);

    await db.run("UPDATE plans SET addon_user_monthly_minor = 49900 WHERE code = 'starter'");
  });

  test('users beyond the band are quoted as add-on seats', async () => {
    const q = (await api.post('/billing/subscription/quote', { plan_code: 'starter' }, { token })).body.data;

    assert.ok(q.addon_seats > 0, 'the overflow above the band cap is counted');
    assert.equal(q.addon_minor, q.addon_seats * 49_900);
    assert.ok(q.base_minor + q.addon_minor > q.base_minor);
  });

  test('the subscription view reports add-on seats and their monthly cost', async () => {
    const res = await api.get('/billing/subscription', { token });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.data.addon_seats, 'number');
    assert.equal(typeof res.body.data.addon_monthly_minor, 'number');
  });

  test('inviting past the band cap is blocked unless an add-on seat is accepted', async () => {
    await db.run("UPDATE plans SET band_max_users = 4 WHERE code = 'growth'");

    const blocked = await api.post('/users', {
      name: 'Over Band', email: 'overband@billing.test', role: 'employee',
    }, { token });
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error.message, /Upgrade, or re-send/i);

    const allowed = await api.post('/users?allow_addon=true', {
      name: 'Over Band', email: 'overband@billing.test', role: 'employee',
    }, { token });
    assert.equal(allowed.status, 201, 'the add-on seat is an explicit, priced decision');

    await db.run("UPDATE plans SET band_max_users = 30 WHERE code = 'growth'");
  });
});

describe('add-ons', () => {
  test('an add-on purchase raises its own GST invoice', async () => {
    const res = await api.post('/billing/addons', {
      addon: 'whatsapp_pack', quantity: 3,
    }, { token, headers: { 'Idempotency-Key': 'addon-1' } });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.taxable_minor, 80_000 * 3);
    assert.equal(res.body.data.gst_minor, Math.round(80_000 * 3 * 0.18));
    assert.equal(res.body.data.total_minor, res.body.data.taxable_minor + res.body.data.gst_minor);

    const invoice = await db.get('SELECT * FROM subscription_invoices WHERE id = ?', [res.body.data.subscription_invoice_id]);
    assert.equal(invoice.status, 'due');
  });

  test('an unknown add-on is rejected', async () => {
    const res = await api.post('/billing/addons', { addon: 'gold_plating' }, { token });
    assert.equal(res.status, 422);
  });
});

describe('cancellation and the read-only state', () => {
  test('cancelling at period end keeps the workspace usable and opens a 90-day export window', async () => {
    const res = await api.post('/billing/subscription/cancel', { immediate: false }, { token });

    assert.equal(res.status, 200);
    assert.match(res.body.data.message, /90 days/);

    const sub = await subscription();
    assert.ok(sub.cancelled_at);
    assert.ok(sub.data_export_until > nowIso(), 'the export window is in the future');
    assert.equal((await db.get('SELECT status FROM tenants WHERE id = ?', [tenantId])).status, 'active',
      'the workspace keeps working until the period actually ends');
  });

  test('reactivating restores the subscription', async () => {
    const res = await api.post('/billing/subscription/reactivate', {}, { token });
    assert.equal(res.status, 200);

    const sub = await subscription();
    assert.equal(sub.status, 'active');
    assert.equal(sub.cancelled_at, null);
  });

  test('a suspended workspace becomes read-only but still allows reads and export', async () => {
    await db.run("UPDATE subscriptions SET status = 'suspended' WHERE tenant_id = ?", [tenantId]);

    const read = await api.get('/crm/clients', { token });
    assert.equal(read.status, 200, 'reading is always allowed - the data is theirs');

    const write = await api.post('/crm/clients', { name: 'Should not save' }, { token });
    assert.equal(write.status, 402);
    assert.equal(write.body.error.code, 'subscription_read_only');

    const exportRes = await api.get('/settings/data-export', { token });
    assert.equal(exportRes.status, 200, 'export stays available so nobody is held hostage');

    await db.run("UPDATE subscriptions SET status = 'active' WHERE tenant_id = ?", [tenantId]);
  });

  test('writing works again once the subscription is restored', async () => {
    const res = await api.post('/crm/clients', { name: 'Back in business' }, { token });
    assert.equal(res.status, 201);
  });
});

describe('feature flags follow the plan', () => {
  test('a feature absent from the plan is reported as unavailable', async () => {
    const res = await api.get('/billing/subscription', { token });
    assert.equal(res.body.data.features.api_access, false, 'API access is a Scale-tier feature');
    assert.equal(res.body.data.features.custom_roles, true);
  });

  test('usage is measured against the plan limits', async () => {
    const { usage } = (await api.get('/billing/subscription', { token })).body.data;
    assert.equal(usage.clients_limit, 200);
    assert.ok(usage.users >= 1);
    assert.ok(usage.storage_mb >= 0);
  });
});
