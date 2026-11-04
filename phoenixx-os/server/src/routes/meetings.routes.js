import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit, paginate, pageMeta } from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import {
  DEFAULT_TZ, DUE_DATE_RE, DUE_TIME_RE, dueAtIso, todayInTz, timeInTz, formatDueTime,
} from '../lib/dueTime.js';
import { upsertDeadline } from '../services/deadlines.js';
import { notifyMany } from '../services/notifications.js';

const router = Router();

const meetingSchema = z.object({
  title: z.string().min(2).max(200),
  agenda: z.string().max(8000).optional().nullable(),
  client_id: z.string().optional().nullable(),
  project_id: z.string().optional().nullable(),
  scheduled_at: z.string(),
  duration_minutes: z.number().int().min(5).max(600).optional(),
  location: z.string().optional().nullable(),
  meeting_link: z.string().optional().nullable(),
  attendees: z.array(z.object({
    user_id: z.string().optional(),
    contact_id: z.string().optional(),
    external_name: z.string().optional(),
  })).optional(),
});

const SELECT = `
  SELECT m.*, u.name AS organizer_name, c.name AS client_name,
         (SELECT COUNT(*) FROM mom_points mp WHERE mp.meeting_id = m.id) AS mom_count,
         (SELECT COUNT(*) FROM mom_points mp WHERE mp.meeting_id = m.id AND mp.action_item_id IS NOT NULL) AS converted_count
    FROM meetings m
    LEFT JOIN users u ON u.id = m.organizer_id
    LEFT JOIN clients c ON c.id = m.client_id`;

router.get('/', requires('meetings', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['m.tenant_id = ?', 'm.deleted_at IS NULL'];
  const params = [req.auth.tenantId];

  if (req.query.status) { filters.push('m.status = ?'); params.push(req.query.status); }
  if (req.query.client_id) { filters.push('m.client_id = ?'); params.push(req.query.client_id); }
  if (req.query.from) { filters.push('m.scheduled_at >= ?'); params.push(req.query.from); }
  if (req.query.to) { filters.push('m.scheduled_at <= ?'); params.push(req.query.to); }
  if (req.query.mine === 'true') {
    filters.push('(m.organizer_id = ? OR m.id IN (SELECT meeting_id FROM meeting_attendees WHERE user_id = ?))');
    params.push(req.auth.userId, req.auth.userId);
  }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM meetings m WHERE ${where}`, params))?.n || 0);
  const rows = await all(`${SELECT} WHERE ${where} ORDER BY m.scheduled_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset]);

  return ok(res, rows, pageMeta(page, limit, total));
});

router.get('/:id', requires('meetings', 'view'), async (req, res) => {
  const meeting = await get(`${SELECT} WHERE m.id = ? AND m.tenant_id = ? AND m.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!meeting) throw notFound('Meeting');

  return ok(res, {
    ...meeting,
    attendees: await all(
      `SELECT ma.*, u.name AS user_name, u.avatar_url, ct.name AS contact_name
         FROM meeting_attendees ma
         LEFT JOIN users u ON u.id = ma.user_id
         LEFT JOIN contacts ct ON ct.id = ma.contact_id
        WHERE ma.meeting_id = ?`,
      [meeting.id],
    ),
    mom_points: await all(
      `SELECT mp.*, u.name AS owner_name, ai.status AS action_status, ai.title AS action_title
         FROM mom_points mp
         LEFT JOIN users u ON u.id = mp.owner_id
         LEFT JOIN action_items ai ON ai.id = mp.action_item_id
        WHERE mp.meeting_id = ? ORDER BY mp.sort, mp.created_at`,
      [meeting.id],
    ),
  });
});

router.post('/', requires('meetings', 'create'), async (req, res) => {
  const body = validate(meetingSchema, req.body);
  const { tenantId, userId } = req.auth;
  const id = uuid();
  const ts = nowIso();

  await tx(async () => {
    await run(
      `INSERT INTO meetings (id, tenant_id, title, agenda, client_id, project_id, organizer_id,
         scheduled_at, duration_minutes, location, meeting_link, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, body.title, body.agenda ?? null, body.client_id ?? null, body.project_id ?? null,
        userId, body.scheduled_at, body.duration_minutes || 30, body.location ?? null,
        body.meeting_link ?? null, ts, ts],
    );
    for (const a of body.attendees || []) {
      await run(
        `INSERT INTO meeting_attendees (id, tenant_id, meeting_id, user_id, contact_id, external_name, created_at)
         VALUES (?,?,?,?,?,?,?)`,
        [uuid(), tenantId, id, a.user_id ?? null, a.contact_id ?? null, a.external_name ?? null, ts],
      );
    }
  });

  const attendeeIds = (body.attendees || []).map((a) => a.user_id).filter((x) => x && x !== userId);
  if (attendeeIds.length) {
    // Read on the workspace clock: an invite that names the hour is worth more
    // than one that only names the day.
    const tz = req.tenant?.timezone || DEFAULT_TZ;
    const at = new Date(body.scheduled_at);
    const day = todayInTz(tz, at);
    await notifyMany({
      tenantId,
      userIds: attendeeIds,
      eventKey: 'action_item.assigned',
      vars: {
        title: `Meeting: ${body.title}`,
        priority: 'medium',
        due_date: day,
        due_time: formatDueTime(timeInTz(tz, at)),
        due: `${day} · ${formatDueTime(timeInTz(tz, at))}`,
      },
      link: `/meetings/${id}`,
    }).catch(() => {});
  }

  await audit(req, { entity: 'meeting', entityId: id, action: 'create', after: { title: body.title } });
  return created(res, await get(`${SELECT} WHERE m.id = ?`, [id]));
});

router.patch('/:id', requires('meetings', 'edit'), async (req, res) => {
  const r = repo('meetings', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Meeting');

  const body = validate(meetingSchema.partial().extend({
    status: z.enum(['scheduled', 'completed', 'cancelled']).optional(),
    mom_summary: z.string().optional().nullable(),
  }), req.body);

  const patch = { ...body, updated_at: nowIso() };
  delete patch.attendees;
  const after = await r.update(req.params.id, patch);

  await audit(req, { entity: 'meeting', entityId: after.id, action: 'update', before, after });
  return ok(res, await get(`${SELECT} WHERE m.id = ?`, [after.id]));
});

router.delete('/:id', requires('meetings', 'delete'), async (req, res) => {
  const r = repo('meetings', req.auth.tenantId);
  if (!await r.findById(req.params.id)) throw notFound('Meeting');
  await r.softDelete(req.params.id, nowIso());
  await audit(req, { entity: 'meeting', entityId: req.params.id, action: 'delete' });
  return ok(res, { ok: true });
});

// ------------------------------------------------------------------- MOM
const momSchema = z.object({
  kind: z.enum(['note', 'decision', 'action', 'risk']).optional(),
  text: z.string().min(2).max(2000),
  owner_id: z.string().optional().nullable(),
  due_date: z.string().optional().nullable(),
});

router.post('/:id/mom', requires('meetings', 'edit'), async (req, res) => {
  const meeting = await get('SELECT * FROM meetings WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!meeting) throw notFound('Meeting');
  if (meeting.mom_locked_at) throw badRequest('This MOM has been locked and can no longer be edited');

  const points = validate(z.union([momSchema, z.array(momSchema)]), req.body);
  const list = Array.isArray(points) ? points : [points];
  const sortBase = Number((await get('SELECT COALESCE(MAX(sort), -1) AS s FROM mom_points WHERE meeting_id = ?',
    [meeting.id]))?.s ?? -1) + 1;

  const ids = await tx(async () => await Promise.all(list.map(async (p, i) => {
    const id = uuid();
    await run(
      `INSERT INTO mom_points (id, tenant_id, meeting_id, kind, text, owner_id, due_date, sort, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      [id, req.auth.tenantId, meeting.id, p.kind || 'note', p.text, p.owner_id ?? null,
        p.due_date ?? null, sortBase + i, nowIso(), nowIso()],
    );
    return id;
  })));

  return created(res, await all(
    `SELECT * FROM mom_points WHERE id IN (${ids.map(() => '?').join(',')})`, ids,
  ));
});

router.patch('/:id/mom/:pointId', requires('meetings', 'edit'), async (req, res) => {
  const point = await get(
    'SELECT * FROM mom_points WHERE id = ? AND meeting_id = ? AND tenant_id = ?',
    [req.params.pointId, req.params.id, req.auth.tenantId],
  );
  if (!point) throw notFound('MOM point');

  const body = validate(momSchema.partial(), req.body);
  const cols = Object.keys(body);
  if (cols.length) {
    await run(`UPDATE mom_points SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...cols.map((c) => body[c]), nowIso(), point.id]);
  }
  return ok(res, await get('SELECT * FROM mom_points WHERE id = ?', [point.id]));
});

router.delete('/:id/mom/:pointId', requires('meetings', 'edit'), async (req, res) => {
  await run('DELETE FROM mom_points WHERE id = ? AND meeting_id = ? AND tenant_id = ?',
    [req.params.pointId, req.params.id, req.auth.tenantId]);
  return ok(res, { ok: true });
});

/** A2 - one-tap conversion of a MOM point into a tracked action item. */
router.post('/:id/mom/:pointId/convert', requires('action_items', 'create'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const point = await get(
    `SELECT mp.*, m.client_id, m.project_id, m.title AS meeting_title
       FROM mom_points mp JOIN meetings m ON m.id = mp.meeting_id
      WHERE mp.id = ? AND mp.meeting_id = ? AND mp.tenant_id = ?`,
    [req.params.pointId, req.params.id, tenantId],
  );
  if (!point) throw notFound('MOM point');
  if (point.action_item_id) throw badRequest('This point has already been converted into an action item');

  const body = validate(z.object({
    owner_id: z.string().optional(),
    due_date: z.string().regex(DUE_DATE_RE).optional(),
    /** A point can be converted straight onto an hour of the day. */
    due_time: z.string().regex(DUE_TIME_RE).optional().nullable(),
    priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
    category_id: z.string().optional(),
  }), req.body || {});

  const id = uuid();
  const ts = nowIso();
  const tz = req.tenant?.timezone || DEFAULT_TZ;
  const dueDate = body.due_date || point.due_date || null;
  const dueTime = body.due_time ?? null;

  await tx(async () => {
    await run(
      `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
         project_id, category_id, priority, status, due_date, due_time, due_at, source_type, source_id,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?, 'open', ?,?,?, 'mom', ?, ?, ?)`,
      [id, tenantId, point.text.slice(0, 240),
        `From MOM of "${point.meeting_title}".`,
        body.owner_id || point.owner_id || userId, userId, point.client_id, point.project_id,
        body.category_id ?? null, body.priority || 'medium',
        dueDate, dueTime, dueAtIso(dueDate, dueTime, tz), point.id, ts, ts],
    );
    await run('UPDATE mom_points SET action_item_id = ?, kind = ?, updated_at = ? WHERE id = ?',
      [id, 'action', ts, point.id]);
  });

  const item = await get('SELECT * FROM action_items WHERE id = ?', [id]);
  if (item.due_date) {
    const owner = item.owner_id ? await get('SELECT manager_id FROM users WHERE id = ?', [item.owner_id]) : null;
    await upsertDeadline({
      tenantId,
      sourceType: 'action_item',
      sourceId: id,
      title: item.title,
      dueAt: item.due_at || item.due_date,
      ownerId: item.owner_id,
      escalateToId: owner?.manager_id,
      meta: {
        priority: item.priority,
        timed: !!item.due_time,
        due_date: item.due_date,
        due_time: item.due_time || null,
      },
    });
  }

  await audit(req, { entity: 'action_item', entityId: id, action: 'create', after: { from_mom: point.id } });
  return created(res, item);
});

/** Locks the MOM and converts every outstanding action-type point at once. */
router.post('/:id/finalize', requires('meetings', 'edit'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const meeting = await get('SELECT * FROM meetings WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!meeting) throw notFound('Meeting');

  const pending = await all(
    "SELECT * FROM mom_points WHERE meeting_id = ? AND kind = 'action' AND action_item_id IS NULL",
    [meeting.id],
  );
  const tz = req.tenant?.timezone || DEFAULT_TZ;
  const createdIds = await tx(async () => {
    const out = [];
    for (const p of pending) {
      const id = uuid();
      await run(
        `INSERT INTO action_items (id, tenant_id, title, description, owner_id, created_by, client_id,
           project_id, priority, status, due_date, due_at, source_type, source_id, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?, 'medium', 'open', ?,?, 'mom', ?, ?, ?)`,
        [id, tenantId, p.text.slice(0, 240), `From MOM of "${meeting.title}".`,
          p.owner_id || userId, userId, meeting.client_id, meeting.project_id,
          p.due_date, dueAtIso(p.due_date, null, tz), p.id, nowIso(), nowIso()],
      );
      await run('UPDATE mom_points SET action_item_id = ? WHERE id = ?', [id, p.id]);
      out.push(id);
    }
    await run("UPDATE meetings SET status = 'completed', mom_locked_at = ?, updated_at = ? WHERE id = ?",
      [nowIso(), nowIso(), meeting.id]);
    return out;
  });

  for (const id of createdIds) {
    const item = await get('SELECT * FROM action_items WHERE id = ?', [id]);
    if (item.due_date) {
      await upsertDeadline({
        tenantId, sourceType: 'action_item', sourceId: id, title: item.title,
        dueAt: item.due_at || item.due_date,
        ownerId: item.owner_id,
        meta: { priority: item.priority, timed: false, due_date: item.due_date, due_time: null },
      });
    }
  }

  await audit(req, { entity: 'meeting', entityId: meeting.id, action: 'approve', after: { converted: createdIds.length } });
  return ok(res, { converted: createdIds.length, action_item_ids: createdIds });
});

export { router as meetingsRouter };
