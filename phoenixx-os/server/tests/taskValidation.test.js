import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Validate Co', email: 'owner@validate.test' });
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

let ranjith; // raises the work
let chandru; // does the work
let vinu;    // uninvolved bystander

before(async () => {
  ranjith = await join('Ranjith', 'ranjith@validate.test', 'manager');
  chandru = await join('Chandru', 'chandru@validate.test', 'employee', { manager_id: ranjith.user.id });
  vinu = await join('Vinu', 'vinu@validate.test', 'employee', { manager_id: ranjith.user.id });
});

/** Ranjith raises a task, Chandru is accountable for it. */
const assignTask = async (title = 'Website review') => {
  const res = await api.post('/action-items',
    { title, owner_id: chandru.user.id, due_date: '2026-12-31' }, { token: ranjith.token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};

const detail = (id, token) => api.get(`/action-items/${id}`, { token }).then((r) => r.body.data);
const markDone = (id, token) => api.patch(`/action-items/${id}`, { status: 'done' }, { token });

describe('completion and creator validation', () => {
  test('marking done sends the task for validation instead of closing it', async () => {
    const t = await assignTask();
    assert.equal(t.validation_status, null, 'nothing to validate until the work is done');

    const done = await markDone(t.id, chandru.token);
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal(done.body.data.status, 'done');
    assert.equal(done.body.data.validation_status, 'pending');
    assert.equal(done.body.data.completed_by, chandru.user.id);
    assert.ok(done.body.data.completed_at, 'the completion is timestamped');

    const d = await detail(t.id, ranjith.token);
    assert.equal(d.can_validate, true, 'the creator is asked to rule on it');
    assert.deepEqual(d.validations.map((v) => v.event), ['submitted']);
  });

  test('a completed task leaves the working list and appears under completed', async () => {
    const t = await assignTask('Leaves the active list');
    await markDone(t.id, chandru.token);

    const active = await api.get('/action-items?bucket=active&limit=100', { token: chandru.token });
    assert.ok(!active.body.data.some((i) => i.id === t.id),
      'work the assignee has finished is off their working list');

    const completed = await api.get('/action-items?bucket=completed&validation=pending&limit=100',
      { token: chandru.token });
    assert.ok(completed.body.data.some((i) => i.id === t.id));
  });

  test('the assignee cannot validate their own work', async () => {
    const t = await assignTask('Not mine to sign off');
    await markDone(t.id, chandru.token);

    const res = await api.post(`/action-items/${t.id}/validate`, { decision: 'approve' },
      { token: chandru.token });
    assert.equal(res.status, 403, JSON.stringify(res.body));
    assert.match(res.body.error.message, /only the person who raised this task/i);

    const d = await detail(t.id, chandru.token);
    assert.equal(d.validation_status, 'pending', 'the refusal changed nothing');
    assert.equal(d.can_validate, false);
  });

  test('somebody who neither raised nor did the work cannot validate it either', async () => {
    const t = await assignTask('Bystander test');
    await markDone(t.id, chandru.token);

    const res = await api.post(`/action-items/${t.id}/validate`, { decision: 'approve' },
      { token: vinu.token });
    assert.equal(res.status, 403);
  });

  test('the creator approves, and the task is finished for good', async () => {
    const t = await assignTask('Approved work');
    await markDone(t.id, chandru.token);

    const res = await api.post(`/action-items/${t.id}/validate`,
      { decision: 'approve', note: 'Looks right.' }, { token: ranjith.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const d = await detail(t.id, ranjith.token);
    assert.equal(d.status, 'done');
    assert.equal(d.validation_status, 'validated');
    assert.equal(d.validated_by, ranjith.user.id);
    assert.ok(d.validated_at, 'the sign-off is timestamped');
    assert.equal(d.validation_note, 'Looks right.');
    assert.equal(d.can_validate, false, 'there is nothing left to rule on');
    assert.deepEqual(d.validations.map((v) => v.event), ['submitted', 'validated']);
  });

  test('a rejection needs a reason', async () => {
    const t = await assignTask('Rejected with no reason');
    await markDone(t.id, chandru.token);

    const res = await api.post(`/action-items/${t.id}/validate`, { decision: 'reject' },
      { token: ranjith.token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /say what needs changing/i);
  });

  test('a rejected task goes back to the assignee as live work, and can be resubmitted', async () => {
    const t = await assignTask('Round trip');
    await markDone(t.id, chandru.token);

    const rejected = await api.post(`/action-items/${t.id}/validate`,
      { decision: 'reject', note: 'The August figures are missing from section 3.' },
      { token: ranjith.token });
    assert.equal(rejected.status, 200, JSON.stringify(rejected.body));

    let d = await detail(t.id, chandru.token);
    assert.equal(d.status, 'in_progress', 'it is being worked again, not sitting in done');
    assert.equal(d.validation_status, 'changes_requested');
    assert.equal(d.completed_at, null, 'it is no longer a completed task');
    assert.equal(d.rework_count, 1);
    assert.match(d.validation_note, /August figures/);

    const active = await api.get('/action-items?bucket=active&limit=100', { token: chandru.token });
    assert.ok(active.body.data.some((i) => i.id === t.id), 'it is back on the working list');

    // Second attempt: done again, and it queues for the creator a second time.
    await markDone(t.id, chandru.token);
    d = await detail(t.id, ranjith.token);
    assert.equal(d.validation_status, 'pending');
    assert.equal(d.can_validate, true);

    await api.post(`/action-items/${t.id}/validate`, { decision: 'approve' }, { token: ranjith.token });
    d = await detail(t.id, ranjith.token);
    assert.equal(d.validation_status, 'validated');
    assert.deepEqual(d.validations.map((v) => v.event),
      ['submitted', 'changes_requested', 'submitted', 'validated'],
      'the whole round trip is on the record, in order');
    assert.deepEqual(d.validations.map((v) => v.round), [1, 1, 2, 2]);
  });

  test('validating twice is refused', async () => {
    const t = await assignTask('Only once');
    await markDone(t.id, chandru.token);
    await api.post(`/action-items/${t.id}/validate`, { decision: 'approve' }, { token: ranjith.token });

    const again = await api.post(`/action-items/${t.id}/validate`, { decision: 'reject', note: 'changed my mind' },
      { token: ranjith.token });
    assert.equal(again.status, 400);
    assert.match(again.body.error.message, /already been validated/i);
  });

  test('validating work nobody has finished is refused', async () => {
    const t = await assignTask('Still open');
    const res = await api.post(`/action-items/${t.id}/validate`, { decision: 'approve' },
      { token: ranjith.token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /marked done/i);
  });

  test('the assignee cannot reopen work the creator has signed off', async () => {
    const t = await assignTask('Closed for good');
    await markDone(t.id, chandru.token);
    await api.post(`/action-items/${t.id}/validate`, { decision: 'approve' }, { token: ranjith.token });

    const res = await api.patch(`/action-items/${t.id}`, { status: 'in_progress' }, { token: chandru.token });
    assert.equal(res.status, 403, JSON.stringify(res.body));

    const d = await detail(t.id, chandru.token);
    assert.equal(d.status, 'done');
    assert.equal(d.validation_status, 'validated');
  });

  test('the creator may reopen validated work, which clears the sign-off', async () => {
    const t = await assignTask('Reopened by the creator');
    await markDone(t.id, chandru.token);
    await api.post(`/action-items/${t.id}/validate`, { decision: 'approve' }, { token: ranjith.token });

    const res = await api.patch(`/action-items/${t.id}`, { status: 'in_progress' }, { token: ranjith.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const d = await detail(t.id, ranjith.token);
    assert.equal(d.validation_status, null, 'a reopened task is not a validated task');
    assert.equal(d.completed_at, null);
    assert.ok(d.validations.some((v) => v.event === 'reopened'));
  });

  test('nobody can raise a task for themselves', async () => {
    const own = await api.post('/action-items',
      { title: 'My own errand', owner_id: chandru.user.id }, { token: chandru.token });
    assert.equal(own.status, 400);
    assert.match(own.body.error.message, /yourself/);
  });

  test('the creator queue counts only what is waiting on that person', async () => {
    const mine = await api.get('/action-items?to_validate=true&limit=100', { token: ranjith.token });
    assert.ok(mine.body.data.every((i) => i.status === 'done' && i.validation_status === 'pending'));
    assert.ok(mine.body.data.every((i) => i.created_by === ranjith.user.id));

    const chandruQueue = await api.get('/action-items?limit=1', { token: chandru.token });
    assert.equal(chandruQueue.body.meta.my_validation_queue, 0,
      'Chandru raised none of this work, so nothing waits on him');
  });

  test('work closed before sign-off existed is settled by the migration, not queued', async () => {
    const t = await assignTask('Closed under the old rules');
    // Exactly the shape of a row written before this workflow shipped.
    await db.run("UPDATE action_items SET status = 'done', completed_at = ?, validation_status = NULL WHERE id = ?",
      [new Date().toISOString(), t.id]);

    await db.migrate();

    const d = await detail(t.id, ranjith.token);
    assert.equal(d.validation_status, 'validated', 'history does not land in anybody\'s queue');
    assert.equal(d.validated_by, null, 'nobody is credited with a sign-off they never gave');
    assert.equal(d.can_validate, false);
  });

  test('a bulk mark-done still routes every task through validation', async () => {
    const a = await assignTask('Bulk one');
    const b = await assignTask('Bulk two');

    const res = await api.post('/action-items/bulk',
      { ids: [a.id, b.id], patch: { status: 'done' } }, { token: chandru.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.updated, 2);

    for (const t of [a, b]) {
      const d = await detail(t.id, ranjith.token);
      assert.equal(d.validation_status, 'pending', 'bulk is not a way round the sign-off');
      assert.equal(d.completed_by, chandru.user.id);
      assert.deepEqual(d.validations.map((v) => v.event), ['submitted']);
    }
  });

  test('bulk skips validated work rather than trampling it', async () => {
    const t = await assignTask('Bulk cannot reopen this');
    await markDone(t.id, chandru.token);
    await api.post(`/action-items/${t.id}/validate`, { decision: 'approve' }, { token: ranjith.token });

    const res = await api.post('/action-items/bulk',
      { ids: [t.id], patch: { status: 'open' } }, { token: chandru.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.updated, 0);
    assert.equal(res.body.data.skipped, 1);

    const d = await detail(t.id, chandru.token);
    assert.equal(d.status, 'done');
    assert.equal(d.validation_status, 'validated');
  });
});
