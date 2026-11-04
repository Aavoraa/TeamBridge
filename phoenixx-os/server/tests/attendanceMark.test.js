/**
 * HR marking a day by hand: present on a day nothing was recorded, overriding
 * a recorded day, and the limits - future days, weekly offs, the owner.
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const { todayInTz } = await import('../src/lib/dueTime.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Mark Co', email: 'owner@mark.test' });
const token = owner.access_token;
const ownerId = (await db.get("SELECT id FROM users WHERE email = 'owner@mark.test'")).id;

const join = async (name, email) => {
  const invite = await api.post('/users', { name, email, role: 'employee' }, { token });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken,
    password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invite.body.data.id, token: accepted.body.data.access_token };
};

const dayOffset = (n) => new Date(Date.parse(`${todayInTz('Asia/Kolkata')}T00:00:00Z`) + n * 86_400_000)
  .toISOString().slice(0, 10);
const weekday = (d) => new Date(`${d}T12:00:00Z`).getUTCDay();
// The most recent past working day (Sunday is the default weekly off).
let pastDay = dayOffset(-1);
for (let i = -1; weekday(pastDay) === 0; i -= 1) pastDay = dayOffset(i - 1);
let sunday = dayOffset(-1);
for (let i = -1; weekday(sunday) !== 0; i -= 1) sunday = dayOffset(i - 1);

const e = await join('Ravi', 'ravi@mark.test');
const mark = (body, who = token) => api.post('/hr/attendance/mark', body, { token: who });

describe('HR marks attendance by hand', () => {
  test('a day with nothing recorded can be marked present', async () => {
    const res = await mark({ user_id: e.id, work_date: pastDay, status: 'present', check_in_time: '09:30', note: 'At the client site' });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'present');
    assert.equal(res.body.data.source, 'regularized');
    const reg = await api.get('/hr/attendance/register', { token, query: undefined });
    assert.equal(reg.status, 200);
  });

  test('the same day can be re-marked; one row, every change in the history', async () => {
    const res = await mark({ user_id: e.id, work_date: pastDay, status: 'half_day', note: 'Left at lunch' });
    assert.equal(res.body.data.status, 'half_day');
    const rows = await db.all('SELECT id FROM attendance WHERE user_id = ? AND work_date = ?', [e.id, pastDay]);
    assert.equal(rows.length, 1);
    const events = await db.all('SELECT event, from_status, to_status FROM attendance_events WHERE attendance_id = ? ORDER BY seq', [rows[0].id]);
    assert.deepEqual(events.map((x) => [x.event, x.from_status, x.to_status]),
      [['marked', null, 'present'], ['marked', 'present', 'half_day']]);
  });

  test('a reason is required', async () => {
    assert.equal((await mark({ user_id: e.id, work_date: pastDay, status: 'present', note: '' })).status, 422);
  });

  test('a future day cannot be marked', async () => {
    const res = await mark({ user_id: e.id, work_date: dayOffset(3), status: 'present', note: 'Planned visit' });
    assert.equal(res.status, 400);
  });

  test('a weekly off cannot be marked', async () => {
    const res = await mark({ user_id: e.id, work_date: sunday, status: 'present', note: 'Came in' });
    assert.equal(res.status, 400);
  });

  test('the owner is not on the register', async () => {
    const res = await mark({ user_id: ownerId, work_date: pastDay, status: 'present', note: 'Was here' });
    assert.equal(res.status, 404);
  });

  test('an employee cannot mark anybody, themselves included', async () => {
    const res = await mark({ user_id: e.id, work_date: pastDay, status: 'present', note: 'Trust me' }, e.token);
    assert.equal(res.status, 403);
  });
});
