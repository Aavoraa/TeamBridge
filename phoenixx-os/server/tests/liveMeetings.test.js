import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const live = await import('../src/services/liveMeetings.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Live Co', email: 'owner@live.test', owner_name: 'Arun Prakash' });
const ownerToken = owner.access_token;

async function join(name, email, role = 'employee', extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

// A day well ahead on the workspace calendar (Asia/Kolkata), as YYYY-MM-DD.
const day = (n) => new Date(Date.now() + n * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);

let divya; let priya; let rahul; let meera; let sundar;
before(async () => {
  divya = await join('Divya Ramesh', 'divya@live.test', 'manager', { department: 'Delivery' });
  priya = await join('Priya Raman', 'priya@live.test', 'employee', { manager_id: divya.user.id, department: 'Delivery' });
  rahul = await join('Rahul Kumar', 'rahul@live.test', 'employee', { manager_id: divya.user.id, department: 'Delivery' });
  meera = await join('Meera Iyer', 'meera@live.test', 'finance', { department: 'Finance' });
  sundar = await join('Sundar Rajan', 'sundar@live.test', 'employee', { department: 'Sales' });
});

const notesOf = async (who) => (await api.get('/notifications', { token: who.token })).body.data;

describe('departments', () => {
  test('HR/owner can set a department; the directory lists departments', async () => {
    const res = await api.patch(`/users/${sundar.user.id}`, { department: 'Sales' }, { token: ownerToken });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.department, 'Sales');
    const dir = await api.get('/ai-meetings/directory', { token: divya.token });
    assert.deepEqual(dir.body.data.departments, ['Delivery', 'Finance', 'Sales']);
    assert.ok(!dir.body.data.people.some((p) => p.manager_id !== undefined), 'reporting lines are not exposed');
  });
});

describe('scheduling', () => {
  let m;
  before(async () => {
    const res = await api.post('/ai-meetings', {
      title: 'Sprint planning', description: 'Plan sprint 12', agenda: '1. Review\n2. Plan',
      date: day(10), time: '10:30', duration_minutes: 45,
      participant_ids: [meera.user.id], departments: ['Delivery'], department: 'Delivery',
      transcription_allowed: true,
    }, { token: divya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    m = res.body.data;
  });

  test('individuals and a whole department are invited, host included once', () => {
    const names = m.attendees.map((a) => a.name).sort();
    assert.deepEqual(names, ['Divya Ramesh', 'Meera Iyer', 'Priya Raman', 'Rahul Kumar']);
    assert.equal(m.attendees.find((a) => a.name === 'Divya Ramesh').role, 'host');
    assert.equal(m.attendees.find((a) => a.name === 'Priya Raman').invited_via, 'department:Delivery');
    assert.equal(m.is_host, true);
    assert.match(m.join_url, /\/ai-meetings\/j\/[\w-]{20,}$/);
    assert.equal(m.scheduled_at, new Date(`${day(10)}T05:00:00.000Z`).toISOString(), '10:30 IST stored as 05:00 UTC');
  });

  test('invitees are notified through the existing notifications', async () => {
    const n = (await notesOf(priya)).find((x) => /Meeting invitation: Sprint planning/.test(x.title));
    assert.ok(n);
    assert.match(n.body, /Divya Ramesh has invited you/);
  });

  test('inviting someone twice adds them once and notifies once', async () => {
    const res = await api.post(`/ai-meetings/${m.id}/invite`, { participant_ids: [meera.user.id, sundar.user.id], departments: ['Delivery'] }, { token: divya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.added, 1);
    const n = await db.pluck('SELECT COUNT(*) FROM meeting_attendees WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL', [m.id, meera.user.id]);
    assert.equal(Number(n), 1);
    const invites = (await notesOf(meera)).filter((x) => /Sprint planning/.test(x.title));
    assert.equal(invites.length, 1);
  });

  test('accept and decline reach the host', async () => {
    assert.equal((await api.post(`/ai-meetings/${m.id}/respond`, { response: 'accepted' }, { token: priya.token })).status, 200);
    const d = await api.post(`/ai-meetings/${m.id}/respond`, { response: 'declined' }, { token: meera.token });
    assert.equal(d.body.data.my_response, 'declined');
    const n = (await notesOf(divya)).find((x) => /Meera Iyer declined/.test(x.title));
    assert.ok(n, 'the host hears about the decline');
  });

  test('who can see it: invitees, the host\'s manager chain, the owner - not outsiders', async () => {
    assert.equal((await api.get(`/ai-meetings/${m.id}`, { token: priya.token })).status, 200);
    assert.equal((await api.get(`/ai-meetings/${m.id}`, { token: ownerToken })).status, 200);
    const outsider = await join('Kavya Nair', 'kavya@live.test', 'employee');
    assert.equal((await api.get(`/ai-meetings/${m.id}`, { token: outsider.token })).status, 404);
    // An invite-only meeting's link does not let them in either.
    const viaLink = await api.get(`/ai-meetings/link/${m.invite_token}`, { token: outsider.token });
    assert.equal(viaLink.status, 403);
  });

  test('a participant cannot change the meeting; the host can reschedule and people are told', async () => {
    assert.equal((await api.patch(`/ai-meetings/${m.id}`, { time: '11:00' }, { token: priya.token })).status, 403);
    const res = await api.patch(`/ai-meetings/${m.id}`, { time: '14:00' }, { token: divya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.scheduled_at, new Date(`${day(10)}T08:30:00.000Z`).toISOString());
    const n = (await notesOf(priya)).find((x) => /Meeting moved: Sprint planning/.test(x.title));
    assert.ok(n);
    assert.ok(!(await notesOf(meera)).some((x) => /Meeting moved/.test(x.title)), 'someone who declined is not told');
  });

  test('times in the past are refused', async () => {
    const res = await api.post('/ai-meetings', { title: 'Too late', date: day(-2), time: '10:00', duration_minutes: 30 }, { token: divya.token });
    assert.equal(res.status, 400);
  });

  test('cancelling tells the attendees', async () => {
    const res = await api.post(`/ai-meetings/${m.id}/cancel`, { reason: 'Client moved the review' }, { token: divya.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'cancelled');
    const n = (await notesOf(rahul)).find((x) => /Meeting cancelled: Sprint planning/.test(x.title));
    assert.match(n.body, /Client moved the review/);
    assert.equal((await api.post(`/ai-meetings/${m.id}/respond`, { response: 'accepted' }, { token: rahul.token })).status, 400);
  });
});

describe('recurring meetings', () => {
  test('weekly until a date creates each occurrence with its own room and link', async () => {
    const res = await api.post('/ai-meetings', {
      title: 'Weekly sync', date: day(7), time: '09:00', duration_minutes: 30,
      participant_ids: [priya.user.id], recurrence: 'weekly', recurrence_until: day(7 + 21),
    }, { token: divya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.data.occurrence_ids.length, 4);
    const rows = await db.all('SELECT room_name, invite_token, scheduled_at FROM meetings WHERE series_id = ? ORDER BY scheduled_at', [res.body.data.series_id]);
    assert.equal(new Set(rows.map((r) => r.room_name)).size, 4);
    assert.equal(Date.parse(rows[1].scheduled_at) - Date.parse(rows[0].scheduled_at), 7 * 86_400_000);
    const invites = (await notesOf(priya)).filter((x) => /Weekly sync/.test(x.title));
    assert.equal(invites.length, 1, 'one invitation for the whole series');
    assert.match(invites[0].body, /repeating weekly \(4 meetings\)/);
  });

  test('moving "this and later" shifts the rest of the series only', async () => {
    const ids = (await db.all("SELECT id FROM meetings WHERE title = 'Weekly sync' ORDER BY scheduled_at")).map((r) => r.id);
    const before = await db.all('SELECT id, scheduled_at FROM meetings WHERE id IN (?,?,?,?) ORDER BY scheduled_at', ids);
    await api.patch(`/ai-meetings/${ids[2]}`, { time: '10:00', scope: 'series' }, { token: divya.token });
    const afterRows = await db.all('SELECT id, scheduled_at FROM meetings WHERE id IN (?,?,?,?) ORDER BY scheduled_at', ids);
    assert.equal(afterRows[0].scheduled_at, before[0].scheduled_at);
    assert.equal(afterRows[1].scheduled_at, before[1].scheduled_at);
    assert.equal(Date.parse(afterRows[2].scheduled_at) - Date.parse(before[2].scheduled_at), 3_600_000);
    assert.equal(Date.parse(afterRows[3].scheduled_at) - Date.parse(before[3].scheduled_at), 3_600_000);
  });

  test('monthly on the 31st skips months without one', () => {
    const occ = live.occurrences('2030-01-31T04:30:00.000Z', 'monthly', '2030-05-31', 'Asia/Kolkata');
    assert.deepEqual(occ.map((s) => s.slice(0, 10)), ['2030-01-31', '2030-03-31', '2030-05-31']);
  });
});

describe('instant meetings and links', () => {
  let m;
  test('an instant meeting starts now with a shareable link', async () => {
    const res = await api.post('/ai-meetings/instant', { title: 'Quick sync' }, { token: priya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    m = res.body.data;
    assert.equal(m.access, 'workspace');
    assert.ok(Math.abs(Date.parse(m.scheduled_at) - Date.now()) < 60_000);
    assert.ok(m.join_url);
  });

  test('a colleague with the link is admitted and recorded as an attendee', async () => {
    const res = await api.get(`/ai-meetings/link/${m.invite_token}`, { token: sundar.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.data.attendees.some((a) => a.user_id === sundar.user.id && a.invited_via === 'link'));
    // Opening it again does not add them twice.
    await api.get(`/ai-meetings/link/${m.invite_token}`, { token: sundar.token });
    const n = await db.pluck('SELECT COUNT(*) FROM meeting_attendees WHERE meeting_id = ? AND user_id = ?', [m.id, sundar.user.id]);
    assert.equal(Number(n), 1);
  });

  test('a rotated link stops the old one working', async () => {
    const old = m.invite_token;
    const res = await api.post(`/ai-meetings/${m.id}/rotate-link`, {}, { token: priya.token });
    assert.notEqual(res.body.data.invite_token, old);
    assert.equal((await api.get(`/ai-meetings/link/${old}`, { token: rahul.token })).status, 404);
  });

  test('another workspace cannot use the link', async () => {
    const other = await signUpTenant(api, { agency_name: 'Other Co', email: 'owner@other.test' });
    const res = await api.get(`/ai-meetings/link/${m.invite_token}`, { token: other.access_token });
    assert.equal(res.status, 404);
  });
});

describe('dashboard and reminders', () => {
  test('the dashboard separates now, upcoming, mine and invitations', async () => {
    await api.post('/ai-meetings', { title: 'Design review', date: day(2), time: '16:00', duration_minutes: 30, participant_ids: [rahul.user.id] }, { token: divya.token });
    const d = (await api.get('/ai-meetings/dashboard', { token: rahul.token })).body.data;
    assert.ok(d.invitations.some((x) => x.title === 'Design review'));
    assert.ok(d.upcoming.some((x) => x.title === 'Design review'));
    assert.equal(d.pending_approvals, null, 'employees do not see the approval numbers');
    const mgr = (await api.get('/ai-meetings/dashboard', { token: divya.token })).body.data;
    assert.ok(mgr.mine.some((x) => x.title === 'Design review'));
    assert.equal(typeof mgr.pending_approvals, 'number');
    assert.ok(mgr.live.some((x) => x.title === 'Quick sync'), 'the manager sees a meeting her report is running now');
  });

  test('a reminder goes out once, about fifteen minutes before', async () => {
    const soon = new Date(Date.now() + 10 * 60_000);
    const id = await live.insertLiveMeeting(owner.tenant.id, {
      title: 'Standup', organizer_id: divya.user.id, host_id: divya.user.id, scheduled_at: soon.toISOString(), duration_minutes: 15,
    });
    await live.addAttendees(owner.tenant.id, id, new Map([[priya.user.id, 'individual'], [divya.user.id, 'individual']]), { hostId: divya.user.id });
    const first = await live.sendMeetingReminders();
    const second = await live.sendMeetingReminders();
    assert.ok(first >= 1);
    assert.equal(second, 0);
    const n = (await notesOf(priya)).filter((x) => /Starting soon: Standup/.test(x.title));
    assert.equal(n.length, 1);
  });

  test('the old Meetings & MOM invite now uses the meeting invitation', async () => {
    const res = await api.post('/meetings', {
      title: 'Client kickoff', scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), duration_minutes: 30,
      attendees: [{ user_id: rahul.user.id }],
    }, { token: divya.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const n = (await notesOf(rahul)).find((x) => /Meeting invitation: Client kickoff/.test(x.title));
    assert.ok(n);
  });
});
