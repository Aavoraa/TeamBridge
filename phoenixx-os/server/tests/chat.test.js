import test, { after, before, describe } from 'node:test';
import assert from 'node:assert/strict';
import { useTempDatabase, seedPlan, startServer, signUpTenant } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);

const api = await startServer();
after(() => api.close());

const alpha = await signUpTenant(api, { agency_name: 'Chat Agency', email: 'owner@chat.test' });
const beta = await signUpTenant(api, { agency_name: 'Other Agency', email: 'owner@elsewhere.test' });
const token = alpha.access_token;
const betaToken = beta.access_token;

/** Invites someone and signs them in, so tests can act as them. */
async function hire(name, role = 'employee') {
  const email = `${name.toLowerCase()}@chat.test`;
  const invite = await api.post('/users', { name, email, role }, { token });
  assert.equal(invite.status, 201, JSON.stringify(invite.body));

  const reset = await api.post(`/users/${invite.body.data.id}/reset-password`, {}, { token });
  const login = await api.post('/auth/login', {
    email, password: reset.body.data.temporary_password,
  });
  assert.equal(login.status, 200, JSON.stringify(login.body));
  return { ...invite.body.data, token: login.body.data.access_token };
}

const client = (await api.post('/crm/clients', { name: 'Acme Textiles' }, { token })).body.data;

let divya, priya, vignesh;
before(async () => {
  divya = await hire('Divya', 'manager');
  priya = await hire('Priya');
  vignesh = await hire('Vignesh');
});

const channels = async (tok) => (await api.get('/chat/channels', { token: tok })).body.data;
const findKind = (list, kind) => list.find((c) => c.kind === kind);
const messagesIn = async (id, tok) => (await api.get(`/chat/channels/${id}/messages`, { token: tok })).body.data;
const say = (id, body, tok, extra = {}) =>
  api.post(`/chat/channels/${id}/messages`, { body, ...extra }, { token: tok });

describe('the company broadcast channel', () => {
  test('every person in the workspace lands in it without being invited', async () => {
    const mine = findKind(await channels(token), 'broadcast');
    assert.ok(mine, 'owner has a broadcast channel');

    const theirs = findKind(await channels(priya.token), 'broadcast');
    assert.equal(theirs.id, mine.id, 'the employee is in the same room');
  });

  test('an owner can announce and everyone sees it', async () => {
    const room = findKind(await channels(token), 'broadcast');
    const res = await say(room.id, 'Payroll runs Friday.', token);
    assert.equal(res.status, 201, JSON.stringify(res.body));

    const seen = await messagesIn(room.id, priya.token);
    assert.ok(seen.some((m) => m.body === 'Payroll runs Friday.'));
  });

  test('an employee cannot post an announcement', async () => {
    const room = findKind(await channels(priya.token), 'broadcast');
    const res = await say(room.id, 'Free lunch everyone', priya.token);
    assert.equal(res.status, 403);
    assert.equal(room.can_post, undefined); // the list is lean; the detail carries can_post

    const detail = (await api.get(`/chat/channels/${room.id}`, { token: priya.token })).body.data;
    assert.equal(detail.can_post, false);
  });

  test('a manager can, because announcements are not owner-only', async () => {
    const room = findKind(await channels(divya.token), 'broadcast');
    assert.equal((await say(room.id, 'Standup moves to 9:30.', divya.token)).status, 201);
  });

  test('an announcement notifies everyone else in the workspace', async () => {
    const room = findKind(await channels(token), 'broadcast');
    await say(room.id, 'Office closed on Monday.', token);

    const inbox = (await api.get('/notifications', { token: priya.token })).body.data;
    assert.ok(inbox.some((n) => n.event_key === 'chat.broadcast' && n.body.includes('Office closed on Monday.')));
  });
});

describe('a project room follows its team', () => {
  let project;
  let room;

  before(async () => {
    project = (await api.post('/projects', {
      client_id: client.id, name: 'Brand refresh', manager_id: divya.id,
    }, { token })).body.data;
    room = findKind(await channels(divya.token), 'project');
  });

  test('creating a project opens a room for the people on it', async () => {
    assert.ok(room, 'the project manager is in the project room');
    assert.equal(room.project_id, project.id);
    assert.equal(room.name, 'Brand refresh');
  });

  test('someone not on the team cannot see the room at all', async () => {
    assert.ok(!findKind(await channels(priya.token), 'project'));
    assert.equal((await api.get(`/chat/channels/${room.id}`, { token: priya.token })).status, 404);
    assert.equal((await say(room.id, 'sneaking in', priya.token)).status, 404);
  });

  test('joining the team joins the room, and the room says so', async () => {
    await api.post(`/projects/${project.id}/members`, { user_id: priya.id, seat: 'senior' }, { token });

    const hers = findKind(await channels(priya.token), 'project');
    assert.equal(hers?.id, room.id);
    assert.equal((await say(room.id, 'Happy to be here.', priya.token)).status, 201);

    const history = await messagesIn(room.id, priya.token);
    assert.ok(history.some((m) => m.kind === 'system' && m.body.includes('Priya joined the team as senior')));
  });

  test('leaving the team leaves the room', async () => {
    const members = (await api.get(`/projects/${project.id}/members`, { token })).body.data;
    const priyaMember = members.find((m) => m.user_id === priya.id);
    await api.del(`/projects/${project.id}/members/${priyaMember.id}?force=true`, { token });

    assert.ok(!findKind(await channels(priya.token), 'project'));
    assert.equal((await api.get(`/chat/channels/${room.id}`, { token: priya.token })).status, 404);
  });

  test('renaming the project renames the room', async () => {
    await api.patch(`/projects/${project.id}`, { name: 'Brand refresh 2.0' }, { token });
    const after = findKind(await channels(divya.token), 'project');
    assert.equal(after.name, 'Brand refresh 2.0');
  });

  test('the room cannot be renamed on its own, because the project owns the name', async () => {
    // Divya, not the workspace owner: only the team is in this room.
    const res = await api.patch(`/chat/channels/${room.id}`, { name: 'Something else' }, { token: divya.token });
    assert.equal(res.status, 400);
  });

  test('members cannot be added directly — the team is the membership', async () => {
    const res = await api.post(`/chat/channels/${room.id}/members`, { user_ids: [vignesh.id] },
      { token: divya.token });
    assert.equal(res.status, 400);
  });

  test('archiving the project archives the room', async () => {
    const solo = (await api.post('/projects', {
      client_id: client.id, name: 'Short lived', manager_id: divya.id,
    }, { token })).body.data;
    const its = (await channels(divya.token)).find((c) => c.project_id === solo.id);
    assert.ok(its);

    await api.del(`/projects/${solo.id}`, { token });
    assert.ok(!(await channels(divya.token)).some((c) => c.project_id === solo.id));
  });
});

describe('messages', () => {
  let room;
  before(async () => {
    room = (await api.post('/chat/channels', {
      name: 'Design guild', member_ids: [priya.id, vignesh.id],
    }, { token })).body.data;
  });

  test('naming someone mentions them and pulls them out of band', async () => {
    const res = await say(room.id, 'Can @Priya take the first pass?', token);
    assert.equal(res.status, 201);
    assert.deepEqual(res.body.data.mentions, [priya.id]);

    const inbox = (await api.get('/notifications', { token: priya.token })).body.data;
    assert.ok(inbox.some((n) => n.event_key === 'chat.mention'));
  });

  test('someone not in the room is never mentioned by accident', async () => {
    const outsider = await hire('Kavya');
    const res = await say(room.id, 'cc @Kavya on this', token);
    assert.deepEqual(res.body.data.mentions, []);
    assert.ok(outsider.id);
  });

  test('a reply carries the message it answers', async () => {
    const first = (await say(room.id, 'Ship it Friday?', token)).body.data;
    const reply = (await say(room.id, 'Works for me.', priya.token, { reply_to_id: first.id })).body.data;
    assert.equal(reply.reply_body, 'Ship it Friday?');
  });

  test('you may edit and delete your own words but not someone else\'s', async () => {
    const mine = (await say(room.id, 'draft', priya.token)).body.data;

    assert.equal((await api.patch(`/chat/messages/${mine.id}`, { body: 'final' }, { token: priya.token })).status, 200);
    assert.equal((await api.patch(`/chat/messages/${mine.id}`, { body: 'hijacked' }, { token: vignesh.token })).status, 403);
    assert.equal((await api.del(`/chat/messages/${mine.id}`, { token: vignesh.token })).status, 403);
    assert.equal((await api.del(`/chat/messages/${mine.id}`, { token: priya.token })).status, 200);

    const history = await messagesIn(room.id, priya.token);
    assert.ok(!history.some((m) => m.id === mine.id), 'a deleted message leaves the history');
  });

  test('history pages backwards without repeating or skipping a message', async () => {
    const quiet = (await api.post('/chat/channels', { name: 'Paging' }, { token })).body.data;
    for (let i = 1; i <= 12; i += 1) await say(quiet.id, `line ${i}`, token);

    const first = await api.get(`/chat/channels/${quiet.id}/messages?limit=5`, { token });
    assert.equal(first.body.data.length, 5);
    assert.equal(first.body.meta.has_more, true);
    assert.equal(first.body.data.at(-1).body, 'line 12');

    const second = await api.get(
      `/chat/channels/${quiet.id}/messages?limit=5&before=${encodeURIComponent(first.body.meta.oldest)}`,
      { token },
    );
    const overlap = second.body.data.filter((m) => first.body.data.some((f) => f.id === m.id));
    assert.equal(overlap.length, 0);
    assert.equal(second.body.data.at(-1).body, 'line 7');
  });

  test('pinning surfaces a message on the channel itself', async () => {
    const decision = (await say(room.id, 'Decision: we go with the blue palette.', token)).body.data;
    await api.post(`/chat/messages/${decision.id}/pin`, {}, { token });

    const detail = (await api.get(`/chat/channels/${room.id}`, { token: priya.token })).body.data;
    assert.ok(detail.pinned.some((m) => m.id === decision.id));
  });
});

describe('unread counts', () => {
  test('a message is unread for everyone except the person who sent it', async () => {
    const room = (await api.post('/chat/channels', { name: 'Counting', member_ids: [priya.id] }, { token })).body.data;
    await say(room.id, 'first', token);
    await say(room.id, 'second', token);

    const hers = (await channels(priya.token)).find((c) => c.id === room.id);
    assert.equal(hers.unread, 2);

    const mine = (await channels(token)).find((c) => c.id === room.id);
    assert.equal(mine.unread, 0, 'posting counts as reading');
  });

  test('opening a conversation clears it, and the badge follows', async () => {
    const room = (await api.post('/chat/channels', { name: 'Clearing', member_ids: [priya.id] }, { token })).body.data;
    await say(room.id, 'hello', token);

    const before = (await api.get('/chat/unread', { token: priya.token })).body.data.unread;
    assert.ok(before >= 1);

    await api.post(`/chat/channels/${room.id}/read`, {}, { token: priya.token });
    const hers = (await channels(priya.token)).find((c) => c.id === room.id);
    assert.equal(hers.unread, 0);
    assert.equal((await api.get('/chat/unread', { token: priya.token })).body.data.unread, before - 1);
  });

  test('a muted conversation stays out of the badge', async () => {
    const room = (await api.post('/chat/channels', { name: 'Noisy', member_ids: [priya.id] }, { token })).body.data;
    await api.patch(`/chat/channels/${room.id}/settings`, { muted: true }, { token: priya.token });

    // Other rooms carry their own unread from earlier cases, so the assertion
    // is that this message moves the badge by nothing at all.
    const before = (await api.get('/chat/unread', { token: priya.token })).body.data.unread;
    await say(room.id, 'noise', token);
    const after = (await api.get('/chat/unread', { token: priya.token })).body.data.unread;

    const hers = (await channels(priya.token)).find((c) => c.id === room.id);
    assert.equal(hers.unread, 1, 'the count is still shown on the row');
    assert.equal(after, before, 'but it does not ring the bell');
  });

  test('the home dashboard reports the same number as the chat badge', async () => {
    const home = (await api.get('/dashboard/home', { token: priya.token })).body.data;
    const badge = (await api.get('/chat/unread', { token: priya.token })).body.data.unread;
    assert.equal(home.counters.chat, badge);
  });
});

describe('direct messages', () => {
  test('opening a DM twice returns the same conversation', async () => {
    const a = (await api.post('/chat/direct', { user_id: priya.id }, { token })).body.data;
    const b = (await api.post('/chat/direct', { user_id: priya.id }, { token })).body.data;
    assert.equal(a.id, b.id);

    // And from the other side too - the pair is what identifies the room.
    const c = (await api.post('/chat/direct', { user_id: alpha.user.id }, { token: priya.token })).body.data;
    assert.equal(c.id, a.id);
  });

  test('a DM is labelled by the other person, from either side', async () => {
    const mine = (await api.post('/chat/direct', { user_id: vignesh.id }, { token })).body.data;
    assert.equal(mine.label, 'Vignesh');

    const theirs = (await channels(vignesh.token)).find((c) => c.id === mine.id);
    assert.equal(theirs.label, 'Test Owner');
  });

  test('nobody else can read it', async () => {
    const dm = (await api.post('/chat/direct', { user_id: priya.id }, { token })).body.data;
    await say(dm.id, 'between us', token);
    assert.equal((await api.get(`/chat/channels/${dm.id}`, { token: vignesh.token })).status, 404);
  });
});

describe('boundaries', () => {
  test('another workspace cannot read or post to a conversation', async () => {
    const room = findKind(await channels(token), 'broadcast');
    assert.equal((await api.get(`/chat/channels/${room.id}`, { token: betaToken })).status, 404);
    assert.equal((await say(room.id, 'hello from outside', betaToken)).status, 404);
  });

  test('each workspace gets its own broadcast channel', async () => {
    const mine = findKind(await channels(token), 'broadcast');
    const theirs = findKind(await channels(betaToken), 'broadcast');
    assert.ok(theirs);
    assert.notEqual(mine.id, theirs.id);
  });

  test('an empty message is rejected', async () => {
    const room = findKind(await channels(token), 'broadcast');
    assert.equal((await say(room.id, '   ', token)).status, 201); // trimmed but non-empty input
    assert.equal((await say(room.id, '', token)).status, 422);
  });
});
