import test, { describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase();
const intel = await import('../src/services/meetingIntel.js');

const saved = { ...process.env };
afterEach(() => {
  for (const k of ['OPENAI_API_KEY', 'GEMINI_API_KEY', 'TRANSCRIBE_PROVIDER', 'GEMINI_TRANSCRIBE_MODEL']) {
    if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  }
  intel.setMeetingProvidersForTests(null);
});

/** A stand-in for the Gemini client: records what it was sent, answers with `reply`. */
function fakeGemini({ reply, fail, failFor, processingRounds = 1 } = {}) {
  const sent = [];
  const files = { uploaded: [], deleted: [] };
  let rounds = processingRounds;
  // The SDK's shape: ai.models.generateContent, ai.files.upload / get / delete.
  return {
    sent,
    models: {
      generateContent: async (params) => {
        sent.push(params);
        if (fail) throw fail;
        const e = failFor?.(params.model);
        if (e) throw e;
        return { text: typeof reply === 'string' ? reply : JSON.stringify(reply), candidates: [{ finishReason: 'STOP' }] };
      },
    },
    files: {
      upload: async ({ file, config }) => {
        files.uploaded.push({ size: file.size, mimeType: config.mimeType });
        return { name: 'files/abc', state: 'PROCESSING', uri: 'https://gemini.example/files/abc', mimeType: config.mimeType };
      },
      get: async ({ name }) => ({ name, state: --rounds > 0 ? 'PROCESSING' : 'ACTIVE', uri: 'https://gemini.example/files/abc', mimeType: 'audio/ogg' }),
      delete: async ({ name }) => { files.deleted.push(name); },
      uploaded: files.uploaded,
      deleted: files.deleted,
    },
  };
}

describe('choosing the speech-to-text provider', () => {
  test('whichever key is present, OpenAI first, unless TRANSCRIBE_PROVIDER says otherwise', () => {
    delete process.env.TRANSCRIBE_PROVIDER;
    delete process.env.OPENAI_API_KEY;
    process.env.GEMINI_API_KEY = 'g-key';
    assert.equal(intel.transcribeProvider(), 'gemini');
    assert.equal(intel.speechConfigured(), true);

    process.env.OPENAI_API_KEY = 'sk-test';
    assert.equal(intel.transcribeProvider(), 'openai');

    process.env.TRANSCRIBE_PROVIDER = 'Gemini';
    assert.equal(intel.transcribeProvider(), 'gemini');

    delete process.env.GEMINI_API_KEY;
    assert.equal(intel.speechConfigured(), false, 'Gemini chosen but no Gemini key');
  });
});

describe('transcribing with Gemini', () => {
  test('a ten-minute piece goes inline with a strict JSON shape, and comes back as timed, labelled lines', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    const ai = fakeGemini({
      reply: {
        segments: [
          { start: 12.5, end: 15, speaker: 'B', text: 'Priya, please send the proposal by Friday.' },
          { start: 1, end: 4.2, speaker: 'A', text: ' Good morning everyone. ' },
          { start: 20, end: 21, speaker: 'A', text: '   ' },
        ],
      },
    });
    intel.setMeetingProvidersForTests({ gemini: ai });
    const audio = Buffer.from('OggS fake opus audio');
    const lines = await intel.transcribeWithGemini(audio, 'audio/ogg');

    assert.deepEqual(lines, [
      { start: 1, end: 4.2, speaker: 'Speaker A', text: 'Good morning everyone.' },
      { start: 12.5, end: 15, speaker: 'Speaker B', text: 'Priya, please send the proposal by Friday.' },
    ], 'in time order, trimmed, empty lines dropped');

    const [req] = ai.sent;
    assert.equal(req.model, 'gemini-flash-latest', 'follows the current Flash model, so a retired version does not break it');
    const [part, prompt] = req.contents[0].parts;
    assert.equal(part.inlineData.mimeType, 'audio/ogg');
    assert.equal(Buffer.from(part.inlineData.data, 'base64').toString(), 'OggS fake opus audio');
    assert.match(prompt.text, /word for word/);
    assert.match(prompt.text, /Never invent words/);
    assert.equal(req.config.responseMimeType, 'application/json');
    assert.deepEqual(req.config.responseJsonSchema.required, ['segments']);
    assert.equal(req.config.temperature, 0);
    assert.equal(ai.files.uploaded.length, 0, 'small audio is not uploaded as a file');
  });

  test('the model can be changed with GEMINI_TRANSCRIBE_MODEL', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    process.env.GEMINI_TRANSCRIBE_MODEL = 'gemini-2.5-pro';
    const ai = fakeGemini({ reply: { segments: [] } });
    intel.setMeetingProvidersForTests({ gemini: ai });
    assert.deepEqual(await intel.transcribeWithGemini(Buffer.from('x'), 'audio/wav'), []);
    assert.equal(ai.sent[0].model, 'gemini-2.5-pro');
  });

  test('large audio goes through the Files API, waits until it is ready, and is deleted afterwards', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    const ai = fakeGemini({ reply: { segments: [{ start: 0, end: 2, speaker: 'A', text: 'Hello.' }] }, processingRounds: 2 });
    intel.setMeetingProvidersForTests({ gemini: ai });
    const big = Buffer.alloc(15 * 1024 * 1024, 1);
    const lines = await intel.transcribeWithGemini(big, 'audio/x-wav');
    assert.equal(lines.length, 1);
    assert.deepEqual(ai.files.uploaded, [{ size: big.length, mimeType: 'audio/wav' }]);
    const [part] = ai.sent[0].contents[0].parts;
    assert.equal(part.fileData.fileUri, 'https://gemini.example/files/abc');
    assert.deepEqual(ai.files.deleted, ['files/abc']);
  });

  test('the uploaded file is deleted even when transcription fails', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    const ai = fakeGemini({ fail: new Error('{"error":{"code":400,"message":"Unsupported audio"}}') });
    intel.setMeetingProvidersForTests({ gemini: ai });
    await assert.rejects(intel.transcribeWithGemini(Buffer.alloc(15 * 1024 * 1024), 'audio/wav'), /Transcription failed \(Gemini\)/);
    assert.deepEqual(ai.files.deleted, ['files/abc']);
  });

  test('an overloaded or retired model falls back to the next one; when all are busy it tries again later', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    const busy = () => Object.assign(new Error('{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}'), { status: 503 });
    const retired = () => Object.assign(new Error('{"error":{"code":404,"message":"This model is no longer available to new users."}}'), { status: 404 });
    let ai = fakeGemini({ reply: { segments: [{ start: 0, end: 1, speaker: 'A', text: 'Hi.' }] }, failFor: (m) => (m === 'gemini-flash-latest' ? busy() : m === 'gemini-3.5-flash' ? retired() : null) });
    intel.setMeetingProvidersForTests({ gemini: ai });
    assert.equal((await intel.transcribeWithGemini(Buffer.from('x'), 'audio/ogg')).length, 1);
    assert.deepEqual(ai.sent.map((r) => r.model), ['gemini-flash-latest', 'gemini-3.5-flash', 'gemini-flash-lite-latest']);

    ai = fakeGemini({ failFor: () => busy() });
    intel.setMeetingProvidersForTests({ gemini: ai });
    await assert.rejects(intel.transcribeWithGemini(Buffer.from('x'), 'audio/ogg'), (e) => /busy right now/.test(e.message) && !e.permanent);
    assert.equal(ai.sent.length, 3);

    // A bad request is not fixed by another model: no fallback.
    ai = fakeGemini({ failFor: () => Object.assign(new Error('{"error":{"code":400,"message":"bad audio"}}'), { status: 400 }) });
    intel.setMeetingProvidersForTests({ gemini: ai });
    await assert.rejects(intel.transcribeWithGemini(Buffer.from('x'), 'audio/ogg'), /Transcription failed \(Gemini\): .*bad audio/);
    assert.equal(ai.sent.length, 1);
  });

  test('quota errors are retried later; a bad key stops for good; no key says what to add', async () => {
    process.env.GEMINI_API_KEY = 'g-key';
    intel.setMeetingProvidersForTests({ gemini: fakeGemini({ fail: Object.assign(new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'), { status: 429 }) }) });
    await assert.rejects(intel.transcribeWithGemini(Buffer.from('x'), 'audio/ogg'), (e) => /quota or rate limit/.test(e.message) && !e.permanent);

    intel.setMeetingProvidersForTests({ gemini: fakeGemini({ fail: Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 }) }) });
    await assert.rejects(intel.transcribeWithGemini(Buffer.from('x'), 'audio/ogg'), (e) => /API key was refused/.test(e.message) && e.permanent === true);

    intel.setMeetingProvidersForTests({ gemini: fakeGemini({ reply: 'not json at all' }) });
    await assert.rejects(intel.transcribeWithGemini(Buffer.from('x'), 'audio/ogg'), /unreadable reply \(STOP\)/);

    delete process.env.GEMINI_API_KEY;
    intel.setMeetingProvidersForTests(null);
    await assert.rejects(intel.transcribeWithGemini(Buffer.from('x'), 'audio/ogg'), (e) => /GEMINI_API_KEY/.test(e.message) && e.permanent === true);
  });
});
