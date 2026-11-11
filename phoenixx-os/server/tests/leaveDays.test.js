/**
 * How many days a leave takes: Sundays inside the range are not counted, so
 * Saturday to Monday is two days, not three. Holidays are counted as leave.
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Leave Days Co', email: 'owner@leavedays.test' });
const auth = { token: owner.access_token };
const typeId = (await api.get('/hr/leave/types', auth)).body.data[0].id;

// Sunday is the weekly off.
const sched = await api.patch('/hr/work-schedules', { work_start: '09:30', work_end: '18:30', week_off_days: [0] }, auth);
assert.equal(sched.status, 200, JSON.stringify(sched.body));

const iso = (d) => d.toISOString().slice(0, 10);
const plus = (dateStr, n) => { const d = new Date(`${dateStr}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
// The first Saturday in June 2031, and the days around it.
let saturday = '2031-06-01';
while (new Date(`${saturday}T12:00:00Z`).getUTCDay() !== 6) saturday = plus(saturday, 1);
const sunday = plus(saturday, 1);
const monday = plus(saturday, 2);

const count = (from, to) => api.get(`/hr/leave/days?from=${from}&to=${to}`, auth);
const apply = (from, to) => api.post('/hr/leave/requests', {
  leave_type_id: typeId, from_date: from, to_date: to, reason: 'Family function',
}, auth);

describe('leave day count', () => {
  test('Saturday to Monday with Sunday off is two days', async () => {
    const res = await count(saturday, monday);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.days, 2);
    assert.deepEqual(res.body.data.skipped, [{ date: sunday, reason: 'sunday' }]);

    const lr = await apply(saturday, monday);
    assert.equal(lr.status, 201, JSON.stringify(lr.body));
    assert.equal(lr.body.data.days, 2, 'the stored request takes two days off the balance');
  });

  test('a holiday inside the range still counts as leave', async () => {
    const tuesday = plus(saturday, 10);
    const wednesday = plus(tuesday, 1);
    const thursday = plus(tuesday, 2);
    const hol = await api.post('/hr/holidays', { holiday_date: wednesday, name: 'Founders Day' }, auth);
    assert.equal(hol.status, 201, JSON.stringify(hol.body));

    const res = await count(tuesday, thursday);
    assert.equal(res.body.data.days, 3);
    assert.deepEqual(res.body.data.skipped, []);
  });

  test('a leave on a Sunday alone is refused', async () => {
    const nextSunday = plus(sunday, 21);
    assert.equal((await count(nextSunday, nextSunday)).body.data.days, 0);
    const res = await apply(nextSunday, nextSunday);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Sunday/);
  });

  test('an hourly permission still counts as a quarter day', async () => {
    const tuesday = plus(monday, 22);
    const res = await api.post('/hr/leave/requests', {
      leave_type_id: typeId, kind: 'permission', from_date: tuesday, to_date: tuesday,
      from_time: '09:30', to_time: '10:30', reason: 'Bank visit',
    }, auth);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.days, 0.25);
  });
});
