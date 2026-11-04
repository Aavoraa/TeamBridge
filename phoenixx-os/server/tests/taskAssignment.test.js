import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Delivery Co', email: 'owner@delivery.test' });
const ownerToken = owner.access_token;

async function join(name, email, role = 'employee', extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: ownerToken });
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

// Daily updates are filed against the UTC day, which is what the server writes.
const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

// A due date, though, is a day on the workspace calendar - and a task due today
// has to name a time that has not gone by yet.
const WORKSPACE_TZ = 'Asia/Kolkata';
const workspaceNow = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: WORKSPACE_TZ,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).formatToParts(new Date()).reduce((a, p) => ({ ...a, [p.type]: p.value }), {});

const dueToday = () => {
  const p = workspaceNow();
  return `${p.year}-${p.month}-${p.day}`;
};

/** Half an hour from now on the workspace clock, without spilling into tomorrow. */
const laterToday = () => {
  const p = workspaceNow();
  const mins = Math.min((Number(p.hour) % 24) * 60 + Number(p.minute) + 30, 23 * 60 + 59);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

let divya; // manager
let priya; // reports to Divya
let rahul; // reports to Divya
let sundar; // reports to nobody — outside Divya's team
let client;
let project;

before(async () => {
  divya = await join('Divya', 'divya@delivery.test', 'manager');
  priya = await join('Priya', 'priya@delivery.test', 'employee', { manager_id: divya.user.id });
  rahul = await join('Rahul', 'rahul@delivery.test', 'employee', { manager_id: divya.user.id });
  sundar = await join('Sundar', 'sundar@delivery.test', 'employee');

  client = (await api.post('/crm/clients', { name: 'Cotton India' }, { token: ownerToken })).body.data;
  project = (await api.post('/projects',
    { client_id: client.id, name: 'Brand refresh', manager_id: divya.user.id }, { token: ownerToken })).body.data;
  await api.post(`/projects/${project.id}/members`, { user_id: priya.user.id, seat: 'senior' }, { token: ownerToken });
  await api.post(`/projects/${project.id}/members`, { user_id: rahul.user.id, seat: 'member' }, { token: ownerToken });
});

const newTask = async (body = {}, token = ownerToken) => {
  const res = await api.post('/action-items',
    { title: 'Send the August report to Cotton India', ...body }, { token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

const detail = (id, token) => api.get(`/action-items/${id}`, { token }).then((r) => r.body.data);

describe('task assignment', () => {
  test('a task names who is accountable and who raised it', async () => {
    const t = await newTask({ owner_id: priya.user.id });
    assert.equal(t.owner_id, priya.user.id);
    assert.equal(t.owner_name, 'Priya');
    assert.equal(t.created_by_name, 'Test Owner', 'the creator is carried on the row, not just the assignee');

    const d = await detail(t.id, ownerToken);
    assert.equal(d.assignees.length, 1);
    assert.equal(d.assignees[0].accountable, true);
    assert.equal(d.assignees[0].user_id, priya.user.id);
  });

  test('several people can be assigned, with exactly one accountable', async () => {
    const t = await newTask({ owner_id: priya.user.id, assignee_ids: [rahul.user.id, sundar.user.id] });
    const d = await detail(t.id, ownerToken);

    assert.equal(d.assignees.length, 3);
    assert.deepEqual(d.assignees.filter((a) => a.accountable).map((a) => a.user_id), [priya.user.id]);
    assert.equal(d.assignees[0].user_id, priya.user.id, 'the accountable person is listed first');
  });

  test('a project team can be staffed onto a task in one go', async () => {
    const t = await newTask({ assign_from_project_id: project.id, owner_id: rahul.user.id });
    const d = await detail(t.id, ownerToken);

    const ids = d.assignees.map((a) => a.user_id).sort();
    assert.deepEqual(ids, [divya.user.id, priya.user.id, rahul.user.id].sort(),
      'everyone seated on the project is on the task');
    assert.equal(d.assignees.find((a) => a.accountable).user_id, rahul.user.id);
    assert.equal(d.project_id, project.id, 'the task is filed against the project it was staffed from');
  });

  test('staffing from an empty project is refused rather than silently assigning nobody', async () => {
    const empty = (await api.post('/projects', { client_id: client.id, name: 'Not staffed yet' },
      { token: ownerToken })).body.data;
    // The named manager is seated automatically, so remove them to empty it.
    const members = (await api.get(`/projects/${empty.id}/members`, { token: ownerToken })).body.data;
    for (const m of members) await api.del(`/projects/${empty.id}/members/${m.id}`, { token: ownerToken });

    const res = await api.post('/action-items',
      { title: 'Goes nowhere', assign_from_project_id: empty.id }, { token: ownerToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /nobody( else)? on its team/i);
  });

  test('the accountable person is never duplicated in the extras', async () => {
    const t = await newTask({ owner_id: priya.user.id, assignee_ids: [priya.user.id, rahul.user.id] });
    const d = await detail(t.id, ownerToken);
    assert.equal(d.assignees.length, 2);
    assert.equal(d.assignees.filter((a) => a.user_id === priya.user.id).length, 1);
  });

  test('reassigning replaces the team, and handing over clears the old owner from the extras', async () => {
    const t = await newTask({ owner_id: priya.user.id, assignee_ids: [rahul.user.id] });

    await api.patch(`/action-items/${t.id}`, { assignee_ids: [sundar.user.id] }, { token: ownerToken });
    let d = await detail(t.id, ownerToken);
    assert.deepEqual(d.assignees.map((a) => a.user_id).sort(), [priya.user.id, sundar.user.id].sort());

    // Hand accountability to somebody already on the task.
    await api.patch(`/action-items/${t.id}`, { owner_id: sundar.user.id }, { token: ownerToken });
    d = await detail(t.id, ownerToken);
    assert.equal(d.assignees.find((a) => a.accountable).user_id, sundar.user.id);
    assert.equal(d.assignees.filter((a) => a.user_id === sundar.user.id).length, 1,
      'the new owner is not both accountable and an extra');
  });

  test('somebody outside the workspace cannot be assigned', async () => {
    const res = await api.post('/action-items',
      { title: 'Ghost task', assignee_ids: ['no-such-user'] }, { token: ownerToken });
    assert.equal(res.status, 400);
  });

  test('a co-assignee sees the task on their own list', async () => {
    const t = await newTask({ owner_id: priya.user.id, assignee_ids: [rahul.user.id] });

    const rahulSees = await api.get('/action-items?assigned_to_me=true', { token: rahul.token });
    assert.ok(rahulSees.body.data.some((x) => x.id === t.id), 'assigned alongside someone else still counts');

    const sundarSees = await api.get('/action-items', { token: sundar.token });
    assert.equal(sundarSees.body.data.some((x) => x.id === t.id), false, 'and nobody else sees it');
  });
});

describe('daily updates', () => {
  let task;

  before(async () => {
    task = await newTask({
      owner_id: priya.user.id, assignee_ids: [rahul.user.id],
      due_date: dueToday(), due_time: laterToday(),
    });
  });

  const post = (body, token = priya.token, id = task.id) =>
    api.post(`/action-items/${id}/updates`, body, { token });

  test('an assignee logs the six parts of a standup', async () => {
    const res = await post({
      completed_today: 'Pulled the August numbers and drafted the summary',
      in_progress: 'Charts for the media section',
      pending: 'Client sign-off on the creative',
      next_action: 'Send the draft to Divya tomorrow morning',
      progress_pct: 60,
      hours_spent: 3.5,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.progress_pct, 60);
    assert.equal(res.body.data.update_date, today);
    assert.equal(res.body.data.status_at_update, 'open', 'the status is frozen as it stood');
  });

  test('logging twice in a day edits the same update rather than stacking', async () => {
    const again = await post({ completed_today: 'Also cleared the media plan', progress_pct: 75 });
    assert.equal(again.status, 200, 'an upsert, not a second row');

    const list = await api.get(`/action-items/${task.id}/updates`, { token: priya.token });
    const mine = list.body.data.filter((u) => u.user_id === priya.user.id && u.update_date === today);
    assert.equal(mine.length, 1);
    assert.equal(mine[0].progress_pct, 75);
    // Topping up must not wipe the parts that were not resent.
    assert.equal(mine[0].next_action, 'Send the draft to Divya tomorrow morning');
    assert.equal(mine[0].hours_spent, 3.5);
  });

  test('a field is cleared only when null is sent explicitly', async () => {
    await post({ remarks: 'Ignore the typo in slide 4' });
    let mine = (await api.get(`/action-items/${task.id}/updates`, { token: priya.token }))
      .body.data.find((u) => u.user_id === priya.user.id && u.update_date === today);
    assert.equal(mine.remarks, 'Ignore the typo in slide 4');

    await post({ remarks: null });
    mine = (await api.get(`/action-items/${task.id}/updates`, { token: priya.token }))
      .body.data.find((u) => u.user_id === priya.user.id && u.update_date === today);
    assert.equal(mine.remarks, null);
    assert.equal(mine.completed_today, 'Also cleared the media plan', 'and nothing else moved');
  });

  test('an update with nothing written in it is refused', async () => {
    // A fresh task, so there is no earlier entry for the merge to keep alive.
    const blank = await newTask({ owner_id: priya.user.id });
    const res = await post({ progress_pct: 10 }, priya.token, blank.id);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /at least one part/i);
  });

  test('an update cannot be logged for a day that has not happened', async () => {
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    const res = await post({ completed_today: 'Time travel', update_date: tomorrow });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /has not happened/i);
  });

  test('only people on the task can post an update on it', async () => {
    const res = await post({ completed_today: 'Not my task' }, sundar.token);
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /assigned/i);
  });

  test('each assignee keeps their own update for the same task and day', async () => {
    await post({ completed_today: 'Reviewed the layout' }, rahul.token);

    const list = (await api.get(`/action-items/${task.id}/updates`, { token: priya.token })).body.data;
    const todays = list.filter((u) => u.update_date === today);
    assert.equal(todays.length, 2);
    assert.deepEqual(todays.map((u) => u.user_id).sort(), [priya.user.id, rahul.user.id].sort());
  });

  test('the update can move the task on in the same action', async () => {
    const res = await post({
      completed_today: 'Sent it to the client', next_action: 'Await sign-off', status: 'in_progress',
    });
    assert.equal(res.status, 200);
    const d = await detail(task.id, priya.token);
    assert.equal(d.status, 'in_progress');
    assert.ok(d.started_at, 'starting the task is stamped');
  });

  test('a blocker reaches the accountable owner and the reporting manager', async () => {
    const blocked = await newTask({ owner_id: priya.user.id, assignee_ids: [rahul.user.id] });
    const res = await api.post(`/action-items/${blocked.id}/updates`,
      { blockers: 'Waiting on brand assets from the client', next_action: 'Chase Karthik' },
      { token: rahul.token });
    assert.equal(res.status, 201);

    // Priya is accountable, Divya is Rahul's manager. Both should be told.
    for (const who of [priya, divya]) {
      const notes = await api.get('/notifications', { token: who.token });
      assert.ok(
        notes.body.data.some((n) => /Blocker raised/i.test(n.title || '')),
        `${who.user.name} was told about the blocker`,
      );
    }
  });

  test('an update can be withdrawn, but only by the person who wrote it', async () => {
    const t = await newTask({ owner_id: priya.user.id, assignee_ids: [rahul.user.id] });
    const made = await api.post(`/action-items/${t.id}/updates`,
      { completed_today: 'Something' }, { token: rahul.token });

    assert.equal((await api.del(`/action-items/updates/${made.body.data.id}`, { token: priya.token })).status, 403);
    assert.equal((await api.del(`/action-items/updates/${made.body.data.id}`, { token: rahul.token })).status, 200);
    assert.equal(
      (await api.get(`/action-items/${t.id}/updates`, { token: rahul.token })).body.data.length, 0,
    );
  });
});

describe('the employee view', () => {
  test('lists my tasks, what still owes an update, and what I have written', async () => {
    const fresh = await join('Aisha', 'aisha@delivery.test', 'employee', { manager_id: divya.user.id });
    const a = await newTask({ title: 'Task one', owner_id: fresh.user.id });
    await newTask({ title: 'Task two', owner_id: fresh.user.id });

    let mine = (await api.get('/action-items/updates/mine', { token: fresh.token })).body.data;
    assert.equal(mine.tasks.length, 2);
    assert.equal(mine.needs_update.length, 2, 'nothing written yet, so both are outstanding');
    assert.equal(mine.submitted.length, 0);

    await api.post(`/action-items/${a.id}/updates`, { completed_today: 'Started it' }, { token: fresh.token });

    mine = (await api.get('/action-items/updates/mine', { token: fresh.token })).body.data;
    assert.equal(mine.needs_update.length, 1);
    assert.equal(mine.submitted.length, 1);
    assert.equal(mine.tasks.find((t) => t.id === a.id).has_update_today, true);
  });

  test('the needs_update filter agrees with the employee view', async () => {
    const fresh = await join('Bala', 'bala@delivery.test', 'employee');
    await newTask({ title: 'Needs a word', owner_id: fresh.user.id });

    const filtered = await api.get('/action-items?needs_update=true', { token: fresh.token });
    assert.equal(filtered.body.data.length, 1);
    assert.equal(filtered.body.data[0].title, 'Needs a word');
  });

  test('a completed task stops asking for updates', async () => {
    const fresh = await join('Chandra', 'chandra@delivery.test', 'employee');
    const t = await newTask({ title: 'Nearly there', owner_id: fresh.user.id });

    await api.patch(`/action-items/${t.id}`, { status: 'done' }, { token: ownerToken });
    const mine = (await api.get('/action-items/updates/mine', { token: fresh.token })).body.data;
    assert.equal(mine.needs_update.some((x) => x.id === t.id), false);
  });
});

describe('the manager view', () => {
  test('shows each report, their tasks, their update and their blockers', async () => {
    const res = await api.get(`/action-items/updates/team?date=${today}`, { token: divya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.scope, 'team');

    const names = res.body.data.people.map((p) => p.user.name);
    assert.ok(names.includes('Priya') && names.includes('Rahul'), 'her direct reports are listed');
    assert.equal(names.includes('Sundar'), false, 'somebody outside her team is not');

    const forPriya = res.body.data.people.find((p) => p.user.name === 'Priya');
    assert.ok(forPriya.updates.length >= 1);
    assert.ok(forPriya.open_tasks >= 1);
    assert.equal(typeof forPriya.avg_progress_pct, 'number');
  });

  test('silence is reported, not hidden', async () => {
    const quiet = await join('Quiet', 'quiet@delivery.test', 'employee', { manager_id: divya.user.id });
    await newTask({ title: 'Untouched work', owner_id: quiet.user.id });

    const res = await api.get(`/action-items/updates/team?date=${today}`, { token: divya.token });
    const row = res.body.data.people.find((p) => p.user.name === 'Quiet');
    assert.equal(row.status, 'silent');
    assert.equal(row.updates.length, 0);
    assert.equal(row.missing.length, 1, 'the task they said nothing about is named');
    assert.ok(res.body.data.summary.silent >= 1);
  });

  test('somebody with no open work is not counted as silent', async () => {
    const idle = await join('Idle', 'idle@delivery.test', 'employee', { manager_id: divya.user.id });
    const res = await api.get(`/action-items/updates/team?date=${today}`, { token: divya.token });
    const row = res.body.data.people.find((p) => p.user.id === idle.user.id);
    assert.equal(row.status, 'no_open_tasks');
  });

  test('an employee cannot read the team board', async () => {
    const res = await api.get('/action-items/updates/team', { token: priya.token });
    assert.equal(res.status, 403);
  });

  test('an admin sees the whole workspace', async () => {
    const res = await api.get('/action-items/updates/team', { token: ownerToken });
    assert.equal(res.body.data.scope, 'all');
    assert.ok(res.body.data.people.some((p) => p.user.name === 'Sundar'));
  });

  test('a past day can be reviewed', async () => {
    const t = await newTask({ owner_id: priya.user.id });
    await api.post(`/action-items/${t.id}/updates`,
      { completed_today: 'Wrote it up late', update_date: yesterday }, { token: priya.token });

    const res = await api.get(`/action-items/updates/team?date=${yesterday}`, { token: divya.token });
    assert.equal(res.body.data.date, yesterday);
    const forPriya = res.body.data.people.find((p) => p.user.name === 'Priya');
    assert.ok(forPriya.updates.some((u) => u.completed_today === 'Wrote it up late'));
  });

  test('the board exports as a CSV', async () => {
    const res = await api.get(`/action-items/updates/export?from=${yesterday}&to=${today}`, { token: ownerToken });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const [header] = String(res.body.raw ?? res.body).split('\n');
    assert.match(header, /date,employee,task,client,task_status/);
  });
});

describe('My Day', () => {
  test('counts and lists assigned work, flagging what still owes an update', async () => {
    const solo = await join('Deepa', 'deepa@delivery.test', 'employee');
    const t = await newTask({
      title: 'Due right now', owner_id: solo.user.id, due_date: dueToday(), due_time: laterToday(),
    });

    let home = (await api.get('/dashboard/home', { token: solo.token })).body.data;
    assert.equal(home.counters.due_today, 1);
    assert.equal(home.counters.needs_update, 1);
    assert.equal(home.today_items.find((x) => x.id === t.id).has_update_today, false);

    await api.post(`/action-items/${t.id}/updates`, { completed_today: 'Half done' }, { token: solo.token });

    home = (await api.get('/dashboard/home', { token: solo.token })).body.data;
    assert.equal(home.counters.needs_update, 0);
    assert.equal(home.today_items.find((x) => x.id === t.id).has_update_today, true);
  });

  test('work assigned alongside somebody else still shows on My Day', async () => {
    const helper = await join('Eshan', 'eshan@delivery.test', 'employee');
    await newTask({
      title: 'Shared job', owner_id: priya.user.id, assignee_ids: [helper.user.id],
      due_date: dueToday(), due_time: laterToday(),
    });

    const home = (await api.get('/dashboard/home', { token: helper.token })).body.data;
    assert.ok(home.today_items.some((x) => x.title === 'Shared job'),
      'a co-assignee sees it even though they are not accountable');
    assert.equal(home.today_items.find((x) => x.title === 'Shared job').accountable, false);
  });

  test('personal to-dos stay out of the assigned-task counters', async () => {
    const solo = await join('Farah', 'farah@delivery.test', 'employee');
    await api.post('/todos', { title: 'Call the dentist' }, { token: solo.token });

    const home = (await api.get('/dashboard/home', { token: solo.token })).body.data;
    assert.equal(home.counters.needs_update, 0);
    assert.equal(home.today_items.length, 0, 'a personal reminder is not company work');
  });
});
