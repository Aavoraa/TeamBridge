import test, { after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const alpha = await signUpTenant(api, { agency_name: 'Register Agency', email: 'owner@register.test' });
const beta = await signUpTenant(api, { agency_name: 'Rival Agency', email: 'owner@rival.test' });
const token = alpha.access_token;
const betaToken = beta.access_token;

const create = (body, opts = {}) => api.post('/clients', body, { token, ...opts });

describe('client register', () => {
  test('creates a client and reads it back', async () => {
    const res = await create({
      name: 'Cotton India Textiles',
      legal_name: 'Cotton India Textiles Private Limited',
      industry: 'textiles',
      contact_name: 'Ravi Shankar',
      email: 'ravi@cottonindia.test',
      city: 'Tiruppur',
      gstin: '33AABCC7654D1Z9',
      payment_terms_days: 15,
    });
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const row = res.body.data;
    assert.equal(row.name, 'Cotton India Textiles');
    assert.equal(row.status, 'active');
    assert.equal(row.payment_terms_days, 15);
    // The creator becomes the account manager when none is named.
    assert.ok(row.owner_id);

    const read = await api.get(`/clients/${row.id}`, { token });
    assert.equal(read.status, 200);
    assert.equal(read.body.data.contact_name, 'Ravi Shankar');
    assert.deepEqual(read.body.data.leads, []);
  });

  test('blank optional fields are stored as null, not empty strings', async () => {
    const res = await create({ name: 'Blank Fields Co', website: '', city: '' });
    assert.equal(res.status, 201);
    assert.equal(res.body.data.website, null);
    assert.equal(res.body.data.city, null);
  });

  test('refuses a duplicate name, and takes it with force', async () => {
    const first = await create({ name: 'Twice Over Ltd' });
    assert.equal(first.status, 201);

    const dup = await create({ name: 'twice over ltd' });
    assert.equal(dup.status, 409, JSON.stringify(dup.body));
    assert.equal(dup.body.error.details.existing.name, 'Twice Over Ltd');

    const forced = await api.post('/clients?force=true', { name: 'twice over ltd' }, { token });
    assert.equal(forced.status, 201);
  });

  test('refuses a duplicate GSTIN under a different name', async () => {
    await create({ name: 'Gst Holder One', gstin: '29AAHCM9876L1ZR' });
    const dup = await create({ name: 'Completely Different Name', gstin: '29AAHCM9876L1ZR' });
    assert.equal(dup.status, 409);
  });

  test('updates a client without disturbing the fields left alone', async () => {
    const made = (await create({ name: 'Patch Me Ltd', city: 'Salem', industry: 'retail' })).body.data;

    const res = await api.patch(`/clients/${made.id}`, { city: 'Erode', status: 'inactive' }, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.city, 'Erode');
    assert.equal(res.body.data.status, 'inactive');
    assert.equal(res.body.data.industry, 'retail');
    assert.equal(res.body.data.name, 'Patch Me Ltd');
  });

  test('search and status filters narrow the list', async () => {
    await create({ name: 'Findable Foods', city: 'Madurai', industry: 'hospitality' });

    const hit = await api.get('/clients?search=Findable', { token });
    assert.equal(hit.status, 200);
    assert.equal(hit.body.data.length, 1);
    assert.equal(hit.body.data[0].name, 'Findable Foods');

    const miss = await api.get('/clients?search=nothing-matches-this', { token });
    assert.equal(miss.body.data.length, 0);
  });

  test('archived clients are hidden from the default list', async () => {
    const made = (await create({ name: 'Gone Quiet Ltd' })).body.data;
    await api.patch(`/clients/${made.id}`, { status: 'archived' }, { token });

    const listed = await api.get('/clients?limit=200', { token });
    assert.ok(!listed.body.data.some((c) => c.id === made.id));

    const asked = await api.get('/clients?status=archived', { token });
    assert.ok(asked.body.data.some((c) => c.id === made.id));
  });
});

describe('leads linked to a client', () => {
  test('a lead can be attached, and the client reports it', async () => {
    const account = (await create({ name: 'Linked Client Ltd', city: 'Coimbatore' })).body.data;

    const leadRes = await api.post('/crm/clients',
      { name: 'Linked Client Ltd — retainer renewal', client_account_id: account.id }, { token });
    assert.equal(leadRes.status, 201, JSON.stringify(leadRes.body));
    assert.equal(leadRes.body.data.client_account_id, account.id);
    assert.equal(leadRes.body.data.client_account_name, 'Linked Client Ltd');

    const read = await api.get(`/clients/${account.id}`, { token });
    assert.equal(read.body.data.lead_count, 1);
    assert.equal(read.body.data.leads.length, 1);

    // Two rows are linked to the account: the stage-less delivery record every
    // client carries, and this opportunity. Only the latter counts as a lead,
    // which is why lead_count above is 1 rather than 2.
    const filtered = await api.get(`/crm/clients?client_account_id=${account.id}`, { token });
    assert.equal(filtered.body.data.length, 2);
    assert.equal(filtered.body.data.filter((c) => c.stage_id).length, 1);
  });

  test('archiving a client keeps its leads and unlinks them', async () => {
    const account = (await create({ name: 'Detach Me Ltd' })).body.data;
    const lead = (await api.post('/crm/clients',
      { name: 'Detach Me — new scope', client_account_id: account.id }, { token })).body.data;

    const del = await api.del(`/clients/${account.id}`, { token });
    assert.equal(del.status, 200, JSON.stringify(del.body));
    assert.equal(del.body.data.detached_leads, 1);

    // The opportunity survives; only the link is gone.
    const still = await api.get(`/crm/clients/${lead.id}`, { token });
    assert.equal(still.status, 200);
    assert.equal(still.body.data.client_account_id, null);

    assert.equal((await api.get(`/clients/${account.id}`, { token })).status, 404);
  });
});

describe('tenant isolation', () => {
  test('one agency cannot see or touch another agency\'s clients', async () => {
    const mine = (await create({ name: 'Private Books Ltd' })).body.data;

    const listed = await api.get('/clients?limit=200', { token: betaToken });
    assert.ok(!listed.body.data.some((c) => c.id === mine.id));

    assert.equal((await api.get(`/clients/${mine.id}`, { token: betaToken })).status, 404);
    assert.equal((await api.patch(`/clients/${mine.id}`, { city: 'Nope' }, { token: betaToken })).status, 404);
    assert.equal((await api.del(`/clients/${mine.id}`, { token: betaToken })).status, 404);
  });
});

describe('validation', () => {
  test('a one-character name is rejected', async () => {
    assert.equal((await create({ name: 'X' })).status, 422);
  });

  test('a malformed email is rejected', async () => {
    assert.equal((await create({ name: 'Bad Email Ltd', email: 'not-an-email' })).status, 422);
  });

  test('an unknown status is rejected', async () => {
    assert.equal((await create({ name: 'Bad Status Ltd', status: 'prospect' })).status, 422);
  });
});

describe('a new client is usable straight away', () => {
  test('appears in the picker that projects, proposals and invoices read', async () => {
    const account = (await create({ name: 'Pickable Client Ltd', city: 'Erode', industry: 'retail' })).body.data;

    // This is the exact call the New project / New invoice / New proposal
    // forms make. Before delivery records existed, a client added on the
    // Clients page was simply absent from all three.
    const picker = await api.get('/crm/clients?limit=200', { token });
    const match = picker.body.data.find((c) => c.name === 'Pickable Client Ltd');
    assert.ok(match, 'the new client is selectable when creating a project');
    assert.equal(match.client_account_id, account.id);
    assert.equal(match.status, 'active');
  });

  test('the delivery record carries no stage, so it stays off the CRM board', async () => {
    const account = (await create({ name: 'Not On The Board Ltd' })).body.data;

    const record = (await api.get(`/crm/clients?client_account_id=${account.id}`, { token })).body.data[0];
    assert.equal(record.stage_id, null);

    const board = await api.get('/crm/pipeline', { token });
    const onBoard = board.body.data.some((stage) =>
      stage.clients.some((c) => c.name === 'Not On The Board Ltd'));
    assert.equal(onBoard, false, 'a client on the register is not an opportunity in the funnel');
  });

  test('links an existing lead instead of duplicating it', async () => {
    const lead = (await api.post('/crm/clients', { name: 'Already A Lead Ltd' }, { token })).body.data;
    const account = (await create({ name: 'Already A Lead Ltd' })).body.data;

    const matches = (await api.get('/crm/clients?search=Already A Lead', { token })).body.data;
    assert.equal(matches.length, 1, 'no duplicate row was created');
    assert.equal(matches[0].id, lead.id, 'the existing lead was linked, keeping its history');
    assert.equal(matches[0].client_account_id, account.id);
  });

  test('renaming the client renames what the pickers show', async () => {
    const account = (await create({ name: 'Old Trading Name Ltd' })).body.data;
    await api.patch(`/clients/${account.id}`, { name: 'New Trading Name Ltd' }, { token });

    const record = (await api.get(`/crm/clients?client_account_id=${account.id}`, { token })).body.data[0];
    assert.equal(record.name, 'New Trading Name Ltd');
  });
});

describe('the project client picker lists only the client register', () => {
  test('a client on the Clients page is offered; a pipeline lead is not', async () => {
    const account = (await create({ name: 'Register Only Pvt Ltd' })).body.data;
    await api.post('/crm/clients', { name: 'Just A Lead Co' }, { token });

    const res = await api.get('/crm/clients?on_register=true&limit=200', { token });
    assert.equal(res.status, 200);
    const names = res.body.data.map((c) => c.name);
    assert.ok(names.includes('Register Only Pvt Ltd'), JSON.stringify(names));
    assert.ok(!names.includes('Just A Lead Co'), 'a lead with no client account is left out');
    assert.ok(res.body.data.every((c) => c.client_account_id), 'every row is linked to a client account');

    // Archiving it on the Clients page takes it out of the picker too.
    await api.patch(`/clients/${account.id}`, { status: 'archived' }, { token });
    const after = (await api.get('/crm/clients?on_register=true&limit=200', { token })).body.data.map((c) => c.name);
    assert.ok(!after.includes('Register Only Pvt Ltd'));
  });
});
