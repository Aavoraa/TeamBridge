import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso, addDays, addMonths, parseJson, daysBetween } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit, ApiError } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { idempotency } from '../middleware/common.js';
import { config } from '../config.js';

const router = Router();

/**
 * PRD 4 - subscription billing.
 *
 * Gateway integration is behind a provider interface: Razorpay for India
 * (UPI/cards/netbanking) and Stripe internationally (S4). Without credentials
 * the `manual` provider records the intent and marks the invoice due, so the
 * whole lifecycle - trial, upgrade, proration, dunning, suspension - is
 * exercisable end to end before a gateway account exists.
 */

const gateways = {
  manual: {
    id: 'manual',
    async createOrder({ amountMinor, currency, notes }) {
      return { id: `manual_${uuid().slice(0, 12)}`, amount: amountMinor, currency, notes, provider: 'manual' };
    },
  },
  razorpay: {
    id: 'razorpay',
    async createOrder({ amountMinor, currency, notes }) {
      if (!config.billing.razorpayKeyId) throw new ApiError(503, 'gateway_unconfigured', 'Razorpay is not configured');
      const auth = Buffer.from(`${config.billing.razorpayKeyId}:${config.billing.razorpayKeySecret}`).toString('base64');
      const res = await fetch('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amountMinor, currency, notes }),
      });
      const json = await res.json();
      if (!res.ok) throw new ApiError(502, 'gateway_error', json?.error?.description || 'Razorpay rejected the order');
      return { ...json, provider: 'razorpay', key_id: config.billing.razorpayKeyId };
    },
  },
  stripe: {
    id: 'stripe',
    async createOrder({ amountMinor, currency }) {
      if (!config.billing.stripeSecret) throw new ApiError(503, 'gateway_unconfigured', 'Stripe is not configured');
      const res = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.billing.stripeSecret}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({ amount: String(amountMinor), currency: currency.toLowerCase() }),
      });
      const json = await res.json();
      if (!res.ok) throw new ApiError(502, 'gateway_error', json?.error?.message || 'Stripe rejected the intent');
      return { ...json, provider: 'stripe' };
    },
  },
};

const gatewayFor = (currency) => {
  if (currency !== 'INR' && config.billing.stripeSecret) return gateways.stripe;
  if (config.billing.razorpayKeyId) return gateways.razorpay;
  return gateways.manual;
};

const hydratePlan = (p) => ({ ...p, features: parseJson(p.features, {}), limits: parseJson(p.limits, {}) });

// ------------------------------------------------------------------- plans
router.get('/plans', async (req, res) => ok(res, (await all(
  'SELECT * FROM plans WHERE active = 1 ORDER BY sort',
)).map(hydratePlan)));

// ------------------------------------------------------------ subscription
router.get('/subscription', requires('billing', 'view'), async (req, res) => {
  const sub = await get(
    `SELECT s.*, p.code AS plan_code, p.name AS plan_name, p.features, p.limits, p.band_min_users,
            p.band_max_users, p.price_monthly_minor, p.price_yearly_minor, p.addon_user_monthly_minor,
            c.code AS coupon_code
       FROM subscriptions s JOIN plans p ON p.id = s.plan_id
       LEFT JOIN coupons c ON c.id = s.coupon_id
      WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`,
    [req.auth.tenantId],
  );
  if (!sub) throw notFound('Subscription');

  const seats = Number((await get(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client' AND status != 'disabled'",
    [req.auth.tenantId],
  ))?.n || 0);

  const usage = {
    users: seats,
    users_limit: sub.band_max_users,
    clients: Number((await get('SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND deleted_at IS NULL', [req.auth.tenantId]))?.n || 0),
    clients_limit: parseJson(sub.limits, {}).clients ?? null,
    storage_mb: Math.round(Number((await get('SELECT COALESCE(SUM(size_bytes),0) AS b FROM attachments WHERE tenant_id = ? AND deleted_at IS NULL',
      [req.auth.tenantId]))?.b || 0) / 1_048_576),
    storage_limit_mb: parseJson(sub.limits, {}).storage_mb ?? null,
    whatsapp_sent: Number((await get("SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND channel = 'whatsapp' AND created_at >= ?",
      [req.auth.tenantId, sub.current_period_start || nowIso()]))?.n || 0),
    whatsapp_credits: parseJson(sub.limits, {}).wa_credits ?? null,
  };

  const addonSeats = Math.max(0, seats - sub.band_max_users);
  return ok(res, {
    ...sub,
    features: parseJson(sub.features, {}),
    limits: parseJson(sub.limits, {}),
    usage,
    addon_seats: addonSeats,
    addon_monthly_minor: addonSeats * sub.addon_user_monthly_minor,
    trial_days_left: sub.status === 'trial' && sub.trial_ends_at
      ? Math.max(0, daysBetween(new Date(), sub.trial_ends_at)) : null,
    invoices: await all('SELECT * FROM subscription_invoices WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 12',
      [req.auth.tenantId]),
  });
});

/** Quotes a plan change, including proration for the unused period (S4). */
function quoteChange(sub, plan, cycle, seats) {
  const base = cycle === 'yearly' ? plan.price_yearly_minor : plan.price_monthly_minor;
  const addonSeats = Math.max(0, seats - plan.band_max_users);
  const addon = addonSeats * plan.addon_user_monthly_minor * (cycle === 'yearly' ? 12 : 1);
  const gross = base + addon;

  let credit = 0;
  if (sub.status === 'active' && sub.current_period_end) {
    const total = Math.max(1, daysBetween(sub.current_period_start, sub.current_period_end));
    const remaining = Math.max(0, daysBetween(new Date(), sub.current_period_end));
    const paidBase = sub.billing_cycle === 'yearly' ? sub.price_yearly_minor : sub.price_monthly_minor;
    credit = Math.round((paidBase || 0) * (remaining / total));
  }

  const taxable = Math.max(0, gross - credit);
  const gst = Math.round(taxable * 0.18);       // S4 - GST on the subscription itself
  return {
    plan_code: plan.code,
    cycle,
    base_minor: base,
    addon_seats: addonSeats,
    addon_minor: addon,
    proration_credit_minor: credit,
    taxable_minor: taxable,
    gst_minor: gst,
    total_minor: taxable + gst,
    currency: plan.currency,
  };
}

router.post('/subscription/quote', requires('billing', 'view'), async (req, res) => {
  const body = validate(z.object({
    plan_code: z.string(),
    billing_cycle: z.enum(['monthly', 'yearly']).optional(),
    coupon_code: z.string().optional(),
  }), req.body);

  const plan = await get('SELECT * FROM plans WHERE code = ? AND active = 1', [body.plan_code]);
  if (!plan) throw notFound('Plan');

  const sub = await get(
    `SELECT s.*, p.price_monthly_minor, p.price_yearly_minor FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`,
    [req.auth.tenantId],
  );
  const seats = Number((await get(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client' AND status != 'disabled'",
    [req.auth.tenantId],
  ))?.n || 0);

  const quote = quoteChange(sub || {}, plan, body.billing_cycle || 'monthly', seats);

  if (body.coupon_code) {
    const coupon = await get("SELECT * FROM coupons WHERE code = ? AND active = 1", [body.coupon_code.toUpperCase()]);
    if (!coupon) throw badRequest('That coupon code is not valid');
    if (coupon.valid_until && coupon.valid_until < nowIso()) throw badRequest('That coupon has expired');
    if (coupon.max_redemptions && coupon.redeemed >= coupon.max_redemptions) throw badRequest('That coupon has been fully redeemed');

    const discount = coupon.kind === 'percent'
      ? Math.round((quote.taxable_minor * coupon.value) / 100)
      : coupon.kind === 'amount' ? Math.min(coupon.value, quote.taxable_minor)
        : quote.taxable_minor;                       // free_months: this cycle is free
    quote.coupon = { code: coupon.code, kind: coupon.kind, value: coupon.value, discount_minor: discount };
    quote.taxable_minor -= discount;
    quote.gst_minor = Math.round(quote.taxable_minor * 0.18);
    quote.total_minor = quote.taxable_minor + quote.gst_minor;
  }

  return ok(res, quote);
});

/** S3/S4 - upgrade, downgrade or convert a trial. */
router.post('/subscription/change', requires('billing', 'edit'), idempotency, async (req, res) => {
  const body = validate(z.object({
    plan_code: z.string(),
    billing_cycle: z.enum(['monthly', 'yearly']).optional(),
    coupon_code: z.string().optional(),
  }), req.body);
  const { tenantId } = req.auth;

  const plan = await get('SELECT * FROM plans WHERE code = ? AND active = 1', [body.plan_code]);
  if (!plan) throw notFound('Plan');

  const sub = await get(
    `SELECT s.*, p.price_monthly_minor, p.price_yearly_minor FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id WHERE s.tenant_id = ? ORDER BY s.created_at DESC LIMIT 1`,
    [tenantId],
  );
  if (!sub) throw notFound('Subscription');

  const seats = Number((await get(
    "SELECT COUNT(*) AS n FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND role != 'client' AND status != 'disabled'",
    [tenantId],
  ))?.n || 0);
  if (seats > plan.band_max_users && plan.addon_user_monthly_minor === 0) {
    throw badRequest(`The ${plan.name} plan covers up to ${plan.band_max_users} users; this workspace has ${seats}.`);
  }

  const cycle = body.billing_cycle || sub.billing_cycle || 'monthly';
  const quote = quoteChange(sub, plan, cycle, seats);

  let coupon = null;
  if (body.coupon_code) {
    coupon = await get('SELECT * FROM coupons WHERE code = ? AND active = 1', [body.coupon_code.toUpperCase()]);
    if (!coupon) throw badRequest('That coupon code is not valid');
    const discount = coupon.kind === 'percent'
      ? Math.round((quote.taxable_minor * coupon.value) / 100)
      : coupon.kind === 'amount' ? Math.min(coupon.value, quote.taxable_minor) : quote.taxable_minor;
    quote.taxable_minor -= discount;
    quote.gst_minor = Math.round(quote.taxable_minor * 0.18);
    quote.total_minor = quote.taxable_minor + quote.gst_minor;
  }

  const gateway = gatewayFor(plan.currency);
  const order = quote.total_minor > 0
    ? await gateway.createOrder({
      amountMinor: quote.total_minor,
      currency: plan.currency,
      notes: { tenant_id: tenantId, plan: plan.code, cycle },
    })
    : null;

  const periodEnd = cycle === 'yearly' ? addMonths(new Date(), 12) : addMonths(new Date(), 1);
  const invoiceId = uuid();

  await tx(async () => {
    await run(
      `UPDATE subscriptions SET plan_id = ?, billing_cycle = ?, status = ?, seats = ?, coupon_id = ?,
         gateway = ?, gateway_ref = ?, current_period_start = ?, current_period_end = ?, updated_at = ?
       WHERE id = ?`,
      [plan.id, cycle, quote.total_minor > 0 ? 'past_due' : 'active', seats, coupon?.id ?? null,
        gateway.id, order?.id ?? null, nowIso(), periodEnd.toISOString(), nowIso(), sub.id],
    );
    await run(
      `INSERT INTO subscription_invoices (id, tenant_id, subscription_id, number, amount_minor,
         tax_minor, total_minor, currency, status, period_start, period_end, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [invoiceId, tenantId, sub.id, `PHX-SUB-${Date.now().toString(36).toUpperCase()}`,
        quote.taxable_minor, quote.gst_minor, quote.total_minor, plan.currency,
        quote.total_minor > 0 ? 'due' : 'paid', nowIso(), periodEnd.toISOString(), nowIso()],
    );
    if (coupon) await run('UPDATE coupons SET redeemed = redeemed + 1 WHERE id = ?', [coupon.id]);
  });

  await audit(req, { entity: 'subscription', entityId: sub.id, action: 'update', after: { plan: plan.code, cycle, total: quote.total_minor } });
  return ok(res, {
    quote,
    order,
    subscription_invoice_id: invoiceId,
    status: quote.total_minor > 0 ? 'awaiting_payment' : 'active',
  });
});

/** Confirms a gateway payment (or records a manual one) and activates the plan. */
router.post('/subscription/confirm-payment', requires('billing', 'edit'), idempotency, async (req, res) => {
  const body = validate(z.object({
    subscription_invoice_id: z.string(),
    gateway_payment_id: z.string().optional(),
  }), req.body);
  const { tenantId } = req.auth;

  const inv = await get('SELECT * FROM subscription_invoices WHERE id = ? AND tenant_id = ?',
    [body.subscription_invoice_id, tenantId]);
  if (!inv) throw notFound('Subscription invoice');
  if (inv.status === 'paid') return ok(res, { already_paid: true });

  await tx(async () => {
    await run("UPDATE subscription_invoices SET status = 'paid', paid_at = ? WHERE id = ?", [nowIso(), inv.id]);
    await run(
      `UPDATE subscriptions SET status = 'active', gateway_ref = COALESCE(?, gateway_ref), updated_at = ?
        WHERE id = ?`,
      [body.gateway_payment_id ?? null, nowIso(), inv.subscription_id],
    );
    await run("UPDATE tenants SET status = 'active', updated_at = ? WHERE id = ?", [nowIso(), tenantId]);
  });

  await audit(req, { entity: 'subscription', entityId: inv.subscription_id, action: 'update', after: { paid: inv.total_minor } });
  return ok(res, await get('SELECT * FROM subscriptions WHERE id = ?', [inv.subscription_id]));
});

/** S5 - cancellation keeps a 90-day export window open. */
router.post('/subscription/cancel', requires('billing', 'edit'), async (req, res) => {
  const { reason, immediate } = validate(
    z.object({ reason: z.string().optional(), immediate: z.boolean().optional() }), req.body || {},
  );
  const sub = await get('SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    [req.auth.tenantId]);
  if (!sub) throw notFound('Subscription');

  const cancelAt = immediate ? nowIso() : (sub.current_period_end || nowIso());
  await run(
    `UPDATE subscriptions SET status = ?, cancel_at = ?, cancelled_at = ?, data_export_until = ?, updated_at = ?
      WHERE id = ?`,
    [immediate ? 'cancelled' : sub.status, cancelAt, nowIso(),
      addDays(cancelAt, 90).toISOString(), nowIso(), sub.id],
  );
  if (immediate) await run("UPDATE tenants SET status = 'cancelled', updated_at = ? WHERE id = ?", [nowIso(), req.auth.tenantId]);

  await audit(req, { entity: 'subscription', entityId: sub.id, action: 'update', after: { cancelled: true, reason } });
  return ok(res, {
    ...await get('SELECT * FROM subscriptions WHERE id = ?', [sub.id]),
    message: immediate
      ? 'Subscription cancelled. Your data stays exportable for 90 days.'
      : `Subscription will end on ${cancelAt.slice(0, 10)}. Your data stays exportable for 90 days after that.`,
  });
});

router.post('/subscription/reactivate', requires('billing', 'edit'), async (req, res) => {
  const sub = await get('SELECT * FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1',
    [req.auth.tenantId]);
  if (!sub) throw notFound('Subscription');
  if (!sub.cancelled_at) throw badRequest('This subscription is not cancelled');

  await run(
    `UPDATE subscriptions SET status = 'active', cancel_at = NULL, cancelled_at = NULL,
       data_export_until = NULL, updated_at = ? WHERE id = ?`,
    [nowIso(), sub.id],
  );
  await run("UPDATE tenants SET status = 'active', updated_at = ? WHERE id = ?", [nowIso(), req.auth.tenantId]);
  return ok(res, await get('SELECT * FROM subscriptions WHERE id = ?', [sub.id]));
});

/** S6 - add-on purchases (WhatsApp packs, storage). */
router.post('/addons', requires('billing', 'edit'), idempotency, async (req, res) => {
  const body = validate(z.object({
    addon: z.enum(['whatsapp_pack', 'storage_pack', 'implementation']),
    quantity: z.number().int().min(1).max(100).optional(),
  }), req.body);

  const catalogue = {
    whatsapp_pack: { label: '1,000 WhatsApp message credits', price_minor: 80_000 },
    storage_pack: { label: '50 GB extra storage', price_minor: 50_000 },
    implementation: { label: 'Implementation & configuration service', price_minor: 2_500_000 },
  };
  const item = catalogue[body.addon];
  const qty = body.quantity || 1;
  const taxable = item.price_minor * qty;
  const gst = Math.round(taxable * 0.18);

  const gateway = gatewayFor('INR');
  const order = await gateway.createOrder({
    amountMinor: taxable + gst,
    currency: 'INR',
    notes: { tenant_id: req.auth.tenantId, addon: body.addon, quantity: qty },
  });

  const id = uuid();
  const sub = await get('SELECT id FROM subscriptions WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1', [req.auth.tenantId]);
  await run(
    `INSERT INTO subscription_invoices (id, tenant_id, subscription_id, number, amount_minor, tax_minor,
       total_minor, currency, status, created_at) VALUES (?,?,?,?,?,?,?, 'INR', 'due', ?)`,
    [id, req.auth.tenantId, sub.id, `PHX-ADD-${Date.now().toString(36).toUpperCase()}`,
      taxable, gst, taxable + gst, nowIso()],
  );

  return created(res, {
    addon: { ...item, quantity: qty }, taxable_minor: taxable, gst_minor: gst,
    total_minor: taxable + gst, order, subscription_invoice_id: id,
  });
});

export { router as billingRouter };
