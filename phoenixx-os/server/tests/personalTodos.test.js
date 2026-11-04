import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Day Planner Agency', email: 'owner@day.test' });
const ownerToken = owner.access_token;

/** Invites someone and signs them in, so we have a second person's session. */
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

const today = new Date().toISOString().slice(0, 10);
const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

let priya;
let rahul;

before(async () => {
  priya = await join('Priya', 'priya@day.test');
  rahul = await join('Rahul', 'rahul@day.test');
});

describe('My Day - the personal to-do list', () => {
  test('an item is created with a title alone and lands on today', async () => {
    const res = await api.post('/todos', { title: 'Call client' }, { token: priya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.title, 'Call client');
    assert.equal(res.body.data.todo_date, today);
    assert.equal(res.body.data.status, 'pending');
    assert.equal(res.body.data.priority, 'normal');
    assert.equal(res.body.data.due_time, null);
  });

  test('a time and a priority can be set, and are validated', async () => {
    const good = await api.post('/todos',
      { title: 'Prepare EOD report', due_time: '18:30', priority: 'high' }, { token: priya.token });
    assert.equal(good.status, 201, JSON.stringify(good.body));
    assert.equal(good.body.data.due_time, '18:30');
    assert.equal(good.body.data.priority, 'high');

    assert.equal((await api.post('/todos', { title: 'Nope', due_time: '25:99' }, { token: priya.token })).status, 422);
    assert.equal((await api.post('/todos', { title: 'Nope', priority: 'urgent' }, { token: priya.token })).status, 422);
    assert.equal((await api.post('/todos', { title: '   ' }, { token: priya.token })).status, 422);
  });

  test("the day's list separates pending from completed and counts both", async () => {
    const item = (await api.post('/todos', { title: 'Complete documentation' }, { token: rahul.token })).body.data;
    await api.post(`/todos/${item.id}/toggle`, {}, { token: rahul.token });
    await api.post('/todos', { title: "Review today's work" }, { token: rahul.token });

    const res = await api.get('/todos', { token: rahul.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.meta.date, today);
    assert.equal(res.body.meta.pending, 1);
    assert.equal(res.body.meta.completed, 1);
  });

  test('the checkbox toggles both ways and stamps when it was finished', async () => {
    const item = (await api.post('/todos', { title: 'Follow up with HR' }, { token: priya.token })).body.data;

    const done = await api.post(`/todos/${item.id}/toggle`, {}, { token: priya.token });
    assert.equal(done.body.data.status, 'completed');
    assert.ok(done.body.data.completed_at, 'completing stamps the time');

    const reopened = await api.post(`/todos/${item.id}/toggle`, {}, { token: priya.token });
    assert.equal(reopened.body.data.status, 'pending');
    assert.equal(reopened.body.data.completed_at, null, 'reopening clears it, so "done at" never lies');
  });

  test('an item can be edited and deleted by the person who made it', async () => {
    const item = (await api.post('/todos', { title: 'Draft agenda' }, { token: priya.token })).body.data;

    const edited = await api.patch(`/todos/${item.id}`, { title: 'Draft the kickoff agenda', priority: 'high' },
      { token: priya.token });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.title, 'Draft the kickoff agenda');
    assert.equal(edited.body.data.priority, 'high');

    assert.equal((await api.del(`/todos/${item.id}`, { token: priya.token })).status, 200);
    assert.equal((await api.get('/todos', { token: priya.token })).body.data.some((t) => t.id === item.id), false);
  });

  test("unfinished items carry over from earlier days, and can be pulled onto today", async () => {
    const stale = (await api.post('/todos', { title: 'Chase the vendor', todo_date: yesterday },
      { token: rahul.token })).body.data;

    const withCarry = await api.get('/todos', { token: rahul.token });
    assert.ok(withCarry.body.data.some((t) => t.id === stale.id), 'yesterday still shows on today');
    assert.equal(withCarry.body.meta.carried_over, 1);

    const onlyToday = await api.get('/todos?include_carry_over=false', { token: rahul.token });
    assert.equal(onlyToday.body.data.some((t) => t.id === stale.id), false);

    const moved = await api.post(`/todos/${stale.id}/move`, { todo_date: today }, { token: rahul.token });
    assert.equal(moved.body.data.todo_date, today);
    assert.equal((await api.get('/todos', { token: rahul.token })).body.meta.carried_over, 0);
  });

  test('clearing completed items tidies the day without touching pending ones', async () => {
    const keep = (await api.post('/todos', { title: 'Still to do' }, { token: priya.token })).body.data;
    const drop = (await api.post('/todos', { title: 'Already done' }, { token: priya.token })).body.data;
    await api.post(`/todos/${drop.id}/toggle`, {}, { token: priya.token });

    const cleared = await api.post('/todos/clear-completed', {}, { token: priya.token });
    assert.equal(cleared.status, 200);
    assert.ok(cleared.body.data.cleared >= 1);

    const list = (await api.get('/todos', { token: priya.token })).body.data;
    assert.ok(list.some((t) => t.id === keep.id));
    assert.equal(list.some((t) => t.id === drop.id), false);
  });
});

describe('a personal list is private', () => {
  test('one person never sees another person\'s items', async () => {
    const mine = (await api.post('/todos', { title: 'Private reminder' }, { token: priya.token })).body.data;

    const theirs = await api.get('/todos', { token: rahul.token });
    assert.equal(theirs.body.data.some((t) => t.id === mine.id), false);

    // Not even the workspace owner, who can read everything else in the tenant.
    const asOwner = await api.get('/todos', { token: ownerToken });
    assert.equal(asOwner.body.data.some((t) => t.id === mine.id), false);
  });

  test('someone else\'s item cannot be read, edited, toggled or deleted', async () => {
    const mine = (await api.post('/todos', { title: 'Hands off' }, { token: priya.token })).body.data;

    assert.equal((await api.patch(`/todos/${mine.id}`, { title: 'Hijacked' }, { token: rahul.token })).status, 404);
    assert.equal((await api.post(`/todos/${mine.id}/toggle`, {}, { token: rahul.token })).status, 404);
    assert.equal((await api.post(`/todos/${mine.id}/move`, { todo_date: today }, { token: rahul.token })).status, 404);
    assert.equal((await api.del(`/todos/${mine.id}`, { token: rahul.token })).status, 404);
    assert.equal((await api.del(`/todos/${mine.id}`, { token: ownerToken })).status, 404);

    // Still there, and still untouched.
    assert.equal((await api.get('/todos', { token: priya.token })).body.data
      .find((t) => t.id === mine.id)?.title, 'Hands off');
  });

  test('personal items stay out of the company action-item queues', async () => {
    await api.post('/todos', { title: 'Buy a birthday card' }, { token: priya.token });
    const items = await api.get('/action-items', { token: priya.token });
    assert.equal(items.status, 200);
    assert.equal(items.body.data.some((a) => a.title === 'Buy a birthday card'), false);
  });

  test('a to-do saved for a later day shows under upcoming, not today', async () => {
    const later = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const res = await api.post('/todos', { title: 'Renew domain', todo_date: later, due_time: '11:00' }, { token: priya.token });
    assert.equal(res.status, 201);
    const day = await api.get(`/todos?date=${today}`, { token: priya.token });
    assert.ok(!day.body.data.some((t) => t.title === 'Renew domain'));
    const up = await api.get(`/todos/upcoming?date=${today}`, { token: priya.token });
    assert.ok(up.body.data.some((t) => t.title === 'Renew domain' && t.todo_date === later));
    const theirs = await api.get(`/todos/upcoming?date=${today}`, { token: rahul.token });
    assert.ok(!theirs.body.data.some((t) => t.title === 'Renew domain'), 'still private');
  });

  test('the list is unreachable without a session', async () => {
    assert.equal((await api.get('/todos')).status, 401);
  });
});
