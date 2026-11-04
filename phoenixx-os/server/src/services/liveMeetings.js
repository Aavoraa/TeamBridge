import crypto from 'node:crypto';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { DEFAULT_TZ, localToUtc, todayInTz, timeInTz, formatDueTime } from '../lib/dueTime.js';
import { notifyMany } from './notifications.js';
import { config } from '../config.js';

/**
 * AI Meetings - live internal video meetings, stored in the same `meetings`
 * table as Meetings & MOM (kind = 'live'), so a live meeting has an agenda,
 * attendees and minutes like any other, and the existing pages keep working.
 *
 * Who may see a live meeting:
 *   owner / platform admin  - every meeting in the workspace
 *   manager                 - meetings they host or attend, and meetings their
 *                             direct reports host or attend
 *   everyone else           - meetings they host or are invited to
 * A meeting opened to the workspace ("anyone with the link") additionally
 * admits any active colleague who has the link; they are added as an
 * attendee when they open it.
 */

export const KIND = 'live';
export const MAX_OCCURRENCES = 26;

const ALL_SCOPE = ['owner', 'super_admin'];

export const newToken = () => crypto.randomBytes(18).toString('base64url');
export const roomNameFor = (tenantId, meetingId) => `t${tenantId.slice(0, 8)}-${meetingId}`;
export const joinUrl = (token) => `${config.webBaseUrl}/ai-meetings/j/${token}`;

const ATT = `(SELECT 1 FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.deleted_at IS NULL AND a.user_id = ?)`;

/** SQL filter (on alias m) for the meetings this user may see. */
export function visibility(auth) {
  if (ALL_SCOPE.includes(auth.role)) return { where: '1 = 1', params: [] };
  const mine = `(m.host_id = ? OR m.organizer_id = ? OR EXISTS ${ATT})`;
  if (auth.role === 'manager') {
    return {
      where: `(${mine} OR m.host_id IN (SELECT id FROM users WHERE manager_id = ?)
              OR EXISTS (SELECT 1 FROM meeting_attendees a JOIN users ru ON ru.id = a.user_id
                          WHERE a.meeting_id = m.id AND a.deleted_at IS NULL AND ru.manager_id = ?))`,
      params: [auth.userId, auth.userId, auth.userId, auth.userId, auth.userId],
    };
  }
  return { where: mine, params: [auth.userId, auth.userId, auth.userId] };
}

/**
 * SQL for "this user may see the analysed meeting (ai_meetings row) `a`": owners
 * see all; anyone else sees what they uploaded, plus meetings recorded in AI
 * Meetings that `visibility` lets them see (host, on it, or a manager whose
 * direct reports hosted or attended). One rule for Meeting Intelligence and
 * every dashboard count, so they always agree.
 */
export function intelScope(auth, a = 'm') {
  if (auth.scope === 'all' || ALL_SCOPE.includes(auth.role)) return { where: '1 = 1', params: [] };
  const live = visibility(auth);
  return {
    where: `(${a}.uploaded_by = ? OR EXISTS (SELECT 1 FROM meetings lm WHERE lm.ai_meeting_id = ${a}.id AND lm.tenant_id = ${a}.tenant_id
              AND ${live.where.replace(/\bm\./g, 'lm.')}))`,
    params: [auth.userId, ...live.params],
  };
}

export const canManage = (auth, m) => ALL_SCOPE.includes(auth.role) || m.host_id === auth.userId || m.organizer_id === auth.userId;

/** Active colleagues - the only people who can be invited (never client logins). */
export async function staff(tenantId) {
  return all(
    `SELECT id, name, email, designation, department, avatar_url, role, manager_id FROM users
      WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role NOT IN ('client', 'super_admin')
      ORDER BY name`, [tenantId],
  );
}

/**
 * Individual invitations plus whole departments, resolved to people now (a
 * department invite is a snapshot: someone who joins the department later is
 * not silently added to old meetings). Unknown ids are refused, not ignored.
 */
export async function resolveInvitees(tenantId, { user_ids = [], departments = [] }) {
  const people = await staff(tenantId);
  const byId = new Map(people.map((p) => [p.id, p]));
  const out = new Map();
  for (const id of user_ids) {
    if (!byId.has(id)) { const e = new Error('One of the invited people is not an active colleague'); e.status = 400; throw e; }
    out.set(id, 'individual');
  }
  const wanted = new Set(departments.map((d) => d.trim().toLowerCase()).filter(Boolean));
  for (const p of people) {
    if (p.department && wanted.has(p.department.trim().toLowerCase()) && !out.has(p.id)) out.set(p.id, `department:${p.department}`);
  }
  return out; // user_id -> invited_via
}

/** Adds people who are not already invited. Returns only the newly added ids. */
export async function addAttendees(tenantId, meetingId, invitees, { hostId } = {}) {
  const added = [];
  const ts = nowIso();
  for (const [userId, via] of invitees) {
    if (!userId) continue;
    // One row per person per meeting, even if two invites race: insert only if absent.
    const r = await run(
      `INSERT INTO meeting_attendees (id, tenant_id, meeting_id, user_id, role, invited_via, response, created_at)
       SELECT ?,?,?,?,?,?,?,?
        WHERE NOT EXISTS (SELECT 1 FROM meeting_attendees WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL)`,
      [uuid(), tenantId, meetingId, userId, userId === hostId ? 'host' : 'participant', via,
        userId === hostId ? 'accepted' : 'pending', ts, meetingId, userId],
    );
    if (r.changes) added.push(userId);
  }
  return added;
}

// ------------------------------------------------------------------ time
export async function tzOf(tenantId) {
  return (await get('SELECT timezone FROM tenants WHERE id = ?', [tenantId]))?.timezone || DEFAULT_TZ;
}

export function whenLabel(iso, tz) {
  const d = new Date(iso);
  const day = d.toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: tz });
  return `${day}, ${formatDueTime(timeInTz(tz, d))}`;
}

/** The occurrence start times of a recurring meeting, first one included. */
export function occurrences(firstIso, recurrence, untilDate, tz) {
  const first = new Date(firstIso);
  if (!recurrence) return [first.toISOString()];
  const day = todayInTz(tz, first);
  const time = timeInTz(tz, first);
  const out = [];
  const [y, mo, d] = day.split('-').map(Number);
  for (let i = 0; i < MAX_OCCURRENCES; i++) {
    const cal = new Date(Date.UTC(y, mo - 1, d));
    if (recurrence === 'daily') cal.setUTCDate(cal.getUTCDate() + i);
    else if (recurrence === 'weekly') cal.setUTCDate(cal.getUTCDate() + 7 * i);
    else if (recurrence === 'monthly') {
      cal.setUTCMonth(cal.getUTCMonth() + i);
      if (cal.getUTCDate() !== d) continue; // no 31 February: that month is skipped
    }
    const date = cal.toISOString().slice(0, 10);
    if (untilDate && date > untilDate) break;
    out.push(localToUtc(date, time, tz).toISOString());
  }
  return out;
}

// ---------------------------------------------------------- notifications
export async function notifyInvited(meeting, userIds, { hostName, tz, occurrenceCount = 1 }) {
  if (!userIds.length) return;
  await notifyMany({
    tenantId: meeting.tenant_id,
    userIds,
    eventKey: 'meeting.invited',
    vars: {
      title: meeting.title,
      host: hostName,
      when: whenLabel(meeting.scheduled_at, tz),
      duration: meeting.duration_minutes,
      recurring: meeting.recurrence ? `, repeating ${meeting.recurrence} (${occurrenceCount} meetings)` : '',
    },
    link: `/ai-meetings/m/${meeting.id}`,
    dedupeKey: `meeting.invited:${meeting.series_id || meeting.id}`,
  }).catch((err) => console.error('[meetings] invite notification failed', err.message));
}

/** Everyone who should hear about a change: attendees who have not declined, minus the person acting. */
export async function audience(meetingId, exceptUserId) {
  return (await all(
    `SELECT user_id FROM meeting_attendees WHERE meeting_id = ? AND deleted_at IS NULL AND user_id IS NOT NULL
       AND response <> 'declined' AND user_id <> ?`, [meetingId, exceptUserId || ''],
  )).map((r) => r.user_id);
}

/**
 * Cron (every few minutes): a reminder ~15 minutes before each live meeting,
 * once - the reminder_sent_at claim makes a repeated or overlapping tick
 * send nothing twice.
 */
export async function sendMeetingReminders() {
  const now = Date.now();
  const soon = new Date(now + 15 * 60_000).toISOString();
  const due = await all(
    `SELECT * FROM meetings WHERE kind = ? AND status = 'scheduled' AND deleted_at IS NULL AND cancelled_at IS NULL
       AND reminder_sent_at IS NULL AND scheduled_at <= ? AND scheduled_at >= ?`,
    [KIND, soon, new Date(now - 5 * 60_000).toISOString()],
  );
  let sent = 0;
  for (const m of due) {
    const claim = await run('UPDATE meetings SET reminder_sent_at = ? WHERE id = ? AND reminder_sent_at IS NULL', [nowIso(), m.id]);
    if (!claim.changes) continue;
    const tz = await tzOf(m.tenant_id);
    const ids = await audience(m.id, '');
    if (m.host_id && !ids.includes(m.host_id)) ids.push(m.host_id);
    await notifyMany({
      tenantId: m.tenant_id,
      userIds: ids,
      eventKey: 'meeting.reminder',
      vars: { title: m.title, time: formatDueTime(timeInTz(tz, new Date(m.scheduled_at))) },
      link: `/ai-meetings/m/${m.id}`,
      dedupeKey: `meeting.reminder:${m.id}`,
    }).catch(() => {});
    sent++;
  }
  return sent;
}

export async function insertLiveMeeting(tenantId, fields) {
  const id = uuid();
  const ts = nowIso();
  await run(
    `INSERT INTO meetings (id, tenant_id, kind, title, description, agenda, client_id, project_id, department,
       organizer_id, host_id, scheduled_at, duration_minutes, status, room_name, invite_token, access,
       recording_allowed, transcription_allowed, recurrence, recurrence_until, series_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, 'scheduled', ?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, KIND, fields.title, fields.description ?? null, fields.agenda ?? null, fields.client_id ?? null,
      fields.project_id ?? null, fields.department ?? null, fields.organizer_id, fields.host_id, fields.scheduled_at,
      fields.duration_minutes, roomNameFor(tenantId, id), newToken(), fields.access || 'invited',
      fields.recording_allowed ? 1 : 0, fields.transcription_allowed ? 1 : 0, fields.recurrence ?? null,
      fields.recurrence_until ?? null, fields.series_id ?? null, ts, ts],
  );
  return id;
}

export { tx };
