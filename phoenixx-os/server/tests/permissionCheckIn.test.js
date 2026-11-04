/**
 * Late check-in inside an approved hourly permission.
 *
 * Approved permission covering the start of the day -> present, no HR queue.
 * No permission, a pending one, or arriving after it ends -> HR as before.
 * A permission approved after the late check-in settles that check-in.
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const { todayInTz, timeInTz } = await import('../src/lib/dueTime.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Permit Co', email: 'owner@permit.test' });
const token = owner.access_token;

const TZ = 'Asia/Kolkata';
const today = () => todayInTz(TZ);
const clockOffset = (minutes) => {
  const [h, m] = timeInTz(TZ).split(':').map(Number);
  const total = Math.min(Math.max(h * 60 + m + minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

let n = 0;
const employee = async () => {
  n += 1;
  const invite = await api.post('/users', { name: `Staff ${n}`, email: `s${n}@permit.test`, role: 'employee' }, { token });
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

const types = (await api.get('/hr/leave/types', { token })).body.data;
const typeId = types[0].id;

const askPermission = (who, from_time, to_time) => api.post('/hr/leave/requests', {
  leave_type_id: typeId, kind: 'permission', from_date: today(), to_date: today(),
  from_time, to_time, reason: 'Hospital visit in the morning',
}, { token: who.token });
const approve = (id) => api.post(`/hr/leave/requests/${id}/decide`, { decision: 'approved' }, { token });
const checkIn = (who) => api.post('/hr/attendance/check-in', {}, { token: who.token });

// Shift started an hour ago, so every check-in here is late.
const start = clockOffset(-60);
await api.patch('/hr/work-schedules', { work_start: start, work_end: '23:59', late_grace_minutes: 10 }, { token });
const lateEnough = start < clockOffset(-30); // false only in the first hour after midnight

describe('hourly permission and late check-in', { skip: !lateEnough && 'too close to midnight' }, () => {
  test('a permission needs times, and has to end after it starts', async () => {
    const e = await employee();
    const none = await api.post('/hr/leave/requests', {
      leave_type_id: typeId, kind: 'permission', from_date: today(), to_date: today(), reason: 'Bank work',
    }, { token: e.token });
    assert.equal(none.status, 400);
    assert.equal((await askPermission(e, '11:00', '10:00')).status, 400);
  });

  test('approved permission covering the late start -> present, not sent to HR', async () => {
    const e = await employee();
    const req = await askPermission(e, start, clockOffset(30));
    assert.equal(req.status, 201, JSON.stringify(req.body));
    await approve(req.body.data.id);
    const res = await checkIn(e);
    assert.equal(res.body.data.status, 'present');
    assert.equal(res.body.data.permission_id, req.body.data.id);
    assert.match(res.body.data.message, /approved permission/);
  });

  test('no permission -> pending HR approval', async () => {
    const e = await employee();
    assert.equal((await checkIn(e)).body.data.status, 'pending_approval');
  });

  test('a permission still waiting for approval does not count', async () => {
    const e = await employee();
    await askPermission(e, start, clockOffset(30));
    assert.equal((await checkIn(e)).body.data.status, 'pending_approval');
  });

  test('arriving after the permission ended -> pending HR approval', async () => {
    const e = await employee();
    const req = await askPermission(e, start, clockOffset(-40));
    await approve(req.body.data.id);
    assert.equal((await checkIn(e)).body.data.status, 'pending_approval');
  });

  test('a permission that starts after the shift does not excuse a late start', async () => {
    const e = await employee();
    const req = await askPermission(e, clockOffset(-20), clockOffset(30));
    await approve(req.body.data.id);
    assert.equal((await checkIn(e)).body.data.status, 'pending_approval');
  });

  test('permission approved after the late check-in settles it', async () => {
    const e = await employee();
    const req = await askPermission(e, start, clockOffset(30));
    const first = await checkIn(e);
    assert.equal(first.body.data.status, 'pending_approval');
    await approve(req.body.data.id);
    const row = await db.get('SELECT * FROM attendance WHERE id = ?', [first.body.data.id]);
    assert.equal(row.status, 'present');
    assert.equal(row.permission_id, req.body.data.id);
    const events = await db.all('SELECT event FROM attendance_events WHERE attendance_id = ? ORDER BY seq', [row.id]);
    assert.deepEqual(events.map((x) => x.event), ['checked_in', 'approved']);
  });
});
