import crypto from 'node:crypto';
import { all, run, get } from '../db/index.js';
import { uuid, nowIso, parseJson } from '../lib/util.js';

/**
 * AR3 - outbound webhooks so tenants can automate off platform events.
 * Deliveries are queued to a table and flushed by the job runner with retries,
 * so a slow subscriber never blocks an API request.
 */

export const WEBHOOK_EVENTS = [
  'invoice.paid',
  'invoice.sent',
  'invoice.overdue',
  'client.stage_changed',
  'escalation.raised',
  'proposal.accepted',
  'action_item.completed',
  'action_item.validated',
  'action_item.changes_requested',
];

const sign = (secret, payload) =>
  crypto.createHmac('sha256', secret).update(payload).digest('hex');

/** Queue an event for every endpoint subscribed to it. Never throws. */
export async function emitWebhook(tenantId, event, data) {
  try {
    const endpoints = (await all(
      'SELECT * FROM webhook_endpoints WHERE tenant_id = ? AND active = 1',
      [tenantId],
    )).filter((e) => (parseJson(e.events, []) || []).includes(event));

    for (const ep of endpoints) {
      await run(
        `INSERT INTO webhook_deliveries (id, tenant_id, endpoint_id, event, payload, status, created_at)
         VALUES (?,?,?,?,?, 'pending', ?)`,
        [uuid(), tenantId, ep.id, event, JSON.stringify({ event, created_at: nowIso(), data }), nowIso()],
      );
    }
  } catch (err) {
    console.error('[webhook] queue failed', err.message);
  }
}

const MAX_ATTEMPTS = 5;

/** Flush pending deliveries with capped exponential backoff. */
export async function flushWebhooks({ limit = 25 } = {}) {
  const pending = await all(
    `SELECT d.*, e.url, e.secret FROM webhook_deliveries d
       JOIN webhook_endpoints e ON e.id = d.endpoint_id
      WHERE d.status = 'pending' AND d.attempts < ? AND e.active = 1
      ORDER BY d.created_at LIMIT ?`,
    [MAX_ATTEMPTS, limit],
  );
  let delivered = 0;

  for (const d of pending) {
    // Backoff: 1m, 2m, 4m, 8m between attempts.
    const waitMs = d.attempts ? 60_000 * 2 ** (d.attempts - 1) : 0;
    if (Date.now() - new Date(d.created_at).getTime() < waitMs) continue;

    const attempts = d.attempts + 1;
    try {
      const res = await fetch(d.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Phoenixx-Event': d.event,
          'X-Phoenixx-Signature': sign(d.secret, d.payload),
          'X-Phoenixx-Delivery': d.id,
        },
        body: d.payload,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) {
        await run(`UPDATE webhook_deliveries SET status = 'delivered', attempts = ?, response_code = ?, delivered_at = ? WHERE id = ?`,
          [attempts, res.status, nowIso(), d.id]);
        delivered++;
      } else {
        await run(`UPDATE webhook_deliveries SET status = ?, attempts = ?, response_code = ? WHERE id = ?`,
          [attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, res.status, d.id]);
      }
    } catch (err) {
      await run(`UPDATE webhook_deliveries SET status = ?, attempts = ?, error = ? WHERE id = ?`,
        [attempts >= MAX_ATTEMPTS ? 'failed' : 'pending', attempts, err.message, d.id]);
    }
  }
  return { pending: pending.length, delivered };
}

export const endpointById = async (tenantId, id) =>
  await get('SELECT * FROM webhook_endpoints WHERE tenant_id = ? AND id = ?', [tenantId, id]);
