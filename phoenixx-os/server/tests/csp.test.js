import test from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase } from './helpers.js';

useTempDatabase();
const { externalSources } = await import('../src/app.js');

test('LiveKit Cloud: its own host plus the regional hosts it hands sessions to', () => {
  const { live } = externalSources({ livekit: { url: 'wss://team-abc.livekit.cloud' }, recordingStorage: {} });
  assert.deepEqual(live, [
    'wss://team-abc.livekit.cloud', 'https://team-abc.livekit.cloud', 'wss://*.livekit.cloud', 'https://*.livekit.cloud',
  ]);
});

test('a self-hosted LiveKit over ws:// stays on ws/http, without the cloud wildcard', () => {
  const { live } = externalSources({ livekit: { url: 'ws://localhost:7880' }, recordingStorage: {} });
  assert.deepEqual(live, ['ws://localhost:7880', 'http://localhost:7880']);
});

test('recordings: the bucket host, or a custom endpoint', () => {
  assert.deepEqual(externalSources({ livekit: {}, recordingStorage: { bucket: 'rec', region: 'ap-southeast-2' } }).media,
    ['https://rec.s3.ap-southeast-2.amazonaws.com', 'https://s3.ap-southeast-2.amazonaws.com']);
  assert.deepEqual(externalSources({ livekit: {}, recordingStorage: { bucket: 'rec', endpoint: 'https://minio.example.com:9000/x' } }).media,
    ['https://minio.example.com:9000']);
});

test('nothing configured, or garbage: no extra sources and no crash', () => {
  assert.deepEqual(externalSources({ livekit: { url: 'not a url' }, recordingStorage: { endpoint: '::' } }), { live: [], media: [] });
});
