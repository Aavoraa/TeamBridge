import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AccessToken } from 'livekit-server-sdk';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

// LiveKit settings are read when the config loads, so they are set first.
process.env.LIVEKIT_URL = 'wss://phoenixx-test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'APItestkey';
process.env.LIVEKIT_API_SECRET = 'test-secret-that-is-long-enough-for-hmac-signing-0123456789';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const lk = await import('../src/services/livekit.js');

// No network: the room service is a stand-in; webhooks use the real verifier.
const created = [];
let roomFails = false;
const calls = [];
let inRoom = [];
lk.setLivekitForTests({
  roomClient: {
    createRoom: async (opts) => { if (roomFails) throw new Error('connect ECONNREFUSED'); created.push(opts); return opts; },
    listParticipants: async () => inRoom,
    mutePublishedTrack: async (room, identity, sid, muted) => { calls.push(['mute', room, identity, sid, muted]); },
    removeParticipant: async (room, identity) => { calls.push(['remove', room, identity]); },
    deleteRoom: async (room) => { calls.push(['delete', room]); },
    updateParticipant: async (room, identity, opts) => { calls.push(['update', room, identity, opts]); },
    updateRoomMetadata: async (room, md) => { calls.push(['room-meta', room, JSON.parse(md)]); },
  },
});

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Room Co', email: 'owner@room.test', owner_name: 'Arun Prakash' });
async function join(name, email, role = 'employee', extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: owner.access_token });
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

const day = (n) => new Date(Date.now() + n * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);
const claims = (jwt) => JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

async function signedWebhook(event) {
  const body = JSON.stringify(event);
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const res = await fetch(`${api.base}/livekit/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/webhook+json', Authorization: await at.toJwt() },
    body,
  });
  return { status: res.status, body: await res.json() };
}

let host; let guest; let outsider; let meeting;
before(async () => {
  host = await join('Divya Ramesh', 'divya@room.test', 'manager');
  guest = await join('Priya Raman', 'priya@room.test', 'employee', { designation: 'Designer', department: 'Delivery' });
  outsider = await join('Kavya Nair', 'kavya@room.test', 'employee');
  const res = await api.post('/ai-meetings/instant', { title: 'Design sync', participant_ids: [guest.user.id] }, { token: host.token });
  meeting = res.body.data;
});

describe('joining', () => {
  test('the host gets a short-lived token for this room only, with host powers', async () => {
    const res = await api.post(`/ai-meetings/${meeting.id}/join`, {}, { token: host.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const c = claims(res.body.data.token);
    assert.equal(c.sub, host.user.id, 'identity is the CRM user id');
    assert.equal(c.name, 'Divya Ramesh');
    assert.equal(c.video.room, created[0].name);
    assert.equal(c.video.roomJoin, true);
    assert.equal(c.video.roomAdmin, true);
    assert.ok(c.exp - c.nbf <= 600, 'valid for ten minutes at most');
    assert.ok(c.exp - Math.floor(Date.now() / 1000) <= 600);
    assert.equal(res.body.data.server_url, 'wss://phoenixx-test.livekit.cloud');
    assert.ok(!JSON.stringify(res.body).includes(process.env.LIVEKIT_API_SECRET), 'the secret never leaves the server');
    assert.equal(created[0].emptyTimeout, 300);
  });

  test('an invitee joins without host powers, carrying their role and department', async () => {
    const res = await api.post(`/ai-meetings/${meeting.id}/join`, {}, { token: guest.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const c = claims(res.body.data.token);
    assert.equal(c.video.roomAdmin, false);
    assert.deepEqual(JSON.parse(c.metadata), { user_id: guest.user.id, role: 'participant', designation: 'Designer', department: 'Delivery', avatar_url: null });
  });

  test('someone not on the meeting is refused, even in the same workspace', async () => {
    const res = await api.post(`/ai-meetings/${meeting.id}/join`, {}, { token: outsider.token });
    assert.equal(res.status, 404);
  });

  test('opening the workspace link first lets them in', async () => {
    assert.equal((await api.get(`/ai-meetings/link/${meeting.invite_token}`, { token: outsider.token })).status, 200);
    assert.equal((await api.post(`/ai-meetings/${meeting.id}/join`, {}, { token: outsider.token })).status, 200);
  });

  test('if the video service cannot be reached, the user is told and nothing breaks', async () => {
    roomFails = true;
    const res = await api.post(`/ai-meetings/${meeting.id}/join`, {}, { token: guest.token });
    roomFails = false;
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'video_unavailable');
  });
});

describe('consent and timing', () => {
  let recorded;
  before(async () => {
    const res = await api.post('/ai-meetings', {
      title: 'Client review', date: day(0), time: '23:59', duration_minutes: 30,
      participant_ids: [guest.user.id], transcription_allowed: true,
    }, { token: host.token });
    recorded = res.body.data;
  });

  test('a meeting that may be transcribed needs consent before a token is issued', async () => {
    // Too early for a guest unless it is within 15 minutes; the host may open an hour ahead.
    const early = await api.post(`/ai-meetings/${recorded.id}/join`, { consent: true }, { token: guest.token });
    if (Date.parse(recorded.scheduled_at) - Date.now() > 15 * 60_000) {
      assert.equal(early.status, 400);
      assert.match(early.body.error.message, /opens 15 minutes before/);
    }
    // Move it to now so the consent rule is what is being tested.
    await db.run('UPDATE meetings SET scheduled_at = ? WHERE id = ?', [new Date().toISOString(), recorded.id]);
    const noConsent = await api.post(`/ai-meetings/${recorded.id}/join`, {}, { token: guest.token });
    assert.equal(noConsent.status, 412);
    assert.equal(noConsent.body.error.code, 'consent_required');
    const ok = await api.post(`/ai-meetings/${recorded.id}/join`, { consent: true }, { token: guest.token });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    const row = await db.get('SELECT * FROM meeting_consents WHERE meeting_id = ? AND user_id = ?', [recorded.id, guest.user.id]);
    assert.equal(row.transcription, 1);
    assert.equal(row.recording, 0);
    assert.ok(row.given_at);
  });

  test('a cancelled meeting cannot be joined', async () => {
    const res = await api.post('/ai-meetings', { title: 'Off', date: day(3), time: '10:00', duration_minutes: 30 }, { token: host.token });
    await api.post(`/ai-meetings/${res.body.data.id}/cancel`, {}, { token: host.token });
    assert.equal((await api.post(`/ai-meetings/${res.body.data.id}/join`, {}, { token: host.token })).status, 400);
  });
});

describe('webhooks', () => {
  test('an unsigned or tampered webhook is refused', async () => {
    const res = await fetch(`${api.base}/livekit/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/webhook+json' }, body: JSON.stringify({ event: 'room_finished' }),
    });
    assert.equal(res.status, 401);
    const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
    at.sha256 = crypto.createHash('sha256').update('something else').digest('base64');
    const tampered = await fetch(`${api.base}/livekit/webhook`, {
      method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: await at.toJwt() },
      body: JSON.stringify({ event: 'room_finished', room: { name: created[0].name } }),
    });
    assert.equal(tampered.status, 401);
  });

  test('room started, people joining and leaving, room finished: status and attendance follow', async () => {
    const room = created[0].name;
    const t = Math.floor(Date.now() / 1000);
    assert.equal((await signedWebhook({ event: 'room_started', room: { name: room }, createdAt: String(t) })).status, 200);
    await signedWebhook({ event: 'participant_joined', room: { name: room }, participant: { sid: 'PA_1', identity: host.user.id }, createdAt: String(t) });
    await signedWebhook({ event: 'participant_joined', room: { name: room }, participant: { sid: 'PA_2', identity: guest.user.id }, createdAt: String(t + 5) });
    // LiveKit retries: the same join twice is still one connection.
    await signedWebhook({ event: 'participant_joined', room: { name: room }, participant: { sid: 'PA_2', identity: guest.user.id }, createdAt: String(t + 5) });

    let m = (await api.get(`/ai-meetings/${meeting.id}`, { token: host.token })).body.data;
    assert.equal(m.status, 'live');
    assert.equal(m.attendance.length, 2);
    assert.ok(m.attendance.every((a) => a.connected_now));

    await signedWebhook({ event: 'participant_left', room: { name: room }, participant: { sid: 'PA_2', identity: guest.user.id }, createdAt: String(t + 65) });
    // A reconnect is a new connection for the same person.
    await signedWebhook({ event: 'participant_joined', room: { name: room }, participant: { sid: 'PA_3', identity: guest.user.id }, createdAt: String(t + 70) });
    await signedWebhook({ event: 'room_finished', room: { name: room }, createdAt: String(t + 600) });

    m = (await api.get(`/ai-meetings/${meeting.id}`, { token: host.token })).body.data;
    assert.equal(m.status, 'completed');
    assert.ok(m.ended_at);
    const priya = m.attendance.find((a) => a.user_id === guest.user.id);
    assert.equal(priya.connections, 2);
    assert.equal(priya.connected_now, false);
    assert.equal(priya.minutes, 10, '1 minute, then 8:50 after reconnecting');
    assert.equal(m.attended_count, 2);
    assert.equal((await api.post(`/ai-meetings/${meeting.id}/join`, {}, { token: guest.token })).status, 400, 'an ended meeting cannot be rejoined');
  });

  test('webhooks for rooms that are not CRM meetings are ignored', async () => {
    const res = await signedWebhook({ event: 'room_started', room: { name: 'someone-elses-room' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.ignored, true);
  });
});

describe('host controls', () => {
  let live; let room;
  before(async () => {
    const res = await api.post('/ai-meetings/instant', { title: 'Standup', participant_ids: [guest.user.id, outsider.user.id] }, { token: host.token });
    live = res.body.data;
    await api.post(`/ai-meetings/${live.id}/join`, {}, { token: host.token });
    room = created.at(-1).name;
    inRoom = [
      { identity: host.user.id, metadata: JSON.stringify({ role: 'host' }), tracks: [] },
      { identity: guest.user.id, metadata: JSON.stringify({ role: 'participant' }), tracks: [{ sid: 'TR_mic', source: 2, muted: false }, { sid: 'TR_cam', source: 1, muted: false }] },
    ];
  });
  const hostCall = (action, body, token = host.token) => api.post(`/ai-meetings/${live.id}/host/${action}`, body, { token });
  const joinAs = (who) => api.post(`/ai-meetings/${live.id}/join`, {}, { token: who.token });

  test('only the host (or the workspace owner) can use host controls', async () => {
    const before = calls.length;
    for (const [action, body] of [['mute', { identity: host.user.id }], ['remove', { identity: host.user.id }], ['lock', { locked: true }], ['end', {}], ['transfer', { user_id: guest.user.id }], ['allow', { identity: guest.user.id }]]) {
      assert.equal((await hostCall(action, body, guest.token)).status, 403, action);
    }
    assert.equal(calls.length, before, 'nothing reached the video service');
  });

  test('mute turns off only the microphone track', async () => {
    const res = await hostCall('mute', { identity: guest.user.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.muted, 1);
    assert.deepEqual(calls.at(-1), ['mute', room, guest.user.id, 'TR_mic', true]);
  });

  test('lowering a hand clears the attribute', async () => {
    assert.equal((await hostCall('lower-hand', { identity: guest.user.id })).status, 200);
    assert.deepEqual(calls.at(-1), ['update', room, guest.user.id, { attributes: { hand: '' } }]);
  });

  test('a locked meeting keeps new people out, but the host still gets in', async () => {
    assert.equal((await hostCall('lock', { locked: true })).status, 200);
    const [kind, toRoom, md] = calls.at(-1);
    assert.deepEqual([kind, toRoom, md.meeting_id, md.locked], ['room-meta', room, live.id, true], 'everyone in the room is told');
    assert.ok(md.tenant_id, 'room metadata keeps the workspace');
    const refused = await joinAs(outsider);
    assert.equal(refused.status, 423);
    assert.equal(refused.body.error.code, 'meeting_locked');
    const hostJoin = await joinAs(host);
    assert.equal(hostJoin.status, 200);
    assert.equal(hostJoin.body.data.meeting.locked, true, 'the room shows it is locked');
    assert.equal((await hostCall('lock', { locked: false })).status, 200);
    assert.equal((await joinAs(outsider)).status, 200);
  });

  test('a removed person is disconnected and cannot rejoin, by token or by link', async () => {
    const res = await hostCall('remove', { identity: outsider.user.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(calls.at(-1), ['remove', room, outsider.user.id]);
    assert.equal((await joinAs(outsider)).status, 403);
    assert.equal((await api.get(`/ai-meetings/link/${live.invite_token}`, { token: outsider.token })).status, 403);
    assert.equal((await hostCall('remove', { identity: host.user.id })).status, 400, 'the host cannot remove themself');
    // Undo: allowed back in.
    assert.equal((await hostCall('allow', { identity: outsider.user.id })).status, 200);
    assert.equal((await joinAs(outsider)).status, 200);
  });

  test('the host role can be handed over, and the badge in the room follows', async () => {
    assert.equal((await hostCall('transfer', { user_id: 'not-on-meeting' })).status, 400);
    const res = await hostCall('transfer', { user_id: guest.user.id });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const m = (await api.get(`/ai-meetings/${live.id}`, { token: guest.token })).body.data;
    assert.equal(m.host_id, guest.user.id);
    const roles = calls.filter((c) => c[0] === 'update' && c[3].metadata).map((c) => `${c[2]}:${JSON.parse(c[3].metadata).role}`).sort();
    assert.deepEqual(roles, [`${guest.user.id}:host`, `${host.user.id}:participant`].sort());
    assert.equal((await hostCall('lock', { locked: true })).status, 403, 'the old host has no powers left');
    const tok = claims((await joinAs(guest)).body.data.token);
    assert.equal(tok.video.roomAdmin, true, 'the new host gets host powers on rejoin');
  });

  test('end for everyone closes the room and completes the meeting', async () => {
    const res = await hostCall('end', {}, guest.token);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(calls.at(-1), ['delete', room]);
    const m = (await api.get(`/ai-meetings/${live.id}`, { token: guest.token })).body.data;
    assert.equal(m.status, 'completed');
    assert.ok(m.ended_at);
    assert.equal((await joinAs(guest)).status, 400);
    assert.equal((await hostCall('end', {}, guest.token)).status, 400, 'already ended');
  });

  test('the workspace owner can step in as host', async () => {
    const res = await api.post('/ai-meetings/instant', { title: 'Escalation', participant_ids: [guest.user.id] }, { token: host.token });
    assert.equal((await api.post(`/ai-meetings/${res.body.data.id}/host/lock`, { locked: true }, { token: owner.access_token })).status, 200);
  });
});
