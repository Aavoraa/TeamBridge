import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
process.env.ANTHROPIC_API_KEY = ''; // blank, not deleted: dotenv would refill it from server/.env
process.env.OPENAI_API_KEY = ''; // blank, not deleted: dotenv would refill it from server/.env

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const intel = await import('../src/services/meetingIntel.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Meet Co', email: 'owner@meet.test', owner_name: 'Arun Prakash' });
const ownerToken = owner.access_token;

async function join(name, email, role = 'employee', extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

let divya; let priyaR; let priyaS; let rahul; let karthik;
before(async () => {
  divya = await join('Divya Ramesh', 'divya@meet.test', 'manager');
  priyaR = await join('Priya Raman', 'priya.r@meet.test', 'employee', { manager_id: divya.user.id });
  rahul = await join('Rahul Kumar', 'rahul@meet.test', 'employee', { manager_id: divya.user.id });
  priyaS = await join('Priya Shankar', 'priya.s@meet.test', 'employee');
  karthik = await join('Karthik Subramanian', 'karthik@meet.test', 'employee');
});

// ------------------------------------------------------------- helpers
async function putChunk(token, meetingId, index, offset, bytes) {
  const res = await fetch(`${api.base}/meeting-intel/${meetingId}/parts/${index}?offset=${offset}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/octet-stream' },
    body: bytes,
  });
  return { status: res.status, body: await res.json() };
}

/** Uploads a text transcript in two chunks, like the browser does. */
async function uploadTranscript(token, text, extra = {}) {
  const bytes = Buffer.from(text, 'utf8');
  const res = await api.post('/meeting-intel', {
    title: 'Project Weekly Review', meeting_date: '2030-03-04', source_kind: 'transcript',
    file_name: 'weekly.txt', file_mime: 'text/plain', file_size: bytes.length,
    file_sha256: crypto.createHash('sha256').update(bytes).update(crypto.randomUUID()).digest('hex'),
    consent: true, parts: [{ index: 0, size: bytes.length, mime: 'text/plain' }], ...extra,
  }, { token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const id = res.body.data.id;
  const half = Math.floor(bytes.length / 2);
  assert.equal((await putChunk(token, id, 0, 0, bytes.subarray(0, half))).status, 200);
  const last = await putChunk(token, id, 0, half, bytes.subarray(half));
  assert.equal(last.status, 200);
  assert.equal(last.body.data.complete, true);
  return id;
}

/** Steps the pipeline until it stops changing (what the page and the cron do). */
async function runToRest(token, id) {
  let m;
  for (let i = 0; i < 12; i++) {
    const r = await api.post(`/meeting-intel/${id}/advance`, {}, { token });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    m = r.body.data;
    if (!['queued', 'transcribing', 'analyzing'].includes(m.status) || m.error) break;
  }
  return m;
}

const item = (over) => ({
  title: 'Task', description: '', assignee_name: '', assignee_speaker: '', assigned_by: '', acceptance: 'unclear',
  deadline_text: '', due_date: '', due_time: '', deadline_status: 'none', priority: 'unspecified', related_to: '',
  evidence_segments: [], confidence: 'high', cancelled: false, ...over,
});

const ANALYSIS = {
  summary: {
    overview: 'Weekly review of the Cotton India rollout.', topics: ['Rollout'], updates: ['Design done'],
    decisions: ['Ship on the 10th'], problems: ['Late assets'], client_discussions: ['Cotton India wants a demo'],
  },
  action_items: [
    // 1. accepted
    item({ title: 'Complete pending client confirmation emails', assignee_name: 'Rahul', assigned_by: 'Divya', acceptance: 'accepted',
      deadline_text: 'by Friday', due_date: '2030-03-08', deadline_status: 'resolved', evidence_segments: [0, 1], priority: 'high' }),
    // 2. assigned, no response
    item({ title: 'Update the rollout tracker', assignee_name: 'Priya Raman', acceptance: 'not_confirmed', evidence_segments: [2] }),
    // 3. two Priyas
    item({ title: 'Send the demo deck', assignee_name: 'Priya', acceptance: 'unclear', evidence_segments: [3] }),
    // 4. nobody assigned
    item({ title: 'Book the venue for the launch', evidence_segments: [4] }),
    // 8. cancelled in the meeting
    item({ title: 'Print brochures', assignee_name: 'Rahul', cancelled: true, evidence_segments: [5] }),
    // a self-commitment from an unmapped speaker
    item({ title: 'Share the budget sheet', assignee_speaker: 'Speaker B', acceptance: 'accepted', evidence_segments: [6] }),
    // ambiguous deadline
    item({ title: 'Prepare the client FAQ', assignee_name: 'Rahul', deadline_text: 'before the client meeting', deadline_status: 'ambiguous', evidence_segments: [7] }),
    // someone outside Divya's team
    item({ title: 'Audit the vendor contracts', assignee_name: 'Karthik', acceptance: 'accepted', evidence_segments: [8] }),
  ],
  open_items: {
    unassigned_tasks: ['Book the venue'], unclear_deadlines: ['Client FAQ'], pending_decisions: ['Launch city'],
    unresolved_issues: ['Asset delays'], follow_ups: ['Call with Cotton India'],
  },
};

const TRANSCRIPT = [
  '[00:00:05] Divya: Rahul, please complete the pending client confirmation emails by Friday.',
  '[00:00:09] Rahul: Sure, I will get them done.',
  '[00:01:10] Divya: Priya Raman, update the rollout tracker.',
  '[00:02:00] Divya: Priya, send the demo deck to Cotton India.',
  '[00:03:00] Divya: Someone needs to book the venue for the launch.',
  '[00:04:00] Divya: Rahul, print brochures. Actually, cancel that, we are going digital.',
  '[00:05:00] Speaker B: I will share the budget sheet tonight.',
  '[00:06:00] Divya: Rahul, prepare the client FAQ before the client meeting.',
  '[00:07:00] Divya: Karthik, audit the vendor contracts.',
].join('\n');

let lastPrompt = '';
const scriptedAnalysis = (out) => ({ analyze: async (prompt) => { lastPrompt = prompt; return structuredClone(out); } });

// =================================================================== tests
describe('access', () => {
  test('employees cannot reach the module', async () => {
    assert.equal((await api.get('/meeting-intel', { token: rahul.token })).status, 403);
    assert.equal((await api.get('/meeting-intel/config', { token: priyaS.token })).status, 403);
  });

  test('upload requires the consent confirmation', async () => {
    const res = await api.post('/meeting-intel', {
      title: 'No consent', source_kind: 'transcript', file_name: 'a.txt', file_size: 5,
      parts: [{ index: 0, size: 5, mime: 'text/plain' }],
    }, { token: divya.token });
    assert.equal(res.status, 422 === res.status ? 422 : res.status);
    assert.ok([400, 422].includes(res.status));
  });

  test('wrong file types are refused', async () => {
    const res = await api.post('/meeting-intel', {
      title: 'Bad', source_kind: 'transcript', file_name: 'notes.exe', file_size: 5, consent: true,
      parts: [{ index: 0, size: 5, mime: 'application/octet-stream' }],
    }, { token: divya.token });
    assert.equal(res.status, 400);
  });
});

describe('parsing transcripts', () => {
  test('speaker lines and timestamps are recognised; wrapped lines join their turn', () => {
    const segs = intel.parseTranscriptText('[00:01:05] Divya: Rahul, send it.\ncontinued here\n12:30 Rahul: Okay.\nplain line');
    assert.equal(segs[0].speaker, 'Divya');
    assert.equal(segs[0].start, 65);
    assert.match(segs[0].text, /continued here/);
    assert.equal(segs[1].speaker, 'Rahul');
    assert.equal(segs[1].start, 750);
  });
  test('WebVTT cues keep their times and voices', () => {
    const segs = intel.parseTranscriptText('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\n<v Divya>Hello team</v>');
    assert.deepEqual([segs[0].speaker, segs[0].start, segs[0].text], ['Divya', 1, 'Hello team']);
  });
});

describe('a transcript, end to end (manager)', () => {
  let id;
  let m;
  before(async () => {
    intel.setMeetingProvidersForTests(scriptedAnalysis(ANALYSIS));
    id = await uploadTranscript(divya.token, TRANSCRIPT);
    m = await runToRest(divya.token, id);
  });
  after(() => intel.setMeetingProvidersForTests(null));

  test('analysis lands in review with the summary, open items and the original transcript', () => {
    assert.equal(m.status, 'review');
    assert.equal(m.summary.decisions[0], 'Ship on the 10th');
    assert.equal(m.extras.pending_decisions[0], 'Launch city');
    assert.equal(m.transcript.length, 9);
    assert.match(lastPrompt, /Meeting date: Monday, 2030-03-04/);
    assert.match(lastPrompt, /\[0\] \(0:05\) Divya:/);
  });

  test('nothing was created by analysing', async () => {
    const n = await db.pluck("SELECT COUNT(*) FROM action_items WHERE source_type = 'meeting_ai'");
    assert.equal(Number(n), 0);
  });

  test('names are matched to real people, and only when certain', () => {
    const by = Object.fromEntries(m.items.map((it) => [it.title, it]));
    assert.equal(by['Complete pending client confirmation emails'].assignee_user_id, rahul.user.id);
    assert.equal(by['Complete pending client confirmation emails'].acceptance, 'accepted');
    assert.equal(by['Update the rollout tracker'].acceptance, 'not_confirmed');
    assert.equal(by['Send the demo deck'].assignee_status, 'ambiguous');
    assert.deepEqual(by['Send the demo deck'].candidates.map((c) => c.name).sort(), ['Priya Raman', 'Priya Shankar']);
    assert.equal(by['Book the venue for the launch'].assignee_status, 'unassigned');
    assert.equal(by['Share the budget sheet'].assignee_status, 'speaker_unmapped');
    assert.equal(by['Print brochures'].status, 'cancelled_in_meeting');
    assert.equal(by['Prepare the client FAQ'].deadline_status, 'ambiguous');
    assert.equal(by['Audit the vendor contracts'].assignee_user_id, karthik.user.id);
  });

  test('evidence and timestamps come from the stored transcript', () => {
    const t = m.items.find((it) => it.title === 'Complete pending client confirmation emails');
    assert.match(t.evidence.quote, /^Divya: Rahul, please complete/);
    assert.equal(t.start_seconds, 5);
  });

  test('only verified tasks are verified; the rest say why', () => {
    const verified = m.items.filter((it) => it.verified).map((it) => it.title).sort();
    assert.deepEqual(verified, ['Complete pending client confirmation emails', 'Update the rollout tracker']);
    const karthikTask = m.items.find((it) => it.title === 'Audit the vendor contracts');
    assert.match(karthikTask.problems.join(), /someone in your team/);
  });

  test('a manager cannot assign outside their team, even by editing', async () => {
    const t = m.items.find((it) => it.title === 'Audit the vendor contracts');
    const res = await api.patch(`/meeting-intel/${id}/items/${t.id}`, { assignee_user_id: karthik.user.id }, { token: divya.token });
    assert.equal(res.status, 403);
  });

  test('"Approve all verified" creates exactly the verified tasks, with the meeting notification', async () => {
    const res = await api.post(`/meeting-intel/${id}/items/approve`, { all_verified: true }, { token: divya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.results.filter((r) => r.ok).length, 2);
    const tasks = await db.all("SELECT * FROM action_items WHERE source_type = 'meeting_ai' ORDER BY title");
    assert.deepEqual(tasks.map((t) => t.title), ['Complete pending client confirmation emails', 'Update the rollout tracker']);
    const emails = tasks[0];
    assert.equal(emails.owner_id, rahul.user.id);
    assert.equal(emails.created_by, divya.user.id);
    assert.equal(emails.due_date, '2030-03-08');
    assert.equal(emails.priority, 'high');

    const notes = await api.get('/notifications', { token: rahul.token });
    const note = notes.body.data.find((n) => /from meeting/i.test(n.title || ''));
    assert.ok(note, 'Rahul is told the task came from the meeting');
    assert.match(note.body, /Project Weekly Review/);
    assert.match(note.body, /Assigned by: Divya Ramesh/);
  });

  test('approving the same task again creates nothing new', async () => {
    const t = m.items.find((it) => it.title === 'Update the rollout tracker');
    const res = await api.post(`/meeting-intel/${id}/items/approve`, { item_ids: [t.id] }, { token: divya.token });
    assert.equal(res.status, 200);
    const n = await db.pluck("SELECT COUNT(*) FROM action_items WHERE source_type = 'meeting_ai'");
    assert.equal(Number(n), 2);
  });

  test('resolving the ambiguous name by editing, then approving', async () => {
    const t = m.items.find((it) => it.title === 'Send the demo deck');
    const blocked = await api.post(`/meeting-intel/${id}/items/approve`, { item_ids: [t.id] }, { token: divya.token });
    assert.equal(blocked.body.data.results[0].ok, false);
    assert.match(blocked.body.data.results[0].error, /Several people match/);

    const edited = await api.patch(`/meeting-intel/${id}/items/${t.id}`,
      { assignee_user_id: priyaR.user.id, due_date: '2030-03-12', due_time: '16:00' }, { token: divya.token });
    assert.equal(edited.status, 200, JSON.stringify(edited.body));
    const ok = await api.post(`/meeting-intel/${id}/items/approve`, { item_ids: [t.id] }, { token: divya.token });
    assert.equal(ok.body.data.results[0].ok, true, JSON.stringify(ok.body));
    const task = await db.get('SELECT * FROM action_items WHERE id = ?', [ok.body.data.results[0].action_item_id]);
    assert.deepEqual([task.owner_id, task.due_date, task.due_time], [priyaR.user.id, '2030-03-12', '16:00']);
  });

  test('a speaker mapped by the reviewer becomes the assignee', async () => {
    const res = await api.put(`/meeting-intel/${id}/speakers`, { speakers: { 'Speaker B': rahul.user.id } }, { token: divya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const t = res.body.data.items.find((it) => it.title === 'Share the budget sheet');
    assert.equal(t.assignee_user_id, rahul.user.id);
    assert.equal(t.verified, true);
  });

  test('an ambiguous deadline blocks approval until the reviewer sets or clears it', async () => {
    let t = (await api.get(`/meeting-intel/${id}`, { token: divya.token })).body.data.items.find((it) => it.title === 'Prepare the client FAQ');
    assert.equal(t.verified, false);
    const res = await api.patch(`/meeting-intel/${id}/items/${t.id}`, { due_date: '' }, { token: divya.token });
    t = res.body.data.items.find((it) => it.title === 'Prepare the client FAQ');
    assert.equal(t.deadline_status, 'none');
    assert.equal(t.verified, true);
  });

  test('two reviewers approving the same task at once create one task', async () => {
    const t = (await api.get(`/meeting-intel/${id}`, { token: ownerToken })).body.data.items.find((it) => it.title === 'Share the budget sheet');
    const [a, b] = await Promise.all([
      api.post(`/meeting-intel/${id}/items/approve`, { item_ids: [t.id] }, { token: divya.token }),
      api.post(`/meeting-intel/${id}/items/approve`, { item_ids: [t.id] }, { token: ownerToken }),
    ]);
    const wins = [a, b].flatMap((r) => r.body.data?.results || []).filter((r) => r.ok);
    assert.equal(wins.length, 1, JSON.stringify([a.body, b.body]));
    const n = await db.pluck("SELECT COUNT(*) FROM action_items WHERE source_type = 'meeting_ai' AND source_id = ?", [t.id]);
    assert.equal(Number(n), 1);
  });

  test('rejecting the rest completes the meeting, and history counts add up', async () => {
    const res = await api.post(`/meeting-intel/${id}/items/reject`, { all: true, reason: 'Not this sprint' }, { token: divya.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const mm = res.body.data.meeting;
    assert.equal(mm.status, 'completed');
    assert.equal(mm.items_approved, 4);
    assert.equal(mm.items_rejected, 3);
    const hist = await api.get('/meeting-intel?tab=history', { token: divya.token });
    assert.ok(hist.body.data.some((h) => h.id === id && h.items_approved === 4));
  });

  test('a manager does not see other people\'s meetings; the owner sees all', async () => {
    const ownersOwn = await uploadTranscript(ownerToken, 'Arun: Karthik, renew the domain.');
    assert.equal((await api.get(`/meeting-intel/${ownersOwn}`, { token: divya.token })).status, 404);
    assert.equal((await api.get(`/meeting-intel/${id}`, { token: ownerToken })).status, 200);
  });

  test('the public task API cannot forge a meeting source', async () => {
    const res = await api.post('/action-items', { title: 'Forged', owner_id: rahul.user.id, source_type: 'meeting_ai', source_id: 'x' }, { token: ownerToken });
    assert.ok([400, 422].includes(res.status));
  });
});

describe('deadlines without a meeting date', () => {
  test('a relative deadline needs the meeting date before it can be approved', async () => {
    intel.setMeetingProvidersForTests(scriptedAnalysis({
      ...ANALYSIS,
      action_items: [item({ title: 'Send the invoice', assignee_name: 'Rahul', deadline_text: 'tomorrow', deadline_status: 'needs_meeting_date' })],
    }));
    try {
      const id = await uploadTranscript(divya.token, 'Divya: Rahul, send the invoice tomorrow.', { meeting_date: '' });
      const m = await runToRest(divya.token, id);
      assert.match(lastPrompt, /Meeting date: not provided/);
      assert.equal(m.items[0].deadline_status, 'needs_meeting_date');
      assert.equal(m.items[0].due_date, null);
      assert.equal(m.items[0].verified, false);
    } finally { intel.setMeetingProvidersForTests(null); }
  });
});

describe('failures and retries', () => {
  test('analysis failing is recorded, retried, then recoverable', async () => {
    let calls = 0;
    intel.setMeetingProvidersForTests({ analyze: async () => { calls++; throw new Error('model overloaded'); } });
    const id = await uploadTranscript(divya.token, 'Divya: Rahul, call the client.');
    let m = await runToRest(divya.token, id);
    for (let i = 0; i < 3 && m.status !== 'failed'; i++) m = (await api.post(`/meeting-intel/${id}/advance`, {}, { token: divya.token })).body.data;
    assert.equal(m.status, 'failed');
    assert.equal(m.failed_stage, 'analyzing');
    assert.match(m.error, /model overloaded/);
    assert.equal(calls, 3, 'tried three times before giving up');

    intel.setMeetingProvidersForTests(scriptedAnalysis({ ...ANALYSIS, action_items: [item({ title: 'Call the client', assignee_name: 'Rahul' })] }));
    const retried = await api.post(`/meeting-intel/${id}/retry`, {}, { token: divya.token });
    assert.equal(retried.status, 200);
    m = await runToRest(divya.token, id);
    assert.equal(m.status, 'review');
    intel.setMeetingProvidersForTests(null);
  });

  test('without AI configured the meeting fails clearly instead of hanging', async () => {
    intel.setMeetingProvidersForTests(null);
    const id = await uploadTranscript(divya.token, 'Divya: Rahul, call the client.');
    const m = await runToRest(divya.token, id);
    assert.equal(m.status, 'failed');
    assert.match(m.error, /not configured/);
  });

  test('the same file again is flagged before processing', async () => {
    const bytes = Buffer.from('Divya: hello');
    const sha = crypto.createHash('sha256').update(bytes).digest('hex');
    const body = {
      title: 'Dup', source_kind: 'transcript', file_name: 'd.txt', file_size: bytes.length, file_sha256: sha, consent: true,
      parts: [{ index: 0, size: bytes.length, mime: 'text/plain' }],
    };
    assert.equal((await api.post('/meeting-intel', body, { token: divya.token })).status, 201);
    const again = await api.post('/meeting-intel', body, { token: divya.token });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'duplicate_upload');
    assert.equal((await api.post('/meeting-intel', { ...body, allow_duplicate: true }, { token: divya.token })).status, 201);
  });

  test('an out-of-order chunk is refused and a repeated chunk is not appended twice', async () => {
    const bytes = Buffer.from('Divya: Rahul, finish the report.');
    const res = await api.post('/meeting-intel', {
      title: 'Chunks', source_kind: 'transcript', file_name: 'c.txt', file_size: bytes.length, consent: true,
      parts: [{ index: 0, size: bytes.length, mime: 'text/plain' }],
    }, { token: divya.token });
    const id = res.body.data.id;
    assert.equal((await putChunk(divya.token, id, 0, 5, bytes.subarray(5))).status, 409);
    assert.equal((await putChunk(divya.token, id, 0, 0, bytes.subarray(0, 10))).status, 200);
    const dup = await putChunk(divya.token, id, 0, 0, bytes.subarray(0, 10));
    assert.equal(dup.body.data.duplicate, true);
    const done = await putChunk(divya.token, id, 0, 10, bytes.subarray(10));
    assert.equal(done.body.data.complete, true);
    const stored = await db.get("SELECT size_bytes FROM stored_files WHERE path = ?", [`meetings/${owner.tenant.id}/${id}/part-0`]);
    assert.equal(Number(stored.size_bytes), bytes.length);
  });
});

describe('a recording (two audio parts)', () => {
  test('parts are transcribed in turn, stitched with offsets, speakers scoped per part, audio deleted', async () => {
    const seen = [];
    intel.setMeetingProvidersForTests({
      transcribe: async (buf, mime) => {
        seen.push(buf.length);
        return [{ start: 1, end: 3, speaker: 'Speaker A', text: seen.length === 1 ? 'Rahul, send the report.' : 'Okay, sending it today.' }];
      },
      ...scriptedAnalysis({ ...ANALYSIS, action_items: [item({ title: 'Send the report', assignee_name: 'Rahul', evidence_segments: [0] })] }),
    });
    try {
      const a = crypto.randomBytes(3000);
      const b = crypto.randomBytes(2000);
      const res = await api.post('/meeting-intel', {
        title: 'Recorded standup', meeting_date: '2030-03-04', source_kind: 'recording', file_name: 'standup.mp4',
        file_size: 9_000_000, consent: true,
        parts: [{ index: 0, size: a.length, mime: 'audio/wav', offset_seconds: 0 }, { index: 1, size: b.length, mime: 'audio/wav', offset_seconds: 600 }],
      }, { token: divya.token });
      assert.equal(res.status, 201, JSON.stringify(res.body));
      const id = res.body.data.id;
      await putChunk(divya.token, id, 0, 0, a);
      await putChunk(divya.token, id, 1, 0, b);
      const m = await runToRest(divya.token, id);
      assert.equal(m.status, 'review', JSON.stringify(m.error));
      assert.deepEqual(seen, [3000, 2000]);
      assert.deepEqual(m.transcript.map((s) => [s.start, s.speaker]), [[1, 'Speaker A (part 1)'], [601, 'Speaker A (part 2)']]);
      assert.ok(m.audio_purged_at, 'audio is deleted once transcribed');
      const left = await db.pluck(`SELECT COUNT(*) FROM stored_files WHERE path LIKE ?`, [`meetings/%/${id}/%`]);
      assert.equal(Number(left), 0);
    } finally { intel.setMeetingProvidersForTests(null); }
  });

  test('a transcription failure is retried, then marked failed with the reason', async () => {
    intel.setMeetingProvidersForTests({ transcribe: async () => { throw new Error('audio could not be decoded'); } });
    try {
      const a = crypto.randomBytes(1000);
      const res = await api.post('/meeting-intel', {
        title: 'Broken audio', source_kind: 'recording', file_name: 'x.mp3', file_size: 1000, consent: true,
        parts: [{ index: 0, size: a.length, mime: 'audio/wav' }],
      }, { token: divya.token });
      const id = res.body.data.id;
      await putChunk(divya.token, id, 0, 0, a);
      let m = await runToRest(divya.token, id);
      for (let i = 0; i < 4 && m.status !== 'failed'; i++) m = (await api.post(`/meeting-intel/${id}/advance`, {}, { token: divya.token })).body.data;
      assert.equal(m.status, 'failed');
      assert.equal(m.failed_stage, 'transcribing');
      assert.match(m.error, /could not be decoded/);
    } finally { intel.setMeetingProvidersForTests(null); }
  });
});
