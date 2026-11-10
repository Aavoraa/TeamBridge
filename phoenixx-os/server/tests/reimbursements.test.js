import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant, rupees } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const owner = await signUpTenant(api, { agency_name: 'Claims Agency', email: 'owner@claims.test' });
const ownerToken = owner.access_token;

async function join(name, email, role = 'employee', extra = {}) {
  const invite = await api.post('/users', { name, email, role, ...extra }, { token: ownerToken });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));
  const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
  const accepted = await api.post('/auth/accept-invite', {
    token: inviteToken,
    password: 'Password@123',
    security_question: 'What was the name of the first street you lived on as a child?',
    security_answer: 'Trichy Road',
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
  return { user: invite.body.data, token: accepted.body.data.access_token };
}

const today = new Date().toISOString().slice(0, 10);

let divya; // manager
let priya; // reports to Divya
let rahul; // reports to Divya, used for the "someone else" checks
let sundar; // nobody to report to
let meera; // finance
let categories;
let travel;
let conveyance; // requires_receipt = 0

before(async () => {
  divya = await join('Divya', 'divya@claims.test', 'manager');
  priya = await join('Priya', 'priya@claims.test', 'employee', { manager_id: divya.user.id });
  rahul = await join('Rahul', 'rahul@claims.test', 'employee', { manager_id: divya.user.id });
  sundar = await join('Sundar', 'sundar@claims.test', 'employee');
  meera = await join('Meera', 'meera@claims.test', 'finance');

  categories = (await api.get('/finance/reimbursements/categories', { token: priya.token })).body.data;
  travel = categories.find((c) => c.code === 'travel');
  conveyance = categories.find((c) => c.code === 'local_conveyance');
});

/** A claim, optionally with a receipt already attached. */
async function raise(who, body = {}, { withReceipt = false } = {}) {
  const res = await api.post('/finance/reimbursements', {
    category_id: conveyance.id,
    expense_date: today,
    amount_minor: rupees(1250),
    description: 'Cab to the client office and back',
    ...body,
  }, { token: who.token });
  assert.equal(res.status, 201, JSON.stringify(res.body));

  if (withReceipt) await attach(who, res.body.data.id);
  return res.body.data;
}

const attach = (who, id, filename = 'receipt.txt') => api.post('/files', {
  entity: 'reimbursement',
  entity_id: id,
  filename,
  mime: 'text/plain',
  content_base64: Buffer.from('CAB RECEIPT 1250.00').toString('base64'),
}, { token: who.token });

const submit = (who, id) => api.post(`/finance/reimbursements/${id}/submit`, {}, { token: who.token });

describe('raising a reimbursement request', () => {
  test('a claim starts as a draft and carries the claimant\'s reporting manager', async () => {
    const r = await raise(priya);
    assert.equal(r.status, 'draft');
    assert.equal(r.user_id, priya.user.id);
    assert.equal(r.manager_id, divya.user.id);
    assert.equal(r.number, null, 'a draft does not burn a number');
  });

  test('the amount, the date and the description are validated', async () => {
    const bad = (body) => api.post('/finance/reimbursements',
      { expense_date: today, amount_minor: rupees(100), description: 'Valid enough', ...body },
      { token: priya.token });

    assert.equal((await bad({ amount_minor: 0 })).status, 422);
    assert.equal((await bad({ description: 'no' })).status, 422);
    assert.equal((await bad({ expense_date: '2026/01/01' })).status, 422);
    assert.equal((await bad({ category_id: 'not-a-real-category' })).status, 400);

    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const ahead = await bad({ expense_date: future });
    assert.equal(ahead.status, 400);
    assert.match(ahead.body.error.message, /future/i);
  });

  test('submitting assigns a number and sends it to the reporting manager', async () => {
    const r = await raise(priya);
    const sent = await submit(priya, r.id);

    assert.equal(sent.status, 200, JSON.stringify(sent.body));
    assert.equal(sent.body.data.status, 'submitted');
    assert.match(sent.body.data.number, /^REIMB-\d{4}-\d{4}$/);
    assert.ok(sent.body.data.submitted_at);
    assert.equal(sent.body.data.manager_id, divya.user.id);
  });

  test('numbers start at one and never repeat, however many go in at once', async () => {
    // A fresh workspace, so the sequence is observable from the start.
    const solo = await signUpTenant(api, { agency_name: 'Numbering Agency', email: 'owner@numbers.test' });
    const cat = (await api.get('/finance/reimbursements/categories', { token: solo.access_token }))
      .body.data.find((c) => c.code === 'local_conveyance');

    const raiseOne = async () => {
      const made = await api.post('/finance/reimbursements', {
        category_id: cat.id, expense_date: today, amount_minor: rupees(100), description: 'Parking',
      }, { token: solo.access_token });
      return api.post(`/finance/reimbursements/${made.body.data.id}/submit`, {}, { token: solo.access_token });
    };

    const first = await raiseOne();
    assert.equal(first.body.data.number, `REIMB-${today.slice(0, 4)}-0001`);

    // Submitted together, so a shared read of the counter would collide.
    const rest = await Promise.all([raiseOne(), raiseOne(), raiseOne()]);
    const numbers = [first, ...rest].map((r) => r.body.data.number);
    assert.equal(new Set(numbers).size, 4, `duplicate numbers issued: ${numbers.join(', ')}`);
  });

  test('a category that needs a bill will not submit without one', async () => {
    const r = await raise(priya, { category_id: travel.id, description: 'Flight to Chennai' });
    const blocked = await submit(priya, r.id);
    assert.equal(blocked.status, 400);
    assert.match(blocked.body.error.message, /bill or receipt/i);

    assert.equal((await attach(priya, r.id, 'boarding-pass.txt')).status, 201);
    assert.equal((await submit(priya, r.id)).status, 200, 'goes through once the bill is attached');
  });

  test('with nobody to report to, a claim goes straight to the finance desk', async () => {
    const r = await raise(sundar);
    const sent = await submit(sundar, r.id);
    assert.equal(sent.body.data.status, 'manager_approved');

    const trail = (await api.get(`/finance/reimbursements/${r.id}`, { token: sundar.token })).body.data.history;
    assert.match(trail.at(-1).note, /no reporting manager/i);
  });

  test('a draft can be edited and deleted, a submitted request cannot', async () => {
    const draft = await raise(priya);
    const edited = await api.patch(`/finance/reimbursements/${draft.id}`,
      { amount_minor: rupees(1400), merchant: 'Ola' }, { token: priya.token });
    assert.equal(edited.status, 200);
    assert.equal(edited.body.data.amount_minor, rupees(1400));
    assert.equal((await api.del(`/finance/reimbursements/${draft.id}`, { token: priya.token })).status, 200);

    const sentIn = await raise(priya);
    await submit(priya, sentIn.id);
    const late = await api.patch(`/finance/reimbursements/${sentIn.id}`, { amount_minor: rupees(9999) },
      { token: priya.token });
    assert.equal(late.status, 400, 'the numbers must not move under an approver');
    assert.equal((await api.del(`/finance/reimbursements/${sentIn.id}`, { token: priya.token })).status, 400);
  });

  test('the claimant can withdraw a request nobody has decided on yet', async () => {
    const r = await raise(priya);
    await submit(priya, r.id);
    const pulled = await api.post(`/finance/reimbursements/${r.id}/withdraw`,
      { note: 'Claiming this through the project instead' }, { token: priya.token });
    assert.equal(pulled.body.data.status, 'cancelled');
  });
});

describe('the approval chain', () => {
  test('draft -> submitted -> manager -> finance -> approved -> paid', async () => {
    const r = await raise(priya, { amount_minor: rupees(3200), description: 'Client dinner' });
    await submit(priya, r.id);

    const byManager = await api.post(`/finance/reimbursements/${r.id}/manager-decision`,
      { decision: 'approved', note: 'Genuine client spend' }, { token: divya.token });
    assert.equal(byManager.status, 200, JSON.stringify(byManager.body));
    assert.equal(byManager.body.data.status, 'manager_approved');
    assert.equal(byManager.body.data.manager_decided_by, divya.user.id);

    const byFinance = await api.post(`/finance/reimbursements/${r.id}/finance-decision`,
      { decision: 'approved' }, { token: meera.token });
    assert.equal(byFinance.status, 200, JSON.stringify(byFinance.body));
    assert.equal(byFinance.body.data.status, 'approved');
    assert.equal(byFinance.body.data.approved_minor, rupees(3200), 'the full claim by default');

    const paid = await api.post(`/finance/reimbursements/${r.id}/pay`,
      { payment_method: 'bank_transfer', payment_reference: 'UTR9911', paid_at: today },
      { token: meera.token });
    assert.equal(paid.status, 200, JSON.stringify(paid.body));
    assert.equal(paid.body.data.status, 'paid');
    assert.equal(paid.body.data.paid_minor, rupees(3200));
    assert.equal(paid.body.data.payment_reference, 'UTR9911');

    // Every step is on the record, in order, with who did it.
    const trail = (await api.get(`/finance/reimbursements/${r.id}`, { token: priya.token })).body.data.history;
    assert.deepEqual(trail.map((e) => e.action),
      ['created', 'submitted', 'manager_approved', 'finance_approved', 'paid']);
    assert.equal(trail[2].actor_name, 'Divya');
    assert.equal(trail.at(-1).actor_name, 'Meera');
  });

  test('finance may settle a lower amount than was claimed, but never a higher one', async () => {
    const r = await raise(priya, { amount_minor: rupees(5000), description: 'Team lunch' });
    await submit(priya, r.id);
    await api.post(`/finance/reimbursements/${r.id}/manager-decision`, { decision: 'approved' }, { token: divya.token });

    const tooMuch = await api.post(`/finance/reimbursements/${r.id}/finance-decision`,
      { decision: 'approved', approved_minor: rupees(6000) }, { token: meera.token });
    assert.equal(tooMuch.status, 400);

    const trimmed = await api.post(`/finance/reimbursements/${r.id}/finance-decision`,
      { decision: 'approved', approved_minor: rupees(4000), note: 'Alcohol is not reimbursable' },
      { token: meera.token });
    assert.equal(trimmed.body.data.approved_minor, rupees(4000));

    const overpay = await api.post(`/finance/reimbursements/${r.id}/pay`,
      { payment_method: 'upi', paid_minor: rupees(5000) }, { token: meera.token });
    assert.equal(overpay.status, 400, 'a payment cannot exceed what was approved');
  });

  test('a rejection has to say why, at either gate', async () => {
    const byManager = await raise(priya);
    await submit(priya, byManager.id);
    const silent = await api.post(`/finance/reimbursements/${byManager.id}/manager-decision`,
      { decision: 'rejected' }, { token: divya.token });
    assert.equal(silent.status, 400);
    assert.match(silent.body.error.message, /why/i);

    const reasoned = await api.post(`/finance/reimbursements/${byManager.id}/manager-decision`,
      { decision: 'rejected', note: 'Already covered by the project budget' }, { token: divya.token });
    assert.equal(reasoned.body.data.status, 'rejected');
    assert.equal(reasoned.body.data.rejection_reason, 'Already covered by the project budget');

    const byFinance = await raise(priya);
    await submit(priya, byFinance.id);
    await api.post(`/finance/reimbursements/${byFinance.id}/manager-decision`, { decision: 'approved' }, { token: divya.token });
    assert.equal((await api.post(`/finance/reimbursements/${byFinance.id}/finance-decision`,
      { decision: 'rejected' }, { token: meera.token })).status, 400);
    const out = await api.post(`/finance/reimbursements/${byFinance.id}/finance-decision`,
      { decision: 'rejected', note: 'No supporting bill' }, { token: meera.token });
    assert.equal(out.body.data.status, 'rejected');
  });

  test('a rejected claim can be corrected and sent round again', async () => {
    const r = await raise(priya);
    await submit(priya, r.id);
    await api.post(`/finance/reimbursements/${r.id}/manager-decision`,
      { decision: 'rejected', note: 'Attach the bill' }, { token: divya.token });

    const fixed = await api.patch(`/finance/reimbursements/${r.id}`,
      { description: 'Cab to the client office and back - bill attached' }, { token: priya.token });
    assert.equal(fixed.status, 200);

    const again = await submit(priya, r.id);
    assert.equal(again.body.data.status, 'submitted');
    assert.equal(again.body.data.rejection_reason, null, 'the old rejection is cleared');
  });

  test('the gates cannot be skipped or taken out of order', async () => {
    const r = await raise(priya);
    // Straight to finance, before a manager has seen it.
    assert.equal((await api.post(`/finance/reimbursements/${r.id}/finance-decision`,
      { decision: 'approved' }, { token: meera.token })).status, 400);
    // Paid before it is approved.
    assert.equal((await api.post(`/finance/reimbursements/${r.id}/pay`,
      { payment_method: 'cash' }, { token: meera.token })).status, 400);

    await submit(priya, r.id);
    // Decided twice at the same gate.
    await api.post(`/finance/reimbursements/${r.id}/manager-decision`, { decision: 'approved' }, { token: divya.token });
    assert.equal((await api.post(`/finance/reimbursements/${r.id}/manager-decision`,
      { decision: 'rejected', note: 'Changed my mind' }, { token: divya.token })).status, 400);
  });
});

describe('role-based access', () => {
  test('an employee cannot approve anything, including their own claim', async () => {
    const r = await raise(priya);
    await submit(priya, r.id);

    assert.equal((await api.post(`/finance/reimbursements/${r.id}/manager-decision`,
      { decision: 'approved' }, { token: priya.token })).status, 403);
    assert.equal((await api.post(`/finance/reimbursements/${r.id}/finance-decision`,
      { decision: 'approved' }, { token: priya.token })).status, 403);
    assert.equal((await api.post(`/finance/reimbursements/${r.id}/pay`,
      { payment_method: 'cash' }, { token: priya.token })).status, 403);
  });

  test('a manager cannot approve their own claim at their own gate', async () => {
    // Karthik runs a team of his own but still reports to Divya, so his claim
    // goes to her - and holding `approve` does not let him wave it through.
    const karthik = await join('Karthik', 'karthik@claims.test', 'manager', { manager_id: divya.user.id });
    const r = await raise(karthik, { description: 'Parking at the client site' });
    await submit(karthik, r.id);

    const self = await api.post(`/finance/reimbursements/${r.id}/manager-decision`,
      { decision: 'approved' }, { token: karthik.token });
    assert.equal(self.status, 403, JSON.stringify(self.body));
    assert.match(self.body.error.message, /not yours/i);

    const byDivya = await api.post(`/finance/reimbursements/${r.id}/manager-decision`,
      { decision: 'approved' }, { token: divya.token });
    assert.equal(byDivya.body.data.status, 'manager_approved');
  });

  test('a manager with nobody above them still cannot self-approve - it goes to finance', async () => {
    const r = await raise(divya, { description: 'Toll on the client run' });
    const sent = await submit(divya, r.id);
    assert.equal(sent.body.data.status, 'manager_approved', 'the manager gate is skipped, not self-served');
    assert.equal((await api.post(`/finance/reimbursements/${r.id}/finance-decision`,
      { decision: 'approved' }, { token: divya.token })).status, 403);
  });

  test('a manager cannot decide for somebody outside their team', async () => {
    const outsider = await join('Vignesh', 'vignesh@claims.test', 'employee');
    const r = await raise(outsider);
    await submit(outsider, r.id);
    // Not routed to Divya and not one of her reports, so she cannot even see it.
    assert.equal((await api.get(`/finance/reimbursements/${r.id}`, { token: divya.token })).status, 404);
    assert.equal((await api.post(`/finance/reimbursements/${r.id}/manager-decision`,
      { decision: 'approved' }, { token: divya.token })).status, 404);
  });

  test('a manager holds no finance-desk powers', async () => {
    const r = await raise(priya);
    await submit(priya, r.id);
    await api.post(`/finance/reimbursements/${r.id}/manager-decision`, { decision: 'approved' }, { token: divya.token });

    assert.equal((await api.post(`/finance/reimbursements/${r.id}/finance-decision`,
      { decision: 'approved' }, { token: divya.token })).status, 403);
    assert.equal((await api.get('/finance/reimbursements?queue=finance', { token: divya.token })).status, 403);
    assert.equal((await api.post('/finance/reimbursements/categories',
      { name: 'Sneaky', code: 'sneaky' }, { token: divya.token })).status, 403);
  });

  test('one employee cannot read, alter or even list another employee\'s claim', async () => {
    const r = await raise(priya, { description: 'Confidential travel' });
    await submit(priya, r.id);

    assert.equal((await api.get(`/finance/reimbursements/${r.id}`, { token: rahul.token })).status, 404);
    assert.equal((await api.patch(`/finance/reimbursements/${r.id}`, { amount_minor: 1 }, { token: rahul.token })).status, 404);
    assert.equal((await api.del(`/finance/reimbursements/${r.id}`, { token: rahul.token })).status, 404);

    const list = await api.get('/finance/reimbursements', { token: rahul.token });
    assert.equal(list.body.meta.scope, 'own');
    assert.equal(list.body.data.some((x) => x.id === r.id), false);

    // An employee asking for someone else by id gets their own rows, not theirs.
    const filtered = await api.get(`/finance/reimbursements?user_id=${priya.user.id}`, { token: rahul.token });
    assert.equal(filtered.body.data.length, 0);
  });

  test('the manager and the finance desk see the rows they are meant to', async () => {
    const asManager = await api.get('/finance/reimbursements', { token: divya.token });
    assert.equal(asManager.body.meta.scope, 'team');
    assert.ok(asManager.body.data.some((r) => r.user_id === priya.user.id), 'her reports\' claims are there');
    assert.equal(asManager.body.data.some((r) => r.user_id === sundar.user.id), false,
      'a manager sees their own team and nobody else\'s');

    const asFinance = await api.get('/finance/reimbursements', { token: meera.token });
    assert.equal(asFinance.body.meta.scope, 'all');
    assert.ok(asFinance.body.data.some((r) => r.user_id === sundar.user.id), 'finance sees the whole workspace');
  });

  test('the manager queue only ever contains that manager\'s team', async () => {
    const queue = await api.get('/finance/reimbursements?queue=manager', { token: divya.token });
    assert.equal(queue.status, 200);
    assert.ok(queue.body.data.every((r) => r.status === 'submitted' && r.manager_id === divya.user.id));

    assert.equal((await api.get('/finance/reimbursements?queue=manager', { token: priya.token })).status, 403);
  });

  test('a client-portal user is kept out of the module entirely', async () => {
    const acme = (await api.post('/crm/clients', { name: 'Acme Textiles' }, { token: ownerToken })).body.data;
    const portal = await join('Client Contact', 'contact@acme.test', 'client', { client_id: acme.id });

    assert.equal((await api.get('/finance/reimbursements', { token: portal.token })).status, 403);
    assert.equal((await api.post('/finance/reimbursements',
      { expense_date: today, amount_minor: 100, description: 'Not for you' }, { token: portal.token })).status, 403);
  });
});

describe('supporting documents', () => {
  test('a receipt is only visible to the people who may see the claim', async () => {
    const r = await raise(priya, { description: 'Hotel in Madurai' });
    const uploaded = await attach(priya, r.id, 'hotel-bill.txt');
    assert.equal(uploaded.status, 201);
    await submit(priya, r.id);

    // The claimant, their manager and finance can all read it.
    for (const who of [priya, divya, meera]) {
      const detail = await api.get(`/finance/reimbursements/${r.id}`, { token: who.token });
      assert.equal(detail.status, 200);
      assert.equal(detail.body.data.documents.length, 1);
      assert.equal(detail.body.data.documents[0].filename, 'hotel-bill.txt');
    }

    // A colleague cannot - not by listing, and not by guessing the file URL.
    const listed = await api.get(`/files/list?entity=reimbursement&entity_id=${r.id}`, { token: rahul.token });
    assert.equal(listed.status, 404);

    const path = uploaded.body.data.storage_path;
    assert.equal((await api.get(`/files/${path}`, { token: rahul.token })).status, 404);
    assert.equal((await api.get(`/files/${path}`, { token: priya.token })).status, 200);
  });

  test('a receipt cannot be attached to somebody else\'s claim, or deleted from it', async () => {
    const r = await raise(priya);
    const mine = await attach(priya, r.id);
    assert.equal((await attach(rahul, r.id, 'forged.txt')).status, 404);
    assert.equal((await api.del(`/files/${mine.body.data.id}`, { token: rahul.token })).status, 404);
  });

  test('other kinds of attachment are unaffected by the receipt rule', async () => {
    // Their manager hands the brief to both of them (employees do not assign work).
    const item = (await api.post('/action-items', { title: 'Shared brief', owner_id: priya.user.id, assignee_ids: [rahul.user.id] },
      { token: divya.token })).body.data;
    assert.equal((await api.post('/files', {
      entity: 'action_item', entity_id: item.id, filename: 'brief.txt',
      content_base64: Buffer.from('brief').toString('base64'),
    }, { token: priya.token })).status, 201);
    assert.equal((await api.get(`/files/list?entity=action_item&entity_id=${item.id}`,
      { token: rahul.token })).status, 200);
  });
});

describe('expense and reimbursement reporting', () => {
  test('finance gets totals broken down by status, category, month and person', async () => {
    const res = await api.get('/finance/reimbursements/reports?from=2000-01-01', { token: meera.token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.scope, 'all');
    assert.ok(res.body.data.totals.claimed_minor > 0);
    assert.ok(res.body.data.totals.paid_minor > 0, 'what has actually gone out is tracked separately');
    assert.ok(res.body.data.by_status.length);
    assert.ok(res.body.data.by_category.length);
    assert.ok(res.body.data.by_month.length);
    assert.ok(res.body.data.by_user.some((u) => u.user_id === priya.user.id));
  });

  test('a manager\'s report covers their team and nobody else', async () => {
    const res = await api.get('/finance/reimbursements/reports?from=2000-01-01', { token: divya.token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.scope, 'team');
    assert.ok(res.body.data.by_user.some((u) => u.user_id === priya.user.id), 'her own reports are in it');
    assert.equal(res.body.data.by_user.some((u) => u.user_id === sundar.user.id), false,
      'somebody outside her team is not');
  });

  test('an employee cannot pull company expense reports or the export', async () => {
    assert.equal((await api.get('/finance/reimbursements/reports', { token: priya.token })).status, 403);
    assert.equal((await api.get('/finance/reimbursements/reports/export', { token: priya.token })).status, 403);
  });

  test('the export is a CSV of the rows the caller may see', async () => {
    const res = await api.get('/finance/reimbursements/reports/export?from=2000-01-01', { token: meera.token });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/csv/);
    const [header] = String(res.body.raw ?? res.body).split('\n');
    assert.match(header, /number,employee,email,expense_date,category/);
  });

  test('the queue counters answer what each role is waiting on', async () => {
    const mine = await api.get('/finance/reimbursements/queues', { token: priya.token });
    assert.equal(mine.body.data.finance_pending, 0, 'an employee is told nothing about the finance queue');
    assert.equal(mine.body.data.manager_pending, 0);
    assert.ok(mine.body.data.mine_open >= 0);

    const desk = await api.get('/finance/reimbursements/queues', { token: meera.token });
    assert.ok(desk.body.data.finance_pending >= 0);
  });
});
