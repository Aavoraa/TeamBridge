import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Team View Co', email: 'owner@teamview.test' });
const ownerToken = owner.access_token;

async function join(name, email, role = 'employee', extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Main Road',
  });
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

let mgr; let other; let ravi; let sana; let outsider; let mine; let theirs;
before(async () => {
  mgr = await join('Meena Manager', 'meena@teamview.test', 'manager');
  other = await join('Omkar Manager', 'omkar@teamview.test', 'manager');
  ravi = await join('Ravi Report', 'ravi@teamview.test', 'employee', { manager_id: mgr.user.id });
  sana = await join('Sana Report', 'sana@teamview.test', 'employee', { manager_id: mgr.user.id });
  outsider = await join('Uma Outsider', 'uma@teamview.test', 'employee', { manager_id: other.user.id });
  mine = (await api.post('/projects', { client_name: 'Acme', name: 'Acme portal', manager_id: mgr.user.id, owner_ids: [owner.user.id] }, { token: ownerToken })).body.data;
  theirs = (await api.post('/projects', { client_name: 'Zen', name: 'Zen app', manager_id: other.user.id, owner_ids: [owner.user.id] }, { token: ownerToken })).body.data;
  await api.post(`/projects/${theirs.id}/members`, { user_id: sana.user.id, seat: 'member', allocation_pct: 40 }, { token: ownerToken });
  await api.post('/action-items', { title: 'Late thing', owner_id: ravi.user.id, due_date: '2020-01-01' }, { token: mgr.token });
});

test('a manager sees their reports, their projects and their workload', async () => {
  const res = await api.get('/projects/my-team', { token: mgr.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const { people, projects_i_run: runs, scope } = res.body.data;
  assert.equal(scope, 'reports');
  assert.deepEqual(people.map((p) => p.name), ['Ravi Report', 'Sana Report'], 'reports only, not other teams');
  const s = people.find((p) => p.name === 'Sana Report');
  assert.deepEqual(s.projects.map((p) => p.project_name), ['Zen app'], 'every project they are on, even ones run by someone else');
  assert.equal(s.allocation_pct, 40);
  const r = people.find((p) => p.name === 'Ravi Report');
  assert.equal(r.open_tasks, 1);
  assert.equal(r.overdue_tasks, 1);
  assert.deepEqual(runs.map((p) => p.name), ['Acme portal'], 'the projects they can staff');
});

test('a manager puts their report on a project they run', async () => {
  const res = await api.post(`/projects/${mine.id}/members`,
    { user_id: ravi.user.id, seat: 'lead', allocation_pct: 50, responsibility: 'Front end' }, { token: mgr.token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const after = (await api.get('/projects/my-team', { token: mgr.token })).body.data.people.find((p) => p.name === 'Ravi Report');
  assert.deepEqual(after.projects.map((p) => [p.project_name, p.seat, p.allocation_pct]), [['Acme portal', 'lead', 50]]);
});

test('but cannot change the team of a project someone else runs', async () => {
  // She sits on Zen as an ordinary member, so she can see it - but she does not run it.
  await api.post(`/projects/${theirs.id}/members`, { user_id: mgr.user.id, seat: 'member' }, { token: ownerToken });
  const res = await api.post(`/projects/${theirs.id}/members`, { user_id: ravi.user.id, seat: 'member' }, { token: mgr.token });
  assert.equal(res.status, 403);
  const member = (await api.get(`/projects/${theirs.id}/members`, { token: ownerToken })).body.data.find((m) => m.user_id === sana.user.id);
  assert.equal((await api.del(`/projects/${theirs.id}/members/${member.id}`, { token: mgr.token })).status, 403);
});

test('the owner sees everyone and can staff any project', async () => {
  const res = await api.get('/projects/my-team', { token: ownerToken });
  assert.equal(res.body.data.scope, 'everyone');
  assert.ok(res.body.data.people.some((p) => p.name === 'Uma Outsider'));
  assert.equal(res.body.data.projects_i_run.length, 2);
  assert.equal((await api.post(`/projects/${theirs.id}/members`, { user_id: outsider.user.id, seat: 'member' }, { token: ownerToken })).status, 201);
});

test('employees have no team to see', async () => {
  const res = await api.get('/projects/my-team', { token: ravi.token });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.people, []);
});
