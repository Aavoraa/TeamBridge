/**
 * When AWS rotates the production database password, the running app is left
 * holding the old one and every query fails with "password authentication
 * failed" (Postgres code 28P01). In production the app then exits so systemd
 * restarts it with the current password; nowhere else does it exit.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { restartIfPasswordRotated } from '../src/db/driver.js';

const rejected = Object.assign(new Error('password authentication failed for user "teambridge"'), { code: '28P01' });
const prod = { NODE_ENV: 'production' };

test('other database errors never restart the app', () => {
  let exited = false;
  const other = Object.assign(new Error('duplicate key'), { code: '23505' });
  assert.equal(restartIfPasswordRotated(other, { env: prod, exit: () => { exited = true; } }), false);
  assert.equal(restartIfPasswordRotated(new Error('no code'), { env: prod, exit: () => { exited = true; } }), false);
  assert.equal(exited, false);
});

test('outside production a rejected password is only thrown, not a restart', () => {
  assert.equal(restartIfPasswordRotated(rejected, { env: { NODE_ENV: 'development' }, exit: () => assert.fail('exited') }), false);
  assert.equal(restartIfPasswordRotated(rejected, { env: { ...prod, DB_AUTH_FAILURE_EXIT: 'false' }, exit: () => assert.fail('exited') }), false);
});

test('in production a rejected password exits once, so systemd restarts with the new one', async () => {
  const codes = [];
  const exit = (code) => codes.push(code);
  assert.equal(restartIfPasswordRotated(rejected, { env: prod, exit }), true);
  assert.equal(restartIfPasswordRotated(rejected, { env: prod, exit }), true, 'a burst of failures schedules one exit');
  await new Promise((r) => setTimeout(r, 700));
  assert.deepEqual(codes, [1]);
});
