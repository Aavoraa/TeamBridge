import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Reset Co', email: 'owner@reset.test' });
const ownerAuth = { token: owner.access_token };
const ownerId = (await api.get('/auth/me', ownerAuth)).body.data.user.id;

async function join(name, email, role, extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, ownerAuth);
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const acc = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Main Road',
  });
  return { id: invite.body.data.id, email, auth: { token: acc.body.data.access_token } };
}

let hr; let mgr; let report; let stranger; let hr2;
before(async () => {
  hr = await join('Hema', 'hema@reset.test', 'hr');
  hr2 = await join('Hari', 'hari@reset.test', 'hr');
  mgr = await join('Mani', 'mani@reset.test', 'manager');
  report = await join('Ravi', 'ravi@reset.test', 'employee', { manager_id: mgr.id });
  stranger = await join('Sita', 'sita@reset.test', 'employee');
});

const reset = (id, auth) => api.post(`/users/${id}/reset-password`, {}, auth);
const signsIn = async (email, password) => (await api.post('/auth/login', { email, password })).status === 200;

test('a reset hands out a temporary password that works, and the old one stops working', async () => {
  const res = await reset(stranger.id, hr.auth);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.ok(await signsIn(stranger.email, res.body.data.temporary_password));
  assert.equal(await signsIn(stranger.email, 'Password@123'), false);
});

test('the owner resets anyone; HR resets anyone but the owner', async () => {
  assert.equal((await reset(hr.id, ownerAuth)).status, 200);
  assert.equal((await reset(mgr.id, hr2.auth)).status, 200);
  assert.equal((await reset(ownerId, hr2.auth)).status, 403, 'HR can never take over the owner account');
});

test('a manager resets only the people who report to them', async () => {
  // Earlier resets signed the manager out; sign back in with a fresh password.
  const temp = (await reset(mgr.id, ownerAuth)).body.data.temporary_password;
  const mAuth = { token: (await api.post('/auth/login', { email: mgr.email, password: temp })).body.data.access_token };
  assert.equal((await reset(report.id, mAuth)).status, 200);
  assert.equal((await reset(stranger.id, mAuth)).status, 403);
  assert.equal((await reset(hr2.id, mAuth)).status, 403);
  assert.equal((await reset(ownerId, mAuth)).status, 403);
  const view = await api.get(`/users/${report.id}`, mAuth);
  assert.equal(view.body.data.can_reset_password, true);
  assert.equal((await api.get(`/users/${stranger.id}`, mAuth)).body.data.can_reset_password, false);
});

test('employees reset nobody, and nobody resets their own password here', async () => {
  const temp = (await reset(report.id, ownerAuth)).body.data.temporary_password;
  const eAuth = { token: (await api.post('/auth/login', { email: report.email, password: temp })).body.data.access_token };
  assert.equal((await reset(stranger.id, eAuth)).status, 403);
  assert.equal((await reset(ownerId, ownerAuth)).status, 400, 'their own goes through the profile');
});
