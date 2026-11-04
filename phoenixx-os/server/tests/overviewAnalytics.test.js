import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Analytics Co', email: 'owner@an.test', owner_name: 'Arun Prakash' });
async function join(name, email, role) {
  const invite = await api.post('/users', { name, email, role }, { token: owner.access_token });
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

const DAY = 86_400_000;
const ago = (d) => new Date(Date.now() - d * DAY).toISOString();
let tenant; let employee;

before(async () => {
  employee = await join('Priya Raman', 'priya@an.test', 'employee');
  tenant = (await db.get('SELECT tenant_id FROM users WHERE id = ?', [employee.user.id])).tenant_id;
  const stages = Object.fromEntries((await db.all('SELECT code, id FROM pipeline_stages WHERE tenant_id = ?', [tenant])).map((s) => [s.code, s.id]));
  const ts = new Date().toISOString();
  const client = async (name, status, stage, deal = 0, created = ts) => {
    const id = crypto.randomUUID();
    await db.run(`INSERT INTO clients (id, tenant_id, name, status, stage_id, deal_value_minor, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
      [id, tenant, name, status, stages[stage] || null, deal, created, ts]);
    return id;
  };
  // Five leads at different steps, two won clients.
  await client('Lead A', 'lead', 'outreach', 100_000_00);
  await client('Lead B', 'lead', 'pitch', 200_000_00);
  const c = await client('Lead C', 'lead', 'proposal', 300_000_00);
  const won = await client('Won D', 'active', 'execution');
  await client('Won E', 'active', 'retention', 0, ago(40)); // became a lead 40 days ago

  // Proposals: two sent this month, one accepted; one sent last month, none accepted.
  const prop = async (clientId, sent, accepted) => db.run(
    `INSERT INTO proposals (id, tenant_id, client_id, number, title, status, sent_at, accepted_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [crypto.randomUUID(), tenant, clientId, `P-${crypto.randomUUID().slice(0, 6)}`, 'Proposal', accepted ? 'accepted' : 'sent', sent, accepted, ts, ts],
  );
  await prop(c, ago(5), null);
  await prop(won, ago(10), ago(8));
  await prop(won, ago(45), null);

  // Payments: 30,000 this month (one in USD at 80), 10,000 last month.
  const invoice = async (rate) => {
    const id = crypto.randomUUID();
    await db.run(
      `INSERT INTO invoices (id, tenant_id, client_id, number, seq, fy, status, issue_date, due_date, exchange_rate, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'paid',?,?,?,?,?)`,
      [id, tenant, won, `INV-${crypto.randomUUID().slice(0, 6)}`, 1, '2026-27', ts.slice(0, 10), ts.slice(0, 10), rate, ts, ts],
    );
    return id;
  };
  const inr = await invoice(1);
  const usd = await invoice(80);
  const pay = (inv, amount, at) => db.run(
    'INSERT INTO payments (id, tenant_id, invoice_id, client_id, amount_minor, paid_at, created_at) VALUES (?,?,?,?,?,?,?)',
    [crypto.randomUUID(), tenant, inv, won, amount, at, ts],
  );
  await pay(inr, 20_000_00, ago(3));
  await pay(usd, 125_00, ago(6)); // $125 x 80 = 10,000
  await pay(inr, 10_000_00, ago(40));
});

const get = (token, range = '1M') => api.get(`/dashboard/overview-analytics?range=${range}`, { token });

describe('the owner', () => {
  test('revenue, conversion, leads and pipeline, compared with the 30 days before', async () => {
    const res = await get(owner.access_token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.equal(d.revenue.value, 30_000_00, 'INR plus USD converted at the invoice rate');
    assert.equal(d.revenue.previous, 10_000_00);
    assert.equal(d.revenue.change, 200);
    assert.equal(d.conversion.value, 50, 'one of two proposals sent this month was accepted');
    assert.equal(d.conversion.previous, 0);
    assert.equal(d.leads.value, 3, 'open leads');
    assert.equal(d.pipeline.value, 600_000_00, 'their deal values');
    assert.equal(d.pipeline.deals, 3);
  });

  test('the funnel narrows step by step and ends in the conversion rate', async () => {
    const f = (await get(owner.access_token)).body.data.funnel;
    const v = Object.fromEntries(f.steps.map((s) => [s.key, s.value]));
    assert.deepEqual(v, { total: 5, qualified: 4, proposals: 3, negotiations: 2, closed: 2 });
    for (let i = 1; i < f.steps.length; i++) assert.ok(f.steps[i].value <= f.steps[i - 1].value, 'each bar contains the next');
    assert.equal(f.conversion, 40);
  });

  test('the chart has this period and the one before, bucket for bucket, for each range', async () => {
    for (const [range, n] of [['1M', 30], ['3M', 13], ['6M', 6], ['1Y', 12]]) {
      const s = (await get(owner.access_token, range)).body.data.series;
      assert.equal(s.points.length, n, range);
      assert.ok(s.points.every((p) => typeof p.current === 'number' && typeof p.previous === 'number'));
    }
    const month = (await get(owner.access_token, '1M')).body.data.series;
    assert.equal(month.total, 30_000_00);
    assert.equal(month.previous_total, 10_000_00);
    assert.equal((await get(owner.access_token, 'nonsense')).body.data.range, '1M');
  });
});

describe('each block follows the existing permissions', () => {
  test('an employee sees no revenue (no invoice access), and CRM figures only because they may open the CRM', async () => {
    const me = (await api.get('/auth/me', { token: employee.token })).body.data;
    const can = (m) => !!me.permissions?.[m]?.includes('view');
    const d = (await get(employee.token)).body.data;
    assert.equal(can('invoices'), false);
    assert.equal(d.revenue, null);
    assert.equal(d.series, null, 'no revenue chart either');
    assert.equal(d.leads !== null, can('crm'));
    assert.equal(d.funnel !== null, can('crm'));
    assert.equal(d.conversion !== null, can('proposals'));
  });

  test('a finance login with invoices but no CRM sees revenue and no pipeline', async () => {
    const fin = await join('Meera Iyer', 'meera@an.test', 'finance');
    const me = (await api.get('/auth/me', { token: fin.token })).body.data;
    const d = (await get(fin.token)).body.data;
    assert.equal(d.revenue !== null, !!me.permissions?.invoices?.includes('view'));
    assert.equal(d.leads !== null, !!me.permissions?.crm?.includes('view'));
  });
});
