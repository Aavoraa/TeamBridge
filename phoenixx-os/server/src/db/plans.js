/**
 * The platform's subscription plans and launch coupons. Shared by the demo
 * seed (seed.js) and the clean production setup (bootstrap.js). Safe to run
 * twice: it does nothing when plans already exist.
 */
import { get, run } from './index.js';
import { uuid, nowIso, addMonths, forEachSeq } from '../lib/util.js';

const rupees = (n) => Math.round(n * 100);

export async function seedPlans() {
  const ts = nowIso();
  if (await get('SELECT id FROM plans LIMIT 1')) return console.log('· plans already present');

  const plans = [
    {
      code: 'starter', name: 'Starter', band_max_users: 15,
      monthly: rupees(7_999), yearly: rupees(79_990), addon: rupees(499),
      features: {
        action_items: true, deadline_engine: true, crm: true, proposals: true, invoicing: true,
        hr: true, sop: true, reports: true, dashboard: true,
        whatsapp: true, custom_roles: false, client_portal: false, report_builder: false,
        api_access: false, white_label_reports: false,
      },
      limits: { clients: 50, storage_mb: 5_000, wa_credits: 1_000 },
    },
    {
      code: 'growth', name: 'Growth', band_min_users: 16, band_max_users: 30,
      monthly: rupees(13_999), yearly: rupees(139_990), addon: rupees(449),
      features: {
        action_items: true, deadline_engine: true, crm: true, proposals: true, invoicing: true,
        hr: true, sop: true, reports: true, dashboard: true,
        whatsapp: true, custom_roles: true, client_portal: true, report_builder: true,
        api_access: false, white_label_reports: false,
      },
      limits: { clients: 200, storage_mb: 20_000, wa_credits: 5_000 },
    },
    {
      code: 'scale', name: 'Scale', band_min_users: 31, band_max_users: 50,
      monthly: rupees(22_999), yearly: rupees(229_990), addon: rupees(399),
      features: {
        action_items: true, deadline_engine: true, crm: true, proposals: true, invoicing: true,
        hr: true, sop: true, reports: true, dashboard: true,
        whatsapp: true, custom_roles: true, client_portal: true, report_builder: true,
        api_access: true, white_label_reports: true,
      },
      limits: { clients: null, storage_mb: 100_000, wa_credits: 15_000 },
    },
  ];

  await forEachSeq(plans, async (p, i) => {
    await run(
      `INSERT INTO plans (id, code, name, band_min_users, band_max_users, price_monthly_minor,
         price_yearly_minor, addon_user_monthly_minor, features, limits, sort, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), p.code, p.name, p.band_min_users ?? 1, p.band_max_users, p.monthly, p.yearly,
        p.addon, JSON.stringify(p.features), JSON.stringify(p.limits), i, ts],
    );
  });

  // S3 - launch offer: the first 25 tenants get three months free.
  await run(
    `INSERT INTO coupons (id, code, kind, value, duration_months, max_redemptions, valid_until, created_at)
     VALUES (?, 'LAUNCH3', 'free_months', 3, 3, 25, ?, ?)`,
    [uuid(), addMonths(new Date(), 6).toISOString(), ts],
  );
  await run(
    `INSERT INTO coupons (id, code, kind, value, max_redemptions, created_at)
     VALUES (?, 'AGENCY20', 'percent', 20, 100, ?)`,
    [uuid(), ts],
  );

  console.log(`✓ ${plans.length} plans + 2 coupons`);
}

