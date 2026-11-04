import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const alpha = await signUpTenant(api, { agency_name: 'Team Agency', email: 'owner@team.test' });
const beta = await signUpTenant(api, { agency_name: 'Rival Agency', email: 'owner@rival.test' });
const token = alpha.access_token;
const betaToken = beta.access_token;

/** Invites someone and returns their user row. */
async function hire(name, role = 'employee') {
  const email = `${name.toLowerCase().replace(/\W+/g, '')}@team.test`;
  const res = await api.post('/users', { name, email, role }, { token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const client = (await api.post('/crm/clients', { name: 'Acme Textiles' }, { token })).body.data;

let divya, rahul, priya, vignesh;

before(async () => {
  divya = await hire('Divya', 'manager');
  rahul = await hire('Rahul');
  priya = await hire('Priya');
  vignesh = await hire('Vignesh');
});

const newProject = async (body = {}) => {
  const res = await api.post('/projects', { client_id: client.id, name: 'Brand refresh', ...body }, { token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

const teamOf = async (id) => (await api.get(`/projects/${id}/members`, { token })).body.data;
const seatOf = (team, userId) => team.find((m) => m.user_id === userId)?.seat;

describe('building a team for a project', () => {
  test('the manager and lead named at creation are seated on the team', async () => {
    const p = await newProject({ name: 'Launch programme', manager_id: divya.id, lead_id: rahul.id });

    const team = await teamOf(p.id);
    assert.equal(team.length, 2);
    assert.equal(seatOf(team, divya.id), 'manager');
    assert.equal(seatOf(team, rahul.id), 'lead');
    // The mirrored columns keep list views to a single query.
    assert.equal(p.manager_id, divya.id);
    assert.equal(p.lead_id, rahul.id);
  });

  test('members arrive with a seat, a responsibility and an allocation', async () => {
    const p = await newProject({ name: 'Website rebuild' });

    const res = await api.post(`/projects/${p.id}/members`, {
      user_id: priya.id, seat: 'senior', responsibility: 'Performance campaigns', allocation_pct: 40,
    }, { token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.seat, 'senior');
    assert.equal(res.body.data.responsibility, 'Performance campaigns');
    assert.equal(res.body.data.allocation_pct, 40);
    // The joined user is carried back so the UI can render a row immediately.
    assert.equal(res.body.data.name, 'Priya');
  });

  test('the team comes back ordered by seniority and grouped by seat', async () => {
    const p = await newProject({ name: 'Ordered team' });
    await api.post(`/projects/${p.id}/members`, { user_id: priya.id, seat: 'member' }, { token });
    await api.post(`/projects/${p.id}/members`, { user_id: vignesh.id, seat: 'senior' }, { token });
    await api.post(`/projects/${p.id}/members`, { user_id: divya.id, seat: 'manager' }, { token });
    await api.post(`/projects/${p.id}/members`, { user_id: rahul.id, seat: 'lead' }, { token });

    const detail = (await api.get(`/projects/${p.id}`, { token })).body.data;
    assert.deepEqual(detail.team.map((m) => m.seat), ['manager', 'lead', 'senior', 'member']);
    assert.deepEqual(detail.team_by_seat.map((g) => g.id), ['manager', 'lead', 'senior', 'member']);
    assert.equal(detail.team_size, 4);
  });

  test('adding someone twice moves them rather than duplicating them', async () => {
    const p = await newProject({ name: 'No duplicates' });
    await api.post(`/projects/${p.id}/members`, { user_id: priya.id, seat: 'member' }, { token });
    await api.post(`/projects/${p.id}/members`, { user_id: priya.id, seat: 'senior' }, { token });

    const team = await teamOf(p.id);
    assert.equal(team.length, 1);
    assert.equal(team[0].seat, 'senior');
  });

  test('several people can be staffed in one call', async () => {
    const p = await newProject({ name: 'Bulk staffing' });
    const res = await api.post(`/projects/${p.id}/members/bulk`, {
      members: [
        { user_id: divya.id, seat: 'manager' },
        { user_id: rahul.id, seat: 'lead', allocation_pct: 50 },
        { user_id: priya.id, seat: 'member', allocation_pct: 20 },
      ],
    }, { token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.length, 3);
  });
});

describe('single-holder seats', () => {
  test('naming a new lead moves the previous one to team member', async () => {
    const p = await newProject({ name: 'Lead handover', lead_id: rahul.id });
    await api.post(`/projects/${p.id}/members`, { user_id: vignesh.id, seat: 'lead' }, { token });

    const team = await teamOf(p.id);
    assert.equal(seatOf(team, vignesh.id), 'lead');
    // The outgoing lead stays on the team - they were not removed, only reseated.
    assert.equal(seatOf(team, rahul.id), 'member');
    assert.equal((await api.get(`/projects/${p.id}`, { token })).body.data.lead_id, vignesh.id);
  });

  test('patching the project manager seats them on the team too', async () => {
    const p = await newProject({ name: 'Manager by patch' });
    const res = await api.patch(`/projects/${p.id}`, { manager_id: divya.id }, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.equal(seatOf(await teamOf(p.id), divya.id), 'manager');
  });

  test('changing a seat through the member endpoint keeps the project column in step', async () => {
    const p = await newProject({ name: 'Seat swap', manager_id: divya.id });
    const member = (await teamOf(p.id)).find((m) => m.user_id === divya.id);

    await api.patch(`/projects/${p.id}/members/${member.id}`, { seat: 'observer' }, { token });
    assert.equal((await api.get(`/projects/${p.id}`, { token })).body.data.manager_id, null);
  });

  test('several people may hold non-exclusive seats', async () => {
    const p = await newProject({ name: 'Many seniors' });
    await api.post(`/projects/${p.id}/members`, { user_id: priya.id, seat: 'senior' }, { token });
    await api.post(`/projects/${p.id}/members`, { user_id: vignesh.id, seat: 'senior' }, { token });

    const team = await teamOf(p.id);
    assert.equal(team.filter((m) => m.seat === 'senior').length, 2);
  });
});

describe('taking someone off a team', () => {
  test('removal frees the seat and leaves the rest of the team alone', async () => {
    const p = await newProject({ name: 'Removal', manager_id: divya.id, lead_id: rahul.id });
    const member = (await teamOf(p.id)).find((m) => m.user_id === rahul.id);

    const res = await api.del(`/projects/${p.id}/members/${member.id}`, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const team = await teamOf(p.id);
    assert.equal(team.length, 1);
    assert.equal((await api.get(`/projects/${p.id}`, { token })).body.data.lead_id, null);
  });

  test('someone holding open work on the project cannot be removed by accident', async () => {
    const p = await newProject({ name: 'Open work' });
    await api.post(`/projects/${p.id}/members`, { user_id: priya.id, seat: 'member' }, { token });
    const member = (await teamOf(p.id)).find((m) => m.user_id === priya.id);

    const item = await api.post('/action-items', {
      title: 'Ship the campaign', owner_id: priya.id, client_id: client.id,
      // Tomorrow, deliberately: this test is about who may leave a project, and
      // a due date of today would drag the same-day time rule into it.
      project_id: p.id, due_date: new Date(Date.now() + 86_400_000).toISOString().slice(0, 10),
    }, { token });
    assert.equal(item.status, 201, JSON.stringify(item.body));

    const blocked = await api.del(`/projects/${p.id}/members/${member.id}`, { token });
    assert.equal(blocked.status, 409);

    const forced = await api.del(`/projects/${p.id}/members/${member.id}?force=true`, { token });
    assert.equal(forced.status, 200);
    assert.equal((await teamOf(p.id)).length, 0);
  });

  test('archiving a project takes its team with it', async () => {
    const p = await newProject({ name: 'Archived', manager_id: divya.id });
    await api.del(`/projects/${p.id}`, { token });

    assert.equal((await api.get(`/projects/${p.id}`, { token })).status, 404);
    const rows = await db.all('SELECT deleted_at FROM project_members WHERE project_id = ?', [p.id]);
    assert.ok(rows.every((r) => r.deleted_at));
  });
});

describe('staffing views', () => {
  test('people already on the team drop out of the available list', async () => {
    const p = await newProject({ name: 'Availability' });
    await api.post(`/projects/${p.id}/members`, { user_id: priya.id, seat: 'member' }, { token });

    const available = (await api.get(`/projects/${p.id}/available`, { token })).body.data;
    assert.ok(!available.some((u) => u.id === priya.id));
    assert.ok(available.some((u) => u.id === vignesh.id));
  });

  test('workload adds a person allocation up across every project they are on', async () => {
    // A fresh hire, so the total is not carried over from the other cases.
    const arjun = await hire('Arjun');
    const a = await newProject({ name: 'Workload A' });
    const b = await newProject({ name: 'Workload B' });
    await api.post(`/projects/${a.id}/members`, { user_id: arjun.id, seat: 'lead', allocation_pct: 60 }, { token });
    await api.post(`/projects/${b.id}/members`, { user_id: arjun.id, seat: 'senior', allocation_pct: 30 }, { token });

    const row = (await api.get('/projects/workload', { token })).body.data.find((u) => u.id === arjun.id);
    assert.equal(row.project_count, 2);
    assert.equal(row.allocation_pct, 90);
    assert.equal(row.leads, 1);
  });

  test('the list view carries a roster so faces can be shown without a second call', async () => {
    const p = await newProject({ name: 'Roster', manager_id: divya.id, lead_id: rahul.id });
    const row = (await api.get('/projects', { token })).body.data.find((x) => x.id === p.id);

    assert.equal(row.team_size, 2);
    assert.equal(row.manager_name, 'Divya');
    assert.equal(row.lead_name, 'Rahul');
    assert.deepEqual(row.team.map((m) => m.seat), ['manager', 'lead']);
  });

  test('the older /finance/projects path still answers', async () => {
    const res = await api.get('/finance/projects', { token });
    assert.equal(res.status, 200);
    assert.ok(Array.isArray(res.body.data));
  });
});

describe('boundaries', () => {
  test('someone from another workspace cannot be added to the team', async () => {
    const p = await newProject({ name: 'Cross tenant' });
    const outsider = (await api.get('/users/directory', { token: betaToken })).body.data[0];

    const res = await api.post(`/projects/${p.id}/members`, { user_id: outsider.id }, { token });
    assert.equal(res.status, 400);
  });

  test('another workspace cannot read the project or its team', async () => {
    const p = await newProject({ name: 'Private', manager_id: divya.id });

    assert.equal((await api.get(`/projects/${p.id}`, { token: betaToken })).status, 404);
    assert.equal((await api.get(`/projects/${p.id}/members`, { token: betaToken })).status, 404);
  });

  test('an unknown seat is rejected', async () => {
    const p = await newProject({ name: 'Bad seat' });
    const res = await api.post(`/projects/${p.id}/members`, { user_id: priya.id, seat: 'ceo' }, { token });
    assert.equal(res.status, 422);
  });
});
