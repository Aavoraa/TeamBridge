import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

/**
 * Advance Planner -> Action Items. Every task on a filed plan becomes exactly
 * one action item, assigned to the person who planned it and validated by the
 * reporting person the plan went to, and from then on it is tracked there.
 */

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const P = await import('../src/services/todoPlan.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Convert Agency', email: 'owner@convert.test' });
const ownerToken = owner.access_token;
const tenantId = (await db.get('SELECT tenant_id FROM users WHERE email = ?', ['owner@convert.test'])).tenant_id;

async function join(name, role = 'employee') {
  const email = `${name.toLowerCase()}@convert.test`;
  const invite = await api.post('/users', { name, email, role }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invite.body.data.id, token: accepted.body.data.access_token, name };
}

const reportTo = async (person, manager) => {
  const res = await api.patch(`/users/${person.id}`, { manager_id: manager.id }, { token: ownerToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
};

/** Plans this suite files are all for the next working day, held to a deadline at the end of today. */
async function file(person, tasks) {
  const res = await api.put(`/todo-plan/mine/${target}`, { tasks, submit: true }, { token: person.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
}

const convert = (planId, token) => api.post(`/todo-plan/submissions/${planId}/action-items`, {}, { token });
const itemsOf = async (planId) => await db.all(
  "SELECT * FROM action_items WHERE tenant_id = ? AND source_type = 'advance_planner' AND source_plan_id = ? ORDER BY created_at, ctid",
  [tenantId, planId],
);
const addDay = (d, n = 1) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

let mani; let ravi; let kumar; let arun; let sita; let lata; let devi;
let target;

before(async () => {
  mani = await join('Mani', 'manager');
  ravi = await join('Ravi', 'manager');
  kumar = await join('Kumar');
  arun = await join('Arun');
  sita = await join('Sita');
  lata = await join('Lata');
  devi = await join('Devi');
  for (const p of [kumar, arun, lata, devi]) await reportTo(p, mani);
  await reportTo(sita, ravi);
  const res = await api.put('/todo-plan/settings', {
    enabled: true,
    working_days: [0, 1, 2, 3, 4, 5, 6],
    open_time: '00:00', reminder_time: '00:01', deadline_time: '23:57', escalation_time: '23:58',
  }, { token: ownerToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  target = (await api.get('/todo-plan/mine', { token: kumar.token })).body.data.window.todo_date;
});

describe('the planner form follows the action item conventions', () => {
  test('the four action item priorities are accepted, anything else is not', async () => {
    const ok = await api.put(`/todo-plan/mine/${target}`, { tasks: [{ task: 'Fix the outage', priority: 'urgent' }] }, { token: devi.token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.data.tasks[0].priority, 'urgent');
    const bad = await api.put(`/todo-plan/mine/${target}`, { tasks: [{ task: 'Fix the outage', priority: 'critical' }] }, { token: devi.token });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.message, /urgent, high, medium or low/);
  });

  test('the plan shows who the action items will be assigned to and who validates them', async () => {
    const res = await api.get('/todo-plan/mine', { token: devi.token });
    const c = res.body.data.plan.conversion;
    assert.equal(c.assignee.id, devi.id);
    assert.equal(c.reviewer.id, mani.id);
    assert.equal(c.can_convert, false, 'a draft is not converted');
    assert.match(c.problem, /Submit the plan/);
  });

  test('a draft cannot be turned into action items', async () => {
    const plan = (await api.get('/todo-plan/mine', { token: devi.token })).body.data.plan;
    const res = await convert(plan.id, devi.token);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Submit the plan/);
    assert.equal((await itemsOf(plan.id)).length, 0);
  });
});

describe('one planner task, one action item', () => {
  let plan; let item;

  test('a plan with one task converts to one action item', async () => {
    plan = await file(arun, [{
      task: 'Verify the Monday lead batch', priority: 'high', expected_time: '11:30',
      notes: 'Use the new checklist', checklist: [{ text: 'Pull the sheet' }, { text: 'Call back no-answers' }],
    }]);
    const res = await convert(plan.id, arun.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.created.length, 1);
    assert.deepEqual([res.body.data.already_converted.length, res.body.data.skipped.length, res.body.data.failed.length], [0, 0, 0]);
    [item] = await itemsOf(plan.id);
    assert.equal(item.id, res.body.data.created[0].action_item_id);
  });

  test('the creator is the assignee and the plan\'s reporting person validates', () => {
    assert.equal(item.owner_id, arun.id);
    assert.equal(item.created_by, mani.id);
  });

  test('title, description, priority and the planned day and time are carried over', () => {
    assert.equal(item.title, 'Verify the Monday lead batch');
    assert.equal(item.priority, 'high');
    assert.equal(item.due_date, target);
    assert.equal(item.due_time, '11:30');
    assert.ok(item.due_at, 'the instant is resolved so overdue works');
    assert.match(item.description, /Use the new checklist/);
    assert.match(item.description, /- \[ \] Pull the sheet/);
    assert.match(item.description, /From the Advance Planner/);
  });

  test('it starts at the action item default status, linked back to its plan and task', () => {
    assert.equal(item.status, 'open');
    assert.equal(item.validation_status, null);
    assert.equal(item.source_type, 'advance_planner');
    assert.equal(item.source_id, plan.tasks[0].id);
    assert.equal(item.source_plan_id, plan.id);
  });

  test('the item detail links back to the plan', async () => {
    const res = await api.get(`/action-items/${item.id}`, { token: arun.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.source_plan.id, plan.id);
    assert.equal(res.body.data.source_plan.todo_date, target);
  });

  test('it is on the assignee\'s list and in the reviewer\'s view, once each', async () => {
    const mine = await api.get('/action-items?assigned_to_me=true', { token: arun.token });
    assert.equal(mine.body.data.filter((a) => a.id === item.id).length, 1);
    const team = await api.get(`/action-items?source_plan_id=${plan.id}`, { token: mani.token });
    assert.equal(team.body.data.length, 1);
    assert.equal(team.body.meta.total, 1);
  });

  test('the conversion is on the audit trail and in the plan\'s activity', async () => {
    const audit = await db.all("SELECT * FROM audit_logs WHERE tenant_id = ? AND entity = 'todo_submission' AND entity_id = ? AND action = 'convert_to_action_items'",
      [tenantId, plan.id]);
    assert.equal(audit.length, 1);
    assert.equal(audit[0].actor_id, arun.id);
    assert.equal((await db.all("SELECT * FROM audit_logs WHERE entity = 'action_item' AND entity_id = ? AND action = 'create'", [item.id])).length, 1);
    assert.equal((await db.all("SELECT * FROM todo_comments WHERE submission_id = ? AND kind = 'converted'", [plan.id])).length, 1);
  });

  test('the reporting person is told, the person who converted is not', async () => {
    const inbox = async (uid) => await db.all("SELECT * FROM notifications WHERE tenant_id = ? AND user_id = ? AND event_key = 'todo.converted' AND channel = 'in_app'", [tenantId, uid]);
    assert.equal((await inbox(mani.id)).length, 1);
    assert.equal((await inbox(arun.id)).length, 0);
  });

  test('the item joins the deadline ladder', async () => {
    assert.ok(await db.get("SELECT id FROM deadlines WHERE tenant_id = ? AND source_type = 'action_item' AND source_id = ?", [tenantId, item.id]));
  });
});

describe('many tasks, many items - and never twice', () => {
  let plan;

  test('a plan with several tasks makes one action item per task', async () => {
    plan = await file(kumar, [
      { task: 'Complete lead verification', priority: 'high', expected_time: '10:30' },
      { task: 'Follow up with 20 prospects', priority: 'medium' },
      { task: 'Draft the weekly report', priority: 'low', notes: 'Numbers from the dashboard' },
    ]);
    const res = await convert(plan.id, kumar.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.created.length, 3);
    const items = await itemsOf(plan.id);
    assert.equal(items.length, 3);
    assert.deepEqual(items.map((a) => a.title).sort(), plan.tasks.map((t) => t.task).sort());
    assert.deepEqual(new Set(items.map((a) => a.source_id)), new Set(plan.tasks.map((t) => t.id)));
    // Not one item holding the list.
    assert.ok(items.every((a) => !a.description.includes('Follow up with 20 prospects') || a.title === 'Follow up with 20 prospects'));
    assert.deepEqual(items.map((a) => a.priority).sort(), ['high', 'low', 'medium']);
    assert.equal(items.find((a) => a.title === 'Follow up with 20 prospects').due_time, null);
  });

  test('clicking again creates nothing and says what was already converted', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await convert(plan.id, kumar.token);
      assert.equal(res.status, 200);
      assert.equal(res.body.data.created.length, 0);
      assert.equal(res.body.data.already_converted.length, 3);
    }
    assert.equal((await itemsOf(plan.id)).length, 3);
  });

  test('requests racing each other still make one item per task', async () => {
    const racing = await file(lata, [{ task: 'Task one' }, { task: 'Task two' }, { task: 'Task three' }, { task: 'Task four' }]);
    const results = await Promise.all(Array.from({ length: 6 }, () => convert(racing.id, lata.token)));
    assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.body)));
    assert.equal(results.reduce((n, r) => n + r.body.data.created.length, 0), 4);
    assert.equal((await itemsOf(racing.id)).length, 4);
  });

  test('the database itself refuses a second item for the same task', async () => {
    const [a] = await itemsOf(plan.id);
    await assert.rejects(async () => await db.run(
      `INSERT INTO action_items (id, tenant_id, title, owner_id, created_by, priority, status, source_type, source_id, source_plan_id, created_at, updated_at)
       VALUES (?,?,?,?,?, 'medium', 'open', 'advance_planner', ?, ?, ?, ?)`,
      [crypto.randomUUID(), tenantId, 'dup', kumar.id, mani.id, a.source_id, plan.id, new Date().toISOString(), new Date().toISOString()],
    ), /UNIQUE|unique constraint/i);
  });

  test('the plan reads back how many are converted and each item\'s status', async () => {
    const res = await api.get(`/todo-plan/submissions/${plan.id}`, { token: kumar.token });
    const c = res.body.data.conversion;
    assert.deepEqual([c.total, c.converted, c.not_converted, c.ready], [3, 3, 0, 0]);
    assert.equal(c.can_convert, false);
    assert.ok(res.body.data.tasks.every((t) => t.action_item && t.action_item.status === 'open'));
  });
});

describe('the action item workflow runs as it always has', () => {
  let item;

  before(async () => {
    const plan = await db.get("SELECT id FROM todo_submissions WHERE user_id = ? AND todo_date = ?", [kumar.id, target]);
    item = (await itemsOf(plan.id)).find((a) => a.title === 'Complete lead verification');
  });

  test('the assignee starts it and logs a daily update', async () => {
    const started = await api.patch(`/action-items/${item.id}`, { status: 'in_progress' }, { token: kumar.token });
    assert.equal(started.status, 200, JSON.stringify(started.body));
    const update = await api.post(`/action-items/${item.id}/updates`, {
      completed_today: 'First 40 verified', in_progress: 'Next 40', pending: 'Last 20', blockers: '', next_action: 'Finish by noon',
    }, { token: kumar.token });
    assert.equal(update.status, 201, JSON.stringify(update.body));
  });

  test('done by the assignee goes to the reporting person for validation', async () => {
    const res = await api.patch(`/action-items/${item.id}`, { status: 'done' }, { token: kumar.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.validation_status, 'pending');
    const queue = await api.get('/action-items?to_validate=true', { token: mani.token });
    assert.ok(queue.body.data.some((a) => a.id === item.id));
    assert.ok(await db.get("SELECT id FROM notifications WHERE user_id = ? AND event_key = 'action_item.awaiting_validation'", [mani.id]));
  });

  test('the assignee cannot validate their own work, and nor can another manager', async () => {
    const self = await api.post(`/action-items/${item.id}/validate`, { decision: 'approve' }, { token: kumar.token });
    assert.equal(self.status, 403);
    const other = await api.post(`/action-items/${item.id}/validate`, { decision: 'approve' }, { token: ravi.token });
    assert.equal(other.status, 403);
  });

  test('a rejection sends it back to the assignee as live work', async () => {
    const res = await api.post(`/action-items/${item.id}/validate`, { decision: 'reject', note: 'Add the source column' }, { token: mani.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'in_progress');
    assert.equal(res.body.data.validation_status, 'changes_requested');
  });

  test('done again and approved, it is validated - and the plan shows it', async () => {
    await api.patch(`/action-items/${item.id}`, { status: 'done' }, { token: kumar.token });
    const res = await api.post(`/action-items/${item.id}/validate`, { decision: 'approve' }, { token: mani.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.validation_status, 'validated');
    const plan = await api.get(`/todo-plan/submissions/${item.source_plan_id}`, { token: kumar.token });
    const t = plan.body.data.tasks.find((x) => x.id === item.source_id);
    assert.equal(t.action_item.status, 'done');
    assert.equal(t.action_item.validation_status, 'validated');
    assert.equal(t.done_at, null, 'progress lives on the action item, not on the planner task');
  });
});

describe('once converted, the planner stops tracking the work itself', () => {
  let plan;
  before(async () => { plan = await db.get("SELECT * FROM todo_submissions WHERE user_id = ? AND todo_date = ?", [kumar.id, target]); });

  test('a converted task cannot be ticked off in the planner', async () => {
    const task = await db.get('SELECT id FROM todo_tasks WHERE submission_id = ? ORDER BY sort', [plan.id]);
    const res = await api.post(`/todo-plan/submissions/${plan.id}/tasks/${task.id}`, { done: true }, { token: kumar.token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Action Items/);
  });

  test('the plan can no longer be edited, so its tasks stay linked', async () => {
    const view = await api.get(`/todo-plan/submissions/${plan.id}`, { token: kumar.token });
    assert.equal(view.body.data.can_edit, false);
    assert.match(view.body.data.reason, /Action Items/);
    const res = await api.put(`/todo-plan/mine/${target}`, { tasks: [{ task: 'Something else' }] }, { token: kumar.token });
    assert.equal(res.status, 403);
    assert.equal((await itemsOf(plan.id)).length, 3);
  });

  test('the reporting person cannot send a converted plan back for changes', async () => {
    const res = await api.post(`/todo-plan/submissions/${plan.id}/request-changes`, { note: 'Redo it' }, { token: mani.token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /already action items/);
  });

  test('a task added afterwards is converted on the next run, nothing else is redone', async () => {
    const added = await api.post(`/todo-plan/submissions/${plan.id}/tasks`, { task: 'Late addition', priority: 'medium' }, { token: kumar.token });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    assert.equal(added.body.data.conversion.ready, 1);
    const res = await convert(plan.id, kumar.token);
    assert.equal(res.body.data.created.length, 1);
    assert.equal(res.body.data.created[0].task, 'Late addition');
    assert.equal(res.body.data.already_converted.length, 3);
    assert.equal((await itemsOf(plan.id)).length, 4);
  });
});

describe('partial runs and tasks that cannot convert', () => {
  test('a run that stopped part-way is finished by the retry', async () => {
    const plan = await file(devi, [{ task: 'Alpha task' }, { task: 'Beta task' }, { task: 'Gamma task' }]);
    // As if an earlier run had converted the first task and then stopped.
    const now = new Date().toISOString();
    const earlier = crypto.randomUUID();
    await db.run(
      `INSERT INTO action_items (id, tenant_id, title, owner_id, created_by, priority, status, due_date,
         source_type, source_id, source_plan_id, created_at, updated_at)
       VALUES (?,?,?,?,?, 'medium', 'open', ?, 'advance_planner', ?, ?, ?, ?)`,
      [earlier, tenantId, 'Alpha task', devi.id, mani.id, target, plan.tasks[0].id, plan.id, now, now],
    );
    const res = await convert(plan.id, devi.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.data.created.map((c) => c.task), ['Beta task', 'Gamma task']);
    assert.deepEqual(res.body.data.already_converted.map((c) => c.action_item_id), [earlier]);
    assert.equal((await itemsOf(plan.id)).length, 3);
  });

  test('a task already ticked off in the planner is skipped, with the reason', async () => {
    const other = await join('Hari');
    await reportTo(other, mani);
    const plan = await file(other, [{ task: 'Already finished' }, { task: 'Still to do' }]);
    const done = await api.post(`/todo-plan/submissions/${plan.id}/tasks/${plan.tasks[0].id}`, { done: true }, { token: other.token });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    const res = await convert(plan.id, other.token);
    assert.equal(res.body.data.created.length, 1);
    assert.equal(res.body.data.skipped.length, 1);
    assert.match(res.body.data.skipped[0].reason, /ticked off/);
  });

  test('a deleted action item is not recreated by a retry', async () => {
    const plan = await db.get('SELECT id FROM todo_submissions WHERE user_id = ? AND todo_date = ?', [devi.id, target]);
    const [first] = await itemsOf(plan.id);
    const del = await api.del(`/action-items/${first.id}`, { token: ownerToken });
    assert.equal(del.status, 200);
    const res = await convert(plan.id, devi.token);
    assert.equal(res.body.data.created.length, 0);
    assert.ok(res.body.data.already_converted.find((c) => c.action_item_id === first.id).deleted);
  });
});

describe('who may convert, and to whom', () => {
  test('the reporting person may convert their report\'s plan; the items still go to the employee', async () => {
    const other = await join('Gopi');
    await reportTo(other, mani);
    const plan = await file(other, [{ task: 'Reporting person converts this' }]);
    const res = await convert(plan.id, mani.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [a] = await itemsOf(plan.id);
    assert.equal(a.owner_id, other.id);
    assert.equal(a.created_by, mani.id);
    assert.ok(await db.get("SELECT id FROM notifications WHERE user_id = ? AND event_key = 'todo.converted'", [other.id]));
  });

  test('another employee or an unrelated manager cannot see the plan, let alone convert it', async () => {
    const plan = await file(sita, [{ task: 'Sita owns this' }]);
    for (const who of [arun, mani]) {
      const res = await convert(plan.id, who.token);
      assert.equal(res.status, 404);
    }
    assert.equal((await itemsOf(plan.id)).length, 0);
  });

  test('assignee and reviewer cannot be chosen by the caller', async () => {
    const plan = await db.get('SELECT id FROM todo_submissions WHERE user_id = ? AND todo_date = ?', [sita.id, target]);
    const res = await api.post(`/todo-plan/submissions/${plan.id}/action-items`, { owner_id: arun.id, created_by: arun.id }, { token: sita.token });
    assert.equal(res.status, 200);
    const [a] = await itemsOf(plan.id);
    assert.equal(a.owner_id, sita.id);
    assert.equal(a.created_by, ravi.id);
  });

  test('the planner link cannot be forged through the action item API', async () => {
    const task = await db.get('SELECT id FROM todo_tasks LIMIT 1');
    const res = await api.post('/action-items', {
      title: 'Forged', owner_id: arun.id, source_type: 'advance_planner', source_id: task.id,
    }, { token: mani.token });
    assert.equal(res.status, 422);
  });

  test('a converted item keeps its link through an edit', async () => {
    const plan = await db.get('SELECT id FROM todo_submissions WHERE user_id = ? AND todo_date = ?', [sita.id, target]);
    const [a] = await itemsOf(plan.id);
    const res = await api.patch(`/action-items/${a.id}`, { source_type: 'manual', source_id: null, priority: 'high' }, { token: ravi.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const after = await db.get('SELECT * FROM action_items WHERE id = ?', [a.id]);
    assert.equal(after.source_type, 'advance_planner');
    assert.equal(after.priority, 'high');
  });
});

describe('approving a plan moves its tasks to Action Items', () => {
  test('approval creates one item per task, assigned to the employee, validated by the approver', async () => {
    const emp = await join('Meena');
    await reportTo(emp, mani);
    const plan = await file(emp, [{ task: 'Approved task one' }, { task: 'Approved task two' }]);
    const res = await api.post(`/todo-plan/submissions/${plan.id}/approve`, {}, { token: mani.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'APPROVED');
    assert.equal(res.body.data.conversion_result.created.length, 2);
    assert.equal(res.body.data.conversion.converted, 2);
    const items = await itemsOf(plan.id);
    assert.ok(items.every((a) => a.owner_id === emp.id && a.created_by === mani.id && a.status === 'open'));
    const mine = await api.get('/action-items?assigned_to_me=true', { token: emp.token });
    assert.equal(mine.body.data.filter((a) => a.source_plan_id === plan.id).length, 2);
    // The button afterwards finds nothing left to do.
    const again = await convert(plan.id, emp.token);
    assert.equal(again.body.data.created.length, 0);
    assert.equal((await itemsOf(plan.id)).length, 2);
  });

  test('a plan approved without converting is picked up by the clock, once', async () => {
    const emp = await join('Ranji');
    await reportTo(emp, mani);
    const plan = await file(emp, [{ task: 'Approved before the update' }]);
    // Approved the way it was before approval converted: status only.
    await db.run("UPDATE todo_submissions SET status = 'APPROVED', reviewed_by = ?, approved_at = ? WHERE id = ?",
      [mani.id, new Date().toISOString(), plan.id]);
    assert.equal((await itemsOf(plan.id)).length, 0);

    await P.todoTick([tenantId]);
    const items = await itemsOf(plan.id);
    assert.equal(items.length, 1);
    assert.equal(items[0].owner_id, emp.id);
    assert.equal(items[0].created_by, mani.id);

    await P.todoTick([tenantId]);
    assert.equal((await itemsOf(plan.id)).length, 1, 'the next tick has nothing left to do');
    const audits = await db.all("SELECT * FROM audit_logs WHERE entity = 'todo_submission' AND entity_id = ? AND action = 'convert_to_action_items'", [plan.id]);
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actor_id, mani.id);
  });

  test('an approval that cannot convert still approves, and says why', async () => {
    const emp = await join('Tara');
    await reportTo(emp, mani);
    const plan = await file(emp, [{ task: 'Converted later' }]);
    // Nobody to assign the items to: the employee left after filing.
    await db.run("UPDATE users SET status = 'disabled' WHERE id = ?", [emp.id]);
    const res = await api.post(`/todo-plan/submissions/${plan.id}/approve`, {}, { token: mani.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'APPROVED');
    assert.match(res.body.data.conversion_result.error, /no longer active/);
    assert.equal((await itemsOf(plan.id)).length, 0);
    await db.run("UPDATE users SET status = 'active' WHERE id = ?", [emp.id]);
  });
});

describe('a reporting person who cannot validate stops the conversion', () => {
  test('an inactive reporting person is an error, not a silent swap', async () => {
    const boss = await join('Kavi', 'manager');
    const emp = await join('Nila');
    await reportTo(emp, boss);
    const plan = await file(emp, [{ task: 'Waiting on a reviewer' }]);
    const off = await api.patch(`/users/${boss.id}`, { status: 'disabled' }, { token: ownerToken });
    assert.equal(off.status, 200, JSON.stringify(off.body));
    const res = await convert(plan.id, emp.token);
    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /Kavi is no longer active/);
    assert.equal((await itemsOf(plan.id)).length, 0);
    const view = await api.get(`/todo-plan/submissions/${plan.id}`, { token: emp.token });
    assert.equal(view.body.data.conversion.can_convert, false);
    assert.match(view.body.data.conversion.problem, /no longer active/);
  });

  test('a plan with no reporting person on record is an error', async () => {
    const emp = await join('Ravi2');
    await reportTo(emp, mani);
    const plan = await file(emp, [{ task: 'Nobody to validate' }]);
    await db.run('UPDATE todo_submissions SET reporting_person_id = NULL WHERE id = ?', [plan.id]);
    const res = await convert(plan.id, emp.token);
    assert.equal(res.status, 422);
    assert.match(res.body.error.message, /no reporting person/);
    assert.equal((await itemsOf(plan.id)).length, 0);
  });
});

describe('carry-over leaves converted tasks to Action Items', () => {
  test('the next day, only tasks that are not action items move forward', async () => {
    const plan = await db.get('SELECT id FROM todo_submissions WHERE user_id = ? AND todo_date = ?', [arun.id, target]);
    const added = await api.post(`/todo-plan/submissions/${plan.id}/tasks`, { task: 'Not converted' }, { token: arun.token });
    assert.equal(added.status, 200, JSON.stringify(added.body));
    await P.carryOver(tenantId, addDay(target));
    const carried = (await db.all(
      `SELECT t.task FROM todo_tasks t JOIN todo_submissions s ON s.id = t.submission_id
        WHERE s.user_id = ? AND s.todo_date > ? AND t.carried_from_task_id IS NOT NULL`,
      [arun.id, target],
    )).map((r) => r.task);
    assert.deepEqual(carried, ['Not converted']);
  });
});
