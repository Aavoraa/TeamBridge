import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { AccessToken, EgressStatus } from 'livekit-server-sdk';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';
import { readPages, sliceOgg, oggDurationSeconds, oggCrc32 } from '../src/lib/oggOpus.js';

// Settings are read when the config loads, so they are set first.
process.env.LIVEKIT_URL = 'wss://phoenixx-test.livekit.cloud';
process.env.LIVEKIT_API_KEY = 'APIcapturekey';
process.env.LIVEKIT_API_SECRET = 'capture-secret-that-is-long-enough-for-hmac-signing-0123456789';
process.env.RECORDING_S3_BUCKET = 'phoenixx-recordings';
process.env.RECORDING_S3_REGION = 'ap-south-1';
process.env.RECORDING_S3_ACCESS_KEY_ID = 'AKIATEST';
process.env.RECORDING_S3_SECRET_ACCESS_KEY = 'test-s3-secret';

// ------------------------------------------------------------ a fake Ogg Opus
/** Builds an Ogg Opus stream: OpusHead, OpusTags, then one page per `pageSeconds` whose payload names the speaker. */
function page({ flags = 0, granule, seq, body }) {
  const segs = [];
  let left = body.length;
  while (left >= 255) { segs.push(255); left -= 255; }
  segs.push(left);
  const h = Buffer.alloc(27 + segs.length);
  h.write('OggS', 0, 'latin1');
  h[5] = flags;
  h.writeBigInt64LE(BigInt(granule), 6);
  h.writeUInt32LE(0x1234, 14);
  h.writeUInt32LE(seq, 18);
  h[26] = segs.length;
  segs.forEach((s, i) => { h[27 + i] = s; });
  const out = Buffer.concat([h, body]);
  out.writeUInt32LE(oggCrc32(out), 22);
  return out;
}
function fakeOgg(speaker, seconds, pageSeconds = 60) {
  const pages = [
    page({ flags: 0x02, granule: 0, seq: 0, body: Buffer.from('OpusHead\x01\x01\x38\x01\x80\xbb\x00\x00\x00\x00\x00', 'latin1') }),
    page({ granule: 0, seq: 1, body: Buffer.from('OpusTags\x00\x00\x00\x00\x00\x00\x00\x00', 'latin1') }),
  ];
  const n = Math.ceil(seconds / pageSeconds);
  for (let i = 1; i <= n; i++) {
    pages.push(page({ granule: Math.min(i * pageSeconds, seconds) * 48_000, seq: i + 1, flags: i === n ? 0x04 : 0, body: Buffer.from(`[${speaker} minute ${i}]`) }));
  }
  return Buffer.concat(pages);
}

describe('cutting Ogg Opus by time', () => {
  const ogg = fakeOgg('PRIYA', 25 * 60);

  test('reads the pages and the length', () => {
    assert.equal(readPages(ogg).length, 2 + 25);
    assert.equal(oggDurationSeconds(ogg), 1500);
    assert.throws(() => readPages(Buffer.from('RIFF....WAVE')), /Not an Ogg file/);
  });

  test('a ten-minute window is a valid file of its own, starting at zero', () => {
    const second = sliceOgg(ogg, 600, 1200);
    const pages = readPages(second);
    assert.equal(pages.length, 2 + 10, 'both headers, then minutes 11-20');
    assert.match(pages[0].bytes.toString('latin1'), /OpusHead/);
    assert.equal(pages[0].flags & 0x02, 0x02, 'begins the stream');
    assert.equal(Number(pages[2].granule), 60 * 48_000, 'rebased to the window start');
    assert.equal(Number(pages.at(-1).granule), 600 * 48_000);
    assert.equal(pages.at(-1).flags & 0x04, 0x04, 'the last page ends the stream');
    assert.ok(second.includes(Buffer.from('[PRIYA minute 11]')));
    assert.ok(!second.includes(Buffer.from('[PRIYA minute 10]')));
    for (const p of pages) {
      const copy = Buffer.from(p.bytes);
      const stored = copy.readUInt32LE(22);
      copy.writeUInt32LE(0, 22);
      assert.equal(oggCrc32(copy), stored, 'every checksum is right');
    }
    assert.deepEqual(pages.map((p) => p.bytes.readUInt32LE(18)), [...Array(12).keys()], 'pages renumbered');
  });

  test('the last window is short, and past the end there is nothing', () => {
    assert.equal(readPages(sliceOgg(ogg, 1200, 1800)).length, 2 + 5);
    assert.equal(sliceOgg(ogg, 1800, 2400), null);
  });

  test('a file cut off mid-page (recorder stopped hard) keeps the complete pages', () => {
    const cut = ogg.subarray(0, ogg.length - 5);
    assert.equal(readPages(cut).length, 2 + 24);
  });
});

// --------------------------------------------------------------- the server
useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const lk = await import('../src/services/livekit.js');
const store = await import('../src/services/objectStore.js');
const intel = await import('../src/services/meetingIntel.js');
const { config } = await import('../src/config.js');

const created = [];
const calls = [];
let inRoom = [];
let egressN = 0;
let compositeFails = false;
let openRoomNames = null; // null = every room is open
const egressState = new Map(); // egressId -> what listEgress reports
lk.setLivekitForTests({
  roomClient: {
    createRoom: async (opts) => { created.push(opts); return opts; },
    listParticipants: async () => inRoom,
    updateRoomMetadata: async (room, md) => { calls.push(['room-meta', JSON.parse(md)]); },
    deleteRoom: async (room) => { calls.push(['delete-room', room]); },
    listRooms: async (names) => (names || []).filter((n) => !openRoomNames || openRoomNames.has(n)).map((name) => ({ name })),
  },
  egressClient: {
    startRoomCompositeEgress: async (room, output, opts) => {
      if (compositeFails) throw new Error('egress unavailable');
      calls.push(['composite', room, output, opts]);
      return { egressId: `EG_v${++egressN}`, status: EgressStatus.EGRESS_STARTING };
    },
    startTrackEgress: async (room, output, trackSid) => {
      calls.push(['track', room, output, trackSid]);
      return { egressId: `EG_t${++egressN}_${trackSid}`, status: EgressStatus.EGRESS_STARTING };
    },
    stopEgress: async (id) => { calls.push(['stop', id]); return { egressId: id, status: EgressStatus.EGRESS_ENDING }; },
    listEgress: async ({ egressId }) => [egressState.get(egressId) || { egressId, status: EgressStatus.EGRESS_ACTIVE }],
  },
});

const objects = new Map();
const deleted = [];
store.setObjectStoreForTests({
  get: async (key) => { if (!objects.has(key)) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' }); return objects.get(key); },
  del: async (key) => { deleted.push(key); objects.delete(key); },
  sign: async (key, { seconds }) => `https://signed.example/${key}?expires=${seconds}`,
});
// Speech-to-text stand-in: reads which minutes are in the audio it was sent.
const sent = [];
intel.setMeetingProvidersForTests({
  transcribe: async (buffer, mime, name) => {
    sent.push({ mime, name, bytes: buffer.length });
    const marks = [...buffer.toString('latin1').matchAll(/\[(\w+) minute (\d+)\]/g)];
    return marks.map((m, i) => ({ start: i * 60 + 1, end: i * 60 + 5, speaker: 'Speaker A', text: `${m[1]} says minute ${m[2]}` }));
  },
});

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Capture Co', email: 'owner@capture.test', owner_name: 'Arun Prakash' });
async function join(name, email, role = 'employee') {
  const invite = await api.post('/users', { name, email, role }, { token: owner.access_token });
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

async function signedWebhook(event) {
  const body = JSON.stringify(event);
  const at = new AccessToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET);
  at.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  const res = await fetch(`${api.base}/livekit/webhook`, {
    method: 'POST', headers: { 'Content-Type': 'application/webhook+json', Authorization: await at.toJwt() }, body,
  });
  return { status: res.status, body: await res.json() };
}
const ns = (ms) => String(BigInt(ms) * 1_000_000n);
const mic = (sid) => ({ sid, source: 2, type: 0, muted: false });

let host; let guest; let outsider; let meeting; let room;
const lastMeta = () => calls.filter((c) => c[0] === 'room-meta').at(-1)?.[1];

before(async () => {
  host = await join('Divya Ramesh', 'divya@capture.test', 'manager');
  guest = await join('Priya Raman', 'priya@capture.test');
  outsider = await join('Kavya Nair', 'kavya@capture.test');
  const res = await api.post('/ai-meetings/instant', {
    title: 'Client kickoff', participant_ids: [guest.user.id], recording_allowed: true, transcription_allowed: true,
  }, { token: host.token });
  meeting = res.body.data;
  for (const who of [host, guest]) {
    const j = await api.post(`/ai-meetings/${meeting.id}/join`, { consent: true }, { token: who.token });
    assert.equal(j.status, 200, JSON.stringify(j.body));
  }
  room = created.at(-1).name;
  inRoom = [
    { identity: host.user.id, tracks: [mic('TR_divya'), { sid: 'TR_cam', source: 1 }] },
    { identity: guest.user.id, tracks: [mic('TR_priya')] },
  ];
});

describe('starting and stopping', () => {
  test('the join response says what the host can switch on', async () => {
    const j = await api.post(`/ai-meetings/${meeting.id}/join`, { consent: true }, { token: host.token });
    assert.deepEqual(j.body.data.capture, { video: { available: true, reason: null }, transcript: { available: true, reason: null } });
    assert.equal(j.body.data.state.recording, false);
  });

  test('only the host can start recording', async () => {
    const res = await api.post(`/ai-meetings/${meeting.id}/capture/start`, {}, { token: guest.token });
    assert.equal(res.status, 403);
    assert.equal(calls.filter((c) => c[0] === 'composite' || c[0] === 'track').length, 0);
  });

  test('nobody is recorded who did not agree: someone in the room without consent blocks the start', async () => {
    inRoom.push({ identity: outsider.user.id, tracks: [mic('TR_kavya')] });
    const res = await api.post(`/ai-meetings/${meeting.id}/capture/start`, {}, { token: host.token });
    inRoom.pop();
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'consent_missing');
    assert.match(res.body.error.message, /Kavya Nair has not agreed/);
  });

  test('start records the room and every microphone separately, and tells everyone', async () => {
    const res = await api.post(`/ai-meetings/${meeting.id}/capture/start`, {}, { token: host.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.recording, true);
    assert.equal(res.body.data.transcribing, true);

    const composite = calls.find((c) => c[0] === 'composite');
    assert.equal(composite[1], room);
    assert.equal(composite[3].layout, 'speaker');
    const out = composite[2];
    assert.equal(out.output.case, 's3');
    assert.equal(out.output.value.bucket, 'phoenixx-recordings');
    assert.match(out.filepath, new RegExp(`^meetings/[^/]+/${meeting.id}/video/.+\\.mp4$`));

    const tracks = calls.filter((c) => c[0] === 'track').map((c) => c[3]).sort();
    assert.deepEqual(tracks, ['TR_divya', 'TR_priya'], 'microphones only, not the camera');
    assert.deepEqual({ recording: lastMeta().recording, transcribing: lastMeta().transcribing }, { recording: true, transcribing: true });
    assert.equal((await api.post(`/ai-meetings/${meeting.id}/capture/start`, {}, { token: host.token })).status, 400, 'already on');
  });

  test('the recording settings cannot be changed under people while the meeting runs', async () => {
    await db.run("UPDATE meetings SET status = 'live' WHERE id = ?", [meeting.id]);
    const res = await api.patch(`/ai-meetings/${meeting.id}`, { recording_allowed: false }, { token: host.token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /started or ended cannot be changed/, 'people agreed to what was allowed when they joined');
  });

  test('a microphone that appears later is captured too, once', async () => {
    const ev = { event: 'track_published', room: { name: room }, participant: { identity: guest.user.id, sid: 'PA_p' }, track: mic('TR_priya2') };
    assert.equal((await signedWebhook(ev)).status, 200);
    await signedWebhook(ev); // LiveKit retries
    assert.equal(calls.filter((c) => c[0] === 'track' && c[3] === 'TR_priya2').length, 1);
    // A camera is not captured for the transcript.
    await signedWebhook({ ...ev, track: { sid: 'TR_cam2', source: 1 } });
    assert.equal(calls.filter((c) => c[3] === 'TR_cam2').length, 0);
  });

  test('stop asks LiveKit to stop every recorder and tells the room', async () => {
    const res = await api.post(`/ai-meetings/${meeting.id}/capture/stop`, {}, { token: host.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(calls.filter((c) => c[0] === 'stop').length, 4, 'video + three microphones');
    assert.equal(lastMeta().recording, false);
    // After stop, a new microphone is not captured.
    await signedWebhook({ event: 'track_published', room: { name: room }, participant: { identity: host.user.id }, track: mic('TR_divya2') });
    assert.equal(calls.filter((c) => c[3] === 'TR_divya2').length, 0);
  });
});

describe('after the meeting: playback and transcript', () => {
  const t0 = Date.parse('2026-11-04T10:00:00Z');
  const ended = (egressId, startMs, seconds) => signedWebhook({
    event: 'egress_ended',
    egressInfo: { egressId, roomName: room, status: 'EGRESS_COMPLETE', fileResults: [{ startedAt: ns(startMs), endedAt: ns(startMs + seconds * 1000), duration: ns(seconds * 1000), size: '4096' }] },
  });
  const rec = (sid) => db.get('SELECT * FROM meeting_recordings WHERE track_sid = ?', [sid]);

  test('egress results are recorded; nothing is transcribed while the meeting is still running', async () => {
    const video = await db.get("SELECT * FROM meeting_recordings WHERE kind = 'video' AND meeting_id = ?", [meeting.id]);
    assert.equal((await ended(video.egress_id, t0, 1500)).status, 200);
    // Divya talked for 25 minutes from the start; Priya's first mic 4 minutes from 2:00, her second from 20:00.
    const [d, p1, p2] = [await rec('TR_divya'), await rec('TR_priya'), await rec('TR_priya2')];
    objects.set(d.s3_key, fakeOgg('DIVYA', 1500));
    objects.set(p1.s3_key, fakeOgg('PRIYA', 240));
    objects.set(p2.s3_key, fakeOgg('PRIYAB', 120));
    await ended(d.egress_id, t0, 1500);
    await ended(p1.egress_id, t0 + 120_000, 240);
    const v = await db.get('SELECT * FROM meeting_recordings WHERE id = ?', [video.id]);
    assert.equal(v.status, 'complete');
    assert.equal(v.duration_seconds, 1500);
    assert.equal(v.file_started_at, '2026-11-04T10:00:00.000Z');
    assert.equal((await db.get('SELECT ai_meeting_id FROM meetings WHERE id = ?', [meeting.id])).ai_meeting_id, null);
  });

  test('ending the meeting waits for the last recorder, then hands the audio to Meeting Intelligence once', async () => {
    assert.equal((await api.post(`/ai-meetings/${meeting.id}/host/end`, {}, { token: host.token })).status, 200);
    assert.equal((await db.get('SELECT ai_meeting_id FROM meetings WHERE id = ?', [meeting.id])).ai_meeting_id, null, 'one recorder still writing');
    const p2 = await rec('TR_priya2');
    await ended(p2.egress_id, t0 + 1_200_000, 120);
    await ended(p2.egress_id, t0 + 1_200_000, 120); // retried delivery

    const m = await db.get('SELECT * FROM meetings WHERE id = ?', [meeting.id]);
    assert.ok(m.ai_meeting_id);
    assert.equal(m.capture_active, 0);
    const ai = await db.get('SELECT * FROM ai_meetings WHERE id = ?', [m.ai_meeting_id]);
    assert.equal(ai.source_kind, 'live');
    assert.equal(ai.status, 'queued');
    assert.equal(ai.uploaded_by, host.user.id);
    assert.equal(ai.consent_by, host.user.id);
    assert.deepEqual(JSON.parse(ai.speakers_json), { 'Divya Ramesh': host.user.id, 'Priya Raman': guest.user.id });
    const parts = await db.all('SELECT * FROM ai_meeting_parts WHERE meeting_id = ? ORDER BY part_index', [ai.id]);
    // Divya's 25 minutes = 3 ten-minute parts; Priya's two files = 1 each.
    assert.deepEqual(parts.map((p) => [p.speaker_label, p.offset_seconds]), [
      ['Divya Ramesh', 0], ['Divya Ramesh', 600], ['Divya Ramesh', 1200], ['Priya Raman', 120], ['Priya Raman', 1200],
    ]);
    assert.equal(await db.get('SELECT COUNT(*) AS n FROM ai_meetings WHERE tenant_id = ?', [ai.tenant_id]).then((r) => Number(r.n)), 1);
  });

  test('the transcript has real names, in the order things were said, and the audio is deleted afterwards', async () => {
    const { ai_meeting_id: id } = await db.get('SELECT ai_meeting_id FROM meetings WHERE id = ?', [meeting.id]);
    let ai;
    for (let i = 0; i < 10; i++) {
      ai = await intel.advanceMeeting(id);
      if (ai.status !== 'queued' && ai.status !== 'transcribing') break;
    }
    assert.equal(ai.status, 'analyzing', ai.error || '');
    assert.ok(sent.every((s) => s.mime === 'audio/ogg' && /\.ogg$/.test(s.name)));
    assert.ok(sent.every((s) => s.bytes < 24 * 1024 * 1024));
    const lines = JSON.parse(ai.transcript_json);
    assert.ok(lines.every((l, i) => i === 0 || l.start >= lines[i - 1].start), 'in time order');
    assert.ok(lines.every((l) => ['Divya Ramesh', 'Priya Raman'].includes(l.speaker)), 'no "Speaker A"');
    const priyaFirst = lines.find((l) => l.text === 'PRIYA says minute 1');
    assert.equal(priyaFirst.speaker, 'Priya Raman');
    assert.equal(priyaFirst.start, 121, 'placed at 2:01 on the meeting timeline');
    const divya11 = lines.find((l) => l.text === 'DIVYA says minute 11');
    assert.equal(divya11.start, 601);
    assert.ok(lines.find((l) => l.text === 'PRIYAB says minute 1').start >= 1200);
    assert.equal(deleted.filter((k) => /\/audio\//.test(k)).length, 3, 'each audio file deleted once');
    const purged = await db.all("SELECT purged_at FROM meeting_recordings WHERE meeting_id = ? AND kind = 'audio_track' AND status = 'complete'", [meeting.id]);
    assert.ok(purged.every((r) => r.purged_at));
  });

  test('the analysis knows who was there: participants come from the meeting, and "Priya" means the Priya in the room', async () => {
    // Another Priya works here but was not in this meeting.
    const otherPriya = await join('Priya Sharma', 'priya.sharma@capture.test');
    const { ai_meeting_id: id } = await db.get('SELECT ai_meeting_id FROM meetings WHERE id = ?', [meeting.id]);
    let prompt = '';
    intel.setMeetingProvidersForTests({
      transcribe: async () => [], // already transcribed; keeps speech-to-text counted as set up for later tests
      analyze: async (p) => {
        prompt = p;
        const task = (over) => ({
          title: 'Task', description: '', assignee_name: '', assignee_speaker: '', assigned_by: 'Divya Ramesh', acceptance: 'unclear',
          deadline_text: '', due_date: '', due_time: '', deadline_status: 'none', priority: 'unspecified', related_to: '',
          evidence_segments: [0], confidence: 'high', cancelled: false, ...over,
        });
        return {
          summary: {
            overview: 'Kickoff.', topics: ['Scope'], updates: [], decisions: ['Budget fixed at 5 lakh'], problems: [], client_discussions: [],
            conclusions: ['The client wants a phased launch'],
          },
          action_items: [
            task({ title: 'Send the revised proposal', assignee_name: 'Priya', acceptance: 'accepted', deadline_text: 'by Friday' }),
            task({ title: 'Book the review call', assignee_speaker: 'Divya Ramesh', assigned_by: '' }),
          ],
          open_items: {
            unassigned_tasks: [], unclear_deadlines: [], pending_decisions: [], unresolved_issues: [], follow_ups: [],
            follow_up_meetings: ['Review call with the client next week'], repeated_issues: ['Late feedback from the client'],
            risks: ['Launch may slip if feedback is late again'],
          },
        };
      },
    });
    const ai = await intel.advanceMeeting(id);
    assert.equal(ai.status, 'review', ai.error || '');

    assert.match(prompt, /Participants \(from the meeting system\): Divya Ramesh[^;]*, host; Priya Raman/);
    assert.match(prompt, /Speaker labels are the participants' names/);
    assert.doesNotMatch(prompt, /Priya Sharma/, 'people not on the meeting are not listed');

    const items = await db.all('SELECT * FROM ai_meeting_items WHERE meeting_id = ? ORDER BY idx', [id]);
    assert.equal(items[0].assignee_user_id, guest.user.id, '"Priya" is the Priya who was in the meeting');
    assert.equal(items[0].assignee_status, 'matched');
    assert.deepEqual(JSON.parse(items[0].candidates_json).sort(), [guest.user.id, otherPriya.user.id].sort(), 'the other Priya stays visible to the reviewer');
    assert.equal(items[1].assignee_user_id, host.user.id, '"I\'ll book it" from Divya\'s own microphone is Divya');

    const summary = JSON.parse(ai.summary_json);
    assert.deepEqual(summary.conclusions, ['The client wants a phased launch']);
    assert.deepEqual(summary.participants.map((p) => [p.name, p.host, p.attended]), [['Divya Ramesh', true, true], ['Priya Raman', false, true]]);
    const extras = JSON.parse(ai.extras_json);
    assert.deepEqual(extras.risks, ['Launch may slip if feedback is late again']);
    assert.deepEqual(extras.repeated_issues, ['Late feedback from the client']);
    assert.deepEqual(extras.follow_up_meetings, ['Review call with the client next week']);
  });

  test('an approved task is a normal task that links back to its meeting, who approved it, and where it was said', async () => {
    await db.run('UPDATE users SET manager_id = ? WHERE id = ?', [host.user.id, guest.user.id]); // Priya reports to Divya
    const { ai_meeting_id: id } = await db.get('SELECT ai_meeting_id FROM meetings WHERE id = ?', [meeting.id]);
    const d = (await api.get(`/meeting-intel/${id}`, { token: host.token })).body.data;
    assert.equal(d.live_meeting_id, meeting.id, 'the analysis points at the meeting (and its video)');
    const proposal = d.items.find((i) => i.title === 'Send the revised proposal');
    const res = await api.post(`/meeting-intel/${id}/items/approve`, { item_ids: [proposal.id] }, { token: host.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [r] = res.body.data.results;
    assert.equal(r.ok, true, r.error);

    const task = (await api.get(`/action-items/${r.action_item_id}`, { token: host.token })).body.data;
    assert.equal(task.owner_id, guest.user.id);
    assert.equal(task.source_type, 'meeting_ai');
    assert.equal(task.source_meeting.ai_meeting_id, id);
    assert.equal(task.source_meeting.live_meeting_id, meeting.id);
    assert.equal(task.source_meeting.approved_by_name, 'Divya Ramesh');
    assert.equal(task.source_meeting.title, 'Client kickoff');

    // Approving again creates nothing new.
    const again = await api.post(`/meeting-intel/${id}/items/approve`, { item_ids: [proposal.id] }, { token: host.token });
    assert.equal(again.body.data.results[0].ok, false);
    assert.equal(Number((await db.get("SELECT COUNT(*) AS n FROM action_items WHERE source_type = 'meeting_ai' AND source_id = ?", [proposal.id])).n), 1);
  });

  test("a manager sees a meeting's proposals when their team was in it, and not otherwise", async () => {
    const meena = await join('Meena Iyer', 'meena@capture.test', 'manager');
    const { ai_meeting_id: id } = await db.get('SELECT ai_meeting_id FROM meetings WHERE id = ?', [meeting.id]);
    assert.equal((await api.get(`/meeting-intel/${id}`, { token: meena.token })).status, 404, 'not her meeting, not her team');
    assert.ok(!(await api.get('/meeting-intel?tab=pending', { token: meena.token })).body.data.some((m) => m.id === id));

    await db.run('UPDATE users SET manager_id = ? WHERE id = ?', [meena.user.id, guest.user.id]); // now Priya reports to Meena
    assert.equal((await api.get(`/meeting-intel/${id}`, { token: meena.token })).status, 200);
    assert.ok((await api.get('/meeting-intel?tab=pending', { token: meena.token })).body.data.some((m) => m.id === id), 'in her approval queue');
    // An employee without the module never sees it, even though she was in the meeting.
    assert.equal((await api.get(`/meeting-intel/${id}`, { token: guest.token })).status, 403);
    await db.run('UPDATE users SET manager_id = ? WHERE id = ?', [host.user.id, guest.user.id]);
  });

  test('people on the meeting can watch the video through a short-lived link; others cannot', async () => {
    const res = await api.get(`/ai-meetings/${meeting.id}/recordings`, { token: guest.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const [video] = res.body.data.recordings;
    assert.equal(video.status, 'complete');
    assert.match(video.url, /^https:\/\/signed\.example\/meetings\/.+\.mp4\?expires=3600$/);
    assert.equal(video.s3_key, undefined, 'storage keys are not handed out');
    assert.equal(res.body.data.transcript.status, 'review', 'analysed and waiting for review');
    assert.equal(res.body.data.can_delete, false);
    const other = await api.get(`/ai-meetings/${meeting.id}/recordings`, { token: outsider.token });
    assert.ok([403, 404].includes(other.status));
  });

  test('meeting history shows what came out of each meeting', async () => {
    const list = (await api.get('/ai-meetings?tab=history', { token: host.token })).body.data;
    const row = list.find((x) => x.id === meeting.id);
    assert.ok(row, 'the ended meeting is in history');
    assert.equal(row.recordings_count, 1);
    assert.equal(row.has_transcript, true);
    assert.equal(row.has_summary, true);
    assert.equal(row.ai_status, 'review');
    assert.deepEqual([row.tasks_extracted, row.tasks_approved, row.tasks_rejected], [2, 1, 0]);

    const ids = async (q, token = host.token) => (await api.get(`/ai-meetings?tab=history${q}`, { token })).body.data.map((x) => x.id);
    assert.ok((await ids('&recorded=1')).includes(meeting.id));
    assert.ok((await ids('&transcribed=1')).includes(meeting.id));
    assert.ok(!(await ids('&from=2099-01-01')).includes(meeting.id), 'date range');
  });

  test('transcript search finds what was said, only for people who may read it', async () => {
    const ids = async (token, q) => (await api.get(`/ai-meetings?tab=history&search=${encodeURIComponent(q)}&in_transcripts=1`, { token })).body.data.map((x) => x.id);
    assert.ok((await ids(host.token, 'says minute 11')).includes(meeting.id), 'a phrase from the transcript');
    assert.ok(!(await ids(host.token, 'nobody said this')).includes(meeting.id));
    assert.ok(!(await api.get('/ai-meetings?tab=history&search=says%20minute%2011', { token: host.token })).body.data.some((x) => x.id === meeting.id),
      'without "search transcripts", only titles and descriptions match');
    assert.ok((await ids(guest.token, 'says minute 11')).includes(meeting.id), 'a participant');
    assert.ok(!(await ids(outsider.token, 'says minute 11')).includes(meeting.id), 'someone not on it');
  });

  test('the meeting record: transcript, AI summary, action items and approved tasks, for the people allowed', async () => {
    const r = (await api.get(`/ai-meetings/${meeting.id}/record`, { token: host.token })).body.data;
    assert.ok(r.transcript.length > 3);
    assert.ok(r.transcript.every((l) => ['Divya Ramesh', 'Priya Raman'].includes(l.speaker)));
    assert.deepEqual(r.summary.conclusions, ['The client wants a phased launch']);
    assert.deepEqual(r.open_items.risks, ['Launch may slip if feedback is late again']);
    assert.equal(r.items.length, 2);
    assert.equal(r.approved_tasks.length, 1);
    const t = r.approved_tasks[0];
    assert.equal(t.owner_name, 'Priya Raman');
    assert.equal(t.approved_by_name, 'Divya Ramesh');
    assert.ok(t.status, 'the task as it stands now');
    assert.equal(r.can_review, true);

    assert.equal((await api.get(`/ai-meetings/${meeting.id}/record`, { token: guest.token })).status, 200, 'a participant can read it');
    assert.equal((await api.get(`/ai-meetings/${meeting.id}/record`, { token: guest.token })).body.data.can_review, false);
    assert.equal((await api.get(`/ai-meetings/${meeting.id}/record`, { token: outsider.token })).status, 404, 'someone not on it');
  });

  test('a removed participant loses the recording and the transcript', async () => {
    await db.run('UPDATE meeting_attendees SET blocked = 1 WHERE meeting_id = ? AND user_id = ?', [meeting.id, guest.user.id]);
    try {
      assert.equal((await api.get(`/ai-meetings/${meeting.id}/record`, { token: guest.token })).status, 403);
      assert.equal((await api.get(`/ai-meetings/${meeting.id}/recordings`, { token: guest.token })).status, 403);
      const hits = (await api.get('/ai-meetings?tab=history&search=says%20minute%2011&in_transcripts=1', { token: guest.token })).body.data;
      assert.ok(!hits.some((x) => x.id === meeting.id));
    } finally {
      await db.run('UPDATE meeting_attendees SET blocked = 0 WHERE meeting_id = ? AND user_id = ?', [meeting.id, guest.user.id]);
    }
  });

  test('only the host deletes a recording, and the file goes with it', async () => {
    const [video] = (await api.get(`/ai-meetings/${meeting.id}/recordings`, { token: host.token })).body.data.recordings;
    assert.equal((await api.del(`/ai-meetings/${meeting.id}/recordings/${video.id}`, { token: guest.token })).status, 403);
    assert.equal((await api.del(`/ai-meetings/${meeting.id}/recordings/${video.id}`, { token: host.token })).status, 200);
    assert.ok(deleted.some((k) => /\/video\//.test(k)));
    assert.equal((await api.get(`/ai-meetings/${meeting.id}/recordings`, { token: host.token })).body.data.recordings.length, 0);
  });
});

describe('what is not allowed or not set up', () => {
  let plain;
  before(async () => {
    plain = (await api.post('/ai-meetings/instant', { title: 'Quick sync', participant_ids: [guest.user.id] }, { token: host.token })).body.data;
    await api.post(`/ai-meetings/${plain.id}/join`, {}, { token: host.token });
  });

  test('a meeting scheduled without recording or transcription cannot be recorded, and says why', async () => {
    const res = await api.post(`/ai-meetings/${plain.id}/capture/start`, {}, { token: host.token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /not allowed when this meeting was scheduled/);
    assert.equal((await api.post(`/ai-meetings/${plain.id}/captions`, { on: true }, { token: host.token })).status, 400);
  });

  test('without storage settings the host is told, instead of a silent failure', async () => {
    const m = (await api.post('/ai-meetings/instant', { title: 'Rec', recording_allowed: true }, { token: host.token })).body.data;
    const saved = config.recordingStorage.bucket;
    config.recordingStorage.bucket = '';
    try {
      const j = await api.post(`/ai-meetings/${m.id}/join`, { consent: true }, { token: host.token });
      assert.equal(j.body.data.capture.video.available, false);
      assert.match(j.body.data.capture.video.reason, /storage is not set up/);
      assert.equal((await api.post(`/ai-meetings/${m.id}/capture/start`, {}, { token: host.token })).status, 400);
    } finally { config.recordingStorage.bucket = saved; }
  });

  test('if the recorder cannot start, recording is not shown as on', async () => {
    const m = (await api.post('/ai-meetings/instant', { title: 'Rec 2', recording_allowed: true }, { token: host.token })).body.data;
    await api.post(`/ai-meetings/${m.id}/join`, { consent: true }, { token: host.token });
    inRoom = [{ identity: host.user.id, tracks: [mic('TR_x')] }];
    compositeFails = true;
    const res = await api.post(`/ai-meetings/${m.id}/capture/start`, {}, { token: host.token });
    compositeFails = false;
    assert.equal(res.status, 503);
    assert.equal(lastMeta().recording, false);
    assert.equal((await db.get('SELECT capture_active FROM meetings WHERE id = ?', [m.id])).capture_active, 0);
  });

  test('live captions are switched on by the host for everyone to see', async () => {
    const m = (await api.post('/ai-meetings/instant', { title: 'Captions', transcription_allowed: true }, { token: host.token })).body.data;
    await api.post(`/ai-meetings/${m.id}/join`, { consent: true }, { token: host.token });
    assert.equal((await api.post(`/ai-meetings/${m.id}/captions`, { on: true }, { token: host.token })).status, 200);
    assert.equal(lastMeta().captions, true);
    assert.equal(lastMeta().meeting_id, m.id);
  });
});

describe('when webhooks never arrive', () => {
  test('the background check closes the meeting once its room is gone, reads the files back, and queues the transcript', async () => {
    const { sweepCaptures } = await import('../src/services/meetingCapture.js');
    const m = (await api.post('/ai-meetings/instant', { title: 'No webhook', participant_ids: [guest.user.id], transcription_allowed: true }, { token: host.token })).body.data;
    await api.post(`/ai-meetings/${m.id}/join`, { consent: true }, { token: host.token });
    const roomName = created.at(-1).name;
    inRoom = [{ identity: host.user.id, tracks: [mic('TR_nowebhook')] }];
    assert.equal((await api.post(`/ai-meetings/${m.id}/capture/start`, {}, { token: host.token })).status, 200);
    const row = await db.get('SELECT * FROM meeting_recordings WHERE track_sid = ?', ['TR_nowebhook']);

    // Everyone left; LiveKit closed the room and finished the file. No webhook told us.
    openRoomNames = new Set();
    const start = Date.parse('2026-11-04T10:45:03Z');
    egressState.set(row.egress_id, {
      egressId: row.egress_id, status: EgressStatus.EGRESS_COMPLETE, fileResults: [],
      // How listEgress really returns it: the file as the result, not in fileResults.
      result: { case: 'file', value: { startedAt: BigInt(start) * 1_000_000n, duration: 21_434_145_830n, size: 325_444n } },
    });
    await db.run('UPDATE meeting_recordings SET updated_at = ? WHERE id = ?', [new Date(Date.now() - 2 * 60_000).toISOString(), row.id]);

    await sweepCaptures();
    openRoomNames = null;
    const after = await db.get('SELECT * FROM meetings WHERE id = ?', [m.id]);
    assert.equal(after.status, 'completed');
    assert.ok(after.ended_at);
    const rec = await db.get('SELECT * FROM meeting_recordings WHERE id = ?', [row.id]);
    assert.equal(rec.status, 'complete');
    assert.equal(Math.round(rec.duration_seconds), 21);
    assert.equal(rec.size_bytes, 325444);
    assert.ok(after.ai_meeting_id, 'transcript queued');
    const parts = await db.all('SELECT * FROM ai_meeting_parts WHERE meeting_id = ?', [after.ai_meeting_id]);
    assert.equal(parts.length, 1);
    assert.equal(parts[0].speaker_label, 'Divya Ramesh');
    assert.ok(roomName);
  });
});
