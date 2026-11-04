import {
  AccessToken, RoomServiceClient, WebhookReceiver, EgressClient,
  EncodedFileOutput, EncodedFileType, DirectFileOutput, S3Upload,
} from 'livekit-server-sdk';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { config } from '../config.js';
import { KIND } from './liveMeetings.js';
import { onTrackPublished, onEgressEvent, onRoomClosed } from './meetingCapture.js';

/**
 * LiveKit: the video and audio for AI Meetings run on LiveKit (Cloud), never
 * through this server. This module does the three things the server must:
 *
 *  - issue short-lived join tokens, after the CRM has decided the person may
 *    join (identity = their user id, so every participant is a known account);
 *  - make sure the room exists with sensible limits;
 *  - turn LiveKit's signed webhooks into meeting status and attendance.
 *
 * The API key and secret stay here. The browser only ever sees a token that
 * admits one person to one room for a few minutes (LiveKit refreshes it for
 * as long as they stay connected).
 */

export const livekitConfigured = () => !!(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);

/** The REST address for the same project: wss://x -> https://x. */
const httpUrl = () => config.livekit.url.replace(/^ws(s?):\/\//, 'http$1://');

let roomClient;
let receiver;
let egressClient;
function egress() {
  if (!egressClient) egressClient = new EgressClient(httpUrl(), config.livekit.apiKey, config.livekit.apiSecret);
  return egressClient;
}
function rooms() {
  if (!roomClient) roomClient = new RoomServiceClient(httpUrl(), config.livekit.apiKey, config.livekit.apiSecret);
  return roomClient;
}
export function webhooks() {
  if (!receiver) receiver = new WebhookReceiver(config.livekit.apiKey, config.livekit.apiSecret);
  return receiver;
}

/** Tests only. */
export function setLivekitForTests({ roomClient: r, receiver: w, egressClient: e } = {}) {
  roomClient = r;
  receiver = w;
  egressClient = e;
}

export class VideoUnavailable extends Error {}

/**
 * Creates the room if it is not there yet (creating an existing room returns
 * it). An empty room closes 5 minutes after the last person leaves.
 */
export async function ensureRoom(meeting) {
  try {
    await rooms().createRoom({
      name: meeting.room_name,
      emptyTimeout: 5 * 60,
      departureTimeout: 2 * 60,
      maxParticipants: 100,
      metadata: JSON.stringify({ meeting_id: meeting.id, tenant_id: meeting.tenant_id, locked: !!meeting.locked }),
    });
  } catch (err) {
    console.error('[livekit] createRoom failed', err?.message);
    throw new VideoUnavailable('The video service could not be reached. Try again in a moment.');
  }
}

export async function joinToken({ meeting, user, isHost }) {
  const at = new AccessToken(config.livekit.apiKey, config.livekit.apiSecret, {
    identity: user.id,
    name: user.name,
    ttl: '10m',
    metadata: JSON.stringify({
      user_id: user.id,
      role: isHost ? 'host' : 'participant',
      designation: user.designation || null,
      department: user.department || null,
      avatar_url: user.avatar_url || null,
    }),
  });
  at.addGrant({
    roomJoin: true,
    room: meeting.room_name,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canUpdateOwnMetadata: true,
    // Host powers on the LiveKit side; the CRM checks host status again before
    // acting on anyone else (mute, remove, end - Phase 4).
    roomAdmin: !!isHost,
  });
  return at.toJwt();
}

// ------------------------------------------------------------ host controls
/** LiveKit calls made on the host's behalf, after the CRM has checked they are the host. */
async function call(fn) {
  try { return await fn(); } catch (err) {
    console.error('[livekit] host control failed', err?.message);
    const e = new VideoUnavailable('The video service did not accept that. Try again in a moment.');
    e.cause = err;
    throw e;
  }
}

export const listRoomParticipants = (room) => call(() => rooms().listParticipants(room));
/** Which of these rooms are open on LiveKit right now. */
export const openRooms = async (names) => new Set((await call(() => rooms().listRooms(names))).map((r) => r.name));

const SOURCES = { microphone: 2, camera: 1, screen_share: 3 }; // livekit TrackSource values

/** Mutes one participant's microphone (or camera / screen share). LiveKit lets a host mute, never unmute. */
export async function muteParticipant(room, identity, source = 'microphone') {
  const people = await listRoomParticipants(room);
  const person = people.find((x) => x.identity === identity);
  if (!person) return { muted: 0 };
  const tracks = (person.tracks || []).filter((t) => t.source === SOURCES[source] && !t.muted);
  for (const t of tracks) await call(() => rooms().mutePublishedTrack(room, identity, t.sid, true));
  return { muted: tracks.length };
}

export const removeFromRoom = (room, identity) => call(() => rooms().removeParticipant(room, identity));
export const closeRoom = (room) => call(() => rooms().deleteRoom(room));
/** Room metadata is what everyone in the room sees live (used for the locked flag). */
export const setRoomMetadata = (room, md) => call(() => rooms().updateRoomMetadata(room, JSON.stringify(md)));
export const updateInRoom = (room, identity, options) => call(() => rooms().updateParticipant(room, identity, options));

// ---------------------------------------------------------------- egress
/**
 * Egress runs inside LiveKit (Cloud): it joins the room as a hidden recorder
 * and uploads straight to object storage. These only start and stop it.
 */
export const startVideoRecording = (room, filepath, s3) => call(() => egress().startRoomCompositeEgress(room,
  new EncodedFileOutput({ fileType: EncodedFileType.MP4, filepath, output: { case: 's3', value: new S3Upload(s3) } }),
  { layout: 'speaker' }));

/** One microphone track, as it was sent (Ogg Opus), for a transcript with a known speaker. */
export const startTrackRecording = (room, trackSid, filepath, s3) => call(() => egress().startTrackEgress(room,
  new DirectFileOutput({ filepath, output: { case: 's3', value: new S3Upload(s3) } }), trackSid));

export const stopRecording = (egressId) => call(() => egress().stopEgress(egressId));
export const egressInfo = async (egressId) => (await call(() => egress().listEgress({ egressId })))[0] || null;

// ----------------------------------------------------------------- webhooks
async function meetingByRoom(name) {
  return name ? get('SELECT * FROM meetings WHERE room_name = ? AND kind = ?', [name, KIND]) : undefined;
}

/**
 * Applies one verified webhook event. Every branch is safe to run twice:
 * LiveKit retries deliveries, and events can arrive out of order.
 */
export async function applyWebhook(event) {
  if (/^egress_/.test(event.event)) return onEgressEvent(event.egressInfo);
  const m = await meetingByRoom(event.room?.name);
  if (!m) return { ignored: true };
  const at = event.createdAt ? new Date(Number(event.createdAt) * 1000).toISOString() : nowIso();

  switch (event.event) {
    case 'room_started':
      await run(`UPDATE meetings SET status = 'live', started_at = COALESCE(started_at, ?), updated_at = ?
                  WHERE id = ? AND status = 'scheduled'`, [at, nowIso(), m.id]);
      break;
    case 'room_finished':
      await run(`UPDATE meetings SET status = 'completed', ended_at = COALESCE(ended_at, ?), updated_at = ?
                  WHERE id = ? AND status IN ('live', 'scheduled')`, [at, nowIso(), m.id]);
      await run('UPDATE meeting_participation SET left_at = ? WHERE meeting_id = ? AND left_at IS NULL', [at, m.id]);
      await onRoomClosed(m.id);
      break;
    case 'track_published':
      await onTrackPublished(m, event.participant, event.track);
      break;
    case 'participant_joined': {
      const p = event.participant;
      if (!p?.sid) break;
      const user = await get('SELECT id FROM users WHERE id = ? AND tenant_id = ?', [p.identity, m.tenant_id]);
      await run(
        `INSERT INTO meeting_participation (id, tenant_id, meeting_id, user_id, participant_sid, joined_at)
         VALUES (?,?,?,?,?,?) ON CONFLICT (meeting_id, participant_sid) DO NOTHING`,
        [uuid(), m.tenant_id, m.id, user?.id || null, p.sid, at],
      );
      if (user) {
        await run('UPDATE meeting_attendees SET attended = 1 WHERE meeting_id = ? AND user_id = ? AND deleted_at IS NULL', [m.id, user.id]);
      }
      await run(`UPDATE meetings SET status = 'live', started_at = COALESCE(started_at, ?), updated_at = ?
                  WHERE id = ? AND status = 'scheduled'`, [at, nowIso(), m.id]);
      break;
    }
    case 'participant_left':
    case 'participant_connection_aborted':
      if (event.participant?.sid) {
        await run('UPDATE meeting_participation SET left_at = ? WHERE meeting_id = ? AND participant_sid = ? AND left_at IS NULL',
          [at, m.id, event.participant.sid]);
      }
      break;
    default:
      return { ignored: true };
  }
  return { meeting_id: m.id, event: event.event };
}

/** Attendance for the meeting page: everyone who connected, with total time in the room. */
export async function attendance(meetingId) {
  const rows = await all(
    `SELECT p.user_id, u.name, MIN(p.joined_at) AS first_joined, MAX(COALESCE(p.left_at, ?)) AS last_seen,
            COUNT(*) AS connections, SUM(CASE WHEN p.left_at IS NULL THEN 1 ELSE 0 END) AS connected_now
       FROM meeting_participation p LEFT JOIN users u ON u.id = p.user_id
      WHERE p.meeting_id = ? GROUP BY p.user_id, u.name ORDER BY MIN(p.joined_at)`,
    [nowIso(), meetingId],
  );
  const spans = await all('SELECT user_id, joined_at, left_at FROM meeting_participation WHERE meeting_id = ?', [meetingId]);
  return rows.map((r) => ({
    ...r,
    connections: Number(r.connections),
    connected_now: Number(r.connected_now) > 0,
    minutes: Math.round(spans.filter((s) => s.user_id === r.user_id)
      .reduce((a, s) => a + (Date.parse(s.left_at || nowIso()) - Date.parse(s.joined_at)), 0) / 60_000),
  }));
}
