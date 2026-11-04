import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const alpha = await signUpTenant(api, { agency_name: 'Board Agency', email: 'owner@board.test' });
const beta = await signUpTenant(api, { agency_name: 'Other Agency', email: 'owner@other.test' });
const token = alpha.access_token;
const betaToken = beta.access_token;

const stages = (await api.get('/settings/pipeline-stages', { token })).body.data;
const [s1, s2] = stages;

/** Creates a lead in the first stage and returns it. */
async function lead(name) {
  const res = await api.post('/crm/clients', { name, stage_id: s1.id }, { token });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const board = async () => (await api.get('/crm/pipeline', { token })).body.data;
const namesIn = async (stageId) =>
  (await board()).find((s) => s.id === stageId).clients.map((c) => c.name);

describe('pipeline board drag-and-drop', () => {
  let a, b, c;

  before(async () => {
    a = await lead('Card A');
    b = await lead('Card B');
    c = await lead('Card C');
  });

  test('a new stage has an order that the board reports back', async () => {
    const names = await namesIn(s1.id);
    assert.deepEqual(names.length, 3);
    assert.ok(names.includes('Card A') && names.includes('Card B') && names.includes('Card C'));
  });

  test('dropping a card between two others reorders only that card', async () => {
    const start = await namesIn(s1.id);
    const [first, second, third] = start.map((n) => [a, b, c].find((x) => x.name === n));

    // Move the third card into the gap between the first and the second.
    const res = await api.post('/crm/pipeline/move', {
      client_id: third.id, stage_id: s1.id, prev_id: first.id, next_id: second.id,
    }, { token });
    assert.equal(res.status, 200, JSON.stringify(res.body));

    assert.deepEqual(await namesIn(s1.id), [first.name, third.name, second.name]);
  });

  test('dropping at the top and the bottom of a stage both work', async () => {
    const order = await namesIn(s1.id);
    const ids = order.map((n) => [a, b, c].find((x) => x.name === n).id);

    await api.post('/crm/pipeline/move',
      { client_id: ids[2], stage_id: s1.id, prev_id: null, next_id: ids[0] }, { token });
    assert.equal((await namesIn(s1.id))[0], order[2], 'moved to the top');

    await api.post('/crm/pipeline/move',
      { client_id: ids[2], stage_id: s1.id, prev_id: ids[1], next_id: null }, { token });
    assert.equal((await namesIn(s1.id)).at(-1), order[2], 'moved to the bottom');
  });

  test('moving across stages records history, an activity and the new position', async () => {
    const before = (await board()).find((s) => s.id === s1.id).clients[0];

    const res = await api.post('/crm/pipeline/move',
      { client_id: before.id, stage_id: s2.id, prev_id: null, next_id: null }, { token });
    assert.equal(res.status, 200);
    assert.equal(res.body.data.stage_id, s2.id);

    assert.ok((await namesIn(s2.id)).includes(before.name), 'it landed in the target stage');
    assert.ok(!(await namesIn(s1.id)).includes(before.name), 'and left the old one');

    const detail = (await api.get(`/crm/clients/${before.id}`, { token })).body.data;
    assert.ok(
      detail.stage_history.some((h) => h.to_stage_id === s2.id),
      'the move is recorded in stage history',
    );
    assert.ok(
      detail.timeline.some((t) => t.type === 'stage_change'),
      'and appears on the client timeline',
    );
  });

  test('a repeated drop into the same gap keeps working once precision runs out', async () => {
    const ids = (await board()).find((s) => s.id === s1.id).clients.map((c) => c.id);
    assert.ok(ids.length >= 2, 'need two cards to squeeze between');

    // 60 drops into the same gap exhausts a float midpoint and forces a renumber.
    for (let i = 0; i < 60; i++) {
      const cur = (await board()).find((s) => s.id === s1.id).clients.map((c) => c.id);
      const res = await api.post('/crm/pipeline/move',
        { client_id: cur.at(-1), stage_id: s1.id, prev_id: cur[0], next_id: cur[1] }, { token });
      assert.equal(res.status, 200, `drop ${i} failed: ${JSON.stringify(res.body)}`);
    }

    const final = (await board()).find((s) => s.id === s1.id).clients;
    const sorts = final.map((c) => c.board_sort);
    assert.equal(new Set(final.map((c) => c.id)).size, final.length, 'no card was duplicated or lost');
    assert.deepEqual([...sorts].sort((x, y) => x - y), sorts, 'the board is still strictly ordered');
  });

  test('a move naming another tenant\'s card is not found', async () => {
    const mine = (await board()).find((s) => s.id === s1.id).clients[0];
    const res = await api.post('/crm/pipeline/move',
      { client_id: mine.id, stage_id: s1.id }, { token: betaToken });
    assert.equal(res.status, 404, 'cross-tenant move returns 404, not 403');
  });

  test('a move naming another tenant\'s stage is rejected', async () => {
    const mine = (await board()).find((s) => s.id === s1.id).clients[0];
    const betaStages = (await api.get('/settings/pipeline-stages', { token: betaToken })).body.data;

    const res = await api.post('/crm/pipeline/move',
      { client_id: mine.id, stage_id: betaStages[1].id, prev_id: null, next_id: null }, { token });
    assert.equal(res.status, 400, 'the foreign stage id is refused');
    assert.equal((await board()).find((s) => s.id === s1.id).clients[0].id, mine.id, 'nothing moved');
  });
});
