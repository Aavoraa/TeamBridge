import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();
const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const { setMailSender, inviteEmail } = await import('../src/services/mailer.js');
const api = await startServer();
after(() => { setMailSender(null); api.close(); });

const owner = await signUpTenant(api, { agency_name: 'Bulk Co', email: 'owner@bulk.test', owner_name: 'Arun Prakash' });
const auth = { token: owner.access_token };

test('without a mail server, invites are created and links returned, nothing is emailed', async () => {
  const res = await api.post('/users/bulk-invite', {
    people: [{ name: 'Meena Iyer', email: 'meena@bulk.test', role: 'manager' }],
  }, auth);
  assert.equal(res.status, 201);
  const d = res.body.data;
  assert.equal(d.invited, 1);
  assert.equal(d.emailed, 0);
  assert.equal(d.email_configured, false);
  assert.equal(d.results[0].email_status, 'not_configured');
  assert.match(d.results[0].invite_url, /accept-invite\?token=/);
});

test('a batch: valid rows invited and emailed, bad and duplicate rows skipped, managers linked', async () => {
  const sent = [];
  setMailSender(async (m) => { sent.push(m); return m.to === 'bounce@bulk.test' ? { ok: false, error: 'mailbox full' } : { ok: true, ref: 'x' }; });

  const res = await api.post('/users/bulk-invite', {
    people: [
      { name: 'Ravi Kumar', email: 'RAVI@bulk.test', role: 'employee', designation: 'Designer', manager_email: 'meena@bulk.test' },
      { name: 'Divya S', email: 'divya@bulk.test', role: 'employee', manager_email: 'lead@bulk.test' },
      { name: 'Lead Person', email: 'lead@bulk.test', role: 'manager' },
      { name: 'Ravi Again', email: 'ravi@bulk.test' },
      { name: 'Meena Copy', email: 'meena@bulk.test' },
      { name: 'X', email: 'not-an-email' },
      { name: 'Bounce Me', email: 'bounce@bulk.test' },
      { name: 'Ghost Boss', email: 'ghost@bulk.test', manager_email: 'nobody@bulk.test' },
    ],
  }, auth);
  assert.equal(res.status, 201);
  const d = res.body.data;
  assert.equal(d.invited, 5);
  assert.equal(d.skipped, 3);
  assert.equal(d.emailed, 4);
  assert.deepEqual(d.results.map((r) => r.row), [1, 2, 3, 4, 5, 6, 7, 8]);

  const by = Object.fromEntries(d.results.map((r) => [`${r.row}`, r]));
  assert.equal(by[4].reason, 'Listed twice');
  assert.equal(by[5].reason, 'Already in this workspace');
  assert.equal(by[6].status, 'skipped');
  assert.equal(by[7].email_status, 'failed');
  assert.equal(by[7].email_error, 'mailbox full');
  assert.match(by[8].reason, /nobody@bulk\.test not found/);

  const ravi = await db.get("SELECT u.status, u.manager_id, m.email AS manager FROM users u LEFT JOIN users m ON m.id = u.manager_id WHERE u.email = 'ravi@bulk.test'");
  assert.equal(ravi.status, 'invited');
  assert.equal(ravi.manager, 'meena@bulk.test');
  const divya = await db.get("SELECT m.email AS manager FROM users u JOIN users m ON m.id = u.manager_id WHERE u.email = 'divya@bulk.test'");
  assert.equal(divya.manager, 'lead@bulk.test', 'a manager from the same batch is linked');

  const mail = sent.find((m) => m.to === 'ravi@bulk.test');
  assert.match(mail.subject, /Bulk Co/);
  assert.match(mail.text, /Arun Prakash has invited you/);
  assert.ok(mail.html.includes(by[1].invite_url.replace(/&/g, '&amp;')));
  assert.equal(mail.replyTo, 'owner@bulk.test');
  setMailSender(null);
});

test('an emailed link works once to set a password', async () => {
  setMailSender(async () => ({ ok: true }));
  const res = await api.post('/users/bulk-invite', { people: [{ name: 'Sam Lee', email: 'sam@bulk.test' }] }, auth);
  const t = new URL(res.body.data.results[0].invite_url).searchParams.get('token');
  const body = {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  };
  assert.equal((await api.post('/auth/accept-invite', body)).status, 200);
  assert.notEqual((await api.post('/auth/accept-invite', body)).status, 200);
  setMailSender(null);
});

test('single invite and resend also email when a mail server is set', async () => {
  const sent = [];
  setMailSender(async (m) => { sent.push(m.to); return { ok: true }; });
  const one = await api.post('/users', { name: 'Nila R', email: 'nila@bulk.test', role: 'hr' }, auth);
  assert.equal(one.body.data.email_status, 'sent');
  const again = await api.post(`/users/${one.body.data.id}/resend-invite`, {}, auth);
  assert.equal(again.body.data.email_status, 'sent');
  assert.deepEqual(sent, ['nila@bulk.test', 'nila@bulk.test']);
  setMailSender(null);
});

test('only people who can add users may bulk invite, and the list is bounded', async () => {
  const inv = await api.post('/users', { name: 'Emp One', email: 'emp@bulk.test', role: 'employee' }, auth);
  const t = new URL(inv.body.data.invite_url).searchParams.get('token');
  const emp = await api.post('/auth/accept-invite', {
    token: t, password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?', security_answer: 'Trichy Road',
  });
  const denied = await api.post('/users/bulk-invite', { people: [{ name: 'Zed Z', email: 'z@bulk.test' }] },
    { token: emp.body.data.access_token });
  assert.equal(denied.status, 403);
  assert.equal((await api.post('/users/bulk-invite', { people: [] }, auth)).status, 422);
});

test('invite email escapes names', () => {
  const m = inviteEmail({ name: '<b>Eve</b>', workspace: 'A & B', invitedBy: 'Me', role: 'Employee', url: 'https://x/accept-invite?token=a&b' });
  assert.ok(!m.html.includes('<b>Eve</b>'));
  assert.ok(m.html.includes('A &amp; B'));
  assert.equal(m.subject, "You're invited to join A & B on TeamBridge");
});
