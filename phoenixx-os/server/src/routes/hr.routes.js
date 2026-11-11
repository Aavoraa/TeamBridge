import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import {
  uuid, nowIso, todayIso, monthIso, daysBetween, startOfMonth, endOfMonth, pct, round1, toCsv,
} from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, forbidden, audit, paginate, pageMeta } from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import { notifyMany, notifyRole } from '../services/notifications.js';
import { upsertDeadline, resolveDeadline } from '../services/deadlines.js';
import { DUE_DATE_RE, DUE_TIME_RE, formatDueTime, localToUtc, timeInTz } from '../lib/dueTime.js';
import {
  PENDING, decorate, dayKind, historyFor, holidaysBetween, hoursLabel, logAttendance,
  scheduleFor, tzFor, workDayFor, workspaceSchedule, workMinutes, assessCheckIn,
  weekOffDays, weekdayOf, permissionCovering, minutesAtCheckout, statusAtCheckout,
  keepsAttendance, NO_ATTENDANCE_SQL,
} from '../services/attendance.js';
import {
  METHOD as NETWORK_METHOD, checkEnabled, isPrivateRange, isTooBroad, matchNetwork,
  parseRange, verifyCheckIn, requestIp, ipDiagnostics,
} from '../services/officeNetwork.js';
import * as performance from '../services/performance.js';

const router = Router();

// ============================================================ C1 ATTENDANCE
const geoSchema = z.object({
  lat: z.number().optional(),
  lng: z.number().optional(),
  accuracy: z.number().optional(),
});

/**
 * Stamping in.
 *
 * The body carries no time and no date on purpose. An employee may say *that*
 * they arrived, never *when* - the server reads its own clock, resolves the day
 * on the workspace calendar, and that is the record. (The offline queue in
 * sync.routes.js is the one path that supplies its own stamp, because the phone
 * genuinely held the button press while it had no signal.)
 */
router.post('/attendance/check-in', requires('hr_attendance', 'create'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  // The owner and the HR / Finance management logins are not on the register.
  if (!keepsAttendance(req.auth.role)) throw forbidden('Attendance is not tracked for this login');
  const body = validate(z.object({
    geo: geoSchema.optional(),
    source: z.enum(['web', 'mobile']).optional(),
    notes: z.string().max(500).optional().nullable(),
  }), req.body || {});

  const at = nowIso();
  const tz = await tzFor(tenantId);
  const workDate = await workDayFor(tenantId, new Date(at));
  const existing = await get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
    [tenantId, userId, workDate]);
  // One check-in per person per day. A second press is not an error - it is
  // somebody making sure it took - so it answers with the record they already
  // have rather than a message that reads like something went wrong.
  if (existing?.check_in_at && !existing.check_out_at) {
    return ok(res, { ...await decorate(tenantId, existing), already_checked_in: true });
  }
  // Back after checking out - a permission, an errand, a site visit. The day
  // keeps its first check-in (that is what lateness was judged on) and starts
  // a new session; the hours already worked carry over.
  if (existing?.check_in_at && existing.check_out_at) {
    return await checkInAgain(req, res, existing, at, body);
  }

  const schedule = await scheduleFor(tenantId, userId);
  const assessed = await assessCheckIn({ tenantId, workDate, at, schedule, userId });
  // The network is judged from the address the request arrived from - never
  // from anything in the body, which zod has already stripped down to geo,
  // source and notes. A `wifi` field sent by a tampered client is dropped.
  const network = await verifyCheckIn(tenantId, requestIp(req));
  const offNetwork = network.enabled && !network.verified;
  const reasons = [assessed.late && 'late', offNetwork && 'off_network'].filter(Boolean);
  const status = reasons.length ? PENDING : 'present';

  const id = existing?.id || uuid();
  const fields = [at, body.geo?.lat ?? null, body.geo?.lng ?? null, body.geo?.accuracy ?? null,
    body.source || 'web', status, assessed.late_minutes,
    assessed.scheduled_start, assessed.scheduled_end, body.notes ?? null,
    network.verified === null ? null : Number(network.verified), network.method,
    network.network?.id ?? null, network.network ? (network.network.ssid || network.network.network_name) : null,
    network.verified === null ? null : network.ip, reasons.join(',') || null,
    assessed.permission?.id ?? null];

  await tx(async () => {
    if (existing) {
      await run(
        `UPDATE attendance SET check_in_at = ?, in_lat = ?, in_lng = ?, in_accuracy = ?, source = ?,
           status = ?, late_minutes = ?, scheduled_start = ?, scheduled_end = ?,
           notes = COALESCE(?, notes), network_verified = ?, verification_method = ?,
           network_id = ?, network_label = ?, client_ip = ?, review_reason = ?,
           permission_id = ?, updated_at = ? WHERE id = ?`,
        [...fields, nowIso(), id],
      );
    } else {
      await run(
        `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, in_lat, in_lng,
           in_accuracy, source, status, late_minutes, scheduled_start, scheduled_end, notes,
           network_verified, verification_method, network_id, network_label, client_ip,
           review_reason, permission_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, userId, workDate, ...fields, nowIso(), nowIso()],
      );
    }
    await logAttendance({
      tenantId,
      attendanceId: id,
      userId,
      workDate,
      event: 'checked_in',
      actorId: userId,
      toStatus: status,
      at,
      note: [
        assessed.late && `${assessed.late_minutes} min after a ${formatDueTime(schedule.start)} start`,
        assessed.permission && `within approved permission ${formatDueTime(assessed.permission.from_time)}–${formatDueTime(assessed.permission.to_time)}`,
        network.verified !== null && `${network.verified
          ? `office network: ${network.network.network_name}`
          : 'not on an approved office network'}${network.enabled ? '' : ' (trial - check switched off)'}`,
      ].filter(Boolean).join('; ') || null,
    });
  });

  // Off the office network: the day goes to HR, whatever the clock said.
  if (offNetwork) {
    await notifyRole({
      tenantId,
      roles: ['hr', 'owner'],
      eventKey: 'attendance.network_review',
      vars: {
        person: req.auth.name,
        actual: formatDueTime(timeInTz(tz, new Date(at))),
        work_date: workDate,
        late_note: assessed.late ? ` It was also ${assessed.late_minutes} min late.` : '',
      },
      link: '/hr?tab=attendance',
      dedupeKey: `attendance:${id}:network`,
    }).catch(() => {});
  } else if (assessed.late) {
    // A late arrival is not marked present by the system. It goes to HR with
    // the two numbers they need in order to rule on it, and waits there.
    await notifyRole({
      tenantId,
      roles: ['hr', 'owner'],
      eventKey: 'attendance.late_check_in',
      vars: {
        person: req.auth.name,
        actual: formatDueTime(timeInTz(tz, new Date(at))),
        scheduled: formatDueTime(schedule.start),
        late_minutes: assessed.late_minutes,
        work_date: workDate,
      },
      link: '/hr?tab=attendance',
      dedupeKey: `attendance:${id}:late`,
    }).catch(() => {});
  }

  await audit(req, {
    entity: 'attendance',
    entityId: id,
    action: 'create',
    after: {
      work_date: workDate, status, late_minutes: assessed.late_minutes,
      network_verified: network.verified, review_reason: reasons.join(',') || null,
    },
  });

  return created(res, {
    ...await decorate(tenantId, await get('SELECT * FROM attendance WHERE id = ?', [id])),
    message: checkInMessage(network, assessed, status),
    schedule,
    day_kind: (await dayKind(tenantId, workDate)).kind,
  });
});

/**
 * What the employee is told. Whether the network was approved, never which
 * address or range was compared - that stays on HR's side of the screen.
 */
function checkInMessage(network, assessed, status) {
  if (network.enabled && !network.verified) {
    return 'Your network could not be verified as an approved company network. '
      + 'Your check-in has been sent to HR for review.';
  }
  if (status === PENDING) return 'You checked in after your start time, so HR has been asked to approve it.';
  const within = assessed.permission
    ? ` Your approved permission (${formatDueTime(assessed.permission.from_time)}–${formatDueTime(assessed.permission.to_time)}) covers the late start.`
    : '';
  return network.enabled
    ? `Check-in successful. You are connected to an approved company network.${within}`
    : `Check-in successful.${within}`;
}

/**
 * A second (or later) check-in on the same day. The network is checked again
 * when the check is on: coming back from home is not the same as coming back
 * to the office, and a miss sends the day to HR like any other.
 */
async function checkInAgain(req, res, row, at, body) {
  const { tenantId, userId } = req.auth;
  const tz = await tzFor(tenantId);
  const network = await verifyCheckIn(tenantId, requestIp(req));
  const offNetwork = network.enabled && !network.verified;
  const reasons = new Set(String(row.review_reason || '').split(',').filter(Boolean));
  if (offNetwork) reasons.add('off_network');
  // The day is in progress again, so a half day decided at the last check-out
  // no longer stands; the next check-out works it out afresh.
  const status = offNetwork ? PENDING : (row.status === 'half_day' ? 'present' : row.status);

  await tx(async () => {
    await run(
      `UPDATE attendance SET check_out_at = NULL, session_started_at = ?, status = ?, review_reason = ?,
         notes = COALESCE(?, notes), updated_at = ? WHERE id = ? AND check_out_at IS NOT NULL`,
      [at, status, [...reasons].join(',') || null, body.notes ?? null, nowIso(), row.id],
    );
    await logAttendance({
      tenantId,
      attendanceId: row.id,
      userId,
      workDate: row.work_date,
      event: 'checked_in_again',
      actorId: userId,
      fromStatus: row.status,
      toStatus: status,
      at,
      note: [`${hoursLabel(row.work_minutes)} worked before this`,
        network.verified !== null && (network.verified ? `office network: ${network.network.network_name}` : `not on an approved office network${network.enabled ? '' : ' (trial)'}`),
      ].filter(Boolean).join('; '),
    });
  });

  if (offNetwork) {
    await notifyRole({
      tenantId,
      roles: ['hr', 'owner'],
      eventKey: 'attendance.network_review',
      vars: {
        person: req.auth.name,
        actual: formatDueTime(timeInTz(tz, new Date(at))),
        work_date: row.work_date,
        late_note: ' This was a return after checking out.',
      },
      link: '/hr?tab=attendance',
      dedupeKey: `attendance:${row.id}:network:${at}`,
    }).catch(() => {});
  }
  await audit(req, { entity: 'attendance', entityId: row.id, action: 'update', before: row, after: { session_started_at: at, status } });

  return ok(res, {
    ...await decorate(tenantId, await get('SELECT * FROM attendance WHERE id = ?', [row.id])),
    checked_in_again: true,
    message: offNetwork
      ? 'Welcome back. Your network could not be verified as an approved company network, so HR will review it.'
      : `Welcome back. ${hoursLabel(row.work_minutes)} already logged today; this session adds to it.`,
  });
}

/** Stamping out. Server clock again, once per session. */
router.post('/attendance/check-out', requires('hr_attendance', 'create'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(z.object({ geo: geoSchema.optional() }), req.body || {});

  const at = nowIso();
  const workDate = await workDayFor(tenantId, new Date(at));
  const row = await get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
    [tenantId, userId, workDate]);
  if (!row?.check_in_at) throw badRequest('You have not checked in for this day yet');
  if (row.check_out_at) {
    return ok(res, { ...await decorate(tenantId, row), already_checked_out: true });
  }

  // Every session of the day counts, not only the latest. Checking out does
  // not overrule HR: a day still waiting on a ruling stays waiting.
  const minutes = minutesAtCheckout(row, at);
  const nextStatus = statusAtCheckout(row, minutes);

  await tx(async () => {
    await run(
      `UPDATE attendance SET check_out_at = ?, out_lat = ?, out_lng = ?, work_minutes = ?,
         status = ?, updated_at = ? WHERE id = ?`,
      [at, body.geo?.lat ?? null, body.geo?.lng ?? null, minutes, nextStatus, nowIso(), row.id],
    );
    await logAttendance({
      tenantId,
      attendanceId: row.id,
      userId,
      workDate,
      event: 'checked_out',
      actorId: userId,
      fromStatus: row.status,
      toStatus: nextStatus,
      at,
      note: hoursLabel(minutes),
    });
  });

  await audit(req, {
    entity: 'attendance',
    entityId: row.id,
    action: 'update',
    before: row,
    after: { check_out_at: at, work_minutes: minutes, status: nextStatus },
  });
  return ok(res, await decorate(tenantId, await get('SELECT * FROM attendance WHERE id = ?', [row.id])));
});

/**
 * My Day's attendance panel, and HR's "who is in" board on the same payload.
 *
 * `day` answers the question that comes before all the others: is anybody
 * expected in at all today? On a holiday or a weekly off, nobody is, and the
 * screen says so instead of offering a button that would mark them late.
 */
router.get('/attendance/today', requires('hr_attendance', 'view'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const today = await workDayFor(tenantId);
  const day = await dayKind(tenantId, today);
  const approver = await can(req.auth, 'hr_attendance', 'approve');

  return ok(res, {
    work_date: today,
    day_kind: day.kind,
    holiday: day.holiday,
    exempt: req.auth.role === 'owner',
    schedule: await scheduleFor(tenantId, userId),
    me: await decorate(tenantId, await get(
      'SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
      [tenantId, userId, today],
    )) || null,
    team: approver
      ? await Promise.all((await all(
        `SELECT a.*, u.name, u.avatar_url, u.designation, n.network_name FROM attendance a
           JOIN users u ON u.id = a.user_id
           LEFT JOIN approved_networks n ON n.id = a.network_id
          WHERE a.tenant_id = ? AND a.work_date = ? ORDER BY a.check_in_at`,
        [tenantId, today],
      )).map(async (r) => await decorate(tenantId, r, { withNetwork: true })))
      : [],
    absent: approver
      ? await all(
        `SELECT u.id, u.name, u.avatar_url, u.designation FROM users u
          WHERE u.tenant_id = ? AND u.deleted_at IS NULL AND u.status = 'active'
            AND u.role NOT IN (${NO_ATTENDANCE_SQL})
            AND u.id NOT IN (SELECT user_id FROM attendance WHERE tenant_id = ? AND work_date = ?)`,
        [tenantId, tenantId, today],
      )
      : [],
  });
});

// =================================================== LATE ARRIVAL APPROVAL
/**
 * Everything sitting between "they turned up late" and "that counts as a day
 * worked". Nothing leaves this queue on its own: a late arrival stays pending
 * until a person with the attendance-approval right rules on it, which is the
 * point of not marking it present automatically in the first place.
 */
router.get('/attendance/pending', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  return ok(res, await Promise.all((await all(
    `SELECT a.*, u.name AS user_name, u.avatar_url, u.designation, n.network_name
       FROM attendance a JOIN users u ON u.id = a.user_id
       LEFT JOIN approved_networks n ON n.id = a.network_id
      WHERE a.tenant_id = ? AND a.status = ?
      ORDER BY a.work_date DESC, a.check_in_at DESC LIMIT 200`,
    [tenantId, PENDING],
  )).map(async (r) => await decorate(tenantId, r, { withNetwork: true }))));
});

/**
 * HR's ruling. Approve and the day counts as present, with who said so and how
 * late they were kept on the row; reject and it counts as not approved, with
 * the reason - a rejection with no reason is just a day disappearing.
 */
router.post('/attendance/:id/decide', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const { decision, note } = validate(z.object({
    decision: z.enum(['approve', 'reject']),
    note: z.string().max(1000).optional().nullable(),
  }), req.body);

  const row = await get('SELECT * FROM attendance WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
  if (!row) throw notFound('Attendance record');
  if (row.status !== PENDING) {
    throw badRequest(row.approved_by
      ? 'This day has already been decided'
      : 'Only a check-in waiting on approval can be decided');
  }
  const reason = (note || '').trim();
  if (decision === 'reject' && reason.length < 3) {
    throw badRequest('Say why it is not approved - the employee sees this note');
  }

  const ts = nowIso();
  const toStatus = decision === 'approve' ? 'present' : 'not_approved';

  await tx(async () => {
    // Conditional on the row still being pending, so two HR people pressing
    // at once cannot both rule on it: the second finds nothing to update.
    const result = await run(
      `UPDATE attendance SET status = ?, approved_by = ?, approved_at = ?, approval_note = ?,
         updated_at = ? WHERE id = ? AND status = ?`,
      [toStatus, userId, ts, reason || null, ts, row.id, PENDING],
    );
    if (!result.changes) throw badRequest('This day has already been decided');
    await logAttendance({
      tenantId,
      attendanceId: row.id,
      userId: row.user_id,
      workDate: row.work_date,
      event: decision === 'approve' ? 'approved' : 'rejected',
      actorId: userId,
      fromStatus: row.status,
      toStatus,
      note: reason || null,
      at: ts,
    });
  });

  await notifyMany({
    tenantId,
    userIds: [row.user_id],
    eventKey: decision === 'approve' ? 'attendance.approved' : 'attendance.rejected',
    vars: {
      work_date: row.work_date,
      person: req.auth.name,
      late_minutes: row.late_minutes,
      note: reason || 'no note',
    },
    link: '/',
  }).catch(() => {});

  await audit(req, { entity: 'attendance', entityId: row.id, action: 'update', before: row, after: { status: toStatus, approved_by: userId, approval_note: reason || null } });
  return ok(res, await decorate(tenantId, await get('SELECT * FROM attendance WHERE id = ?', [row.id])));
});

/**
 * The forgotten checkout, and any other day HR has to put right by hand.
 *
 * Deliberately not something the employee can reach: the whole guarantee of the
 * stamps is that the person they are about cannot move them. When HR does, the
 * old and new values both go into the day's history with their name on it.
 */
router.post('/attendance/:id/correct', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(z.object({
    check_in_time: z.string().regex(DUE_TIME_RE).optional().nullable(),
    check_out_time: z.string().regex(DUE_TIME_RE).optional().nullable(),
    status: z.enum(['present', 'absent', 'half_day', 'wfh', 'leave']).optional(),
    note: z.string().min(3).max(1000),
  }), req.body);

  const row = await get('SELECT * FROM attendance WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
  if (!row) throw notFound('Attendance record');

  const tz = await tzFor(tenantId);
  const toInstant = (hhmm) => (hhmm ? localToUtc(row.work_date, hhmm, tz).toISOString() : null);
  const checkIn = body.check_in_time !== undefined
    ? toInstant(body.check_in_time) : row.check_in_at;
  const checkOut = body.check_out_time !== undefined
    ? toInstant(body.check_out_time) : row.check_out_at;
  if (checkIn && checkOut && new Date(checkOut) < new Date(checkIn)) {
    throw badRequest('Check-out cannot be before check-in');
  }

  const minutes = workMinutes(checkIn, checkOut);
  const toStatus = body.status || (row.status === PENDING ? 'present' : row.status);
  const ts = nowIso();

  await tx(async () => {
    await run(
      `UPDATE attendance SET check_in_at = ?, check_out_at = ?, work_minutes = ?, status = ?,
         source = 'regularized', approved_by = ?, approved_at = ?, approval_note = ?,
         session_started_at = NULL, updated_at = ? WHERE id = ?`,
      [checkIn, checkOut, minutes, toStatus, userId, ts, body.note, ts, row.id],
    );
    await logAttendance({
      tenantId,
      attendanceId: row.id,
      userId: row.user_id,
      workDate: row.work_date,
      event: 'corrected',
      actorId: userId,
      fromStatus: row.status,
      toStatus,
      note: body.note,
      at: ts,
    });
  });

  await audit(req, { entity: 'attendance', entityId: row.id, action: 'update', before: row, after: { check_in_at: checkIn, check_out_at: checkOut, status: toStatus, corrected_by: userId } });
  return ok(res, await decorate(tenantId, await get('SELECT * FROM attendance WHERE id = ?', [row.id])));
});

/**
 * HR marks a day by hand - present, half day, WFH or absent - whether or not
 * anything was recorded for it. The day somebody was at a client site with no
 * signal, forgot to check in, or worked from the other office: the register
 * should say what happened, and HR is the one who knows.
 *
 * Creates the row if there is none, overrides it if there is. Either way the
 * reason is mandatory and lands in the day's history under HR's name, so a
 * hand-marked day is never mistaken for a stamped one.
 */
router.post('/attendance/mark', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(z.object({
    user_id: z.string().min(1),
    work_date: z.string().regex(DUE_DATE_RE),
    status: z.enum(['present', 'half_day', 'wfh', 'absent']),
    check_in_time: z.string().regex(DUE_TIME_RE).optional().nullable(),
    check_out_time: z.string().regex(DUE_TIME_RE).optional().nullable(),
    note: z.string().trim().min(3).max(1000),
  }), req.body);

  const employee = await get(
    `SELECT id, name, role FROM users
      WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND role NOT IN (${NO_ATTENDANCE_SQL})`,
    [body.user_id, tenantId],
  );
  if (!employee) throw notFound('Employee');
  if (body.work_date > await workDayFor(tenantId)) throw badRequest('A day that has not happened yet cannot be marked');
  const day = await dayKind(tenantId, body.work_date);
  if (day.kind !== 'working') {
    throw badRequest(day.kind === 'holiday'
      ? 'That day is a company holiday - remove the holiday first if people were expected in'
      : 'That day is a weekly off - nobody is expected in');
  }

  const tz = await tzFor(tenantId);
  const row = await get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
    [tenantId, employee.id, body.work_date]);
  const toInstant = (hhmm) => (hhmm ? localToUtc(body.work_date, hhmm, tz).toISOString() : null);
  const checkIn = body.check_in_time ? toInstant(body.check_in_time) : (row?.check_in_at ?? null);
  const checkOut = body.check_out_time ? toInstant(body.check_out_time) : (row?.check_out_at ?? null);
  if (checkIn && checkOut && new Date(checkOut) < new Date(checkIn)) {
    throw badRequest('Check-out cannot be before check-in');
  }
  const minutes = workMinutes(checkIn, checkOut);
  const schedule = await scheduleFor(tenantId, employee.id);
  const ts = nowIso();
  const id = row?.id || uuid();

  await tx(async () => {
    if (row) {
      await run(
        `UPDATE attendance SET status = ?, check_in_at = ?, check_out_at = ?, work_minutes = ?,
           source = 'regularized', approved_by = ?, approved_at = ?, approval_note = ?,
           session_started_at = NULL, updated_at = ?
         WHERE id = ?`,
        [body.status, checkIn, checkOut, minutes, userId, ts, body.note, ts, id],
      );
    } else {
      await run(
        `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, check_out_at,
           source, status, work_minutes, late_minutes, scheduled_start, scheduled_end,
           approved_by, approved_at, approval_note, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 'regularized', ?,?,0,?,?,?,?,?,?,?)`,
        [id, tenantId, employee.id, body.work_date, checkIn, checkOut, body.status, minutes,
          schedule.start, schedule.end, userId, ts, body.note, ts, ts],
      );
    }
    await logAttendance({
      tenantId,
      attendanceId: id,
      userId: employee.id,
      workDate: body.work_date,
      event: 'marked',
      actorId: userId,
      fromStatus: row?.status ?? null,
      toStatus: body.status,
      note: body.note,
      at: ts,
    });
  });

  await audit(req, {
    entity: 'attendance',
    entityId: id,
    action: row ? 'update' : 'create',
    before: row || null,
    after: { user_id: employee.id, work_date: body.work_date, status: body.status, marked_by: userId, note: body.note },
  });
  return ok(res, await decorate(tenantId, await get('SELECT * FROM attendance WHERE id = ?', [id])));
});

/** One employee, one day, with everything that ever happened to it. */
router.get('/attendance/day', requires('hr_attendance', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const workDate = String(req.query.date || '');
  if (!DUE_DATE_RE.test(workDate)) throw badRequest('Give a date like 2026-09-03');

  const targetId = String(req.query.user_id || req.auth.userId);
  if (targetId !== req.auth.userId && !await can(req.auth, 'hr_attendance', 'approve')) {
    throw forbidden('You can only open your own attendance');
  }

  const user = await get('SELECT id, name, avatar_url, designation FROM users WHERE id = ? AND tenant_id = ?',
    [targetId, tenantId]);
  if (!user) throw notFound('Employee');

  const row = await get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
    [tenantId, targetId, workDate]);
  const day = await dayKind(tenantId, workDate);
  const leave = await get(
    `SELECT l.*, lt.name AS leave_type_name FROM leave_requests l
       LEFT JOIN leave_types lt ON lt.id = l.leave_type_id
      WHERE l.tenant_id = ? AND l.user_id = ? AND l.status = 'approved'
        AND l.from_date <= ? AND l.to_date >= ?`,
    [tenantId, targetId, workDate, workDate],
  );

  return ok(res, {
    user,
    work_date: workDate,
    day_kind: day.kind,
    holiday: day.holiday,
    leave: leave || null,
    schedule: await scheduleFor(tenantId, targetId),
    attendance: await decorate(tenantId, row, { withNetwork: await can(req.auth, 'hr_attendance', 'approve') }) || null,
    history: row ? await historyFor(tenantId, row.id) : [],
  });
});

// ======================================================== WORK SCHEDULES
/** HR's roster of who is expected when. */
router.get('/work-schedules', requires('hr_attendance', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const scoped = !await can(req.auth, 'hr_attendance', 'approve');
  const users = await all(
    `SELECT id, name, avatar_url, designation, role, work_start, work_end, grace_minutes
       FROM users
      WHERE tenant_id = ? AND deleted_at IS NULL AND role NOT IN (${NO_ATTENDANCE_SQL}) AND status != 'disabled'
        ${scoped ? 'AND id = ?' : ''}
      ORDER BY name`,
    scoped ? [tenantId, req.auth.userId] : [tenantId],
  );
  const workspace = await workspaceSchedule(tenantId);

  return ok(res, {
    workspace,
    employees: await Promise.all(users.map(async (u) => {
      const s = await scheduleFor(tenantId, u.id);
      return {
        ...u,
        effective_start: s.start,
        effective_end: s.end,
        effective_grace: s.grace_minutes,
        start_label: formatDueTime(s.start),
        end_label: formatDueTime(s.end),
        custom: s.custom,
      };
    })),
  });
});

/**
 * Sets one person's hours. Sending null puts them back on the workspace
 * default rather than freezing today's default onto their row, so a later
 * change to the workspace day still reaches them.
 */
router.patch('/work-schedules/:userId', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  const body = validate(z.object({
    work_start: z.string().regex(DUE_TIME_RE).optional().nullable(),
    work_end: z.string().regex(DUE_TIME_RE).optional().nullable(),
    grace_minutes: z.number().int().min(0).max(240).optional().nullable(),
  }), req.body);

  const user = await get("SELECT * FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND role != 'client'",
    [req.params.userId, tenantId]);
  if (!user) throw notFound('Employee');
  if (body.work_start && body.work_end && body.work_end <= body.work_start) {
    throw badRequest('The working day has to end after it starts');
  }

  const patch = {};
  for (const k of ['work_start', 'work_end', 'grace_minutes']) {
    if (body[k] !== undefined) patch[k] = body[k] === '' ? null : body[k];
  }
  if (Object.keys(patch).length) {
    const cols = Object.keys(patch);
    await run(`UPDATE users SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...cols.map((c) => patch[c]), nowIso(), user.id]);
  }

  await audit(req, { entity: 'user', entityId: user.id, action: 'update', before: { work_start: user.work_start, work_end: user.work_end, grace_minutes: user.grace_minutes }, after: patch });
  return ok(res, { ...await scheduleFor(tenantId, user.id), user_id: user.id });
});

/** The workspace default day, and which weekdays are a weekly off. */
router.patch('/work-schedules', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  const body = validate(z.object({
    work_start: z.string().regex(DUE_TIME_RE).optional(),
    work_end: z.string().regex(DUE_TIME_RE).optional(),
    late_grace_minutes: z.number().int().min(0).max(240).optional(),
    // At least one. A week with no day off marks everybody absent every Sunday
    // for ever, and nothing about unticking the last box says that was meant.
    week_off_days: z.array(z.number().int().min(0).max(6)).min(1, 'Keep at least one weekly off')
      .max(6).optional(),
  }), req.body);

  const before = await workspaceSchedule(tenantId);
  const start = body.work_start ?? before.work_start;
  const end = body.work_end ?? before.work_end;
  if (end <= start) throw badRequest('The working day has to end after it starts');

  await run(
    `UPDATE tenants SET work_start = ?, work_end = ?, late_grace_minutes = ?, week_off_days = ?,
       updated_at = ? WHERE id = ?`,
    [start, end, body.late_grace_minutes ?? before.late_grace_minutes,
      JSON.stringify(body.week_off_days ?? before.week_off_days), nowIso(), tenantId],
  );
  await audit(req, { entity: 'tenant', entityId: tenantId, action: 'update', before, after: await workspaceSchedule(tenantId) });
  return ok(res, await workspaceSchedule(tenantId));
});

// ======================================================== OFFICE NETWORKS
/**
 * The office connections a check-in is approved from, and the switch that
 * makes the check count. Everything here is HR's to change; nothing about a
 * network lives in code.
 */
const networkSchema = z.object({
  network_name: z.string().trim().min(2).max(80),
  ssid: z.string().trim().max(64).optional().nullable(),
  public_ip: z.string().trim().min(3).max(64),
  is_active: z.boolean().optional(),
  description: z.string().trim().max(300).optional().nullable(),
});

/** Refuses an address that cannot work, saying why in words HR can act on. */
function checkedRange(value) {
  const range = parseRange(value);
  if (!range) throw badRequest('Enter a public IP such as 49.206.113.67, or a range such as 49.206.113.0/24');
  if (isPrivateRange(range)) {
    throw badRequest('That is a private network address (like 192.168.x.x). The server never sees those, '
      + 'and every home router uses them. Open whatismyipaddress.com on the office Wi-Fi and enter the public IP shown.');
  }
  if (isTooBroad(range)) throw badRequest('That range is too wide to identify one office. Use a single IP or a narrower range.');
  return range.prefix === (range.type === 'ipv4' ? 32 : 128) ? range.addr : `${range.addr}/${range.prefix}`;
}

const networkRow = async (tenantId, id) => await get(
  `SELECT n.*, u.name AS updated_by_name FROM approved_networks n
     LEFT JOIN users u ON u.id = COALESCE(n.updated_by, n.created_by)
    WHERE n.id = ? AND n.tenant_id = ? AND n.deleted_at IS NULL`,
  [id, tenantId],
);

/**
 * Today's check-ins that missed only because the office connection had not
 * been listed yet. When HR adds or corrects a network, each of today's
 * unverified rows is matched again against the address the server recorded at
 * check-in - still never anything the employee sent. A match clears the
 * off-network reason; a day that was waiting on that alone becomes present.
 * Lateness is left for HR to decide. Earlier days are not touched.
 */
async function recheckToday(req) {
  const { tenantId, userId } = req.auth;
  const workDate = await workDayFor(tenantId, new Date());
  const rows = await all(
    `SELECT * FROM attendance WHERE tenant_id = ? AND work_date = ?
       AND network_verified = 0 AND client_ip IS NOT NULL`,
    [tenantId, workDate],
  );
  let count = 0;
  for (const row of rows) {
    const match = await matchNetwork(tenantId, row.client_ip);
    if (!match) continue;
    const reasons = String(row.review_reason || '').split(',').filter((r) => r && r !== 'off_network');
    const settles = row.status === PENDING && !reasons.length;
    const status = settles ? 'present' : row.status;
    const ts = nowIso();
    const note = `Office network listed after check-in: ${match.network_name} (${row.client_ip})`;
    await tx(async () => {
      await run(
        `UPDATE attendance SET network_verified = 1, network_id = ?, network_label = ?, review_reason = ?,
           status = ?, approved_by = CASE WHEN ? = 1 THEN ? ELSE approved_by END,
           approved_at = CASE WHEN ? = 1 THEN ? ELSE approved_at END,
           approval_note = CASE WHEN ? = 1 THEN ? ELSE approval_note END, updated_at = ?
         WHERE id = ? AND network_verified = 0`,
        [match.id, match.ssid || match.network_name, reasons.join(',') || null, status,
          settles ? 1 : 0, userId, settles ? 1 : 0, ts, settles ? 1 : 0, note, ts, row.id],
      );
      await logAttendance({
        tenantId,
        attendanceId: row.id,
        userId: row.user_id,
        workDate: row.work_date,
        event: 'network_verified',
        actorId: userId,
        fromStatus: row.status,
        toStatus: status,
        note,
        at: ts,
      });
    });
    count += 1;
  }
  return count;
}

router.get('/networks', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  return ok(res, {
    enabled: await checkEnabled(tenantId),
    method: NETWORK_METHOD,
    networks: await all(
      `SELECT n.*, u.name AS updated_by_name FROM approved_networks n
         LEFT JOIN users u ON u.id = COALESCE(n.updated_by, n.created_by)
        WHERE n.tenant_id = ? AND n.deleted_at IS NULL ORDER BY n.network_name, n.ssid`,
      [tenantId],
    ),
  });
});

/**
 * "Would a check-in from here count?" Answered from the request HR is making
 * right now, so pressing it on the office Wi-Fi proves the setup end to end -
 * including what address the hosting proxy actually hands the server.
 */
router.get('/networks/test', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  const ip = requestIp(req);
  const match = await matchNetwork(tenantId, ip);
  return ok(res, {
    ip,
    ip_version: ip && ip.includes(':') ? 6 : 4,
    matched: !!match,
    network: match ? { id: match.id, network_name: match.network_name, ssid: match.ssid } : null,
    enabled: await checkEnabled(tenantId),
    diagnostics: ipDiagnostics(req),
  });
});

router.patch('/networks/settings', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  const { enabled } = validate(z.object({ enabled: z.boolean() }), req.body);
  const before = await checkEnabled(tenantId);
  await run('UPDATE tenants SET network_check = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, nowIso(), tenantId]);
  await audit(req, { entity: 'tenant', entityId: tenantId, action: 'update', before: { network_check: before }, after: { network_check: enabled } });
  return ok(res, { enabled });
});

router.post('/networks', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(networkSchema, req.body);
  const ip = checkedRange(body.public_ip);
  const id = uuid();
  const ts = nowIso();
  await run(
    `INSERT INTO approved_networks (id, tenant_id, network_name, ssid, public_ip, verification_method,
       is_active, description, created_by, updated_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, body.network_name, body.ssid || null, ip, NETWORK_METHOD,
      body.is_active === false ? 0 : 1, body.description || null, userId, userId, ts, ts],
  );
  const row = await networkRow(tenantId, id);
  await audit(req, { entity: 'approved_network', entityId: id, action: 'create', after: row });
  return created(res, { ...row, rechecked: row.is_active ? await recheckToday(req) : 0 });
});

router.patch('/networks/:id', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const before = await networkRow(tenantId, req.params.id);
  if (!before) throw notFound('Network');
  const body = validate(networkSchema.partial(), req.body);
  const patch = {};
  if (body.network_name !== undefined) patch.network_name = body.network_name;
  if (body.ssid !== undefined) patch.ssid = body.ssid || null;
  if (body.public_ip !== undefined) patch.public_ip = checkedRange(body.public_ip);
  if (body.is_active !== undefined) patch.is_active = body.is_active ? 1 : 0;
  if (body.description !== undefined) patch.description = body.description || null;
  const cols = Object.keys(patch);
  if (cols.length) {
    await run(
      `UPDATE approved_networks SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_by = ?, updated_at = ?
        WHERE id = ? AND tenant_id = ?`,
      [...cols.map((c) => patch[c]), userId, nowIso(), before.id, tenantId],
    );
  }
  const after = await networkRow(tenantId, before.id);
  await audit(req, { entity: 'approved_network', entityId: before.id, action: 'update', before, after });
  return ok(res, { ...after, rechecked: after.is_active ? await recheckToday(req) : 0 });
});

/** Soft delete: past check-ins still point at the network they matched. */
router.delete('/networks/:id', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const before = await networkRow(tenantId, req.params.id);
  if (!before) throw notFound('Network');
  await run('UPDATE approved_networks SET deleted_at = ?, updated_by = ?, updated_at = ? WHERE id = ?',
    [nowIso(), userId, nowIso(), before.id]);
  await audit(req, { entity: 'approved_network', entityId: before.id, action: 'delete', before });
  return ok(res, { id: before.id, deleted: true });
});

// ============================================================== HOLIDAYS
/**
 * Company-wide non-working days. One row marks the date for everybody at once:
 * it lands on every employee's calendar, and nobody is expected to check in.
 */
router.get('/holidays', requires('hr_attendance', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const year = /^\d{4}$/.test(String(req.query.year || ''))
    ? String(req.query.year)
    : (await workDayFor(tenantId)).slice(0, 4);
  return ok(res, await holidaysBetween(tenantId, `${year}-01-01`, `${year}-12-31`), { year });
});

router.post('/holidays', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(z.object({
    holiday_date: z.string().regex(DUE_DATE_RE, 'Use a date like 2026-09-15'),
    name: z.string().min(2).max(120),
    kind: z.enum(['company_holiday', 'restricted']).optional(),
    notes: z.string().max(500).optional().nullable(),
  }), req.body);

  const clash = await get('SELECT * FROM holidays WHERE tenant_id = ? AND holiday_date = ?',
    [tenantId, body.holiday_date]);
  const ts = nowIso();

  if (clash && !clash.deleted_at) throw badRequest(`${clash.name} is already on that date`);
  if (clash) {
    // Re-adding a date somebody deleted revives the same row, so the calendar
    // keeps one holiday per date rather than collecting tombstones.
    await run(
      `UPDATE holidays SET name = ?, kind = ?, notes = ?, deleted_at = NULL, created_by = ?,
         updated_at = ? WHERE id = ?`,
      [body.name, body.kind || 'company_holiday', body.notes ?? null, userId, ts, clash.id],
    );
    await audit(req, { entity: 'holiday', entityId: clash.id, action: 'create', after: body });
    return created(res, await get('SELECT * FROM holidays WHERE id = ?', [clash.id]));
  }

  const id = uuid();
  await run(
    `INSERT INTO holidays (id, tenant_id, holiday_date, name, kind, notes, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, body.holiday_date, body.name, body.kind || 'company_holiday',
      body.notes ?? null, userId, ts, ts],
  );
  await audit(req, { entity: 'holiday', entityId: id, action: 'create', after: body });
  return created(res, await get('SELECT * FROM holidays WHERE id = ?', [id]));
});

router.patch('/holidays/:id', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  const body = validate(z.object({
    holiday_date: z.string().regex(DUE_DATE_RE).optional(),
    name: z.string().min(2).max(120).optional(),
    kind: z.enum(['company_holiday', 'restricted']).optional(),
    notes: z.string().max(500).optional().nullable(),
  }), req.body);

  const before = await get('SELECT * FROM holidays WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!before) throw notFound('Holiday');
  if (body.holiday_date && body.holiday_date !== before.holiday_date) {
    const clash = await get('SELECT id FROM holidays WHERE tenant_id = ? AND holiday_date = ? AND deleted_at IS NULL',
      [tenantId, body.holiday_date]);
    if (clash) throw badRequest('There is already a holiday on that date');
  }

  const patch = { ...body, updated_at: nowIso() };
  const cols = Object.keys(patch).filter((c) => patch[c] !== undefined);
  await run(`UPDATE holidays SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
    [...cols.map((c) => patch[c]), before.id]);

  await audit(req, { entity: 'holiday', entityId: before.id, action: 'update', before, after: patch });
  return ok(res, await get('SELECT * FROM holidays WHERE id = ?', [before.id]));
});

router.delete('/holidays/:id', requires('hr_attendance', 'approve'), async (req, res) => {
  const { tenantId } = req.auth;
  const before = await get('SELECT * FROM holidays WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!before) throw notFound('Holiday');
  await run('UPDATE holidays SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), before.id]);
  await audit(req, { entity: 'holiday', entityId: before.id, action: 'delete', before });
  return ok(res, { ok: true });
});

/**
 * C1 - the monthly attendance register.
 *
 * Every cell is decided in the same order, and the order is the whole design:
 *
 *   holiday -> weekly off -> what was actually recorded -> approved leave ->
 *   absent (only for a day that has already been)
 *
 * A holiday outranks a record because a company holiday is a fact about the
 * day, not about the person; a recorded check-in outranks leave because
 * somebody who came in and worked was, whatever the leave register says, at
 * work. And a future working day with nothing on it is left blank rather than
 * called absent - nobody is absent from a day that has not happened.
 */
router.get('/attendance/register', requires('hr_attendance', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? String(req.query.month) : monthIso();
  const from = startOfMonth(month).slice(0, 10);
  const to = endOfMonth(month).slice(0, 10);
  const today = await workDayFor(tenantId);

  // A manager is an employee too: `self=1` asks for their own row only, the
  // same register everybody without approval rights sees.
  const scopeToSelf = ['1', 'true'].includes(String(req.query.self))
    || !await can(req.auth, 'hr_attendance', 'approve');
  // The owner and the HR / Finance management logins are not rows on the register.
  const filters = ["tenant_id = ?", 'deleted_at IS NULL', `role NOT IN (${NO_ATTENDANCE_SQL})`];
  const params = [tenantId];
  if (scopeToSelf) { filters.push('id = ?'); params.push(req.auth.userId); }
  // HR filters the register the way they think about it: one person, or one
  // team, or one service line.
  if (req.query.user_id) { filters.push('id = ?'); params.push(String(req.query.user_id)); }
  if (req.query.service_line_id) { filters.push('service_line_id = ?'); params.push(String(req.query.service_line_id)); }
  if (req.query.manager_id) { filters.push('(manager_id = ? OR id = ?)'); params.push(String(req.query.manager_id), String(req.query.manager_id)); }

  const users = await all(
    `SELECT id, name, avatar_url, designation, role, service_line_id, manager_id,
            work_start, work_end
       FROM users WHERE ${filters.join(' AND ')} ORDER BY name`,
    params,
  );

  const records = await all(
    'SELECT * FROM attendance WHERE tenant_id = ? AND work_date >= ? AND work_date <= ?',
    [tenantId, from, to],
  );
  const leaves = await all(
    `SELECT l.*, lt.name AS leave_type_name FROM leave_requests l
       LEFT JOIN leave_types lt ON lt.id = l.leave_type_id
      WHERE l.tenant_id = ? AND l.status = 'approved' AND l.from_date <= ? AND l.to_date >= ?`,
    [tenantId, to, from],
  );
  const holidays = await holidaysBetween(tenantId, from, to);
  const offDays = await weekOffDays(tenantId);

  const days = [];
  for (let d = new Date(`${from}T12:00:00Z`); d.toISOString().slice(0, 10) <= to; d.setUTCDate(d.getUTCDate() + 1)) {
    const iso = d.toISOString().slice(0, 10);
    const holiday = holidays.find((h) => h.holiday_date === iso) || null;
    days.push({
      date: iso,
      weekday: d.getUTCDay(),
      week_off: offDays.includes(d.getUTCDay()),
      holiday: holiday ? { id: holiday.id, name: holiday.name } : null,
      future: iso > today,
    });
  }

  // A day only counts as one somebody was meant to work.
  const workingDayCount = days.filter((d) => !d.week_off && !d.holiday).length;
  const statusFilter = req.query.status ? String(req.query.status).split(',') : null;

  const rows = users.map((u) => {
    const mine = records.filter((r) => r.user_id === u.id);
    const myLeaves = leaves.filter((l) => l.user_id === u.id);

    const cells = days.map((day) => {
      const base = { date: day.date, week_off: day.week_off, future: day.future };
      const offDay = !!(day.holiday || day.week_off);
      // Someone who checked in on a weekly off or a holiday worked that day:
      // the check-in wins, marked as an extra day so it is not mistaken for a
      // missed working day and does not count against the month.
      const rec = mine.find((r) => r.work_date === day.date);
      if (!rec) {
        if (day.holiday) return { ...base, status: 'holiday', holiday: day.holiday.name };
        if (day.week_off) return { ...base, status: 'weekoff' };
      }
      if (rec) {
        return {
          ...base,
          ...(offDay ? { extra_day: day.holiday ? 'holiday' : 'weekoff', holiday: day.holiday?.name } : {}),
          status: rec.status,
          attendance_id: rec.id,
          work_minutes: rec.work_minutes,
          late_minutes: rec.late_minutes,
          check_in_at: rec.check_in_at,
          check_out_at: rec.check_out_at,
          scheduled_start: rec.scheduled_start,
          checkout_missing: !rec.check_out_at && day.date < today,
        };
      }
      const leave = myLeaves.find((l) => l.from_date <= day.date && l.to_date >= day.date);
      if (leave) return { ...base, status: 'leave', leave_type: leave.leave_type_name };
      return { ...base, status: day.future ? null : 'absent' };
    });

    const count = (...statuses) => cells.filter((c) => statuses.includes(c.status)).length;
    // The month's attendance is measured on working days; work on an off day is counted on its own.
    const onWorkingDays = (...statuses) => cells.filter((c) => !c.extra_day && statuses.includes(c.status)).length;
    const present = onWorkingDays('present', 'wfh');
    const halfDay = onWorkingDays('half_day');
    const extraDays = cells.filter((c) => c.extra_day && ['present', 'wfh', 'half_day'].includes(c.status)).length;
    const leave = count('leave');

    return {
      user: u,
      cells,
      summary: {
        present,
        half_day: halfDay,
        leave,
        absent: count('absent', 'not_approved'),
        pending: count(PENDING),
        week_off: count('weekoff'),
        extra_days: extraDays,
        holiday: count('holiday'),
        not_marked: cells.filter((c) => c.status === null).length,
        working_days: workingDayCount,
        // Half a day counts as half. Anything still waiting on HR counts as
        // nothing yet, which is the honest answer until somebody rules on it.
        present_days: round1(present + halfDay * 0.5),
        leave_days: leave,
        attendance_pct: pct(present + halfDay * 0.5, workingDayCount),
        avg_hours: round1(
          mine.filter((r) => r.work_minutes).reduce((a, r) => a + r.work_minutes, 0)
          / (mine.filter((r) => r.work_minutes).length || 1) / 60,
        ),
      },
    };
  }).filter((row) => !statusFilter || row.cells.some((c) => statusFilter.includes(c.status || 'not_marked')));

  // The month at a glance, across whoever survived the filters.
  const totals = rows.reduce((a, r) => {
    for (const k of ['present', 'half_day', 'leave', 'absent', 'pending', 'week_off', 'holiday', 'not_marked', 'extra_days']) {
      a[k] = (a[k] || 0) + r.summary[k];
    }
    return a;
  }, {});

  return ok(res, {
    month,
    days,
    working_days: workingDayCount,
    week_off_days: offDays,
    holidays,
    rows,
    totals: { ...totals, employees: rows.length, working_days: workingDayCount },
  });
});

router.get('/attendance/export', requires('hr_attendance', 'export'), async (req, res) => {
  const { tenantId } = req.auth;
  const month = req.query.month || monthIso();
  const tz = await tzFor(tenantId);
  const clock = (iso) => (iso ? formatDueTime(timeInTz(tz, new Date(iso))) : '');
  const today = await workDayFor(tenantId);

  const rows = (await all(
    `SELECT u.name AS employee, u.designation, a.work_date, a.status, a.check_in_at, a.check_out_at,
            a.work_minutes, a.late_minutes, a.scheduled_start, a.source,
            ap.name AS approved_by_name, a.approved_at, a.approval_note
       FROM attendance a JOIN users u ON u.id = a.user_id
       LEFT JOIN users ap ON ap.id = a.approved_by
      WHERE a.tenant_id = ? AND a.work_date >= ? AND a.work_date <= ?
      ORDER BY u.name, a.work_date`,
    [tenantId, startOfMonth(month).slice(0, 10), endOfMonth(month).slice(0, 10)],
  )).map((r) => ({
    employee: r.employee,
    designation: r.designation || '',
    date: r.work_date,
    status: r.status,
    scheduled_start: formatDueTime(r.scheduled_start),
    check_in: clock(r.check_in_at),
    check_out: r.check_out_at ? clock(r.check_out_at)
      : (r.check_in_at && r.work_date < today ? 'Missing' : ''),
    working_hours: r.work_minutes ? hoursLabel(r.work_minutes) : '',
    late_minutes: r.late_minutes || 0,
    approved_by: r.approved_by_name || '',
    approved_at: r.approved_at || '',
    approval_note: r.approval_note || '',
    source: r.source,
  }));

  await audit(req, { entity: 'attendance', action: 'export', after: { month, rows: rows.length } });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="attendance-${month}.csv"`);
  return res.send(toCsv(rows));
});

// ---------------------------------------------------------- regularization
router.post('/attendance/regularize', requires('hr_attendance', 'create'), async (req, res) => {
  const body = validate(z.object({
    work_date: z.string(),
    requested_in: z.string().optional().nullable(),
    requested_out: z.string().optional().nullable(),
    requested_status: z.enum(['present', 'half_day', 'wfh']).optional(),
    reason: z.string().min(5).max(1000),
  }), req.body);
  const { tenantId, userId } = req.auth;

  const id = uuid();
  await run(
    `INSERT INTO attendance_regularizations (id, tenant_id, user_id, work_date, requested_in,
       requested_out, requested_status, reason, approver_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, userId, body.work_date, body.requested_in ?? null, body.requested_out ?? null,
      body.requested_status || 'present', body.reason, req.auth.managerId ?? null, nowIso(), nowIso()],
  );

  if (req.auth.managerId) {
    await notifyMany({
      tenantId, userIds: [req.auth.managerId], eventKey: 'leave.requested',
      vars: { days: 1, leave_type: 'attendance regularization', from_date: body.work_date, to_date: body.work_date, reason: body.reason },
      link: '/hr/attendance',
    }).catch(() => {});
  }
  return created(res, await get('SELECT * FROM attendance_regularizations WHERE id = ?', [id]));
});

router.get('/attendance/regularizations', requires('hr_attendance', 'view'), async (req, res) => {
  const canApprove = await can(req.auth, 'hr_attendance', 'approve');
  return ok(res, await all(
    `SELECT r.*, u.name AS user_name, u.avatar_url FROM attendance_regularizations r
       JOIN users u ON u.id = r.user_id
      WHERE r.tenant_id = ? ${canApprove ? '' : 'AND r.user_id = ?'}
        ${req.query.status ? 'AND r.status = ?' : ''}
      ORDER BY r.created_at DESC LIMIT 200`,
    [req.auth.tenantId, ...(canApprove ? [] : [req.auth.userId]), ...(req.query.status ? [req.query.status] : [])],
  ));
});

router.post('/attendance/regularizations/:id/decide', requires('hr_attendance', 'approve'), async (req, res) => {
  const { decision, note } = validate(
    z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().optional() }), req.body,
  );
  const { tenantId, userId } = req.auth;
  const reg = await get('SELECT * FROM attendance_regularizations WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
  if (!reg) throw notFound('Regularization request');
  if (reg.status !== 'pending') throw badRequest('This request has already been decided');

  await tx(async () => {
    await run(
      'UPDATE attendance_regularizations SET status = ?, approver_id = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?',
      [decision, userId, nowIso(), note ?? null, nowIso(), reg.id],
    );
    if (decision === 'approved') {
      const minutes = reg.requested_in && reg.requested_out
        ? Math.max(0, Math.round((new Date(reg.requested_out) - new Date(reg.requested_in)) / 60_000))
        : 480;
      await run(
        `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, check_out_at,
           source, status, work_minutes, notes, created_at, updated_at)
         VALUES (?,?,?,?,?,?, 'regularized', ?,?,?,?,?)
         ON CONFLICT (tenant_id, user_id, work_date) DO UPDATE SET
           check_in_at = excluded.check_in_at, check_out_at = excluded.check_out_at,
           source = 'regularized', status = excluded.status, work_minutes = excluded.work_minutes,
           updated_at = excluded.updated_at`,
        [uuid(), tenantId, reg.user_id, reg.work_date, reg.requested_in, reg.requested_out,
          reg.requested_status || 'present', minutes, `Regularized: ${reg.reason}`, nowIso(), nowIso()],
      );
    }
  });

  await audit(req, { entity: 'attendance_regularization', entityId: reg.id, action: decision === 'approved' ? 'approve' : 'reject' });
  return ok(res, await get('SELECT * FROM attendance_regularizations WHERE id = ?', [reg.id]));
});

// ================================================================= C2 LEAVE
router.get('/leave/types', requires('hr_leave', 'view'), async (req, res) => ok(res, await all(
  'SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1 ORDER BY name', [req.auth.tenantId],
)));

router.get('/leave/balances', requires('hr_leave', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const year = Number(req.query.year) || new Date().getUTCFullYear();
  const userId = req.query.user_id && await can(req.auth, 'hr_leave', 'approve') ? req.query.user_id : req.auth.userId;

  const types = await all('SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1', [tenantId]);
  return ok(res, await Promise.all(types.map(async (t) => {
    const bal = await get(
      'SELECT * FROM leave_balances WHERE tenant_id = ? AND user_id = ? AND leave_type_id = ? AND year = ?',
      [tenantId, userId, t.id, year],
    );
    const used = Number((await get(
      `SELECT COALESCE(SUM(days),0) AS d FROM leave_requests WHERE tenant_id = ? AND user_id = ?
         AND leave_type_id = ? AND status = 'approved' AND from_date LIKE ?`,
      [tenantId, userId, t.id, `${year}%`],
    ))?.d || 0);
    const entitled = bal?.entitled ?? t.annual_quota;
    return {
      leave_type_id: t.id, name: t.name, code: t.code, color: t.color,
      entitled, used, carried: bal?.carried || 0,
      available: round1(entitled + (bal?.carried || 0) - used),
    };
  })));
});

const leaveSchema = z.object({
  leave_type_id: z.string(),
  kind: z.enum(['leave', 'permission']).optional(),
  from_date: z.string(),
  to_date: z.string(),
  from_time: z.string().optional().nullable(),
  to_time: z.string().optional().nullable(),
  reason: z.string().min(3).max(1000),
});

/**
 * Leave is approved in two steps. The person's reporting manager verifies it
 * first; only then does it reach HR, who give the final word. Somebody who
 * reports straight to the Owner or HR (or to nobody) goes to HR directly.
 * The Owner can decide at either step, and their word is final.
 */
const HR_LEAVE_ROLES = ['owner', 'hr', 'super_admin'];
const isHrApprover = (auth) => HR_LEAVE_ROLES.includes(auth.role);
const isOwner = (auth) => auth.role === 'owner' || auth.role === 'super_admin';

async function leaveFirstApprover(tenantId, managerId) {
  if (!managerId) return null;
  const m = await get(
    "SELECT id, role FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND status != 'disabled'",
    [managerId, tenantId],
  );
  return m && !HR_LEAVE_ROLES.includes(m.role) ? m.id : null;
}

function canDecideLeave(auth, lr) {
  if (lr.status !== 'pending') return false;
  if (lr.user_id === auth.userId && !isOwner(auth)) return false;
  if (isOwner(auth)) return true;
  return (lr.stage || 'hr') === 'manager' ? lr.manager_id === auth.userId : isHrApprover(auth);
}

router.get('/leave/requests', requires('hr_leave', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const canApprove = await can(req.auth, 'hr_leave', 'approve');
  const filters = ['l.tenant_id = ?'];
  const params = [req.auth.tenantId];

  if (!canApprove) { filters.push('l.user_id = ?'); params.push(req.auth.userId); }
  else if (req.auth.role === 'manager') {
    filters.push('(l.user_id = ? OR l.user_id IN (SELECT id FROM users WHERE manager_id = ?))');
    params.push(req.auth.userId, req.auth.userId);
  }
  if (req.query.status) { filters.push('l.status = ?'); params.push(req.query.status); }
  if (req.query.user_id && canApprove) { filters.push('l.user_id = ?'); params.push(req.query.user_id); }
  if (req.query.from) { filters.push('l.to_date >= ?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('l.from_date <= ?'); params.push(req.query.to); }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM leave_requests l WHERE ${where}`, params))?.n || 0);
  const rows = await all(
    `SELECT l.*, u.name AS user_name, u.avatar_url, lt.name AS leave_type_name, lt.code AS leave_type_code,
            lt.color, a.name AS approver_name, mg.name AS manager_name, mv.name AS manager_approved_by_name
       FROM leave_requests l
       JOIN users u ON u.id = l.user_id
       JOIN leave_types lt ON lt.id = l.leave_type_id
       LEFT JOIN users a ON a.id = l.approver_id
       LEFT JOIN users mg ON mg.id = l.manager_id
       LEFT JOIN users mv ON mv.id = l.manager_approved_by
      WHERE ${where} ORDER BY l.from_date DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return ok(res, rows.map((r) => ({ ...r, can_decide: canDecideLeave(req.auth, r) })), pageMeta(page, limit, total));
});

router.post('/leave/requests', requires('hr_leave', 'create'), async (req, res) => {
  const body = validate(leaveSchema, req.body);
  const { tenantId, userId } = req.auth;

  if (body.to_date < body.from_date) throw badRequest('The end date cannot be before the start date');
  // An hourly permission is one day, and the hours are the whole point: they
  // are what a late check-in is matched against.
  if (body.kind === 'permission') {
    if (body.to_date !== body.from_date) throw badRequest('An hourly permission is for a single day');
    if (!DUE_TIME_RE.test(String(body.from_time || '')) || !DUE_TIME_RE.test(String(body.to_time || ''))) {
      throw badRequest('Give the permission start and end times');
    }
    if (body.to_time <= body.from_time) throw badRequest('The permission has to end after it starts');
  }
  const type = await get('SELECT * FROM leave_types WHERE id = ? AND tenant_id = ? AND active = 1',
    [body.leave_type_id, tenantId]);
  if (!type) throw notFound('Leave type');

  const days = body.kind === 'permission' ? 0.25 : daysBetween(body.from_date, body.to_date) + 1;

  const overlap = await get(
    `SELECT id FROM leave_requests WHERE tenant_id = ? AND user_id = ? AND status IN ('pending','approved')
       AND from_date <= ? AND to_date >= ?`,
    [tenantId, userId, body.to_date, body.from_date],
  );
  if (overlap) throw badRequest('You already have a leave request covering those dates');

  const id = uuid();
  const firstApprover = await leaveFirstApprover(tenantId, req.auth.managerId);
  await run(
    `INSERT INTO leave_requests (id, tenant_id, user_id, leave_type_id, kind, from_date, to_date,
       from_time, to_time, days, reason, approver_id, stage, manager_id, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, userId, body.leave_type_id, body.kind || 'leave', body.from_date, body.to_date,
      body.from_time ?? null, body.to_time ?? null, days, body.reason, firstApprover,
      firstApprover ? 'manager' : 'hr', firstApprover, nowIso(), nowIso()],
  );

  const vars = { days, leave_type: type.name, from_date: body.from_date, to_date: body.to_date, reason: body.reason };
  if (firstApprover) {
    // B1: an approval that has not happened is a deadline the manager owns.
    await upsertDeadline({
      tenantId, sourceType: 'leave', sourceId: id,
      title: `Verify leave: ${req.auth.name} (${body.from_date})`,
      dueAt: body.from_date, ownerId: firstApprover, escalationDays: 1,
    });
    await notifyMany({ tenantId, userIds: [firstApprover], eventKey: 'leave.requested', vars, link: '/hr?tab=leave' })
      .catch(() => {});
  } else {
    // Nobody to verify it first: straight to HR, and the reporting person
    // (the Owner, usually) still hears about it.
    await notifyRole({ tenantId, roles: ['hr'], eventKey: 'leave.requested', vars, link: '/hr?tab=leave' }).catch(() => {});
    if (req.auth.managerId) {
      await notifyMany({ tenantId, userIds: [req.auth.managerId], eventKey: 'leave.requested', vars, link: '/hr?tab=leave' })
        .catch(() => {});
    }
  }

  return created(res, await get('SELECT * FROM leave_requests WHERE id = ?', [id]));
});

router.post('/leave/requests/:id/decide', requires('hr_leave', 'approve'), async (req, res) => {
  const { decision, note } = validate(
    z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().optional() }), req.body,
  );
  const { tenantId, userId } = req.auth;
  const lr = await get('SELECT * FROM leave_requests WHERE id = ? AND tenant_id = ?', [req.params.id, tenantId]);
  if (!lr) throw notFound('Leave request');
  if (lr.status !== 'pending') throw badRequest('This request has already been decided');
  if (lr.user_id === userId && !isOwner(req.auth)) throw forbidden('You cannot approve your own leave');
  if (!canDecideLeave(req.auth, lr)) {
    throw forbidden((lr.stage || 'hr') === 'manager'
      ? 'This request is waiting on the reporting manager to verify it first'
      : 'Only HR gives the final approval on leave');
  }

  // Step one: the reporting manager verifies it and hands it to HR. A
  // rejection here is final - there is nothing left for HR to rule on.
  if ((lr.stage || 'hr') === 'manager' && decision === 'approved' && !isOwner(req.auth)) {
    const ts = nowIso();
    await run(
      `UPDATE leave_requests SET stage = 'hr', approver_id = NULL, manager_approved_by = ?, manager_approved_at = ?,
         manager_note = ?, updated_at = ? WHERE id = ?`,
      [userId, ts, note ?? null, ts, lr.id],
    );
    await resolveDeadline(tenantId, 'leave', lr.id, 'met');
    const employee = await get('SELECT name FROM users WHERE id = ?', [lr.user_id]);
    await notifyRole({
      tenantId, roles: ['hr'], eventKey: 'leave.manager_verified',
      vars: {
        employee: employee?.name || 'An employee', manager: req.auth.name,
        days: lr.days, from_date: lr.from_date, to_date: lr.to_date,
      },
      link: '/hr?tab=leave',
    }).catch(() => {});
    await notifyMany({
      tenantId, userIds: [lr.user_id], eventKey: 'leave.decided',
      vars: {
        status: 'verified by your manager and sent to HR for final approval',
        from_date: lr.from_date, to_date: lr.to_date, note: note ? `: ${note}` : '',
      },
      link: '/hr?tab=leave',
    }).catch(() => {});
    await audit(req, { entity: 'leave_request', entityId: lr.id, action: 'verify' });
    return ok(res, await get('SELECT * FROM leave_requests WHERE id = ?', [lr.id]));
  }

  await run('UPDATE leave_requests SET status = ?, approver_id = ?, decided_at = ?, decision_note = ?, updated_at = ? WHERE id = ?',
    [decision, userId, nowIso(), note ?? null, nowIso(), lr.id]);
  await resolveDeadline(tenantId, 'leave', lr.id, decision === 'approved' ? 'met' : 'cancelled');

  // A permission approved after the person already turned up late: the late
  // check-in waiting on HR is now explained, so it settles here rather than
  // asking HR the same question twice. Only a day waiting purely on lateness -
  // an off-network check-in still needs a person to look at it.
  if (decision === 'approved' && lr.kind === 'permission') {
    const pending = await all(
      `SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND status = ?
         AND work_date >= ? AND work_date <= ? AND check_in_at IS NOT NULL
         AND (review_reason IS NULL OR review_reason = 'late')`,
      [tenantId, lr.user_id, PENDING, lr.from_date, lr.to_date],
    );
    for (const row of pending) {
      const schedule = { ...await scheduleFor(tenantId, lr.user_id), start: row.scheduled_start || (await scheduleFor(tenantId, lr.user_id)).start };
      const covering = await permissionCovering({ tenantId, userId: lr.user_id, workDate: row.work_date, at: row.check_in_at, schedule });
      if (covering?.id !== lr.id) continue;
      const ts = nowIso();
      const note = `Covered by approved hourly permission ${formatDueTime(lr.from_time)}–${formatDueTime(lr.to_time)}`;
      await tx(async () => {
        await run(
          `UPDATE attendance SET status = 'present', approved_by = ?, approved_at = ?, approval_note = ?,
             permission_id = ?, review_reason = NULL, updated_at = ? WHERE id = ? AND status = ?`,
          [userId, ts, note, lr.id, ts, row.id, PENDING],
        );
        await logAttendance({
          tenantId,
          attendanceId: row.id,
          userId: row.user_id,
          workDate: row.work_date,
          event: 'approved',
          actorId: userId,
          fromStatus: row.status,
          toStatus: 'present',
          note,
          at: ts,
        });
      });
    }
  }

  await notifyMany({
    tenantId, userIds: [lr.user_id], eventKey: 'leave.decided',
    vars: { status: decision, from_date: lr.from_date, to_date: lr.to_date, note: note ? `: ${note}` : '' },
    link: '/hr/leave',
  }).catch(() => {});

  await audit(req, { entity: 'leave_request', entityId: lr.id, action: decision === 'approved' ? 'approve' : 'reject' });
  return ok(res, await get('SELECT * FROM leave_requests WHERE id = ?', [lr.id]));
});

router.delete('/leave/requests/:id', requires('hr_leave', 'create'), async (req, res) => {
  const lr = await get('SELECT * FROM leave_requests WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!lr) throw notFound('Leave request');
  if (lr.user_id !== req.auth.userId && !await can(req.auth, 'hr_leave', 'delete')) throw forbidden();
  if (lr.status === 'approved' && lr.from_date <= todayIso()) throw badRequest('Leave that has already started cannot be withdrawn');

  await run("UPDATE leave_requests SET status = 'withdrawn', updated_at = ? WHERE id = ?", [nowIso(), lr.id]);
  await resolveDeadline(req.auth.tenantId, 'leave', lr.id, 'cancelled');
  return ok(res, { ok: true });
});

/** C2 - team availability calendar. */
router.get('/leave/calendar', requires('hr_leave', 'view'), async (req, res) => {
  const month = req.query.month || monthIso();
  return ok(res, await all(
    `SELECT l.id, l.from_date, l.to_date, l.days, l.kind, l.status, u.id AS user_id, u.name, u.avatar_url,
            lt.name AS leave_type_name, lt.color
       FROM leave_requests l
       JOIN users u ON u.id = l.user_id
       JOIN leave_types lt ON lt.id = l.leave_type_id
      WHERE l.tenant_id = ? AND l.status IN ('approved','pending')
        AND l.from_date <= ? AND l.to_date >= ?
      ORDER BY l.from_date`,
    [req.auth.tenantId, endOfMonth(month).slice(0, 10), startOfMonth(month).slice(0, 10)],
  ));
});

// =========================================================== C3 PERFORMANCE
/**
 * Scorecards v2 - see services/performance.js for how a score is built.
 *
 * Who sees what:
 *   - everyone sees their own scorecard, and never a ranking
 *   - a manager also sees their direct reports and the people on the projects
 *     they manage or lead
 *   - the workspace Owner and HR see everyone
 * Who rates: the person's reporting manager, or the Owner / HR. Never
 * themselves - a manager's own card is rated by the Owner.
 */
const SEES_ALL_PERFORMANCE = ['owner', 'super_admin', 'hr'];

/** User ids whose scorecards this person may see. */
async function performanceScope(auth) {
  if (SEES_ALL_PERFORMANCE.includes(auth.role)) return null; // everyone
  const ids = new Set([auth.userId]);
  if (await can(auth, 'hr_performance', 'approve')) {
    for (const r of await all('SELECT id FROM users WHERE tenant_id = ? AND manager_id = ? AND deleted_at IS NULL',
      [auth.tenantId, auth.userId])) ids.add(r.id);
    for (const r of await all(
      `SELECT DISTINCT pm.user_id FROM project_members pm
         JOIN project_members me ON me.project_id = pm.project_id AND me.deleted_at IS NULL
          AND me.user_id = ? AND me.seat IN ('manager','lead')
         JOIN projects p ON p.id = pm.project_id AND p.deleted_at IS NULL
        WHERE pm.tenant_id = ? AND pm.deleted_at IS NULL`,
      [auth.userId, auth.tenantId],
    )) ids.add(r.user_id);
  }
  return [...ids];
}
const canSeePerformance = async (auth, userId) => {
  const scope = await performanceScope(auth);
  return scope === null || scope.includes(userId);
};
function canRate(auth, subject) {
  if (subject.id === auth.userId) return false;
  if (SEES_ALL_PERFORMANCE.includes(auth.role)) return true;
  return subject.manager_id === auth.userId;
}

const shapeReview = (r) => {
  const extra = performance.parseDetail(r.pillars);
  return { ...r, pillars: extra.pillars || [], coverage_pct: extra.coverage_pct ?? null, direct_reports: extra.direct_reports ?? 0 };
};

router.get('/performance', requires('hr_performance', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const month = req.query.month || monthIso();
  const scope = await performanceScope(req.auth);
  const filters = ['r.tenant_id = ?', 'r.period_month = ?', "u.role NOT IN ('owner','super_admin')"];
  const params = [tenantId, month];
  if (scope) { filters.push(`r.user_id IN (${scope.map(() => '?').join(',')})`); params.push(...scope); }
  if (req.query.user_id) { filters.push('r.user_id = ?'); params.push(req.query.user_id); }

  const rows = (await all(
    `SELECT r.*, u.name AS user_name, u.avatar_url, u.designation, u.role AS user_role, u.manager_id,
            rev.name AS reviewer_name, sl.name AS service_line_name, mgr.name AS manager_name
       FROM performance_reviews r
       JOIN users u ON u.id = r.user_id
       LEFT JOIN users rev ON rev.id = r.reviewer_id
       LEFT JOIN users mgr ON mgr.id = u.manager_id
       LEFT JOIN service_lines sl ON sl.id = u.service_line_id
      WHERE ${filters.join(' AND ')} ORDER BY r.overall_score DESC NULLS LAST, u.name`,
    params,
  )).map(shapeReview);

  // A rank only means something to someone looking at more than themselves.
  const ranked = scope === null || scope.length > 1;
  return ok(res, await Promise.all(rows.map(async (r, i) => ({
    ...r,
    rank: ranked && r.overall_score != null ? i + 1 : null,
    can_rate: canRate(req.auth, { id: r.user_id, manager_id: r.manager_id }) && await can(req.auth, 'hr_performance', 'edit'),
    kpis: await all('SELECT * FROM performance_kpi_scores WHERE review_id = ?', [r.id]),
  }))));
});

/** The rules in force - weights, thresholds, bands - for the "how it is calculated" notes. */
router.get('/performance/config', requires('hr_performance', 'view'), async (req, res) => ok(res, {
  weights: await performance.weightsFor(req.auth.tenantId),
  defaults: performance.DEFAULT_WEIGHTS,
  pillars: performance.PILLARS,
  min_sample: performance.MIN_SAMPLE,
  min_coverage: performance.MIN_COVERAGE,
  priority_weight: performance.PRIORITY_WEIGHT,
  bands: performance.BANDS,
  can_edit: ['owner', 'super_admin', 'hr'].includes(req.auth.role),
}));

router.put('/performance/config', requires('hr_performance', 'edit'), async (req, res) => {
  if (!['owner', 'super_admin', 'hr'].includes(req.auth.role)) throw forbidden('Only the Owner or HR can change the scorecard weights');
  const before = await performance.weightsFor(req.auth.tenantId);
  const after = await performance.saveWeights(req.auth.tenantId, req.body || {});
  await audit(req, { entity: 'performance_config', entityId: req.auth.tenantId, action: 'update', before, after });
  return ok(res, after);
});

/**
 * One person's scorecard computed live from today's records - the month to
 * date for the current month. Nothing is saved; the stored review (rating,
 * notes, status) comes back alongside it.
 */
router.get('/performance/scorecard', requires('hr_performance', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const userId = req.query.user_id || req.auth.userId;
  if (!await canSeePerformance(req.auth, userId)) throw forbidden('You can only see your own scorecard and your team\'s');
  const month = req.query.month || monthIso();

  const { period, weights, cards } = await performance.computeScorecards(tenantId, month, [userId]);
  const card = cards[0];
  if (!card) {
    return ok(res, { period, weights, card: null, review: null, reason: 'The workspace Owner is not scored - they rate everyone else.' });
  }
  const stored = await get('SELECT * FROM performance_reviews WHERE tenant_id = ? AND user_id = ? AND period_month = ?', [tenantId, userId, month]);
  const subject = await get('SELECT id, manager_id FROM users WHERE id = ?', [userId]);
  const overall = performance.overallFor(card.system_score, stored?.manager_rating, weights.rating_share);
  return ok(res, {
    period,
    weights,
    card: { ...card, overall_score: overall, band: performance.bandFor(overall, card.coverage_pct) },
    review: stored ? shapeReview(stored) : null,
    can_rate: canRate(req.auth, subject) && await can(req.auth, 'hr_performance', 'edit'),
  });
});

/** Recomputes and stores the month's scorecards. Keeps ratings, notes and status. */
router.post('/performance/generate', requires('hr_performance', 'create'), async (req, res) => {
  const { month = monthIso(), user_id: onlyUser } = req.body || {};
  const result = await performance.generateReviews(req.auth.tenantId, month, onlyUser ? [onlyUser] : null);
  await audit(req, { entity: 'performance_review', action: 'create', after: { generated: result.generated, month } });
  return ok(res, { generated: result.generated, month, period: result.period });
});

router.patch('/performance/:id', requires('hr_performance', 'edit'), async (req, res) => {
  const body = validate(z.object({
    manager_rating: z.number().int().min(1).max(5).optional(),
    strengths: z.string().max(4000).optional().nullable(),
    improvements: z.string().max(4000).optional().nullable(),
    status: z.enum(['draft', 'submitted']).optional(),
  }), req.body);

  const r = repo('performance_reviews', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Performance review');
  const subject = await get('SELECT id, name, manager_id FROM users WHERE id = ?', [before.user_id]);
  if (!canRate(req.auth, subject)) {
    throw forbidden(subject.id === req.auth.userId
      ? 'You cannot review yourself - your own card is rated by your manager or the Owner'
      : 'Only their reporting manager, the Owner or HR can review this person');
  }

  const patch = { ...body, updated_at: nowIso() };
  if (body.manager_rating != null) {
    const { rating_share: share } = await performance.weightsFor(req.auth.tenantId);
    patch.overall_score = performance.overallFor(before.system_score ?? before.kpi_score, body.manager_rating, share);
    patch.band = performance.bandFor(patch.overall_score, performance.parseDetail(before.pillars).coverage_pct ?? 100);
    patch.reviewed_at = nowIso();
    patch.reviewer_id = req.auth.userId;
  }

  const after = await r.update(req.params.id, patch);
  if (body.status === 'submitted' && before.status !== 'submitted') {
    await notifyMany({
      tenantId: req.auth.tenantId,
      userIds: [before.user_id],
      eventKey: 'performance.reviewed',
      vars: { period: before.period_month, reviewer: req.auth.name, score: after.overall_score ?? '—' },
      link: '/hr?tab=performance',
      channels: ['in_app'],
      dedupeKey: `perf_reviewed:${after.id}`,
    }).catch(() => {});
  }
  await audit(req, { entity: 'performance_review', entityId: after.id, action: 'update', before, after });
  return ok(res, shapeReview(after));
});

/** The person reviewed confirms they have read it. Only they can. */
router.post('/performance/:id/acknowledge', requires('hr_performance', 'view'), async (req, res) => {
  const r = repo('performance_reviews', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Performance review');
  if (before.user_id !== req.auth.userId) throw forbidden('Only the person reviewed can acknowledge their review');
  if (before.status !== 'submitted') throw badRequest('There is nothing to acknowledge until your manager submits the review');
  const after = await r.update(before.id, { status: 'acknowledged', acknowledged_at: nowIso(), updated_at: nowIso() });
  await audit(req, { entity: 'performance_review', entityId: after.id, action: 'update', before, after });
  return ok(res, shapeReview(after));
});

router.get('/performance/history/:userId', requires('hr_performance', 'view'), async (req, res) => {
  if (!await canSeePerformance(req.auth, req.params.userId)) throw forbidden();
  return ok(res, (await all(
    `SELECT period_month, completion_pct, attendance_pct, kpi_score, system_score, manager_rating,
            overall_score, band, scorecard_kind, status
       FROM performance_reviews WHERE tenant_id = ? AND user_id = ? ORDER BY period_month DESC LIMIT 24`,
    [req.auth.tenantId, req.params.userId],
  )).reverse());
});

// =============================================================== C4 HIRING
const openingSchema = z.object({
  title: z.string().min(2).max(160),
  service_line_id: z.string().optional().nullable(),
  department: z.string().optional().nullable(),
  qualification: z.string().optional().nullable(),
  skills: z.array(z.string()).optional(),
  experience_min_years: z.number().min(0).optional(),
  experience_max_years: z.number().min(0).optional().nullable(),
  headcount: z.number().int().min(1).optional(),
  salary_min_minor: z.number().int().min(0).optional().nullable(),
  salary_max_minor: z.number().int().min(0).optional().nullable(),
  location: z.string().optional().nullable(),
  status: z.enum(['open', 'on_hold', 'closed']).optional(),
  hiring_manager_id: z.string().optional().nullable(),
  target_close_date: z.string().optional().nullable(),
});

router.get('/hiring/openings', requires('hr_hiring', 'view'), async (req, res) => ok(res, (await all(
  `SELECT j.*, sl.name AS service_line_name, u.name AS hiring_manager_name,
          (SELECT COUNT(*) FROM candidates c WHERE c.job_opening_id = j.id AND c.deleted_at IS NULL) AS candidate_count
     FROM job_openings j
     LEFT JOIN service_lines sl ON sl.id = j.service_line_id
     LEFT JOIN users u ON u.id = j.hiring_manager_id
    WHERE j.tenant_id = ? AND j.deleted_at IS NULL ${req.query.status ? 'AND j.status = ?' : ''}
    ORDER BY j.created_at DESC`,
  req.query.status ? [req.auth.tenantId, req.query.status] : [req.auth.tenantId],
)).map((j) => ({ ...j, skills: JSON.parse(j.skills || '[]') }))));

router.post('/hiring/openings', requires('hr_hiring', 'create'), async (req, res) => {
  const body = validate(openingSchema, req.body);
  const id = uuid();
  await run(
    `INSERT INTO job_openings (id, tenant_id, title, service_line_id, department, qualification, skills,
       experience_min_years, experience_max_years, headcount, salary_min_minor, salary_max_minor,
       location, status, hiring_manager_id, target_close_date, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.title, body.service_line_id ?? null, body.department ?? null,
      body.qualification ?? null, JSON.stringify(body.skills || []), body.experience_min_years || 0,
      body.experience_max_years ?? null, body.headcount || 1, body.salary_min_minor ?? null,
      body.salary_max_minor ?? null, body.location ?? null, body.status || 'open',
      body.hiring_manager_id ?? null, body.target_close_date ?? null, nowIso(), nowIso()],
  );
  await audit(req, { entity: 'job_opening', entityId: id, action: 'create', after: { title: body.title } });
  return created(res, await get('SELECT * FROM job_openings WHERE id = ?', [id]));
});

router.patch('/hiring/openings/:id', requires('hr_hiring', 'edit'), async (req, res) => {
  const r = repo('job_openings', req.auth.tenantId);
  if (!await r.findById(req.params.id)) throw notFound('Job opening');
  const body = validate(openingSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.skills) patch.skills = JSON.stringify(body.skills);
  return ok(res, await r.update(req.params.id, patch));
});

router.delete('/hiring/openings/:id', requires('hr_hiring', 'delete'), async (req, res) => {
  await repo('job_openings', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

const CANDIDATE_STAGES = ['sourced', 'screened', 'interview', 'offer', 'hired', 'rejected'];

const candidateSchema = z.object({
  job_opening_id: z.string().optional().nullable(),
  name: z.string().min(2).max(120),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  experience_years: z.number().min(0).optional().nullable(),
  current_ctc_minor: z.number().int().min(0).optional().nullable(),
  expected_ctc_minor: z.number().int().min(0).optional().nullable(),
  stage: z.enum(CANDIDATE_STAGES).optional(),
  rating: z.number().min(1).max(5).optional().nullable(),
  notes: z.string().optional().nullable(),
  rejected_reason: z.string().optional().nullable(),
});

/** C4 - the hiring pipeline board. */
router.get('/hiring/candidates', requires('hr_hiring', 'view'), async (req, res) => {
  const filters = ['c.tenant_id = ?', 'c.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  if (req.query.job_opening_id) { filters.push('c.job_opening_id = ?'); params.push(req.query.job_opening_id); }

  const rows = await all(
    `SELECT c.*, j.title AS job_title FROM candidates c
       LEFT JOIN job_openings j ON j.id = c.job_opening_id
      WHERE ${filters.join(' AND ')} ORDER BY c.updated_at DESC`,
    params,
  );

  return ok(res, CANDIDATE_STAGES.map((stage) => ({
    stage,
    candidates: rows.filter((c) => c.stage === stage),
    count: rows.filter((c) => c.stage === stage).length,
  })));
});

router.post('/hiring/candidates', requires('hr_hiring', 'create'), async (req, res) => {
  const body = validate(candidateSchema, req.body);
  const id = uuid();
  await run(
    `INSERT INTO candidates (id, tenant_id, job_opening_id, name, email, phone, source,
       experience_years, current_ctc_minor, expected_ctc_minor, stage, rating, notes,
       stage_changed_at, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.job_opening_id ?? null, body.name, body.email || null,
      body.phone ?? null, body.source ?? null, body.experience_years ?? null,
      body.current_ctc_minor ?? null, body.expected_ctc_minor ?? null, body.stage || 'sourced',
      body.rating ?? null, body.notes ?? null, nowIso(), nowIso(), nowIso()],
  );
  return created(res, await get('SELECT * FROM candidates WHERE id = ?', [id]));
});

router.patch('/hiring/candidates/:id', requires('hr_hiring', 'edit'), async (req, res) => {
  const r = repo('candidates', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Candidate');

  const body = validate(candidateSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.email === '') patch.email = null;

  if (body.stage && body.stage !== before.stage) {
    patch.stage_changed_at = nowIso();
    if (body.stage === 'rejected' && !body.rejected_reason && !before.rejected_reason) {
      throw badRequest('Rejecting a candidate needs a reason');
    }
    if (body.stage === 'hired' && before.job_opening_id) {
      await run('UPDATE job_openings SET filled = filled + 1, updated_at = ? WHERE id = ?',
        [nowIso(), before.job_opening_id]);
      const opening = await get('SELECT * FROM job_openings WHERE id = ?', [before.job_opening_id]);
      if (opening && opening.filled >= opening.headcount) {
        await run("UPDATE job_openings SET status = 'closed', updated_at = ? WHERE id = ?", [nowIso(), opening.id]);
      }
    }
  }

  const after = await r.update(req.params.id, patch);
  await audit(req, { entity: 'candidate', entityId: after.id, action: 'update', before, after });
  return ok(res, after);
});

router.delete('/hiring/candidates/:id', requires('hr_hiring', 'delete'), async (req, res) => {
  await repo('candidates', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

router.get('/hiring/candidates/:id/interviews', requires('hr_hiring', 'view'), async (req, res) => ok(res, await all(
  `SELECT i.*, u.name AS interviewer_name FROM interviews i
     LEFT JOIN users u ON u.id = i.interviewer_id
    WHERE i.tenant_id = ? AND i.candidate_id = ? ORDER BY i.created_at`,
  [req.auth.tenantId, req.params.id],
)));

router.post('/hiring/candidates/:id/interviews', requires('hr_hiring', 'create'), async (req, res) => {
  const body = validate(z.object({
    round: z.string().min(1),
    interviewer_id: z.string().optional().nullable(),
    scheduled_at: z.string().optional().nullable(),
    feedback: z.string().optional().nullable(),
    score: z.number().min(1).max(5).optional().nullable(),
    recommendation: z.enum(['proceed', 'hold', 'reject']).optional().nullable(),
  }), req.body);

  if (!await get('SELECT id FROM candidates WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId])) throw notFound('Candidate');

  const id = uuid();
  await run(
    `INSERT INTO interviews (id, tenant_id, candidate_id, round, interviewer_id, scheduled_at,
       feedback, score, recommendation, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, req.params.id, body.round, body.interviewer_id ?? null,
      body.scheduled_at ?? null, body.feedback ?? null, body.score ?? null,
      body.recommendation ?? null, nowIso(), nowIso()],
  );
  return created(res, await get('SELECT * FROM interviews WHERE id = ?', [id]));
});

router.patch('/hiring/interviews/:id', requires('hr_hiring', 'edit'), async (req, res) => {
  const iv = await get('SELECT * FROM interviews WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!iv) throw notFound('Interview');

  const body = validate(z.object({
    feedback: z.string().optional().nullable(),
    score: z.number().min(1).max(5).optional().nullable(),
    recommendation: z.enum(['proceed', 'hold', 'reject']).optional().nullable(),
    scheduled_at: z.string().optional().nullable(),
  }), req.body);

  const cols = Object.keys(body);
  if (cols.length) {
    await run(`UPDATE interviews SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...cols.map((c) => body[c]), nowIso(), iv.id]);
  }
  return ok(res, await get('SELECT * FROM interviews WHERE id = ?', [iv.id]));
});

export { router as hrRouter };
