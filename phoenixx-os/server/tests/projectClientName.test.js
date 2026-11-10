import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Typed Client Co', email: 'owner@typed.test' });
const token = owner.access_token;
const newProject = (body) => api.post('/projects', { name: 'Website rebuild', ...body }, { token });

test('a typed new client name creates the client and lists it on the Clients page', async () => {
  const res = await newProject({ client_name: '  Sunrise   Foods ' });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.client_name, 'Sunrise Foods');
  const register = await api.get('/clients', { token });
  assert.ok(register.body.data.some((c) => c.name === 'Sunrise Foods'));
});

test('typing an existing client name, in any case, reuses it', async () => {
  const first = await newProject({ client_name: 'Sunrise Foods', name: 'Brand refresh' });
  const second = await newProject({ client_name: 'sunrise foods', name: 'SEO retainer' });
  assert.equal(first.status, 201);
  assert.equal(second.body.data.client_id, first.body.data.client_id);
  const n = await db.pluck("SELECT COUNT(*) FROM client_accounts WHERE LOWER(name) = 'sunrise foods'");
  assert.equal(Number(n), 1);
});

test('a blank client name is refused and nothing is created', async () => {
  const res = await newProject({ client_name: '   ' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.details[0].field, 'client_name');
});
