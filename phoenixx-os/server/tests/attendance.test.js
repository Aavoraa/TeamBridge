/**
 * Check-in, check-out and the HR ruling that sits between a late arrival and a
 * day counted as worked.
 *
 * The rules under test are the ones that decide pay: the employee stamps
 * nothing, one check-in and one check-out per day, late means pending until a
 * person says otherwise, and Sundays and company holidays are days nobody was
 * expected in. The last group is there to prove the update did not break the
 * attendance an existing workspace already had.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const { localToUtc, todayInTz, timeInTz } = await import('../src/lib/dueTime.js');
const attendance = await import('../src/services/attendance.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Shift Co', email: 'owner@shift.test' });
const token = owner.access_token;
const tenantId = (await db.get('SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1')).id;

const TZ = 'Asia/Kolkata';
const today = () => todayInTz(TZ);
const shiftDay = (n) => new Date(Date.parse(`${today()}T00:00:00Z`) + n * 86_400_000)
  .toISOString().slice(0, 10);

const join = async (name, email, role = 'employee') => {
  const invite = await api.post('/users', { name, email, role }, { token });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken,
    password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invite.body.data.id, token: accepted.body.data.access_token, name };
};

/** Puts the workspace shift somewhere relative to now, so a check-in made
 *  during the test run is deliberately on time or deliberately late. */
const setShift = (startHHMM, patch = {}) => api.patch('/hr/work-schedules',
  { work_start: startHHMM, work_end: '23:59', ...patch }, { token });

/** The workspace clock, offset by minutes, as 'HH:MM'. */
const clockOffset = (minutes) => {
  const [h, m] = timeInTz(TZ).split(':').map(Number);
  const total = Math.min(Math.max(h * 60 + m + minutes, 0), 23 * 60 + 59);
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
};

/** The next Sunday on or after today, on the workspace calendar. */
const sundayOn = () => {
  let d = today();
  while (attendance.weekdayOf(d) !== 0) {
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return d;
};

/** The next Saturday on or after today, on the workspace calendar. */
const saturdayOn = () => {
  let d = today();
  while (attendance.weekdayOf(d) !== 6) {
    d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  }
  return d;
};

/** One employee, one day, as HR sees it. */
const dayFor = (userId, date) => api.get(
  `/hr/attendance/day?user_id=${userId}&date=${date}`, { token: hr.token },
);

const clearDay = async (userId, date = today()) => await db.run(
  'DELETE FROM attendance WHERE user_id = ? AND work_date = ?', [userId, date],
);

let hr;
let chandru;
let priya;
before(async () => {
  hr = await join('Sanjay', 'sanjay@shift.test', 'hr');
  chandru = await join('Chandru', 'chandru@shift.test');
  priya = await join('Priya', 'priya@shift.test');
  // Sunday-only weekly off, so Saturday is a working day like the product says.
  await setShift('09:30', { week_off_days: [0] });
});

// ------------------------------------------------------------- the stamps
describe('checking in', () => {
  test('records the server clock, not anything the employee sends', async () => {
    await clearDay(chandru.id);
    await setShift(clockOffset(-120));       // shift started two hours ago... but

    // ...the grace window is what decides, so widen it and stay "on time".
    await api.patch('/hr/work-schedules', { late_grace_minutes: 240 }, { token });

    const res = await api.post('/hr/attendance/check-in', {
      source: 'web',
      at: '2020-01-01T00:00:00.000Z',       // a forged stamp
      work_date: '2020-01-01',              // and a forged day
    }, { token: chandru.token });

    assert.equal(res.status, 201, JSON.stringify(res.body));
    const row = res.body.data;
    assert.equal(row.work_date, today(), 'the day is the workspace calendar day, not the one sent');
    assert.ok(row.check_in_at > '2026-01-01', 'the stamp is the server clock, not the one sent');
    assert.equal(row.status, 'present');
    assert.equal(Math.abs(Date.now() - Date.parse(row.check_in_at)) < 60_000, true,
      'stamped now, to the minute');
  });

  test('is idempotent - a second press returns the first record', async () => {
    const again = await api.post('/hr/attendance/check-in', {}, { token: chandru.token });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.already_checked_in, true);
    assert.equal(
      (await db.get('SELECT COUNT(*) AS n FROM attendance WHERE user_id = ? AND work_date = ?',
        [chandru.id, today()])).n,
      1,
      'still one row for the day',
    );
  });

  test('within the grace window still counts as on time', async () => {
    await clearDay(priya.id);
    await setShift(clockOffset(-5), { late_grace_minutes: 10 });
    const res = await api.post('/hr/attendance/check-in', {}, { token: priya.token });
    assert.equal(res.body.data.status, 'present');
    assert.ok(res.body.data.late_minutes <= 10);
  });
});

describe('a late check-in', () => {
  let late;
  before(async () => {
    await clearDay(priya.id);
    await setShift(clockOffset(-45), { late_grace_minutes: 10 });
    const res = await api.post('/hr/attendance/check-in', {}, { token: priya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    late = res.body.data;
  });

  test('is not marked present - it waits for HR', () => {
    assert.equal(late.status, 'pending_approval');
    assert.ok(late.late_minutes >= 40, `expected ~45 late minutes, got ${late.late_minutes}`);
    assert.equal(late.scheduled_start, clockOffset(-45), 'the schedule it was judged against is kept');
  });

  test('notifies HR with both times', async () => {
    const note = await db.get(
      `SELECT n.* FROM notifications n WHERE n.tenant_id = ? AND n.user_id = ?
         AND n.channel = 'in_app' AND n.title LIKE '%Late check-in%'
       ORDER BY n.created_at DESC LIMIT 1`,
      [tenantId, hr.id],
    );
    assert.ok(note, 'HR was told');
    assert.match(note.body, /Scheduled start/);
    assert.match(note.body, /min late/);
  });

  test('shows up in the queue, and only for someone who may rule on it', async () => {
    const mine = await api.get('/hr/attendance/pending', { token: priya.token });
    assert.equal(mine.status, 403, 'an employee cannot see the approval queue');

    const queue = await api.get('/hr/attendance/pending', { token: hr.token });
    assert.equal(queue.status, 200);
    assert.ok(queue.body.data.some((r) => r.id === late.id));
  });

  test('cannot be approved by the person it is about', async () => {
    const res = await api.post(`/hr/attendance/${late.id}/decide`, { decision: 'approve' },
      { token: priya.token });
    assert.equal(res.status, 403);
    assert.equal((await db.get('SELECT status FROM attendance WHERE id = ?', [late.id])).status,
      'pending_approval', 'and the day did not move');
  });

  test('cannot be rejected without a reason', async () => {
    const res = await api.post(`/hr/attendance/${late.id}/decide`, { decision: 'reject' },
      { token: hr.token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Say why/i);
  });

  test('approved by HR becomes present, and says who and when', async () => {
    const res = await api.post(`/hr/attendance/${late.id}/decide`,
      { decision: 'approve', note: 'Told the manager the night before' }, { token: hr.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    const row = res.body.data;
    assert.equal(row.status, 'present');
    assert.equal(row.approved_by, hr.id);
    assert.ok(row.approved_at);
    assert.equal(row.approval_note, 'Told the manager the night before');
    assert.ok(row.late_minutes >= 40, 'how late they were is kept, not erased by the approval');
  });

  test('cannot be decided twice', async () => {
    const res = await api.post(`/hr/attendance/${late.id}/decide`, { decision: 'reject', note: 'no' },
      { token: hr.token });
    assert.equal(res.status, 400);
  });

  test('leaves a history anybody can read back', async () => {
    const day = await dayFor(priya.id, today());
    const events = (day.body.data.history || []).map((h) => h.event);
    assert.deepEqual(events.slice(0, 2), ['checked_in', 'approved']);
  });

  test('a rejection records the reason and marks the day not approved', async () => {
    await clearDay(chandru.id);
    await setShift(clockOffset(-60), { late_grace_minutes: 5 });
    const created = (await api.post('/hr/attendance/check-in', {}, { token: chandru.token })).body.data;
    assert.equal(created.status, 'pending_approval');

    const res = await api.post(`/hr/attendance/${created.id}/decide`,
      { decision: 'reject', note: 'No notice given' }, { token: hr.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'not_approved');
    assert.equal(res.body.data.approval_note, 'No notice given');
  });
});

// ---------------------------------------------------------------- checkout
describe('checking out', () => {
  test('stamps the server clock and totals the hours', async () => {
    await clearDay(chandru.id);
    await setShift(clockOffset(-5), { late_grace_minutes: 60 });
    await api.post('/hr/attendance/check-in', {}, { token: chandru.token });

    // Back-date the check-in by nine hours so there are real hours to total.
    const row = await db.get('SELECT * FROM attendance WHERE user_id = ? AND work_date = ?',
      [chandru.id, today()]);
    await db.run('UPDATE attendance SET check_in_at = ? WHERE id = ?',
      [new Date(Date.now() - 9 * 3_600_000).toISOString(), row.id]);

    const res = await api.post('/hr/attendance/check-out',
      { at: '2020-01-01T00:00:00.000Z' }, { token: chandru.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.check_out_at > '2026-01-01', 'the forged stamp was ignored');
    assert.ok(Math.abs(res.body.data.work_minutes - 540) <= 2, 'about nine hours');
    assert.match(res.body.data.work_hours_label, /^9h 0\dm$/);
    assert.equal(res.body.data.status, 'present');
  });

  test('happens once - a second press returns what is already recorded', async () => {
    const again = await api.post('/hr/attendance/check-out', {}, { token: chandru.token });
    assert.equal(again.body.data.already_checked_out, true);
  });

  test('cannot happen before a check-in', async () => {
    await clearDay(priya.id);
    const res = await api.post('/hr/attendance/check-out', {}, { token: priya.token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /not checked in/i);
  });

  test('does not overrule HR on a day still waiting on a ruling', async () => {
    await clearDay(priya.id);
    await setShift(clockOffset(-90), { late_grace_minutes: 5 });
    await api.post('/hr/attendance/check-in', {}, { token: priya.token });

    const res = await api.post('/hr/attendance/check-out', {}, { token: priya.token });
    assert.equal(res.body.data.status, 'pending_approval', 'still the call for HR to make');
  });

  test('a forgotten checkout is flagged, and HR can put it right', async () => {
    const yesterday = shiftDay(-1);
    await clearDay(chandru.id, yesterday);
    const id = 'att-missing-checkout';
    await db.run(
      `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, source, status,
         scheduled_start, scheduled_end, created_at, updated_at)
       VALUES (?,?,?,?,?, 'web', 'present', '09:30', '18:30', ?, ?)`,
      [id, tenantId, chandru.id, yesterday,
        localToUtc(yesterday, '09:28', TZ).toISOString(),
        new Date().toISOString(), new Date().toISOString()],
    );

    const day = await dayFor(chandru.id, yesterday);
    assert.equal(day.body.data.attendance.checkout_missing, true);

    const fixed = await api.post(`/hr/attendance/${id}/correct`,
      { check_out_time: '18:34', note: 'Forgot to check out; confirmed with the manager' },
      { token: hr.token });
    assert.equal(fixed.status, 200, JSON.stringify(fixed.body));
    assert.equal(fixed.body.data.check_out_label, '6:34 PM');
    assert.equal(fixed.body.data.work_hours_label, '9h 06m');
    assert.equal(fixed.body.data.checkout_missing, false);

    const events = await db.all('SELECT event, note FROM attendance_events WHERE attendance_id = ?', [id]);
    assert.ok(events.some((e) => e.event === 'corrected'), 'the correction is on the record');
  });

  test('an employee cannot correct their own stamps', async () => {
    const res = await api.post('/hr/attendance/att-missing-checkout/correct',
      { check_out_time: '23:00', note: 'let me out later' }, { token: chandru.token });
    assert.equal(res.status, 403);
  });
});

// -------------------------------------------------- weekly offs + holidays
describe('days nobody is expected in', () => {
  test('Sunday is a weekly off without anybody marking it', async () => {
    const sunday = (() => {
      let d = today();
      while (attendance.weekdayOf(d) !== 0) {
        d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      }
      return d;
    })();
    assert.equal((await attendance.dayKind(tenantId, sunday)).kind, 'weekoff');

    const day = await dayFor(chandru.id, sunday);
    assert.equal(day.body.data.day_kind, 'weekoff');
  });

  test('a company holiday added once covers everybody', async () => {
    const onam = shiftDay(12);
    const res = await api.post('/hr/holidays', { holiday_date: onam, name: 'Onam' }, { token: hr.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    for (const person of [chandru, priya]) {
      const day = await dayFor(person.id, onam);
      assert.equal(day.body.data.day_kind, 'holiday', `${person.name} has the holiday too`);
      assert.equal(day.body.data.holiday.name, 'Onam');
    }

    const dup = await api.post('/hr/holidays', { holiday_date: onam, name: 'Onam again' }, { token: hr.token });
    assert.equal(dup.status, 400, 'one holiday per date');
  });

  test('only somebody with the approval right may set one', async () => {
    const res = await api.post('/hr/holidays', { holiday_date: shiftDay(20), name: 'Nope' },
      { token: chandru.token });
    assert.equal(res.status, 403);
  });

  test('a holiday can be renamed and removed', async () => {
    const created = (await api.post('/hr/holidays',
      { holiday_date: shiftDay(30), name: 'Gandhi Jayanthi' }, { token: hr.token })).body.data;

    const renamed = await api.patch(`/hr/holidays/${created.id}`, { name: 'Gandhi Jayanti' },
      { token: hr.token });
    assert.equal(renamed.body.data.name, 'Gandhi Jayanti');

    assert.equal((await api.del(`/hr/holidays/${created.id}`, { token: hr.token })).status, 200);
    const day = await dayFor(chandru.id, shiftDay(30));
    assert.equal(day.body.data.day_kind, 'working', 'and the day goes back to being a working one');
  });
});

// ----------------------------------------------------------- work timings
describe('work timings', () => {
  test('an employee inherits the workspace hours until HR gives them their own', async () => {
    await api.patch('/hr/work-schedules', { work_start: '09:30', work_end: '18:30' }, { token: hr.token });
    let sched = await attendance.scheduleFor(tenantId, priya.id);
    assert.equal(sched.start, '09:30');
    assert.equal(sched.custom, false);

    await api.patch(`/hr/work-schedules/${priya.id}`, { work_start: '10:00', work_end: '19:00' },
      { token: hr.token });
    sched = await attendance.scheduleFor(tenantId, priya.id);
    assert.equal(sched.start, '10:00');
    assert.equal(sched.custom, true);

    // Clearing puts them back on the default rather than freezing today's.
    await api.patch(`/hr/work-schedules/${priya.id}`, { work_start: null, work_end: null },
      { token: hr.token });
    assert.equal((await attendance.scheduleFor(tenantId, priya.id)).start, '09:30');
  });

  test('a day is judged against the schedule as it stood, not as it is now', async () => {
    await clearDay(priya.id);
    await setShift(clockOffset(-45), { late_grace_minutes: 5 });
    const row = (await api.post('/hr/attendance/check-in', {}, { token: priya.token })).body.data;
    assert.equal(row.status, 'pending_approval');
    const judgedAgainst = row.scheduled_start;

    // HR moves everybody's day later afterwards. The record does not move.
    await setShift('23:00', { late_grace_minutes: 5 });
    const after = await db.get('SELECT scheduled_start, late_minutes FROM attendance WHERE id = ?', [row.id]);
    assert.equal(after.scheduled_start, judgedAgainst);
    assert.equal(after.late_minutes, row.late_minutes);

    await setShift('09:30', { late_grace_minutes: 10 });
  });

  test('an employee cannot set their own hours', async () => {
    const res = await api.patch(`/hr/work-schedules/${chandru.id}`, { work_start: '11:00' },
      { token: chandru.token });
    assert.equal(res.status, 403);
  });
});

// -------------------------------------------------------------- register
describe('the monthly register', () => {
  test('names each kind of day, and counts only the ones people owed', async () => {
    const month = today().slice(0, 7);
    const res = await api.get(`/hr/attendance/register?month=${month}`, { token: hr.token });
    assert.equal(res.status, 200);

    const { days, rows, totals, working_days: workingDays } = res.body.data;
    const sundays = days.filter((d) => d.weekday === 0);
    assert.ok(sundays.length >= 4);
    assert.ok(sundays.every((d) => d.week_off), 'every Sunday is a weekly off');
    assert.ok(days.some((d) => d.weekday === 6 && !d.week_off), 'Saturday is a working day');

    const row = rows.find((r) => r.user.id === chandru.id);
    const sundayCell = row.cells.find((c) => c.date === sundays[0].date);
    assert.equal(sundayCell.status, 'weekoff');

    // Working days exclude the weekly offs and the holiday that was added.
    assert.equal(workingDays, days.filter((d) => !d.week_off && !d.holiday).length);
    assert.equal(totals.working_days, workingDays);
    assert.ok(row.summary.present_days <= row.summary.working_days);
  });

  test('a future working day is blank, not an absence', async () => {
    const month = today().slice(0, 7);
    const res = await api.get(`/hr/attendance/register?month=${month}`, { token: hr.token });
    const row = res.body.data.rows.find((r) => r.user.id === chandru.id);
    // A holiday is a named day, not a blank one - it is excluded here for the
    // same reason a weekly off is.
    const blankable = row.cells.filter((c) => c.future && !c.week_off && c.status !== 'holiday');
    assert.ok(blankable.length > 0, 'there is at least one plain future working day to check');
    for (const cell of blankable) {
      assert.equal(cell.status, null, `${cell.date} should be blank, not ${cell.status}`);
    }
  });

  test('an employee sees only their own row', async () => {
    const res = await api.get('/hr/attendance/register', { token: chandru.token });
    assert.equal(res.body.data.rows.length, 1);
    assert.equal(res.body.data.rows[0].user.id, chandru.id);
  });

  test('HR can narrow it to one person', async () => {
    const res = await api.get(`/hr/attendance/register?user_id=${priya.id}`, { token: hr.token });
    assert.equal(res.body.data.rows.length, 1);
    assert.equal(res.body.data.rows[0].user.id, priya.id);
  });
});

// ----------------------------------------------------- nothing else broke
describe('attendance that predates this workflow', () => {
  test('a row with no schedule and no ruling still reads as it always did', async () => {
    const old = shiftDay(-10);
    const id = 'att-legacy-row';
    // Exactly the shape the old check-in wrote: no scheduled_start, no approval.
    await db.run(
      `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, check_out_at,
         source, status, work_minutes, late_minutes, created_at, updated_at)
       VALUES (?,?,?,?,?,?, 'web', 'present', 500, 12, ?, ?)`,
      [id, tenantId, priya.id, old,
        localToUtc(old, '09:42', TZ).toISOString(), localToUtc(old, '18:02', TZ).toISOString(),
        new Date().toISOString(), new Date().toISOString()],
    );

    const day = await dayFor(priya.id, old);
    assert.equal(day.status, 200, JSON.stringify(day.body));
    const a = day.body.data.attendance;
    assert.equal(a.status, 'present', 'still present');
    assert.equal(a.check_in_label, '9:42 AM');
    assert.equal(a.check_out_label, '6:02 PM');
    assert.equal(a.work_hours_label, '8h 20m');
    // The schedule falls back to whatever the workspace says today, so the
    // detail panel has something to show rather than a blank.
    assert.equal(day.body.data.schedule.start, '09:30');

    const month = old.slice(0, 7);
    const reg = await api.get(`/hr/attendance/register?month=${month}`, { token: hr.token });
    const cell = reg.body.data.rows.find((r) => r.user.id === priya.id)
      .cells.find((c) => c.date === old);
    assert.equal(cell.status, 'present');
  });
});

// ------------------------------------------------------ Saturday is worked
describe('the working week', () => {
  test('a new workspace has Sunday off and Saturday on', async () => {
    const fresh = 'tenant-fresh-week';
    await db.run('INSERT INTO tenants (id,name,slug,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [fresh, 'Fresh Co', `fresh-${Date.now()}`, 'active', new Date().toISOString(), new Date().toISOString()]);
    assert.deepEqual(await attendance.weekOffDays(fresh), [0], 'Sunday alone');
    assert.equal((await attendance.dayKind(fresh, saturdayOn())).kind, 'working');
  });

  test('a workspace still carrying the old Sat+Sun default is corrected on boot', async () => {
    const legacy = 'tenant-legacy-week';
    await db.run('INSERT INTO tenants (id,name,slug,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [legacy, 'Legacy Co', `legacy-${Date.now()}`, 'active', new Date().toISOString(), new Date().toISOString()]);
    await db.run("UPDATE tenants SET week_off_days = '[0,6]' WHERE id = ?", [legacy]);
    await db.run("DELETE FROM schema_meta WHERE key = 'week_off_saturday_is_working'");

    await db.migrate();
    assert.deepEqual(await attendance.weekOffDays(legacy), [0], 'Saturday is a working day again');
  });

  test('but a deliberate choice of Saturday off is not overruled by a restart', async () => {
    const chosen = 'tenant-chose-saturday';
    await db.run('INSERT INTO tenants (id,name,slug,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [chosen, 'Six Day Co', `sixday-${Date.now()}`, 'active', new Date().toISOString(), new Date().toISOString()]);
    await db.run("UPDATE tenants SET week_off_days = '[0,6]' WHERE id = ?", [chosen]);

    await db.migrate();
    assert.deepEqual(await attendance.weekOffDays(chosen), [0, 6],
      'the correction runs once, not on every boot');
  });

  test('the last weekly off cannot be unticked', async () => {
    const res = await api.patch('/hr/work-schedules', { week_off_days: [] }, { token: hr.token });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(JSON.stringify(res.body), /at least one weekly off/i);
    assert.deepEqual(await attendance.weekOffDays(tenantId), [0], 'and Sunday is still off');
  });

  test('a workspace already left with no weekly off reads as Sunday, and is repaired', async () => {
    const stranded = 'tenant-no-week-off';
    await db.run('INSERT INTO tenants (id,name,slug,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [stranded, 'Stranded Co', `stranded-${Date.now()}`, 'active',
        new Date().toISOString(), new Date().toISOString()]);
    await db.run("UPDATE tenants SET week_off_days = '[]' WHERE id = ?", [stranded]);

    // Read back as Sunday before anything has repaired the stored value.
    assert.deepEqual(await attendance.weekOffDays(stranded), [0]);
    assert.equal((await attendance.dayKind(stranded, sundayOn())).kind, 'weekoff');

    await db.migrate();
    assert.equal(
      (await db.get('SELECT week_off_days FROM tenants WHERE id = ?', [stranded])).week_off_days,
      '[0]',
      'and the stored value is put right too',
    );
  });

  test('a deliberate weekly off on another day is left alone', async () => {
    const friday = 'tenant-friday-off';
    await db.run('INSERT INTO tenants (id,name,slug,status,created_at,updated_at) VALUES (?,?,?,?,?,?)',
      [friday, 'Friday Co', `friday-${Date.now()}`, 'active',
        new Date().toISOString(), new Date().toISOString()]);
    await db.run("UPDATE tenants SET week_off_days = '[5]' WHERE id = ?", [friday]);

    await db.migrate();
    assert.deepEqual(await attendance.weekOffDays(friday), [5], 'not forced back to Sunday');
  });

  test('a Saturday off is a holiday somebody adds, not a standing rule', async () => {
    const sat = saturdayOn();
    assert.equal((await attendance.dayKind(tenantId, sat)).kind, 'working');

    const res = await api.post('/hr/holidays',
      { holiday_date: sat, name: 'Second Saturday' }, { token: hr.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const day = await dayFor(chandru.id, sat);
    assert.equal(day.body.data.day_kind, 'holiday');
    assert.equal(day.body.data.holiday.name, 'Second Saturday');

    await api.del(`/hr/holidays/${res.body.data.id}`, { token: hr.token });
    assert.equal((await attendance.dayKind(tenantId, sat)).kind, 'working', 'and back to a working day');
  });
});

// -------------------------------------------------------------- the clock
describe('the working-day clock', () => {
  test('hours read the way a payslip says them', () => {
    assert.equal(attendance.hoursLabel(532), '8h 52m');
    assert.equal(attendance.hoursLabel(545), '9h 05m');
    assert.equal(attendance.hoursLabel(0), '0h 00m');
  });

  test('a shift start is an instant on the workspace clock', () => {
    assert.equal(localToUtc('2026-09-03', '09:30', TZ).toISOString(), '2026-09-03T04:00:00.000Z');
  });
});

// ------------------------------------------------- management logins
describe('HR and Finance logins are not on the register', () => {
  test('they are not rows on the monthly register, and cannot check in', async () => {
    const meera = await join('Meera', 'meera@shift.test', 'finance');
    const month = today().slice(0, 7);
    const res = await api.get(`/hr/attendance/register?month=${month}`, { token: hr.token });
    assert.equal(res.status, 200);
    const ids = res.body.data.rows.map((r) => r.user.id);
    assert.ok(!ids.includes(hr.id), 'the HR login is not a row');
    assert.ok(!ids.includes(meera.id), 'the Finance login is not a row');
    assert.ok(ids.includes(chandru.id), 'employees still are');

    assert.equal((await api.post('/hr/attendance/check-in', {}, { token: hr.token })).status, 403);
  });
});
