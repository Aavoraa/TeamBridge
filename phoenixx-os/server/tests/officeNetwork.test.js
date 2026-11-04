/**
 * Office-network attendance check.
 *
 * The server decides whether a check-in came from the office by the public
 * address the request arrived from - here supplied the way the hosting proxy
 * supplies it, as X-Forwarded-For. Nothing in the request body takes part, so
 * a client claiming to be on the office Wi-Fi gets nowhere.
 */
import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const { todayInTz, timeInTz } = await import('../src/lib/dueTime.js');

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Netcheck Co', email: 'owner@net.test' });
const token = owner.access_token;
const tenantId = (await db.get('SELECT id FROM tenants ORDER BY created_at DESC LIMIT 1')).id;

const TZ = 'Asia/Kolkata';
const OFFICE_IP = '49.206.113.67';
const from = (ip) => ({ 'X-Forwarded-For': ip });

const join = async (name, email) => {
  const invite = await api.post('/users', { name, email, role: 'employee' }, { token });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken,
    password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { id: invite.body.data.id, token: accepted.body.data.access_token, name };
};

const checkIn = (who, ip, body = {}) => api.post('/hr/attendance/check-in', body,
  { token: who.token, headers: ip ? from(ip) : {} });

const rowFor = async (who) => await db.get(
  'SELECT * FROM attendance WHERE tenant_id = ? AND user_id = ? AND work_date = ?',
  [tenantId, who.id, todayInTz(TZ)],
);

// Shift starting now, so nobody in this file is late and the only thing being
// judged is the network.
const now = timeInTz(TZ);
await api.patch('/hr/work-schedules', { work_start: now < '23:00' ? now : '23:00', work_end: '23:59' }, { token });

let n = 0;
const employee = () => { n += 1; return join(`Person ${n}`, `p${n}@net.test`); };

describe('network settings', () => {
  test('a private LAN range is refused with an explanation', async () => {
    const res = await api.post('/hr/networks',
      { network_name: 'Airtel', ssid: 'Airtel_renn_1546-5G', public_ip: '192.168.1.0/24' }, { token });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /private network address/);
  });

  test('a range too wide to be one office is refused', async () => {
    const res = await api.post('/hr/networks', { network_name: 'Wide', public_ip: '49.0.0.0/8' }, { token });
    assert.equal(res.status, 400);
  });

  test('HR adds, edits and lists a public address', async () => {
    const res = await api.post('/hr/networks',
      { network_name: 'ACT office', ssid: 'ACTFIBERNET', public_ip: OFFICE_IP }, { token });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const edited = await api.patch(`/hr/networks/${res.body.data.id}`, { description: 'ACT router' }, { token });
    assert.equal(edited.body.data.description, 'ACT router');
    const list = await api.get('/hr/networks', { token });
    assert.equal(list.body.data.enabled, false, 'the check starts off');
    assert.equal(list.body.data.networks.length, 1);
  });

  test('an employee cannot see or change the network list', async () => {
    const e = await employee();
    assert.equal((await api.get('/hr/networks', { token: e.token })).status, 403);
    assert.equal((await api.post('/hr/networks', { network_name: 'Mine', public_ip: '8.8.8.8' },
      { token: e.token })).status, 403);
  });

  test('Test reports the address HR is on and whether it matches', async () => {
    const hit = await api.get('/hr/networks/test', { token, headers: from(OFFICE_IP) });
    assert.equal(hit.body.data.ip, OFFICE_IP);
    assert.equal(hit.body.data.matched, true);
    const miss = await api.get('/hr/networks/test', { token, headers: from('8.8.8.8') });
    assert.equal(miss.body.data.matched, false);
  });
});

describe('check-in with the check switched off', () => {
  test('trial run: a miss is recorded for HR but the day stays present', async () => {
    const e = await employee();
    const res = await checkIn(e, '8.8.8.8');
    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'present');
    assert.equal(res.body.data.message, 'Check-in successful.', 'the employee is told nothing about a trial');
    const row = await rowFor(e);
    assert.equal(row.network_verified, 0);
    assert.equal(row.client_ip, '8.8.8.8');
    assert.equal(row.review_reason, null);
  });

  test('trial run: a match is recorded too', async () => {
    const e = await employee();
    await checkIn(e, OFFICE_IP);
    assert.equal((await rowFor(e)).network_verified, 1);
  });

  test('HR sees the trial result on "who is in today"', async () => {
    const t = await api.get('/hr/attendance/today', { token });
    const hit = t.body.data.team.find((r) => r.client_ip === OFFICE_IP);
    assert.equal(hit.network_verified, 1);
    assert.equal(hit.network_name, 'ACT office');
  });
});

describe('check-in with the check switched on', () => {
  test('switching it on', async () => {
    const res = await api.patch('/hr/networks/settings', { enabled: true }, { token });
    assert.equal(res.body.data.enabled, true);
  });

  test('1. approved network -> present', async () => {
    const e = await employee();
    const res = await checkIn(e, OFFICE_IP);
    assert.equal(res.body.data.status, 'present');
    assert.equal(res.body.data.network_verified, 1);
    assert.match(res.body.data.message, /approved company network/);
    assert.equal(res.body.data.client_ip, undefined, 'the employee is not shown the address');
    assert.equal((await rowFor(e)).client_ip, OFFICE_IP, 'but it is on the record for HR');
  });

  test('2. unapproved network -> pending HR review', async () => {
    const e = await employee();
    const res = await checkIn(e, '103.21.244.9');
    assert.equal(res.body.data.status, 'pending_approval');
    assert.equal(res.body.data.network_verified, 0);
    assert.deepEqual(res.body.data.review_reasons, ['off_network']);
    assert.match(res.body.data.message, /sent to HR for review/);
  });

  test('3/4. no usable network information -> pending HR review', async () => {
    const e = await employee();
    const res = await checkIn(e, null); // straight to the server, loopback address
    assert.equal(res.body.data.status, 'pending_approval');
  });

  test('6. a Wi-Fi name or IP claimed in the body is ignored', async () => {
    const e = await employee();
    const res = await checkIn(e, '103.21.244.10',
      { wifi: 'ACTFIBERNET', ssid: 'ACTFIBERNET', ip: OFFICE_IP, network_verified: true, status: 'present' });
    assert.equal(res.body.data.status, 'pending_approval');
    assert.equal(res.body.data.network_verified, 0);
  });

  test('a disabled network no longer approves anyone', async () => {
    const list = await api.get('/hr/networks', { token });
    const id = list.body.data.networks[0].id;
    await api.patch(`/hr/networks/${id}`, { is_active: false }, { token });
    const e = await employee();
    assert.equal((await checkIn(e, OFFICE_IP)).body.data.status, 'pending_approval');
    await api.patch(`/hr/networks/${id}`, { is_active: true }, { token });
  });

  test('a CIDR range covers every address in it', async () => {
    await api.post('/hr/networks', { network_name: 'Airtel office', public_ip: '117.98.188.0/24' }, { token });
    const e = await employee();
    assert.equal((await checkIn(e, '117.98.188.200')).body.data.status, 'present');
  });

  test('9. duplicate check-in -> one record, first verdict kept', async () => {
    const e = await employee();
    await checkIn(e, '103.21.244.11');
    const again = await checkIn(e, OFFICE_IP);
    assert.equal(again.body.data.already_checked_in, true);
    assert.equal(again.body.data.status, 'pending_approval', 'a later office request does not upgrade it');
    const count = (await db.get('SELECT COUNT(*) AS c FROM attendance WHERE user_id = ?', [e.id])).c;
    assert.equal(count, 1);
  });

  test('HR sees the network details in the review queue', async () => {
    const pending = await api.get('/hr/attendance/pending', { token });
    const row = pending.body.data.find((r) => r.client_ip === '103.21.244.9');
    assert.ok(row, 'off-network row with its address');
    assert.equal(row.verification_method, 'public_ip');
  });

  test('7. HR approves -> present with the approver recorded; a second ruling is refused', async () => {
    const e = await employee();
    const { id } = (await checkIn(e, '103.21.244.12')).body.data;
    const res = await api.post(`/hr/attendance/${id}/decide`, { decision: 'approve', note: 'Client visit' }, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'present');
    assert.ok(res.body.data.approved_by);
    const second = await api.post(`/hr/attendance/${id}/decide`, { decision: 'reject', note: 'Too late' }, { token });
    assert.equal(second.status, 400);
    const events = await db.all('SELECT event FROM attendance_events WHERE attendance_id = ? ORDER BY seq', [id]);
    assert.deepEqual(events.map((x) => x.event), ['checked_in', 'approved']);
  });

  test('8. HR rejects -> not approved', async () => {
    const e = await employee();
    const { id } = (await checkIn(e, '103.21.244.13')).body.data;
    const res = await api.post(`/hr/attendance/${id}/decide`, { decision: 'reject', note: 'Was working from home' }, { token });
    assert.equal(res.body.data.status, 'not_approved');
  });

  test('5. offline-queued mobile check-in cannot be verified -> pending', async () => {
    const e = await employee();
    const res = await api.post('/sync/queue', {
      operations: [{ client_id: 'queued-1', type: 'attendance.check_in', payload: {}, created_at: new Date().toISOString() }],
    }, { token: e.token, headers: from(OFFICE_IP) });
    assert.ok([200, 201].includes(res.status), JSON.stringify(res.body));
    const row = await rowFor(e);
    assert.equal(row.status, 'pending_approval');
    assert.equal(row.review_reason, 'offline');
  });

  test('behind Render (internal 10.x hop) the Cloudflare client IP is used', async () => {
    const e = await employee();
    const res = await api.post('/hr/attendance/check-in', {}, {
      token: e.token,
      headers: { 'X-Forwarded-For': '10.26.34.133', 'CF-Connecting-IP': OFFICE_IP },
    });
    assert.equal(res.body.data.status, 'present');
    const t = await api.get('/hr/networks/test', {
      token, headers: { 'X-Forwarded-For': '10.26.34.133', 'CF-Connecting-IP': OFFICE_IP },
    });
    assert.equal(t.body.data.ip, OFFICE_IP);
    assert.equal(t.body.data.diagnostics.proxy_ip, '10.26.34.133');
  });

  test('a CF-Connecting-IP header on a request that did not come through the proxy is ignored', async () => {
    const e = await employee();
    const res = await api.post('/hr/attendance/check-in', {}, {
      token: e.token,
      headers: { 'X-Forwarded-For': '103.21.244.20', 'CF-Connecting-IP': OFFICE_IP },
    });
    assert.equal(res.body.data.status, 'pending_approval');
  });

  test('listing a network after the fact re-verifies today\'s check-ins from it', async () => {
    const early = await employee();
    const elsewhere = await employee();
    await checkIn(early, '122.173.241.132');
    await checkIn(elsewhere, '106.192.170.132');
    assert.equal((await rowFor(early)).status, 'pending_approval');

    const res = await api.post('/hr/networks',
      { network_name: 'Airtel fibre', ssid: 'Airtel_renn_1546-5G', public_ip: '122.173.241.132' }, { token });
    assert.equal(res.body.data.rechecked, 1);

    const row = await rowFor(early);
    assert.equal(row.network_verified, 1);
    assert.equal(row.status, 'present', 'waiting on the network alone, so it settles');
    assert.equal(row.review_reason, null);
    assert.ok(row.approved_by);
    const events = await db.all('SELECT event FROM attendance_events WHERE attendance_id = ? ORDER BY seq', [row.id]);
    assert.deepEqual(events.map((x) => x.event), ['checked_in', 'network_verified']);

    const other = await rowFor(elsewhere);
    assert.equal(other.network_verified, 0, 'a different address is left alone');
    assert.equal(other.status, 'pending_approval');
  });

  test('a late check-in keeps its lateness for HR after the network is re-verified', async () => {
    const e = await employee();
    await checkIn(e, '117.99.1.5');
    await db.run("UPDATE attendance SET review_reason = 'late,off_network' WHERE id = ?", [(await rowFor(e)).id]);
    await api.post('/hr/networks', { network_name: 'Second line', public_ip: '117.99.1.5' }, { token });
    const row = await rowFor(e);
    assert.equal(row.network_verified, 1);
    assert.equal(row.status, 'pending_approval');
    assert.equal(row.review_reason, 'late');
  });

  test('the owner still does not check in', async () => {
    const res = await checkIn({ token }, OFFICE_IP);
    assert.equal(res.status, 403);
  });
});
