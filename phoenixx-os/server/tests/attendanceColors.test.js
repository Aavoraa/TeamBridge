import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Colour Co', email: 'owner@colour.test', owner_name: 'Dev Owner' });
const ownerAuth = { token: owner.access_token };
async function join(name, email, role) {
  const invite = await api.post('/users', { name, email, role }, ownerAuth);
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const ok = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Main Road',
  });
  return { token: ok.body.data.access_token };
}
const hr = await join('Hema HR', 'hema@colour.test', 'hr');
const manager = await join('Mani Manager', 'mani@colour.test', 'manager');
const employee = await join('Esha Employee', 'esha@colour.test', 'employee');

test('nothing is saved at first; everyone gets the built-in colours', async () => {
  const r = await api.get('/hr/attendance-colors', employee);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.colors, {});
  assert.equal(r.body.data.can_edit, false);
  assert.equal((await api.get('/hr/attendance-colors', hr)).body.data.can_edit, true);
});

test('HR sets colours and everyone sees them', async () => {
  const r = await api.put('/hr/attendance-colors', { colors: { present: '#22C55E', leave: '#0EA5E9' } }, hr);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.deepEqual(r.body.data.colors, { present: '#22c55e', leave: '#0ea5e9' });
  const seen = await api.get('/hr/attendance-colors', employee);
  assert.deepEqual(seen.body.data.colors, { present: '#22c55e', leave: '#0ea5e9' });
});

test('a change touches only the colours named; null goes back to the default', async () => {
  const r = await api.put('/hr/attendance-colors', { colors: { leave: null, holiday: '#a855f7' } }, hr);
  assert.deepEqual(r.body.data.colors, { present: '#22c55e', holiday: '#a855f7' });
});

test('only HR (or the owner) can change them', async () => {
  for (const who of [employee, manager]) {
    assert.equal((await api.put('/hr/attendance-colors', { colors: { present: '#000000' } }, who)).status, 403);
  }
  assert.equal((await api.put('/hr/attendance-colors', { colors: { absent: '#ef4444' } }, ownerAuth)).status, 200);
});

test('bad colours and unknown statuses are refused', async () => {
  assert.equal((await api.put('/hr/attendance-colors', { colors: { present: 'red' } }, hr)).status, 422);
  assert.equal((await api.put('/hr/attendance-colors', { colors: { present: 'url(x)' } }, hr)).status, 422);
  assert.equal((await api.put('/hr/attendance-colors', { colors: { party: '#123456' } }, hr)).status, 422);
});
