import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Policy Co', email: 'owner@policy.test', owner_name: 'Dev Owner' });
const ownerAuth = { token: owner.access_token };
const invite = await api.post('/users', { name: 'Kavya Casual', email: 'kavya@policy.test', role: 'employee' }, ownerAuth);
assert.equal(invite.status, 201, JSON.stringify(invite.body));
const kavya = invite.body.data;
const tenantId = (await db.get('SELECT tenant_id FROM users WHERE id = ?', [kavya.id])).tenant_id;
const typeId = async (code) => (await db.get('SELECT id FROM leave_types WHERE tenant_id = ? AND code = ?', [tenantId, code])).id;

const ts = new Date().toISOString();
const approve = async (code, from, to, days, extra = {}) => db.run(
  `INSERT INTO leave_requests (id, tenant_id, user_id, leave_type_id, kind, from_date, to_date, from_time, to_time,
     days, reason, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  [crypto.randomUUID(), tenantId, kavya.id, await typeId(code), extra.kind || 'leave', from, to,
    extra.from_time ?? null, extra.to_time ?? null, days, 'Away', 'approved', ts, ts],
);

// June 2030: casual leave on Tue 4th, Wed 5th and Thu 6th; a 90-minute permission on the 10th.
await approve('CL', '2030-06-04', '2030-06-06', 3);
await approve('PERM', '2030-06-10', '2030-06-10', 0.25, { kind: 'permission', from_time: '10:00', to_time: '11:30' });

const balances = async (month) => {
  const r = await api.get(`/hr/leave/balances?month=${month}&user_id=${kavya.id}`, ownerAuth);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return Object.fromEntries(r.body.data.map((b) => [b.code, b]));
};

test('only casual leave, loss of pay and hourly permission are offered', async () => {
  const types = (await api.get('/hr/leave/types', ownerAuth)).body.data.map((t) => t.code).sort();
  assert.deepEqual(types, ['CL', 'LOP', 'PERM']);
  assert.deepEqual(Object.keys(await balances('2030-06')).sort(), ['CL', 'LOP', 'PERM']);
});

test('casual leave is one day a month; days past it are loss of pay', async () => {
  const b = await balances('2030-06');
  assert.deepEqual([b.CL.entitled, b.CL.used, b.CL.available, b.CL.period], [1, 1, 0, 'month']);
  assert.deepEqual([b.LOP.used, b.LOP.counts_up], [2, true]);

  const july = await balances('2030-07');
  assert.deepEqual([july.CL.available, july.LOP.used], [1, 0], 'a new month starts fresh');
});

test('hourly permission is two hours a month', async () => {
  const b = await balances('2030-06');
  assert.deepEqual([b.PERM.unit, b.PERM.entitled, b.PERM.used, b.PERM.available], ['hours', 2, 1.5, 0.5]);
  assert.equal((await balances('2030-07')).PERM.available, 2);
});

test('the register marks casual leave past the month\'s allowance as unpaid', async () => {
  const r = await api.get(`/hr/attendance/register?month=2030-06&user_id=${kavya.id}`, ownerAuth);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const cells = r.body.data.rows[0].cells;
  const paid = (d) => cells.find((c) => c.date === d).paid;
  assert.deepEqual([paid('2030-06-04'), paid('2030-06-05'), paid('2030-06-06')], [true, false, false]);
  assert.equal(r.body.data.rows[0].summary.unpaid_leave, 2);
});
