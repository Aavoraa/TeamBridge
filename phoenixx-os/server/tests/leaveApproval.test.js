/**
 * Two-step leave approval.
 *
 * An employee's leave is verified by their reporting manager first, and only
 * then reaches HR for the final word. HR cannot jump the queue, the manager
 * cannot give the final approval, and a manager's rejection is final.
 * Somebody who reports to the Owner goes straight to HR.
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

const owner = await signUpTenant(api, { agency_name: 'Leave Co', email: 'owner@leave.test' });
const token = owner.access_token;

let n = 0;
const person = async (role, managerId = null) => {
  n += 1;
  const invite = await api.post('/users', {
    name: `${role} ${n}`, email: `p${n}@leave.test`, role, manager_id: managerId,
  }, { token });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken,
    password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invite.body.data.id, token: accepted.body.data.access_token };
};

const types = (await api.get('/hr/leave/types', { token })).body.data;
const typeId = types[0].id;

let day = 10;
const apply = async (who) => {
  day += 2;
  // Never a Sunday (the default weekly off), which is not a day of leave.
  if (new Date(`2031-03-${String(day).padStart(2, '0')}T12:00:00Z`).getUTCDay() === 0) day += 1;
  const date = `2031-03-${String(day).padStart(2, '0')}`;
  const res = await api.post('/hr/leave/requests', {
    leave_type_id: typeId, from_date: date, to_date: date, reason: 'Family function',
  }, { token: who.token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
};
const decide = (who, id, decision) =>
  api.post(`/hr/leave/requests/${id}/decide`, { decision }, { token: who.token });

const hr = await person('hr');
const manager = await person('manager');
const employee = await person('employee', manager.id);

describe('leave approval', () => {
  test('goes to the reporting manager first, then HR', async () => {
    const lr = await apply(employee);
    assert.equal(lr.stage, 'manager');

    const early = await decide(hr, lr.id, 'approved');
    assert.equal(early.status, 403, 'HR cannot approve before the manager verifies');

    const verified = await decide(manager, lr.id, 'approved');
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    assert.equal(verified.body.data.status, 'pending');
    assert.equal(verified.body.data.stage, 'hr');
    assert.equal(verified.body.data.manager_approved_by, manager.id);

    const again = await decide(manager, lr.id, 'approved');
    assert.equal(again.status, 403, 'the manager cannot give the final approval');

    const final = await decide(hr, lr.id, 'approved');
    assert.equal(final.status, 200, JSON.stringify(final.body));
    assert.equal(final.body.data.status, 'approved');
  });

  test('a manager rejection is final', async () => {
    const lr = await apply(employee);
    const rejected = await decide(manager, lr.id, 'rejected');
    assert.equal(rejected.status, 200);
    assert.equal(rejected.body.data.status, 'rejected');
  });

  test('somebody reporting to the Owner goes straight to HR', async () => {
    const lead = await person('manager', owner.user?.id ?? null);
    const lr = await apply(lead);
    assert.equal(lr.stage, 'hr');
    const final = await decide(hr, lr.id, 'approved');
    assert.equal(final.status, 200, JSON.stringify(final.body));
    assert.equal(final.body.data.status, 'approved');
  });

  test('the list tells each person whether it is theirs to decide', async () => {
    const lr = await apply(employee);
    const forManager = (await api.get('/hr/leave/requests', { token: manager.token })).body.data;
    const forHr = (await api.get('/hr/leave/requests', { token: hr.token })).body.data;
    assert.equal(forManager.find((r) => r.id === lr.id).can_decide, true);
    assert.equal(forHr.find((r) => r.id === lr.id).can_decide, false);
  });
});
