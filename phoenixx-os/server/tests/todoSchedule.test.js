import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const { todoTick } = await import('../src/services/todoPlan.js');
const { localToUtc } = await import('../src/lib/dueTime.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Plan Agency', email: 'owner@plan.test' });
const ownerToken = owner.access_token;
const ownerRow = await db.get('SELECT id, tenant_id FROM users WHERE email = ?', ['owner@plan.test']);
const tenantId = ownerRow.tenant_id;

async function join(name, email, role = 'employee') {
  const invite = await api.post('/users', { name, email, role }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invite.body.data.id, token: accepted.body.data.access_token };
}

async function person(name, managerId = null) {
  const id = crypto.randomUUID();
  await db.run(
    `INSERT INTO users (id, tenant_id, email, password_hash, name, role, manager_id, status, created_at, updated_at)
     VALUES (?,?,?,?,?, 'employee', ?, 'active', ?, ?)`,
    [id, tenantId, `${name.toLowerCase()}@plan.test`, 'x', name, managerId, new Date().toISOString(), new Date().toISOString()],
  );
  return id;
}

/** Runs the clock at a workspace-local wall time. */
const at = (day, hhmm, tz = 'Asia/Kolkata') => todoTick([tenantId], localToUtc(day, hhmm, tz));

const inbox = async (userId, eventKey) => (await db.all(
  "SELECT * FROM notifications WHERE tenant_id = ? AND user_id = ? AND event_key = ? AND channel = 'in_app' ORDER BY created_at",
  [tenantId, userId, eventKey],
)).map((n) => ({ ...n, meta: JSON.parse(n.meta || '{}') }));

const statusOf = async (userId, day) => (await db.get(
  'SELECT status FROM todo_submissions WHERE tenant_id = ? AND user_id = ? AND todo_date = ?', [tenantId, userId, day],
))?.status;

let mani; let kumar; let arun; let devi;

before(async () => {
  mani = await join('Mani', 'mani@plan.test', 'manager');
  kumar = await person('Kumar', mani.id);
  arun = await person('Arun', mani.id);
  devi = await person('Devi'); // no reporting person: falls back to the owner
  // Mon-Fri, so Friday's plan is Monday's.
  const res = await api.put('/todo-plan/settings', { enabled: true, working_days: [1, 2, 3, 4, 5] }, { token: ownerToken });
  assert.equal(res.status, 200, JSON.stringify(res.body));
});

describe('settings', () => {
  test('a workspace that has not switched it on gets nothing', async () => {
    await db.run('UPDATE tenants SET todo_settings = NULL WHERE id = ?', [tenantId]);
    await at('2026-10-05', '17:31');
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND event_key LIKE 'todo.%'", [tenantId])).n, 0);
    await api.put('/todo-plan/settings', { enabled: true, working_days: [1, 2, 3, 4, 5] }, { token: ownerToken });
  });

  test('only someone who can edit settings may change the schedule', async () => {
    const res = await api.put('/todo-plan/settings', { open_time: '16:00' }, { token: mani.token });
    assert.equal(res.status, 403);
  });

  test('the schedule must run in order', async () => {
    const res = await api.put('/todo-plan/settings', { reminder_time: '18:30' }, { token: ownerToken });
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /open < reminder < deadline < escalation/);
  });

  test('every signed-in person can read the window', async () => {
    const res = await api.get('/todo-plan/schedule', { token: mani.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.settings.deadline_time, '18:00');
    assert.deepEqual(res.body.data.settings.working_days, [1, 2, 3, 4, 5]);
    assert.equal(res.body.data.can_edit_settings, false);
  });

  test('changes are written to the audit log', async () => {
    assert.ok(await db.get("SELECT id FROM audit_logs WHERE tenant_id = ? AND entity = 'todo_settings'", [tenantId]));
  });
});

describe('a working day (Tue 6 Oct 2026)', () => {
  test('nothing goes out before the submission time', async () => {
    await at('2026-10-06', '17:00');
    assert.equal((await inbox(kumar, 'todo.submission_open')).length, 0);
  });

  test('at the submission time every planner is told, for the next working day', async () => {
    await at('2026-10-06', '17:31');
    for (const id of [kumar, arun, devi, mani.id]) {
      const n = await inbox(id, 'todo.submission_open');
      assert.equal(n.length, 1);
      assert.equal(n[0].meta.todo_date, '2026-10-07');
    }
    assert.equal((await inbox(ownerRow.id, 'todo.submission_open')).length, 0, 'owners do not file plans');
  });

  test('re-running the clock sends nothing twice', async () => {
    await at('2026-10-06', '17:35');
    assert.equal((await inbox(kumar, 'todo.submission_open')).length, 1);
  });

  test('the reminder skips anyone who has already submitted', async () => {
    await db.run(
      `INSERT INTO todo_submissions (id, tenant_id, user_id, reporting_person_id, todo_date, plan_date, status, submitted_at, created_at, updated_at)
       VALUES (?,?,?,?, '2026-10-07', '2026-10-06', 'SUBMITTED', ?, ?, ?)`,
      [crypto.randomUUID(), tenantId, arun, mani.id, new Date().toISOString(), new Date().toISOString(), new Date().toISOString()],
    );
    await at('2026-10-06', '17:51');
    assert.equal((await inbox(kumar, 'todo.reminder')).length, 1);
    assert.equal((await inbox(arun, 'todo.reminder')).length, 0);
  });

  test('after the deadline an unfiled plan is OVERDUE', async () => {
    await at('2026-10-06', '18:01');
    assert.equal(await statusOf(kumar, '2026-10-07'), 'OVERDUE');
    assert.equal(await statusOf(arun, '2026-10-07'), 'SUBMITTED');
    assert.equal((await inbox(kumar, 'todo.overdue')).length, 1);
    assert.equal((await inbox(mani.id, 'todo.escalation')).length, 0, 'escalation waits for its own time');
  });

  test('at escalation time each reporting person hears about their own people', async () => {
    await at('2026-10-06', '18:16');
    const toMani = await inbox(mani.id, 'todo.escalation');
    assert.equal(toMani.length, 1);
    assert.match(toMani[0].body, /Kumar/);
    assert.match(toMani[0].body, /6:00 PM/);

    // Devi and Mani have no reporting person, so the owner hears about them - and only them.
    const toOwner = (await inbox(ownerRow.id, 'todo.escalation')).map((n) => n.meta.person).sort();
    assert.deepEqual(toOwner, ['Devi', 'Mani']);
  });

  test('when the planned day arrives, an unfiled plan becomes MISSED', async () => {
    await at('2026-10-07', '00:05');
    assert.equal(await statusOf(kumar, '2026-10-07'), 'MISSED');
    assert.equal(await statusOf(arun, '2026-10-07'), 'SUBMITTED');
  });
});

describe('the working calendar', () => {
  test("Friday's plan is for Monday", async () => {
    await at('2026-10-09', '17:31');
    const open = (await inbox(kumar, 'todo.submission_open')).at(-1);
    assert.equal(open.meta.todo_date, '2026-10-12');
  });

  test('nothing goes out on a day off', async () => {
    const before = (await inbox(kumar, 'todo.submission_open')).length;
    await at('2026-10-10', '17:31');
    await at('2026-10-10', '18:16');
    assert.equal((await inbox(kumar, 'todo.submission_open')).length, before);
  });

  test('a holiday is skipped when working out the target day', async () => {
    await db.run(
      `INSERT INTO holidays (id, tenant_id, holiday_date, name, created_at, updated_at)
       VALUES (?,?, '2026-10-13', 'Test holiday', ?, ?)`,
      [crypto.randomUUID(), tenantId, new Date().toISOString(), new Date().toISOString()],
    );
    await at('2026-10-12', '17:31');
    assert.equal((await inbox(kumar, 'todo.submission_open')).at(-1).meta.todo_date, '2026-10-14');
  });

  test('nothing goes out on the holiday itself', async () => {
    const before = (await inbox(kumar, 'todo.submission_open')).length;
    await at('2026-10-13', '17:31');
    assert.equal((await inbox(kumar, 'todo.submission_open')).length, before);
  });
});

describe('timezone', () => {
  test('the schedule follows the workspace clock, not the server', async () => {
    await db.run("UPDATE tenants SET timezone = 'Europe/London' WHERE id = ?", [tenantId]);
    try {
      const before = (await inbox(kumar, 'todo.submission_open')).length;
      await at('2026-10-14', '17:31', 'Asia/Kolkata'); // 13:01 in London: not open yet
      assert.equal((await inbox(kumar, 'todo.submission_open')).length, before);
      await at('2026-10-14', '17:31', 'Europe/London');
      assert.equal((await inbox(kumar, 'todo.submission_open')).length, before + 1);
    } finally {
      await db.run("UPDATE tenants SET timezone = 'Asia/Kolkata' WHERE id = ?", [tenantId]);
    }
  });
});

describe('reporting person changes', () => {
  test("after the owner reassigns someone, the next escalation goes to the new person", async () => {
    const meena = await person('Meena');
    await db.run('UPDATE users SET manager_id = ? WHERE id = ?', [meena, kumar]);
    await at('2026-10-15', '18:16');
    assert.equal((await inbox(meena, 'todo.escalation')).at(-1)?.meta.person, 'Kumar');
    const maniToday = (await inbox(mani.id, 'todo.escalation')).filter((n) => n.meta.todo_date === '2026-10-16');
    assert.deepEqual(maniToday.map((n) => n.meta.person), ['Arun'], 'Mani still hears about Arun, no longer about Kumar');
  });
});

describe('HR and Finance logins do not file a To-Do', () => {
  test('they get no reminders, and the server refuses a plan from them', async () => {
    const hr = await join('Hema', 'hema@plan.test', 'hr');
    const fin = await join('Farook', 'farook@plan.test', 'finance');
    await at('2026-10-20', '17:31');
    for (const id of [hr.id, fin.id]) assert.equal((await inbox(id, 'todo.submission_open')).length, 0);
    assert.ok((await inbox(kumar, 'todo.submission_open')).some((n) => n.meta.todo_date === '2026-10-21'), 'employees still are');

    const mine = await api.get('/todo-plan/mine', { token: hr.token });
    assert.equal(mine.body.data.expected, false);
    const res = await api.put('/todo-plan/mine/2030-01-01', { tasks: [{ task: 'x' }] }, { token: fin.token });
    assert.equal(res.status, 403);
  });
});
