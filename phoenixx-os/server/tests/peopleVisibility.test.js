import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'People Co', email: 'owner@people.test' });
const ownerAuth = { token: owner.access_token };

async function join(name, email, role, extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, ownerAuth);
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const acc = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Main Road',
  });
  return { id: invite.body.data.id, auth: { token: acc.body.data.access_token } };
}

let mgr; let mine; let other; let hr; let fin;
before(async () => {
  mgr = await join('Venkat', 'venkat@people.test', 'manager');
  mine = await join('Ruthresh', 'ruthresh@people.test', 'employee', { manager_id: mgr.id });
  other = await join('Priya', 'priya@people.test', 'employee');
  hr = await join('Hema', 'hema@people.test', 'hr');
  fin = await join('Meera', 'meera@people.test', 'finance');
});

test('an employee sees no colleague details: no team list, no profiles, no reporting structure', async () => {
  assert.equal((await api.get('/users', mine.auth)).status, 403);
  assert.equal((await api.get(`/users/${other.id}`, mine.auth)).status, 403);
  assert.equal((await api.get(`/users/${mgr.id}`, mine.auth)).status, 403, 'not even their manager');
  assert.equal((await api.get('/users/org/chart', mine.auth)).status, 403);
  assert.equal((await api.get('/users/export/csv', mine.auth)).status, 403);
  const perms = (await api.get('/auth/me', mine.auth)).body.data.permissions;
  assert.deepEqual(perms.employees, [], 'so the Team menu is hidden');
});

test('everyone still gets the plain name list that chat and pickers use, without phone numbers or pay', async () => {
  const dir = await api.get('/users/directory', mine.auth);
  assert.equal(dir.status, 200);
  assert.ok(dir.body.data.some((u) => u.id === other.id));
  for (const u of dir.body.data) {
    assert.equal(u.phone, undefined);
    assert.equal(u.monthly_cost_minor, undefined);
  }
});

test('a manager sees only themselves and their own people', async () => {
  const list = await api.get('/users', mgr.auth);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((u) => u.id).sort(), [mgr.id, mine.id].sort());
  assert.equal((await api.get(`/users/${mine.id}`, mgr.auth)).status, 200);
  assert.equal((await api.get(`/users/${other.id}`, mgr.auth)).status, 404);
  const chart = (await api.get('/users/org/chart', mgr.auth)).body.data;
  assert.equal(chart.length, 1);
  assert.equal(chart[0].id, mgr.id);
  assert.deepEqual(chart[0].reports.map((r) => r.id), [mine.id]);
});

test('the owner, HR and finance see the whole team', async () => {
  for (const who of [ownerAuth, hr.auth, fin.auth]) {
    const ids = (await api.get('/users', who)).body.data.map((u) => u.id);
    for (const id of [mgr.id, mine.id, other.id]) assert.ok(ids.includes(id));
    assert.equal((await api.get(`/users/${other.id}`, who)).status, 200);
  }
});
