import { Router } from 'express';
import { z } from 'zod';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, forbidden, audit } from '../lib/http.js';
import { notifyMany } from '../services/notifications.js';
import { DEFAULT_TZ } from '../lib/dueTime.js';
import { KIND } from '../services/liveMeetings.js';

/**
 * The office calendar. One shared calendar per workspace that everyone on the
 * team can add to and edit: outings, trainings, deadlines, celebrations. The
 * same view also shows - read-only - company holidays (HR owns those), who is
 * on approved leave, and the meetings the viewer is on.
 *
 * Anyone may edit any event (it is a shared board, and every change records who
 * made it); deleting is for whoever created it, or an owner, HR or a manager.
 */
const router = Router();

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const CATEGORIES = ['event', 'deadline', 'training', 'celebration', 'reminder', 'other'];
const CAN_DELETE_ANY = ['owner', 'hr', 'manager', 'super_admin'];
const MAX_RANGE_DAYS = 100;

function staffOnly(req) {
  if (req.auth.role === 'client') throw forbidden('The office calendar is for the team');
}
const tzOf = async (tenantId) => (await get('SELECT timezone FROM tenants WHERE id = ?', [tenantId]))?.timezone || DEFAULT_TZ;

const SELECT = `
  SELECT e.id, e.title, e.description, e.location, e.category, e.all_day, e.start_date, e.end_date,
         e.start_time, e.end_time, e.created_by, e.created_at, e.updated_at,
         c.name AS created_by_name, u.name AS updated_by_name
    FROM office_events e
    LEFT JOIN users c ON c.id = e.created_by
    LEFT JOIN users u ON u.id = e.updated_by`;

const shape = (req) => (e) => ({
  ...e,
  all_day: !!Number(e.all_day),
  can_delete: e.created_by === req.auth.userId || CAN_DELETE_ANY.includes(req.auth.role),
});

// ------------------------------------------------------------------- read
router.get('/', async (req, res) => {
  staffOnly(req);
  const from = String(req.query.from || '');
  const to = String(req.query.to || '');
  if (!DATE.test(from) || !DATE.test(to) || to < from) throw badRequest('Give a from and to date like 2026-11-01');
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > MAX_RANGE_DAYS) throw badRequest(`Ask for at most ${MAX_RANGE_DAYS} days at a time`);
  const { tenantId, userId } = req.auth;
  const tz = await tzOf(tenantId);

  const events = await all(
    `${SELECT} WHERE e.tenant_id = ? AND e.deleted_at IS NULL AND e.start_date <= ? AND e.end_date >= ?
      ORDER BY e.start_date, e.all_day DESC, e.start_time`, [tenantId, to, from],
  );
  const holidays = await all(
    `SELECT id, holiday_date AS date, name, kind FROM holidays
      WHERE tenant_id = ? AND deleted_at IS NULL AND holiday_date BETWEEN ? AND ? ORDER BY holiday_date`,
    [tenantId, from, to],
  );
  // Who is away: names and days only - never the reason or the leave type.
  const leave = await all(
    `SELECT l.id, l.user_id, u.name, l.from_date, l.to_date FROM leave_requests l JOIN users u ON u.id = l.user_id
      WHERE l.tenant_id = ? AND l.status = 'approved' AND COALESCE(l.kind, 'leave') = 'leave'
        AND l.from_date <= ? AND l.to_date >= ? AND u.deleted_at IS NULL
      ORDER BY l.from_date, u.name`, [tenantId, to, from],
  );
  // The viewer's own meetings (host, organiser or invited). A day either side covers time zones.
  const lo = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString();
  const hi = new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86_400_000).toISOString();
  const meetings = await all(
    `SELECT m.id, m.title, m.scheduled_at, m.duration_minutes, m.status FROM meetings m
      WHERE m.tenant_id = ? AND m.kind = ? AND m.deleted_at IS NULL AND m.cancelled_at IS NULL
        AND m.scheduled_at >= ? AND m.scheduled_at < ?
        AND (m.host_id = ? OR m.organizer_id = ? OR EXISTS (
          SELECT 1 FROM meeting_attendees a WHERE a.meeting_id = m.id AND a.deleted_at IS NULL AND a.user_id = ? AND a.response <> 'declined'))
      ORDER BY m.scheduled_at`, [tenantId, KIND, lo, hi, userId, userId, userId],
  );

  return ok(res, { timezone: tz, events: events.map(shape(req)), holidays, leave, meetings });
});

// ------------------------------------------------------------------ write
// No defaults here: an edit that does not mention a field must leave it alone.
const eventFields = z.object({
  title: z.string().trim().min(2, 'Give the event a name').max(200),
  description: z.string().trim().max(4000).optional().nullable(),
  location: z.string().trim().max(200).optional().nullable(),
  category: z.enum(CATEGORIES),
  all_day: z.boolean(),
  start_date: z.string().regex(DATE, 'Use a date like 2026-11-20'),
  end_date: z.string().regex(DATE, 'Use a date like 2026-11-20').optional().nullable(),
  start_time: z.string().regex(TIME, 'Use a time like 15:30').optional().nullable(),
  end_time: z.string().regex(TIME, 'Use a time like 16:30').optional().nullable(),
  notify_team: z.boolean().optional(),
});
const createSchema = eventFields.extend({
  category: z.enum(CATEGORIES).default('event'),
  all_day: z.boolean().default(true),
});
const editSchema = eventFields.partial();

/** Normalises dates and times; throws on anything that does not add up. */
function settle(body) {
  const end = body.end_date || body.start_date;
  if (end < body.start_date) throw badRequest('The event ends before it starts');
  if ((Date.parse(end) - Date.parse(body.start_date)) / 86_400_000 > 60) throw badRequest('An event can last at most 60 days');
  if (body.all_day) return { ...body, end_date: end, start_time: null, end_time: null };
  if (!body.start_time) throw badRequest('Give a start time, or make it an all-day event');
  const endTime = body.end_time || null;
  if (endTime && end === body.start_date && endTime <= body.start_time) throw badRequest('The event ends before it starts');
  return { ...body, end_date: end, end_time: endTime };
}

function whenText(e) {
  const day = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
  const span = e.end_date !== e.start_date ? `${day(e.start_date)} – ${day(e.end_date)}` : day(e.start_date);
  return e.all_day ? span : `${span}, ${e.start_time}${e.end_time ? `–${e.end_time}` : ''}`;
}

async function tellTeam(req, e) {
  const ids = (await all(
    `SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role NOT IN ('client', 'super_admin') AND id != ?`,
    [req.auth.tenantId, req.auth.userId],
  )).map((u) => u.id);
  await notifyMany({
    tenantId: req.auth.tenantId, userIds: ids, eventKey: 'calendar.event_added', channels: ['in_app'],
    link: `/calendar?date=${e.start_date}`,
    vars: { person: req.auth.name, title: e.title, when: whenText(e), location: e.location ? ` Where: ${e.location}.` : '' },
    dedupeKey: `calendar.event:${e.id}`,
  }).catch(() => {});
}

router.post('/events', async (req, res) => {
  staffOnly(req);
  const body = settle(validate(createSchema, req.body));
  const id = uuid();
  const ts = nowIso();
  await run(
    `INSERT INTO office_events (id, tenant_id, title, description, location, category, all_day, start_date, end_date,
       start_time, end_time, created_by, updated_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.title, body.description || null, body.location || null, body.category, body.all_day ? 1 : 0,
      body.start_date, body.end_date, body.start_time || null, body.end_time || null, req.auth.userId, req.auth.userId, ts, ts],
  );
  await audit(req, { entity: 'office_event', entityId: id, action: 'create', after: { title: body.title, start_date: body.start_date } });
  const e = shape(req)(await get(`${SELECT} WHERE e.id = ?`, [id]));
  if (body.notify_team) await tellTeam(req, e);
  return created(res, e);
});

async function eventFor(req) {
  const e = await get('SELECT * FROM office_events WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [req.params.id, req.auth.tenantId]);
  if (!e) throw notFound('Event');
  return e;
}

router.patch('/events/:id', async (req, res) => {
  staffOnly(req);
  const before = await eventFor(req);
  const patch = validate(editSchema, req.body);
  const merged = settle({
    ...{
      title: before.title, description: before.description, location: before.location, category: before.category,
      all_day: !!Number(before.all_day), start_date: before.start_date, end_date: before.end_date,
      start_time: before.start_time, end_time: before.end_time,
    },
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
    // A new start date with no end date given moves a one-day event, rather than stretching it.
    ...(patch.start_date && patch.end_date === undefined && before.start_date === before.end_date ? { end_date: patch.start_date } : {}),
  });
  await run(
    `UPDATE office_events SET title = ?, description = ?, location = ?, category = ?, all_day = ?, start_date = ?, end_date = ?,
       start_time = ?, end_time = ?, updated_by = ?, updated_at = ? WHERE id = ?`,
    [merged.title, merged.description || null, merged.location || null, merged.category, merged.all_day ? 1 : 0,
      merged.start_date, merged.end_date, merged.start_time || null, merged.end_time || null, req.auth.userId, nowIso(), before.id],
  );
  await audit(req, { entity: 'office_event', entityId: before.id, action: 'update', before, after: merged });
  return ok(res, shape(req)(await get(`${SELECT} WHERE e.id = ?`, [before.id])));
});

router.delete('/events/:id', async (req, res) => {
  staffOnly(req);
  const e = await eventFor(req);
  if (e.created_by !== req.auth.userId && !CAN_DELETE_ANY.includes(req.auth.role)) {
    throw forbidden('Only the person who added it, or an owner, HR or a manager, can delete this event');
  }
  await run('UPDATE office_events SET deleted_at = ?, updated_by = ? WHERE id = ?', [nowIso(), req.auth.userId, e.id]);
  await audit(req, { entity: 'office_event', entityId: e.id, action: 'delete', before: e });
  return ok(res, { id: e.id, deleted: true });
});

export { router as calendarRouter };
