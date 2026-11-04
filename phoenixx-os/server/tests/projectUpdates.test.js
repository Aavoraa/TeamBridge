import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Pulse Agency', email: 'owner@pulse.test' });
const ownerToken = owner.access_token;
const tenantId = owner.tenant?.id ?? (await db.get('SELECT tenant_id FROM users WHERE email = ?', ['owner@pulse.test'])).tenant_id;
const ownerId = (await db.get('SELECT id FROM users WHERE email = ?', ['owner@pulse.test'])).id;

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

const client = (await api.post('/crm/clients', { name: 'Cosmic Dynamic' }, { token: ownerToken })).body.data;
const settle = () => new Promise((r) => setTimeout(r, 60));
const inbox = async (userId, eventKey) => await db.all(
  'SELECT * FROM notifications WHERE user_id = ? AND event_key = ? ORDER BY created_at', [userId, eventKey]);

let divya; // manager role - project manager, also an eligible owner
let karthik; // manager role - a second owner
let ajith; // employee - team lead, files updates
let priya; // employee - ordinary member, may not file
let project;

const good = {
  todays_work: 'Backend API integration',
  completed_today: 'API authentication completed',
  tomorrow_plan: 'Frontend API integration',
  progress_pct: 75,
  status: 'on_track',
};

before(async () => {
  divya = await join('Divya', 'divya@pulse.test', 'manager');
  karthik = await join('Karthik', 'karthik@pulse.test', 'manager');
  ajith = await join('Ajith', 'ajith@pulse.test');
  priya = await join('Priya', 'priya@pulse.test');

  const res = await api.post('/projects', {
    client_id: client.id, name: 'Cosmic Dynamic Website',
    manager_id: divya.user.id, lead_id: ajith.user.id,
    owner_ids: [ownerId, karthik.user.id],
  }, { token: ownerToken });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  project = res.body.data;
  await api.post(`/projects/${project.id}/members`, { user_id: priya.user.id, seat: 'member' }, { token: ownerToken });
  // Whatever weekday the suite runs on, it is a working day for these tests.
  await db.run("UPDATE tenants SET week_off_days = '[9]' WHERE id = ?", [tenantId]);
});

describe('project owners', () => {
  test('a project can have several owners, shown on the list and the detail', async () => {
    const detail = (await api.get(`/projects/${project.id}`, { token: ownerToken })).body.data;
    assert.deepEqual(detail.owners.map((o) => o.name).sort(), ['Karthik', 'Test Owner']);
    const list = (await api.get('/projects', { token: ownerToken })).body.data;
    assert.equal(list.find((p) => p.id === project.id).owners.length, 2);
  });

  test('with no owners named, the creator owns the project', async () => {
    const res = await api.post('/projects', { client_id: client.id, name: 'Default owned' }, { token: divya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const owners = (await api.get(`/projects/${res.body.data.id}/owners`, { token: divya.token })).body.data;
    assert.deepEqual(owners.map((o) => o.user_id), [divya.user.id]);
  });

  test('only workspace Owners and Managers can be owners', async () => {
    const res = await api.put(`/projects/${project.id}/owners`, { user_ids: [ownerId, priya.user.id] }, { token: ownerToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Owners and Managers/);
  });

  test('the last owner cannot be removed', async () => {
    const res = await api.put(`/projects/${project.id}/owners`, { user_ids: [] }, { token: ownerToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /at least one owner/);
  });

  test('owners can be replaced as a set, and filtered on', async () => {
    let res = await api.put(`/projects/${project.id}/owners`, { user_ids: [karthik.user.id, divya.user.id] }, { token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.length, 2);
    const mine = (await api.get(`/projects?owner_id=${divya.user.id}`, { token: ownerToken })).body.data;
    assert.ok(mine.some((p) => p.id === project.id));
    res = await api.put(`/projects/${project.id}/owners`, { user_ids: [ownerId, karthik.user.id] }, { token: ownerToken });
    assert.equal(res.status, 200);
  });

  test('an employee cannot change the owners', async () => {
    const res = await api.put(`/projects/${project.id}/owners`, { user_ids: [ownerId] }, { token: priya.token });
    assert.equal(res.status, 403);
  });

  test('projects written without owners are given one on migrate', async () => {
    const pid = crypto.randomUUID();
    const at = new Date().toISOString();
    await db.run(`INSERT INTO projects (id, tenant_id, client_id, name, manager_id, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?)`, [pid, tenantId, client.id, 'Legacy', divya.user.id, at, at]);
    await db.backfillProjectOwners();
    const owners = await db.all('SELECT user_id FROM project_owners WHERE project_id = ?', [pid]);
    assert.deepEqual(owners.map((o) => o.user_id), [divya.user.id]);
  });
});

describe('filing the daily project update', () => {
  test('only the manager and the lead may file', async () => {
    const res = await api.post(`/projects/${project.id}/updates`, good, { token: priya.token });
    assert.equal(res.status, 403);
    const asOwner = await api.post(`/projects/${project.id}/updates`, good, { token: ownerToken });
    assert.equal(asOwner.status, 403);
  });

  test('the lead files, and every owner hears about it in-app', async () => {
    const res = await api.post(`/projects/${project.id}/updates`, good, { token: ajith.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.seat, 'lead');
    assert.equal(res.body.data.progress_pct, 75);
    await settle();
    for (const uid of [ownerId, karthik.user.id]) {
      const notes = await inbox(uid, 'project.update_filed');
      assert.equal(notes.length, 1);
      assert.equal(notes[0].channel, 'in_app');
    }
  });

  test('filing again the same day tops up the one update', async () => {
    const res = await api.post(`/projects/${project.id}/updates`, { status: 'on_track', progress_pct: 78 }, { token: ajith.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.progress_pct, 78);
    assert.equal(res.body.data.todays_work, good.todays_work, 'omitted fields are kept');
    const rows = await db.all('SELECT id FROM project_updates WHERE project_id = ? AND user_id = ?', [project.id, ajith.user.id]);
    assert.equal(rows.length, 1);
    await settle();
    assert.equal((await inbox(ownerId, 'project.update_filed')).length, 1, 'no second notice for an edit');
  });

  test('an update has to say what was worked on', async () => {
    const res = await api.post(`/projects/${project.id}/updates`, { status: 'on_track' }, { token: divya.token });
    assert.equal(res.status, 400);
  });

  test('a blocker needs its type and description, and blocked needs a blocker', async () => {
    let res = await api.post(`/projects/${project.id}/updates`, { ...good, has_blocker: true }, { token: divya.token });
    assert.equal(res.status, 400);
    res = await api.post(`/projects/${project.id}/updates`, { ...good, status: 'blocked' }, { token: divya.token });
    assert.equal(res.status, 400);
  });

  test('a blocked update is sent to the owners as its own flagged notice', async () => {
    const res = await api.post(`/projects/${project.id}/updates`, {
      ...good,
      status: 'blocked',
      has_blocker: true,
      blocker_type: 'technical',
      blocker_description: 'API response format mismatch',
      help_required: 'Need backend developer review',
      estimated_delay_days: 1,
    }, { token: ajith.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.has_blocker, true);
    await settle();
    const flags = await inbox(karthik.user.id, 'project.update_flagged');
    assert.equal(flags.length, 1);
    assert.match(flags[0].body, /API response format mismatch/);
    assert.match(flags[0].body, /Need backend developer review/);
  });

  test('clearing the blocker clears its detail', async () => {
    const res = await api.post(`/projects/${project.id}/updates`, { status: 'at_risk', has_blocker: false }, { token: ajith.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.blocker_description, null);
    assert.equal(res.body.data.blocker_type, null);
  });

  test('a future day is refused', async () => {
    const res = await api.post(`/projects/${project.id}/updates`, { ...good, update_date: '2999-01-01' }, { token: ajith.token });
    assert.equal(res.status, 400);
  });
});

describe('reading the updates', () => {
  test('the owner feed shows status, both progress numbers and who has not filed', async () => {
    const res = await api.get('/projects/updates/feed', { token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.data.projects.find((p) => p.id === project.id);
    assert.equal(row.status_today, 'at_risk');
    assert.equal(row.reported_progress, 75, 'the blocked update re-sent 75%');
    assert.ok('pct' in row.tasks, 'task completion sits beside the self-reported figure');
    assert.deepEqual(row.missing.map((m) => m.name), ['Divya']);
    assert.equal(row.seats.length, 2);
    assert.ok(res.body.data.summary.at_risk >= 1);
  });

  test('mine=true narrows the feed to projects the caller owns', async () => {
    const res = await api.get('/projects/updates/feed?mine=true', { token: karthik.token });
    assert.deepEqual(res.body.data.projects.map((p) => p.id), [project.id]);
  });

  test('the lead sees the projects they file for, with today\'s update loaded', async () => {
    const res = await api.get('/projects/updates/to-file', { token: ajith.token });
    assert.equal(res.status, 200);
    const row = res.body.data.projects.find((p) => p.id === project.id);
    assert.equal(row.seat, 'lead');
    assert.equal(row.update.status, 'at_risk');
  });

  test('history is readable by the team and owners, not by outsiders', async () => {
    const outsider = await join('Rahul', 'rahul@pulse.test');
    assert.equal((await api.get(`/projects/${project.id}/updates`, { token: priya.token })).status, 200);
    assert.equal((await api.get(`/projects/${project.id}/updates`, { token: karthik.token })).status, 200);
    assert.equal((await api.get(`/projects/${project.id}/updates`, { token: outsider.token })).status, 403);
  });

  test('another workspace cannot see the project', async () => {
    const rival = await signUpTenant(api, { agency_name: 'Rival', email: 'owner@rival-pulse.test' });
    const res = await api.get(`/projects/${project.id}/updates`, { token: rival.access_token });
    assert.equal(res.status, 404);
  });
});

describe('the evening jobs', () => {
  test('the reminder reaches only the filer who has not filed today', async () => {
    const { projectUpdateReminder } = await import('../src/services/jobs.js');
    await projectUpdateReminder();
    assert.equal((await inbox(divya.user.id, 'project.update_due')).length, 1);
    assert.equal((await inbox(ajith.user.id, 'project.update_due')).length, 0);
    await projectUpdateReminder();
    assert.equal((await inbox(divya.user.id, 'project.update_due')).length, 1, 'deduped on the date');
  });

  test('each owner gets one digest of their projects', async () => {
    const { projectOwnerDigest } = await import('../src/services/jobs.js');
    await projectOwnerDigest();
    const notes = await inbox(karthik.user.id, 'project.digest');
    assert.equal(notes.length, 1);
    assert.equal(notes[0].channel, 'in_app');
    assert.match(notes[0].title, /1 at risk/);
    assert.match(notes[0].body, /1 of 2 updates filed/);
  });
});
