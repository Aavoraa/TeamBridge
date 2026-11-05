import express, { Router } from 'express';
import { z } from 'zod';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import {
  ok, created, validate, notFound, badRequest, forbidden, audit, ApiError,
} from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import { formatDue } from '../lib/dueTime.js';
import { eligibleAssignees } from '../services/taskAssistant.js';
import { createActionItem, validateTaskBody } from './actionItems.routes.js';
import { intelScope } from '../services/liveMeetings.js';
import { bookFollowUp, followUpsFor } from '../services/followUpMeetings.js';
import {
  SOURCE_TYPE, RECORDING_EXT, TRANSCRIPT_EXT, MAX_PART_BYTES, MAX_PARTS, MAX_DOCUMENT_BYTES, MAX_CHUNK_BYTES,
  advanceMeeting, retryMeeting, applySpeakerMap, staffOf, speechConfigured, analysisConfigured, extOf,
} from '../services/meetingIntel.js';

/**
 * AI Meeting Intelligence (see services/meetingIntel.js for the pipeline).
 *
 * Who sees what: the module permission decides who is in at all (owner and
 * manager templates; a custom role can grant it). Within it, an owner sees
 * every meeting in the workspace; anyone else sees the meetings they uploaded,
 * plus meetings recorded in AI Meetings that they can see there (they hosted
 * or were on it, or - for a manager - their direct reports hosted or attended). Approving a task also requires that the assignee is someone the
 * reviewer may hand work to - the same rule as the task assistant.
 */
const router = Router();

const PROCESSING = ['uploading', 'queued', 'transcribing', 'analyzing'];
const parse = (s, f) => { try { return s ? JSON.parse(s) : f; } catch { return f; } };

const scope = (auth) => intelScope(auth, 'm');

/** The meeting, if this user may see it. Anything else is "not found". */
async function meetingFor(req, id) {
  const v = scope(req.auth);
  const m = await get(`SELECT * FROM ai_meetings m WHERE m.id = ? AND m.tenant_id = ? AND m.deleted_at IS NULL AND ${v.where}`,
    [id, req.auth.tenantId, ...v.params]);
  if (!m) throw notFound('Meeting');
  return m;
}

const LIST_SELECT = `
  SELECT m.id, m.title, m.meeting_date, m.status, m.source_kind, m.file_name, m.file_size, m.error, m.failed_stage,
         m.created_at, m.updated_at, m.completed_at, m.uploaded_by, u.name AS uploaded_by_name,
         p.name AS project_name, c.name AS client_name, m.parts_expected,
         (SELECT COUNT(*) FROM ai_meeting_parts pt WHERE pt.meeting_id = m.id AND pt.size_received >= pt.size_expected) AS parts_uploaded,
         (SELECT COUNT(*) FROM ai_meeting_parts pt WHERE pt.meeting_id = m.id AND pt.transcribed_at IS NOT NULL) AS parts_transcribed,
         (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = m.id AND i.status <> 'cancelled_in_meeting') AS items_total,
         (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = m.id AND i.status = 'approved') AS items_approved,
         (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = m.id AND i.status = 'rejected') AS items_rejected,
         (SELECT COUNT(*) FROM ai_meeting_items i WHERE i.meeting_id = m.id AND i.status = 'proposed') AS items_pending
    FROM ai_meetings m
    JOIN users u ON u.id = m.uploaded_by
    LEFT JOIN projects p ON p.id = m.project_id
    LEFT JOIN clients c ON c.id = m.client_id`;

const numeric = (r) => ({
  ...r,
  parts_uploaded: Number(r.parts_uploaded), parts_transcribed: Number(r.parts_transcribed),
  items_total: Number(r.items_total), items_approved: Number(r.items_approved),
  items_rejected: Number(r.items_rejected), items_pending: Number(r.items_pending),
});

router.use(requires('meeting_intelligence', 'view'));

// ------------------------------------------------------------------ config
router.get('/config', async (req, res) => ok(res, {
  speech_to_text: speechConfigured(),
  analysis: analysisConfigured(),
  recording_ext: RECORDING_EXT,
  transcript_ext: TRANSCRIPT_EXT,
  max_part_bytes: MAX_PART_BYTES,
  max_parts: MAX_PARTS,
  max_document_bytes: MAX_DOCUMENT_BYTES,
  max_chunk_bytes: MAX_CHUNK_BYTES,
  projects: await all(`SELECT id, name, client_id FROM projects WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name`, [req.auth.tenantId]),
  clients: await all(`SELECT id, name FROM clients WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY name`, [req.auth.tenantId]),
}));

// -------------------------------------------------------------------- list
router.get('/', async (req, res) => {
  const tab = String(req.query.tab || 'history');
  const filters = ['m.tenant_id = ?', 'm.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  const v = scope(req.auth);
  filters.push(v.where);
  params.push(...v.params);
  if (tab === 'processing') filters.push(`m.status IN ('uploading','queued','transcribing','analyzing','failed')`);
  if (tab === 'pending') filters.push(`m.status = 'review'`);
  const rows = await all(`${LIST_SELECT} WHERE ${filters.join(' AND ')} ORDER BY m.created_at DESC LIMIT 200`, params);
  return ok(res, rows.map(numeric));
});

// ----------------------------------------------------------------- upload
const partSchema = z.object({
  index: z.number().int().min(0).max(MAX_PARTS - 1),
  size: z.number().int().min(1),
  mime: z.string().max(80),
  offset_seconds: z.number().min(0).optional(),
});

const createSchema = z.object({
  title: z.string().trim().min(2).max(200),
  meeting_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).optional().nullable(),
  project_id: z.string().optional().nullable(),
  client_id: z.string().optional().nullable(),
  department: z.string().max(80).optional().nullable(),
  description: z.string().max(4000).optional().nullable(),
  source_kind: z.enum(['recording', 'transcript']),
  file_name: z.string().min(1).max(255),
  file_mime: z.string().max(120).optional().nullable(),
  file_size: z.number().int().min(1),
  file_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional().nullable(),
  duration_seconds: z.number().min(0).optional().nullable(),
  consent: z.literal(true, { message: 'Confirm you are authorised to use this recording and that participants agreed to it' }),
  allow_duplicate: z.boolean().optional(),
  parts: z.array(partSchema).min(1).max(MAX_PARTS),
});

router.post('/', requires('meeting_intelligence', 'create'), async (req, res) => {
  const body = validate(createSchema, req.body);
  const { tenantId, userId } = req.auth;
  const ext = extOf(body.file_name);

  if (body.source_kind === 'recording') {
    if (!RECORDING_EXT.includes(ext)) throw badRequest(`Recordings must be ${RECORDING_EXT.join(', ').toUpperCase()}`);
    // The browser extracts the audio and sends 16 kHz mono WAV parts.
    if (body.parts.some((p) => p.mime !== 'audio/wav' || p.size > MAX_PART_BYTES)) {
      throw badRequest('Each audio part must be WAV and under 24 MB - reload the page and upload again');
    }
  } else {
    if (!TRANSCRIPT_EXT.includes(ext)) throw badRequest(`Transcripts must be ${TRANSCRIPT_EXT.join(', ').toUpperCase()}`);
    if (body.parts.length !== 1 || body.parts[0].size > MAX_DOCUMENT_BYTES) {
      throw badRequest('Transcript files are limited to 10 MB');
    }
  }
  const indexes = body.parts.map((p) => p.index).sort((a, b) => a - b);
  if (indexes.some((n, i) => n !== i)) throw badRequest('Parts must be numbered 0, 1, 2…');

  for (const [col, table] of [['project_id', 'projects'], ['client_id', 'clients']]) {
    if (body[col] && !(await get(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL`, [body[col], tenantId]))) {
      throw badRequest(`Unknown ${col.replace('_id', '')}`);
    }
  }

  // Same file again? Say so before spending another transcription on it.
  if (body.file_sha256 && !body.allow_duplicate) {
    const dup = await get(
      `SELECT m.id, m.title, m.created_at, m.status, u.name AS uploaded_by_name FROM ai_meetings m JOIN users u ON u.id = m.uploaded_by
        WHERE m.tenant_id = ? AND m.file_sha256 = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1`,
      [tenantId, body.file_sha256],
    );
    if (dup) {
      throw new ApiError(409, 'duplicate_upload', `This file was already uploaded as "${dup.title}"`, { existing: dup });
    }
  }

  const id = uuid();
  const ts = nowIso();
  await tx(async () => {
    await run(
      `INSERT INTO ai_meetings (id, tenant_id, title, meeting_date, project_id, client_id, department, description, source_kind,
         file_name, file_mime, file_size, file_sha256, duration_seconds, consent_by, consent_at, status, parts_expected,
         uploaded_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'uploading', ?,?,?,?)`,
      [id, tenantId, body.title, body.meeting_date || null, body.project_id || null, body.client_id || null,
        body.department || null, body.description || null, body.source_kind, body.file_name, body.file_mime || null,
        body.file_size, body.file_sha256 || null, body.duration_seconds ?? null, userId, ts, body.parts.length, userId, ts, ts],
    );
    for (const p of body.parts) {
      // Not under attachments/ or documents/, so the generic /files route never serves it.
      const path = `meetings/${tenantId}/${id}/part-${p.index}`;
      await run(
        `INSERT INTO ai_meeting_parts (id, tenant_id, meeting_id, part_index, offset_seconds, mime, size_expected, storage_path, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
        [uuid(), tenantId, id, p.index, p.offset_seconds || 0, p.mime, p.size, path, ts],
      );
      await run(
        `INSERT INTO stored_files (path, mime, size_bytes, data, created_at) VALUES (?,?,0,?,?)
         ON CONFLICT (path) DO UPDATE SET size_bytes = 0, data = excluded.data`,
        [path, p.mime, Buffer.alloc(0), ts],
      );
    }
  });
  await audit(req, {
    entity: 'ai_meeting', entityId: id, action: 'create',
    after: { title: body.title, source_kind: body.source_kind, file_name: body.file_name, consent_by: userId, consent_at: ts },
  });
  return created(res, { id, status: 'uploading' });
});

/**
 * One chunk of one part, appended in order. `offset` must equal what the
 * server already holds, so a retried chunk is acknowledged, never appended twice.
 */
router.put('/:id/parts/:index',
  requires('meeting_intelligence', 'create'),
  express.raw({ type: 'application/octet-stream', limit: MAX_CHUNK_BYTES + 1024 }),
  async (req, res) => {
    const m = await meetingFor(req, req.params.id);
    if (m.uploaded_by !== req.auth.userId) throw forbidden('Only the person who started this upload can add to it');
    if (m.status !== 'uploading') throw badRequest('This meeting has finished uploading');
    const part = await get('SELECT * FROM ai_meeting_parts WHERE meeting_id = ? AND part_index = ?', [m.id, Number(req.params.index)]);
    if (!part) throw notFound('Part');
    const chunk = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const offset = Number(req.query.offset);
    if (!chunk.length) throw badRequest('Empty chunk');
    if (offset + chunk.length <= part.size_received) {
      return ok(res, { received: part.size_received, duplicate: true });
    }
    if (offset !== part.size_received) {
      throw new ApiError(409, 'offset_mismatch', 'Upload out of order', { expected: part.size_received });
    }
    if (part.size_received + chunk.length > part.size_expected) throw badRequest('More data than announced for this part');

    const appended = await run(
      `UPDATE ai_meeting_parts SET size_received = size_received + ? WHERE id = ? AND size_received = ?`,
      [chunk.length, part.id, offset],
    );
    if (!appended.changes) throw new ApiError(409, 'offset_mismatch', 'Upload out of order', { expected: part.size_received });
    await run('UPDATE stored_files SET data = data || ?, size_bytes = size_bytes + ? WHERE path = ?',
      [chunk, chunk.length, part.storage_path]);

    const pending = await get(
      'SELECT COUNT(*) AS n FROM ai_meeting_parts WHERE meeting_id = ? AND size_received < size_expected', [m.id],
    );
    if (Number(pending.n) === 0) {
      await run(`UPDATE ai_meetings SET status = 'queued', updated_at = ? WHERE id = ? AND status = 'uploading'`, [nowIso(), m.id]);
    }
    return ok(res, { received: offset + chunk.length, complete: Number(pending.n) === 0 });
  });

// ------------------------------------------------------------- processing
/** Runs the next processing step now (the page calls this while it is open). */
router.post('/:id/advance', async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  if (PROCESSING.includes(m.status) && m.status !== 'uploading') await advanceMeeting(m.id);
  return ok(res, await detail(req, m.id));
});

/** Book a follow-up the AI found but could not date: the reviewer picks the day and time. */
router.post('/:id/follow-ups/:fid/book', requires('meetings', 'create'), async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  const body = validate(z.object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a date like 2026-11-20'),
    time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Use a time like 15:30'),
  }), req.body);
  const own = await get('SELECT id FROM ai_meeting_followups WHERE id = ? AND ai_meeting_id = ?', [req.params.fid, m.id]);
  if (!own) throw notFound('Follow-up meeting');
  const r = await bookFollowUp({
    tenantId: req.auth.tenantId, followUpId: own.id, date: body.date, time: body.time,
    actor: { userId: req.auth.userId, name: req.auth.name },
  });
  if (r.error === 'past') throw badRequest('That time has already passed - choose a time from now on');
  if (r.error) throw badRequest('This follow-up is already on the calendar');
  await audit(req, { entity: 'meeting', entityId: r.meeting_id, action: 'create', after: { follow_up_of: m.id } });
  return ok(res, await detail(req, m.id));
});

router.post('/:id/retry', requires('meeting_intelligence', 'create'), async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  if (m.status !== 'failed') throw badRequest('Only a failed meeting can be retried');
  await retryMeeting(m);
  await audit(req, { entity: 'ai_meeting', entityId: m.id, action: 'update', after: { retried: m.failed_stage } });
  return ok(res, await detail(req, m.id));
});

// ----------------------------------------------------------------- detail
async function healApproving(meetingId) {
  // An approval interrupted between "claimed" and "recorded": the task either
  // exists (finish recording it) or does not (put the proposal back).
  const stuck = await all(
    `SELECT * FROM ai_meeting_items WHERE meeting_id = ? AND status = 'approving' AND updated_at < ?`,
    [meetingId, new Date(Date.now() - 2 * 60_000).toISOString()],
  );
  for (const it of stuck) {
    const made = await get('SELECT id FROM action_items WHERE source_type = ? AND source_id = ?', [SOURCE_TYPE, it.id]);
    await run(`UPDATE ai_meeting_items SET status = ?, action_item_id = ?, updated_at = ? WHERE id = ?`,
      [made ? 'approved' : 'proposed', made?.id || null, nowIso(), it.id]);
  }
}

async function detail(req, id) {
  const m = await meetingFor(req, id);
  await healApproving(m.id);
  const head = numeric(await get(`${LIST_SELECT} WHERE m.id = ?`, [m.id]));
  const items = await all(
    `SELECT i.*, u.name AS assignee_display, p.name AS project_name, c.name AS client_name,
            a.status AS task_status, d.name AS decided_by_name
       FROM ai_meeting_items i
       LEFT JOIN users u ON u.id = i.assignee_user_id
       LEFT JOIN projects p ON p.id = i.project_id
       LEFT JOIN clients c ON c.id = i.client_id
       LEFT JOIN action_items a ON a.id = i.action_item_id
       LEFT JOIN users d ON d.id = i.decided_by
      WHERE i.meeting_id = ? ORDER BY i.idx`, [m.id],
  );
  const staff = await staffOf(req.auth.tenantId);
  const eligible = new Set((await eligibleAssignees(req.auth)).map((p) => p.id));
  const byId = new Map(staff.map((p) => [p.id, p]));
  const transcript = parse(m.transcript_json, []);
  const speakers = parse(m.speakers_json, {});
  const labels = [...new Set(transcript.map((s) => s.speaker).filter(Boolean))];

  return {
    ...head,
    description: m.description,
    department: m.department,
    project_id: m.project_id,
    client_id: m.client_id,
    duration_seconds: m.duration_seconds,
    audio_purged_at: m.audio_purged_at,
    summary: parse(m.summary_json, null),
    // Recorded in AI Meetings: the meeting page (with its video) the timestamps link to.
    live_meeting_id: m.source_kind === 'live'
      ? (await get('SELECT id FROM meetings WHERE ai_meeting_id = ? AND tenant_id = ?', [m.id, m.tenant_id]))?.id || null
      : null,
    extras: parse(m.extras_json, null),
    follow_ups: await followUpsFor(m.id, m.tenant_id),
    transcript,
    speakers,
    speaker_labels: labels,
    staff: staff.map((p) => ({ ...p, assignable: eligible.has(p.id) })),
    can_approve: await can(req.auth, 'meeting_intelligence', 'approve'),
    items: items.map((it) => {
      const problems = itemProblems(it, eligible);
      return {
        ...it,
        candidates: parse(it.candidates_json, []).map((cid) => byId.get(cid)).filter(Boolean),
        evidence: parse(it.evidence_json, { segments: [], quote: '' }),
        assignee_assignable: it.assignee_user_id ? eligible.has(it.assignee_user_id) : false,
        problems,
        verified: it.status === 'proposed' && problems.length === 0,
      };
    }),
  };
}

router.get('/:id', async (req, res) => ok(res, await detail(req, req.params.id)));

// ----------------------------------------------------------------- review
/** Why a proposal cannot be approved as it stands. Empty = verified. */
function itemProblems(it, eligible) {
  const out = [];
  if (!it.title || it.title.trim().length < 2) out.push('Add a task title');
  if (it.assignee_status === 'ambiguous' && !it.assignee_user_id) out.push('Several people match this name - choose one');
  else if (it.assignee_status === 'speaker_unmapped' && !it.assignee_user_id) out.push('Say who this speaker is, or choose an assignee');
  else if (!it.assignee_user_id) out.push('Choose who this task is for');
  else if (!eligible.has(it.assignee_user_id)) out.push('You can only assign this to someone in your team');
  if (['ambiguous', 'needs_meeting_date'].includes(it.deadline_status)) {
    out.push(it.deadline_status === 'needs_meeting_date'
      ? 'The deadline was relative and the meeting date is unknown - set a date or clear it'
      : `The deadline "${it.deadline_text || 'unclear'}" is ambiguous - set a date or clear it`);
  }
  return out;
}

const editSchema = z.object({
  title: z.string().trim().min(2).max(240).optional(),
  description: z.string().max(8000).optional().nullable(),
  assignee_user_id: z.string().optional().nullable(),
  due_date: z.union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/), z.literal('')]).optional().nullable(),
  due_time: z.union([z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/), z.literal('')]).optional().nullable(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional().nullable(),
  project_id: z.string().optional().nullable(),
  client_id: z.string().optional().nullable(),
});

router.patch('/:id/items/:itemId', requires('meeting_intelligence', 'approve'), async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  const it = await get('SELECT * FROM ai_meeting_items WHERE id = ? AND meeting_id = ?', [req.params.itemId, m.id]);
  if (!it) throw notFound('Proposed task');
  if (it.status !== 'proposed') throw badRequest('This task has already been decided');
  const body = validate(editSchema, req.body);
  const patch = {};
  if (body.title !== undefined) patch.title = body.title;
  if (body.description !== undefined) patch.description = body.description || null;
  if (body.priority !== undefined) patch.priority = body.priority || null;
  if (body.assignee_user_id !== undefined) {
    if (body.assignee_user_id) {
      const allowed = (await eligibleAssignees(req.auth)).some((p) => p.id === body.assignee_user_id);
      if (!allowed) throw forbidden('You can only assign this to someone in your team');
      patch.assignee_user_id = body.assignee_user_id;
      patch.assignee_status = 'matched';
    } else {
      patch.assignee_user_id = null;
      patch.assignee_status = 'unassigned';
    }
    patch.candidates_json = null;
  }
  if (body.due_date !== undefined || body.due_time !== undefined) {
    const date = body.due_date !== undefined ? (body.due_date || null) : it.due_date;
    patch.due_date = date;
    patch.due_time = date ? (body.due_time !== undefined ? (body.due_time || null) : it.due_time) : null;
    // The reviewer has now decided the deadline - set, or explicitly none.
    patch.deadline_status = date ? 'resolved' : 'none';
  }
  for (const [col, table] of [['project_id', 'projects'], ['client_id', 'clients']]) {
    if (body[col] !== undefined) {
      if (body[col] && !(await get(`SELECT id FROM ${table} WHERE id = ? AND tenant_id = ?`, [body[col], req.auth.tenantId]))) {
        throw badRequest(`Unknown ${col.replace('_id', '')}`);
      }
      patch[col] = body[col] || null;
    }
  }
  const cols = Object.keys(patch);
  if (cols.length) {
    await run(
      `UPDATE ai_meeting_items SET ${cols.map((c) => `${c} = ?`).join(', ')}, reviewer_edited = 1, updated_at = ?
        WHERE id = ? AND status = 'proposed'`,
      [...cols.map((c) => patch[c]), nowIso(), it.id],
    );
    await audit(req, { entity: 'ai_meeting_item', entityId: it.id, action: 'update', before: it, after: patch });
  }
  return ok(res, await detail(req, m.id));
});

router.put('/:id/speakers', requires('meeting_intelligence', 'approve'), async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  const { speakers } = validate(z.object({ speakers: z.record(z.string(), z.string().nullable()) }), req.body);
  const clean = await applySpeakerMap(m, speakers);
  await audit(req, { entity: 'ai_meeting', entityId: m.id, action: 'update', after: { speakers: clean } });
  return ok(res, await detail(req, m.id));
});

async function maybeComplete(meetingId) {
  const left = await get(
    `SELECT COUNT(*) AS n FROM ai_meeting_items WHERE meeting_id = ? AND status IN ('proposed', 'approving')`, [meetingId],
  );
  if (Number(left.n) === 0) {
    await run(`UPDATE ai_meetings SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ? AND status = 'review'`,
      [nowIso(), nowIso(), meetingId]);
  }
}

const decisionSchema = z.object({
  item_ids: z.array(z.string()).max(200).optional(),
  all_verified: z.boolean().optional(),
  all: z.boolean().optional(),
  reason: z.string().max(500).optional(),
});

/**
 * Approve: each proposal is CLAIMED first (proposed -> approving, one row,
 * one winner), then created through createActionItem, then recorded. Two
 * reviewers clicking at once: one claim succeeds, the other is told it was
 * already decided. The unique index on action_items(source_id) backs it up.
 */
router.post('/:id/items/approve', requires('meeting_intelligence', 'approve'), async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  if (m.status !== 'review') throw badRequest('This meeting is not waiting for approval');
  const body = validate(decisionSchema, req.body);
  const eligible = new Set((await eligibleAssignees(req.auth)).map((p) => p.id));

  if (!body.all_verified && !body.item_ids?.length) throw badRequest('Choose at least one task to approve');
  let targets = await all(`SELECT * FROM ai_meeting_items WHERE meeting_id = ? AND status = 'proposed' ORDER BY idx`, [m.id]);
  const results = [];
  if (body.all_verified) {
    targets = targets.filter((it) => itemProblems(it, eligible).length === 0);
  } else {
    const open = new Set(targets.map((t) => t.id));
    for (const asked of body.item_ids) {
      if (!open.has(asked)) results.push({ id: asked, ok: false, error: 'Already decided' });
    }
    targets = targets.filter((it) => body.item_ids.includes(it.id));
  }

  for (const it of targets) {
    const problems = itemProblems(it, eligible);
    if (problems.length) { results.push({ id: it.id, ok: false, error: problems.join('; ') }); continue; }

    const claim = await run(
      `UPDATE ai_meeting_items SET status = 'approving', decided_by = ?, decided_at = ?, updated_at = ?
        WHERE id = ? AND meeting_id = ? AND status = 'proposed'`,
      [req.auth.userId, nowIso(), nowIso(), it.id, m.id],
    );
    if (!claim.changes) { results.push({ id: it.id, ok: false, error: 'Already decided by someone else' }); continue; }

    try {
      const task = validateTaskBody({
        title: it.title,
        description: it.description || undefined,
        owner_id: it.assignee_user_id,
        priority: it.priority || 'medium',
        due_date: it.due_date || '',
        due_time: it.due_date ? (it.due_time || '') : '',
        project_id: it.project_id || null,
        client_id: it.client_id || null,
      });
      // Set after validation: the public API refuses this source.
      task.source_type = SOURCE_TYPE;
      task.source_id = it.id;
      const row = await createActionItem(req, task, {
        notify: {
          eventKey: 'action_item.assigned_from_meeting',
          vars: {
            meeting_title: m.title,
            deadline_label: it.due_date ? formatDue(it.due_date, it.due_time) : (it.deadline_text ? `${it.deadline_text} (no date set)` : 'None set'),
          },
        },
      });
      await run(`UPDATE ai_meeting_items SET status = 'approved', action_item_id = ?, updated_at = ? WHERE id = ?`,
        [row.id, nowIso(), it.id]);
      await audit(req, { entity: 'ai_meeting_item', entityId: it.id, action: 'approve', after: { action_item_id: row.id, meeting_id: m.id } });
      results.push({ id: it.id, ok: true, action_item_id: row.id });
    } catch (err) {
      const existing = await get('SELECT id FROM action_items WHERE source_type = ? AND source_id = ?', [SOURCE_TYPE, it.id]);
      if (existing) {
        await run(`UPDATE ai_meeting_items SET status = 'approved', action_item_id = ?, updated_at = ? WHERE id = ?`,
          [existing.id, nowIso(), it.id]);
        results.push({ id: it.id, ok: true, action_item_id: existing.id });
        continue;
      }
      await run(`UPDATE ai_meeting_items SET status = 'proposed', decided_by = NULL, decided_at = NULL, updated_at = ? WHERE id = ?`,
        [nowIso(), it.id]);
      const detailMsg = err?.details?.map?.((d) => d.message).join('; ');
      results.push({ id: it.id, ok: false, error: detailMsg || err?.message || 'Could not create the task' });
    }
  }
  await maybeComplete(m.id);
  return ok(res, { results, meeting: await detail(req, m.id) });
});

router.post('/:id/items/reject', requires('meeting_intelligence', 'approve'), async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  if (m.status !== 'review') throw badRequest('This meeting is not waiting for approval');
  const body = validate(decisionSchema, req.body);
  const targets = await all(`SELECT id FROM ai_meeting_items WHERE meeting_id = ? AND status = 'proposed'`, [m.id]);
  const ids = body.all ? targets.map((t) => t.id) : targets.map((t) => t.id).filter((id) => (body.item_ids || []).includes(id));
  if (!ids.length) throw badRequest('Choose at least one task to reject');
  let n = 0;
  for (const id of ids) {
    const r = await run(
      `UPDATE ai_meeting_items SET status = 'rejected', decided_by = ?, decided_at = ?, reject_reason = ?, updated_at = ?
        WHERE id = ? AND status = 'proposed'`,
      [req.auth.userId, nowIso(), body.reason || null, nowIso(), id],
    );
    n += r.changes;
  }
  await audit(req, { entity: 'ai_meeting', entityId: m.id, action: 'reject', after: { rejected: n, reason: body.reason || null } });
  await maybeComplete(m.id);
  return ok(res, { rejected: n, meeting: await detail(req, m.id) });
});

router.delete('/:id', requires('meeting_intelligence', 'delete'), async (req, res) => {
  const m = await meetingFor(req, req.params.id);
  const parts = await all('SELECT storage_path FROM ai_meeting_parts WHERE meeting_id = ?', [m.id]);
  await tx(async () => {
    for (const p of parts) await run('DELETE FROM stored_files WHERE path = ?', [p.storage_path]);
    await run('UPDATE ai_meetings SET deleted_at = ?, transcript_json = NULL, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), m.id]);
  });
  await audit(req, { entity: 'ai_meeting', entityId: m.id, action: 'delete' });
  return ok(res, { ok: true });
});

export { router as meetingIntelRouter };
