import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Request Co', email: 'owner@request.test', owner_name: 'Asha Owner' });
const ownerToken = owner.access_token;

async function join(name, email, role = 'employee', extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Main Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

let mgr; let lead; let emp; let other; let hr; let lone; let projectId;
before(async () => {
  mgr = await join('Manoj Manager', 'manoj@request.test', 'manager');
  lead = await join('Lata Lead', 'lata@request.test', 'employee', { manager_id: mgr.user.id });
  emp = await join('Esha Employee', 'esha@request.test', 'employee', { manager_id: mgr.user.id });
  other = await join('Omar Other', 'omar@request.test', 'employee');
  hr = await join('Hari HR', 'hari@request.test', 'hr');
  lone = await join('Leela Lone', 'leela@request.test', 'employee');
  const p = await api.post('/projects', {
    client_name: 'Sunrise Foods', name: 'Website rebuild', lead_id: lead.user.id, owner_ids: [owner.user.id],
  }, { token: ownerToken });
  assert.equal(p.status, 201, JSON.stringify(p.body));
  projectId = p.body.data.id;
  for (const who of [emp, lone]) {
    const m = await api.post(`/projects/${projectId}/members`, { user_id: who.user.id, seat: 'member' }, { token: ownerToken });
    assert.equal(m.status, 201, JSON.stringify(m.body));
  }
});

const ask = (who, body) => api.post('/task-requests', { title: 'Write the launch checklist', ...body }, { token: who.token });

describe('only owners and managers assign work to others', () => {
  test('an employee cannot assign a colleague', async () => {
    const res = await api.post('/action-items', { title: 'Help me', owner_id: other.user.id }, { token: emp.token });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /request a task/i);
  });

  test('HR and finance cannot either, even though they can see everyone', async () => {
    const res = await api.post('/action-items', { title: 'Collect forms', owner_id: emp.user.id }, { token: hr.token });
    assert.equal(res.status, 403);
  });

  test('an employee cannot hand their task to someone else afterwards', async () => {
    const item = (await api.post('/action-items', { title: 'Mine', owner_id: emp.user.id }, { token: mgr.token })).body.data;
    const res = await api.patch(`/action-items/${item.id}`, { owner_id: other.user.id }, { token: emp.token });
    assert.equal(res.status, 403);
    const bulk = await api.post('/action-items/bulk', { ids: [item.id], patch: { owner_id: other.user.id } }, { token: emp.token });
    assert.equal(bulk.status, 403);
  });

  test('a manager assigns their reports, not people outside their team', async () => {
    assert.equal((await api.post('/action-items', { title: 'Yours', owner_id: emp.user.id }, { token: mgr.token })).status, 201);
    assert.equal((await api.post('/action-items', { title: 'Not yours', owner_id: other.user.id }, { token: mgr.token })).status, 403);
  });

  test('the owner assigns anyone', async () => {
    assert.equal((await api.post('/action-items', { title: 'Anyone', owner_id: other.user.id }, { token: ownerToken })).status, 201);
  });

  test('private to-dos stay open to everyone', async () => {
    assert.equal((await api.post('/todos', { title: 'Call the bank' }, { token: emp.token })).status, 201);
  });
});

describe('requesting a task for yourself', () => {
  test('it goes to the reporting manager and the project lead, and they are told', async () => {
    const res = await ask(emp, { project_id: projectId, due_date: '2030-01-15', due_time: '15:00', priority: 'high' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const r = res.body.data;
    assert.equal(r.status, 'pending');
    assert.deepEqual(r.approvers.map((a) => a.name).sort(), ['Lata Lead', 'Manoj Manager']);
    for (const who of [mgr, lead]) {
      const notes = (await api.get('/notifications', { token: who.token })).body.data;
      assert.ok(notes.some((n) => /Write the launch checklist/.test(`${n.title} ${n.body}`)));
      const box = (await api.get('/task-requests?box=review', { token: who.token })).body.data;
      assert.ok(box.some((x) => x.id === r.id));
      assert.equal((await api.get('/task-requests/count', { token: who.token })).body.data.review >= 1, true);
    }
    // Nobody else's review list shows it.
    assert.ok(!(await api.get('/task-requests?box=review', { token: other.token })).body.data.some((x) => x.id === r.id));
  });

  test('the team lead approves it: it becomes the employee\'s task, raised by the lead', async () => {
    const r = (await ask(emp, { title: 'Fix the footer links', project_id: projectId, due_date: '2030-01-16' })).body.data;
    const res = await api.post(`/task-requests/${r.id}/approve`, { priority: 'urgent' }, { token: lead.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const item = res.body.data.action_item;
    assert.equal(item.owner_id, emp.user.id);
    assert.equal(item.created_by, lead.user.id, 'the approver signs the work off later');
    assert.equal(item.priority, 'urgent');
    assert.equal(item.project_id, projectId);
    assert.equal(item.source_type, 'task_request');
    const mine = (await api.get('/task-requests', { token: emp.token })).body.data.find((x) => x.id === r.id);
    assert.equal(mine.status, 'approved');
    assert.equal(mine.decided_by_name, 'Lata Lead');
    const notes = (await api.get('/notifications', { token: emp.token })).body.data;
    assert.ok(notes.some((n) => /approved/i.test(n.title) && /Fix the footer links/.test(n.title)));
    // The manager is too late: one request, one task.
    assert.equal((await api.post(`/task-requests/${r.id}/approve`, {}, { token: mgr.token })).status, 409);
  });

  test('rejecting needs a reason, which the employee sees', async () => {
    const r = (await ask(emp, { title: 'Redesign the logo' })).body.data;
    assert.deepEqual(r.approvers.map((a) => a.name), ['Manoj Manager'], 'no project: the reporting manager only');
    assert.equal((await api.post(`/task-requests/${r.id}/reject`, {}, { token: mgr.token })).status, 422);
    const res = await api.post(`/task-requests/${r.id}/reject`, { note: 'Not this quarter' }, { token: mgr.token });
    assert.equal(res.status, 200);
    const mine = (await api.get('/task-requests', { token: emp.token })).body.data.find((x) => x.id === r.id);
    assert.equal(mine.status, 'rejected');
    assert.equal(mine.decision_note, 'Not this quarter');
  });

  test('people it was not sent to cannot decide it; the requester cannot approve their own', async () => {
    const r = (await ask(emp, { title: 'Update the sitemap' })).body.data;
    assert.equal((await api.post(`/task-requests/${r.id}/approve`, {}, { token: other.token })).status, 403);
    assert.equal((await api.post(`/task-requests/${r.id}/approve`, {}, { token: emp.token })).status, 403);
    assert.equal((await api.post(`/task-requests/${r.id}/withdraw`, {}, { token: other.token })).status, 403);
    assert.equal((await api.post(`/task-requests/${r.id}/withdraw`, {}, { token: emp.token })).status, 200);
    assert.equal((await api.post(`/task-requests/${r.id}/approve`, {}, { token: mgr.token })).status, 409);
  });

  test('with no manager and no project lead, the owner decides', async () => {
    const r = (await ask(other, { title: 'Archive old files' })).body.data;
    assert.deepEqual(r.approvers.map((a) => a.name), ['Asha Owner']);
    const res = await api.post(`/task-requests/${r.id}/approve`, {}, { token: ownerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.action_item.owner_id, other.user.id);
  });

  test('a request can only be for a project you are on', async () => {
    assert.equal((await ask(other, { project_id: projectId })).status, 400);
    const projects = (await api.get('/task-requests/projects', { token: emp.token })).body.data;
    assert.deepEqual(projects.map((p) => p.name), ['Website rebuild']);
  });

  test('nobody can forge a task as an approved request', async () => {
    const res = await api.post('/action-items', { title: 'Forged', owner_id: emp.user.id, source_type: 'task_request' }, { token: mgr.token });
    assert.equal(res.status, 422);
  });
});

describe('the approver edits a request before approving it', () => {
  test('the task goes on their list as edited, and the request remembers what changed', async () => {
    const asked = await ask(emp, { title: 'Write launch checklist', description: 'draft', priority: 'low' });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
    const id = asked.body.data.id;
    const res = await api.post(`/task-requests/${id}/approve`, {
      title: 'Write the launch checklist for Sunrise Foods',
      description: 'Cover payments, SEO and analytics.',
      priority: 'high',
    }, { token: mgr.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const item = res.body.data.action_item;
    assert.equal(item.title, 'Write the launch checklist for Sunrise Foods');
    assert.equal(item.description, 'Cover payments, SEO and analytics.');
    assert.equal(item.priority, 'high');
    assert.equal(item.owner_id, emp.user.id, 'still their task');
    assert.deepEqual(Object.keys(res.body.data.approved_changes).sort(), ['description', 'priority', 'title']);
    assert.equal(res.body.data.approved_changes.title.from, 'Write launch checklist');

    const mine = (await api.get('/task-requests?box=mine&status=all', { token: emp.token })).body.data.find((r) => r.id === id);
    assert.equal(mine.title, 'Write the launch checklist for Sunrise Foods');
    assert.ok(mine.approved_changes.priority);
  });

  test('approving as asked records no changes', async () => {
    const asked = await ask(emp, { title: 'Book the venue' });
    const res = await api.post(`/task-requests/${asked.body.data.id}/approve`, {}, { token: mgr.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.approved_changes, null);
  });

  test('an edit cannot blank the task', async () => {
    const asked = await ask(emp, { title: 'Send the brief' });
    const res = await api.post(`/task-requests/${asked.body.data.id}/approve`, { title: ' ' }, { token: mgr.token });
    assert.equal(res.status, 422);
    const still = (await api.get('/task-requests?box=mine&status=all', { token: emp.token })).body.data.find((r) => r.id === asked.body.data.id);
    assert.equal(still.status, 'pending');
  });
});
