import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Delivery Agency', email: 'owner@delivery.test' });
const ownerToken = owner.access_token;

async function join(name, email, role = 'employee') {
  const invite = await api.post('/users', { name, email, role }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken,
    password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

const client = (await api.post('/crm/clients', { name: 'Acme Textiles' }, { token: ownerToken })).body.data;

let divya; // manager
let priya; // employee, on the project
let rahul; // employee, not on the project
let meera; // finance
let project;

before(async () => {
  divya = await join('Divya', 'divya@delivery.test', 'manager');
  priya = await join('Priya', 'priya@delivery.test');
  rahul = await join('Rahul', 'rahul@delivery.test');
  meera = await join('Meera', 'meera@delivery.test', 'finance');

  project = (await api.post('/projects',
    { client_id: client.id, name: 'Brand refresh', manager_id: divya.user.id }, { token: ownerToken })).body.data;
  await api.post(`/projects/${project.id}/members`,
    { user_id: priya.user.id, seat: 'senior' }, { token: ownerToken });
});

describe('an employee has read-only access to projects and teams', () => {
  test('they can list projects, open one, and see who is on the team', async () => {
    const list = await api.get('/projects', { token: priya.token });
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((p) => p.id === project.id));

    const detail = await api.get(`/projects/${project.id}`, { token: priya.token });
    assert.equal(detail.status, 200);
    assert.equal(detail.body.data.team.length, 2);

    assert.equal((await api.get('/projects/workload', { token: priya.token })).status, 200);
    assert.equal((await api.get(`/projects/${project.id}/members/export/csv`, { token: priya.token })).status, 200);
  });

  test('a project they are not associated with is invisible to them', async () => {
    const list = (await api.get('/projects', { token: rahul.token })).body.data;
    assert.ok(!list.some((p) => p.id === project.id));
    // Not found, not forbidden: they are not told it exists.
    assert.equal((await api.get(`/projects/${project.id}`, { token: rahul.token })).status, 404);
    assert.equal((await api.get(`/projects/${project.id}/members`, { token: rahul.token })).status, 404);
    assert.equal((await api.get(`/projects/${project.id}/members/export/csv`, { token: rahul.token })).status, 404);

    const workload = (await api.get('/projects/workload', { token: rahul.token })).body.data;
    assert.ok(workload.every((u) => u.projects.every((p) => p.project_id !== project.id)));

    const clientView = (await api.get(`/crm/clients/${client.id}`, { token: rahul.token })).body.data;
    assert.ok(!clientView.projects.some((p) => p.id === project.id));
  });

  test('they cannot create a project', async () => {
    const res = await api.post('/projects', { client_id: client.id, name: 'Side project' }, { token: priya.token });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  test('they cannot edit a project, even one they are staffed on', async () => {
    const res = await api.patch(`/projects/${project.id}`, { name: 'Renamed by an employee' }, { token: priya.token });
    assert.equal(res.status, 403);

    const unchanged = await api.get(`/projects/${project.id}`, { token: ownerToken });
    assert.equal(unchanged.body.data.name, 'Brand refresh');
  });

  test('they cannot delete a project', async () => {
    assert.equal((await api.del(`/projects/${project.id}`, { token: priya.token })).status, 403);
    assert.equal((await api.get(`/projects/${project.id}`, { token: ownerToken })).status, 200);
  });

  test('they cannot change the team - add, restaff or remove', async () => {
    const add = await api.post(`/projects/${project.id}/members`,
      { user_id: rahul.user.id, seat: 'member' }, { token: priya.token });
    assert.equal(add.status, 403);

    const bulk = await api.post(`/projects/${project.id}/members/bulk`,
      { members: [{ user_id: rahul.user.id }] }, { token: priya.token });
    assert.equal(bulk.status, 403);

    const team = (await api.get(`/projects/${project.id}/members`, { token: ownerToken })).body.data;
    const mine = team.find((m) => m.user_id === priya.user.id);

    // Not even promoting themselves out of their own seat.
    assert.equal((await api.patch(`/projects/${project.id}/members/${mine.id}`,
      { seat: 'manager' }, { token: priya.token })).status, 403);
    assert.equal((await api.del(`/projects/${project.id}/members/${mine.id}`, { token: priya.token })).status, 403);

    const after = (await api.get(`/projects/${project.id}/members`, { token: ownerToken })).body.data;
    assert.equal(after.length, 2, 'the team is exactly as it was');
    assert.equal(after.find((m) => m.user_id === priya.user.id).seat, 'senior');
  });

  test('the old /finance/projects mount enforces the same rules', async () => {
    // Both mounts are the same router, so a stale path is not a way round it.
    assert.equal((await api.get('/finance/projects', { token: priya.token })).status, 200);
    assert.equal((await api.post('/finance/projects',
      { client_id: client.id, name: 'Back door' }, { token: priya.token })).status, 403);
    assert.equal((await api.patch(`/finance/projects/${project.id}`,
      { name: 'Back door' }, { token: priya.token })).status, 403);
    assert.equal((await api.del(`/finance/projects/${project.id}`, { token: priya.token })).status, 403);
  });

  test('CRM write access does not carry over into projects', async () => {
    // An employee still runs their own pipeline - the two are separate modules
    // now, so tightening one must not have loosened or broken the other.
    const lead = await api.post('/crm/clients', { name: 'A lead of my own' }, { token: priya.token });
    assert.equal(lead.status, 201, JSON.stringify(lead.body));
    assert.equal((await api.patch(`/crm/clients/${lead.body.data.id}`,
      { name: 'Renamed lead' }, { token: priya.token })).status, 200);
  });
});

describe('managers and admins keep their project permissions', () => {
  test('a manager can create, edit, staff and close a project', async () => {
    const created = await api.post('/projects',
      { client_id: client.id, name: 'Performance retainer' }, { token: divya.token });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const p = created.body.data;

    assert.equal((await api.patch(`/projects/${p.id}`, { status: 'on_hold' }, { token: divya.token })).status, 200);

    const staffed = await api.post(`/projects/${p.id}/members`,
      { user_id: rahul.user.id, seat: 'lead', allocation_pct: 40 }, { token: divya.token });
    assert.equal(staffed.status, 201, JSON.stringify(staffed.body));

    const member = (await api.get(`/projects/${p.id}/members`, { token: divya.token })).body.data
      .find((m) => m.user_id === rahul.user.id);
    assert.equal((await api.patch(`/projects/${p.id}/members/${member.id}`,
      { seat: 'senior' }, { token: divya.token })).status, 200);
    assert.equal((await api.del(`/projects/${p.id}/members/${member.id}`, { token: divya.token })).status, 200);
    assert.equal((await api.del(`/projects/${p.id}`, { token: divya.token })).status, 200);
  });

  test('the workspace owner keeps full control', async () => {
    const p = (await api.post('/projects', { client_id: client.id, name: 'Owner project' },
      { token: ownerToken })).body.data;
    assert.equal((await api.patch(`/projects/${p.id}`, { budget_minor: 500000 }, { token: ownerToken })).status, 200);
    assert.equal((await api.del(`/projects/${p.id}`, { token: ownerToken })).status, 200);
  });

  test('a manager cannot delete a project they neither run nor own', async () => {
    const p = (await api.post('/projects', { client_id: client.id, name: 'Not Divya\'s' },
      { token: ownerToken })).body.data;
    const res = await api.del(`/projects/${p.id}`, { token: divya.token });
    // Refused either way: 404 where the project is not even visible to them, 403 where it is.
    assert.ok([403, 404].includes(res.status), JSON.stringify(res.body));
    assert.equal((await api.get(`/projects/${p.id}`, { token: ownerToken })).status, 200, 'still there');
    assert.equal((await api.del(`/projects/${p.id}`, { token: ownerToken })).status, 200);
  });

  test('finance can read projects for costing but not restructure them', async () => {
    assert.equal((await api.get('/projects', { token: meera.token })).status, 200);
    assert.equal((await api.post('/projects', { client_id: client.id, name: 'Finance project' },
      { token: meera.token })).status, 403);
    assert.equal((await api.patch(`/projects/${project.id}`, { name: 'Finance rename' },
      { token: meera.token })).status, 403);
  });

  test('the permission matrix reported to the client matches what the API enforces', async () => {
    const asEmployee = (await api.get('/auth/me', { token: priya.token })).body.data.permissions;
    assert.deepEqual(asEmployee.projects, ['view'], 'the UI is told read-only, and the API agrees');

    const asManager = (await api.get('/auth/me', { token: divya.token })).body.data.permissions;
    assert.ok(asManager.projects.includes('create'));
    assert.ok(asManager.projects.includes('edit'));
    assert.ok(asManager.projects.includes('delete'));
  });
});


describe('managers see only the projects they are associated with', () => {
  let other;
  let karthik;
  before(async () => {
    karthik = await join('Karthik', 'karthik@delivery.test', 'manager');
    other = (await api.post('/projects', { client_id: client.id, name: 'Not Divya\'s' }, { token: ownerToken })).body.data;
  });

  test('a manager sees the project they manage, not one they have nothing to do with', async () => {
    const list = (await api.get('/projects', { token: divya.token })).body.data.map((p) => p.id);
    assert.ok(list.includes(project.id));
    assert.ok(!list.includes(other.id));
    assert.equal((await api.get(`/projects/${other.id}`, { token: divya.token })).status, 404);
    assert.equal((await api.patch(`/projects/${other.id}`, { name: 'x' }, { token: divya.token })).status, 404);
  });

  test('being an owner is enough to see it, without a seat on the team', async () => {
    const res = await api.put(`/projects/${other.id}/owners`, { user_ids: [karthik.user.id] }, { token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const list = (await api.get('/projects', { token: karthik.token })).body.data.map((p) => p.id);
    assert.ok(list.includes(other.id));
    assert.equal((await api.get(`/projects/${other.id}`, { token: karthik.token })).status, 200);
  });

  test('the workspace Owner and finance still see every project', async () => {
    for (const token of [ownerToken, meera.token]) {
      const list = (await api.get('/projects', { token })).body.data.map((p) => p.id);
      assert.ok(list.includes(project.id) && list.includes(other.id));
    }
  });
});
