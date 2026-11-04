/**
 * Phase 10: the failure cases from the meeting platform spec that other test
 * files do not already cover - many people joining at once, the host leaving,
 * a meeting ending unexpectedly, a recorder failing part-way, duplicate
 * invitations, another workspace, and a failed notification or audit write
 * during task approval.
 */
import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AccessToken, EgressStatus } from 'livekit-server-sdk';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

process.env.LIVEKIT_URL = 'wss://phoenixx-test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'APIresiliencekey';
process.env.LIVEKIT_API_SECRET = 'resilience-secret-that-is-long-enough-for-hmac-signing-0123';
process.env.RECORDING_S3_BUCKET = 'phoenixx-recordings';
process.env.RECORDING_S3_REGION = 'ap-south-1';
process.env.RECORDING_S3_ACCESS_KEY_ID = 'AKIATEST';
process.env.RECORDING_S3_SECRET_ACCESS_KEY = 'test-s3-secret';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const lk = await import('../src/services/livekit.js');
const store = await import('../src/services/objectStore.js');
const intel = await import('../src/services/meetingIntel.js');

const rooms = [];
let inRoom = [];
let n = 0;
lk.setLivekitForTests({
  roomClient: {
    createRoom: async (o) => { rooms.push(o.name); return o; },
    listParticipants: async () => inRoom,
    updateRoomMetadata: async () => {},
    deleteRoom: async () => {},
    listRooms: async () => [],
  },
  egressClient: {
    startRoomCompositeEgress: async () => ({ egressId: `EG_v${++n}`, status: EgressStatus.EGRESS_STARTING }),
    startTrackEgress: async (room, out, sid) => ({ egressId: `EG_t${++n}_${sid}`, status: EgressStatus.EGRESS_STARTING }),
    stopEgress: async (id) => ({ egressId: id, status: EgressStatus.EGRESS_ENDING }),
    listEgress: async ({ egressId }) => [{ egressId, status: EgressStatus.EGRESS_ACTIVE }],
  },
});
store.setObjectStoreForTests({ get: async () => Buffer.alloc(0), del: async () => {}, sign: async (k) => `https://signed.example/${k}` });
// Speech-to-text counts as set up; nothing in this file transcribes.
intel.setMeetingProvidersForTests({ transcribe: async () => [] });

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Resilience Co', email: 'owner@res.test', owner_name: 'Arun Prakash' });
async function join(name, email, role = 'employee', extra = {}, ownerToken = owner.access_token) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: ownerToken });
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  return { user: invite.body.data, token: accepted.body.data.access_token };
}
async function webhook(event) {
  const body = JSON.stringify(event);
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const res = await fetch(`${api.base}/livekit/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: await at.toJwt() }, body,
  });
  return res.status;
}
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
const roomOf = async (id) => (await db.get('SELECT room_name FROM meetings WHERE id = ?', [id])).room_name;
const mic = (sid) => ({ sid, source: 2, type: 0, muted: false });

let host; const team = [];
before(async () => {
  host = await join('Divya Ramesh', 'divya@res.test', 'manager', { department: 'Delivery' });
  for (let i = 1; i <= 8; i++) team.push(await join(`Member ${i}`, `member${i}@res.test`, 'employee', { manager_id: host.user.id, department: 'Delivery' }));
});

describe('many people joining at once', () => {
  let m;
  before(async () => {
    m = (await api.post('/ai-meetings/instant', { title: 'All hands', participant_ids: team.map((t) => t.user.id), transcription_allowed: true }, { token: host.token })).body.data;
  });

  test('eight join requests at the same moment all get their own token, and consent is recorded once each', async () => {
    const results = await Promise.all(team.map((t) => api.post(`/ai-meetings/${m.id}/join`, { consent: true }, { token: t.token })));
    assert.ok(results.every((r) => r.status === 200), results.map((r) => r.status).join(','));
    const identities = new Set(results.map((r) => claims(r.body.data.token).sub));
    assert.equal(identities.size, 8);
    assert.ok(results.every((r) => claims(r.body.data.token).video.room === results[0].body.data.room), 'one room for everyone');
    const consents = await db.all('SELECT DISTINCT user_id FROM meeting_consents WHERE meeting_id = ?', [m.id]);
    assert.equal(consents.length, 8);
  });

  test('their join webhooks arriving together (and some twice) give one attendance row each', async () => {
    const room = await roomOf(m.id);
    const events = team.map((t, i) => ({ event: 'participant_joined', room: { name: room }, participant: { sid: `PA_${i}`, identity: t.user.id } }));
    const statuses = await Promise.all([...events, ...events.slice(0, 4)].map(webhook));
    assert.ok(statuses.every((s) => s === 200));
    assert.equal(Number((await db.get('SELECT COUNT(*) AS c FROM meeting_participation WHERE meeting_id = ?', [m.id])).c), 8);
    const row = (await api.get(`/ai-meetings/${m.id}`, { token: host.token })).body.data;
    assert.equal(row.status, 'live');
    assert.equal(row.attended_count, 8);
  });
});

describe('the host leaving, and meetings ending unexpectedly', () => {
  let m; let room;
  before(async () => {
    m = (await api.post('/ai-meetings/instant', { title: 'Design review', participant_ids: [team[0].user.id] }, { token: host.token })).body.data;
    await api.post(`/ai-meetings/${m.id}/join`, {}, { token: host.token });
    room = await roomOf(m.id);
    await webhook({ event: 'participant_joined', room: { name: room }, participant: { sid: 'PH_1', identity: host.user.id } });
    await webhook({ event: 'participant_joined', room: { name: room }, participant: { sid: 'PM_1', identity: team[0].user.id } });
  });

  test('the host dropping out does not end the meeting, and they come back as host', async () => {
    await webhook({ event: 'participant_left', room: { name: room }, participant: { sid: 'PH_1', identity: host.user.id } });
    let row = (await api.get(`/ai-meetings/${m.id}`, { token: host.token })).body.data;
    assert.equal(row.status, 'live', 'the others carry on');
    assert.equal(row.attendance.find((a) => a.user_id === team[0].user.id).connected_now, true);
    const back = await api.post(`/ai-meetings/${m.id}/join`, {}, { token: host.token });
    assert.equal(back.status, 200);
    assert.equal(claims(back.body.data.token).video.roomAdmin, true, 'still the host');
    row = (await api.get(`/ai-meetings/${m.id}`, { token: host.token })).body.data;
    assert.equal(row.host_id, host.user.id);
  });

  test('the room closing on its own (everyone gone, or LiveKit ends it) completes the meeting and closes every connection', async () => {
    await db.run('UPDATE meetings SET capture_active = 1, captions_on = 1 WHERE id = ?', [m.id]);
    assert.equal(await webhook({ event: 'room_finished', room: { name: room } }), 200);
    const row = await db.get('SELECT * FROM meetings WHERE id = ?', [m.id]);
    assert.equal(row.status, 'completed');
    assert.ok(row.ended_at);
    assert.equal(row.capture_active, 0, 'recording is not left "on"');
    assert.equal(row.captions_on, 0);
    const open = await db.get('SELECT COUNT(*) AS c FROM meeting_participation WHERE meeting_id = ? AND left_at IS NULL', [m.id]);
    assert.equal(Number(open.c), 0);
    assert.equal((await api.post(`/ai-meetings/${m.id}/join`, {}, { token: team[0].token })).status, 400, 'an ended meeting cannot be rejoined');
  });
});

describe('a recorder failing part-way', () => {
  test('a failed microphone file is reported, the others still make the transcript, and a failed video says so', async () => {
    const m = (await api.post('/ai-meetings/instant', {
      title: 'Client sync', participant_ids: [team[1].user.id], recording_allowed: true, transcription_allowed: true,
    }, { token: host.token })).body.data;
    await api.post(`/ai-meetings/${m.id}/join`, { consent: true }, { token: host.token });
    await api.post(`/ai-meetings/${m.id}/join`, { consent: true }, { token: team[1].token });
    inRoom = [{ identity: host.user.id, tracks: [mic('TR_h')] }, { identity: team[1].user.id, tracks: [mic('TR_m')] }];
    assert.equal((await api.post(`/ai-meetings/${m.id}/capture/start`, {}, { token: host.token })).status, 200);
    const recs = await db.all('SELECT * FROM meeting_recordings WHERE meeting_id = ? ORDER BY kind, track_sid', [m.id]);
    const [audioH, audioM] = recs.filter((r) => r.kind === 'audio_track');
    const video = recs.find((r) => r.kind === 'video');
    const room = await roomOf(m.id);
    const ns = (ms) => String(BigInt(ms) * 1_000_000n);
    const t0 = Date.now() - 600_000;

    await api.post(`/ai-meetings/${m.id}/host/end`, {}, { token: host.token });
    await webhook({ event: 'egress_ended', egressInfo: { egressId: video.egress_id, roomName: room, status: 'EGRESS_FAILED', error: 'Chrome crashed' } });
    await webhook({ event: 'egress_ended', egressInfo: { egressId: audioM.egress_id, roomName: room, status: 'EGRESS_FAILED', error: 'upload failed' } });
    assert.equal((await db.get('SELECT ai_meeting_id FROM meetings WHERE id = ?', [m.id])).ai_meeting_id, null, 'still waiting for the last file');
    await webhook({
      event: 'egress_ended',
      egressInfo: { egressId: audioH.egress_id, roomName: room, status: 'EGRESS_COMPLETE', fileResults: [{ startedAt: ns(t0), duration: ns(300_000), size: '9000' }] },
    });

    const ai = (await db.get('SELECT ai_meeting_id FROM meetings WHERE id = ?', [m.id])).ai_meeting_id;
    assert.ok(ai, 'the transcript is made from the files that worked');
    const parts = await db.all('SELECT speaker_label FROM ai_meeting_parts WHERE meeting_id = ?', [ai]);
    assert.deepEqual(parts.map((p) => p.speaker_label), ['Divya Ramesh']);

    const rec = (await api.get(`/ai-meetings/${m.id}/recordings`, { token: host.token })).body.data.recordings;
    assert.equal(rec[0].status, 'failed');
    assert.equal(rec[0].error, 'Chrome crashed');
    assert.equal(rec[0].url, null, 'no link to a file that does not exist');
  });
});

describe('duplicate invitations', () => {
  test('inviting someone again, or through their department as well, gives one invitation and one notification', async () => {
    const m = (await api.post('/ai-meetings', {
      title: 'Planning', date: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10), time: '10:00', duration_minutes: 30,
      participant_ids: [team[2].user.id],
    }, { token: host.token })).body.data;
    await api.post(`/ai-meetings/${m.id}/invite`, { participant_ids: [team[2].user.id, team[2].user.id] }, { token: host.token });
    await Promise.all([
      api.post(`/ai-meetings/${m.id}/invite`, { departments: ['Delivery'] }, { token: host.token }),
      api.post(`/ai-meetings/${m.id}/invite`, { participant_ids: [team[2].user.id] }, { token: host.token }),
    ]);
    const rows = await db.all('SELECT user_id FROM meeting_attendees WHERE meeting_id = ? AND deleted_at IS NULL', [m.id]);
    assert.equal(rows.length, new Set(rows.map((r) => r.user_id)).size, 'nobody is on the list twice');
    assert.equal(rows.filter((r) => r.user_id === team[2].user.id).length, 1);
    const inApp = await db.all(
      "SELECT id FROM notifications WHERE user_id = ? AND event_key = 'meeting.invited' AND link LIKE ? AND channel = 'in_app'",
      [team[2].user.id, `%${m.id}%`],
    );
    assert.equal(inApp.length, 1, 'one invitation notification');
  });
});

describe('another workspace', () => {
  test('cannot see, join, read or approve anything here, even with the ids', async () => {
    const other = await signUpTenant(api, { agency_name: 'Other Co', email: 'owner@other.test', owner_name: 'Someone Else' });
    const m = (await api.post('/ai-meetings/instant', { title: 'Private', participant_ids: [team[3].user.id], transcription_allowed: true }, { token: host.token })).body.data;
    const t = { token: other.access_token };
    for (const path of [`/ai-meetings/${m.id}`, `/ai-meetings/${m.id}/record`, `/ai-meetings/${m.id}/recordings`]) {
      assert.equal((await api.get(path, t)).status, 404, path);
    }
    assert.equal((await api.post(`/ai-meetings/${m.id}/join`, { consent: true }, t)).status, 404);
    assert.equal((await api.post(`/ai-meetings/${m.id}/capture/start`, {}, t)).status, 404);
    assert.equal((await api.get(`/ai-meetings/link/${m.invite_token}`, t)).status, 404, 'the link does not cross workspaces');
    assert.ok(!(await api.get('/ai-meetings?tab=upcoming', t)).body.data.some((x) => x.id === m.id));
  });
});

describe('approval when a later step fails', () => {
  let ai; let items; let tenant;
  before(async () => {
    tenant = (await db.get('SELECT tenant_id FROM users WHERE id = ?', [host.user.id])).tenant_id;
    ai = crypto.randomUUID();
    const ts = new Date().toISOString();
    await db.run(
      `INSERT INTO ai_meetings (id, tenant_id, title, source_kind, consent_by, consent_at, status, uploaded_by, created_at, updated_at)
       VALUES (?,?,?,'transcript',?,?,'review',?,?,?)`, [ai, tenant, 'Ops sync', host.user.id, ts, host.user.id, ts, ts],
    );
    items = [];
    for (const [i, who] of [team[4], team[5]].entries()) {
      const id = crypto.randomUUID();
      items.push(id);
      await db.run(
        `INSERT INTO ai_meeting_items (id, tenant_id, meeting_id, idx, title, assignee_user_id, assignee_status, acceptance, deadline_status,
           confidence, status, evidence_json, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'matched','accepted','none','high','proposed','{}',?,?)`, [id, tenant, ai, i, `Task ${i + 1}`, who.user.id, ts, ts],
      );
    }
  });
  const tasksFor = async (itemId) => Number((await db.get("SELECT COUNT(*) AS c FROM action_items WHERE source_type = 'meeting_ai' AND source_id = ?", [itemId])).c);

  test('the notification failing does not stop the task, and approving again creates nothing', async () => {
    await db.exec(`CREATE OR REPLACE FUNCTION t_fail_notify() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'notification store down'; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER t_fail_notify BEFORE INSERT ON notifications FOR EACH ROW EXECUTE FUNCTION t_fail_notify();`);
    try {
      const res = await api.post(`/meeting-intel/${ai}/items/approve`, { item_ids: [items[0]] }, { token: host.token });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.data.results[0].ok, true, res.body.data.results[0].error);
    } finally {
      await db.exec('DROP TRIGGER IF EXISTS t_fail_notify ON notifications; DROP FUNCTION IF EXISTS t_fail_notify();');
    }
    assert.equal(await tasksFor(items[0]), 1);
    const again = await api.post(`/meeting-intel/${ai}/items/approve`, { item_ids: [items[0]] }, { token: host.token });
    assert.equal(again.body.data.results[0].ok, false);
    assert.equal(await tasksFor(items[0]), 1, 'still one task');
  });

  test('a failure after the task is saved is recovered: the item is approved with that task, never a second one', async (t) => {
    await db.exec(`CREATE OR REPLACE FUNCTION t_fail_audit() RETURNS trigger AS $$ BEGIN
        IF NEW.entity = 'action_item' THEN RAISE EXCEPTION 'audit store down'; END IF; RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER t_fail_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION t_fail_audit();`);
    let res;
    try {
      res = await api.post(`/meeting-intel/${ai}/items/approve`, { item_ids: [items[1]] }, { token: host.token });
    } finally {
      await db.exec('DROP TRIGGER IF EXISTS t_fail_audit ON audit_logs; DROP FUNCTION IF EXISTS t_fail_audit();');
    }
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const r = res.body.data.results[0];
    const count = await tasksFor(items[1]);
    // Either the whole approval rolled back (no task, item still open) or it recovered to the one task - never two, never a task with an open item.
    const item = await db.get('SELECT status, action_item_id FROM ai_meeting_items WHERE id = ?', [items[1]]);
    t.diagnostic(count === 1 ? 'outcome: recovered to the saved task' : 'outcome: rolled back, left open');
    if (count === 1) {
      assert.equal(r.ok, true);
      assert.equal(item.status, 'approved');
      assert.ok(item.action_item_id);
    } else {
      assert.equal(count, 0);
      assert.equal(r.ok, false);
      assert.equal(item.status, 'proposed', 'left open to approve again');
    }
    await api.post(`/meeting-intel/${ai}/items/approve`, { item_ids: [items[1]] }, { token: host.token });
    assert.equal(await tasksFor(items[1]), 1, 'after a retry there is exactly one task');
  });
});
