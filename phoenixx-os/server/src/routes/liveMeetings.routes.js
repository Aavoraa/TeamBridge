import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, forbidden, audit, ApiError } from '../lib/http.js';
import { config } from '../config.js';
import {
  livekitConfigured, ensureRoom, joinToken, attendance, VideoUnavailable,
  muteParticipant, removeFromRoom, closeRoom, updateInRoom, listRoomParticipants,
} from '../services/livekit.js';
import {
  captureAvailability, publishRoomState, roomState, startCapture, stopCapture, setCaptions, onRoomClosed,
  listRoomRecordings, deleteRecording,
} from '../services/meetingCapture.js';
import { requires, can } from '../middleware/rbac.js';
import { localToUtc, todayInTz, timeInTz } from '../lib/dueTime.js';
import { notifyMany } from '../services/notifications.js';
import {
  KIND, visibility, intelScope, canManage, staff, resolveInvitees, addAttendees, tzOf, whenLabel, occurrences,
  notifyInvited, audience, insertLiveMeeting, joinUrl, newToken,
} from '../services/liveMeetings.js';

/**
 * AI Meetings: scheduling, instant meetings, invitations and responses for
 * live video meetings. The live room itself (LiveKit) is Phase 3.
 * Permissions: the existing `meetings` module (view / create / edit).
 */
const router = Router();
router.use(requires('meetings', 'view'));

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const SELECT = `
  SELECT m.id, m.title, m.description, m.agenda, m.department, m.scheduled_at, m.duration_minutes, m.status,
         m.access, m.recording_allowed, m.transcription_allowed, m.started_at, m.ended_at, m.recurrence,
         m.recurrence_until, m.series_id, m.cancelled_at, m.cancel_reason, m.project_id, m.client_id,
         m.host_id, m.organizer_id, m.invite_token, m.ai_meeting_id, m.locked, m.created_at, m.updated_at,
         h.name AS host_name, h.avatar_url AS host_avatar, p.name AS project_name, c.name AS client_name,
         (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.deleted_at IS NULL) AS invited_count,
         (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.deleted_at IS NULL AND a.response = 'accepted') AS accepted_count,
         (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.deleted_at IS NULL AND a.response = 'declined') AS declined_count,
         (SELECT COUNT(*) FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.deleted_at IS NULL AND a.attended = 1) AS attended_count,
         -- History: what came out of the meeting (counts only; the content has its own access check).
         (SELECT COUNT(*) FROM meeting_recordings r WHERE r.meeting_id = m.id AND r.kind = 'video' AND r.status = 'complete'
             AND r.deleted_at IS NULL) AS recordings_count,
         am.status AS ai_status,
         CASE WHEN am.transcript_json IS NOT NULL THEN 1 ELSE 0 END AS has_transcript,
         CASE WHEN am.summary_json IS NOT NULL THEN 1 ELSE 0 END AS has_summary,
         (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = am.id AND i.status <> 'cancelled_in_meeting') AS tasks_extracted,
         (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = am.id AND i.status = 'approved') AS tasks_approved,
         (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = am.id AND i.status = 'rejected') AS tasks_rejected
    FROM meetings m
    LEFT JOIN users h ON h.id = m.host_id
    LEFT JOIN projects p ON p.id = m.project_id
    LEFT JOIN clients c ON c.id = m.client_id
    LEFT JOIN ai_meetings am ON am.id = m.ai_meeting_id AND am.deleted_at IS NULL`;

const num = (r) => r && ({
  ...r,
  invited_count: Number(r.invited_count), accepted_count: Number(r.accepted_count),
  declined_count: Number(r.declined_count), attended_count: Number(r.attended_count),
  recording_allowed: !!r.recording_allowed, transcription_allowed: !!r.transcription_allowed,
  recordings_count: Number(r.recordings_count || 0),
  has_transcript: Number(r.has_transcript) === 1, has_summary: Number(r.has_summary) === 1,
  tasks_extracted: Number(r.tasks_extracted || 0), tasks_approved: Number(r.tasks_approved || 0), tasks_rejected: Number(r.tasks_rejected || 0),
  // How long it actually ran, when it ran.
  actual_minutes: r.started_at && r.ended_at ? Math.max(1, Math.round((Date.parse(r.ended_at) - Date.parse(r.started_at)) / 60_000)) : null,
});

async function meetingFor(req, id) {
  const v = visibility(req.auth);
  const m = await get(
    `${SELECT} WHERE m.id = ? AND m.tenant_id = ? AND m.kind = ? AND m.deleted_at IS NULL AND ${v.where}`,
    [id, req.auth.tenantId, KIND, ...v.params],
  );
  if (!m) throw notFound('Meeting');
  return num(m);
}

async function myResponse(meetingId, userId) {
  return (await get('SELECT response FROM meeting_attendees WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL',
    [meetingId, userId]))?.response || null;
}

async function withPeople(req, m) {
  const attendees = await all(
    `SELECT a.user_id, a.role, a.response, a.responded_at, a.invited_via, a.attended,
            u.name, u.email, u.designation, u.department, u.avatar_url
       FROM meeting_attendees a JOIN users u ON u.id = a.user_id
      WHERE a.meeting_id = ? AND a.deleted_at IS NULL ORDER BY (a.role = 'host') DESC, u.name`, [m.id],
  );
  const manage = canManage(req.auth, m);
  return {
    ...m,
    // The link's secret is only for people who may hand it out.
    invite_token: manage || m.access === 'workspace' ? m.invite_token : null,
    join_url: manage || m.access === 'workspace' ? joinUrl(m.invite_token) : null,
    attendees,
    my_response: await myResponse(m.id, req.auth.userId),
    can_manage: manage,
    is_host: m.host_id === req.auth.userId,
    video_ready: livekitConfigured(),
    attendance: m.status === 'scheduled' ? [] : await attendance(m.id),
  };
}

// ------------------------------------------------------------- directory
router.get('/directory', async (req, res) => {
  const people = await staff(req.auth.tenantId);
  const departments = [...new Set(people.map((p) => p.department).filter(Boolean))].sort();
  return ok(res, {
    people: people.map(({ manager_id, ...p }) => p),
    departments,
    projects: await all('SELECT id, name, client_id FROM projects WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name', [req.auth.tenantId]),
    clients: await all('SELECT id, name FROM clients WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name', [req.auth.tenantId]),
  });
});

// ------------------------------------------------------------- dashboard
router.get('/dashboard', async (req, res) => {
  const { tenantId, userId } = req.auth;
  const v = visibility(req.auth);
  const base = `${SELECT} WHERE m.tenant_id = ? AND m.kind = ? AND m.deleted_at IS NULL AND ${v.where}`;
  const p = [tenantId, KIND, ...v.params];
  const now = nowIso();
  const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString();
  const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();

  const happening = await all(
    `${base} AND m.cancelled_at IS NULL AND (m.status = 'live'
       OR (m.status = 'scheduled' AND m.scheduled_at <= ? AND m.scheduled_at >= ?))
     ORDER BY m.scheduled_at`, [...p, now, new Date(Date.now() - 3 * 3_600_000).toISOString()],
  );
  const live = happening.filter((m) => m.status === 'live'
    || Date.parse(m.scheduled_at) + m.duration_minutes * 60_000 > Date.now());
  const upcoming = await all(
    `${base} AND m.status = 'scheduled' AND m.cancelled_at IS NULL AND m.scheduled_at > ? AND m.scheduled_at <= ?
     ORDER BY m.scheduled_at LIMIT 20`, [...p, now, inAWeek],
  );
  const recent = await all(
    `${base} AND m.status IN ('completed', 'ended') AND COALESCE(m.ended_at, m.scheduled_at) >= ?
     ORDER BY COALESCE(m.ended_at, m.scheduled_at) DESC LIMIT 10`, [...p, twoWeeksAgo],
  );
  const mine = await all(
    `${base} AND (m.host_id = ? OR m.organizer_id = ?) AND m.cancelled_at IS NULL AND m.scheduled_at >= ?
     ORDER BY m.scheduled_at LIMIT 10`, [...p, userId, userId, now],
  );
  const invitations = await all(
    `${SELECT} JOIN meeting_attendees me ON me.meeting_id = m.id AND me.user_id = ? AND me.deleted_at IS NULL AND me.response = 'pending'
      WHERE m.tenant_id = ? AND m.kind = ? AND m.deleted_at IS NULL AND m.cancelled_at IS NULL AND m.status = 'scheduled'
        AND m.scheduled_at >= ? AND m.host_id <> ?
      ORDER BY m.scheduled_at LIMIT 20`, [userId, tenantId, KIND, now, userId],
  );

  // AI Meeting Intelligence numbers, for the people who can see that module.
  let pendingAnalyses = null;
  let pendingApprovals = null;
  if (await can(req.auth, 'meeting_intelligence', 'view')) {
    // The same visibility rule as Meeting Intelligence itself, so these numbers match its lists.
    const s = intelScope(req.auth, 'am');
    pendingAnalyses = Number((await get(
      `SELECT COUNT(*) AS n FROM ai_meetings am WHERE am.tenant_id = ? AND am.deleted_at IS NULL
         AND am.status IN ('uploading','queued','transcribing','analyzing') AND ${s.where}`, [tenantId, ...s.params],
    )).n);
    pendingApprovals = Number((await get(
      `SELECT COUNT(*) AS n FROM ai_meeting_items i JOIN ai_meetings am ON am.id = i.meeting_id
        WHERE i.tenant_id = ? AND i.status = 'proposed' AND am.status = 'review' AND am.deleted_at IS NULL AND ${s.where}`,
      [tenantId, ...s.params],
    )).n);
  }

  // Attendance across the meetings this user can see that have finished.
  const att = await get(
    `SELECT COUNT(*) AS invited, COALESCE(SUM(CASE WHEN a.attended = 1 THEN 1 ELSE 0 END), 0) AS attended
       FROM meeting_attendees a JOIN meetings m ON m.id = a.meeting_id
      WHERE m.tenant_id = ? AND m.kind = ? AND m.deleted_at IS NULL AND a.deleted_at IS NULL
        AND m.status IN ('completed', 'ended') AND COALESCE(m.ended_at, m.scheduled_at) >= ? AND ${v.where}`,
    [tenantId, KIND, twoWeeksAgo, ...v.params],
  );

  return ok(res, {
    live: live.map(num), upcoming: upcoming.map(num), recent: recent.map(num), mine: mine.map(num),
    invitations: invitations.map(num),
    attendance: { invited: Number(att.invited), attended: Number(att.attended) },
    pending_analyses: pendingAnalyses,
    pending_approvals: pendingApprovals,
  });
});

// --------------------------------------------------------------- overview
/**
 * The owner's view of the whole company's meetings, and a manager's view of
 * their scope (meetings they or their direct reports host or attend): by
 * department, who takes part, what the AI summarised, and what waits for
 * approval. Employees have their own dashboard above.
 */
router.get('/overview', async (req, res) => {
  const { tenantId } = req.auth;
  const company = req.auth.scope === 'all' || ['owner', 'super_admin'].includes(req.auth.role);
  if (!company && req.auth.role !== 'manager') throw forbidden('The meetings overview is for owners and managers');
  const days = [7, 30, 90].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const now = Date.now();
  const from = new Date(now - days * 86_400_000).toISOString();
  const until = new Date(now + 7 * 86_400_000).toISOString();
  const v = visibility(req.auth);

  // Every visible meeting in the period, plus the coming week.
  const rows = await all(
    `SELECT m.id, m.title, m.status, m.scheduled_at, m.duration_minutes, m.started_at, m.ended_at, m.cancelled_at,
            COALESCE(NULLIF(m.department, ''), NULLIF(h.department, ''), 'No department') AS dept
       FROM meetings m LEFT JOIN users h ON h.id = m.host_id
      WHERE m.tenant_id = ? AND m.kind = ? AND m.deleted_at IS NULL AND m.scheduled_at >= ? AND m.scheduled_at <= ? AND ${v.where}`,
    [tenantId, KIND, from, until, ...v.params],
  );
  const isDone = (m) => ['completed', 'ended'].includes(m.status);
  const isUpcoming = (m) => !m.cancelled_at && m.status === 'scheduled' && Date.parse(m.scheduled_at) > now;
  // Scheduled, in the past, never started (nobody joined) - only once its slot is over.
  const isMissed = (m) => !m.cancelled_at && m.status === 'scheduled'
    && Date.parse(m.scheduled_at) + (m.duration_minutes || 30) * 60_000 < now;
  const done = rows.filter(isDone);
  const minutes = done.reduce((a, m) => a + (m.started_at && m.ended_at
    ? Math.max(0, (Date.parse(m.ended_at) - Date.parse(m.started_at)) / 60_000) : (m.duration_minutes || 0)), 0);

  // Invitations and attendance for the meetings that happened.
  const doneIds = done.map((m) => m.id);
  const att = doneIds.length ? await all(
    `SELECT a.meeting_id, a.user_id, a.attended, u.name, u.department, u.designation
       FROM meeting_attendees a JOIN users u ON u.id = a.user_id
      WHERE a.deleted_at IS NULL AND a.meeting_id IN (${doneIds.map(() => '?').join(',')})`, doneIds,
  ) : [];
  const deptOf = new Map(rows.map((m) => [m.id, m.dept]));

  const depts = new Map();
  const dept = (name) => {
    if (!depts.has(name)) depts.set(name, { department: name, completed: 0, upcoming: 0, missed: 0, cancelled: 0, invited: 0, attended: 0 });
    return depts.get(name);
  };
  for (const m of rows) {
    const d = dept(m.dept);
    if (isDone(m)) d.completed++;
    else if (m.cancelled_at || m.status === 'cancelled') { if (Date.parse(m.scheduled_at) >= Date.parse(from)) d.cancelled++; } else if (isUpcoming(m)) d.upcoming++;
    else if (isMissed(m)) d.missed++;
  }
  const people = new Map();
  for (const a of att) {
    const d = dept(deptOf.get(a.meeting_id));
    d.invited++;
    if (Number(a.attended) === 1) d.attended++;
    if (!people.has(a.user_id)) people.set(a.user_id, { user_id: a.user_id, name: a.name, department: a.department || null, designation: a.designation || null, invited: 0, attended: 0 });
    const p = people.get(a.user_id);
    p.invited++;
    if (Number(a.attended) === 1) p.attended++;
  }
  const rate = (x) => (x.invited ? Math.round((x.attended / x.invited) * 100) : null);
  const byDepartment = [...depts.values()].map((d) => ({ ...d, attendance_rate: rate(d) }))
    .sort((a, b) => (b.completed + b.upcoming) - (a.completed + a.upcoming) || a.department.localeCompare(b.department));
  const participation = [...people.values()].map((p) => ({ ...p, attendance_rate: rate(p) }))
    .sort((a, b) => a.attendance_rate - b.attendance_rate || b.invited - a.invited || a.name.localeCompare(b.name));

  // What the AI made of the meetings, and what waits for approval - only for those who use Meeting Intelligence.
  let summaries = null;
  let approvals = null;
  if (await can(req.auth, 'meeting_intelligence', 'view')) {
    const s = intelScope(req.auth, 'am');
    const recent = await all(
      `SELECT am.id, am.title, am.meeting_date, am.status, am.summary_json, am.source_kind, am.created_at,
              (SELECT lm.id FROM meetings lm WHERE lm.ai_meeting_id = am.id) AS live_meeting_id,
              (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = am.id AND i.status = 'proposed') AS pending,
              (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = am.id AND i.status = 'approved') AS approved
         FROM ai_meetings am
        WHERE am.tenant_id = ? AND am.deleted_at IS NULL AND am.status IN ('review', 'completed') AND am.created_at >= ? AND ${s.where}
        ORDER BY am.created_at DESC LIMIT 8`, [tenantId, from, ...s.params],
    );
    summaries = recent.map(({ summary_json: sj, ...r }) => {
      let sum = {};
      try { sum = JSON.parse(sj || '{}'); } catch { /* keep empty */ }
      return {
        ...r, pending: Number(r.pending), approved: Number(r.approved),
        overview: sum.overview || '', decisions: (sum.decisions || []).slice(0, 3),
      };
    });
    approvals = (await all(
      `SELECT am.id, am.title, am.meeting_date, am.created_at, COUNT(i.id) AS pending
         FROM ai_meetings am JOIN ai_meeting_items i ON i.meeting_id = am.id AND i.status = 'proposed'
        WHERE am.tenant_id = ? AND am.deleted_at IS NULL AND am.status = 'review' AND ${s.where}
        GROUP BY am.id, am.title, am.meeting_date, am.created_at ORDER BY am.created_at LIMIT 10`, [tenantId, ...s.params],
    )).map((r) => ({ ...r, pending: Number(r.pending) }));
  }

  const invited = att.length;
  const attended = att.filter((a) => Number(a.attended) === 1).length;
  return ok(res, {
    scope: company ? 'company' : 'team',
    days,
    totals: {
      completed: done.length,
      upcoming: rows.filter(isUpcoming).length,
      missed: rows.filter(isMissed).length,
      cancelled: rows.filter((m) => m.cancelled_at && Date.parse(m.scheduled_at) >= Date.parse(from)).length,
      hours: Math.round(minutes / 6) / 10,
      invited, attended, attendance_rate: invited ? Math.round((attended / invited) * 100) : null,
    },
    by_department: byDepartment,
    participation: participation.slice(0, 50),
    summaries,
    approvals,
  });
});

// ------------------------------------------------------------------- list
router.get('/', async (req, res) => {
  const { tenantId } = req.auth;
  const v = visibility(req.auth);
  const filters = ['m.tenant_id = ?', 'm.kind = ?', 'm.deleted_at IS NULL', v.where];
  const params = [tenantId, KIND, ...v.params];
  const tab = String(req.query.tab || 'upcoming');
  const now = nowIso();
  if (tab === 'upcoming') { filters.push("m.status IN ('scheduled', 'live') AND m.cancelled_at IS NULL AND m.scheduled_at >= ?"); params.push(new Date(Date.now() - 3 * 3_600_000).toISOString()); }
  if (tab === 'history') { filters.push("(m.status IN ('completed', 'ended', 'cancelled') OR (m.status = 'scheduled' AND m.scheduled_at < ?))"); params.push(now); }
  // A meeting without a department belongs to its host's - the same grouping as the overview.
  if (req.query.department) { filters.push("COALESCE(NULLIF(m.department, ''), h.department) = ?"); params.push(String(req.query.department)); }
  if (req.query.project_id) { filters.push('m.project_id = ?'); params.push(String(req.query.project_id)); }
  if (req.query.host_id) { filters.push('m.host_id = ?'); params.push(String(req.query.host_id)); }
  // History: a date range (inclusive, in the workspace's calendar), and "only meetings with a recording / transcript".
  const tz = (req.query.from || req.query.to) ? await tzOf(tenantId) : null;
  if (DATE.test(String(req.query.from || ''))) { filters.push('m.scheduled_at >= ?'); params.push(localToUtc(String(req.query.from), '00:00', tz).toISOString()); }
  if (DATE.test(String(req.query.to || ''))) {
    filters.push('m.scheduled_at < ?');
    params.push(new Date(localToUtc(String(req.query.to), '00:00', tz).getTime() + 86_400_000).toISOString());
  }
  if (req.query.recorded === '1') {
    filters.push(`EXISTS (SELECT 1 FROM meeting_recordings r WHERE r.meeting_id = m.id AND r.kind = 'video' AND r.status = 'complete' AND r.deleted_at IS NULL)`);
  }
  if (req.query.transcribed === '1') filters.push('am.transcript_json IS NOT NULL');
  const search = String(req.query.search || '').trim().slice(0, 100);
  if (search) {
    const like = `%${search}%`;
    if (req.query.in_transcripts === '1') {
      // Words said in the meeting match only meetings whose transcript this person may read - the same
      // rule as the transcript itself (on it and not removed, hosting it, an owner, or a manager for a
      // meeting in their scope) - so a hit never reveals what a hidden transcript says.
      filters.push(`(m.title LIKE ? OR m.description LIKE ? OR (am.transcript_json LIKE ? AND (? = 1 OR m.host_id = ?
        OR EXISTS (SELECT 1 FROM meeting_attendees me WHERE me.meeting_id = m.id AND me.user_id = ? AND me.deleted_at IS NULL AND me.blocked = 0))))`);
      params.push(like, like, like, isAdmin(req.auth) || req.auth.role === 'manager' ? 1 : 0, req.auth.userId, req.auth.userId);
    } else {
      filters.push('(m.title LIKE ? OR m.description LIKE ?)');
      params.push(like, like);
    }
  }
  const order = tab === 'history' ? 'm.scheduled_at DESC' : 'm.scheduled_at ASC';
  const rows = await all(`${SELECT} WHERE ${filters.join(' AND ')} ORDER BY ${order} LIMIT 200`, params);
  return ok(res, rows.map(num));
});

// --------------------------------------------------------------- schedule
const scheduleSchema = z.object({
  title: z.string().trim().min(2).max(200),
  description: z.string().max(4000).optional().nullable(),
  agenda: z.string().max(8000).optional().nullable(),
  date: z.string().regex(DATE, 'Use a date like 2026-11-20'),
  time: z.string().regex(TIME, 'Use a time like 15:30'),
  duration_minutes: z.number().int().min(5).max(480),
  host_id: z.string().optional().nullable(),
  participant_ids: z.array(z.string()).max(300).optional(),
  departments: z.array(z.string().max(80)).max(30).optional(),
  department: z.string().max(80).optional().nullable(),
  project_id: z.string().optional().nullable(),
  client_id: z.string().optional().nullable(),
  access: z.enum(['invited', 'workspace']).optional(),
  recording_allowed: z.boolean().optional(),
  transcription_allowed: z.boolean().optional(),
  recurrence: z.enum(['daily', 'weekly', 'monthly']).optional().nullable(),
  recurrence_until: z.string().regex(DATE).optional().nullable(),
});

async function checkRefs(tenantId, body) {
  for (const [col, table] of [['project_id', 'projects'], ['client_id', 'clients']]) {
    if (body[col] && !(await get(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, [body[col], tenantId]))) {
      throw badRequest(`Unknown ${col.replace('_id', '')}`);
    }
  }
}

router.post('/', requires('meetings', 'create'), async (req, res) => {
  const body = validate(scheduleSchema, req.body);
  const { tenantId, userId } = req.auth;
  await checkRefs(tenantId, body);
  const tz = await tzOf(tenantId);
  const start = localToUtc(body.date, body.time, tz);
  if (start.getTime() < Date.now() - 5 * 60_000) throw badRequest('That time has already passed - choose a time from now on');
  if (body.recurrence && !body.recurrence_until) throw badRequest('Choose when the repeating meeting ends');
  if (body.recurrence_until && body.recurrence_until < body.date) throw badRequest('The repeat end date is before the first meeting');

  const people = await staff(tenantId);
  const hostId = body.host_id || userId;
  if (!people.some((p) => p.id === hostId)) throw badRequest('The host must be an active colleague');
  let invitees;
  try {
    invitees = await resolveInvitees(tenantId, { user_ids: body.participant_ids || [], departments: body.departments || [] });
  } catch (e) { throw badRequest(e.message); }
  invitees.set(hostId, 'individual');

  const starts = occurrences(start.toISOString(), body.recurrence || null, body.recurrence_until || null, tz);
  const seriesId = body.recurrence ? uuid() : null;
  const ids = [];
  await tx(async () => {
    for (const at of starts) {
      const id = await insertLiveMeeting(tenantId, {
        ...body, organizer_id: userId, host_id: hostId, scheduled_at: at, series_id: seriesId,
        recurrence: body.recurrence || null, recurrence_until: body.recurrence_until || null,
      });
      await addAttendees(tenantId, id, invitees, { hostId });
      ids.push(id);
    }
  });

  const first = await get('SELECT * FROM meetings WHERE id = ?', [ids[0]]);
  const hostName = people.find((p) => p.id === hostId)?.name || req.auth.name;
  await notifyInvited(first, [...invitees.keys()].filter((id) => id !== userId), { hostName, tz, occurrenceCount: ids.length });
  await audit(req, { entity: 'meeting', entityId: ids[0], action: 'create', after: { title: body.title, kind: KIND, occurrences: ids.length, invited: invitees.size } });
  return created(res, { ...(await withPeople(req, await meetingFor(req, ids[0]))), occurrence_ids: ids });
});

/** Instant meeting: starts now, open to anyone in the workspace with the link. */
router.post('/instant', requires('meetings', 'create'), async (req, res) => {
  const body = validate(z.object({
    title: z.string().trim().max(200).optional(),
    participant_ids: z.array(z.string()).max(300).optional(),
    recording_allowed: z.boolean().optional(),
    transcription_allowed: z.boolean().optional(),
  }), req.body || {});
  const { tenantId, userId } = req.auth;
  let invitees;
  try { invitees = await resolveInvitees(tenantId, { user_ids: body.participant_ids || [] }); } catch (e) { throw badRequest(e.message); }
  invitees.set(userId, 'individual');
  const tz = await tzOf(tenantId);
  let id;
  await tx(async () => {
    id = await insertLiveMeeting(tenantId, {
      title: body.title || `${req.auth.name}'s meeting`, organizer_id: userId, host_id: userId,
      scheduled_at: nowIso(), duration_minutes: 60, access: 'workspace',
      recording_allowed: body.recording_allowed, transcription_allowed: body.transcription_allowed,
    });
    await addAttendees(tenantId, id, invitees, { hostId: userId });
  });
  const m = await get('SELECT * FROM meetings WHERE id = ?', [id]);
  await notifyInvited(m, [...invitees.keys()].filter((x) => x !== userId), { hostName: req.auth.name, tz });
  await audit(req, { entity: 'meeting', entityId: id, action: 'create', after: { instant: true } });
  return created(res, await withPeople(req, await meetingFor(req, id)));
});

// ----------------------------------------------------------------- detail
router.get('/:id', async (req, res) => ok(res, await withPeople(req, await meetingFor(req, req.params.id))));

/**
 * Opening a share link. An "anyone in the workspace" meeting admits any active
 * colleague (added as an attendee); an invite-only meeting admits only the
 * people on it. Links never work across workspaces.
 */
router.get('/link/:token', async (req, res) => {
  const m = await get(`SELECT * FROM meetings WHERE invite_token = ? AND tenant_id = ? AND kind = ? AND deleted_at IS NULL`,
    [req.params.token, req.auth.tenantId, KIND]);
  if (!m) throw notFound('Meeting');
  const blocked = await get('SELECT 1 AS b FROM meeting_attendees WHERE meeting_id = ? AND user_id = ? AND blocked = 1 AND deleted_at IS NULL', [m.id, req.auth.userId]);
  if (blocked) throw forbidden('The host removed you from this meeting.');
  const invited = await myResponse(m.id, req.auth.userId);
  if (!invited && m.host_id !== req.auth.userId) {
    if (m.access !== 'workspace') throw forbidden('This meeting is for invited people only. Ask the host to invite you.');
    if (m.cancelled_at) throw badRequest('This meeting was cancelled');
    if (req.auth.role === 'client') throw forbidden('This meeting is for colleagues only');
    await addAttendees(req.auth.tenantId, m.id, new Map([[req.auth.userId, 'link']]), { hostId: m.host_id });
  }
  return ok(res, await withPeople(req, await meetingFor(req, m.id)));
});

// ------------------------------------------------------------- responding
router.post('/:id/respond', async (req, res) => {
  const { response } = validate(z.object({ response: z.enum(['accepted', 'declined']) }), req.body);
  const m = await meetingFor(req, req.params.id);
  if (m.cancelled_at) throw badRequest('This meeting was cancelled');
  const r = await run(
    `UPDATE meeting_attendees SET response = ?, responded_at = ? WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL`,
    [response, nowIso(), m.id, req.auth.userId],
  );
  if (!r.changes) throw forbidden('You are not invited to this meeting');
  if (m.host_id && m.host_id !== req.auth.userId) {
    const tz = await tzOf(req.auth.tenantId);
    await notifyMany({
      tenantId: req.auth.tenantId, userIds: [m.host_id], eventKey: 'meeting.response',
      vars: { person: req.auth.name, response, title: m.title, when: whenLabel(m.scheduled_at, tz) },
      link: `/ai-meetings/m/${m.id}`, dedupeKey: `meeting.response:${m.id}:${req.auth.userId}:${response}`,
    }).catch(() => {});
  }
  return ok(res, await withPeople(req, await meetingFor(req, m.id)));
});

// ------------------------------------------------------------ managing it
async function manageable(req, id) {
  const m = await meetingFor(req, id);
  if (!canManage(req.auth, m)) throw forbidden('Only the host or the organiser can change this meeting');
  if (m.cancelled_at) throw badRequest('This meeting was cancelled');
  return m;
}

/** The meetings a change applies to: this one, or this and every later one in its series. */
async function scopeIds(m, scope) {
  if (scope !== 'series' || !m.series_id) return [m.id];
  return (await all(
    `SELECT id FROM meetings WHERE series_id = ? AND scheduled_at >= ? AND cancelled_at IS NULL AND deleted_at IS NULL AND status = 'scheduled'`,
    [m.series_id, m.scheduled_at],
  )).map((r) => r.id);
}

router.post('/:id/invite', requires('meetings', 'edit'), async (req, res) => {
  const body = validate(z.object({
    participant_ids: z.array(z.string()).max(300).optional(),
    departments: z.array(z.string().max(80)).max(30).optional(),
    scope: z.enum(['occurrence', 'series']).optional(),
  }), req.body);
  const m = await manageable(req, req.params.id);
  let invitees;
  try { invitees = await resolveInvitees(req.auth.tenantId, { user_ids: body.participant_ids || [], departments: body.departments || [] }); } catch (e) { throw badRequest(e.message); }
  const targets = await scopeIds(m, body.scope);
  const added = new Set();
  await tx(async () => {
    for (const id of targets) for (const u of await addAttendees(req.auth.tenantId, id, invitees, { hostId: m.host_id })) added.add(u);
  });
  const tz = await tzOf(req.auth.tenantId);
  const raw = await get('SELECT * FROM meetings WHERE id = ?', [m.id]);
  await notifyInvited(raw, [...added].filter((u) => u !== req.auth.userId), { hostName: m.host_name || req.auth.name, tz, occurrenceCount: targets.length });
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { invited: [...added] } });
  return ok(res, { added: added.size, already_invited: invitees.size - added.size, meeting: await withPeople(req, await meetingFor(req, m.id)) });
});

router.delete('/:id/attendees/:userId', requires('meetings', 'edit'), async (req, res) => {
  const m = await manageable(req, req.params.id);
  if (req.params.userId === m.host_id) throw badRequest('Choose a new host before removing this one');
  await run('UPDATE meeting_attendees SET deleted_at = ? WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL',
    [nowIso(), m.id, req.params.userId]);
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { removed: req.params.userId } });
  return ok(res, await withPeople(req, await meetingFor(req, m.id)));
});

const editSchema = scheduleSchema.partial().omit({ participant_ids: true, departments: true, recurrence: true, recurrence_until: true })
  .extend({ scope: z.enum(['occurrence', 'series']).optional() });

router.patch('/:id', requires('meetings', 'edit'), async (req, res) => {
  const body = validate(editSchema, req.body);
  const m = await manageable(req, req.params.id);
  if (m.status !== 'scheduled') throw badRequest('A meeting that has started or ended cannot be changed');
  await checkRefs(req.auth.tenantId, body);
  const tz = await tzOf(req.auth.tenantId);
  const people = await staff(req.auth.tenantId);
  if (body.host_id && !people.some((p) => p.id === body.host_id)) throw badRequest('The host must be an active colleague');

  // Time: a new date and/or time moves each targeted meeting by the same amount.
  let shiftMs = 0;
  if (body.date || body.time) {
    const date = body.date || todayInTz(tz, new Date(m.scheduled_at));
    const time = body.time || timeInTz(tz, new Date(m.scheduled_at));
    const next = localToUtc(date, time, tz);
    if (next.getTime() < Date.now() - 5 * 60_000) throw badRequest('That time has already passed');
    shiftMs = next.getTime() - Date.parse(m.scheduled_at);
  }
  const fields = {};
  for (const k of ['title', 'description', 'agenda', 'department', 'project_id', 'client_id', 'access', 'duration_minutes', 'host_id']) {
    if (body[k] !== undefined) fields[k] = body[k] ?? null;
  }
  for (const k of ['recording_allowed', 'transcription_allowed']) if (body[k] !== undefined) fields[k] = body[k] ? 1 : 0;

  const targets = await scopeIds(m, body.scope);
  await tx(async () => {
    for (const id of targets) {
      const row = await get('SELECT scheduled_at FROM meetings WHERE id = ?', [id]);
      const set = { ...fields, updated_at: nowIso(), updated_by: req.auth.userId };
      if (shiftMs) { set.scheduled_at = new Date(Date.parse(row.scheduled_at) + shiftMs).toISOString(); set.reminder_sent_at = null; }
      const cols = Object.keys(set);
      await run(`UPDATE meetings SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map((c) => set[c]), id]);
      if (body.host_id) {
        await run(`UPDATE meeting_attendees SET role = 'participant' WHERE meeting_id = ? AND role = 'host'`, [id]);
        await addAttendees(req.auth.tenantId, id, new Map([[body.host_id, 'individual']]), { hostId: body.host_id });
        await run(`UPDATE meeting_attendees SET role = 'host', response = 'accepted' WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL`, [id, body.host_id]);
      }
    }
  });

  if (shiftMs || body.duration_minutes) {
    const after = await get('SELECT * FROM meetings WHERE id = ?', [m.id]);
    await notifyMany({
      tenantId: req.auth.tenantId, userIds: await audience(m.id, req.auth.userId), eventKey: 'meeting.rescheduled',
      vars: {
        title: after.title, when: whenLabel(after.scheduled_at, tz), duration: after.duration_minutes,
        previous: whenLabel(m.scheduled_at, tz) + (targets.length > 1 ? ` (and ${targets.length - 1} later meetings in the series)` : ''),
      },
      link: `/ai-meetings/m/${m.id}`, dedupeKey: `meeting.rescheduled:${m.id}:${after.scheduled_at}:${after.duration_minutes}`,
    }).catch(() => {});
  }
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', before: m, after: { ...fields, shifted_ms: shiftMs, occurrences: targets.length } });
  return ok(res, await withPeople(req, await meetingFor(req, m.id)));
});

router.post('/:id/cancel', requires('meetings', 'edit'), async (req, res) => {
  const body = validate(z.object({ reason: z.string().max(500).optional(), scope: z.enum(['occurrence', 'series']).optional() }), req.body || {});
  const m = await manageable(req, req.params.id);
  if (m.status !== 'scheduled') throw badRequest('Only a meeting that has not started can be cancelled');
  const targets = await scopeIds(m, body.scope);
  const ts = nowIso();
  const people = await audience(m.id, req.auth.userId);
  await tx(async () => {
    for (const id of targets) {
      await run(`UPDATE meetings SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, updated_at = ?, updated_by = ? WHERE id = ? AND status = 'scheduled'`,
        [ts, body.reason || null, ts, req.auth.userId, id]);
    }
  });
  const tz = await tzOf(req.auth.tenantId);
  await notifyMany({
    tenantId: req.auth.tenantId, userIds: people, eventKey: 'meeting.cancelled',
    vars: {
      title: m.title, by: req.auth.name,
      when: whenLabel(m.scheduled_at, tz) + (targets.length > 1 ? ` and the ${targets.length - 1} after it` : ''),
      reason: body.reason ? ` Reason: ${body.reason}` : '',
    },
    link: `/ai-meetings/m/${m.id}`, dedupeKey: `meeting.cancelled:${m.id}`,
  }).catch(() => {});
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { cancelled: targets.length, reason: body.reason || null } });
  return ok(res, await withPeople(req, await meetingFor(req, m.id)));
});

// ------------------------------------------------------------------- join
/**
 * The only way into a room: the CRM decides, then hands out a token for this
 * one person and this one room, valid for ten minutes (LiveKit refreshes it
 * while they stay connected). Invitees and the host only; a workspace-link
 * meeting admits colleagues once they have opened the link (which adds them).
 */
router.post('/:id/join', async (req, res) => {
  const body = validate(z.object({ consent: z.boolean().optional() }), req.body || {});
  if (!livekitConfigured()) {
    throw new ApiError(503, 'video_not_configured', 'Video meetings are not set up yet. An admin needs to add the LiveKit keys.');
  }
  const m = await meetingFor(req, req.params.id);
  if (m.cancelled_at) throw badRequest('This meeting was cancelled');
  if (['completed', 'ended'].includes(m.status)) throw badRequest('This meeting has ended');
  const isHost = m.host_id === req.auth.userId;
  const att = await get('SELECT id, blocked FROM meeting_attendees WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL', [m.id, req.auth.userId]);
  if (!att && !isHost) throw forbidden('You are not on this meeting. Open it from its link, or ask the host to invite you.');
  if (att?.blocked && !isHost) throw forbidden('The host removed you from this meeting.');
  if (m.locked && !isHost && !isAdmin(req.auth)) {
    throw new ApiError(423, 'meeting_locked', 'The host has locked this meeting. Ask them to unlock it to let you in.');
  }

  // The room opens a little before the start: 60 minutes for the host, 15 for everyone else.
  const lead = (isHost ? 60 : 15) * 60_000;
  if (m.status !== 'live' && Date.now() < Date.parse(m.scheduled_at) - lead) {
    throw badRequest(`This meeting opens ${isHost ? 60 : 15} minutes before it starts`);
  }

  // Recording or transcription may happen: everyone agrees before they are in.
  const needsConsent = m.recording_allowed || m.transcription_allowed;
  if (needsConsent && body.consent !== true) {
    throw new ApiError(412, 'consent_required', 'This meeting may be recorded or transcribed. Agree to continue.');
  }
  if (needsConsent) {
    await run(
      `INSERT INTO meeting_consents (id, tenant_id, meeting_id, user_id, recording, transcription, ip, user_agent, given_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [uuid(), req.auth.tenantId, m.id, req.auth.userId, m.recording_allowed ? 1 : 0, m.transcription_allowed ? 1 : 0,
        req.ip || null, String(req.get('user-agent') || '').slice(0, 300), nowIso()],
    );
  }

  const room = await get('SELECT * FROM meetings WHERE id = ?', [m.id]);
  try {
    await ensureRoom(room);
  } catch (err) {
    if (err instanceof VideoUnavailable) throw new ApiError(503, 'video_unavailable', err.message);
    throw err;
  }
  const user = await get('SELECT id, name, designation, department, avatar_url FROM users WHERE id = ?', [req.auth.userId]);
  const token = await joinToken({ meeting: room, user, isHost });
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { joined: true, consent: needsConsent ? true : null } });
  return ok(res, {
    server_url: config.livekit.url,
    token,
    room: room.room_name,
    identity: user.id,
    is_host: isHost,
    meeting: { id: m.id, title: m.title, host_id: m.host_id, host_name: m.host_name, locked: !!m.locked, recording_allowed: m.recording_allowed, transcription_allowed: m.transcription_allowed },
    // What the host could switch on, with the reason when not; and what is on right now.
    capture: captureAvailability(room),
    state: await roomState(m.id),
  });
});

// ------------------------------------------------------------ host controls
const isAdmin = (auth) => ['owner', 'super_admin'].includes(auth.role);

/** The meeting, if the caller is its host (or the workspace owner) and it is running. */
async function hosting(req) {
  const m = await meetingFor(req, req.params.id);
  if (m.host_id !== req.auth.userId && !isAdmin(req.auth)) throw forbidden('Only the host can do that');
  if (!livekitConfigured()) throw new ApiError(503, 'video_not_configured', 'Video meetings are not set up.');
  if (m.cancelled_at || ['completed', 'ended'].includes(m.status)) throw badRequest('This meeting is not running');
  return { ...m, room_name: (await get('SELECT room_name FROM meetings WHERE id = ?', [m.id])).room_name };
}

/** Video-service failures become a readable 503 instead of a crash. */
const hostAction = (fn) => async (req, res) => {
  try {
    return await fn(req, res);
  } catch (err) {
    if (err instanceof VideoUnavailable) throw new ApiError(503, 'video_unavailable', err.message);
    throw err;
  }
};

const who = z.object({ identity: z.string().min(1).max(80) });
const notInRoom = (err) => /not.?found|not exist/i.test(String(err?.cause?.message || err?.message || ''));

router.post('/:id/host/mute', hostAction(async (req, res) => {
  const body = validate(who.extend({ source: z.enum(['microphone', 'camera', 'screen_share']).optional() }), req.body);
  const m = await hosting(req);
  const out = await muteParticipant(m.room_name, body.identity, body.source || 'microphone');
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { host_muted: body.identity, source: body.source || 'microphone' } });
  return ok(res, out);
}));

router.post('/:id/host/remove', hostAction(async (req, res) => {
  const body = validate(who, req.body);
  const m = await hosting(req);
  if (body.identity === m.host_id) throw badRequest('Hand the host role to someone else before removing yourself');
  // Blocked first, so a fast rejoin is refused rather than racing the removal.
  await run('UPDATE meeting_attendees SET blocked = 1 WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL', [m.id, body.identity]);
  await removeFromRoom(m.room_name, body.identity).catch((err) => { if (!notInRoom(err)) throw err; });
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { host_removed: body.identity } });
  return ok(res, { removed: true });
}));

/** Undo a removal: they may join again. */
router.post('/:id/host/allow', async (req, res) => {
  const body = validate(who, req.body);
  const m = await meetingFor(req, req.params.id);
  if (m.host_id !== req.auth.userId && !isAdmin(req.auth)) throw forbidden('Only the host can do that');
  await run('UPDATE meeting_attendees SET blocked = 0 WHERE meeting_id = ? AND user_id = ?', [m.id, body.identity]);
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { host_allowed: body.identity } });
  return ok(res, { allowed: true });
});

router.post('/:id/host/lock', hostAction(async (req, res) => {
  const { locked } = validate(z.object({ locked: z.boolean() }), req.body);
  const m = await hosting(req);
  await run('UPDATE meetings SET locked = ?, updated_at = ? WHERE id = ?', [locked ? 1 : 0, nowIso(), m.id]);
  // Everyone in the room sees the change. Best effort: the database is what admits or refuses people.
  await publishRoomState(m.id);
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { locked } });
  return ok(res, { locked });
}));

router.post('/:id/host/lower-hand', hostAction(async (req, res) => {
  const body = validate(who, req.body);
  const m = await hosting(req);
  await updateInRoom(m.room_name, body.identity, { attributes: { hand: '' } });
  return ok(res, { lowered: true });
}));

/** Hands the host role to someone on the meeting, e.g. before the host leaves. */
router.post('/:id/host/transfer', hostAction(async (req, res) => {
  const { user_id: userId } = validate(z.object({ user_id: z.string() }), req.body);
  const m = await hosting(req);
  const att = await get('SELECT * FROM meeting_attendees WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL AND blocked = 0', [m.id, userId]);
  if (!att) throw badRequest('The new host must be on the meeting');
  await tx(async () => {
    await run("UPDATE meeting_attendees SET role = 'participant' WHERE meeting_id = ? AND role = 'host'", [m.id]);
    await run("UPDATE meeting_attendees SET role = 'host', response = 'accepted' WHERE id = ?", [att.id]);
    await run('UPDATE meetings SET host_id = ?, updated_at = ?, updated_by = ? WHERE id = ?', [userId, nowIso(), req.auth.userId, m.id]);
  });
  // The badge in the room follows the role. Best effort: people not in the room are skipped.
  const inRoom = await listRoomParticipants(m.room_name).catch(() => []);
  for (const p of inRoom) {
    if (p.identity !== userId && p.identity !== m.host_id) continue;
    let md = {};
    try { md = JSON.parse(p.metadata || '{}'); } catch { /* keep empty */ }
    await updateInRoom(m.room_name, p.identity, { metadata: JSON.stringify({ ...md, role: p.identity === userId ? 'host' : 'participant' }) }).catch(() => {});
  }
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { host_transferred_to: userId } });
  return ok(res, { host_id: userId });
}));

/** Ends the meeting for everyone: LiveKit closes the room and disconnects them all. */
router.post('/:id/host/end', hostAction(async (req, res) => {
  const m = await hosting(req);
  await closeRoom(m.room_name).catch((err) => { if (!notInRoom(err)) throw err; });
  await run("UPDATE meetings SET status = 'completed', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ? AND status IN ('live', 'scheduled')",
    [nowIso(), nowIso(), m.id]);
  await run('UPDATE meeting_participation SET left_at = ? WHERE meeting_id = ? AND left_at IS NULL', [nowIso(), m.id]);
  await onRoomClosed(m.id); // recorders stop with the room; the transcript queues once their files are in
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { ended_for_everyone: true } });
  return ok(res, { ended: true });
}));

// ------------------------------------------------- recording and transcription
/**
 * Only the host starts or stops capture, and only what the meeting allowed.
 * Everyone in the room must have agreed when they joined (checked again here).
 */
router.post('/:id/capture/start', hostAction(async (req, res) => {
  const m = await hosting(req);
  const state = await startCapture(m.id, req.auth.userId);
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { capture_started: { video: state.recording, transcript: state.transcribing } } });
  return ok(res, state);
}));

router.post('/:id/capture/stop', hostAction(async (req, res) => {
  const m = await hosting(req);
  const state = await stopCapture(m.id);
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { capture_stopped: true } });
  return ok(res, state);
}));

/** Live captions: each speaker's own browser turns their speech into text; nothing is stored. */
router.post('/:id/captions', hostAction(async (req, res) => {
  const { on } = validate(z.object({ on: z.boolean() }), req.body);
  const m = await hosting(req);
  if (on && !m.transcription_allowed) throw badRequest('Live captions need transcription to be allowed for this meeting');
  const state = await setCaptions(m.id, on);
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { captions: on } });
  return ok(res, state);
}));

/** Who may watch a recording: the host, people on the meeting, and workspace admins. Not managers-of-attendees. */
async function canWatch(req, m) {
  if (m.host_id === req.auth.userId || isAdmin(req.auth)) return true;
  return !!(await get('SELECT 1 AS x FROM meeting_attendees WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL AND blocked = 0',
    [m.id, req.auth.userId]));
}

/**
 * Recording, transcript and AI summary of a meeting: the people on it (not
 * removed), the host, owners, and managers - but a manager only reaches here
 * for meetings in their scope (they or their direct reports hosted or attended),
 * because meetingFor has already applied that.
 */
const canSeeRecord = async (req, m) => (await canWatch(req, m)) || req.auth.role === 'manager';

const parseJson = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

/** Everything that came out of a meeting, for the history tabs: transcript, AI summary, action items, approved tasks. */
router.get('/:id/record', async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  if (!(await canSeeRecord(req, m))) throw forbidden('Only people on this meeting and managers can see what was said in it');
  const ai = m.ai_meeting_id ? await get('SELECT * FROM ai_meetings WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [m.ai_meeting_id, req.auth.tenantId]) : null;
  if (!ai) return ok(res, { ai: null, transcript: [], summary: null, open_items: null, items: [], approved_tasks: [] });

  const items = await all(
    `SELECT i.id, i.idx, i.title, i.description, i.assignee_name, i.assignee_status, i.assigned_by_name, i.acceptance, i.deadline_text,
            i.due_date, i.due_time, i.priority, i.confidence, i.status, i.start_seconds, i.evidence_json, i.action_item_id, i.decided_at,
            u.name AS assignee_display, d.name AS decided_by_name, p.name AS project_name, c.name AS client_name
       FROM ai_meeting_items i
       LEFT JOIN users u ON u.id = i.assignee_user_id
       LEFT JOIN users d ON d.id = i.decided_by
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN clients c ON c.id = i.client_id
      WHERE i.meeting_id = ? ORDER BY i.idx`, [ai.id],
  );
  // The tasks as they stand now in the task system (status may have moved on since approval).
  const taskIds = items.map((i) => i.action_item_id).filter(Boolean);
  const tasks = taskIds.length ? await all(
    `SELECT a.id, a.title, a.status, a.due_date, a.due_time, a.priority, a.completed_at, a.owner_id, u.name AS owner_name
       FROM action_items a LEFT JOIN users u ON u.id = a.owner_id
      WHERE a.tenant_id = ? AND a.deleted_at IS NULL AND a.id IN (${taskIds.map(() => '?').join(',')})`, [req.auth.tenantId, ...taskIds],
  ) : [];
  const byTask = new Map(tasks.map((t) => [t.id, t]));
  return ok(res, {
    ai: { id: ai.id, status: ai.status, error: ai.error, analysis_model: ai.analysis_model, audio_purged_at: ai.audio_purged_at },
    transcript: parseJson(ai.transcript_json, []),
    summary: parseJson(ai.summary_json, null),
    open_items: parseJson(ai.extras_json, null),
    items: items.map(({ evidence_json: ev, ...i }) => ({ ...i, quote: parseJson(ev, {}).quote || null })),
    approved_tasks: items.filter((i) => i.status === 'approved' && byTask.has(i.action_item_id)).map((i) => ({
      ...byTask.get(i.action_item_id), item_id: i.id, approved_by_name: i.decided_by_name, approved_at: i.decided_at, said_at: i.start_seconds,
    })),
    // Whether this person can act on the proposals (the approval dashboard decides the rest).
    can_review: await can(req.auth, 'meeting_intelligence', 'approve'),
  });
});

router.get('/:id/recordings', async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  if (!(await canSeeRecord(req, m))) throw forbidden('Only people on this meeting and managers can see its recordings');
  const ai = m.ai_meeting_id ? await get('SELECT id, status, error FROM ai_meetings WHERE id = ? AND deleted_at IS NULL', [m.ai_meeting_id]) : null;
  const audio = await get(
    `SELECT COUNT(*) AS n, SUM(CASE WHEN status IN ('starting', 'active') THEN 1 ELSE 0 END) AS running
       FROM meeting_recordings WHERE meeting_id = ? AND kind = 'audio_track'`, [m.id],
  );
  return ok(res, {
    recordings: await listRoomRecordings(m.id),
    transcript: ai ? { ai_meeting_id: ai.id, status: ai.status, error: ai.error }
      : Number(audio?.n) ? { ai_meeting_id: null, status: Number(audio.running) ? 'recording' : 'waiting' } : null,
    can_delete: m.host_id === req.auth.userId || isAdmin(req.auth),
  });
});

router.delete('/:id/recordings/:recordingId', async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  if (m.host_id !== req.auth.userId && !isAdmin(req.auth)) throw forbidden('Only the host can delete a recording');
  const r = await deleteRecording(m.id, req.params.recordingId, req.auth.userId);
  if (!r) throw notFound('Recording');
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { recording_deleted: r.id } });
  return ok(res, { deleted: true });
});

/** A fresh link, for when the old one went somewhere it should not have. */
router.post('/:id/rotate-link', requires('meetings', 'edit'), async (req, res) => {
  const m = await manageable(req, req.params.id);
  await run('UPDATE meetings SET invite_token = ?, updated_at = ? WHERE id = ?', [newToken(), nowIso(), m.id]);
  await audit(req, { entity: 'meeting', entityId: m.id, action: 'update', after: { link_rotated: true } });
  return ok(res, await withPeople(req, await meetingFor(req, m.id)));
});

export { router as liveMeetingsRouter };
