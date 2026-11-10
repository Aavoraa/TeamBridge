import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
delete process.env.FCM_SERVICE_ACCOUNT;
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const fcm = await import('../src/services/fcm.js');
const api = await startServer();
after(() => { fcm.setFcmSender(null); api.close(); });

const owner = await signUpTenant(api, { agency_name: 'Phone Co', email: 'owner@phone.test' });
const ownerToken = owner.access_token;
let emp;
before(async () => {
  const invite = await api.post('/users', { name: 'Pavi Phone', email: 'pavi@phone.test', role: 'employee' }, { token: ownerToken });
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const acc = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Main Road',
  });
  emp = { user: invite.body.data, token: acc.body.data.access_token };
});

const PHONE = `fcm-token-${'x'.repeat(40)}`;

test('with no Firebase key the phone channel is off, and registering still works', async () => {
  const res = await api.post('/notifications/push/device', { token: PHONE }, { token: emp.token });
  assert.equal(res.status, 201);
  assert.equal(res.body.data.sending, false);
  const cfg = (await api.get('/notifications/push/config', { token: emp.token })).body.data;
  assert.equal(cfg.phones_enabled, false);
  assert.equal(cfg.registered_phones, 1);
});

test('a task assigned to someone reaches their phone, with the page to open', async () => {
  const sent = [];
  fcm.setFcmSender(async (token, payload) => { sent.push({ token, payload }); return { name: 'ok' }; });
  const res = await api.post('/action-items', { title: 'Call the bank', owner_id: emp.user.id }, { token: ownerToken });
  assert.equal(res.status, 201);
  const msg = sent.find((s) => s.token === PHONE);
  assert.ok(msg, 'sent to the phone');
  assert.match(msg.payload.message.notification.title, /Call the bank/);
  assert.match(msg.payload.message.data.link, new RegExp(`/action-items\\?open=${res.body.data.id}`));
  assert.equal(msg.payload.message.android.notification.channel_id, 'general');
});

test('the same phone signed in by someone else now belongs to them', async () => {
  await api.post('/notifications/push/device', { token: PHONE }, { token: ownerToken });
  const rows = await db.all('SELECT user_id FROM native_push_devices WHERE token = ?', [PHONE]);
  assert.deepEqual(rows.map((r) => r.user_id), [owner.user.id]);
  await api.post('/notifications/push/device', { token: PHONE }, { token: emp.token });
});

test('a phone Firebase has forgotten is dropped', async () => {
  fcm.setFcmSender(async () => { throw new fcm.GoneDevice('UNREGISTERED'); });
  await api.post('/notifications/push/test', {}, { token: emp.token });
  const n = await db.pluck('SELECT COUNT(*) FROM native_push_devices WHERE token = ?', [PHONE]);
  assert.equal(Number(n), 0);
});

test('signing out removes the phone', async () => {
  fcm.setFcmSender(async () => ({}));
  await api.post('/notifications/push/device', { token: PHONE }, { token: emp.token });
  await api.post('/notifications/push/device/remove', { token: PHONE }, { token: emp.token });
  assert.equal(Number(await db.pluck('SELECT COUNT(*) FROM native_push_devices')), 0);
});

test('the service account key is read as JSON or base64, and a bad one leaves it off', () => {
  fcm.setFcmSender(null);
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { project_id: 'p', client_email: 'a@p.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  process.env.FCM_SERVICE_ACCOUNT = JSON.stringify(key);
  assert.equal(fcm.fcmConfigured(), true);
  process.env.FCM_SERVICE_ACCOUNT = Buffer.from(JSON.stringify(key)).toString('base64');
  assert.equal(fcm.fcmConfigured(), true);
  process.env.FCM_SERVICE_ACCOUNT = 'not a key';
  assert.equal(fcm.fcmConfigured(), false);
  delete process.env.FCM_SERVICE_ACCOUNT;
});
