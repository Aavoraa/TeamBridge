import test, { describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
const { scoreClient, scoreAllClients } = await import('../src/services/scoring.js');
const { uuid, nowIso, addDays, todayIso } = await import('../src/lib/util.js');

await db.migrate();

const TENANT = 'tenant-scoring';
let stageEarly; let stageLate; let riskReason;

await db.run(
  `INSERT INTO tenants (id, name, slug, settings, created_at, updated_at) VALUES (?, 'Scoring', 'scoring', ?, ?, ?)`,
  [TENANT, JSON.stringify({
    icp: { industries: ['textiles', 'construction'], target_deal_value_minor: 15_000_000 },
  }), nowIso(), nowIso()],
);

stageEarly = uuid();
stageLate = uuid();
await db.run(
  `INSERT INTO pipeline_stages (id, tenant_id, name, code, sort, probability, sla_days, created_at, updated_at)
   VALUES (?,?, 'Outreach', 'outreach', 0, 10, 7, ?, ?)`, [stageEarly, TENANT, nowIso(), nowIso()],
);
await db.run(
  `INSERT INTO pipeline_stages (id, tenant_id, name, code, sort, probability, is_won, sla_days, created_at, updated_at)
   VALUES (?,?, 'Execution', 'execution', 5, 95, 1, 90, ?, ?)`, [stageLate, TENANT, nowIso(), nowIso()],
);

const slBranding = uuid();
await db.run(`INSERT INTO service_lines (id, tenant_id, name, code, created_at, updated_at) VALUES (?,?, 'Branding', 'branding', ?, ?)`,
  [slBranding, TENANT, nowIso(), nowIso()]);

riskReason = uuid();
await db.run(`INSERT INTO reason_codes (id, tenant_id, category, code, label, severity, created_at)
        VALUES (?,?, 'score_adjust', 'STRATEGIC', 'Strategic logo value', 1, ?)`,
[riskReason, TENANT, nowIso()]);

let seq = 0;
async function makeClient(over = {}) {
  const id = `client-${++seq}`;
  await db.run(
    `INSERT INTO clients (id, tenant_id, name, industry, stage_id, status, engagement_model,
       mrr_minor, deal_value_minor, service_lines, scope_total, scope_delivered, satisfaction,
       renewal_date, stage_entered_at, last_activity_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, TENANT, over.name || `Client ${seq}`, over.industry ?? 'textiles',
      over.stage_id ?? stageLate, over.status ?? 'active', over.engagement_model ?? 'retainer',
      over.mrr_minor ?? 1_500_000, over.deal_value_minor ?? 0,
      JSON.stringify(over.service_lines ?? [slBranding]),
      over.scope_total ?? 10, over.scope_delivered ?? 9, over.satisfaction ?? 4,
      over.renewal_date ?? null,
      over.stage_entered_at ?? addDays(new Date(), -5).toISOString(),
      over.last_activity_at ?? addDays(new Date(), -1).toISOString(),
      over.created_at ?? addDays(new Date(), -200).toISOString(), nowIso()],
  );
  return id;
}

async function addActivity(clientId, { daysAgo = 1, type = 'call', direction = 'outbound', outcome = 'connected' } = {}) {
  await db.run(
    `INSERT INTO activities (id, tenant_id, client_id, type, direction, outcome, occurred_at, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [uuid(), TENANT, clientId, type, direction, outcome,
      addDays(new Date(), -daysAgo).toISOString(), nowIso()],
  );
}

async function addInvoice(clientId, { totalMinor = 1_180_000, balanceMinor = 0, dueDaysAgo = 20, paidDaysLate = 0 } = {}) {
  const dueDate = addDays(new Date(), -dueDaysAgo).toISOString().slice(0, 10);
  await db.run(
    `INSERT INTO invoices (id, tenant_id, client_id, number, seq, fy, status, issue_date, due_date,
       taxable_minor, total_minor, paid_minor, balance_minor, paid_at, created_at, updated_at)
     VALUES (?,?,?,?,?, '2026-27', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [uuid(), TENANT, clientId, `SC/${uuid().slice(0, 8)}`, ++seq,
      balanceMinor > 0 ? 'overdue' : 'paid',
      addDays(dueDate, -15).toISOString().slice(0, 10), dueDate,
      totalMinor, totalMinor, totalMinor - balanceMinor, balanceMinor,
      balanceMinor > 0 ? null : addDays(dueDate, paidDaysLate).toISOString(),
      nowIso(), nowIso()],
  );
}

describe('conversion score', () => {
  test('an engaged client deep in the pipeline scores higher than a cold early-stage lead', async () => {
    const engaged = await makeClient({ name: 'Engaged' });
    for (let i = 1; i <= 6; i++) await addActivity(engaged, { daysAgo: i * 2, outcome: 'positive' });

    const cold = await makeClient({
      name: 'Cold',
      stage_id: stageEarly,
      status: 'lead',
      stage_entered_at: addDays(new Date(), -90).toISOString(),
      last_activity_at: addDays(new Date(), -60).toISOString(),
    });
    for (let i = 1; i <= 6; i++) await addActivity(cold, { daysAgo: 40 + i, outcome: 'no_response' });

    const a = await scoreClient(TENANT, engaged, { persist: false });
    const b = await scoreClient(TENANT, cold, { persist: false });

    assert.ok(a.conversion > b.conversion,
      `engaged (${a.conversion}) should beat cold (${b.conversion})`);
    assert.ok(a.conversion >= 60, 'a responsive late-stage client should score well');
    assert.ok(b.conversion <= 40, 'an unresponsive stalled lead should score poorly');
  });

  test('sitting in a stage past its SLA drags the velocity component down', async () => {
    const fresh = await makeClient({ name: 'Fresh', stage_entered_at: addDays(new Date(), -2).toISOString() });
    const stale = await makeClient({ name: 'Stale', stage_entered_at: addDays(new Date(), -300).toISOString() });

    const a = await scoreClient(TENANT, fresh, { persist: false });
    const b = await scoreClient(TENANT, stale, { persist: false });

    assert.equal(a.breakdown.conversion.stage_velocity, 100, 'inside the SLA there is no penalty');
    assert.ok(b.breakdown.conversion.stage_velocity < 40,
      `300 days in a 90-day stage should hurt, got ${b.breakdown.conversion.stage_velocity}`);
  });

  test('velocity bottoms out at zero rather than going negative', async () => {
    // The decay reaches zero at four times the stage SLA; this stage allows 7 days.
    const abandoned = await makeClient({
      name: 'Abandoned', stage_id: stageEarly, status: 'lead',
      stage_entered_at: addDays(new Date(), -300).toISOString(),
    });

    const s = await scoreClient(TENANT, abandoned, { persist: false });
    assert.equal(s.breakdown.conversion.stage_velocity, 0);
    assert.ok(s.conversion >= 0, 'the overall score never goes negative either');
  });
});

describe('risk score', () => {
  test('paying on time keeps risk low', async () => {
    const good = await makeClient({ name: 'Prompt payer' });
    for (let i = 0; i < 4; i++) await addInvoice(good, { dueDaysAgo: 30 + i * 30, paidDaysLate: -2 });

    const s = await scoreClient(TENANT, good, { persist: false });
    assert.ok(s.risk < 30, `expected low risk, got ${s.risk}`);
    assert.equal(s.breakdown.risk.avg_days_late, 0);
  });

  test('chronic late payment and an overdue balance raise risk sharply', async () => {
    const bad = await makeClient({ name: 'Late payer' });
    for (let i = 0; i < 3; i++) await addInvoice(bad, { dueDaysAgo: 60 + i * 30, paidDaysLate: 40 });
    await addInvoice(bad, { dueDaysAgo: 25, balanceMinor: 1_180_000 });

    const good = await makeClient({ name: 'Prompt payer for comparison' });
    for (let i = 0; i < 4; i++) await addInvoice(good, { dueDaysAgo: 30 + i * 30, paidDaysLate: -2 });

    const s = await scoreClient(TENANT, bad, { persist: false });
    const baseline = await scoreClient(TENANT, good, { persist: false });

    assert.ok(s.risk > baseline.risk * 3,
      `late payer (${s.risk}) should be far riskier than the prompt payer (${baseline.risk})`);
    assert.ok(s.breakdown.risk.avg_days_late > 20, 'the delay itself is measured, not just inferred');
    assert.equal(s.breakdown.risk.overdue_invoices, 1);
    assert.ok(s.breakdown.risk.payment_delay_risk > 80,
      'paying 40 days late is close to the worst the delay component records');
  });

  test('a logged grievance in the last 90 days contributes to risk', async () => {
    const calm = await makeClient({ name: 'No complaints' });
    const upset = await makeClient({ name: 'Complained' });
    await addActivity(upset, { daysAgo: 10, type: 'grievance', direction: 'inbound', outcome: 'negative' });

    const a = await scoreClient(TENANT, calm, { persist: false });
    const b = await scoreClient(TENANT, upset, { persist: false });

    assert.equal(a.breakdown.risk.grievances_90d, 0);
    assert.equal(b.breakdown.risk.grievances_90d, 1);
    assert.ok(b.risk > a.risk);
  });

  test('a grievance older than 90 days no longer counts', async () => {
    const old = await makeClient({ name: 'Old grievance' });
    await addActivity(old, { daysAgo: 200, type: 'grievance', direction: 'inbound' });

    const s = await scoreClient(TENANT, old, { persist: false });
    assert.equal(s.breakdown.risk.grievances_90d, 0);
  });
});

describe('relevancy score', () => {
  test('an industry on the ideal-client list scores above one that is not', async () => {
    const onProfile = await makeClient({ name: 'Textiles', industry: 'textiles' });
    const offProfile = await makeClient({ name: 'Aviation', industry: 'aviation' });

    const a = await scoreClient(TENANT, onProfile, { persist: false });
    const b = await scoreClient(TENANT, offProfile, { persist: false });

    assert.equal(a.breakdown.relevancy.industry_fit, 100);
    assert.equal(b.breakdown.relevancy.industry_fit, 35);
    assert.ok(a.relevancy > b.relevancy);
  });

  test('a retainer is a better fit than a one-off project', async () => {
    const retainer = await makeClient({ name: 'Retainer', engagement_model: 'retainer' });
    const project = await makeClient({ name: 'Project', engagement_model: 'project', mrr_minor: 0, deal_value_minor: 1_500_000 });

    const a = await scoreClient(TENANT, retainer, { persist: false });
    const b = await scoreClient(TENANT, project, { persist: false });

    assert.ok(a.breakdown.relevancy.model_fit > b.breakdown.relevancy.model_fit);
  });
});

describe('retention score', () => {
  test('a churned client scores zero regardless of history', async () => {
    const churned = await makeClient({ name: 'Gone', status: 'churned', satisfaction: 5, scope_delivered: 10 });
    const s = await scoreClient(TENANT, churned, { persist: false });

    assert.equal(s.retention, 0);
    assert.equal(s.breakdown.retention.churned, true);
  });

  test('rising engagement scores better than falling engagement', async () => {
    const rising = await makeClient({ name: 'Rising' });
    for (let i = 1; i <= 8; i++) await addActivity(rising, { daysAgo: i * 3 });        // mostly recent

    const falling = await makeClient({ name: 'Falling' });
    for (let i = 1; i <= 8; i++) await addActivity(falling, { daysAgo: 32 + i * 3 });  // all in the prior window

    const a = await scoreClient(TENANT, rising, { persist: false });
    const b = await scoreClient(TENANT, falling, { persist: false });

    assert.ok(a.breakdown.retention.activities_30d > b.breakdown.retention.activities_30d);
    assert.ok(a.retention > b.retention);
  });

  test('an imminent renewal lowers the proximity component', async () => {
    const soon = await makeClient({ name: 'Renews soon', renewal_date: addDays(new Date(), 14).toISOString().slice(0, 10) });
    const later = await makeClient({ name: 'Renews later', renewal_date: addDays(new Date(), 200).toISOString().slice(0, 10) });

    const a = await scoreClient(TENANT, soon, { persist: false });
    const b = await scoreClient(TENANT, later, { persist: false });

    assert.ok(a.breakdown.retention.renewal_proximity < b.breakdown.retention.renewal_proximity,
      'a renewal two weeks out needs more attention than one six months out');
  });

  test('delivering less scope than committed lowers retention', async () => {
    const delivering = await makeClient({ name: 'On track', scope_total: 10, scope_delivered: 10 });
    const behind = await makeClient({ name: 'Behind', scope_total: 10, scope_delivered: 2 });

    const a = await scoreClient(TENANT, delivering, { persist: false });
    const b = await scoreClient(TENANT, behind, { persist: false });

    assert.equal(a.breakdown.retention.delivery_ratio, 100);
    assert.equal(b.breakdown.retention.delivery_ratio, 20);
    assert.ok(a.retention > b.retention);
  });
});

describe('health, flagging and persistence', () => {
  test('health rises with the positive scores and falls with risk', async () => {
    const healthy = await makeClient({ name: 'Healthy' });
    for (let i = 1; i <= 8; i++) await addActivity(healthy, { daysAgo: i * 2, outcome: 'positive' });
    await addInvoice(healthy, { dueDaysAgo: 30, paidDaysLate: -3 });

    const troubled = await makeClient({ name: 'Troubled', satisfaction: 2, scope_delivered: 2, scope_total: 10 });
    await addActivity(troubled, { daysAgo: 5, type: 'grievance', direction: 'inbound' });
    await addInvoice(troubled, { dueDaysAgo: 70, balanceMinor: 2_360_000 });

    const a = await scoreClient(TENANT, healthy, { persist: false });
    const b = await scoreClient(TENANT, troubled, { persist: false });

    assert.ok(a.health > b.health, `healthy ${a.health} should beat troubled ${b.health}`);
    assert.ok(a.health >= 0 && a.health <= 100);
    assert.ok(b.health >= 0 && b.health <= 100);
  });

  test('a weak client is flagged as a retention risk', async () => {
    const weak = await makeClient({ name: 'At risk', satisfaction: 1, scope_delivered: 1, scope_total: 10 });
    await addInvoice(weak, { dueDaysAgo: 95, balanceMinor: 5_000_000 });
    await addActivity(weak, { daysAgo: 3, type: 'grievance', direction: 'inbound' });

    const s = await scoreClient(TENANT, weak, { persist: true });
    assert.equal(s.retention_risk, 1);

    const stored = await db.get('SELECT retention_risk, health_score FROM clients WHERE id = ?', [weak]);
    assert.equal(stored.retention_risk, 1, 'the flag is persisted for the dashboard to read');
    assert.equal(stored.health_score, s.health);
  });

  test('every score stays inside 0-100', async () => {
    const extreme = await makeClient({
      name: 'Extreme', satisfaction: 1, scope_delivered: 0, scope_total: 100,
      mrr_minor: 99_999_999, stage_entered_at: addDays(new Date(), -3000).toISOString(),
    });
    for (let i = 0; i < 12; i++) await addInvoice(extreme, { dueDaysAgo: 200 + i, balanceMinor: 9_999_999 });
    for (let i = 0; i < 8; i++) await addActivity(extreme, { daysAgo: i + 1, type: 'grievance', direction: 'inbound' });

    const s = await scoreClient(TENANT, extreme, { persist: false });
    for (const key of ['conversion', 'risk', 'relevancy', 'retention', 'health']) {
      assert.ok(s[key] >= 0 && s[key] <= 100, `${key} out of range: ${s[key]}`);
    }
  });

  test('a manual adjustment moves the score and is reported in the breakdown', async () => {
    const client = await makeClient({ name: 'Adjusted', industry: 'aviation' });
    const before = await scoreClient(TENANT, client, { persist: false });

    await db.run(
      `INSERT INTO score_adjustments (id, tenant_id, client_id, score_type, delta, reason_code_id, created_at)
       VALUES (?,?,?, 'relevancy', 20, ?, ?)`,
      [uuid(), TENANT, client, riskReason, nowIso()],
    );

    const after = await scoreClient(TENANT, client, { persist: false });
    assert.ok(after.relevancy > before.relevancy);
    assert.equal(after.breakdown.adjustments.length, 1);
    assert.equal(after.breakdown.adjustments[0].code, 'STRATEGIC',
      'the reason code travels with the adjustment so it can be explained later');
  });

  test('an expired adjustment stops being applied', async () => {
    const client = await makeClient({ name: 'Expired adjustment', industry: 'aviation' });
    await db.run(
      `INSERT INTO score_adjustments (id, tenant_id, client_id, score_type, delta, reason_code_id, expires_at, created_at)
       VALUES (?,?,?, 'relevancy', 25, ?, ?, ?)`,
      [uuid(), TENANT, client, riskReason, addDays(new Date(), -1).toISOString(), nowIso()],
    );

    const s = await scoreClient(TENANT, client, { persist: false });
    assert.equal(s.breakdown.adjustments.length, 0);
  });

  test('a snapshot is written so the trend chart has history', async () => {
    const client = await makeClient({ name: 'Snapshotted' });
    await scoreClient(TENANT, client, { persist: true, snapshot: true });

    const row = await db.get(
      'SELECT * FROM client_score_history WHERE client_id = ? AND snapshot_date = ?',
      [client, todayIso()],
    );
    assert.ok(row, 'a history row exists for today');
    assert.ok(row.health >= 0);

    // Re-running the same day must update, not duplicate.
    await scoreClient(TENANT, client, { persist: true, snapshot: true });
    const count = await db.get(
      'SELECT COUNT(*) AS n FROM client_score_history WHERE client_id = ? AND snapshot_date = ?',
      [client, todayIso()],
    );
    assert.equal(Number(count.n), 1);
  });

  test('scoring the whole tenant skips lost clients and returns a count', async () => {
    await makeClient({ name: 'Lost one', status: 'lost' });
    const total = await db.get("SELECT COUNT(*) AS n FROM clients WHERE tenant_id = ? AND status != 'lost'", [TENANT]);
    const scored = await scoreAllClients(TENANT, { snapshot: false });
    assert.equal(scored, Number(total.n));
  });

  test('scoring never leaks across tenants', async () => {
    await db.run(`INSERT INTO tenants (id, name, slug, created_at, updated_at) VALUES ('other-scoring', 'Other', 'other-scoring', ?, ?)`,
      [nowIso(), nowIso()]);
    const mine = await makeClient({ name: 'Mine' });

    const wrongTenant = await scoreClient('other-scoring', mine, { persist: false });
    assert.equal(wrongTenant, null, 'a client is invisible to a different tenant');
  });
});
