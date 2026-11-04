/**
 * Same-day scheduling: a due date that carries a time of day.
 *
 * The rules under test are the ones a person actually runs into - a task set
 * for today has to say when today, that time cannot already be behind them, and
 * once it passes the task is late rather than merely "due today". Everything
 * else here exists to prove the old behaviour survived: a task with only a date
 * still means end of day, and nothing that predates times has changed.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const { dueAtIso, todayInTz, timeInTz, formatDueTime } = await import('../src/lib/dueTime.js');
const { runDeadlineLadder } = await import('../src/services/deadlines.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Slot Co', email: 'owner@slot.test' });
const token = owner.access_token;

const TZ = 'Asia/Kolkata';
const today = () => todayInTz(TZ);
const shiftDay = (days) => new Date(Date.parse(`${today()}T00:00:00Z`) + days * 86_400_000)
  .toISOString().slice(0, 10);
const tomorrow = () => shiftDay(1);

/** A time still ahead on the workspace clock, so a same-day task is allowed. */
const laterToday = (addMinutes = 90) => {
  const [h, m] = timeInTz(TZ).split(':').map(Number);
  const mins = Math.min(h * 60 + m + addMinutes, 23 * 60 + 59);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
};

const create = (body) => api.post('/action-items', { title: 'Website review', ...body }, { token });
const errorOn = (res, field) => (res.body.error?.details || []).find((d) => d.field === field)?.message;

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

let chandru;
before(async () => { chandru = await join('Chandru', 'chandru@slot.test'); });

/** Writes the row directly: the API will not let anyone schedule the past. */
const backdate = async (id, dueDate, dueTime) => await db.run(
  'UPDATE action_items SET due_date = ?, due_time = ?, due_at = ? WHERE id = ?',
  [dueDate, dueTime, dueAtIso(dueDate, dueTime, TZ), id],
);

/** An hour of today that has already gone by, or null in the first hour. */
const hourGoneBy = () => {
  const h = Number(timeInTz(TZ).split(':')[0]);
  return h < 1 ? null : `${String(h - 1).padStart(2, '0')}:00`;
};

// ---------------------------------------------------------------- the rules
describe('a task due today', () => {
  test('is refused without a time, and the message names the field', async () => {
    const res = await create({ owner_id: chandru.id, due_date: today() });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(errorOn(res, 'due_time') || '', /needs a time/i);
  });

  test('is refused when the time has already gone by', async () => {
    // 00:01 is behind us on every run except the first minute of the day, which
    // is the one minute where the rule genuinely does not apply.
    if (timeInTz(TZ) <= '00:01') return;
    const res = await create({ owner_id: chandru.id, due_date: today(), due_time: '00:01' });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(errorOn(res, 'due_time') || '', /already passed/i);
  });

  test('is accepted with a time still ahead, and stores all three columns', async () => {
    const at = laterToday();
    const res = await create({ owner_id: chandru.id, due_date: today(), due_time: at });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const item = res.body.data;
    assert.equal(item.due_date, today());
    assert.equal(item.due_time, at);
    assert.equal(item.due_at, dueAtIso(today(), at, TZ), 'the instant is resolved on the workspace clock');
    assert.equal(item.is_overdue, false);
  });
});

describe('a task due on a future day', () => {
  test('takes a time if one is given', async () => {
    const res = await create({ owner_id: chandru.id, due_date: tomorrow(), due_time: '09:30' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.due_time, '09:30');
    assert.equal(res.body.data.due_at, dueAtIso(tomorrow(), '09:30', TZ));
  });

  test('takes none, and then means the end of that day', async () => {
    const res = await create({ owner_id: chandru.id, due_date: tomorrow() });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.due_time, null);
    assert.equal(res.body.data.due_at, dueAtIso(tomorrow(), null, TZ));
    assert.ok(res.body.data.due_at.length > 10, 'an instant, not a bare date');
  });

  test('accepts a time that would have been in the past today', async () => {
    const res = await create({ owner_id: chandru.id, due_date: tomorrow(), due_time: '00:05' });
    assert.equal(res.status, 201, JSON.stringify(res.body));
  });
});

// ------------------------------------------------------------------ overdue
describe('overdue', () => {
  test('a same-day task is late the moment its time passes, not at midnight', async (t) => {
    const past = hourGoneBy();
    if (!past) return t.skip('run inside the first hour of the workspace day');

    const item = (await create({ owner_id: chandru.id, due_date: tomorrow(), due_time: '10:00' })).body.data;
    await backdate(item.id, today(), past);

    const row = (await api.get(`/action-items/${item.id}`, { token })).body.data;
    assert.equal(row.due_date, today(), 'it is still a task due today');
    assert.equal(row.is_overdue, true, 'and it is nonetheless overdue');

    const list = await api.get('/action-items?overdue=true', { token });
    assert.ok(list.body.data.some((x) => x.id === item.id), 'the overdue filter agrees');
  });

  test('a date-only task is not overdue until its whole day is out', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: tomorrow() })).body.data;
    await backdate(item.id, today(), null);

    const row = (await api.get(`/action-items/${item.id}`, { token })).body.data;
    assert.equal(row.is_overdue, false, 'end of day has not arrived');

    const list = await api.get('/action-items?overdue=true', { token });
    assert.equal(list.body.data.some((x) => x.id === item.id), false);
  });

  test('yesterday, with no time, is overdue exactly as it always was', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: tomorrow() })).body.data;
    await backdate(item.id, shiftDay(-1), null);

    const row = (await api.get(`/action-items/${item.id}`, { token })).body.data;
    assert.equal(row.is_overdue, true);
  });
});

// ------------------------------------------------------------------- edits
describe('editing the due date', () => {
  test('moving a task to today asks for the time', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: tomorrow() })).body.data;
    const res = await api.patch(`/action-items/${item.id}`, { due_date: today() }, { token });
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.match(errorOn(res, 'due_time') || '', /needs a time/i);
  });

  test('moving it to today with a time works, and moves the deadline with it', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: tomorrow() })).body.data;
    const at = laterToday();
    const res = await api.patch(`/action-items/${item.id}`,
      { due_date: today(), due_time: at }, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.due_at, dueAtIso(today(), at, TZ));

    const deadline = await db.get(
      "SELECT * FROM deadlines WHERE source_type = 'action_item' AND source_id = ?", [item.id],
    );
    assert.equal(deadline.due_at, dueAtIso(today(), at, TZ), 'the ladder is set to the minute');
    assert.equal(JSON.parse(deadline.meta).timed, true);
  });

  test('clearing the date clears the time and the instant with it', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: tomorrow(), due_time: '11:00' })).body.data;
    const res = await api.patch(`/action-items/${item.id}`, { due_date: null }, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.due_date, null);
    assert.equal(res.body.data.due_time, null);
    assert.equal(res.body.data.due_at, null);
  });

  test('an edit that leaves the due date alone is never blocked by it', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: today(), due_time: laterToday() })).body.data;
    // Put its time behind us, then do something unrelated to the schedule.
    await backdate(item.id, today(), '00:01');

    const res = await api.patch(`/action-items/${item.id}`, { priority: 'urgent' }, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.priority, 'urgent');
    assert.equal(res.body.data.due_time, '00:01', 'and the schedule is untouched');
  });

  test('marking a task done after its time has passed still works', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: today(), due_time: laterToday() })).body.data;
    await backdate(item.id, today(), '00:01');

    const res = await api.patch(`/action-items/${item.id}`, { status: 'done' }, { token: chandru.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.status, 'done');
    assert.equal(res.body.data.is_overdue, false, 'finished work is not overdue work');
  });
});

// ------------------------------------------------------- reminders + My Day
describe('the reminder ladder', () => {
  test('warns half an hour before a timed task and breaches once it passes', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: tomorrow(), due_time: '10:00' })).body.data;
    const dueAt = new Date(dueAtIso(today(), '10:00', TZ));
    await backdate(item.id, today(), '10:00');
    await db.run('UPDATE deadlines SET due_at = ?, ladder_sent = ?, status = ? WHERE source_id = ?',
      [dueAt.toISOString(), '[]', 'pending', item.id]);

    // Twenty minutes out: the half-hour warning is the rung that should fire.
    await runDeadlineLadder({ now: new Date(dueAt.getTime() - 20 * 60_000) });
    let sent = JSON.parse((await db.get('SELECT ladder_sent FROM deadlines WHERE source_id = ?', [item.id])).ladder_sent);
    assert.ok(sent.includes('t-30m'), `expected the 30-minute rung, got ${JSON.stringify(sent)}`);

    // Two hours past it: breached, and recorded as hours late rather than 0 days.
    await runDeadlineLadder({ now: new Date(dueAt.getTime() + 2 * 3_600_000) });
    const deadline = await db.get('SELECT * FROM deadlines WHERE source_id = ?', [item.id]);
    sent = JSON.parse(deadline.ladder_sent);
    assert.equal(deadline.status, 'breached');
    assert.ok(sent.includes('overdue-0'), `expected a same-day overdue rung, got ${JSON.stringify(sent)}`);
  });

  test('a date-only deadline is not breached during its own day', async () => {
    const item = (await create({ owner_id: chandru.id, due_date: tomorrow() })).body.data;
    const noon = new Date(dueAtIso(tomorrow(), '12:00', TZ));
    await runDeadlineLadder({ now: noon });
    const deadline = await db.get('SELECT * FROM deadlines WHERE source_id = ?', [item.id]);
    assert.equal(deadline.status, 'pending', 'end of day has not arrived');
  });
});

describe('My Day', () => {
  test('sorts a timed task by its hour and drops it into overdue once it passes', async (t) => {
    const past = hourGoneBy();
    if (!past) return t.skip('run inside the first hour of the workspace day');

    const meena = await join('Meena', 'meena@slot.test');
    const late = (await create({ owner_id: meena.id, due_date: tomorrow(), due_time: '10:00' })).body.data;
    const ahead = (await create({
      title: 'Still ahead', owner_id: meena.id, due_date: today(), due_time: laterToday(),
    })).body.data;

    await backdate(late.id, today(), past);

    const day = (await api.get('/action-items/me/today', { token: meena.token })).body.data;
    assert.ok(day.overdue.some((x) => x.id === late.id), 'the hour that passed is overdue');
    assert.ok(day.today.some((x) => x.id === ahead.id), 'the hour still ahead is today');
    assert.equal(day.today.some((x) => x.id === late.id), false);
  });
});

// --------------------------------------------------------------- formatting
describe('the workspace clock', () => {
  test('renders a 24-hour time the way a reader says it', () => {
    assert.equal(formatDueTime('16:00'), '4:00 PM');
    assert.equal(formatDueTime('09:05'), '9:05 AM');
    assert.equal(formatDueTime('00:30'), '12:30 AM');
    assert.equal(formatDueTime('12:00'), '12:00 PM');
    assert.equal(formatDueTime(null), '');
  });

  test('resolves a local wall clock to the right instant, either side of a DST change', () => {
    assert.equal(dueAtIso('2026-09-03', '16:00', 'Asia/Kolkata'), '2026-09-03T10:30:00.000Z');
    assert.equal(dueAtIso('2026-07-01', '16:00', 'America/New_York'), '2026-07-01T20:00:00.000Z');
    assert.equal(dueAtIso('2026-01-05', '16:00', 'America/New_York'), '2026-01-05T21:00:00.000Z');
  });
});
