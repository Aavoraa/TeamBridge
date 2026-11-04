import { Router } from 'express';
import { saveFile, sendStoredFile } from '../services/storage.js';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { get, all, run, tx, hasColumn } from '../db/index.js';
import { uuid, nowIso, todayIso } from '../lib/util.js';
import { DEFAULT_TZ, DUE_TIME_RE, dueAtIso, formatDueTime, timeInTz } from '../lib/dueTime.js';
import {
  PENDING, assessCheckIn, logAttendance, scheduleFor, tzFor, workDayFor, workMinutes,
  minutesAtCheckout, statusAtCheckout,
} from '../services/attendance.js';
import { notifyRole } from '../services/notifications.js';
import { checkEnabled, METHOD as NETWORK_METHOD } from '../services/officeNetwork.js';
import { ok, created, validate, notFound, badRequest, ApiError } from '../lib/http.js';
import { config } from '../config.js';
import { syncDeadline } from './actionItems.routes.js';
import { canAccessReimbursement } from './reimbursements.routes.js';

const router = Router();

/**
 * AR5 - mobile sync.
 *
 * `GET /sync?updated_since=` returns a delta across the tables the mobile app
 * caches. `POST /sync/queue` replays actions taken while offline. Conflicts are
 * last-write-wins, and every resolved conflict is reported back to the client
 * so the user can be told what happened rather than silently losing an edit.
 */

const SYNCED_TABLES = {
  action_items: `SELECT a.*, u.name AS owner_name, c.name AS client_name FROM action_items a
                   LEFT JOIN users u ON u.id = a.owner_id LEFT JOIN clients c ON c.id = a.client_id`,
  clients: 'SELECT c.* FROM clients c',
  contacts: 'SELECT c.* FROM contacts c',
  meetings: 'SELECT m.* FROM meetings m',
  notifications: 'SELECT n.* FROM notifications n',
  attendance: 'SELECT a.* FROM attendance a',
  leave_requests: 'SELECT l.* FROM leave_requests l',
  action_categories: 'SELECT a.* FROM action_categories a',
  service_lines: 'SELECT s.* FROM service_lines s',
  pipeline_stages: 'SELECT p.* FROM pipeline_stages p',
};

const alias = { action_items: 'a', clients: 'c', contacts: 'c', meetings: 'm', notifications: 'n', attendance: 'a', leave_requests: 'l', action_categories: 'a', service_lines: 's', pipeline_stages: 'p' };

router.get('/', async (req, res) => {
  const { tenantId, userId, scope } = req.auth;
  const since = req.query.updated_since || '1970-01-01T00:00:00.000Z';
  const tables = req.query.tables ? String(req.query.tables).split(',') : Object.keys(SYNCED_TABLES);
  const limit = Math.min(500, Number(req.query.limit) || 300);

  const delta = {};
  for (const table of tables) {
    const base = SYNCED_TABLES[table];
    if (!base) continue;
    const a = alias[table];
    const filters = [`${a}.tenant_id = ?`];
    const params = [tenantId];

    // The timestamp column differs by table - reference data such as
    // action_categories is insert-only and has no updated_at at all, so the
    // column is chosen from the actual schema rather than assumed.
    const stamp = hasColumn(table, 'updated_at') ? 'updated_at' : 'created_at';
    filters.push(`${a}.${stamp} > ?`);
    params.push(since);

    // Employees sync only their own slice, which keeps the payload small.
    if (scope === 'own') {
      if (table === 'action_items') { filters.push(`(${a}.owner_id = ? OR ${a}.created_by = ?)`); params.push(userId, userId); }
      if (table === 'clients') { filters.push(`${a}.owner_id = ?`); params.push(userId); }
      if (['attendance', 'leave_requests', 'notifications'].includes(table)) { filters.push(`${a}.user_id = ?`); params.push(userId); }
    }

    const rows = await all(`${base} WHERE ${filters.join(' AND ')} ORDER BY ${a}.${stamp} LIMIT ?`,
      [...params, limit]);
    delta[table] = rows;
  }

  return ok(res, delta, {
    synced_at: nowIso(),
    since,
    counts: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, v.length])),
    // A full page means there is more to fetch; the client re-syncs from here.
    has_more: Object.values(delta).some((v) => v.length >= limit),
  });
});

/**
 * Replays a queue of offline actions. Each entry carries a client-generated
 * `client_id` so a retried queue never double-applies.
 */
const queueSchema = z.object({
  operations: z.array(z.object({
    client_id: z.string().min(4).max(64),
    type: z.enum([
      'action_item.create', 'action_item.update', 'action_item.complete',
      'attendance.check_in', 'attendance.check_out',
      'activity.log', 'comment.create',
    ]),
    payload: z.record(z.string(), z.any()),
    created_at: z.string(),
  })).max(200),
});

router.post('/queue', async (req, res) => {
  const { operations } = validate(queueSchema, req.body);
  const { tenantId, userId } = req.auth;
  const results = [];

  for (const op of operations) {
    const dedupeKey = `sync:${userId}:${op.client_id}`;
    const seen = await get('SELECT response_json FROM idempotency_keys WHERE tenant_id = ? AND key = ? AND endpoint = ?',
      [tenantId, dedupeKey, 'sync.queue']);
    if (seen) {
      results.push({ client_id: op.client_id, status: 'duplicate', ...JSON.parse(seen.response_json) });
      continue;
    }

    try {
      const outcome = await tx(async () => await applyOperation({ tenantId, userId, op, auth: req.auth }));
      await run(
        `INSERT INTO idempotency_keys (tenant_id, key, endpoint, response_json, status_code, created_at)
         VALUES (?,?, 'sync.queue', ?, 200, ?)`,
        [tenantId, dedupeKey, JSON.stringify(outcome), nowIso()],
      );
      results.push({ client_id: op.client_id, status: 'applied', ...outcome });
    } catch (err) {
      results.push({ client_id: op.client_id, status: 'failed', error: err.message });
    }
  }

  return ok(res, results, {
    applied: results.filter((r) => r.status === 'applied').length,
    duplicates: results.filter((r) => r.status === 'duplicate').length,
    failed: results.filter((r) => r.status === 'failed').length,
    synced_at: nowIso(),
  });
});

/** The workspace clock a queued offline edit should be resolved against. */
const tenantTz = async (tenantId) => (await get('SELECT timezone FROM tenants WHERE id = ?', [tenantId]))?.timezone
  || DEFAULT_TZ;

async function applyOperation({ tenantId, userId, op, auth }) {
  const ts = nowIso();

  switch (op.type) {
    case 'action_item.create': {
      // Same rule as the API: an action item is for somebody else.
      if (!op.payload.owner_id || op.payload.owner_id === userId) {
        throw new Error('An action item has to be assigned to somebody other than yourself');
      }
      const id = op.payload.id || uuid();
      // An offline task keeps whatever hour it was written down for; the
      // instant is worked out here, against the workspace clock, because the
      // phone that queued it may have been in another timezone entirely.
      const dueDate = op.payload.due_date ?? null;
      const dueTime = DUE_TIME_RE.test(String(op.payload.due_time || '')) ? op.payload.due_time : null;
      await run(
        `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
           category_id, priority, status, due_date, due_time, due_at, source_type, estimate_minutes,
           created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'open', ?,?,?, 'mobile_offline', ?, ?, ?)`,
        [id, tenantId, op.payload.title, op.payload.description ?? null,
          op.payload.owner_id || userId, userId, op.payload.client_id ?? null,
          op.payload.category_id ?? null, op.payload.priority || 'medium',
          dueDate, dueTime, dueAtIso(dueDate, dueTime, await tenantTz(tenantId)),
          op.payload.estimate_minutes ?? null,
          op.created_at || ts, ts],
      );
      const item = await get('SELECT * FROM action_items WHERE id = ?', [id]);
      await syncDeadline(tenantId, item);
      return { entity: 'action_item', id, server_updated_at: ts };
    }

    case 'action_item.update':
    case 'action_item.complete': {
      const item = await get('SELECT * FROM action_items WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
        [op.payload.id, tenantId]);
      if (!item) throw new Error('Action item no longer exists');

      // Last-write-wins, but a server edit newer than the queued one is reported.
      const conflict = item.updated_at > op.created_at;
      const patch = op.type === 'action_item.complete'
        ? { status: 'done', completed_at: op.created_at || ts, updated_at: ts }
        : { ...op.payload, id: undefined, updated_at: ts };
      delete patch.id;
      // A queued edit that moved the due date or time has to move the instant
      // with it, or the item would be reminded on and escalated at the old one.
      if (patch.due_date !== undefined || patch.due_time !== undefined) {
        const dueDate = (patch.due_date !== undefined ? patch.due_date : item.due_date) || null;
        const dueTime = (patch.due_time !== undefined ? patch.due_time : item.due_time) || null;
        patch.due_date = dueDate;
        patch.due_time = dueTime;
        patch.due_at = dueAtIso(dueDate, dueTime, await tenantTz(tenantId));
      }

      const cols = Object.keys(patch).filter((c) => patch[c] !== undefined);
      await run(`UPDATE action_items SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...cols.map((c) => patch[c]), item.id, tenantId]);

      const after = await get('SELECT * FROM action_items WHERE id = ?', [item.id]);
      await syncDeadline(tenantId, after);
      return {
        entity: 'action_item',
        id: item.id,
        server_updated_at: ts,
        ...(conflict && {
          conflict: 'last_write_wins',
          overwrote_server_version_at: item.updated_at,
          message: 'This item had also been changed on the server; your offline edit was applied.',
        }),
      };
    }

    // The one path allowed to supply its own stamp: the phone genuinely held
    // the button press while it had no signal, and `op.created_at` is when.
    // It is still judged by the same rules - a queued late arrival reaches HR
    // pending, exactly as it would have done online.
    case 'attendance.check_in': {
      if (auth.role === 'owner') return { entity: 'attendance', id: null, skipped: 'owner does not keep attendance' };
      const at = op.created_at || ts;
      const workDate = op.payload.work_date || await workDayFor(tenantId, new Date(at));
      const existing = await get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
        [tenantId, userId, workDate]);
      if (existing?.check_in_at) return { entity: 'attendance', id: existing.id, skipped: 'already checked in' };

      const schedule = await scheduleFor(tenantId, userId);
      const assessed = await assessCheckIn({ tenantId, workDate, at, schedule, userId });
      // A queued check-in reaches the server later, from wherever the phone is
      // by then - its address says nothing about where the button was pressed.
      // With the office-network check on, it cannot be verified, so HR decides.
      const networkCheck = await checkEnabled(tenantId);
      const reasons = [assessed.late && 'late', networkCheck && 'offline'].filter(Boolean);
      const status = reasons.length ? 'pending_approval' : 'present';
      const id = existing?.id || uuid();
      await run(
        `INSERT INTO attendance (id, tenant_id, user_id, work_date, check_in_at, in_lat, in_lng,
           source, status, late_minutes, scheduled_start, scheduled_end, network_verified,
           verification_method, review_reason, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?, 'mobile', ?,?,?,?,?,?,?,?,?)
         ON CONFLICT (tenant_id, user_id, work_date) DO UPDATE SET
           check_in_at = excluded.check_in_at, in_lat = excluded.in_lat, in_lng = excluded.in_lng,
           source = 'mobile', status = excluded.status, late_minutes = excluded.late_minutes,
           scheduled_start = excluded.scheduled_start, scheduled_end = excluded.scheduled_end,
           network_verified = excluded.network_verified,
           verification_method = excluded.verification_method,
           review_reason = excluded.review_reason, updated_at = excluded.updated_at`,
        [id, tenantId, userId, workDate, at, op.payload.lat ?? null, op.payload.lng ?? null,
          status, assessed.late_minutes, assessed.scheduled_start, assessed.scheduled_end,
          networkCheck ? 0 : null, networkCheck ? NETWORK_METHOD : null, reasons.join(',') || null,
          ts, ts],
      );
      await logAttendance({
        tenantId,
        attendanceId: id,
        userId,
        workDate,
        event: 'checked_in',
        actorId: userId,
        toStatus: status,
        at,
        note: networkCheck ? 'queued offline on mobile; network could not be verified' : 'queued offline on mobile',
      });
      if (networkCheck) {
        await notifyRole({
          tenantId,
          roles: ['hr', 'owner'],
          eventKey: 'attendance.network_review',
          vars: {
            person: auth?.name || 'An employee',
            actual: formatDueTime(timeInTz(await tzFor(tenantId), new Date(at))),
            work_date: workDate,
            late_note: assessed.late ? ` It was also ${assessed.late_minutes} min late.` : '',
          },
          link: '/hr?tab=attendance',
          dedupeKey: `attendance:${id}:network`,
        }).catch(() => {});
      } else if (assessed.late) {
        await notifyRole({
          tenantId,
          roles: ['hr', 'owner'],
          eventKey: 'attendance.late_check_in',
          vars: {
            person: auth?.name || 'An employee',
            actual: formatDueTime(timeInTz(await tzFor(tenantId), new Date(at))),
            scheduled: formatDueTime(schedule.start),
            late_minutes: assessed.late_minutes,
            work_date: workDate,
          },
          link: '/hr?tab=attendance',
          dedupeKey: `attendance:${id}:late`,
        }).catch(() => {});
      }
      return { entity: 'attendance', id, status, server_updated_at: ts };
    }

    case 'attendance.check_out': {
      const at = op.created_at || ts;
      const workDate = op.payload.work_date || await workDayFor(tenantId, new Date(at));
      const row = await get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
        [tenantId, userId, workDate]);
      if (!row?.check_in_at) throw new Error('No check-in recorded for that day');
      if (row.check_out_at) return { entity: 'attendance', id: row.id, skipped: 'already checked out' };

      // Every session of the day counts. A day HR has yet to rule on keeps
      // waiting; checking out is not a verdict.
      const minutes = minutesAtCheckout(row, at);
      const nextStatus = statusAtCheckout(row, minutes);
      await run(
        `UPDATE attendance SET check_out_at = ?, out_lat = ?, out_lng = ?, work_minutes = ?,
           status = ?, updated_at = ? WHERE id = ?`,
        [at, op.payload.lat ?? null, op.payload.lng ?? null, minutes, nextStatus, ts, row.id],
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
        note: 'queued offline on mobile',
      });
      return { entity: 'attendance', id: row.id, work_minutes: minutes, server_updated_at: ts };
    }

    case 'activity.log': {
      const id = uuid();
      await run(
        `INSERT INTO activities (id, tenant_id, client_id, contact_id, type, direction, subject, body,
           outcome, occurred_at, user_id, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, op.payload.client_id, op.payload.contact_id ?? null, op.payload.type || 'call',
          op.payload.direction || 'outbound', op.payload.subject ?? null, op.payload.body ?? null,
          op.payload.outcome ?? null, op.created_at || ts, userId, ts],
      );
      const patch = { last_activity_at: op.created_at || ts, updated_at: ts };
      if (op.payload.next_action) {
        patch.next_action = op.payload.next_action;
        patch.next_action_date = op.payload.next_action_date ?? null;
      }
      const cols = Object.keys(patch);
      await run(`UPDATE clients SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...cols.map((c) => patch[c]), op.payload.client_id, tenantId]);
      return { entity: 'activity', id, server_updated_at: ts };
    }

    case 'comment.create': {
      const id = uuid();
      await run(
        `INSERT INTO comments (id, tenant_id, entity, entity_id, author_id, body, mentions, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, tenantId, op.payload.entity, op.payload.entity_id, userId, op.payload.body,
          JSON.stringify(op.payload.mentions || []), op.created_at || ts, ts],
      );
      return { entity: 'comment', id, server_updated_at: ts };
    }

    default:
      throw new Error(`Unsupported operation "${op.type}"`);
  }
}

/** Bootstrap payload for a fresh mobile install. */
router.get('/bootstrap', async (req, res) => {
  const { tenantId, userId } = req.auth;
  return ok(res, {
    server_time: nowIso(),
    tenant: await get('SELECT id, name, timezone, currency, number_format, brand_primary, brand_accent, logo_url FROM tenants WHERE id = ?', [tenantId]),
    directory: await all(
      "SELECT id, name, email, role, designation, avatar_url FROM users WHERE tenant_id = ? AND deleted_at IS NULL AND status = 'active' AND role != 'client'",
      [tenantId],
    ),
    action_categories: await all('SELECT * FROM action_categories WHERE tenant_id = ? AND active = 1', [tenantId]),
    service_lines: await all('SELECT * FROM service_lines WHERE tenant_id = ? AND deleted_at IS NULL AND active = 1', [tenantId]),
    pipeline_stages: await all('SELECT * FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort', [tenantId]),
    leave_types: await all('SELECT * FROM leave_types WHERE tenant_id = ? AND active = 1', [tenantId]),
    my_attendance_today: await get('SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
      [tenantId, userId, todayIso()]) || null,
  });
});

// ================================================================== FILES
/** A5/A6 - attachments, including mobile voice notes. */
const fileRouter = Router();

/**
 * A few entities carry documents that are private to a subset of the tenant,
 * so being signed in is not enough to read them. A receipt is exactly as
 * private as the reimbursement claim it hangs off: the claimant, their
 * approving manager and the finance desk, and nobody else in the workspace.
 *
 * Anything not listed here keeps the previous behaviour - visible to the
 * tenant - which is what a meeting recording or an action-item file is.
 */
const ENTITY_GUARDS = {
  reimbursement: async (auth, entityId) => await canAccessReimbursement(auth, entityId),
};

async function assertEntityAccess(req, entity, entityId) {
  const guard = ENTITY_GUARDS[entity];
  if (!guard) return;
  if (!entityId || !(await guard(req.auth, entityId))) throw notFound('File');
}

fileRouter.post('/', async (req, res) => {
  const body = validate(z.object({
    entity: z.string().min(2).max(40),
    entity_id: z.string(),
    filename: z.string().min(1).max(200),
    mime: z.string().optional(),
    kind: z.enum(['file', 'voice_note']).optional(),
    // Base64 keeps the dev harness dependency-free; production swaps this for
    // a pre-signed S3 upload and stores only the returned key.
    content_base64: z.string().max(20_000_000),
  }), req.body);

  await assertEntityAccess(req, body.entity, body.entity_id);

  const buffer = Buffer.from(body.content_base64, 'base64');
  if (buffer.length > 15 * 1024 * 1024) throw badRequest('Files are limited to 15 MB');

  const safeName = body.filename.replace(/[^\w.\- ]/g, '_');
  const rel = path.posix.join('attachments', req.auth.tenantId, `${uuid()}-${safeName}`);
  await saveFile(rel, buffer, body.mime || undefined);

  const id = uuid();
  await run(
    `INSERT INTO attachments (id, tenant_id, entity, entity_id, filename, mime, size_bytes,
       storage_path, kind, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, body.entity, body.entity_id, body.filename, body.mime ?? null,
      buffer.length, rel, body.kind || 'file', req.auth.userId, nowIso()],
  );

  return created(res, { ...await get('SELECT * FROM attachments WHERE id = ?', [id]), url: `/api/v1/files/${rel}` });
});

fileRouter.get('/list', async (req, res) => {
  await assertEntityAccess(req, String(req.query.entity || ''), String(req.query.entity_id || ''));
  return ok(res, (await all(
    `SELECT a.*, u.name AS uploaded_by_name FROM attachments a LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.tenant_id = ? AND a.entity = ? AND a.entity_id = ? AND a.deleted_at IS NULL
      ORDER BY a.created_at DESC`,
    [req.auth.tenantId, req.query.entity, req.query.entity_id],
  )).map((a) => ({ ...a, url: `/api/v1/files/${a.storage_path}` })));
});

fileRouter.delete('/:id', async (req, res) => {
  const att = await get('SELECT * FROM attachments WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!att) throw notFound('Attachment');
  await assertEntityAccess(req, att.entity, att.entity_id);
  await run('UPDATE attachments SET deleted_at = ? WHERE id = ?', [nowIso(), att.id]);
  return ok(res, { ok: true });
});

/** Serves a stored file. The tenant prefix in the path is checked against the caller. */
fileRouter.get('/*splat', async (req, res, next) => {
  try {
    const rel = (req.params.splat || []).join('/') || req.path.replace(/^\//, '');
    const safe = path.posix.normalize(rel).replace(/^(\.\.(\/|$))+/, '');
    if (safe.startsWith('..') || safe.startsWith('/')) throw new ApiError(400, 'bad_path', 'Invalid file path');

    // Attachments live under attachments/<tenant_id>/ - enforce ownership, then
    // whatever narrower rule the entity it belongs to imposes. Guessing the URL
    // must not be a way around a claim's privacy.
    if (safe.startsWith('attachments/')) {
      const owner = safe.split('/')[1];
      if (owner !== req.auth.tenantId) throw notFound('File');
      const att = await get('SELECT entity, entity_id FROM attachments WHERE tenant_id = ? AND storage_path = ?',
        [req.auth.tenantId, safe]);
      if (att) await assertEntityAccess(req, att.entity, att.entity_id);
    } else {
      // Generated documents are looked up by their recorded path.
      const known = await get(
        `SELECT 1 AS ok FROM invoices WHERE tenant_id = ? AND pdf_path = ?
         UNION SELECT 1 FROM proposals WHERE tenant_id = ? AND pdf_path = ?
         UNION SELECT 1 FROM report_runs WHERE tenant_id = ? AND pdf_path = ?`,
        [req.auth.tenantId, safe, req.auth.tenantId, safe, req.auth.tenantId, safe],
      );
      if (!known) throw notFound('File');
    }

    if (!(await sendStoredFile(res, safe))) throw notFound('File');
  } catch (err) { next(err); }
});

export { router as syncRouter, fileRouter };
