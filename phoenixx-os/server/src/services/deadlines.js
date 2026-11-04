import { get, all, run } from '../db/index.js';
import { uuid, nowIso, parseJson, formatMoney } from '../lib/util.js';
import {
  DEFAULT_TZ, REMINDER_LEAD_MINUTES, dayDiffInTz, formatDueTime,
} from '../lib/dueTime.js';
import { notify, notifyMany } from './notifications.js';
import { emitWebhook } from './webhooks.js';

/**
 * Module B - the central deadline engine.
 *
 * Every module that owns a date registers it here (B1) instead of writing its
 * own reminder logic. One ladder implementation (B3), one escalation path (A4),
 * one place to audit what was sent.
 */

export const LADDER = [
  { rung: 't-3d', offsetDays: -3, label: 'in 3 days' },
  { rung: 't-1d', offsetDays: -1, label: 'tomorrow' },
  { rung: 'due', offsetDays: 0, label: 'today' },
];

/**
 * The extra rung a deadline earns by naming a time of day. A task due "Tuesday"
 * cannot usefully be warned about half an hour beforehand - a task due at 4pm
 * can, and that nudge is most of what makes same-day scheduling work.
 */
export const TIMED_REMINDER = { rung: 't-30m', label: `in ${REMINDER_LEAD_MINUTES} minutes` };

/** Register (or refresh) a deadline for any source record. Idempotent. */
export async function upsertDeadline({
  tenantId, sourceType, sourceId, title, dueAt, ownerId,
  escalateToId = null, escalationDays = 3, severity = 'normal', meta = {},
}) {
  if (!dueAt) return await cancelDeadline(tenantId, sourceType, sourceId);
  const existing = await get(
    'SELECT * FROM deadlines WHERE tenant_id = ? AND source_type = ? AND source_id = ?',
    [tenantId, sourceType, sourceId],
  );
  const due = String(dueAt).length === 10 ? `${dueAt}T18:00:00.000Z` : dueAt;

  if (existing) {
    // A moved due date resets the ladder so the new schedule is honoured.
    const resetLadder = existing.due_at !== due;
    await run(
      `UPDATE deadlines SET title = ?, due_at = ?, owner_id = ?, escalate_to_id = ?, escalation_days = ?,
         severity = ?, meta = ?, status = CASE WHEN status IN ('met','cancelled') THEN 'pending' ELSE status END,
         ladder_sent = ?, updated_at = ? WHERE id = ?`,
      [title, due, ownerId, escalateToId, escalationDays, severity, JSON.stringify(meta),
        resetLadder ? '[]' : existing.ladder_sent, nowIso(), existing.id],
    );
    return existing.id;
  }

  const id = uuid();
  await run(
    `INSERT INTO deadlines (id, tenant_id, source_type, source_id, title, due_at, owner_id,
       escalate_to_id, status, severity, ladder_sent, escalation_days, meta, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,'pending',?,'[]',?,?,?,?)`,
    [id, tenantId, sourceType, sourceId, title, due, ownerId, escalateToId, severity,
      escalationDays, JSON.stringify(meta), nowIso(), nowIso()],
  );
  return id;
}

export async function resolveDeadline(tenantId, sourceType, sourceId, status = 'met') {
  await run(
    `UPDATE deadlines SET status = ?, resolved_at = ?, updated_at = ?
      WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND status = 'pending'`,
    [status, nowIso(), nowIso(), tenantId, sourceType, sourceId],
  );
}

export const cancelDeadline = async (tenantId, sourceType, sourceId) =>
  await resolveDeadline(tenantId, sourceType, sourceId, 'cancelled');

// ---------------------------------------------------------------- ladder tick
const userById = async (id) => (id ? await get('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [id]) : null);

const linkFor = (d) => ({
  action_item: `/action-items/${d.source_id}`,
  invoice: `/invoices/${d.source_id}`,
  proposal: `/proposals/${d.source_id}`,
  follow_up: `/crm/${d.source_id}`,
  leave: '/hr/leave',
}[d.source_type] || '/');

/** "45 minutes" / "2 hours" / "3 days" - whichever unit reads honestly. */
function overdueLabel(minutesLate, daysLate) {
  if (daysLate >= 1) return `${daysLate} day${daysLate > 1 ? 's' : ''}`;
  const hours = Math.floor(minutesLate / 60);
  if (hours >= 1) return `${hours} hour${hours > 1 ? 's' : ''}`;
  const minutes = Math.max(1, Math.floor(minutesLate));
  return `${minutes} minute${minutes > 1 ? 's' : ''}`;
}

const eventKeyFor = (sourceType, phase) => {
  if (sourceType === 'invoice') return phase === 'overdue' ? 'invoice.overdue' : 'invoice.due_soon';
  if (sourceType === 'follow_up') return 'follow_up.due';
  return phase === 'overdue' ? 'action_item.overdue' : 'action_item.due_soon';
};

/**
 * Runs the reminder ladder for every pending deadline and raises escalations
 * for anything overdue past its configured window. Safe to run repeatedly -
 * each rung is deduped by (deadline, rung).
 */
export async function runDeadlineLadder({ now = new Date() } = {}) {
  const pending = await all(
    `SELECT d.*, t.currency, t.number_format, t.timezone FROM deadlines d
       JOIN tenants t ON t.id = d.tenant_id
      WHERE d.status = 'pending' AND t.status = 'active' AND t.deleted_at IS NULL`,
  );
  let sent = 0;

  for (const d of pending) {
    const tz = d.timezone || DEFAULT_TZ;
    const meta = parseJson(d.meta, {}) || {};
    // Whether this deadline names a time somebody chose, or just the end of a
    // day. The pre-due rungs are the same either way; what changes is the
    // half-hour warning and, crucially, the minute a breach begins.
    const timed = !!meta.timed;
    // Counted in calendar days on the workspace clock, so "tomorrow" means the
    // next day people will come to work and not a rounded 24-hour block.
    const daysToDue = dayDiffInTz(now, d.due_at, tz);
    const minutesToDue = (new Date(d.due_at).getTime() - now.getTime()) / 60_000;
    const ladderSent = parseJson(d.ladder_sent, []) || [];
    const owner = await userById(d.owner_id);

    const vars = {
      title: d.title,
      due_date: meta.due_date || d.due_at.slice(0, 10),
      due_time: timed ? formatDueTime(meta.due_time) : '',
      due: timed
        ? `${meta.due_date || d.due_at.slice(0, 10)} · ${formatDueTime(meta.due_time)}`
        : (meta.due_date || d.due_at.slice(0, 10)),
      client: meta.client || '-',
      number: meta.number || '',
      amount: meta.amount_minor != null ? formatMoney(meta.amount_minor, d.currency, d.number_format) : '',
      balance: meta.balance_minor != null ? formatMoney(meta.balance_minor, d.currency, d.number_format) : '',
      priority: meta.priority || 'medium',
      next_action: meta.next_action || d.title,
    };

    // --- the half-hour warning, for a deadline that named a time ---------
    if (timed && !ladderSent.includes(TIMED_REMINDER.rung)
        && minutesToDue > 0 && minutesToDue <= REMINDER_LEAD_MINUTES) {
      if (owner) {
        await notify({
          tenantId: d.tenant_id,
          user: owner,
          eventKey: eventKeyFor(d.source_type, 'due'),
          vars: { ...vars, when: TIMED_REMINDER.label },
          link: linkFor(d),
          dedupeKey: `deadline:${d.id}:${TIMED_REMINDER.rung}`,
        });
        sent++;
      }
      ladderSent.push(TIMED_REMINDER.rung);
    }

    // --- pre-due rungs -------------------------------------------------
    for (const rung of LADDER) {
      if (ladderSent.includes(rung.rung)) continue;
      if (daysToDue !== -rung.offsetDays) continue;
      // On the day itself, a timed deadline's "due today" nudge is only worth
      // sending while the time is still ahead - after that it is overdue, and
      // the overdue rung below is the one that should speak.
      if (rung.rung === 'due' && timed && minutesToDue <= 0) continue;
      if (owner) {
        await notify({
          tenantId: d.tenant_id,
          user: owner,
          eventKey: eventKeyFor(d.source_type, 'due'),
          vars: { ...vars, when: rung.label },
          link: linkFor(d),
          dedupeKey: `deadline:${d.id}:${rung.rung}`,
        });
        sent++;
      }
      ladderSent.push(rung.rung);
    }

    // --- overdue -------------------------------------------------------
    // A deadline with a time on it breaches at that minute; one without breaches
    // once its whole day is out. Both are the same comparison, because an
    // untimed deadline is stored as the end of its own day.
    const overdue = timed ? minutesToDue < 0 : daysToDue < 0;
    if (overdue) {
      // Whole days late, so an escalation window measured in days still means
      // days. A task that went past its 4pm slot this afternoon is 0 days late,
      // which is exactly what a category set to escalate immediately wants.
      const daysOverdue = timed
        ? Math.floor(-minutesToDue / 1440)
        : -daysToDue;
      // How late it is, said the way a person would. A task that missed its
      // 4pm slot is "2 hours overdue", not "0 day(s) overdue".
      const overdueFor = overdueLabel(-minutesToDue, daysOverdue);
      const rung = `overdue-${daysOverdue}`;
      if (!ladderSent.includes(rung) && owner) {
        await notify({
          tenantId: d.tenant_id,
          user: owner,
          eventKey: eventKeyFor(d.source_type, 'overdue'),
          vars: { ...vars, days_overdue: daysOverdue, overdue_for: overdueFor },
          link: linkFor(d),
          dedupeKey: `deadline:${d.id}:${rung}`,
        });
        ladderSent.push(rung);
        sent++;
      }
      if (d.status === 'pending') {
        await run("UPDATE deadlines SET status = 'breached', updated_at = ? WHERE id = ?", [nowIso(), d.id]);
      }
      // B3/A4: overdue past the configured window escalates to the manager.
      if (daysOverdue >= d.escalation_days) {
        await raiseEscalation({
          tenantId: d.tenant_id,
          sourceType: d.source_type,
          sourceId: d.source_id,
          title: d.title,
          fromUserId: d.owner_id,
          toUserId: d.escalate_to_id || owner?.manager_id,
          reason: `${overdueFor} overdue`,
          link: linkFor(d),
        });
      }
    }

    await run('UPDATE deadlines SET ladder_sent = ?, updated_at = ? WHERE id = ?',
      [JSON.stringify(ladderSent), nowIso(), d.id]);
  }
  return { checked: pending.length, sent };
}

// ---------------------------------------------------------------- escalations
/** A4 / workflow 2: log the escalation, alert the manager, fire the webhook. */
export async function raiseEscalation({
  tenantId, sourceType, sourceId, title, fromUserId, toUserId, reason, link = '/', slaHours = 24,
}) {
  if (!toUserId) return null;

  const openAtLevel = await get(
    `SELECT * FROM escalations WHERE tenant_id = ? AND source_type = ? AND source_id = ?
      ORDER BY level DESC LIMIT 1`,
    [tenantId, sourceType, sourceId],
  );
  // Only escalate further once the previous level has aged past its SLA.
  if (openAtLevel && !openAtLevel.resolved_at) {
    const ageHours = (Date.now() - new Date(openAtLevel.created_at).getTime()) / 3.6e6;
    if (ageHours < (openAtLevel.sla_hours || slaHours)) return openAtLevel.id;
  }

  const level = (openAtLevel?.level || 0) + 1;
  const id = uuid();
  await run(
    `INSERT INTO escalations (id, tenant_id, source_type, source_id, level, from_user_id, to_user_id,
       reason, sla_hours, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, sourceType, sourceId, level, fromUserId, toUserId, reason, slaHours, nowIso()],
  );

  if (sourceType === 'action_item') {
    await run(`UPDATE action_items SET escalation_level = ?, escalated_at = ?, updated_at = ?
          WHERE id = ? AND tenant_id = ?`, [level, nowIso(), nowIso(), sourceId, tenantId]);
  }

  const from = await userById(fromUserId);
  await notifyMany({
    tenantId,
    userIds: [toUserId],
    eventKey: 'escalation.raised',
    vars: { title, level, reason, from: from?.name || 'system' },
    link,
    dedupeKey: `escalation:${id}`,
  });

  await emitWebhook(tenantId, 'escalation.raised', {
    id, source_type: sourceType, source_id: sourceId, level, reason, to_user_id: toUserId,
  });

  return id;
}

export async function resolveEscalations(tenantId, sourceType, sourceId, note = null) {
  await run(
    `UPDATE escalations SET resolved_at = ?, resolution_note = ?
      WHERE tenant_id = ? AND source_type = ? AND source_id = ? AND resolved_at IS NULL`,
    [nowIso(), note, tenantId, sourceType, sourceId],
  );
}
