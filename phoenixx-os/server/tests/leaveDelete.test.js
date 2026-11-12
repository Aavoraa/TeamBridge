/**
 * Deleting leave and permission requests.
 *
 * The owner and HR delete any request. The person who applied deletes their
 * own, except approved leave that has already begun. Nobody else deletes
 * anything, and a deleted request is gone from the list.
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Delete Leave Co', email: 'owner@delleave.test' });
const ownerAuth = { token: owner.access_token };

let n = 0;
const person = async (role, managerId = null) => {
  n += 1;
  const invite = await api.post('/users', {
    name: `${role} ${n}`, email: `p${n}@delleave.test`, role, manager_id: managerId,
  }, ownerAuth);
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken,
    password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invite.body.data.id, auth: { token: accepted.body.data.access_token } };
};

const typeId = (await api.get('/hr/leave/types', ownerAuth)).body.data[0].id;

let day = 2;
const apply = async (who) => {
  day += 1;
  // Never a Sunday (the default weekly off), which is not a day of leave.
  if (new Date(`2031-05-${String(day).padStart(2, '0')}T12:00:00Z`).getUTCDay() === 0) day += 1;
  const date = `2031-05-${String(day).padStart(2, '0')}`;
  const res = await api.post('/hr/leave/requests', {
    leave_type_id: typeId, from_date: date, to_date: date, reason: 'Family function',
  }, who.auth);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const remove = (id, auth) => api.del(`/hr/leave/requests/${id}`, auth);
const listed = async (auth, id) => (await api.get('/hr/leave/requests', auth)).body.data.find((r) => r.id === id);

const hr = await person('hr');
const manager = await person('manager');
const employee = await person('employee', manager.id);
const colleague = await person('employee', manager.id);

describe('deleting leave requests', () => {
  test('the person who applied deletes their own pending request, and it is gone', async () => {
    const lr = await apply(employee);
    assert.equal((await listed(employee.auth, lr.id)).can_delete, true);
    const res = await remove(lr.id, employee.auth);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(await listed(ownerAuth, lr.id), undefined);
  });

  test('a colleague or the reporting manager cannot delete someone else\'s request', async () => {
    const lr = await apply(employee);
    assert.equal((await remove(lr.id, colleague.auth)).status, 403);
    assert.equal((await listed(manager.auth, lr.id)).can_delete, false);
    assert.equal((await remove(lr.id, manager.auth)).status, 403);
    assert.ok(await listed(ownerAuth, lr.id), 'still there');
  });

  test('HR and the owner delete anyone\'s request', async () => {
    const a = await apply(employee);
    const b = await apply(colleague);
    assert.equal((await listed(hr.auth, a.id)).can_delete, true);
    assert.equal((await remove(a.id, hr.auth)).status, 200);
    assert.equal((await remove(b.id, ownerAuth)).status, 200);
    assert.equal(await listed(ownerAuth, a.id), undefined);
    assert.equal(await listed(ownerAuth, b.id), undefined);
  });

  test('approved leave that has started is HR\'s to remove, not the employee\'s', async () => {
    const lr = await apply(employee);
    const today = new Date().toISOString().slice(0, 10);
    await db.run("UPDATE leave_requests SET status = 'approved', from_date = ?, to_date = ? WHERE id = ?", [today, today, lr.id]);

    assert.equal((await listed(employee.auth, lr.id)).can_delete, false);
    const mine = await remove(lr.id, employee.auth);
    assert.equal(mine.status, 400);
    assert.match(mine.body.error.message, /Ask HR/);

    assert.equal((await remove(lr.id, hr.auth)).status, 200);
    assert.equal(await listed(ownerAuth, lr.id), undefined);
  });

  test('a deleted approved request gives its days back', async () => {
    const lr = await apply(employee);
    // Casual leave is counted by the month, so the request sits on today.
    const lastDay = new Date().toISOString().slice(0, 10);
    await db.run("UPDATE leave_requests SET status = 'approved', from_date = ?, to_date = ? WHERE id = ?", [lastDay, lastDay, lr.id]);
    const balance = async () => (await api.get('/hr/leave/balances', employee.auth)).body.data
      .find((b) => b.leave_type_id === typeId).used;
    const before = await balance();
    assert.equal((await remove(lr.id, hr.auth)).status, 200);
    assert.equal(await balance(), before - lr.days);
  });
});
