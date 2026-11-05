import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Cal Co', email: 'owner@cal.test', owner_name: 'Arun Prakash' });
const ownerAuth = { token: owner.access_token };
async function join(name, email, role = 'employee') {
  const invite = await api.post('/users', { name, email, role }, ownerAuth);
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const ok = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  return { user: invite.body.data, auth: { token: ok.body.data.access_token } };
}

let priya; let rahul; let tenantId;
before(async () => {
  priya = await join('Priya Raman', 'priya@cal.test');
  rahul = await join('Rahul Kumar', 'rahul@cal.test');
  tenantId = (await db.get('SELECT tenant_id FROM users WHERE id = ?', [priya.user.id])).tenant_id;
});

const range = '/calendar?from=2030-03-01&to=2030-03-31';

test('anyone on the team adds an event; everyone sees it; the team can be told', async () => {
  const res = await api.post('/calendar/events', {
    title: 'Team lunch', category: 'celebration', all_day: false, start_date: '2030-03-14', start_time: '13:00', end_time: '14:30',
    location: 'Annapoorna, RS Puram', notify_team: true,
  }, priya.auth);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.end_date, '2030-03-14');
  assert.equal(res.body.data.created_by_name, 'Priya Raman');

  const seen = await api.get(range, rahul.auth);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.data.events.length, 1);
  assert.equal(seen.body.data.events[0].title, 'Team lunch');
  assert.equal(seen.body.data.events[0].can_delete, false, 'only the creator or a lead deletes');

  const notes = await db.all("SELECT user_id, title FROM notifications WHERE event_key = 'calendar.event_added'");
  assert.deepEqual(notes.map((n) => n.user_id).sort(), [owner.user.id, rahul.user.id].sort(), 'everyone but the person who added it');
  assert.match(notes[0].title, /On the office calendar: Team lunch/);
});

test('anyone can edit; the change records who made it', async () => {
  const id = (await api.get(range, rahul.auth)).body.data.events[0].id;
  const res = await api.patch(`/calendar/events/${id}`, { start_date: '2030-03-15', start_time: '12:30' }, rahul.auth);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.start_date, '2030-03-15');
  assert.equal(res.body.data.end_date, '2030-03-15', 'a one-day event moves, it does not stretch');
  assert.equal(res.body.data.start_time, '12:30');
  assert.equal(res.body.data.updated_by_name, 'Rahul Kumar');
  const bad = await api.patch(`/calendar/events/${id}`, { end_time: '11:00' }, rahul.auth);
  assert.equal(bad.status, 400);
});

test('deleting is for the creator or a lead', async () => {
  const id = (await api.get(range, rahul.auth)).body.data.events[0].id;
  assert.equal((await api.del(`/calendar/events/${id}`, rahul.auth)).status, 403);
  const ownerView = await api.get(range, ownerAuth);
  assert.equal(ownerView.body.data.events[0].can_delete, true);
  assert.equal((await api.del(`/calendar/events/${id}`, priya.auth)).status, 200);
  assert.equal((await api.get(range, rahul.auth)).body.data.events.length, 0);
});

test('multi-day and all-day events show on every day they cover; bad ranges are refused', async () => {
  await api.post('/calendar/events', { title: 'Offsite', start_date: '2030-02-27', end_date: '2030-03-02' }, priya.auth);
  const march = await api.get(range, priya.auth);
  assert.equal(march.body.data.events[0].title, 'Offsite', 'an event that started last month still shows');
  assert.equal(march.body.data.events[0].all_day, true);
  assert.equal((await api.post('/calendar/events', { title: 'Backwards', start_date: '2030-03-05', end_date: '2030-03-01' }, priya.auth)).status, 400);
  assert.equal((await api.post('/calendar/events', { title: 'No time', all_day: false, start_date: '2030-03-05' }, priya.auth)).status, 400);
  assert.equal((await api.get('/calendar?from=2030-01-01&to=2030-12-31', priya.auth)).status, 400);
});

test('holidays, who is on leave, and your own meetings show alongside', async () => {
  const ts = new Date().toISOString();
  await db.run('INSERT INTO holidays (id, tenant_id, holiday_date, name, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    [crypto.randomUUID(), tenantId, '2030-03-29', 'Good Friday', ts, ts]);
  const lt = await db.get('SELECT id FROM leave_types WHERE tenant_id = ? LIMIT 1', [tenantId]);
  await db.run(`INSERT INTO leave_requests (id, tenant_id, user_id, leave_type_id, from_date, to_date, days, reason, status, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [crypto.randomUUID(), tenantId, rahul.user.id, lt.id, '2030-03-18', '2030-03-19', 2, 'Family function', 'approved', ts, ts]);
  const mtg = await api.post('/ai-meetings', {
    title: 'Sprint review', date: '2030-03-20', time: '11:00', duration_minutes: 30, participant_ids: [priya.user.id],
  }, ownerAuth);
  assert.equal(mtg.status, 201, JSON.stringify(mtg.body));

  const p = (await api.get(range, priya.auth)).body.data;
  assert.deepEqual(p.holidays.map((h) => h.name), ['Good Friday']);
  assert.deepEqual(p.leave.map((l) => [l.name, l.from_date, l.to_date]), [['Rahul Kumar', '2030-03-18', '2030-03-19']]);
  assert.equal(p.leave[0].reason, undefined, 'the reason for leave is private');
  assert.deepEqual(p.meetings.map((m) => m.title), ['Sprint review']);
  const r = (await api.get(range, rahul.auth)).body.data;
  assert.equal(r.meetings.length, 0, 'meetings are only the ones you are on');
});
