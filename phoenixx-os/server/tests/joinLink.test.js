import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const { setMailSender } = await import('../src/services/mailer.js');
const api = await startServer();
after(() => { setMailSender(null); api.close(); });

const owner = await signUpTenant(api, { agency_name: 'Join Co', email: 'owner@join.test', owner_name: 'Arun Prakash' });
const auth = { token: owner.access_token };
const SQ = { security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road' };
const signup = (over = {}) => ({
  name: 'Priya Raman', role: 'manager', designation: 'Delivery Lead', department: 'Delivery',
  password: 'Password@123', ...SQ, ...over,
});
const tokenOf = (url) => url.split('/join/')[1];
const links = {};

test('the owner invites specific people; each gets a personal link (emailed when mail is set up)', async () => {
  const sent = [];
  setMailSender(async (m) => { sent.push(m); return { ok: true }; });
  const res = await api.post('/team-join/invites', {
    people: [
      { email: 'Priya@join.test', name: 'Priya Raman' },
      { email: 'random@join.test' },
      { email: 'priya@join.test' },
      { email: 'owner@join.test' },
      { email: 'nope' },
    ],
  }, auth);
  assert.equal(res.status, 201);
  const d = res.body.data;
  assert.equal(d.invited, 2);
  assert.equal(d.skipped, 3);
  assert.equal(d.emailed, 2);
  assert.deepEqual(d.results.map((r) => r.reason || r.status),
    ['invited', 'invited', 'Listed twice', 'Already has an account', 'Not a valid email']);
  links.priya = tokenOf(d.results[0].invite_url);
  links.random = tokenOf(d.results[1].invite_url);

  assert.match(sent[0].subject, /join Join Co/);
  assert.match(sent[0].text, /Arun Prakash has invited you/);
  assert.match(sent[0].text, /review it/);
  assert.equal(sent[0].to, 'priya@join.test');
  setMailSender(null);

  const pub = await api.get(`/public/join/${links.priya}`);
  assert.equal(pub.body.data.workspace, 'Join Co');
  assert.equal(pub.body.data.email, 'priya@join.test', 'the link knows who it is for');
  assert.equal(pub.body.data.name, 'Priya Raman');
  assert.equal((await api.get('/public/join/not-a-real-token-at-all')).status, 404);

  const open = await api.get('/team-join/invites', auth);
  assert.deepEqual(open.body.data.map((i) => i.email).sort(), ['priya@join.test', 'random@join.test']);
});

test('the invitee creates their own account for the invited email; it waits for approval', async () => {
  const res = await api.post(`/public/join/${links.priya}`, signup({ email: 'someone-else@join.test' }));
  assert.equal(res.status, 201);
  assert.equal(res.body.data.email, 'priya@join.test', 'a typed-in email is ignored');

  assert.equal(await db.get("SELECT id FROM users WHERE email = 'priya@join.test'"), undefined);
  const login = await api.post('/auth/login', { email: 'priya@join.test', password: 'Password@123' });
  assert.equal(login.status, 403);
  assert.match(login.body.error.message, /waiting for approval from the owner, HR or a manager/);
  assert.equal((await api.post('/auth/login', { email: 'priya@join.test', password: 'WrongGuess1' })).status, 401);

  const note = await db.get("SELECT title FROM notifications WHERE event_key = 'team.join_request' AND channel = 'in_app'");
  assert.match(note.title, /Priya Raman \(Manager\)/);

  assert.equal((await api.get(`/public/join/${links.priya}`)).status, 404, 'the link works once');
  assert.equal((await api.post(`/public/join/${links.priya}`, signup())).status, 404);
  const open = await api.get('/team-join/invites', auth);
  assert.deepEqual(open.body.data.map((i) => i.email), ['random@join.test'], 'used invites leave the open list');

  const again = await api.post('/team-join/invites', { people: [{ email: 'priya@join.test' }] }, auth);
  assert.equal(again.body.data.results[0].reason, 'Already signed up - waiting for your approval');
  const weak = await api.post(`/public/join/${links.random}`, signup({ password: 'short' }));
  assert.equal(weak.status, 422);
});

let hrAuth; let mgrAuth; let mgrId;
test('the owner and HR invite; a manager decides only employee sign-ups', async () => {
  const inv = await api.post('/users', { name: 'Hari HR', email: 'hr@join.test', role: 'hr' }, auth);
  const t = new URL(inv.body.data.invite_url).searchParams.get('token');
  const hr = await api.post('/auth/accept-invite', { token: t, password: 'Password@123', ...SQ });
  hrAuth = { token: hr.body.data.access_token };
  assert.equal((await api.get('/team-join/requests', hrAuth)).status, 200);
  const sent = await api.post('/team-join/invites', { people: [{ email: 'x@join.test' }] }, hrAuth);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal((await api.post(`/team-join/invites/${sent.body.data.results[0].id}/revoke`, {}, hrAuth)).status, 200);

  const mInv = await api.post('/users', { name: 'Mani Manager', email: 'mani@join.test', role: 'manager' }, auth);
  const mt = new URL(mInv.body.data.invite_url).searchParams.get('token');
  const mgr = { token: (await api.post('/auth/accept-invite', { token: mt, password: 'Password@123', ...SQ })).body.data.access_token };
  const seen = await api.get('/team-join/requests', mgr);
  assert.equal(seen.status, 200, 'a manager sees sign-ups');
  assert.equal(seen.body.meta.pending, 0, 'but not the one asking to join as a manager');
  const mgrReq = (await api.get('/team-join/requests', auth)).body.data[0];
  assert.equal((await api.post(`/team-join/requests/${mgrReq.id}/approve`, {}, mgr)).status, 403);
  assert.equal((await api.post(`/team-join/requests/${mgrReq.id}/reject`, {}, mgr)).status, 403);
  assert.equal((await api.post('/team-join/invites', { people: [{ email: 'y@join.test' }] }, mgr)).status, 403, 'inviting stays with the owner and HR');
  mgrAuth = mgr;
  mgrId = mInv.body.data.id;
});

test('approving creates the account with the role the owner settles on; they can then sign in', async () => {
  const sent = [];
  setMailSender(async (m) => { sent.push(m); return { ok: true }; });
  const list = await api.get('/team-join/requests', auth);
  assert.equal(list.body.meta.pending, 1);
  const req = list.body.data[0];
  assert.equal(req.requested_role, 'manager');
  assert.equal(req.password_hash, undefined, 'the password hash never leaves the server');

  const ok = await api.post(`/team-join/requests/${req.id}/approve`, { role: 'employee', manager_id: owner.user.id }, auth);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.role, 'employee');
  assert.equal(ok.body.data.email_status, 'sent');
  assert.match(sent[0].subject, /You're in: Join Co/);

  const u = await db.get("SELECT role, status, manager_id, designation, security_question FROM users WHERE email = 'priya@join.test'");
  assert.deepEqual([u.role, u.status, u.manager_id, u.designation], ['employee', 'active', owner.user.id, 'Delivery Lead']);
  assert.ok(u.security_question, 'their security question carries over');

  const login = await api.post('/auth/login', { email: 'priya@join.test', password: 'Password@123' });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.user.role, 'employee');
  assert.equal((await api.post(`/team-join/requests/${req.id}/approve`, {}, auth)).status, 404, 'cannot approve twice');
  setMailSender(null);
});

test('rejecting closes the request and wipes the stored password', async () => {
  await api.post(`/public/join/${links.random}`, signup({ name: 'Random Person', role: 'finance' }));
  const req = (await api.get('/team-join/requests', auth)).body.data[0];
  const res = await api.post(`/team-join/requests/${req.id}/reject`, { note: 'Not on our team' }, auth);
  assert.equal(res.status, 200);
  const row = await db.get('SELECT status, password_hash, decision_note FROM join_requests WHERE id = ?', [req.id]);
  assert.deepEqual([row.status, row.password_hash, row.decision_note], ['rejected', '', 'Not on our team']);
  assert.equal(await db.get("SELECT id FROM users WHERE email = 'random@join.test'"), undefined);
});

test('resending gives a fresh link and kills the old one; revoking stops it', async () => {
  const res = await api.post('/team-join/invites', { people: [{ email: 'late@join.test', name: 'Late Comer' }] }, auth);
  const first = tokenOf(res.body.data.results[0].invite_url);
  const id = res.body.data.results[0].id;

  const resent = await api.post(`/team-join/invites/${id}/resend`, {}, auth);
  const second = tokenOf(resent.body.data.invite_url);
  assert.notEqual(second, first);
  assert.equal((await api.get(`/public/join/${first}`)).status, 404);
  assert.equal((await api.get(`/public/join/${second}`)).status, 200);

  const again = await api.post('/team-join/invites', { people: [{ email: 'late@join.test' }] }, auth);
  assert.equal(again.body.data.results[0].status, 'resent', 'inviting the same address again re-sends it');
  const third = tokenOf(again.body.data.results[0].invite_url);
  assert.equal((await api.get(`/public/join/${second}`)).status, 404);

  assert.equal((await api.post(`/team-join/invites/${id}/revoke`, {}, auth)).status, 200);
  assert.equal((await api.get(`/public/join/${third}`)).status, 404);
  assert.equal((await api.get('/team-join/invites', auth)).body.data.length, 0);
});

test('HR sends an invite, is told when the person signs up, and approves them', async () => {
  const res = await api.post('/team-join/invites', { people: [{ email: 'devi@join.test', name: 'Devi' }] }, hrAuth);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const link = tokenOf(res.body.data.results[0].invite_url);
  assert.equal((await api.post(`/public/join/${link}`, signup({ name: 'Devi Kumar', role: 'employee' }))).status, 201);

  const hrNotes = (await api.get('/notifications', hrAuth)).body.data;
  assert.ok(hrNotes.some((n) => /Devi Kumar/.test(n.title)), 'HR hears about the sign-up too');

  const req = (await api.get('/team-join/requests', hrAuth)).body.data.find((r) => r.email === 'devi@join.test');
  const ok = await api.post(`/team-join/requests/${req.id}/approve`, { role: 'employee' }, hrAuth);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await api.post('/auth/login', { email: 'devi@join.test', password: 'Password@123' })).status, 200);
});

test('a manager approves an employee sign-up, who then reports to them', async () => {
  const res = await api.post('/team-join/invites', { people: [{ email: 'kavin@join.test', name: 'Kavin' }] }, auth);
  const link = tokenOf(res.body.data.results[0].invite_url);
  assert.equal((await api.post(`/public/join/${link}`, signup({ name: 'Kavin Raj', role: 'employee' }))).status, 201);

  const notes = (await api.get('/notifications', mgrAuth)).body.data;
  assert.ok(notes.some((n) => /Kavin Raj/.test(n.title)), 'managers hear about employee sign-ups');

  const req = (await api.get('/team-join/requests', mgrAuth)).body.data.find((r) => r.email === 'kavin@join.test');
  assert.ok(req, 'the manager sees the employee request');
  assert.equal((await api.post(`/team-join/requests/${req.id}/approve`, { role: 'hr' }, mgrAuth)).status, 403,
    'a manager cannot turn a sign-up into another role');
  const ok = await api.post(`/team-join/requests/${req.id}/approve`, {}, mgrAuth);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.role, 'employee');
  const user = await db.get('SELECT manager_id FROM users WHERE id = ?', [ok.body.data.user_id]);
  assert.equal(user.manager_id, mgrId, 'they report to the manager who approved them');
  assert.equal((await api.post('/auth/login', { email: 'kavin@join.test', password: 'Password@123' })).status, 200);
});
