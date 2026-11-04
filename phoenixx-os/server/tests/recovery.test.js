import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const QUESTION = 'What was the name of the first street you lived on as a child?';
const ANSWER = 'Trichy Road';
const PASSWORD = 'Password@123';

/**
 * One tenant for the whole file, and members added through the invitation flow.
 * Signup and login are both rate limited per IP, and every test here runs from
 * 127.0.0.1 - so members arrive via `POST /users` + `accept-invite`, which hands
 * back a session without spending a login.
 */
const owner = await signUpTenant(api, { agency_name: 'Recovery Agency', email: 'rec-owner@test.test' });
const ownerToken = owner.access_token;

/** A member who has set the question, plus their signed-in token. */
async function memberWithQuestion(email, { answer = ANSWER, name = 'Team Member' } = {}) {
  const invited = await api.post('/users', { name, email, role: 'employee' }, { token: ownerToken });
  assert.equal(invited.status, 201, JSON.stringify(invited.body));

  const inviteToken = new URL(invited.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken, password: PASSWORD, security_question: QUESTION, security_answer: answer,
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invited.body.data.id, token: accepted.body.data.access_token };
}

/** A member created straight from the admin form - active, but no question. */
async function memberWithoutQuestion(email) {
  const res = await api.post('/users',
    { name: 'No Question', email, role: 'employee', password: PASSWORD }, { token: ownerToken });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const start = (email) => api.post('/auth/recovery/start', { email });
const verify = (email, answer, extra = {}) => api.post('/auth/recovery/verify', { email, answer, ...extra });
const reset = (resetToken, newPassword) => api.post('/auth/recovery/reset',
  { reset_token: resetToken, new_password: newPassword });

describe('setting a security question', () => {
  test('the suggestion list is public, so a setup form can render it before sign-in', async () => {
    const res = await api.get('/auth/security-questions');
    assert.equal(res.status, 200);
    assert.ok(res.body.data.questions.length >= 5);
  });

  test('an account that never set one reports itself unconfigured', async () => {
    const res = await api.get('/auth/security-question', { token: ownerToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.configured, false);
    assert.equal(res.body.data.question, null);
  });

  test('the question reads back but the answer never does', async () => {
    const member = await memberWithQuestion('q-set@test.test');

    const res = await api.get('/auth/security-question', { token: member.token });
    assert.equal(res.body.data.configured, true);
    assert.equal(res.body.data.question, QUESTION);
    assert.ok(res.body.data.updated_at);
    assert.ok(!JSON.stringify(res.body).toLowerCase().includes('trichy'),
      'no endpoint ever returns the answer');

    // Changing it needs the current password: a hijacked session must not be
    // able to plant a recovery answer the real owner does not know.
    const wrongPassword = await api.put('/auth/security-question',
      { question: QUESTION, answer: 'Something else', password: 'NotMyPassword@1' }, { token: member.token });
    assert.equal(wrongPassword.status, 400);
    assert.ok(wrongPassword.body.error.details.some((d) => d.field === 'password'));

    // And the answer cannot just be the question typed back.
    const lazy = await api.put('/auth/security-question',
      { question: QUESTION, answer: QUESTION, password: PASSWORD }, { token: member.token });
    assert.equal(lazy.status, 400);
  });

  test('an owner can see who is covered without seeing any answer', async () => {
    const res = await api.get('/users', { token: ownerToken });
    assert.equal(res.status, 200);
    const covered = res.body.data.find((u) => u.email === 'q-set@test.test');
    assert.equal(covered.has_security_question, 1);
    assert.ok(!('security_answer_hash' in covered), 'the hash is never listed');
  });
});

describe('recovering a password with the question', () => {
  test('the three steps end with the new password working and the old one dead', async () => {
    await memberWithQuestion('rec-happy@test.test');

    const asked = await start('rec-happy@test.test');
    assert.equal(asked.status, 200);
    assert.equal(asked.body.data.available, true);
    assert.equal(asked.body.data.question, QUESTION);
    assert.equal(asked.body.data.totp_required, false);

    const verified = await verify('rec-happy@test.test', ANSWER);
    assert.equal(verified.status, 200);
    assert.ok(verified.body.data.reset_token);
    assert.equal(verified.body.data.access_token, undefined,
      'answering a question does not sign anybody in - only the reset step acts');

    const done = await reset(verified.body.data.reset_token, 'BrandNew@2026');
    assert.equal(done.status, 200);

    const fresh = await api.post('/auth/login', { email: 'rec-happy@test.test', password: 'BrandNew@2026' });
    assert.equal(fresh.status, 200, 'the new password signs in');

    const stale = await api.post('/auth/login', { email: 'rec-happy@test.test', password: PASSWORD });
    assert.equal(stale.status, 401, 'the old password no longer works');
  });

  test('the answer is matched loosely on case, spacing and a trailing full stop', async () => {
    await memberWithQuestion('rec-loose@test.test');
    const res = await verify('rec-loose@test.test', '  trichy   ROAD. ');
    assert.equal(res.status, 200, 'formatting differences must not lock people out');
  });

  test('a reset token is single use and a made-up one is refused', async () => {
    await memberWithQuestion('rec-once@test.test');
    const verified = await verify('rec-once@test.test', ANSWER);

    assert.equal((await reset(verified.body.data.reset_token, 'FirstGo@2026')).status, 200);
    assert.equal((await reset(verified.body.data.reset_token, 'SecondGo@2026')).status, 400,
      'the same token cannot be replayed');
    assert.equal((await reset('not-a-real-token', 'Whatever@2026')).status, 400);
  });

  test('a short new password is rejected with a field-level message', async () => {
    const again = await verify('rec-once@test.test', ANSWER);
    const res = await reset(again.body.data.reset_token, 'short');
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.some((d) => d.field === 'new_password'));
  });

  test('a reset revokes the sessions that were already open', async () => {
    const member = await memberWithQuestion('rec-sessions@test.test');
    const before = await api.get('/auth/sessions', { token: member.token });
    assert.equal(before.status, 200);
    assert.ok(before.body.data.some((s) => !s.revoked_at), 'the accept-invite session is live to begin with');

    const verified = await verify('rec-sessions@test.test', ANSWER);
    await reset(verified.body.data.reset_token, 'Rotated@2026');

    const login = await api.post('/auth/login', { email: 'rec-sessions@test.test', password: 'Rotated@2026' });
    const listed = await api.get('/auth/sessions', { token: login.body.data.access_token });
    const older = listed.body.data.filter((s) => s.id !== undefined).slice(1);
    assert.ok(older.every((s) => s.revoked_at), 'every session that predates the reset is signed out');
  });
});

describe('recovery does not become the soft way in', () => {
  test('an unknown email and one with no question look identical', async () => {
    await memberWithoutQuestion('rec-noq@test.test');

    const ghost = await start('nobody@nowhere.test');
    const noQuestion = await start('rec-noq@test.test');

    assert.equal(ghost.status, noQuestion.status);
    assert.deepEqual(ghost.body.data, noQuestion.body.data,
      'nothing here distinguishes a registered address from an unregistered one');
    assert.equal(ghost.body.data.available, false);
  });

  test('an account that never set a question cannot be reset through this route', async () => {
    const res = await verify('rec-noq@test.test', 'anything at all');
    assert.equal(res.status, 400);
  });

  test('wrong answers count down and then lock the account out', async () => {
    await memberWithQuestion('rec-lock@test.test');

    for (let i = 1; i <= 4; i += 1) {
      const res = await verify('rec-lock@test.test', `wrong-${i}`);
      assert.equal(res.status, 400, `attempt ${i} is refused`);
      assert.match(res.body.error.message, /before recovery locks/, 'the user is told how many tries remain');
    }

    const fifth = await verify('rec-lock@test.test', 'wrong-5');
    assert.equal(fifth.status, 429);
    assert.equal(fifth.body.error.code, 'recovery_locked');

    const rightButLocked = await verify('rec-lock@test.test', ANSWER);
    assert.equal(rightButLocked.status, 429, 'even the correct answer waits out the lockout');

    const asked = await start('rec-lock@test.test');
    assert.equal(asked.body.data.available, false);
    assert.equal(asked.body.data.locked, true);
  });

  test('a correct answer clears the failures behind it', async () => {
    await memberWithQuestion('rec-clear@test.test');
    await verify('rec-clear@test.test', 'wrong once');
    await verify('rec-clear@test.test', 'wrong twice');

    assert.equal((await verify('rec-clear@test.test', ANSWER)).status, 200);

    // Two more wrong answers would tip a counter that had carried over.
    assert.equal((await verify('rec-clear@test.test', 'wrong again')).status, 400);
    assert.equal((await verify('rec-clear@test.test', 'wrong once more')).status, 400,
      'the counter restarted rather than carrying over');
  });

  test('a disabled account gives nothing away and resets nothing', async () => {
    const member = await memberWithQuestion('rec-disabled@test.test');
    await api.patch(`/users/${member.id}`, { status: 'disabled' }, { token: ownerToken });

    assert.equal((await start('rec-disabled@test.test')).body.data.available, false);
    assert.equal((await verify('rec-disabled@test.test', ANSWER)).status, 400);
  });
});

describe('accepting an invitation', () => {
  test('the invitee must set a question while setting their password', async () => {
    const invited = await api.post('/users',
      { name: 'New Joiner', email: 'inv-joiner@test.test', role: 'employee' }, { token: ownerToken });
    const inviteToken = new URL(invited.body.data.invite_url).searchParams.get('token');

    const without = await api.post('/auth/accept-invite', { token: inviteToken, password: 'Joiner@2026' });
    assert.equal(without.status, 422, 'the question is not optional on the setup form');

    const accepted = await api.post('/auth/accept-invite', {
      token: inviteToken,
      password: 'Joiner@2026',
      security_question: QUESTION,
      security_answer: 'Race Course Road',
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.ok(accepted.body.data.access_token, 'they are still signed straight in');

    const asked = await start('inv-joiner@test.test');
    assert.equal(asked.body.data.available, true, 'and recovery works immediately');
    assert.equal(asked.body.data.question, QUESTION);
  });
});

describe('signup', () => {
  test('an owner can set their question while creating the workspace', async () => {
    const res = await api.post('/auth/signup', {
      agency_name: 'Question At Signup',
      owner_name: 'Founder',
      email: 'signup-q@test.test',
      password: PASSWORD,
      plan_code: 'growth',
      security_question: QUESTION,
      security_answer: 'Avinashi Road',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await start('signup-q@test.test')).body.data.available, true);
  });

  test('leaving it out still works, so an existing integration is unaffected', async () => {
    const res = await api.post('/auth/signup', {
      agency_name: 'No Question At Signup',
      owner_name: 'Founder',
      email: 'signup-noq@test.test',
      password: PASSWORD,
      plan_code: 'growth',
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal((await start('signup-noq@test.test')).body.data.available, false);
  });
});
