import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
process.env.ANTHROPIC_API_KEY = ''; // blank, not deleted: dotenv would refill it from server/.env
process.env.ANTHROPIC_AUTH_TOKEN = ''; // blank, not deleted: dotenv would refill it from server/.env

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const assistant = await import('../src/services/taskAssistant.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Voice Co', email: 'owner@voice.test', owner_name: 'Arun Prakash' });
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

let divya; // manager
let priyaR; // Priya Raman, reports to Divya
let priyaS; // Priya Shankar, reports to nobody
let rahul; // reports to Divya
let meera; // finance, reports to nobody

before(async () => {
  divya = await join('Divya Ramesh', 'divya@voice.test', 'manager');
  priyaR = await join('Priya Raman', 'priya.r@voice.test', 'employee', { manager_id: divya.user.id });
  priyaS = await join('Priya Shankar', 'priya.s@voice.test', 'employee');
  rahul = await join('Rahul Kumar', 'rahul@voice.test', 'employee', { manager_id: divya.user.id });
  meera = await join('Meera Iyer', 'meera@voice.test', 'finance');
});

/** The same body the assistant's confirm screen sends. */
const assistantTask = (ownerId, extra = {}) => ({
  title: 'Complete pending client confirmation emails',
  description: 'Follow up on pending emails and get the client to confirm.',
  owner_id: ownerId,
  priority: 'medium',
  source_type: 'voice_assistant',
  ...extra,
});

describe('name matching', () => {
  const people = [
    { id: '1', name: 'Priya Raman' }, { id: '2', name: 'Priya Shankar' },
    { id: '3', name: 'Rahul Kumar' }, { id: '4', name: 'Divya Ramesh' },
  ];
  test('a full name picks exactly one person', () => {
    assert.deepEqual(assistant.matchPerson('Priya Shankar', people).map((p) => p.id), ['2']);
  });
  test('a shared first name returns every match, so the user chooses', () => {
    assert.deepEqual(assistant.matchPerson('Priya', people).map((p) => p.id).sort(), ['1', '2']);
  });
  test('a unique first name, and a one-letter speech slip, still match', () => {
    assert.deepEqual(assistant.matchPerson('rahul', people).map((p) => p.id), ['3']);
    assert.deepEqual(assistant.matchPerson('Divia', people).map((p) => p.id), ['4']);
  });
  test('an unknown name matches nobody', () => {
    assert.deepEqual(assistant.matchPerson('Karthik', people), []);
  });
});

describe('who may use it, and who they may assign', () => {
  test('employees and finance are refused', async () => {
    for (const who of [priyaR, meera]) {
      const res = await api.get('/assistant/task/people', { token: who.token });
      assert.equal(res.status, 403);
    }
  });

  test('the owner can assign anyone active in the workspace, never themselves', async () => {
    const res = await api.get('/assistant/task/people', { token: ownerToken });
    assert.equal(res.status, 200);
    const names = res.body.data.people.map((p) => p.name).sort();
    assert.deepEqual(names, ['Divya Ramesh', 'Meera Iyer', 'Priya Raman', 'Priya Shankar', 'Rahul Kumar']);
    assert.equal(res.body.data.ai, false, 'no API key in tests');
  });

  test('a manager can assign only their own reports', async () => {
    const res = await api.get('/assistant/task/people', { token: divya.token });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.data.people.map((p) => p.name).sort(), ['Priya Raman', 'Rahul Kumar']);
  });
});

describe('interpreting a command', () => {
  test('without an API key it hands back to the built-in parser', async () => {
    const res = await api.post('/assistant/task/interpret',
      { text: 'Ask Priya to complete the pending mails for confirmation to the client' }, { token: ownerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.engine, 'none');
  });

  test('the AI reading is matched against real people, and two Priyas come back as a choice', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    let seen;
    assistant.setAssistantClientForTests({
      beta: {
        messages: {
          create: async (req) => {
            seen = req;
            return {
              stop_reason: 'end_turn',
              content: [{
                type: 'text',
                text: JSON.stringify({
                  is_task: true,
                  title: 'Complete pending client confirmation emails',
                  description: '',
                  assignee_name: 'Priya',
                  priority: 'unspecified',
                  due_date: '',
                  due_time: '',
                  clarification: '',
                }),
              }],
            };
          },
        },
      },
    });
    try {
      const asOwner = await api.post('/assistant/task/interpret',
        { text: 'Hey, create a new task for Priya. She should complete the pending mails for confirmation to the client.' },
        { token: ownerToken });
      assert.equal(asOwner.status, 200, JSON.stringify(asOwner.body));
      const d = asOwner.body.data;
      assert.equal(d.engine, 'ai');
      assert.equal(d.understood, true);
      assert.equal(d.draft.title, 'Complete pending client confirmation emails');
      assert.equal(d.draft.priority, '', 'no priority was said, so none is invented');
      assert.equal(d.draft.due_date, '', 'no date was said, so none is invented');
      assert.deepEqual(d.person.matches.map((p) => p.name).sort(), ['Priya Raman', 'Priya Shankar']);
      assert.equal(seen.output_config.format.type, 'json_schema');
      assert.match(seen.messages[0].content, /<command>/);

      // Divya only manages one Priya, so for her the same sentence is unambiguous.
      const asManager = await api.post('/assistant/task/interpret',
        { text: 'Create a task for Priya to complete the pending client mails' }, { token: divya.token });
      assert.deepEqual(asManager.body.data.person.matches.map((p) => p.name), ['Priya Raman']);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      assistant.setAssistantClientForTests(undefined);
    }
  });

  test('an AI failure falls back instead of erroring', async () => {
    process.env.ANTHROPIC_API_KEY = 'test-key';
    assistant.setAssistantClientForTests({ beta: { messages: { create: async () => { throw new Error('network down'); } } } });
    try {
      const res = await api.post('/assistant/task/interpret', { text: 'Ask Rahul to call the client' }, { token: ownerToken });
      assert.equal(res.status, 200);
      assert.equal(res.body.data.engine, 'none');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
      assistant.setAssistantClientForTests(undefined);
    }
  });
});

describe('creating the confirmed task', () => {
  test('owner to employee: created, recorded, and the employee is notified', async () => {
    const res = await api.post('/action-items', assistantTask(priyaS.user.id), { token: ownerToken });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const item = res.body.data;
    assert.equal(item.owner_id, priyaS.user.id);
    assert.equal(item.created_by, owner.user.id, 'the owner is recorded as the creator');
    assert.equal(item.source_type, 'voice_assistant');

    const notes = await api.get('/notifications', { token: priyaS.token });
    assert.ok(notes.body.data.some((n) => /Complete pending client confirmation emails/.test(`${n.title} ${n.body}`)),
      'the assignee sees it in their notifications');

    const audit = await db.get(
      "SELECT * FROM audit_logs WHERE entity = 'action_item' AND entity_id = ? AND action = 'create'", [item.id],
    );
    assert.equal(audit.actor_id, owner.user.id, 'the audit trail names who created and assigned it');
    assert.match(audit.after_json, /voice_assistant/);
  });

  test('manager to their own report: allowed', async () => {
    const res = await api.post('/action-items', assistantTask(rahul.user.id, { priority: 'high' }), { token: divya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.created_by, divya.user.id);
    const notes = await api.get('/notifications', { token: rahul.token });
    assert.ok(notes.body.data.length > 0);
  });

  test('manager to someone outside their team: refused on the server', async () => {
    const res = await api.post('/action-items', assistantTask(priyaS.user.id), { token: divya.token });
    assert.equal(res.status, 403);
  });

  test('an employee cannot create through the assistant, even by calling the API', async () => {
    const res = await api.post('/action-items', assistantTask(rahul.user.id), { token: priyaR.token });
    assert.equal(res.status, 403);
  });

  test('a repeated confirm with the same key creates one task, not two', async () => {
    const key = crypto.randomUUID();
    const body = assistantTask(priyaR.user.id, { title: 'Prepare the project report' });
    const first = await api.post('/action-items', body, { token: divya.token, headers: { 'Idempotency-Key': key } });
    const second = await api.post('/action-items', body, { token: divya.token, headers: { 'Idempotency-Key': key } });
    assert.equal(first.status, 201);
    assert.equal(second.body.data.id, first.body.data.id);
    const n = await db.pluck("SELECT COUNT(*) FROM action_items WHERE title = 'Prepare the project report'");
    assert.equal(Number(n), 1);
  });

  test('the ordinary task form is unchanged', async () => {
    const res = await api.post('/action-items',
      { title: 'Manual task from the form', owner_id: priyaS.user.id }, { token: divya.token });
    assert.equal(res.status, 201, 'existing behaviour for non-assistant tasks is untouched');
  });
});
