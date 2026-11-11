import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Photo Co', email: 'owner@photo.test' });
const auth = { token: owner.access_token };
const other = await signUpTenant(api, { agency_name: 'Other Co', email: 'owner@other-photo.test' });

// A 1x1 PNG.
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const origin = api.base.replace(/\/api\/v1$/, '');

test('you set your own photo; everyone in the workspace sees its address; the picture loads without sign-in', async () => {
  const res = await api.post('/me/avatar', { image: PNG }, auth);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const url = res.body.data.avatar_url;
  assert.match(url, /^\/api\/v1\/avatars\/[0-9a-f-]{36}\/[0-9a-f-]{36}-[0-9a-f]{16}\.png$/);

  const me = await api.get('/auth/me', auth);
  assert.equal(me.body.data.user.avatar_url, url);
  const dir = await api.get('/users/directory', auth);
  assert.ok(dir.body.data.some((u) => u.avatar_url === url), 'shown to the team');

  const img = await fetch(`${origin}${url}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('cross-origin-resource-policy'), 'cross-origin', 'the phone app can show it');
});

test('a new photo replaces the old one, which stops loading', async () => {
  const first = (await api.get('/auth/me', auth)).body.data.user.avatar_url;
  const res = await api.post('/me/avatar', { image: PNG }, auth);
  assert.notEqual(res.body.data.avatar_url, first);
  assert.equal((await fetch(`${origin}${first}`)).status, 404);
});

test('only real images under 2 MB are taken', async () => {
  const text = `data:image/png;base64,${Buffer.from('<script>alert(1)</script> not a picture').toString('base64')}`;
  assert.equal((await api.post('/me/avatar', { image: text }, auth)).status, 400);
  const big = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(2_100_000)]).toString('base64')}`;
  assert.equal((await api.post('/me/avatar', { image: big }, auth)).status, 400);
  assert.equal((await api.post('/me/avatar', { image: PNG })).status, 401, 'signed in only');
});

test('your profile cannot point the photo at an outside address', async () => {
  const res = await api.patch('/auth/me', { avatar_url: 'https://tracker.example/pixel.png' }, { token: other.access_token });
  assert.equal(res.status, 422);
});

test('removing the photo clears it', async () => {
  const url = (await api.get('/auth/me', auth)).body.data.user.avatar_url;
  const res = await api.del('/me/avatar', auth);
  assert.equal(res.status, 200);
  assert.equal((await api.get('/auth/me', auth)).body.data.user.avatar_url, null);
  assert.equal((await fetch(`${origin}${url}`)).status, 404);
});
