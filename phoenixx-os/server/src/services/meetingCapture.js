import { TrackSource, EgressStatus } from 'livekit-server-sdk';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { badRequest, ApiError } from '../lib/http.js';
import {
  livekitConfigured, listRoomParticipants, openRooms, setRoomMetadata, startVideoRecording, startTrackRecording, stopRecording, egressInfo,
} from './livekit.js';
import { recordingStorageConfigured, recordingKey, egressUpload, deleteObject, signedUrl } from './objectStore.js';
import { speechConfigured } from './meetingIntel.js';
import { tzOf } from './liveMeetings.js';

/**
 * Recording and transcription of live meetings (Phase 5).
 *
 *  - Nothing is captured unless the meeting was scheduled with recording or
 *    transcription allowed, everyone agreed when they joined, and the host
 *    presses Start. Everyone in the room sees that it is on.
 *  - Video: one LiveKit room-composite recording (MP4) per start.
 *  - Transcript: one audio file per microphone (track egress), so every line
 *    of the transcript has a known speaker instead of "Speaker A".
 *  - When the meeting ends and every file is written, the audio goes through
 *    the AI Meeting Intelligence pipeline (transcribe -> analyse -> proposals
 *    a manager approves) and is then deleted. Videos stay until deleted.
 */

export const CHUNK_SECONDS = 600; // speech-to-text gets ten minutes at a time

const STATUS = {
  [EgressStatus.EGRESS_STARTING]: 'starting',
  [EgressStatus.EGRESS_ACTIVE]: 'active',
  [EgressStatus.EGRESS_ENDING]: 'active',
  [EgressStatus.EGRESS_COMPLETE]: 'complete',
  [EgressStatus.EGRESS_LIMIT_REACHED]: 'complete', // stopped at a limit; the file up to then is written
  [EgressStatus.EGRESS_FAILED]: 'failed',
  [EgressStatus.EGRESS_ABORTED]: 'failed',
};
const nsToIso = (ns) => (ns && Number(ns) > 0 ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : null);

// --------------------------------------------------------------- availability
const notReady = () => (!livekitConfigured() ? 'Video meetings are not set up.'
  : !recordingStorageConfigured() ? 'Recording storage is not set up. An admin needs to add the S3 settings.' : null);

/** What this meeting may capture right now, and why not if it cannot. */
export function captureAvailability(m) {
  const base = notReady();
  const video = !m.recording_allowed ? 'Recording was not allowed when this meeting was scheduled.' : base;
  const transcript = !m.transcription_allowed ? 'Transcription was not allowed when this meeting was scheduled.'
    : base || (!speechConfigured() ? 'Speech-to-text is not set up (add GEMINI_API_KEY or OPENAI_API_KEY).' : null);
  return {
    video: { available: !video, reason: video || null },
    transcript: { available: !transcript, reason: transcript || null },
  };
}

export async function roomState(meetingId) {
  const m = await get('SELECT * FROM meetings WHERE id = ?', [meetingId]);
  return {
    meeting_id: m.id,
    tenant_id: m.tenant_id,
    locked: !!m.locked,
    recording: !!(m.capture_active && m.capture_video),
    transcribing: !!(m.capture_active && m.capture_audio),
    captions: !!m.captions_on,
  };
}

/** Everyone in the room sees the current state (lock, recording, captions) through room metadata. */
export async function publishRoomState(meetingId) {
  const m = await get('SELECT room_name FROM meetings WHERE id = ?', [meetingId]);
  const state = await roomState(meetingId);
  await setRoomMetadata(m.room_name, state).catch(() => {});
  return state;
}

// ------------------------------------------------------------------- consent
async function consented(meetingId, userId, { video, audio }) {
  const row = await get(
    `SELECT MAX(recording) AS rec, MAX(transcription) AS tr FROM meeting_consents WHERE meeting_id = ? AND user_id = ?`,
    [meetingId, userId],
  );
  return (!video || Number(row?.rec) === 1) && (!audio || Number(row?.tr) === 1);
}

/** People in the room (CRM users only; LiveKit's own recorder is not a person) who have not agreed. */
async function missingConsent(m, people, need) {
  const missing = [];
  for (const p of people) {
    const user = await get('SELECT id, name FROM users WHERE id = ? AND tenant_id = ?', [p.identity, m.tenant_id]);
    if (user && !(await consented(m.id, user.id, need))) missing.push(user.name);
  }
  return missing;
}

// ---------------------------------------------------------------- start / stop
const isMic = (t) => t && Number(t.source) === TrackSource.MICROPHONE;

async function captureTrack(m, participant, track) {
  const user = await get('SELECT id, name FROM users WHERE id = ? AND tenant_id = ?', [participant?.identity, m.tenant_id]);
  if (!user || !track?.sid) return null;
  if (!(await consented(m.id, user.id, { audio: true }))) return null; // never capture someone who did not agree
  const id = uuid();
  const key = recordingKey(m, 'audio', `${user.id}-${track.sid}.ogg`);
  const ts = nowIso();
  const claimed = await run(
    `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, kind, track_sid, participant_identity, user_id, speaker_name, s3_key,
       status, started_by, created_at, updated_at)
     VALUES (?,?,?,'audio_track',?,?,?,?,?,'starting',?,?,?) ON CONFLICT DO NOTHING`,
    [id, m.tenant_id, m.id, track.sid, user.id, user.id, user.name, key, m.host_id, ts, ts],
  );
  if (!claimed.changes) return null; // already being captured
  try {
    const info = await startTrackRecording(m.room_name, track.sid, key, egressUpload());
    await run('UPDATE meeting_recordings SET egress_id = ?, status = ?, updated_at = ? WHERE id = ?',
      [info.egressId, STATUS[info.status] || 'starting', nowIso(), id]);
  } catch (err) {
    await run(`UPDATE meeting_recordings SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
      [String(err?.cause?.message || err?.message).slice(0, 300), nowIso(), id]);
  }
  return id;
}

export async function startCapture(meetingId, byUserId) {
  const m = await get('SELECT * FROM meetings WHERE id = ?', [meetingId]);
  if (m.cancelled_at || ['completed', 'ended'].includes(m.status)) throw badRequest('This meeting is not running');
  if (m.capture_active) throw badRequest('Recording is already on');
  const avail = captureAvailability(m);
  const video = avail.video.available;
  const audio = avail.transcript.available;
  if (!video && !audio) {
    throw new ApiError(400, 'capture_unavailable', avail.video.reason || avail.transcript.reason || 'Recording is not available');
  }

  const people = await listRoomParticipants(m.room_name);
  const missing = await missingConsent(m, people, { video, audio });
  if (missing.length) {
    throw new ApiError(409, 'consent_missing',
      `${missing.join(', ')} ${missing.length > 1 ? 'have' : 'has'} not agreed to ${video ? 'recording' : 'transcription'}. They need to leave and rejoin to agree.`);
  }

  const claimed = await run(
    `UPDATE meetings SET capture_active = 1, capture_video = ?, capture_audio = ?, capture_started_at = COALESCE(capture_started_at, ?),
            updated_at = ? WHERE id = ? AND capture_active = 0`,
    [video ? 1 : 0, audio ? 1 : 0, nowIso(), nowIso(), m.id],
  );
  if (!claimed.changes) throw badRequest('Recording is already on');

  const problems = [];
  if (video) {
    const id = uuid();
    const ts = nowIso();
    const key = recordingKey(m, 'video', `${ts.replace(/[:.]/g, '-')}.mp4`);
    await run(
      `INSERT INTO meeting_recordings (id, tenant_id, meeting_id, kind, s3_key, status, started_by, created_at, updated_at)
       VALUES (?,?,?,'video',?,'starting',?,?,?)`, [id, m.tenant_id, m.id, key, byUserId, ts, ts],
    );
    try {
      const info = await startVideoRecording(m.room_name, key, egressUpload());
      await run('UPDATE meeting_recordings SET egress_id = ?, status = ?, updated_at = ? WHERE id = ?',
        [info.egressId, STATUS[info.status] || 'starting', nowIso(), id]);
    } catch (err) {
      problems.push('video');
      await run(`UPDATE meeting_recordings SET status = 'failed', error = ?, updated_at = ? WHERE id = ?`,
        [String(err?.cause?.message || err?.message).slice(0, 300), nowIso(), id]);
    }
  }
  if (audio) {
    for (const p of people) for (const t of p.tracks || []) if (isMic(t)) await captureTrack(m, p, t);
  }
  if (problems.length && !audio) {
    await run('UPDATE meetings SET capture_active = 0, updated_at = ? WHERE id = ?', [nowIso(), m.id]);
    await publishRoomState(m.id);
    throw new ApiError(503, 'video_unavailable', 'The recorder could not be started. Try again in a moment.');
  }
  const state = await publishRoomState(m.id);
  return { ...state, video_failed: problems.includes('video') };
}

export async function stopCapture(meetingId) {
  await run('UPDATE meetings SET capture_active = 0, updated_at = ? WHERE id = ?', [nowIso(), meetingId]);
  const running = await all(
    `SELECT id, egress_id FROM meeting_recordings WHERE meeting_id = ? AND status IN ('starting', 'active') AND egress_id IS NOT NULL`,
    [meetingId],
  );
  for (const r of running) {
    try {
      const info = await stopRecording(r.egress_id);
      if (info) await onEgressEvent(info);
    } catch (err) {
      // Already finished on LiveKit's side: the webhook or the sweep settles the row.
      console.error('[capture] stop failed', r.egress_id, err?.cause?.message || err?.message);
    }
  }
  return publishRoomState(meetingId);
}

export async function setCaptions(meetingId, on) {
  await run('UPDATE meetings SET captions_on = ?, updated_at = ? WHERE id = ?', [on ? 1 : 0, nowIso(), meetingId]);
  return publishRoomState(meetingId);
}

// ------------------------------------------------------------- webhook side
/** A microphone appeared while transcription is on: capture it too. */
export async function onTrackPublished(meeting, participant, track) {
  if (!isMic(track)) return;
  const m = await get('SELECT * FROM meetings WHERE id = ?', [meeting.id]);
  if (!m.capture_active || !m.capture_audio) return;
  await captureTrack(m, participant, track);
}

/** The room closed (everyone left, or the host ended it): capture is over. */
export async function onRoomClosed(meetingId) {
  await run('UPDATE meetings SET capture_active = 0, captions_on = 0 WHERE id = ?', [meetingId]);
  await queueTranscriptIfReady(meetingId);
}

/** egress_started / egress_updated / egress_ended, or a status read back from LiveKit. */
export async function onEgressEvent(info) {
  if (!info?.egressId) return { ignored: true };
  const row = await get('SELECT * FROM meeting_recordings WHERE egress_id = ?', [info.egressId]);
  if (!row) return { ignored: true };
  const status = STATUS[info.status] || row.status;
  // LiveKit reports the file in `fileResults` on some paths and in the `file` result on others
  // (listEgress returns the latter as result = { case: 'file', value }).
  const file = info.fileResults?.[0] || (info.result?.case === 'file' ? info.result.value : null) || info.file || null;
  await run(
    `UPDATE meeting_recordings SET status = ?, error = ?, file_started_at = COALESCE(?, file_started_at),
            file_ended_at = COALESCE(?, file_ended_at), duration_seconds = COALESCE(?, duration_seconds),
            size_bytes = COALESCE(?, size_bytes), updated_at = ? WHERE id = ?`,
    [status, info.error ? String(info.error).slice(0, 300) : null,
      nsToIso(file?.startedAt), nsToIso(file?.endedAt),
      file?.duration ? Number(file.duration) / 1e9 : null, file?.size ? Number(file.size) : null, nowIso(), row.id],
  );
  if (status === 'complete' || status === 'failed') await queueTranscriptIfReady(row.meeting_id);
  return { meeting_id: row.meeting_id, egress: info.egressId, status };
}

// ---------------------------------------------------------------- transcript
/**
 * When the meeting has ended and every microphone file is written, hand them
 * to AI Meeting Intelligence as one meeting: one part per ten minutes of each
 * person's audio, placed on the meeting's timeline, already labelled with who
 * was speaking. Runs once per meeting (claimed through meetings.ai_meeting_id).
 */
export async function queueTranscriptIfReady(meetingId) {
  const m = await get('SELECT * FROM meetings WHERE id = ?', [meetingId]);
  if (!m || m.ai_meeting_id || m.status !== 'completed') return null;
  const pending = await get(
    `SELECT COUNT(*) AS n FROM meeting_recordings WHERE meeting_id = ? AND kind = 'audio_track' AND status IN ('starting', 'active')`, [m.id],
  );
  if (Number(pending.n) > 0) return null;
  const files = await all(
    `SELECT * FROM meeting_recordings WHERE meeting_id = ? AND kind = 'audio_track' AND status = 'complete'
        AND deleted_at IS NULL AND purged_at IS NULL AND COALESCE(duration_seconds, 0) > 0
      ORDER BY file_started_at, created_at`, [m.id],
  );
  if (!files.length) return null;

  const aiId = uuid();
  const ts = nowIso();
  const claimed = await run('UPDATE meetings SET ai_meeting_id = ?, updated_at = ? WHERE id = ? AND ai_meeting_id IS NULL', [aiId, ts, m.id]);
  if (!claimed.changes) return null;

  // Speaker labels are names; two people with the same name stay apart.
  const labels = new Map();
  const used = new Map();
  for (const f of files) {
    if (labels.has(f.user_id)) continue;
    const base = f.speaker_name || 'Participant';
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    labels.set(f.user_id, n > 1 ? `${base} (${n})` : base);
  }
  const t0 = Math.min(...files.map((f) => Date.parse(f.file_started_at || f.created_at)));
  const parts = [];
  for (const f of files) {
    const startOffset = Math.max(0, (Date.parse(f.file_started_at || f.created_at) - t0) / 1000);
    const chunks = Math.max(1, Math.ceil(Number(f.duration_seconds) / CHUNK_SECONDS));
    for (let c = 0; c < chunks; c++) {
      parts.push({ f, c, offset: startOffset + c * CHUNK_SECONDS });
    }
  }
  const tz = await tzOf(m.tenant_id);
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(new Date(m.started_at || m.scheduled_at));

  await tx(async () => {
    await run(
      `INSERT INTO ai_meetings (id, tenant_id, title, meeting_date, project_id, client_id, department, description, source_kind,
         file_name, file_mime, file_size, consent_by, consent_at, status, parts_expected, speakers_json, uploaded_by, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,'live',?,'audio/ogg',?,?,?,'queued',?,?,?,?,?)`,
      [aiId, m.tenant_id, m.title, day, m.project_id || null, m.client_id || null, m.department || null, m.description || null,
        `${m.title} (live meeting)`.slice(0, 200), files.reduce((a, f) => a + Number(f.size_bytes || 0), 0),
        m.host_id, m.capture_started_at || ts, parts.length,
        JSON.stringify(Object.fromEntries([...labels].map(([uid, label]) => [label, uid]))), m.host_id, ts, ts],
    );
    let i = 0;
    for (const p of parts) {
      await run(
        `INSERT INTO ai_meeting_parts (id, tenant_id, meeting_id, part_index, offset_seconds, mime, size_expected, size_received,
           storage_path, speaker_label, speaker_user_id, created_at)
         VALUES (?,?,?,?,?,'audio/ogg',?,?,?,?,?,?)`,
        [uuid(), m.tenant_id, aiId, i++, p.offset, Number(p.f.size_bytes || 0), Number(p.f.size_bytes || 0),
          `s3:${p.f.s3_key}#${p.c}`, labels.get(p.f.user_id), p.f.user_id, ts],
      );
    }
  });
  return aiId;
}

/**
 * Cron safety net: webhooks can be lost. Reads back any recording that has
 * not reported in a while, then queues transcripts that are ready.
 */
export async function sweepCaptures() {
  if (!livekitConfigured()) return 0;
  const now = nowIso();

  // A meeting that recorded, whose room has closed on LiveKit, is over (the room_finished webhook may never have come).
  const running = await all(
    `SELECT DISTINCT m.id, m.room_name FROM meetings m JOIN meeting_recordings r ON r.meeting_id = m.id
      WHERE m.status IN ('scheduled', 'live') AND m.cancelled_at IS NULL AND m.room_name IS NOT NULL LIMIT 20`,
  );
  if (running.length) {
    try {
      const open = await openRooms(running.map((m) => m.room_name));
      for (const m of running) {
        if (open.has(m.room_name)) continue;
        await run(`UPDATE meetings SET status = 'completed', ended_at = COALESCE(ended_at, ?), updated_at = ? WHERE id = ? AND status IN ('scheduled', 'live')`,
          [now, now, m.id]);
        await run('UPDATE meeting_participation SET left_at = ? WHERE meeting_id = ? AND left_at IS NULL', [now, m.id]);
        await onRoomClosed(m.id);
      }
    } catch { /* video service unreachable: next tick */ }
  }

  // Recorders that have not reported: ten minutes while the meeting runs, one minute once it has ended.
  const stale = new Date(Date.now() - 10 * 60_000).toISOString();
  const soon = new Date(Date.now() - 60_000).toISOString();
  const rows = await all(
    `SELECT r.* FROM meeting_recordings r JOIN meetings m ON m.id = r.meeting_id
      WHERE r.status IN ('starting', 'active') AND (r.updated_at < ? OR (m.status = 'completed' AND r.updated_at < ?))
      ORDER BY r.updated_at LIMIT 20`, [stale, soon],
  );
  for (const r of rows) {
    if (!r.egress_id) {
      await run(`UPDATE meeting_recordings SET status = 'failed', error = 'The recorder never started', updated_at = ? WHERE id = ?`, [nowIso(), r.id]);
      continue;
    }
    try {
      const info = await egressInfo(r.egress_id);
      if (info) await onEgressEvent(info);
      else await run(`UPDATE meeting_recordings SET status = 'failed', error = 'Not found on the video service', updated_at = ? WHERE id = ?`, [nowIso(), r.id]);
    } catch { /* try again next tick */ }
  }
  const ready = await all(
    `SELECT DISTINCT m.id FROM meetings m JOIN meeting_recordings r ON r.meeting_id = m.id AND r.kind = 'audio_track'
      WHERE m.status = 'completed' AND m.ai_meeting_id IS NULL LIMIT 20`,
  );
  for (const { id } of ready) await queueTranscriptIfReady(id);
  return rows.length;
}

// ---------------------------------------------------------------- playback
export async function listRoomRecordings(meetingId) {
  const rows = await all(
    `SELECT r.id, r.kind, r.status, r.error, r.duration_seconds, r.size_bytes, r.file_started_at, r.created_at, r.s3_key, u.name AS started_by_name
       FROM meeting_recordings r LEFT JOIN users u ON u.id = r.started_by
      WHERE r.meeting_id = ? AND r.kind = 'video' AND r.deleted_at IS NULL ORDER BY r.created_at`, [meetingId],
  );
  const out = [];
  for (const r of rows) {
    const { s3_key: key, ...rest } = r;
    out.push({
      ...rest,
      url: r.status === 'complete' && recordingStorageConfigured()
        ? await signedUrl(key, { fileName: `recording-${String(r.file_started_at || r.created_at).slice(0, 16).replace(/[:T]/g, '-')}.mp4` })
        : null,
    });
  }
  return out;
}

export async function deleteRecording(meetingId, recordingId, userId) {
  const r = await get(`SELECT * FROM meeting_recordings WHERE id = ? AND meeting_id = ? AND deleted_at IS NULL`, [recordingId, meetingId]);
  if (!r) return null;
  if (['starting', 'active'].includes(r.status)) throw badRequest('Stop the recording before deleting it');
  if (r.status === 'complete') await deleteObject(r.s3_key);
  await run('UPDATE meeting_recordings SET deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ?', [nowIso(), userId, nowIso(), r.id]);
  return r;
}
