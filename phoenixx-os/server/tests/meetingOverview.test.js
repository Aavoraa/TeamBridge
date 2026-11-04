import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Overview Co', email: 'owner@ov.test', owner_name: 'Arun Prakash' });
async function join(name, email, role = 'employee', extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: owner.access_token });
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

let divya; let priya; let rahul; let kiran; let sundar;
const ids = {};
const day = (n) => new Date(Date.now() + n * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);

/** A meeting that already happened, with who attended. */
async function pastMeeting(title, hostToken, inviteIds, attendedIds, { department = null, daysAgo = 3 } = {}) {
  const m = (await api.post('/ai-meetings/instant', { title, participant_ids: inviteIds }, { token: hostToken })).body.data;
  const at = new Date(Date.now() - daysAgo * 86_400_000).toISOString();
  const end = new Date(Date.parse(at) + 45 * 60_000).toISOString();
  await db.run(`UPDATE meetings SET status = 'completed', scheduled_at = ?, started_at = ?, ended_at = ?, department = ? WHERE id = ?`,
    [at, at, end, department, m.id]);
  for (const uid of attendedIds) await db.run('UPDATE meeting_attendees SET attended = 1 WHERE meeting_id = ? AND user_id = ?', [m.id, uid]);
  return m;
}

before(async () => {
  divya = await join('Divya Ramesh', 'divya@ov.test', 'manager', { department: 'Delivery' });
  priya = await join('Priya Raman', 'priya@ov.test', 'employee', { manager_id: divya.user.id, department: 'Delivery' });
  rahul = await join('Rahul Kumar', 'rahul@ov.test', 'employee', { manager_id: divya.user.id, department: 'Delivery' });
  kiran = await join('Kiran Das', 'kiran@ov.test', 'manager', { department: 'Sales' });
  sundar = await join('Sundar Rajan', 'sundar@ov.test', 'employee', { manager_id: kiran.user.id, department: 'Sales' });

  // Delivery: one standup (Divya hosts; Priya came, Rahul did not).
  ids.standup = (await pastMeeting('Delivery standup', divya.token, [priya.user.id, rahul.user.id], [divya.user.id, priya.user.id])).id;
  // Sales: Kiran's pipeline review, everyone came. Divya's team was not in it.
  ids.pipeline = (await pastMeeting('Pipeline review', kiran.token, [sundar.user.id], [kiran.user.id, sundar.user.id], { department: 'Sales' })).id;
  // Upcoming: Divya schedules a client call for next week.
  ids.upcoming = (await api.post('/ai-meetings', { title: 'Client call', date: day(3), time: '11:00', duration_minutes: 30, participant_ids: [priya.user.id] },
    { token: divya.token })).body.data.id;
  // A meeting that was never started (its slot is over): missed.
  const missed = (await api.post('/ai-meetings/instant', { title: 'Nobody came', participant_ids: [rahul.user.id] }, { token: divya.token })).body.data;
  await db.run('UPDATE meetings SET scheduled_at = ? WHERE id = ?', [new Date(Date.now() - 2 * 86_400_000).toISOString(), missed.id]);

  // The standup was recorded and analysed: one summary, two proposed tasks.
  const ai = crypto.randomUUID();
  const ts = new Date().toISOString();
  const tenant = (await db.get('SELECT tenant_id FROM meetings WHERE id = ?', [ids.standup])).tenant_id;
  await db.run(
    `INSERT INTO ai_meetings (id, tenant_id, title, meeting_date, source_kind, consent_by, consent_at, status, summary_json, uploaded_by, created_at, updated_at)
     VALUES (?,?,?,?,'live',?,?,'review',?,?,?,?)`,
    [ai, tenant, 'Delivery standup', day(-3), divya.user.id, ts, JSON.stringify({ overview: 'Sprint status and blockers.', decisions: ['Ship on Friday'] }), divya.user.id, ts, ts],
  );
  for (const [n, t] of ['Fix the login bug', 'Update the client'].entries()) {
    await db.run(
      `INSERT INTO ai_meeting_items (id, tenant_id, meeting_id, idx, title, assignee_status, acceptance, deadline_status, confidence, status, evidence_json, created_at, updated_at)
       VALUES (?,?,?,?,?,'unassigned','unclear','none','high','proposed','{}',?,?)`, [crypto.randomUUID(), tenant, ai, n, t, ts, ts],
    );
  }
  await db.run('UPDATE meetings SET ai_meeting_id = ? WHERE id = ?', [ai, ids.standup]);
  ids.ai = ai;
});

const overview = (token, q = '') => api.get(`/ai-meetings/overview${q}`, { token });

describe('the owner sees the whole company', () => {
  test('totals, departments, participation, summaries and approvals', async () => {
    const res = await overview(owner.access_token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const d = res.body.data;
    assert.equal(d.scope, 'company');
    assert.equal(d.days, 30);
    assert.equal(d.totals.completed, 2);
    assert.equal(d.totals.upcoming, 1);
    assert.equal(d.totals.missed, 1);
    assert.equal(d.totals.hours, 1.5, 'two 45-minute meetings');
    // Invited: Divya+Priya+Rahul at the standup, Kiran+Sundar at the review = 5; attended 4.
    assert.deepEqual([d.totals.invited, d.totals.attended, d.totals.attendance_rate], [5, 4, 80]);

    const delivery = d.by_department.find((x) => x.department === 'Delivery');
    const sales = d.by_department.find((x) => x.department === 'Sales');
    assert.deepEqual([delivery.completed, delivery.upcoming, delivery.missed, delivery.invited, delivery.attended], [1, 1, 1, 3, 2],
      'a meeting with no department counts under its host\'s department');
    assert.deepEqual([sales.completed, sales.attendance_rate], [1, 100]);

    assert.equal(d.participation[0].name, 'Rahul Kumar', 'lowest attendance first');
    assert.equal(d.participation[0].attendance_rate, 0);

    assert.equal(d.summaries.length, 1);
    assert.equal(d.summaries[0].overview, 'Sprint status and blockers.');
    assert.equal(d.summaries[0].live_meeting_id, ids.standup);
    assert.equal(d.summaries[0].pending, 2);
    assert.deepEqual(d.approvals.map((a) => [a.title, a.pending]), [['Delivery standup', 2]]);
  });

  test("a department's meetings list includes meetings that take the host's department", async () => {
    const list = (await api.get('/ai-meetings?tab=history&department=Delivery', { token: owner.access_token })).body.data;
    assert.ok(list.some((m) => m.id === ids.standup), 'the standup has no department of its own; Divya is in Delivery');
    assert.ok(!list.some((m) => m.id === ids.pipeline));
  });

  test('the period can be 7, 30 or 90 days', async () => {
    assert.equal((await overview(owner.access_token, '?days=90')).body.data.days, 90);
    assert.equal((await overview(owner.access_token, '?days=12')).body.data.days, 30, 'anything else falls back to 30');
  });
});

describe('a manager sees their own scope', () => {
  test("Divya sees her team's meetings and approvals, not Sales", async () => {
    const d = (await overview(divya.token)).body.data;
    assert.equal(d.scope, 'team');
    assert.deepEqual(d.by_department.map((x) => x.department), ['Delivery']);
    assert.ok(!d.participation.some((p) => p.name === 'Sundar Rajan'));
    assert.equal(d.approvals.length, 1);
    const dash = (await api.get('/ai-meetings/dashboard', { token: divya.token })).body.data;
    assert.equal(dash.pending_approvals, 2, 'the dashboard count agrees with the approval queue');
  });

  test("Kiran sees Sales only, and not Divya's analysed standup", async () => {
    const d = (await overview(kiran.token)).body.data;
    assert.deepEqual(d.by_department.map((x) => x.department), ['Sales']);
    assert.equal(d.summaries.length, 0);
    assert.equal(d.approvals.length, 0);
    assert.equal((await api.get('/ai-meetings/dashboard', { token: kiran.token })).body.data.pending_approvals, 0);
  });
});

describe('employees', () => {
  test('have their own dashboard, not the overview', async () => {
    assert.equal((await overview(priya.token)).status, 403);
    assert.equal((await api.get('/ai-meetings/dashboard', { token: priya.token })).status, 200);
  });
});

describe('projects', () => {
  test("a project's meetings can be listed for its page", async () => {
    const client = (await api.post('/crm/clients', { name: 'Sunrise Foods' }, { token: owner.access_token })).body.data;
    const res = await api.post('/projects', { client_id: client.id, name: 'Sunrise launch', manager_id: divya.user.id }, { token: owner.access_token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const project = res.body.data.id;
    await db.run('UPDATE meetings SET project_id = ? WHERE id = ?', [project, ids.upcoming]);
    const list = (await api.get(`/ai-meetings?tab=upcoming&project_id=${project}`, { token: owner.access_token })).body.data;
    assert.deepEqual(list.map((m) => m.id), [ids.upcoming]);
  });
});
