import { Router } from 'express';
import { z } from 'zod';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso, todayIso, parseJson } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, audit, paginate, pageMeta } from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import { DEFAULT_TEMPLATES, CHANNELS, notify, pushConfigured, pushToUser } from '../services/notifications.js';
import { config } from '../config.js';
import { runDeadlineLadder, resolveEscalations } from '../services/deadlines.js';
import { WEBHOOK_EVENTS } from '../services/webhooks.js';

const router = Router();

// ------------------------------------------------------------ inbox (B2/B5)
router.get('/', async (req, res) => {
  const { page, limit, offset } = paginate(req, { defaultLimit: 30 });
  const filters = ['n.tenant_id = ?', 'n.user_id = ?'];
  const params = [req.auth.tenantId, req.auth.userId];

  if (req.query.unread === 'true') filters.push('n.read_at IS NULL');
  if (req.query.channel) { filters.push('n.channel = ?'); params.push(req.query.channel); }
  else filters.push("n.channel = 'in_app'");

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM notifications n WHERE ${where}`, params))?.n || 0);
  const rows = (await all(`SELECT n.* FROM notifications n WHERE ${where} ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset])).map((n) => ({ ...n, meta: parseJson(n.meta, {}) }));

  return ok(res, rows, {
    ...pageMeta(page, limit, total),
    unread: Number((await get(
      "SELECT COUNT(*) AS n FROM notifications WHERE tenant_id = ? AND user_id = ? AND channel = 'in_app' AND read_at IS NULL",
      [req.auth.tenantId, req.auth.userId],
    ))?.n || 0),
  });
});

router.post('/:id/read', async (req, res) => {
  await run('UPDATE notifications SET read_at = ?, status = ? WHERE id = ? AND tenant_id = ? AND user_id = ?',
    [nowIso(), 'read', req.params.id, req.auth.tenantId, req.auth.userId]);
  return ok(res, { ok: true });
});

router.post('/read-all', async (req, res) => {
  await run(
    `UPDATE notifications SET read_at = ?, status = 'read'
      WHERE tenant_id = ? AND user_id = ? AND channel = 'in_app' AND read_at IS NULL`,
    [nowIso(), req.auth.tenantId, req.auth.userId],
  );
  return ok(res, { ok: true });
});

/** B5 - full delivery log with status, for the admin view. */
router.get('/log', requires('settings', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req, { defaultLimit: 50 });
  const filters = ['n.tenant_id = ?'];
  const params = [req.auth.tenantId];

  if (req.query.channel) { filters.push('n.channel = ?'); params.push(req.query.channel); }
  if (req.query.status) { filters.push('n.status = ?'); params.push(req.query.status); }
  if (req.query.event_key) { filters.push('n.event_key = ?'); params.push(req.query.event_key); }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM notifications n WHERE ${where}`, params))?.n || 0);

  return ok(res, await all(
    `SELECT n.*, u.name AS user_name FROM notifications n LEFT JOIN users u ON u.id = n.user_id
      WHERE ${where} ORDER BY n.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ), {
    ...pageMeta(page, limit, total),
    stats: (await all(
      `SELECT n.channel, n.status, COUNT(*) AS n FROM notifications n WHERE ${where}
        GROUP BY n.channel, n.status`,
      params,
    )).map((r) => ({ ...r, n: Number(r.n) })),
  });
});

// -------------------------------------------------------------- preferences
router.get('/preferences', async (req, res) => {
  const user = await get('SELECT notification_prefs FROM users WHERE id = ?', [req.auth.userId]);
  return ok(res, {
    channels: CHANNELS,
    events: Object.keys(DEFAULT_TEMPLATES),
    preferences: parseJson(user?.notification_prefs, {}) || {},
  });
});

router.put('/preferences', async (req, res) => {
  const body = validate(z.object({
    channels: z.record(z.string(), z.boolean()).optional(),
    events: z.record(z.string(), z.record(z.string(), z.boolean())).optional(),
  }), req.body);

  await run('UPDATE users SET notification_prefs = ?, updated_at = ? WHERE id = ?',
    [JSON.stringify(body), nowIso(), req.auth.userId]);
  return ok(res, body);
});

// ---------------------------------------------------------------- templates
router.get('/templates', requires('settings', 'view'), async (req, res) => {
  const custom = await all('SELECT * FROM notification_templates WHERE tenant_id = ?', [req.auth.tenantId]);
  const index = new Map(custom.map((t) => [`${t.event_key}:${t.channel}`, t]));

  return ok(res, Object.entries(DEFAULT_TEMPLATES).flatMap(([eventKey, def]) =>
    CHANNELS.filter((c) => c !== 'push').map((channel) => {
      const override = index.get(`${eventKey}:${channel}`);
      return {
        event_key: eventKey,
        channel,
        subject: override?.subject ?? def.subject,
        body: override?.body ?? def.body,
        customized: !!override,
        id: override?.id ?? null,
      };
    })));
});

router.put('/templates', requires('settings', 'edit'), async (req, res) => {
  const body = validate(z.object({
    event_key: z.string(),
    channel: z.enum(['in_app', 'whatsapp', 'email', 'teams']),
    subject: z.string().optional().nullable(),
    body: z.string().min(1),
  }), req.body);

  if (!DEFAULT_TEMPLATES[body.event_key]) throw badRequest('Unknown notification event');

  await run(
    `INSERT INTO notification_templates (id, tenant_id, event_key, channel, subject, body, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT (tenant_id, event_key, channel) DO UPDATE SET
       subject = excluded.subject, body = excluded.body, updated_at = excluded.updated_at`,
    [uuid(), req.auth.tenantId, body.event_key, body.channel, body.subject ?? null, body.body,
      nowIso(), nowIso()],
  );
  await audit(req, { entity: 'notification_template', action: 'update', after: body });
  return ok(res, body);
});

router.delete('/templates/:eventKey/:channel', requires('settings', 'edit'), async (req, res) => {
  await run('DELETE FROM notification_templates WHERE tenant_id = ? AND event_key = ? AND channel = ?',
    [req.auth.tenantId, req.params.eventKey, req.params.channel]);
  return ok(res, { ok: true, reverted_to_default: true });
});

/** Sends the caller a rendered sample so template edits can be checked live. */
router.post('/test', requires('settings', 'edit'), async (req, res) => {
  const { event_key: eventKey, channel } = validate(
    z.object({ event_key: z.string(), channel: z.enum(['in_app', 'whatsapp', 'email', 'teams']) }), req.body,
  );
  const user = await get('SELECT * FROM users WHERE id = ?', [req.auth.userId]);
  const results = await notify({
    tenantId: req.auth.tenantId,
    user,
    eventKey,
    channels: [channel],
    vars: {
      title: 'Sample action item', priority: 'high', due_date: todayIso(), when: 'tomorrow',
      due_time: '4:00 PM', due: `${todayIso()} · 4:00 PM`, overdue_for: '2 hours',
      client: 'Sample Client', number: 'PHX/2026-27/0001', amount: '₹1,18,000',
      balance: '₹18,000', days_overdue: 2, level: 1, reason: 'sample escalation',
      from: req.auth.name, days: 2, leave_type: 'Casual Leave', status: 'approved',
      from_date: todayIso(), to_date: todayIso(), note: '', view_count: 3,
      accepted_by: 'Sample Signatory', due_today: 4, overdue: 1, follow_ups: 2, meetings: 1,
      escalations: 2, sop_adherence: 88, follow_up_pct: 95, period: 'August 2026',
      entity: 'Sample item', excerpt: 'take a look at this', version: 2, next_action: 'Call back',
    },
  });
  return ok(res, { sent: results });
});

// ================================================================= DEADLINES
router.get('/deadlines', requires('deadlines', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req, { defaultLimit: 50 });
  const filters = ['d.tenant_id = ?'];
  const params = [req.auth.tenantId];

  if (req.query.status) { filters.push('d.status = ?'); params.push(req.query.status); }
  else filters.push("d.status IN ('pending','breached')");
  if (req.query.source_type) { filters.push('d.source_type = ?'); params.push(req.query.source_type); }
  if (req.query.mine === 'true') { filters.push('d.owner_id = ?'); params.push(req.auth.userId); }
  if (!await can(req.auth, 'deadlines', 'approve') && req.auth.scope === 'own') {
    filters.push('(d.owner_id = ? OR d.escalate_to_id = ?)');
    params.push(req.auth.userId, req.auth.userId);
  }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM deadlines d WHERE ${where}`, params))?.n || 0);
  const rows = (await all(
    `SELECT d.*, u.name AS owner_name, e.name AS escalate_to_name FROM deadlines d
       LEFT JOIN users u ON u.id = d.owner_id
       LEFT JOIN users e ON e.id = d.escalate_to_id
      WHERE ${where} ORDER BY d.due_at LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  )).map((d) => ({ ...d, meta: parseJson(d.meta, {}), ladder_sent: parseJson(d.ladder_sent, []) }));

  return ok(res, rows, {
    ...pageMeta(page, limit, total),
    summary: await get(
      `SELECT COUNT(CASE WHEN d.due_at < ? THEN 1 END) AS overdue,
              COUNT(CASE WHEN date(d.due_at) = ? THEN 1 END) AS today,
              COUNT(*) AS total
         FROM deadlines d WHERE ${where}`,
      [nowIso(), todayIso(), ...params],
    ),
  });
});

/** Manual trigger for the reminder ladder - useful in demos and for support. */
router.post('/deadlines/run-ladder', requires('settings', 'edit'), async (req, res) => {
  const result = await runDeadlineLadder();
  await audit(req, { entity: 'deadline', action: 'update', after: result });
  return ok(res, result);
});

// =============================================================== ESCALATIONS
router.get('/escalations', requires('deadlines', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['e.tenant_id = ?'];
  const params = [req.auth.tenantId];

  if (req.query.open === 'true') filters.push('e.resolved_at IS NULL');
  if (req.query.mine === 'true') { filters.push('e.to_user_id = ?'); params.push(req.auth.userId); }
  if (req.query.source_type) { filters.push('e.source_type = ?'); params.push(req.query.source_type); }

  const where = filters.join(' AND ');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM escalations e WHERE ${where}`, params))?.n || 0);

  return ok(res, await all(
    `SELECT e.*, uf.name AS from_name, ut.name AS to_name,
            a.title AS item_title, a.status AS item_status,
            i.number AS invoice_number, c.name AS client_name
       FROM escalations e
       LEFT JOIN users uf ON uf.id = e.from_user_id
       LEFT JOIN users ut ON ut.id = e.to_user_id
       LEFT JOIN action_items a ON a.id = e.source_id AND e.source_type = 'action_item'
       LEFT JOIN invoices i ON i.id = e.source_id AND e.source_type = 'invoice'
       LEFT JOIN clients c ON c.id = e.source_id AND e.source_type = 'follow_up'
      WHERE ${where} ORDER BY e.created_at DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  ), pageMeta(page, limit, total));
});

router.post('/escalations/:id/resolve', requires('deadlines', 'approve'), async (req, res) => {
  const { note } = validate(z.object({ note: z.string().optional() }), req.body || {});
  const esc = await get('SELECT * FROM escalations WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!esc) throw notFound('Escalation');

  await run('UPDATE escalations SET resolved_at = ?, resolution_note = ? WHERE id = ?',
    [nowIso(), note ?? null, esc.id]);
  await audit(req, { entity: 'escalation', entityId: esc.id, action: 'approve', after: { note } });
  return ok(res, await get('SELECT * FROM escalations WHERE id = ?', [esc.id]));
});

// ================================================================= WEBHOOKS
router.get('/webhooks', requires('settings', 'view'), async (req, res) => ok(res, {
  available_events: WEBHOOK_EVENTS,
  endpoints: (await all('SELECT id, url, events, active, created_at FROM webhook_endpoints WHERE tenant_id = ?',
    [req.auth.tenantId])).map((e) => ({ ...e, events: parseJson(e.events, []) })),
  recent_deliveries: await all(
    `SELECT d.id, d.event, d.status, d.attempts, d.response_code, d.created_at, d.delivered_at, e.url
       FROM webhook_deliveries d JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.tenant_id = ? ORDER BY d.created_at DESC LIMIT 50`,
    [req.auth.tenantId],
  ),
}));

router.post('/webhooks', requires('settings', 'edit'), async (req, res) => {
  const body = validate(z.object({
    url: z.string().url(),
    events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  }), req.body);

  const id = uuid();
  const secret = uuid().replace(/-/g, '');
  await run(
    'INSERT INTO webhook_endpoints (id, tenant_id, url, events, secret, created_at) VALUES (?,?,?,?,?,?)',
    [id, req.auth.tenantId, body.url, JSON.stringify(body.events), secret, nowIso()],
  );
  await audit(req, { entity: 'webhook_endpoint', entityId: id, action: 'create', after: { url: body.url } });

  // The signing secret is shown once, at creation.
  return created(res, { id, url: body.url, events: body.events, secret });
});

router.delete('/webhooks/:id', requires('settings', 'edit'), async (req, res) => {
  await run('DELETE FROM webhook_endpoints WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  return ok(res, { ok: true });
});

// ------------------------------------------------------------ browser pop-ups
/** Whether pop-ups are available here, and the key a browser subscribes with. */
router.get('/push/config', async (req, res) => ok(res, {
  enabled: pushConfigured(),
  public_key: config.providers.push.publicKey || null,
  subscribed_browsers: Number((await get('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [req.auth.userId]))?.n || 0),
}));

/** This browser wants pop-ups for the signed-in person. Re-sent on every sign-in. */
router.post('/push/subscribe', async (req, res) => {
  const body = validate(z.object({
    endpoint: z.string().url().max(2000),
    keys: z.object({ p256dh: z.string().min(10).max(500), auth: z.string().min(4).max(200) }),
  }), req.body);
  // The endpoint identifies the browser: whoever signed in last owns it.
  await run('DELETE FROM push_subscriptions WHERE endpoint = ?', [body.endpoint]);
  await run(
    `INSERT INTO push_subscriptions (id, tenant_id, user_id, endpoint, p256dh, auth, user_agent, created_at)
     VALUES (?,?,?,?,?,?,?,?)`,
    [uuid(), req.auth.tenantId, req.auth.userId, body.endpoint, body.keys.p256dh, body.keys.auth,
      String(req.get('user-agent') || '').slice(0, 300), nowIso()],
  );
  return created(res, { subscribed: true });
});

/** Stop pop-ups in this browser (switched off, or signing out). */
router.post('/push/unsubscribe', async (req, res) => {
  const endpoint = String(req.body?.endpoint || '');
  await run('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', [endpoint, req.auth.userId]);
  return ok(res, { subscribed: false });
});

/** "Send me a test pop-up". */
router.post('/push/test', async (req, res) => {
  if (!pushConfigured()) throw badRequest('Browser pop-ups are not set up on this server yet');
  const out = await pushToUser(req.auth.userId, {
    title: 'Pop-ups are on',
    body: 'This is how Phoenixx OS notifications will appear.',
    link: '/',
    tag: `test-${Date.now()}`,
  });
  if (out.skipped) throw badRequest('Pop-ups are not switched on in any of your browsers');
  return ok(res, out);
});

export { router as notificationsRouter };
