import { EventEmitter } from 'node:events';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { notifyMany } from './notifications.js';

/**
 * Module B - internal chat.
 *
 * Three rules shape everything here:
 *
 * 1. Membership is derived wherever a source of truth already exists. A project
 *    channel's members ARE the project's team (Module F), and the company
 *    broadcast's members ARE the workspace. Nobody maintains a second list that
 *    can drift, and joining a project team is the same act as joining its room.
 * 2. Unread state is one timestamp per member (`last_read_at`), not a read
 *    receipt per message, so a badge costs one indexed COUNT.
 * 3. Delivery is best-effort live on top of a durable read model. A client
 *    that misses an event still sees everything on its next fetch, so a
 *    dropped connection is never a lost message.
 *
 * Every event is written to `chat_events`, so any server instance can hand
 * it out - which is what a serverless host (Vercel) needs, since there is no
 * one process every client is connected to. Clients poll /chat/events with
 * the last `seq` they saw. The in-process `bus` still pushes instantly to
 * SSE clients connected to this same instance, on hosts that keep one alive.
 */

/** In-process fan-out to SSE clients connected to this instance. */
export const bus = new EventEmitter();
bus.setMaxListeners(0);

export const BROADCAST_NAME = 'Company announcements';

/** Roles that may post in the company broadcast channel out of the box. */
const BROADCAST_ROLES = ['owner', 'super_admin', 'manager', 'hr'];

async function publish(tenantId, event, payload) {
  const { member_ids: memberIds, ...rest } = payload;
  await run(
    'INSERT INTO chat_events (tenant_id, event, payload, member_ids, created_at) VALUES (?,?,?,?,?)',
    [tenantId, event, JSON.stringify(rest), memberIds ? JSON.stringify(memberIds) : null, nowIso()],
  );
  bus.emit('event', { tenantId, event, payload });
}

/** The newest event id in this workspace: where a fresh client starts listening. */
export async function latestChatCursor(tenantId) {
  return Number((await get('SELECT MAX(seq) AS seq FROM chat_events WHERE tenant_id = ?', [tenantId]))?.seq || 0);
}

/**
 * Events after `after` that this user may receive. The cursor returned moves
 * past events filtered out too, so they are never fetched again.
 */
export async function chatEventsAfter(tenantId, userId, after, limit = 200) {
  const rows = await all(
    'SELECT seq, event, payload, member_ids FROM chat_events WHERE tenant_id = ? AND seq > ? ORDER BY seq LIMIT ?',
    [tenantId, after, limit],
  );
  const audienceCache = new Map();
  const events = [];
  for (const r of rows) {
    const payload = JSON.parse(r.payload);
    let audience = r.member_ids ? JSON.parse(r.member_ids) : audienceCache.get(payload.channel_id);
    if (!audience) {
      audience = await memberIdsOf(payload.channel_id);
      audienceCache.set(payload.channel_id, audience);
    }
    if (audience.includes(userId)) events.push({ type: r.event, ...payload });
  }
  return { cursor: rows.length ? Number(rows.at(-1).seq) : after, events };
}

/** Delivery log housekeeping: anything older than two days has been seen or refetched. */
export async function pruneChatEvents() {
  const cutoff = new Date(Date.now() - 2 * 86_400_000).toISOString();
  return (await run('DELETE FROM chat_events WHERE created_at < ?', [cutoff])).changes;
}

// ------------------------------------------------------------------ queries
export const CHANNEL_SELECT = `
  SELECT ch.*, p.name AS project_name, p.status AS project_status, cl.name AS client_name,
         (SELECT COUNT(*) FROM channel_members cm WHERE cm.channel_id = ch.id AND cm.deleted_at IS NULL) AS member_count
    FROM channels ch
    LEFT JOIN projects p ON p.id = ch.project_id
    LEFT JOIN clients cl ON cl.id = p.client_id`;

export const MESSAGE_SELECT = `
  SELECT m.*, u.name AS author_name, u.avatar_url AS author_avatar, u.designation AS author_designation,
         r.body AS reply_body, ru.name AS reply_author_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.author_id
    LEFT JOIN messages r ON r.id = m.reply_to_id
    LEFT JOIN users ru ON ru.id = r.author_id`;

export const membershipOf = async (tenantId, channelId, userId) => await get(
  `SELECT cm.* FROM channel_members cm
    WHERE cm.channel_id = ? AND cm.user_id = ? AND cm.tenant_id = ? AND cm.deleted_at IS NULL`,
  [channelId, userId, tenantId],
);

export const memberIdsOf = async (channelId) => (await all(
  'SELECT user_id FROM channel_members WHERE channel_id = ? AND deleted_at IS NULL',
  [channelId],
)).map((r) => r.user_id);

/**
 * A direct-message channel is identified by its two participants, not by a
 * name, so the pair is sorted into a stable key and opening a DM twice finds
 * the same room instead of creating a second one.
 */
export const dmKey = (a, b) => [a, b].sort().join(':');

/** Everyone in the workspace who can hold a conversation (portal users cannot). */
const staffIds = async (tenantId) => (await all(
  `SELECT id FROM users WHERE tenant_id = ? AND deleted_at IS NULL
     AND status != 'disabled' AND role != 'client'`,
  [tenantId],
)).map((u) => u.id);

// ------------------------------------------------------------- membership
/** Adds a member if they are not already in the channel. Returns true if added. */
export async function addMember(tenantId, channelId, userId, role = 'member') {
  if (!userId) return false;
  const existing = await get(
    'SELECT id, deleted_at FROM channel_members WHERE channel_id = ? AND user_id = ?',
    [channelId, userId],
  );
  if (existing && !existing.deleted_at) {
    if (role === 'owner') await run('UPDATE channel_members SET role = ? WHERE id = ?', [role, existing.id]);
    return false;
  }
  if (existing) {
    // Re-joining: clear the tombstone rather than inserting a duplicate row.
    await run('UPDATE channel_members SET deleted_at = NULL, role = ?, joined_at = ? WHERE id = ?',
      [role, nowIso(), existing.id]);
    return true;
  }
  await run(
    `INSERT INTO channel_members (id, tenant_id, channel_id, user_id, role, joined_at)
     VALUES (?,?,?,?,?,?)`,
    [uuid(), tenantId, channelId, userId, role, nowIso()],
  );
  return true;
}

export async function removeMember(channelId, userId) {
  const row = await get('SELECT id FROM channel_members WHERE channel_id = ? AND user_id = ? AND deleted_at IS NULL',
    [channelId, userId]);
  if (!row) return false;
  await run('UPDATE channel_members SET deleted_at = ? WHERE id = ?', [nowIso(), row.id]);
  return true;
}

// --------------------------------------------------------------- channels
/** The one company-wide room. Created on demand so old tenants get it too. */
export async function ensureBroadcastChannel(tenantId, createdBy = null) {
  let channel = await get(
    "SELECT * FROM channels WHERE tenant_id = ? AND kind = 'broadcast' AND deleted_at IS NULL",
    [tenantId],
  );
  if (!channel) {
    const id = uuid();
    const at = nowIso();
    await run(
      `INSERT INTO channels (id, tenant_id, kind, name, topic, post_policy, created_by, created_at, updated_at)
       VALUES (?,?, 'broadcast', ?, ?, 'admins', ?, ?, ?)`,
      [id, tenantId, BROADCAST_NAME, 'Company-wide announcements. Everyone sees these.', createdBy, at, at],
    );
    channel = await get('SELECT * FROM channels WHERE id = ?', [id]);
  }
  // Everyone belongs here, including people who joined after the channel did.
  for (const userId of await staffIds(tenantId)) await addMember(tenantId, channel.id, userId);
  return channel;
}

/** May this person post in the broadcast channel? */
export const canBroadcast = (auth) => BROADCAST_ROLES.includes(auth.role);

/**
 * The room for a project's delivery team. Created with the project, and its
 * membership reconciled against `project_members` on every team change.
 */
export async function ensureProjectChannel(tenantId, project, createdBy = null) {
  let channel = await get(
    'SELECT * FROM channels WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL',
    [tenantId, project.id],
  );
  if (!channel) {
    const id = uuid();
    const at = nowIso();
    await run(
      `INSERT INTO channels (id, tenant_id, kind, name, topic, project_id, created_by, created_at, updated_at)
       VALUES (?,?, 'project', ?, ?, ?, ?, ?, ?)`,
      [id, tenantId, project.name, 'Delivery team room', project.id, createdBy, at, at],
    );
    channel = await get('SELECT * FROM channels WHERE id = ?', [id]);
  }
  return channel;
}

/**
 * Reconcile a project channel's membership with the project's team, posting a
 * system line for each arrival and departure so the room explains itself.
 * Called after any change to `project_members`, and safe to call repeatedly.
 */
export async function syncProjectChannel(tenantId, projectId, { actorId = null } = {}) {
  const project = await get('SELECT * FROM projects WHERE id = ? AND tenant_id = ?', [projectId, tenantId]);
  if (!project) return null;

  const channel = await get('SELECT * FROM channels WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL',
    [tenantId, projectId]);

  // An archived project archives its room; nothing to reconcile.
  if (project.deleted_at) {
    if (channel) await run('UPDATE channels SET archived_at = ?, updated_at = ? WHERE id = ?',
      [project.deleted_at, nowIso(), channel.id]);
    return channel;
  }

  const room = channel || await ensureProjectChannel(tenantId, project, actorId);

  // The room's name follows the project's name.
  if (room.name !== project.name) {
    await run('UPDATE channels SET name = ?, updated_at = ? WHERE id = ?', [project.name, nowIso(), room.id]);
  }

  const team = await all(
    `SELECT pm.user_id, pm.seat, u.name FROM project_members pm
       JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = ? AND pm.tenant_id = ? AND pm.deleted_at IS NULL`,
    [projectId, tenantId],
  );
  const teamIds = new Set(team.map((m) => m.user_id));
  const current = new Set(await memberIdsOf(room.id));

  for (const member of team) {
    // The project manager owns the room, so they can rename it or pin things.
    const role = member.seat === 'manager' ? 'owner' : 'member';
    if (await addMember(tenantId, room.id, member.user_id, role)) {
      await systemMessage(tenantId, room.id, `${member.name} joined the team as ${member.seat}.`);
    }
  }
  for (const userId of current) {
    if (teamIds.has(userId)) continue;
    const person = await get('SELECT name FROM users WHERE id = ?', [userId]);
    if (await removeMember(room.id, userId)) {
      await systemMessage(tenantId, room.id, `${person?.name || 'Someone'} left the team.`);
    }
  }

  return await get('SELECT * FROM channels WHERE id = ?', [room.id]);
}

/** Opens the two-person room for a pair, creating it the first time. */
export async function ensureDirectChannel(tenantId, userA, userB) {
  const key = dmKey(userA, userB);
  let channel = await get('SELECT * FROM channels WHERE tenant_id = ? AND dm_key = ? AND deleted_at IS NULL',
    [tenantId, key]);
  if (!channel) {
    const id = uuid();
    const at = nowIso();
    await run(
      `INSERT INTO channels (id, tenant_id, kind, dm_key, created_by, created_at, updated_at)
       VALUES (?,?, 'direct', ?, ?, ?, ?)`,
      [id, tenantId, key, userA, at, at],
    );
    channel = await get('SELECT * FROM channels WHERE id = ?', [id]);
  }
  await addMember(tenantId, channel.id, userA);
  await addMember(tenantId, channel.id, userB);
  return channel;
}

// --------------------------------------------------------------- messages
/** Free text -> the user ids it names, matched against channel members only. */
export async function resolveMentions(tenantId, channelId, body) {
  if (!body.includes('@')) return [];
  const members = await all(
    `SELECT u.id, u.name, u.email FROM channel_members cm JOIN users u ON u.id = cm.user_id
      WHERE cm.channel_id = ? AND cm.tenant_id = ? AND cm.deleted_at IS NULL`,
    [channelId, tenantId],
  );
  const lower = body.toLowerCase();
  const hit = new Set();
  for (const m of members) {
    const handle = m.email.split('@')[0].toLowerCase();
    const first = m.name.split(' ')[0].toLowerCase();
    // Longest form first so "@priya venkatesh" does not also half-match someone
    // else called Priya; a bare first name still works when it is unambiguous.
    if (lower.includes(`@${m.name.toLowerCase()}`) || lower.includes(`@${handle}`)) hit.add(m.id);
    else if (lower.includes(`@${first}`) && members.filter((x) => x.name.split(' ')[0].toLowerCase() === first).length === 1) hit.add(m.id);
  }
  return [...hit];
}

/** A message with no author: "X joined the team", "renamed to Y". */
export async function systemMessage(tenantId, channelId, body) {
  const id = uuid();
  const at = nowIso();
  await run(
    `INSERT INTO messages (id, tenant_id, channel_id, author_id, kind, body, created_at)
     VALUES (?,?,?, NULL, 'system', ?, ?)`,
    [id, tenantId, channelId, body, at],
  );
  await run('UPDATE channels SET last_message_at = ?, message_count = message_count + 1, updated_at = ? WHERE id = ?',
    [at, at, channelId]);
  const row = await get(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]);
  await publish(tenantId, 'message', { channel_id: channelId, message: row, member_ids: await memberIdsOf(channelId) });
  return row;
}

/**
 * Post to a channel. Writes the message, moves the channel to the top of
 * everyone's list, marks the author as caught up, pushes to live listeners and
 * queues notifications for the people who should hear about it out of band.
 */
export async function postMessage({
  tenantId, channelId, author, body, replyToId = null, notify = true,
}) {
  const at = nowIso();
  const mentions = await resolveMentions(tenantId, channelId, body);
  const id = uuid();

  await tx(async () => {
    await run(
      `INSERT INTO messages (id, tenant_id, channel_id, author_id, kind, body, mentions, reply_to_id, created_at)
       VALUES (?,?,?,?, 'text', ?,?,?,?)`,
      [id, tenantId, channelId, author.id, body, JSON.stringify(mentions), replyToId, at],
    );
    await run('UPDATE channels SET last_message_at = ?, message_count = message_count + 1, updated_at = ? WHERE id = ?',
      [at, at, channelId]);
    // Posting is reading: the author never sees their own message as unread.
    await run('UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ?',
      [at, channelId, author.id]);
  });

  const message = await get(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]);
  const memberIds = await memberIdsOf(channelId);
  await publish(tenantId, 'message', { channel_id: channelId, message, member_ids: memberIds });

  if (notify) await notifyForMessage({ tenantId, channelId, author, message, mentions, memberIds });
  return message;
}

/**
 * Who hears about a message outside the app.
 *
 * A broadcast reaches everyone - that is the point of it. Anywhere else, only
 * the people named are pulled out of what they were doing; the rest see it when
 * they next look, which is what stops a chat feature turning into noise.
 */
async function notifyForMessage({ tenantId, channelId, author, message, mentions, memberIds }) {
  const channel = await get('SELECT * FROM channels WHERE id = ?', [channelId]);
  const link = `/chat?channel=${channelId}`;
  const preview = message.body.length > 160 ? `${message.body.slice(0, 157)}…` : message.body;

  if (channel.kind === 'broadcast') {
    await notifyMany({
      tenantId,
      userIds: memberIds.filter((id) => id !== author.id),
      eventKey: 'chat.broadcast',
      vars: { author: author.name, channel: channel.name, preview },
      link,
    });
    return;
  }

  const muted = new Set((await all(
    'SELECT user_id FROM channel_members WHERE channel_id = ? AND muted = 1 AND deleted_at IS NULL',
    [channelId],
  )).map((r) => r.user_id));

  const targets = mentions.filter((id) => id !== author.id && !muted.has(id));
  if (!targets.length) return;

  await notifyMany({
    tenantId,
    userIds: targets,
    eventKey: 'chat.mention',
    vars: { author: author.name, channel: await channelLabel(channel, author.id), preview },
    link,
  });
}

/** A DM has no name of its own; it is labelled by the other person. */
export async function channelLabel(channel, viewerId) {
  if (channel.kind !== 'direct') return channel.name || 'Conversation';
  const otherId = (channel.dm_key || '').split(':').find((id) => id !== viewerId);
  return (await get('SELECT name FROM users WHERE id = ?', [otherId]))?.name || 'Direct message';
}

// ----------------------------------------------------------------- unread
/**
 * The channel list for one person: every room they are in, newest activity
 * first, with the unread count and a one-line preview already attached.
 */
export async function channelsFor(tenantId, userId, { includeArchived = false } = {}) {
  const rows = await all(
    `SELECT ch.*, p.name AS project_name, p.status AS project_status, cl.name AS client_name,
            cm.last_read_at, cm.muted, cm.role AS my_role,
            (SELECT COUNT(*) FROM channel_members x WHERE x.channel_id = ch.id AND x.deleted_at IS NULL) AS member_count
       FROM channel_members cm
       JOIN channels ch ON ch.id = cm.channel_id
       LEFT JOIN projects p ON p.id = ch.project_id
       LEFT JOIN clients cl ON cl.id = p.client_id
      WHERE cm.user_id = ? AND cm.tenant_id = ? AND cm.deleted_at IS NULL AND ch.deleted_at IS NULL
        ${includeArchived ? '' : 'AND ch.archived_at IS NULL'}
      ORDER BY ch.last_message_at IS NULL, ch.last_message_at DESC, ch.created_at DESC`,
    [userId, tenantId],
  );

  return await Promise.all(rows.map(async (ch) => {
    return {
      ...ch,
      label: await channelLabel(ch, userId),
      counterpart: ch.kind === 'direct' ? await counterpartOf(ch, userId) : null,
      muted: ch.muted === 1,
      unread: await unreadCount(ch.id, userId, ch.last_read_at),
      last_message: await get(
        `SELECT m.body, m.kind, m.created_at, u.name AS author_name FROM messages m
           LEFT JOIN users u ON u.id = m.author_id
          WHERE m.channel_id = ? AND m.deleted_at IS NULL ORDER BY m.created_at DESC LIMIT 1`,
        [ch.id],
      ) || null,
    };
  }));
}

/** The other participant in a DM, for the avatar and the label. */
async function counterpartOf(channel, viewerId) {
  const otherId = (channel.dm_key || '').split(':').find((id) => id !== viewerId);
  return await get('SELECT id, name, avatar_url, designation, role FROM users WHERE id = ?', [otherId]) || null;
}

export async function unreadCount(channelId, userId, lastReadAt) {
  return Number((await get(
    `SELECT COUNT(*) AS n FROM messages
      WHERE channel_id = ? AND deleted_at IS NULL AND kind = 'text'
        AND author_id IS DISTINCT FROM ? AND created_at > ?`,
    [channelId, userId, lastReadAt || '1970-01-01T00:00:00.000Z'],
  ))?.n || 0);
}

/** Total unread across every room, for the sidebar badge. */
export async function totalUnread(tenantId, userId) {
  const rows = await all(
    `SELECT cm.channel_id, cm.last_read_at FROM channel_members cm
       JOIN channels ch ON ch.id = cm.channel_id
      WHERE cm.user_id = ? AND cm.tenant_id = ? AND cm.deleted_at IS NULL
        AND cm.muted = 0 AND ch.deleted_at IS NULL AND ch.archived_at IS NULL`,
    [userId, tenantId],
  );
  let n = 0;
  for (const r of rows) n += await unreadCount(r.channel_id, userId, r.last_read_at);
  return n;
}

export async function markRead(tenantId, channelId, userId) {
  const at = nowIso();
  await run('UPDATE channel_members SET last_read_at = ? WHERE channel_id = ? AND user_id = ? AND tenant_id = ?',
    [at, channelId, userId, tenantId]);
  await publish(tenantId, 'read', { channel_id: channelId, user_id: userId, at });
  return at;
}
