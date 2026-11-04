import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const N = await import('../src/services/notifications.js');

// Nothing leaves the building: the fake records what would have been pushed.
const sent = [];
let failWith = null;
N.setPushSender(async (sub, payload) => {
  if (failWith) { const err = new Error('gone'); err.statusCode = failWith; throw err; }
  sent.push({ endpoint: sub.endpoint, ...JSON.parse(payload) });
});

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Push Agency', email: 'owner@push.test' });
const ownerToken = owner.access_token;
const tenantId = (await db.get("SELECT tenant_id FROM users WHERE email = 'owner@push.test'")).tenant_id;

async function join(name) {
  const email = `${name.toLowerCase()}@push.test`;
  const invite = await api.post('/users', { name, email, role: 'employee' }, { token: ownerToken });
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  return { id: invite.body.data.id, token: accepted.body.data.access_token };
}

const browser = (n) => ({
  endpoint: `https://fcm.googleapis.com/fcm/send/browser-${n}`,
  keys: { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' },
});
const tell = async (userId, eventKey = 'todo.approved') => N.notify({
  tenantId, user: await db.get('SELECT * FROM users WHERE id = ?', [userId]), eventKey,
  vars: { reviewer: 'Mani', todo_day: 'Wed, 7 Oct', todo_date: '2026-10-07' }, link: '/?plan=abc', channels: ['in_app'],
});

let kumar;
before(async () => { kumar = await join('Kumar'); });

describe('browser pop-ups', () => {
  test('nothing is pushed, or recorded, for someone who has not switched them on', async () => {
    await tell(kumar.id);
    assert.equal(sent.length, 0);
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND channel = 'push'", [kumar.id])).n, 0);
  });

  test('a browser switches them on', async () => {
    const res = await api.post('/notifications/push/subscribe', browser(1), { token: kumar.token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const cfg = await api.get('/notifications/push/config', { token: kumar.token });
    assert.equal(cfg.body.data.enabled, true);
    assert.equal(cfg.body.data.subscribed_browsers, 1);
  });

  test('every bell notification also pops up, with its title and link', async () => {
    await tell(kumar.id);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].title, 'Plan approved for Wed, 7 Oct');
    assert.match(sent[0].body, /Mani approved/);
    assert.equal(sent[0].link, '/?plan=abc');
    const row = await db.get("SELECT * FROM notifications WHERE user_id = ? AND channel = 'push'", [kumar.id]);
    assert.equal(row.status, 'delivered');
    // The bell still has exactly one entry for it.
    assert.equal((await db.get("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND channel = 'in_app'", [kumar.id])).n, 2);
  });

  test('each of the person\'s browsers gets it', async () => {
    await api.post('/notifications/push/subscribe', browser(2), { token: kumar.token });
    sent.length = 0;
    await tell(kumar.id);
    assert.deepEqual(sent.map((s) => s.endpoint).sort(), [browser(1).endpoint, browser(2).endpoint]);
  });

  test('switching pop-ups off in preferences stops them', async () => {
    await api.put('/notifications/preferences', { channels: { push: false } }, { token: kumar.token });
    sent.length = 0;
    await tell(kumar.id);
    assert.equal(sent.length, 0);
    await api.put('/notifications/preferences', { channels: { push: true } }, { token: kumar.token });
  });

  test('a browser that has gone away is forgotten', async () => {
    failWith = 410;
    await tell(kumar.id);
    failWith = null;
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [kumar.id])).n, 0);
  });

  test('when someone else signs in on the same browser, it becomes theirs', async () => {
    const arun = await join('Arun');
    await api.post('/notifications/push/subscribe', browser(3), { token: kumar.token });
    await api.post('/notifications/push/subscribe', browser(3), { token: arun.token });
    assert.equal((await db.get('SELECT user_id FROM push_subscriptions WHERE endpoint = ?', [browser(3).endpoint])).user_id, arun.id);
    sent.length = 0;
    await tell(kumar.id);
    assert.equal(sent.length, 0, 'Kumar no longer has a browser');
  });

  test('unsubscribing stops them, and only for your own browser', async () => {
    const arun = await db.get("SELECT id FROM users WHERE email = 'arun@push.test'");
    await api.post('/notifications/push/unsubscribe', { endpoint: browser(3).endpoint }, { token: kumar.token });
    assert.equal((await db.get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [arun.id])).n, 1, 'not Kumar\'s to remove');
  });

  test('a malformed subscription is refused', async () => {
    const res = await api.post('/notifications/push/subscribe', { endpoint: 'not a url', keys: {} }, { token: kumar.token });
    assert.equal(res.status, 422);
  });

  test('the test button sends one, or says why it cannot', async () => {
    assert.equal((await api.post('/notifications/push/test', {}, { token: kumar.token })).status, 400);
    await api.post('/notifications/push/subscribe', browser(4), { token: kumar.token });
    sent.length = 0;
    const res = await api.post('/notifications/push/test', {}, { token: kumar.token });
    assert.equal(res.status, 200);
    assert.equal(sent[0].title, 'Pop-ups are on');
  });
});
