/**
 * Checking in again after checking out - stepping out on a permission and
 * coming back. Hours add up across sessions, the break is not counted, the
 * first check-in stays the record lateness was judged on.
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const { timeInTz } = await import('../src/lib/dueTime.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Session Co', email: 'owner@session.test' });
const token = owner.access_token;

let n = 0;
const employee = async () => {
  n += 1;
  const invite = await api.post('/users', { name: `Worker ${n}`, email: `w${n}@session.test`, role: 'employee' }, { token });
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken,
    password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  return { id: invite.body.data.id, token: accepted.body.data.access_token };
};

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const inn = (e) => api.post('/hr/attendance/check-in', {}, { token: e.token, headers: { 'X-Forwarded-For': '8.8.8.8' } });
const out = (e) => api.post('/hr/attendance/check-out', {}, { token: e.token });

// On time for everybody here: the shift starts now.
const now = timeInTz('Asia/Kolkata');
await api.patch('/hr/work-schedules', { work_start: now < '23:00' ? now : '23:00', work_end: '23:59' }, { token });

describe('checking in again after checking out', () => {
  test('a second session adds its hours; the break is not counted', async () => {
    const e = await employee();
    const first = (await inn(e)).body.data;
    await out(e);
    // First session: 2h ago to 1h ago = 60 min.
    await db.run('UPDATE attendance SET check_in_at = ?, check_out_at = ?, work_minutes = 60 WHERE id = ?',
      [ago(120), ago(60), first.id]);

    const back = await inn(e);
    assert.equal(back.status, 200, JSON.stringify(back.body));
    assert.equal(back.body.data.checked_in_again, true);
    assert.equal(back.body.data.check_out_at, null);
    assert.equal(back.body.data.check_in_at, (await db.get('SELECT check_in_at FROM attendance WHERE id = ?', [first.id])).check_in_at,
      'the first check-in stays the record');
    assert.match(back.body.data.message, /1h 00m already logged/);

    // Second session started 30 min ago.
    await db.run('UPDATE attendance SET session_started_at = ? WHERE id = ?', [ago(30), first.id]);
    const done = await out(e);
    assert.equal(done.body.data.work_minutes, 90, '60 + 30, not the 120 since the first check-in');
    assert.equal(done.body.data.status, 'half_day');

    const events = await db.all('SELECT event FROM attendance_events WHERE attendance_id = ? ORDER BY seq', [first.id]);
    assert.deepEqual(events.map((x) => x.event), ['checked_in', 'checked_out', 'checked_in_again', 'checked_out']);
    assert.equal((await db.all('SELECT id FROM attendance WHERE user_id = ?', [e.id])).length, 1, 'still one row for the day');
  });

  test('pressing check-in during a session is still a no-op', async () => {
    const e = await employee();
    await inn(e);
    const again = await inn(e);
    assert.equal(again.body.data.already_checked_in, true);
  });

  test('a half day becomes a day in progress again on return', async () => {
    const e = await employee();
    const first = (await inn(e)).body.data;
    await out(e);
    assert.equal((await db.get('SELECT status FROM attendance WHERE id = ?', [first.id])).status, 'half_day');
    const back = await inn(e);
    assert.equal(back.body.data.status, 'present');
  });

  test('a pending day stays pending through a return', async () => {
    const e = await employee();
    const first = (await inn(e)).body.data;
    await out(e);
    await db.run("UPDATE attendance SET status = 'pending_approval', review_reason = 'late' WHERE id = ?", [first.id]);
    assert.equal((await inn(e)).body.data.status, 'pending_approval');
  });

  test('with the network check on, returning from outside the office goes to HR', async () => {
    await api.post('/hr/networks', { network_name: 'Office', public_ip: '49.206.113.67' }, { token });
    await api.patch('/hr/networks/settings', { enabled: true }, { token });
    const e = await employee();
    const first = (await api.post('/hr/attendance/check-in', {}, { token: e.token, headers: { 'X-Forwarded-For': '49.206.113.67' } })).body.data;
    assert.equal(first.status, 'present');
    await out(e);
    const back = await inn(e); // from 8.8.8.8
    assert.equal(back.body.data.status, 'pending_approval');
    assert.deepEqual(back.body.data.review_reasons, ['off_network']);
    await api.patch('/hr/networks/settings', { enabled: false }, { token });
  });
});
