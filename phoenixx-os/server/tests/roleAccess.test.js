import test, { before } from 'node:test';
import { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Access Co', email: 'owner@access.test' });
const ownerAuth = { token: owner.access_token };
const other = await signUpTenant(api, { agency_name: 'Other Co', email: 'owner@other.test' });

async function join(api, auth, name, email, role) {
  const invite = await api.post('/users', { name, email, role }, auth);
  const t = new URL(invite.body.data.invite_url).searchParams.get('token');
  const acc = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Main Road',
  });
  return { user: invite.body.data, auth: { token: acc.body.data.access_token } };
}

let emp; let hr; let otherEmp;
before(async () => {
  emp = await join(api, ownerAuth, 'Esha', 'esha@access.test', 'employee');
  hr = await join(api, ownerAuth, 'Hari', 'hari@access.test', 'hr');
  otherEmp = await join(api, { token: other.access_token }, 'Omar', 'omar@other.test', 'employee');
});

const me = async (auth) => (await api.get('/auth/me', auth)).body.data.permissions;

test('every role starts on its built-in access', async () => {
  const res = await api.get('/settings/access', ownerAuth);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.can_edit, true);
  assert.deepEqual(res.body.data.roles.employee.access.sop, ['view']);
  assert.deepEqual(res.body.data.roles.employee.access.crm, [], 'employees get no clients or pipeline by default');
  assert.equal(res.body.data.roles.employee.customised_at, null);
  assert.equal(res.body.data.roles.employee.people, 1);
  assert.ok(!res.body.data.modules.includes('platform'));
});

test('the owner takes the SOP library away from employees: menu and server both follow at once', async () => {
  assert.equal((await api.get('/sop', emp.auth)).status, 200);
  const access = (await api.get('/settings/access', ownerAuth)).body.data.roles.employee.access;
  const res = await api.put('/settings/access/employee', { permissions: { ...access, sop: [] } }, ownerAuth);
  assert.equal(res.status, 200, JSON.stringify(res.body));

  assert.deepEqual((await me(emp.auth)).sop, [], 'the menu reads this, so the SOP library disappears');
  assert.equal((await api.get('/sop', emp.auth)).status, 403, 'and the server refuses it');
  assert.equal((await api.get('/sop', otherEmp.auth)).status, 200, 'another workspace is untouched');
});

test('granting an action brings view with it, and the bell can never be switched off', async () => {
  const access = (await api.get('/settings/access', ownerAuth)).body.data.roles.employee.access;
  const res = await api.put('/settings/access/employee',
    { permissions: { ...access, invoices: ['export'], notifications: [], platform: ['view'] } }, ownerAuth);
  assert.deepEqual(res.body.data.access.invoices, ['view', 'export']);
  assert.deepEqual(res.body.data.access.notifications, ['view']);
  assert.deepEqual(res.body.data.access.platform, []);
  assert.equal((await api.get('/invoices', emp.auth)).status, 200);
});

test('reset returns the role to its built-in access', async () => {
  const res = await api.del('/settings/access/employee', ownerAuth);
  assert.equal(res.status, 200);
  assert.deepEqual((await me(emp.auth)).sop, ['view']);
  assert.equal((await api.get('/invoices', emp.auth)).status, 403);
});

test('only the owner changes access; owners and clients are not editable', async () => {
  const access = (await api.get('/settings/access', hr.auth)).body.data;
  assert.equal(access.can_edit, false, 'HR may look');
  assert.equal((await api.put('/settings/access/employee', { permissions: {} }, hr.auth)).status, 403);
  assert.equal((await api.put('/settings/access/employee', { permissions: {} }, emp.auth)).status, 403);
  assert.equal((await api.put('/settings/access/owner', { permissions: {} }, ownerAuth)).status, 400);
  assert.equal((await api.put('/settings/access/client', { permissions: {} }, ownerAuth)).status, 400);
  assert.equal((await api.put('/settings/access/employee', { permissions: { nope: ['view'] } }, ownerAuth)).status, 400);
});
