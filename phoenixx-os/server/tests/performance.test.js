import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const { previousMonth } = await import('../src/services/performance.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Score Agency', email: 'owner@score.test' });
const ownerToken = owner.access_token;
const tenantId = (await db.get('SELECT tenant_id FROM users WHERE email = ?', ['owner@score.test'])).tenant_id;
const ownerId = (await db.get('SELECT id FROM users WHERE email = ?', ['owner@score.test'])).id;

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
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

const month = previousMonth();
const addDay = (d, n = 1) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const lastDay = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0)).toISOString().slice(0, 10);
/** Mon-Sat: the workspace default week, Sunday off. */
const workdays = [];
for (let d = `${month}-01`; d <= lastDay; d = addDay(d)) if (new Date(`${d}T12:00:00Z`).getUTCDay() !== 0) workdays.push(d);
const at = (d, hh = '12:00') => `${d}T${hh}:00.000Z`;
const id = () => crypto.randomUUID();

async function task(userId, { title, priority = 'medium', due, done, created = `${month}-01`, status, createdBy = ownerId }) {
  const tid = id();
  await db.run(
    `INSERT INTO action_items (id, tenant_id, title, owner_id, created_by, priority, status, due_date, due_at,
       completed_at, completed_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [tid, tenantId, title, userId, createdBy, priority, status || (done ? 'done' : 'in_progress'),
      due ?? null, due ? at(due, '18:00') : null, done ? at(done, '17:00') : null, done ? userId : null,
      at(created, '09:00'), at(created, '09:00')],
  );
  return tid;
}

let divya; let priya; let rahul; let sanjay;
let leaveDay; let longTask;

before(async () => {
  divya = await join('Divya', 'divya@score.test', 'manager');
  priya = await join('Priya', 'priya@score.test');
  rahul = await join('Rahul', 'rahul@score.test');
  sanjay = await join('Sanjay', 'sanjay@score.test', 'hr');
  await db.run('UPDATE users SET manager_id = ? WHERE id = ?', [divya.user.id, priya.user.id]);
  await db.run('UPDATE users SET manager_id = ? WHERE id = ?', [ownerId, divya.user.id]);

  // Delivery: 4 medium on time, 1 high late, 1 urgent never done.
  const w = workdays;
  for (let i = 0; i < 4; i += 1) await task(priya.user.id, { title: `On time ${i}`, due: w[5 + i], done: w[5 + i] });
  await task(priya.user.id, { title: 'Late one', priority: 'high', due: w[10], done: w[12] });
  await task(priya.user.id, { title: 'Never done', priority: 'urgent', due: w[11] });

  // Quality: three tasks Divya signed off, one after a round of rework.
  for (const [i, rework] of [[0, 0], [1, 0], [2, 1]]) {
    const tid = await task(priya.user.id, { title: `Reviewed ${i}`, created: `${month}-01` });
    await db.run(`UPDATE action_items SET validation_status = 'validated', validated_by = ?, validated_at = ?,
              completed_by = ?, rework_count = ? WHERE id = ?`,
    [divya.user.id, at(w[14 + i]), priya.user.id, rework, tid]);
    // Divya decided each within two hours of it being submitted.
    await db.run(`INSERT INTO action_validations (id, tenant_id, action_item_id, event, actor_id, round, created_at)
            VALUES (?,?,?,?,?,1,?)`, [id(), tenantId, tid, 'submitted', priya.user.id, at(w[14 + i], '10:00')]);
    await db.run(`INSERT INTO action_validations (id, tenant_id, action_item_id, event, actor_id, round, created_at)
            VALUES (?,?,?,?,?,1,?)`, [id(), tenantId, tid, 'validated', divya.user.id, at(w[14 + i], '12:00')]);
  }

  // A long-running task with no due date: open every day, never judged for delivery.
  longTask = await task(priya.user.id, { title: 'Always-on retainer', created: addDay(`${month}-01`, -10) });

  // One approved day of leave, which must vanish from every denominator.
  leaveDay = w[3];
  const leaveType = (await db.get('SELECT id FROM leave_types WHERE tenant_id = ? LIMIT 1', [tenantId])).id;
  await db.run(`INSERT INTO leave_requests (id, tenant_id, user_id, leave_type_id, kind, from_date, to_date, days, reason,
            status, created_at, updated_at) VALUES (?,?,?,?, 'leave', ?, ?, 1, 'Family', 'approved', ?, ?)`,
  [id(), tenantId, priya.user.id, leaveType, leaveDay, leaveDay, at(leaveDay), at(leaveDay)]);

  // Attendance: present every working day except the first (no row = absent)
  // and the leave day; late and unexcused on the second.
  for (const d of w) {
    if (d === w[0] || d === leaveDay) continue;
    const late = d === w[1];
    await db.run(`INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, status, late_minutes, created_at, updated_at)
            VALUES (?,?,?,?,?,?,?,?,?)`,
    [id(), tenantId, priya.user.id, d, at(d, '04:00'), late ? 'pending_approval' : 'present', late ? 25 : 0, at(d), at(d)]);
  }

  // Daily updates on every working day except the leave day and two missed ones.
  for (const d of w) {
    if (d === leaveDay || d === w[7] || d === w[8]) continue;
    await db.run(`INSERT INTO action_updates (id, tenant_id, action_item_id, user_id, update_date, completed_today,
              status_at_update, created_at, updated_at) VALUES (?,?,?,?,?, 'Progress', 'in_progress', ?, ?)`,
    [id(), tenantId, longTask, priya.user.id, d, at(d), at(d)]);
  }
});

const card = async (token, userId) => {
  const res = await api.get(`/hr/performance/scorecard?month=${month}${userId ? `&user_id=${userId}` : ''}`, { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.data;
};
const pillarOf = (c, key) => c.card.pillars.find((p) => p.key === key);
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.11, `${msg}: expected ${b}, got ${a}`);

describe('the employee scorecard', () => {
  test('delivery weighs each task by priority: on time 100%, late 50%, overdue 0', async () => {
    const d = pillarOf(await card(priya.token), 'delivery');
    assert.deepEqual([d.inputs.on_time, d.inputs.late, d.inputs.overdue], [4, 1, 1]);
    // (4 x 1 + 0.5 x 2 + 0 x 3) / (4 + 2 + 3)
    near(d.score, (5 / 9) * 100, 'delivery');
    assert.ok(d.drivers.some((x) => x.text.includes('Never done')), 'the overdue task is named');
  });

  test('quality is the share of reviewed work that passed first time', async () => {
    const q = pillarOf(await card(priya.token), 'quality');
    assert.equal(q.inputs.reviewed, 3);
    near(q.score, (2 / 3) * 100, 'quality');
  });

  test('reporting counts working days with open tasks, skipping leave', async () => {
    const r = pillarOf(await card(priya.token), 'reporting');
    const expected = workdays.length - 1; // the leave day is not a working day for her
    assert.equal(r.inputs.days_expected, expected);
    assert.equal(r.inputs.days_filed, expected - 2);
  });

  test('attendance is 80% presence and 20% punctuality, leave excluded', async () => {
    const a = pillarOf(await card(priya.token), 'attendance');
    const counted = workdays.length - 1;
    const attendance = ((counted - 1) / counted) * 100;
    const punctuality = 100 - (1 / (counted - 1)) * 100;
    assert.equal(a.inputs.working_days, counted);
    assert.equal(a.inputs.unexcused_late, 1);
    near(a.score, attendance * 0.8 + punctuality * 0.2, 'attendance');
  });

  test('the system score is the weighted blend of the pillars that have data', async () => {
    const c = await card(priya.token);
    const have = c.card.pillars.filter((p) => p.score != null);
    const w = have.reduce((n, p) => n + p.weight, 0);
    near(c.card.system_score, have.reduce((n, p) => n + p.score * p.weight, 0) / w, 'system');
    assert.equal(c.card.kind, 'employee');
  });

  test('too little evidence is "not enough data", never zero', async () => {
    const c = await card(ownerToken, rahul.user.id);
    const d = pillarOf(c, 'delivery');
    assert.equal(d.score, null);
    assert.equal(d.status, 'insufficient');
    assert.ok(c.card.coverage_pct < 50);
    assert.equal(c.card.band, null, 'no band on a card that is mostly empty');
  });
});

describe('the manager scorecard', () => {
  test('a manager is scored on their team and their responsiveness too', async () => {
    const c = await card(divya.token);
    assert.equal(c.card.kind, 'manager');
    const team = pillarOf(c, 'team_delivery');
    const priyaCard = await card(ownerToken, priya.user.id);
    const own = (k) => pillarOf(priyaCard, k).score;
    near(team.score, (own('delivery') * 35 + own('quality') * 20) / 55, 'team delivery');

    const resp = pillarOf(c, 'responsiveness');
    assert.equal(resp.inputs.decisions, 3);
    assert.equal(resp.inputs.avg_hours, 2);
    assert.equal(resp.score, 100, 'decided within a day');
    assert.equal(pillarOf(c, 'escalations').score, 100);
  });
});

describe('who sees and who rates', () => {
  test('an employee sees only their own card, with no rank', async () => {
    await api.post('/hr/performance/generate', { month }, { token: ownerToken });
    const list = (await api.get(`/hr/performance?month=${month}`, { token: priya.token })).body.data;
    assert.deepEqual(list.map((r) => r.user_id), [priya.user.id]);
    assert.equal(list[0].rank, null);
    assert.equal((await api.get(`/hr/performance/scorecard?month=${month}&user_id=${rahul.user.id}`, { token: priya.token })).status, 403);
  });

  test('a manager sees their reports, not unrelated staff, and the Owner is never scored', async () => {
    const list = (await api.get(`/hr/performance?month=${month}`, { token: divya.token })).body.data;
    const ids = list.map((r) => r.user_id);
    assert.ok(ids.includes(priya.user.id) && ids.includes(divya.user.id));
    assert.ok(!ids.includes(rahul.user.id));
    const all = (await api.get(`/hr/performance?month=${month}`, { token: ownerToken })).body.data;
    assert.ok(!all.some((r) => r.user_id === ownerId));
    assert.ok(all.every((r, i) => r.overall_score == null || r.rank === i + 1));
  });

  test('the manager rates their report; the rating is 20% of the overall', async () => {
    const review = (await api.get(`/hr/performance?month=${month}&user_id=${priya.user.id}`, { token: divya.token })).body.data[0];
    const res = await api.patch(`/hr/performance/${review.id}`, { manager_rating: 4, status: 'submitted' }, { token: divya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    near(res.body.data.overall_score, review.system_score * 0.8 + 80 * 0.2, 'overall');
  });

  test('nobody rates themselves, and a manager cannot rate outside their team', async () => {
    const mine = (await api.get(`/hr/performance?month=${month}&user_id=${divya.user.id}`, { token: divya.token })).body.data[0];
    assert.equal((await api.patch(`/hr/performance/${mine.id}`, { manager_rating: 5 }, { token: divya.token })).status, 403);
    const rahuls = (await api.get(`/hr/performance?month=${month}&user_id=${rahul.user.id}`, { token: ownerToken })).body.data[0];
    assert.equal((await api.patch(`/hr/performance/${rahuls.id}`, { manager_rating: 5 }, { token: divya.token })).status, 403);
    // The Owner rates the manager.
    assert.equal((await api.patch(`/hr/performance/${mine.id}`, { manager_rating: 4 }, { token: ownerToken })).status, 200);
  });

  test('only the person reviewed can acknowledge, and only once it is submitted', async () => {
    const review = (await api.get(`/hr/performance?month=${month}&user_id=${priya.user.id}`, { token: priya.token })).body.data[0];
    assert.equal((await api.post(`/hr/performance/${review.id}/acknowledge`, {}, { token: divya.token })).status, 403);
    const res = await api.post(`/hr/performance/${review.id}/acknowledge`, {}, { token: priya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'acknowledged');
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(await db.get("SELECT id FROM notifications WHERE user_id = ? AND event_key = 'performance.reviewed'", [priya.user.id]),
      'she was told the review was ready');
  });

  test('recomputing keeps the rating and the status', async () => {
    await api.post('/hr/performance/generate', { month }, { token: ownerToken });
    const review = (await api.get(`/hr/performance?month=${month}&user_id=${priya.user.id}`, { token: ownerToken })).body.data[0];
    assert.equal(review.manager_rating, 4);
    assert.equal(review.status, 'acknowledged');
    assert.ok(review.pillars.length === 5);
  });
});

describe('the weights', () => {
  test('HR can change them; they must add up to 100', async () => {
    const config = (await api.get('/hr/performance/config', { token: priya.token })).body.data;
    assert.equal(config.weights.employee.delivery, 35);
    const bad = { ...config.weights, employee: { ...config.weights.employee, delivery: 50 } };
    assert.equal((await api.put('/hr/performance/config', bad, { token: sanjay.token })).status, 400);
    const good = { ...config.weights, employee: { delivery: 40, quality: 15, reporting: 15, attendance: 15, process: 15 } };
    const res = await api.put('/hr/performance/config', good, { token: sanjay.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(pillarOf(await card(priya.token), 'delivery').weight, 40);
  });

  test('a manager cannot change them', async () => {
    const config = (await api.get('/hr/performance/config', { token: divya.token })).body.data;
    assert.equal((await api.put('/hr/performance/config', config.weights, { token: divya.token })).status, 403);
  });
});
