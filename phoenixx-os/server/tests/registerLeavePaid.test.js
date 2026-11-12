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

const owner = await signUpTenant(api, { agency_name: 'Pay Co', email: 'owner@pay.test', owner_name: 'Dev Owner' });
const ownerAuth = { token: owner.access_token };
const invite = await api.post('/users', { name: 'Lata Leave', email: 'lata@pay.test', role: 'employee' }, ownerAuth);
assert.equal(invite.status, 201, JSON.stringify(invite.body));
const lata = invite.body.data;
const tenantId = (await db.get('SELECT tenant_id FROM users WHERE id = ?', [lata.id])).tenant_id;

const paidType = await db.get('SELECT id, name FROM leave_types WHERE tenant_id = ? AND paid = 1 LIMIT 1', [tenantId]);
const lopType = await db.get("SELECT id, name FROM leave_types WHERE tenant_id = ? AND paid = 0 LIMIT 1", [tenantId]);
const ts = new Date().toISOString();
const approve = (typeId, from, to) => db.run(
  `INSERT INTO leave_requests (id, tenant_id, user_id, leave_type_id, from_date, to_date, days, reason, status, created_at, updated_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [crypto.randomUUID(), tenantId, lata.id, typeId, from, to, 1, 'Away', 'approved', ts, ts],
);
// 2030-04-02 and 2030-04-03 are a Tuesday and a Wednesday.
await approve(paidType.id, '2030-04-02', '2030-04-02');
await approve(lopType.id, '2030-04-03', '2030-04-03');

const register = (q = '') => api.get(`/hr/attendance/register?month=2030-04&user_id=${lata.id}${q}`, ownerAuth);

test('approved leave says whether it is paid or loss of pay', async () => {
  assert.ok(paidType && lopType, 'the workspace starts with a paid leave type and a loss-of-pay one');
  const r = await register();
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const row = r.body.data.rows[0];
  const day = (d) => row.cells.find((c) => c.date === d);
  assert.deepEqual([day('2030-04-02').status, day('2030-04-02').paid, day('2030-04-02').leave_type], ['leave', true, paidType.name]);
  assert.deepEqual([day('2030-04-03').status, day('2030-04-03').paid, day('2030-04-03').leave_type], ['leave', false, lopType.name]);
  assert.equal(row.summary.leave, 2);
  assert.equal(row.summary.paid_leave, 1);
  assert.equal(row.summary.unpaid_leave, 1);
});

test('the register can be filtered to paid or unpaid leave', async () => {
  assert.equal((await register('&status=unpaid_leave')).body.data.rows.length, 1);
  assert.equal((await register('&status=paid_leave')).body.data.rows.length, 1);
  await db.run('DELETE FROM leave_requests WHERE leave_type_id = ?', [lopType.id]);
  assert.equal((await register('&status=unpaid_leave')).body.data.rows.length, 0, 'no unpaid leave left');
  assert.equal((await register('&status=paid_leave')).body.data.rows.length, 1);
});

test('HR can give unpaid leave a colour of its own', async () => {
  const r = await api.put('/hr/attendance-colors', { colors: { leave: '#16a34a', unpaid_leave: '#b91c1c' } }, ownerAuth);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.colors, { leave: '#16a34a', unpaid_leave: '#b91c1c' });
});
