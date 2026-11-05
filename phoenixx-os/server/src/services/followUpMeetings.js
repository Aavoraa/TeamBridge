import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { DEFAULT_TZ, localToUtc, timeInTz } from '../lib/dueTime.js';
import { notifyMany } from './notifications.js';
import { matchPerson } from './taskAssistant.js';
import {
  addAttendees, insertLiveMeeting, notifyInvited, staff as staffOf, whenLabel,
} from './liveMeetings.js';

/**
 * Follow-up meetings found in a transcript ("let's meet again Thursday at 3").
 *
 * One with a date is booked straight onto the calendar as an AI meeting -
 * invitations go out the normal way and the host is told, so a wrong booking is
 * one click to move or cancel. One without a date is kept as a suggestion on the
 * meeting page. A re-analysis of the same meeting never books anything twice.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DEFAULT_TIME = '10:00';

/** The JSON schema piece the analysis returns (see meetingIntel ANALYSIS_SCHEMA). */
export const FOLLOW_UP_SCHEMA = {
  type: 'array',
  description: 'Further meetings that participants agreed should happen. Empty if none.',
  items: {
    type: 'object',
    additionalProperties: false,
    // Kept small on purpose: every field and enum adds to the structured-output
    // grammar, and the API refuses one that is too large. Plain strings here are
    // checked against the allowed values on our side.
    required: ['title', 'purpose', 'when_text', 'date', 'time', 'timing_status', 'duration_minutes',
      'participant_names', 'evidence_segments', 'confidence', 'cancelled'],
    properties: {
      title: { type: 'string', description: 'Short meeting title, e.g. "Follow-up: warehouse POS scope".' },
      purpose: { type: 'string', description: 'What the follow-up is for, from the meeting only.' },
      when_text: { type: 'string', description: 'When it was said to happen, as said ("next Tuesday at 3pm"). Empty if not said.' },
      date: { type: 'string', description: 'YYYY-MM-DD only when timing_status is resolved or date_only. Otherwise empty.' },
      time: { type: 'string', description: 'HH:MM 24-hour only if a time of day was said. Otherwise empty.' },
      timing_status: { type: 'string', description: 'One of: resolved, date_only, ambiguous, none, needs_meeting_date.' },
      duration_minutes: { type: 'integer', description: 'Length if said, otherwise 0.' },
      participant_names: { type: 'array', items: { type: 'string' }, description: 'People singled out to attend, as named. Empty if it is the same group meeting again or nobody was singled out.' },
      evidence_segments: { type: 'array', items: { type: 'integer' }, description: 'Transcript segment numbers where it was agreed.' },
      confidence: { type: 'string', description: 'One of: high, medium, low.' },
      cancelled: { type: 'boolean', description: 'True if the follow-up was later called off in the meeting.' },
    },
  },
};

export const FOLLOW_UP_RULES = `Follow-up meetings:
- Report a follow-up meeting only when participants agreed, decided or were told that another meeting will happen ("let's meet again on Thursday", "we'll review this next Monday at 11", "set up a call with the client next week"). A wish or idea ("we should catch up sometime") is not one.
- Resolve the date like deadlines: against the meeting date, in its calendar. timing_status "resolved" = a date and a time of day were said; "date_only" = a day was said but no time; "ambiguous" = vague ("next week", "soon", "after the launch"); "none" = no timing said; "needs_meeting_date" = relative timing but no meeting date was given. Never invent a date or time.
- One entry per follow-up meeting, even if it is mentioned several times.`;

const s = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Who to invite: named people, or this meeting's group, plus the host. */
async function invitees(tenantId, raw, { hostId, groupIds }) {
  const people = await staffOf(tenantId);
  const active = new Set(people.map((p) => p.id));
  const ids = new Set();
  const names = Array.isArray(raw.participant_names) ? raw.participant_names.map((n) => s(n, 120)).filter(Boolean).slice(0, 30) : [];
  for (const n of names) {
    const hits = matchPerson(n, people);
    // A name several colleagues share: prefer the one who was in this meeting, otherwise leave them out.
    const pick = hits.length === 1 ? hits[0] : hits.filter((h) => groupIds.includes(h.id)).length === 1
      ? hits.find((h) => groupIds.includes(h.id)) : null;
    if (pick) ids.add(pick.id);
  }
  // Nobody singled out (or nobody we could match): the same group meets again.
  if (!ids.size) for (const id of groupIds) ids.add(id);
  if (hostId) ids.add(hostId);
  return [...ids].filter((id) => active.has(id));
}

/**
 * Books one follow-up exactly like a meeting scheduled by hand: on the calendar,
 * invitations to everyone, and a note to the host that it was booked for them.
 */
async function placeOnCalendar({
  tenantId, aiMeeting, live, title, purpose, whenText, start, duration, ids, hostId, hostName, tz, note = '',
}) {
  let meetingId;
  await tx(async () => {
    meetingId = await insertLiveMeeting(tenantId, {
      title,
      description: [purpose, `Follow-up from "${aiMeeting.title}"${whenText ? ` (agreed: "${whenText}")` : ''}.`].filter(Boolean).join('\n\n'),
      organizer_id: hostId, host_id: hostId, scheduled_at: start.toISOString(), duration_minutes: duration,
      project_id: live?.project_id || aiMeeting.project_id || null, client_id: live?.client_id || aiMeeting.client_id || null,
      access: 'invited',
      recording_allowed: live ? !!live.recording_allowed : true, transcription_allowed: live ? !!live.transcription_allowed : true,
    });
    await addAttendees(tenantId, meetingId, new Map(ids.map((id) => [id, 'individual'])), { hostId });
  });
  const m = await get('SELECT * FROM meetings WHERE id = ?', [meetingId]);
  await notifyInvited(m, ids.filter((id) => id !== hostId), { hostName: hostName || 'Your host', tz });
  if (hostId) {
    const names = ids.length
      ? (await all(`SELECT name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).map((u) => u.name) : [];
    await notifyMany({
      tenantId, userIds: [hostId], eventKey: 'meeting.followup_scheduled', link: `/ai-meetings/m/${meetingId}`,
      vars: {
        source: aiMeeting.title, title, when: whenLabel(m.scheduled_at, tz), duration,
        people: names.join(', ') || 'you', assumed: note,
      },
      dedupeKey: `meeting.followup:${meetingId}`,
    }).catch(() => {});
  }
  return meetingId;
}

/**
 * A follow-up the AI could not date, booked by a person who picked the day and
 * time. The invitees and length are the ones the AI found; the person booking
 * becomes the host.
 */
export async function bookFollowUp({ tenantId, followUpId, date, time, actor }) {
  const row = await get(
    "SELECT * FROM ai_meeting_followups WHERE id = ? AND tenant_id = ? AND status != 'scheduled'", [followUpId, tenantId],
  );
  if (!row) return { error: 'not_found' };
  const aiMeeting = await get('SELECT * FROM ai_meetings WHERE id = ? AND tenant_id = ?', [row.ai_meeting_id, tenantId]);
  const tz = (await get('SELECT timezone FROM tenants WHERE id = ?', [tenantId]))?.timezone || DEFAULT_TZ;
  const start = localToUtc(date, time, tz);
  if (start.getTime() < Date.now() - 5 * 60_000) return { error: 'past' };
  const live = aiMeeting.source_kind === 'live'
    ? await get('SELECT * FROM meetings WHERE ai_meeting_id = ? AND tenant_id = ? AND deleted_at IS NULL', [aiMeeting.id, tenantId])
    : null;
  const active = new Set((await staffOf(tenantId)).map((p) => p.id));
  let ids = [];
  try { ids = JSON.parse(row.invitee_ids || '[]'); } catch { /* none */ }
  ids = [...new Set([...ids, actor.userId])].filter((id) => active.has(id));

  // Claim it first, so two people clicking at once book it once.
  const claim = await run(
    "UPDATE ai_meeting_followups SET status = 'scheduled', updated_at = ? WHERE id = ? AND status != 'scheduled'", [nowIso(), row.id],
  );
  if (!claim.changes) return { error: 'not_found' };
  const meetingId = await placeOnCalendar({
    tenantId, aiMeeting, live, title: row.title, purpose: row.purpose, whenText: row.when_text, start,
    duration: row.duration_minutes || 30, ids, hostId: actor.userId, hostName: actor.name, tz,
  });
  await run(
    'UPDATE ai_meeting_followups SET meeting_id = ?, date = ?, time = ?, time_assumed = 0, reason = NULL, invitee_ids = ?, updated_at = ? WHERE id = ?',
    [meetingId, date, time, JSON.stringify(ids), nowIso(), row.id],
  );
  return { meeting_id: meetingId };
}

/**
 * Called after an analysis is saved. `found` is the AI's follow_up_meetings list.
 * Returns the stored rows.
 */
export async function scheduleFollowUps(aiMeeting, found, { segments = [] } = {}) {
  const tenantId = aiMeeting.tenant_id;
  const list = (Array.isArray(found) ? found : []).filter((f) => f && s(f.title, 200)).slice(0, 10);

  // A re-analysis: suggestions are replaced, anything already booked stays booked and is not booked again.
  const booked = await all(
    "SELECT * FROM ai_meeting_followups WHERE ai_meeting_id = ? AND status = 'scheduled'", [aiMeeting.id],
  );
  await run("DELETE FROM ai_meeting_followups WHERE ai_meeting_id = ? AND status != 'scheduled'", [aiMeeting.id]);
  if (!list.length) return booked;

  const tz = (await get('SELECT timezone FROM tenants WHERE id = ?', [tenantId]))?.timezone || DEFAULT_TZ;
  const live = aiMeeting.source_kind === 'live'
    ? await get('SELECT * FROM meetings WHERE ai_meeting_id = ? AND tenant_id = ? AND deleted_at IS NULL', [aiMeeting.id, tenantId])
    : null;
  const hostId = live?.host_id || aiMeeting.uploaded_by;
  const groupIds = live
    ? (await all('SELECT user_id FROM meeting_attendees WHERE meeting_id = ? AND deleted_at IS NULL AND user_id IS NOT NULL', [live.id])).map((r) => r.user_id)
    : [aiMeeting.uploaded_by];
  const host = await get('SELECT id, name FROM users WHERE id = ?', [hostId]);
  const sameTime = live ? timeInTz(tz, new Date(live.scheduled_at)) : DEFAULT_TIME;
  const byIndex = new Map(segments.map((x) => [x.i, x]));
  const out = [...booked];

  for (const [idx, raw] of list.entries()) {
    const title = s(raw.title, 200);
    const status = ['resolved', 'date_only', 'ambiguous', 'none', 'needs_meeting_date'].includes(raw.timing_status) ? raw.timing_status : 'ambiguous';
    let date = DATE_RE.test(s(raw.date, 10)) ? raw.date : '';
    let time = TIME_RE.test(s(raw.time, 5)) ? raw.time : '';
    if (!['resolved', 'date_only'].includes(status) || !aiMeeting.meeting_date) date = '';
    const assumed = !!date && !time;
    if (assumed) time = sameTime;
    const evidence = (Array.isArray(raw.evidence_segments) ? raw.evidence_segments : []).map(Number).filter((i) => byIndex.has(i)).slice(0, 4);
    const quote = evidence.slice(0, 2).map((i) => { const g = byIndex.get(i); return `${g.speaker ? `${g.speaker}: ` : ''}${g.text}`; }).join(' … ').slice(0, 600);
    const duration = Math.min(480, Math.max(15, Number(raw.duration_minutes) || live?.duration_minutes || 30));
    const ids = await invitees(tenantId, raw, { hostId, groupIds });
    const ts = nowIso();
    const row = {
      id: uuid(), idx, title, purpose: s(raw.purpose, 1000) || null, when_text: s(raw.when_text, 160) || null,
      date: date || null, time: date ? time : null, time_assumed: assumed ? 1 : 0, duration_minutes: duration,
      invitee_ids: JSON.stringify(ids), evidence_json: JSON.stringify({ segments: evidence, quote }),
      confidence: ['high', 'medium', 'low'].includes(raw.confidence) ? raw.confidence : 'medium',
      status: 'needs_date', reason: null, meeting_id: null,
    };

    // The same follow-up already booked by an earlier analysis (same day and title): leave it.
    const dup = booked.find((b) => b.date === row.date && b.title.toLowerCase() === title.toLowerCase());
    if (dup) continue;

    if (raw.cancelled === true) { row.status = 'cancelled_in_meeting'; row.reason = 'Called off later in the meeting'; }
    else if (!date) {
      row.reason = status === 'needs_meeting_date' ? 'The meeting date is unknown, so the day could not be worked out'
        : status === 'none' ? 'No day was said' : 'The day was not clear';
    } else if (row.confidence === 'low') { row.status = 'not_scheduled'; row.reason = 'It was not clear a meeting was agreed'; }
    else {
      const start = localToUtc(date, time, tz);
      if (start.getTime() < Date.now()) { row.status = 'in_past'; row.reason = 'That time has already passed'; }
      else {
        row.meeting_id = await placeOnCalendar({
          tenantId, aiMeeting, live, title, purpose: row.purpose, whenText: row.when_text, start, duration, ids,
          hostId, hostName: host?.name, tz,
          note: assumed ? (live ? ' No time was said, so it is at the same time as the original meeting.' : ` No time was said, so it is at ${DEFAULT_TIME}.`) : '',
        });
        row.status = 'scheduled';
      }
    }

    await run(
      `INSERT INTO ai_meeting_followups (id, tenant_id, ai_meeting_id, idx, title, purpose, when_text, date, time, time_assumed,
         duration_minutes, invitee_ids, evidence_json, confidence, status, reason, meeting_id, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [row.id, tenantId, aiMeeting.id, idx, row.title, row.purpose, row.when_text, row.date, row.time, row.time_assumed,
        row.duration_minutes, row.invitee_ids, row.evidence_json, row.confidence, row.status, row.reason, row.meeting_id, ts, ts],
    );
    out.push({ ...row, created_at: ts });
  }
  return out;
}

/** For the meeting page: each follow-up with its people and the calendar meeting it became. */
export async function followUpsFor(aiMeetingId, tenantId) {
  const rows = await all(
    `SELECT f.*, m.scheduled_at, m.status AS meeting_status, m.cancelled_at
       FROM ai_meeting_followups f LEFT JOIN meetings m ON m.id = f.meeting_id
      WHERE f.ai_meeting_id = ? AND f.tenant_id = ? ORDER BY f.idx`, [aiMeetingId, tenantId],
  );
  if (!rows.length) return [];
  const ids = [...new Set(rows.flatMap((r) => { try { return JSON.parse(r.invitee_ids || '[]'); } catch { return []; } }))];
  const names = new Map(ids.length
    ? (await all(`SELECT id, name FROM users WHERE id IN (${ids.map(() => '?').join(',')})`, ids)).map((u) => [u.id, u.name])
    : []);
  return rows.map(({ invitee_ids: inv, evidence_json: ev, tenant_id: _t, ...r }) => {
    let people = [];
    try { people = JSON.parse(inv || '[]').map((id) => ({ id, name: names.get(id) || 'Someone' })); } catch { /* none */ }
    let evidence = null;
    try { evidence = JSON.parse(ev || 'null'); } catch { /* none */ }
    return { ...r, time_assumed: !!Number(r.time_assumed), people, quote: evidence?.quote || null, cancelled: !!r.cancelled_at };
  });
}
