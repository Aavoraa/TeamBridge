import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
process.env.ANTHROPIC_API_KEY = '';
process.env.OPENAI_API_KEY = '';

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const intel = await import('../src/services/meetingIntel.js');
const { scheduleFollowUps } = await import('../src/services/followUpMeetings.js');
const api = await startServer();
after(() => { intel.setMeetingProvidersForTests(null); api.close(); });

const owner = await signUpTenant(api, { agency_name: 'Follow Co', email: 'owner@fu.test', owner_name: 'Arun Prakash' });
async function join(name, email, role = 'employee') {
  const invite = await api.post('/users', { name, email, role }, { token: owner.access_token });
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const ok = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  return { user: invite.body.data, token: ok.body.data.access_token };
}

let divya; let rahul; let priya;
before(async () => {
  divya = await join('Divya Ramesh', 'divya@fu.test', 'manager');
  rahul = await join('Rahul Kumar', 'rahul@fu.test');
  priya = await join('Priya Raman', 'priya@fu.test');
});

async function analyse(followUps, { meetingDate = '2030-03-04' } = {}) {
  intel.setMeetingProvidersForTests({
    analyze: async () => ({
      summary: { overview: 'Review.', topics: [], updates: [], decisions: [], problems: [], client_discussions: [], conclusions: [] },
      action_items: [],
      open_items: { unassigned_tasks: [], unclear_deadlines: [], pending_decisions: [], unresolved_issues: [], follow_ups: [], follow_up_meetings: [], repeated_issues: [], risks: [] },
      follow_up_meetings: followUps,
    }),
  });
  const text = '[00:00:05] Divya: Rahul and Priya, let us meet again on Thursday at 3pm to review the POS scope.\n[00:00:09] Rahul: Sure.';
  const bytes = Buffer.from(text);
  const res = await api.post('/meeting-intel', {
    title: 'POS scope', meeting_date: meetingDate, source_kind: 'transcript', file_name: 'm.txt', file_mime: 'text/plain',
    file_size: bytes.length, file_sha256: crypto.createHash('sha256').update(bytes).update(crypto.randomUUID()).digest('hex'),
    consent: true, parts: [{ index: 0, size: bytes.length, mime: 'text/plain' }],
  }, { token: divya.token });
  const id = res.body.data.id;
  await fetch(`${api.base}/meeting-intel/${id}/parts/0?offset=0`, {
    method: 'PUT', headers: { Authorization: `Bearer ${divya.token}`, 'Content-Type': 'application/octet-stream' }, body: bytes,
  });
  let m;
  for (let i = 0; i < 10; i++) {
    m = (await api.post(`/meeting-intel/${id}/advance`, {}, { token: divya.token })).body.data;
    if (!['queued', 'transcribing', 'analyzing'].includes(m.status)) break;
  }
  return m;
}

const fu = (over) => ({
  title: 'Follow-up: POS scope', purpose: 'Review the POS scope', when_text: 'Thursday at 3pm', date: '2030-03-07', time: '15:00',
  timing_status: 'resolved', duration_minutes: 45, participant_names: ['Rahul', 'Priya Raman'], same_people_as_this_meeting: false,
  evidence_segments: [0], confidence: 'high', cancelled: false, ...over,
});

describe('follow-up meetings found in a transcript', () => {
  let m;
  before(async () => {
    m = await analyse([
      fu(),
      fu({ title: 'Design check-in', when_text: 'Friday', date: '2030-03-08', time: '', timing_status: 'date_only', participant_names: [], same_people_as_this_meeting: true, duration_minutes: 0 }),
      fu({ title: 'Client call', when_text: 'next week', date: '', time: '', timing_status: 'ambiguous' }),
      fu({ title: 'Budget sync', cancelled: true }),
      fu({ title: 'Maybe a retro', confidence: 'low' }),
    ]);
  });

  test('a follow-up with a day and time is booked on the calendar with the named people', async () => {
    assert.equal(m.status, 'review');
    const f = m.follow_ups.find((x) => x.title === 'Follow-up: POS scope');
    assert.equal(f.status, 'scheduled');
    assert.ok(f.meeting_id);
    const cal = await db.get('SELECT * FROM meetings WHERE id = ?', [f.meeting_id]);
    assert.equal(cal.status, 'scheduled');
    assert.equal(cal.scheduled_at, '2030-03-07T09:30:00.000Z', '15:00 in Asia/Kolkata');
    assert.equal(cal.duration_minutes, 45);
    assert.equal(cal.host_id, divya.user.id);
    assert.match(cal.description, /Follow-up from "POS scope"/);
    const people = (await db.all('SELECT user_id, role FROM meeting_attendees WHERE meeting_id = ?', [f.meeting_id]))
      .map((a) => a.user_id).sort();
    assert.deepEqual(people, [divya.user.id, rahul.user.id, priya.user.id].sort());
    assert.deepEqual(f.people.map((p) => p.name).sort(), ['Divya Ramesh', 'Priya Raman', 'Rahul Kumar']);
  });

  test('invitees are notified, and the host is told it was booked', async () => {
    const f = m.follow_ups.find((x) => x.title === 'Follow-up: POS scope');
    const invited = await db.all("SELECT user_id FROM notifications WHERE event_key = 'meeting.invited' AND channel = 'in_app' AND link = ?", [`/ai-meetings/m/${f.meeting_id}`]);
    assert.deepEqual(invited.map((n) => n.user_id).sort(), [rahul.user.id, priya.user.id].sort());
    const host = await db.get("SELECT title, body FROM notifications WHERE event_key = 'meeting.followup_scheduled' AND user_id = ? AND link = ?", [divya.user.id, `/ai-meetings/m/${f.meeting_id}`]);
    assert.match(host.title, /Follow-up booked: Follow-up: POS scope/);
    assert.match(host.body, /Priya Raman/);
    const rahulSees = await api.get(`/ai-meetings/${f.meeting_id}`, { token: rahul.token });
    assert.equal(rahulSees.status, 200, 'it is on their calendar');
  });

  test('a day without a time is booked at a sensible time and says so', async () => {
    const f = m.follow_ups.find((x) => x.title === 'Design check-in');
    assert.equal(f.status, 'scheduled');
    assert.equal(f.time_assumed, true);
    assert.equal(f.time, '10:00');
    const cal = await db.get('SELECT scheduled_at, duration_minutes FROM meetings WHERE id = ?', [f.meeting_id]);
    assert.equal(cal.scheduled_at, '2030-03-08T04:30:00.000Z');
    assert.equal(cal.duration_minutes, 30);
  });

  test('vague, called-off and doubtful follow-ups are kept as suggestions, not booked', () => {
    const by = Object.fromEntries(m.follow_ups.map((x) => [x.title, x]));
    assert.equal(by['Client call'].status, 'needs_date');
    assert.equal(by['Client call'].meeting_id, null);
    assert.equal(by['Budget sync'].status, 'cancelled_in_meeting');
    assert.equal(by['Maybe a retro'].status, 'not_scheduled');
  });

  test('analysing the same meeting again never books it twice', async () => {
    const ai = await db.get('SELECT * FROM ai_meetings WHERE id = ?', [m.id]);
    const before = Number((await db.get('SELECT COUNT(*) AS n FROM meetings WHERE tenant_id = ?', [ai.tenant_id])).n);
    await scheduleFollowUps(ai, [fu(), fu({ title: 'Client call', date: '', timing_status: 'none' })], { segments: [] });
    const afterCount = Number((await db.get('SELECT COUNT(*) AS n FROM meetings WHERE tenant_id = ?', [ai.tenant_id])).n);
    assert.equal(afterCount, before);
    const rows = await db.all('SELECT title, status FROM ai_meeting_followups WHERE ai_meeting_id = ? ORDER BY title', [m.id]);
    assert.equal(rows.filter((r) => r.status === 'scheduled').length, 2, 'both earlier bookings kept');
    assert.ok(rows.some((r) => r.title === 'Client call' && r.status === 'needs_date'));
  });
});

test('a follow-up without a day can be booked by picking one; it is booked once', async () => {
  const m = await analyse([fu({ title: 'Vendor call', date: '', time: '', timing_status: 'ambiguous', when_text: 'next week' })]);
  const f = m.follow_ups[0];
  assert.equal(f.status, 'needs_date');
  const past = await api.post(`/meeting-intel/${m.id}/follow-ups/${f.id}/book`, { date: '2020-01-01', time: '10:00' }, { token: divya.token });
  assert.equal(past.status, 400);
  const res = await api.post(`/meeting-intel/${m.id}/follow-ups/${f.id}/book`, { date: '2030-03-12', time: '11:30' }, { token: divya.token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const booked = res.body.data.follow_ups[0];
  assert.equal(booked.status, 'scheduled');
  assert.equal(booked.date, '2030-03-12');
  const cal = await db.get('SELECT scheduled_at, host_id FROM meetings WHERE id = ?', [booked.meeting_id]);
  assert.equal(cal.scheduled_at, '2030-03-12T06:00:00.000Z');
  assert.equal(cal.host_id, divya.user.id);
  const again = await api.post(`/meeting-intel/${m.id}/follow-ups/${f.id}/book`, { date: '2030-03-13', time: '11:30' }, { token: divya.token });
  assert.equal(again.status, 400);
});

test('a follow-up whose day has already passed is not booked', async () => {
  const m = await analyse([fu({ date: '2020-01-09' })], { meetingDate: '2020-01-06' });
  assert.equal(m.follow_ups[0].status, 'in_past');
  assert.equal(m.follow_ups[0].meeting_id, null);
});

test('without a meeting date nothing relative is booked', async () => {
  const m = await analyse([fu()], { meetingDate: '' });
  assert.equal(m.follow_ups[0].status, 'needs_date');
});
