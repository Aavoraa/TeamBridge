import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

// Two independent tenants, used throughout to prove isolation holds.
const alpha = await signUpTenant(api, { agency_name: 'Alpha Agency', email: 'owner@alpha.test' });
const beta = await signUpTenant(api, { agency_name: 'Beta Agency', email: 'owner@beta.test' });

const alphaToken = (await api.post('/auth/login', { email: 'owner@alpha.test', password: 'Password@123' })).body.data.access_token;

/** Any active workspace member other than the owner - action items are for somebody else. */
const someoneElse = async () => (await api.get('/users', { token: alphaToken })).body.data
  .find((u) => u.email !== 'owner@alpha.test' && u.role !== 'client').id;
const betaToken = (await api.post('/auth/login', { email: 'owner@beta.test', password: 'Password@123' })).body.data.access_token;

describe('signup and session', () => {
  test('signing up creates a tenant seeded with starter content', async () => {
    const res = await api.get('/settings/service-lines', { token: alphaToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.length >= 4, 'the four service lines are seeded');

    const sops = await api.get('/sop', { token: alphaToken });
    assert.ok(sops.body.data.length > 0, 'SOP packs are seeded');

    const reasons = await api.get('/settings/reason-codes', { token: alphaToken });
    assert.ok(reasons.body.data.some((r) => r.category === 'retention_risk'),
      'retention-risk reason codes exist so the flag can never be free text');
  });

  test('a new tenant starts on a trial', async () => {
    const res = await api.get('/billing/subscription', { token: alphaToken });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.status, 'trial');
    assert.ok(res.body.data.trial_days_left > 0);
  });

  test('the same email cannot sign up twice', async () => {
    const res = await api.post('/auth/signup', {
      agency_name: 'Duplicate', owner_name: 'Dup', email: 'owner@alpha.test', password: 'Password@123',
    });
    assert.equal(res.status, 409);
  });

  test('a weak password is rejected with a field-level message', async () => {
    const res = await api.post('/auth/signup', {
      agency_name: 'Weak', owner_name: 'Weak', email: 'weak@test.test', password: 'short',
    });
    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.some((d) => d.field === 'password'));
  });

  test('bad credentials are rejected without revealing which part was wrong', async () => {
    const wrongPassword = await api.post('/auth/login', { email: 'owner@alpha.test', password: 'nope' });
    const noSuchUser = await api.post('/auth/login', { email: 'ghost@nowhere.test', password: 'nope' });

    assert.equal(wrongPassword.status, 401);
    assert.equal(noSuchUser.status, 401);
    assert.equal(wrongPassword.body.error.message, noSuchUser.body.error.message);
  });

  test('a request without a token is rejected', async () => {
    const res = await api.get('/crm/clients');
    assert.equal(res.status, 401);
  });

  test('a refresh token is rotated on use and the old one stops working', async () => {
    const login = await api.post('/auth/login', { email: 'owner@beta.test', password: 'Password@123' });
    const original = login.body.data.refresh_token;

    const first = await api.post('/auth/refresh', { refresh_token: original });
    assert.equal(first.status, 200);
    assert.ok(first.body.data.access_token);

    const replay = await api.post('/auth/refresh', { refresh_token: original });
    assert.equal(replay.status, 401, 'a used refresh token cannot be replayed');
  });

  test('the session payload carries the permission matrix the UI needs', async () => {
    const res = await api.get('/auth/me', { token: alphaToken });
    assert.equal(res.status, 200);
    assert.ok(res.body.data.permissions.invoices.includes('create'));
    assert.equal(res.body.data.user.role, 'owner');
  });
});

describe('tenant isolation', () => {
  let alphaClientId;

  before(async () => {
    const res = await api.post('/crm/clients', { name: 'Alpha Client', industry: 'textiles' }, { token: alphaToken });
    assert.equal(res.status, 201);
    alphaClientId = res.body.data.id;
  });

  test("one tenant's client is invisible to another", async () => {
    const mine = await api.get(`/crm/clients/${alphaClientId}`, { token: alphaToken });
    assert.equal(mine.status, 200);

    const theirs = await api.get(`/crm/clients/${alphaClientId}`, { token: betaToken });
    assert.equal(theirs.status, 404, 'not 403 - the record simply does not exist for them');
  });

  test("one tenant cannot update another's client", async () => {
    const res = await api.patch(`/crm/clients/${alphaClientId}`, { name: 'Hijacked' }, { token: betaToken });
    assert.equal(res.status, 404);

    const check = await api.get(`/crm/clients/${alphaClientId}`, { token: alphaToken });
    assert.equal(check.body.data.name, 'Alpha Client', 'the record is untouched');
  });

  test('list endpoints only ever return the calling tenant rows', async () => {
    await api.post('/crm/clients', { name: 'Beta Client' }, { token: betaToken });

    const alphaList = await api.get('/crm/clients', { token: alphaToken });
    const betaList = await api.get('/crm/clients', { token: betaToken });

    assert.ok(alphaList.body.data.every((c) => c.name !== 'Beta Client'));
    assert.ok(betaList.body.data.every((c) => c.name !== 'Alpha Client'));
  });

  test('dashboards are computed per tenant', async () => {
    const a = await api.get('/dashboard/overview', { token: alphaToken });
    const b = await api.get('/dashboard/overview', { token: betaToken });
    assert.equal(a.status, 200);
    assert.equal(b.status, 200);
    assert.notEqual(a.body.data.clients.total_leads, undefined);
  });
});

describe('adding a team member', () => {
  test('a password set by an admin makes the account usable straight away', async () => {
    const res = await api.post('/users', {
      name: 'Direct Hire', email: 'direct@alpha.test', role: 'employee', password: 'Onboard@2026',
    }, { token: alphaToken });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'active');
    assert.equal(res.body.data.invite_url, undefined, 'no invite link when a password was set');

    const login = await api.post('/auth/login', { email: 'direct@alpha.test', password: 'Onboard@2026' });
    assert.equal(login.status, 200);
  });

  test('omitting the password still issues an invitation', async () => {
    const res = await api.post('/users', {
      name: 'Invited Hire', email: 'invited@alpha.test', role: 'employee',
    }, { token: alphaToken });

    assert.equal(res.status, 201);
    assert.equal(res.body.data.status, 'invited');
    assert.ok(res.body.data.invite_url.includes('/accept-invite?token='));
  });

  test('a password shorter than eight characters is rejected on the field', async () => {
    const res = await api.post('/users', {
      name: 'Weak Hire', email: 'weakhire@alpha.test', role: 'employee', password: 'short',
    }, { token: alphaToken });

    assert.equal(res.status, 422);
    assert.ok(res.body.error.details.some((d) => d.field === 'password'));
  });

  test('a password cannot be slipped in through the update route', async () => {
    const created = await api.post('/users', {
      name: 'Patch Target', email: 'patch@alpha.test', role: 'employee', password: 'Original@2026',
    }, { token: alphaToken });

    const patched = await api.patch(`/users/${created.body.data.id}`, {
      designation: 'Analyst', password: 'Hijacked@2026',
    }, { token: alphaToken });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.data.designation, 'Analyst');

    // The field is stripped rather than applied: changing a password is its own
    // route, because that one also revokes every existing session.
    assert.equal((await api.post('/auth/login',
      { email: 'patch@alpha.test', password: 'Hijacked@2026' })).status, 401);
    assert.equal((await api.post('/auth/login',
      { email: 'patch@alpha.test', password: 'Original@2026' })).status, 200);
  });
});

describe('role-based access control', () => {
  let employeeToken; let financeToken; let employeeId;

  before(async () => {
    const invite = await api.post('/users', {
      name: 'Test Employee', email: 'employee@alpha.test', role: 'employee',
    }, { token: alphaToken });
    assert.equal(invite.status, 201);
    employeeId = invite.body.data.id;

    const inviteToken = new URL(invite.body.data.invite_url).searchParams.get('token');
    // Accepting an invitation also sets the account-recovery question - it is
    // the one moment the new user is there to choose one.
    const accepted = await api.post('/auth/accept-invite', {
      token: inviteToken,
      password: 'Password@123',
      security_question: 'What was the name of the first street you lived on as a child?',
      security_answer: 'Trichy Road',
    });
    employeeToken = accepted.body.data.access_token;

    const finance = await api.post('/users', {
      name: 'Test Finance', email: 'finance@alpha.test', role: 'finance',
    }, { token: alphaToken });
    const financeInvite = new URL(finance.body.data.invite_url).searchParams.get('token');
    financeToken = (await api.post('/auth/accept-invite', {
      token: financeInvite,
      password: 'Password@123',
      security_question: 'What was the make and model of your first vehicle?',
      security_answer: 'Bajaj Chetak',
    })).body.data.access_token;
  });

  test('an employee cannot see invoices', async () => {
    const res = await api.get('/invoices', { token: employeeToken });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  test('an employee cannot see cost or profitability data', async () => {
    assert.equal((await api.get('/finance/costs', { token: employeeToken })).status, 403);
    assert.equal((await api.get('/finance/profitability', { token: employeeToken })).status, 403);
  });

  test('an employee cannot invite other users', async () => {
    const res = await api.post('/users', {
      name: 'Sneaky', email: 'sneaky@alpha.test', role: 'owner',
    }, { token: employeeToken });
    assert.equal(res.status, 403);
  });

  test('finance can see invoices and costs', async () => {
    assert.equal((await api.get('/invoices', { token: financeToken })).status, 200);
    assert.equal((await api.get('/finance/costs', { token: financeToken })).status, 200);
  });

  test('finance cannot manage the hiring pipeline', async () => {
    const res = await api.get('/hr/hiring/openings', { token: financeToken });
    assert.equal(res.status, 403);
  });

  test('an employee cannot raise an action item for themselves', async () => {
    const res = await api.post('/action-items', {
      title: 'My own task', priority: 'medium', owner_id: employeeId,
    }, { token: employeeToken });
    assert.equal(res.status, 400);
    const unnamed = await api.post('/action-items', { title: 'Nobody named' }, { token: employeeToken });
    assert.equal(unnamed.status, 400, 'with nobody named it no longer falls back to the creator');

    const list = await api.get('/action-items', { token: employeeToken });
    assert.equal(list.status, 200);
  });

  test('an employee only sees their own action items', async () => {
    // An item owned by the owner, with the employee neither owner nor watcher.
    await api.post('/action-items', { title: 'Owner private task' }, { token: alphaToken });

    const employeeView = await api.get('/action-items', { token: employeeToken });
    assert.ok(employeeView.body.data.every((i) => i.title !== 'Owner private task'),
      "scope filtering hides other people's work from an employee");
  });

  test('the platform console is closed to tenant users', async () => {
    assert.equal((await api.get('/admin/metrics', { token: alphaToken })).status, 403);
    assert.equal((await api.get('/admin/tenants', { token: employeeToken })).status, 403);
  });
});

describe('validation and error shape', () => {
  test('a validation failure returns field-level details', async () => {
    const res = await api.post('/crm/clients', { name: 'x' }, { token: alphaToken });
    assert.equal(res.status, 422);
    assert.equal(res.body.error.code, 'unprocessable');
    assert.ok(Array.isArray(res.body.error.details));
  });

  test('an unknown route returns a structured 404', async () => {
    const res = await api.get('/does-not-exist', { token: alphaToken });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });

  test('every list response carries pagination metadata', async () => {
    const res = await api.get('/crm/clients?page=1&limit=2', { token: alphaToken });
    assert.equal(res.status, 200);
    for (const key of ['page', 'limit', 'total', 'pages', 'has_more']) {
      assert.ok(key in res.body.meta, `missing meta.${key}`);
    }
  });

  test('sort parameters cannot inject SQL', async () => {
    const res = await api.get('/crm/clients?sort=name;DROP%20TABLE%20clients', { token: alphaToken });
    assert.equal(res.status, 200, 'an unrecognised sort falls back to the default');

    const stillThere = await api.get('/crm/clients', { token: alphaToken });
    assert.equal(stillThere.status, 200);
  });
});

describe('CRM rules', () => {
  test('a duplicate client is caught and the existing record offered', async () => {
    await api.post('/crm/clients', { name: 'Unique Textiles Ltd', gstin: '33AABCU9999X1ZQ' }, { token: alphaToken });
    const dup = await api.post('/crm/clients', { name: 'unique textiles ltd' }, { token: alphaToken });

    assert.equal(dup.status, 409);
    assert.ok(dup.body.error.details.existing, 'the caller is told which record it matched');
  });

  test('the duplicate check can be overridden deliberately', async () => {
    const forced = await api.post('/crm/clients?force=true', { name: 'unique textiles ltd' }, { token: alphaToken });
    assert.equal(forced.status, 201);
  });

  test('churning a client requires a structured reason code', async () => {
    const client = (await api.post('/crm/clients', { name: 'Leaving Co', status: 'active' }, { token: alphaToken })).body.data;

    const noReason = await api.patch(`/crm/clients/${client.id}`, { status: 'churned' }, { token: alphaToken });
    assert.equal(noReason.status, 400);
    assert.match(noReason.body.error.message, /reason code/i);

    const codes = (await api.get('/settings/reason-codes?category=churn', { token: alphaToken })).body.data;
    const withReason = await api.patch(`/crm/clients/${client.id}`, {
      status: 'churned', churn_reason_code_id: codes[0].id,
    }, { token: alphaToken });
    assert.equal(withReason.status, 200);
    assert.equal(withReason.body.data.status, 'churned');
  });

  test('a retention-risk flag will not accept an arbitrary reason id', async () => {
    const client = (await api.post('/crm/clients', { name: 'Risky Co', status: 'active' }, { token: alphaToken })).body.data;
    const res = await api.patch(`/crm/clients/${client.id}`, {
      retention_reason_code_id: 'made-up-id',
    }, { token: alphaToken });

    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /managed list/i);
  });

  test('logging an activity updates the next action and the timeline together', async () => {
    const client = (await api.post('/crm/clients', { name: 'Timeline Co' }, { token: alphaToken })).body.data;
    await api.post(`/crm/clients/${client.id}/activities`, {
      type: 'call', outcome: 'connected', subject: 'Intro call',
      next_action: 'Send the proposal', next_action_date: '2026-12-01',
    }, { token: alphaToken });

    const full = (await api.get(`/crm/clients/${client.id}`, { token: alphaToken })).body.data;
    assert.equal(full.next_action, 'Send the proposal');
    assert.ok(full.timeline.some((a) => a.subject === 'Intro call'));
  });
});

describe('invoicing over the API', () => {
  let clientId;

  before(async () => {
    clientId = (await api.post('/crm/clients', {
      name: 'Invoice Target', state_code: '33', gstin: '33AABCI1234M1Z8',
    }, { token: alphaToken })).body.data.id;
  });

  test('an invoice is created with a system-allocated number', async () => {
    const res = await api.post('/invoices', {
      client_id: clientId,
      items: [{ description: 'Retainer', qty: 1, rate_minor: 10_000_00, gst_rate: 18, hsn_sac: '998361' }],
    }, { token: alphaToken });

    assert.equal(res.status, 201);
    assert.match(res.body.data.number, /\/\d{4}$/, 'the number follows the tenant scheme');
    assert.equal(res.body.data.total_minor, 11_800_00);
  });

  test('an idempotency key stops a double submission creating two invoices', async () => {
    const payload = {
      client_id: clientId,
      items: [{ description: 'Duplicate guard', qty: 1, rate_minor: 5_000_00, gst_rate: 18 }],
    };
    const key = 'test-idempotency-key-1';

    const first = await api.post('/invoices', payload, { token: alphaToken, headers: { 'Idempotency-Key': key } });
    const second = await api.post('/invoices', payload, { token: alphaToken, headers: { 'Idempotency-Key': key } });

    assert.equal(first.status, 201);
    assert.equal(second.body.data.number, first.body.data.number, 'the original response is replayed');
    assert.equal(second.headers.get('idempotent-replay'), 'true');

    const audit = await api.get('/invoices/meta', { token: alphaToken });
    assert.equal(audit.body.data.numbering_audit.duplicate_numbers, 0,
      'the replay consumed no second invoice number');
  });

  test('a sent invoice cannot be deleted', async () => {
    const inv = (await api.post('/invoices', {
      client_id: clientId, items: [{ description: 'To send', rate_minor: 1_000_00 }],
    }, { token: alphaToken })).body.data;

    await api.post(`/invoices/${inv.id}/send`, {}, { token: alphaToken });

    const res = await api.del(`/invoices/${inv.id}`, { token: alphaToken });
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /Only draft invoices can be deleted/i);
  });

  test('sending an invoice registers it with the deadline engine', async () => {
    const inv = (await api.post('/invoices', {
      client_id: clientId, items: [{ description: 'Tracked', rate_minor: 2_000_00 }],
    }, { token: alphaToken })).body.data;
    await api.post(`/invoices/${inv.id}/send`, {}, { token: alphaToken });

    const deadlines = await api.get('/notifications/deadlines?source_type=invoice', { token: alphaToken });
    assert.ok(deadlines.body.data.some((d) => d.source_id === inv.id),
      'the due date is now chased by the central engine, not by memory');
  });

  test('the numbering audit stays clean after all this activity', async () => {
    const meta = await api.get('/invoices/meta', { token: alphaToken });
    assert.equal(meta.body.data.numbering_audit.duplicate_numbers, 0);
    assert.equal(meta.body.data.numbering_audit.sequence_gaps, 0);
    assert.equal(meta.body.data.numbering_audit.clean, true);
  });
});

describe('billing', () => {
  test('the plan matrix is public so a pricing page can read it', async () => {
    const res = await api.get('/plans');
    assert.equal(res.status, 200, 'no token needed for the public plan list');
    assert.ok(res.body.data.length > 0);
    assert.ok('features' in res.body.data[0]);
  });

  test('the in-app plan list requires a session', async () => {
    assert.equal((await api.get('/billing/plans')).status, 401);
    assert.equal((await api.get('/billing/plans', { token: alphaToken })).status, 200);
  });

  test('a plan change quote includes GST and any add-on seats', async () => {
    const res = await api.post('/billing/subscription/quote', {
      plan_code: 'growth', billing_cycle: 'monthly',
    }, { token: alphaToken });

    assert.equal(res.status, 200);
    assert.equal(res.body.data.gst_minor, Math.round(res.body.data.taxable_minor * 0.18));
    assert.equal(res.body.data.total_minor, res.body.data.taxable_minor + res.body.data.gst_minor);
  });

  test('a yearly quote costs more upfront than a monthly one', async () => {
    const monthly = (await api.post('/billing/subscription/quote', { plan_code: 'growth', billing_cycle: 'monthly' }, { token: alphaToken })).body.data;
    const yearly = (await api.post('/billing/subscription/quote', { plan_code: 'growth', billing_cycle: 'yearly' }, { token: alphaToken })).body.data;

    assert.ok(yearly.total_minor > monthly.total_minor);
    assert.ok(yearly.base_minor < monthly.base_minor * 12, 'the annual plan is discounted against paying monthly');
  });

  test('an invalid coupon is rejected rather than silently ignored', async () => {
    const res = await api.post('/billing/subscription/quote', {
      plan_code: 'growth', coupon_code: 'NOTAREALCODE',
    }, { token: alphaToken });
    assert.equal(res.status, 400);
  });

  test('usage is reported against the plan limits', async () => {
    const res = await api.get('/billing/subscription', { token: alphaToken });
    const { usage } = res.body.data;

    assert.ok(usage.users >= 1);
    assert.equal(typeof usage.clients, 'number');
    assert.ok('clients_limit' in usage);
    assert.ok('whatsapp_credits' in usage);
  });

  test('an unknown plan code is a 404, not a crash', async () => {
    const res = await api.post('/billing/subscription/quote', { plan_code: 'enterprise-unicorn' }, { token: alphaToken });
    assert.equal(res.status, 404);
  });
});

describe('mobile sync', () => {
  test('bootstrap returns everything a fresh install needs', async () => {
    const res = await api.get('/sync/bootstrap', { token: alphaToken });
    assert.equal(res.status, 200);
    for (const key of ['tenant', 'directory', 'action_categories', 'service_lines', 'pipeline_stages', 'leave_types']) {
      assert.ok(key in res.body.data, `bootstrap is missing ${key}`);
    }
  });

  test('delta sync only returns rows changed since the given timestamp', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const empty = await api.get(`/sync?updated_since=${future}`, { token: alphaToken });

    assert.equal(empty.status, 200);
    const totals = Object.values(empty.body.data).flat();
    assert.equal(totals.length, 0, 'nothing has changed after now');

    const all = await api.get('/sync?updated_since=1970-01-01T00:00:00.000Z', { token: alphaToken });
    assert.ok(Object.values(all.body.data).flat().length > 0);
  });

  test('an offline action item for yourself is refused', async () => {
    const res = await api.post('/sync/queue', {
      operations: [{ client_id: 'device-op-self', type: 'action_item.create', payload: { title: 'Mine' }, created_at: new Date().toISOString() }],
    }, { token: alphaToken });
    assert.equal(res.body.data[0].status, 'failed');
  });

  test('an offline queue applies once and ignores a replay', async () => {
    const op = {
      client_id: 'device-op-1',
      type: 'action_item.create',
      payload: { title: 'Created while offline', priority: 'high', owner_id: await someoneElse() },
      created_at: new Date().toISOString(),
    };

    const first = await api.post('/sync/queue', { operations: [op] }, { token: alphaToken });
    assert.equal(first.status, 200);
    assert.equal(first.body.data[0].status, 'applied');

    const replay = await api.post('/sync/queue', { operations: [op] }, { token: alphaToken });
    assert.equal(replay.body.data[0].status, 'duplicate',
      'a retried queue must not create the item twice');

    const items = await api.get('/action-items?search=Created while offline', { token: alphaToken });
    assert.equal(items.body.data.length, 1);
  });

  test('a conflicting offline edit wins but reports the conflict', async () => {
    const item = (await api.post('/action-items', { title: 'Conflict test', owner_id: await someoneElse() },
      { token: alphaToken })).body.data;

    // Someone edits on the server after the offline change was made.
    await api.patch(`/action-items/${item.id}`, { title: 'Changed on server' }, { token: alphaToken });

    const res = await api.post('/sync/queue', {
      operations: [{
        client_id: 'device-op-conflict',
        type: 'action_item.update',
        payload: { id: item.id, title: 'Changed offline' },
        created_at: new Date(Date.now() - 600_000).toISOString(),
      }],
    }, { token: alphaToken });

    assert.equal(res.body.data[0].status, 'applied');
    assert.equal(res.body.data[0].conflict, 'last_write_wins');
    assert.ok(res.body.data[0].message, 'the user can be told their offline edit overwrote a newer one');
  });
});

describe('audit trail', () => {
  test('creating and updating a record is written to the audit log', async () => {
    const client = (await api.post('/crm/clients', { name: 'Audited Co' }, { token: alphaToken })).body.data;
    await api.patch(`/crm/clients/${client.id}`, { industry: 'ecommerce' }, { token: alphaToken });

    const res = await api.get(`/settings/audit?entity=client&entity_id=${client.id}`, { token: alphaToken });
    assert.equal(res.status, 200);

    const actions = res.body.data.map((a) => a.action);
    assert.ok(actions.includes('create'));
    assert.ok(actions.includes('update'));

    const update = res.body.data.find((a) => a.action === 'update');
    assert.ok(update.before && update.after, 'before and after values are both recorded');
  });

  test('the data export omits credentials', async () => {
    const res = await api.get('/settings/data-export', { token: alphaToken });
    assert.equal(res.status, 200);

    const dump = res.body;
    assert.ok(Array.isArray(dump.users));
    assert.ok(dump.users.every((u) => !('password_hash' in u) && !('twofa_secret' in u)),
      'an export must never carry password hashes or 2FA secrets');
  });
});
