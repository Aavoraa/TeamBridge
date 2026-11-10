import { config } from '../config.js';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso, parseJson, renderTemplate } from '../lib/util.js';
import webpush from 'web-push';
import { sendMail } from './mailer.js';

/**
 * Module B - multi-channel notifications.
 *
 * AR4: every outbound vendor sits behind this provider interface so WhatsApp
 * vendors (Meta Cloud API / Gupshup / WATI) and mail transports can be swapped
 * without touching call sites. The `log` provider is the default in dev and in
 * tests: it records a delivery row instead of calling out.
 */

export const CHANNELS = ['in_app', 'whatsapp', 'email', 'teams', 'push'];

// ------------------------------------------------------------------ providers
const providers = {
  in_app: {
    id: 'in_app',
    async send() { return { ok: true, ref: null }; }, // the notifications row *is* the delivery
  },

  log: {
    id: 'log',
    async send({ channel, to, subject, body }) {
      console.log(JSON.stringify({ t: nowIso(), notify: channel, to, subject, body: String(body).slice(0, 400) }));
      return { ok: true, ref: `log_${uuid().slice(0, 8)}` };
    },
  },

  // Meta WhatsApp Cloud API. Same shape as Gupshup/WATI adapters would take.
  meta: {
    id: 'meta',
    async send({ to, body }) {
      if (!config.providers.whatsappToken || !config.providers.whatsappPhoneId) {
        return { ok: false, error: 'WhatsApp provider not configured' };
      }
      const res = await fetch(
        `https://graph.facebook.com/v20.0/${config.providers.whatsappPhoneId}/messages`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${config.providers.whatsappToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            to,
            type: 'text',
            text: { body },
          }),
        },
      );
      const json = await res.json().catch(() => ({}));
      return res.ok
        ? { ok: true, ref: json?.messages?.[0]?.id ?? null }
        : { ok: false, error: json?.error?.message || `HTTP ${res.status}` };
    },
  },

  teams: {
    id: 'teams',
    async send({ to, subject, body }) {
      const url = to || config.providers.teamsWebhook;
      if (!url) return { ok: false, error: 'Teams webhook not configured' };
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: subject, text: body }),
      });
      return res.ok ? { ok: true, ref: null } : { ok: false, error: `HTTP ${res.status}` };
    },
  },

  smtp: {
    id: 'smtp',
    async send({ to, subject, body }) {
      return sendMail({ to, subject, text: body });
    },
  },
};

// ------------------------------------------------------------- browser push
/**
 * Web Push: the pop-up Chrome shows even with no Phoenixx tab open. One person
 * can have it on in several browsers; each gets the message. A browser that has
 * gone away (uninstalled, cleared, permission revoked) answers 404/410 and its
 * row is dropped.
 */
let pushSender = null; // tests swap in a fake; production uses web-push
export function setPushSender(fn) { pushSender = fn; }

export const pushConfigured = () => !!pushSender
  || !!(config.providers.push.publicKey && config.providers.push.privateKey);

function sendWithWebPush(sub, payload) {
  return webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    payload,
    {
      TTL: 60 * 60 * 24,
      vapidDetails: {
        subject: config.providers.push.subject,
        publicKey: config.providers.push.publicKey,
        privateKey: config.providers.push.privateKey,
      },
    },
  );
}

/** Push one message to every browser the person has pop-ups on in. */
export async function pushToUser(userId, message) {
  const subs = await all('SELECT * FROM push_subscriptions WHERE user_id = ?', [userId]);
  if (!subs.length || !pushConfigured()) return { ok: false, skipped: true };
  const payload = JSON.stringify(message);
  let delivered = 0;
  let error = null;
  for (const sub of subs) {
    try {
      await (pushSender || sendWithWebPush)(sub, payload);
      delivered += 1;
      await run('UPDATE push_subscriptions SET last_used_at = ? WHERE id = ?', [nowIso(), sub.id]);
    } catch (err) {
      const code = err?.statusCode;
      if (code === 404 || code === 410) await run('DELETE FROM push_subscriptions WHERE id = ?', [sub.id]);
      error = err?.body || err?.message || `HTTP ${code}`;
    }
  }
  return delivered ? { ok: true, delivered } : { ok: false, error };
}

function providerFor(channel) {
  if (channel === 'in_app') return providers.in_app;
  if (channel === 'whatsapp') return providers[config.providers.whatsapp] || providers.log;
  if (channel === 'email') return providers[config.providers.email === 'smtp' ? 'smtp' : 'log'];
  if (channel === 'teams') return config.providers.teamsWebhook ? providers.teams : providers.log;
  return providers.log;
}

// ------------------------------------------------------------------ templates
/** Built-in copy; tenants may override any of these (B5). */
export const DEFAULT_TEMPLATES = {
  // AI Meetings (services/liveMeetings.js)
  'meeting.invited': {
    subject: 'Meeting invitation: {{title}}',
    body: 'Hi {{user.name}}, {{host}} has invited you to "{{title}}" on {{when}} ({{duration}} min){{recurring}}. Open the meeting to accept or decline, and to join when it starts.',
  },
  'calendar.event_added': {
    subject: 'On the office calendar: {{title}}',
    body: '{{person}} added "{{title}}" to the office calendar for {{when}}.{{location}}',
  },
  'meeting.followup_scheduled': {
    subject: 'Follow-up booked: {{title}}',
    body: 'From "{{source}}": a follow-up meeting "{{title}}" was put on the calendar for {{when}} ({{duration}} min) with {{people}}.{{assumed}} Change or cancel it from the meeting page.',
  },
  'meeting.rescheduled': {
    subject: 'Meeting moved: {{title}}',
    body: 'Hi {{user.name}}, "{{title}}" has moved to {{when}} ({{duration}} min). It was {{previous}}.',
  },
  'meeting.cancelled': {
    subject: 'Meeting cancelled: {{title}}',
    body: 'Hi {{user.name}}, "{{title}}" on {{when}} has been cancelled by {{by}}.{{reason}}',
  },
  'meeting.reminder': {
    subject: 'Starting soon: {{title}}',
    body: 'Hi {{user.name}}, "{{title}}" starts at {{time}}. Join from the meeting page.',
  },
  'meeting.response': {
    subject: '{{person}} {{response}} {{title}}',
    body: 'Hi {{user.name}}, {{person}} has {{response}} your meeting "{{title}}" on {{when}}.',
  },
  // A task approved from AI Meeting Intelligence (services/meetingIntel.js).
  'action_item.assigned_from_meeting': {
    subject: 'New task assigned from meeting: {{title}}',
    body: 'Hi {{user.name}}, a new task has been assigned to you based on the {{meeting_title}} meeting. Task: {{title}}. Deadline: {{deadline_label}}. Assigned by: {{assigned_by}}. Source: {{meeting_title}}. Please check your task dashboard for details.',
  },
  // Task requests: an employee asks to take a task on; their manager or project lead decides.
  'task_request.submitted': {
    subject: 'Task request from {{person}}: {{title}}',
    body: 'Hi {{user.name}}, {{person}} has asked to take on a task: "{{title}}". {{due_line}} Approve it to add it to their tasks, or reject it with a reason.',
  },
  'task_request.approved': {
    subject: 'Task approved: {{title}}',
    body: 'Hi {{user.name}}, {{person}} has approved your task request "{{title}}". It is now on your task list.',
  },
  'task_request.rejected': {
    subject: 'Task request not approved: {{title}}',
    body: 'Hi {{user.name}}, {{person}} did not approve your task request "{{title}}". Reason: {{note}}',
  },
  'action_item.assigned': {
    subject: 'New task assigned: {{title}}',
    body: 'Hi {{user.name}}, {{assigned_by}} has assigned you a new task: "{{title}}". Priority: {{priority_label}}. {{due_line}} Please check your task dashboard for details.',
  },
  'action_item.update_due': {
    subject: 'Daily update pending on {{count}} task(s)',
    body: 'Hi {{user.name}}, you have {{count}} open task(s) with no update logged for today: {{titles}}. Two minutes now saves the standup tomorrow.',
  },
  'action_item.awaiting_validation': {
    subject: 'Ready for your sign-off: {{title}}',
    body: '{{person}} has marked "{{title}}" done. It is waiting on you to validate the work or send it back.',
  },
  'action_item.validated': {
    subject: 'Validated: {{title}}',
    body: '{{person}} has validated your work on "{{title}}". Nothing further is needed.',
  },
  'action_item.changes_requested': {
    subject: 'Changes needed on {{title}}',
    body: '{{person}} has sent "{{title}}" back for changes: {{note}}. It is on your list again.',
  },
  'action_item.blocked_reported': {
    subject: 'Blocker raised on {{title}}',
    body: '{{person}} reported a blocker on "{{title}}": {{blockers}}',
  },
  'action_item.due_soon': {
    subject: 'Due {{when}}: {{title}}',
    body: 'Reminder - "{{title}}" is due {{when}} ({{due}}). Client: {{client}}.',
  },
  'action_item.overdue': {
    subject: 'OVERDUE: {{title}}',
    body: '"{{title}}" was due {{due}} and is now {{overdue_for}} overdue.',
  },
  'marketing.progressive_added': {
    subject: '⭐ {{lead}} is now progressive ({{priority}})',
    body: '{{person}} marked {{lead}} on {{project}} as a ⭐ progressive lead: {{reasons}}.',
  },
  'marketing.owner_action': {
    subject: 'Owner action needed: {{lead}}',
    body: '{{person}} needs you on {{lead}} ({{project}}): {{action}}. Due {{due}}.',
  },
  'marketing.followup_pending': {
    subject: 'Follow up ⭐ {{lead}}',
    body: '⭐ {{lead}} ({{project}}) needs its follow-up - due {{due}}. Next action: {{next_action}}.',
  },
  'marketing.progressive_inactive': {
    subject: '⭐ {{lead}} inactive for {{days}} days',
    body: 'Nothing has happened on ⭐ {{lead}} ({{project}}) for {{days}} working days. Next action: {{next_action}}.',
  },
  'marketing.progressive_stalled': {
    subject: 'Stalled: ⭐ {{lead}} needs attention',
    body: '⭐ {{lead}} ({{project}}) has had no activity for {{days}} working days. Owner: {{assignee}}. Next action: {{next_action}}.',
  },
  'marketing.progressive_escalated': {
    subject: 'Escalated: ⭐ {{lead}} inactive {{days}} days',
    body: '⭐ {{lead}} ({{project}}) is still stalled after {{days}} working days and has been escalated to the project owner. Owner: {{assignee}}.',
  },
  'marketing.priority_status_change': {
    subject: '⭐ {{lead}}: {{from}} → {{to}}',
    body: '{{person}} moved ⭐ {{lead}} ({{project}}) from {{from}} to {{to}}.',
  },
  'marketing.progressive_converted': {
    subject: 'Won: ⭐ {{lead}}',
    body: '{{person}} won ⭐ {{lead}} on {{project}}.',
  },
  'marketing.progressive_lost': {
    subject: 'Dead: ⭐ {{lead}}',
    body: '{{person}} marked ⭐ {{lead}} ({{project}}) dead: {{reason}}.',
  },
  'marketing.update_missing': {
    subject: 'Lead update pending on {{count}} ⭐ lead(s)',
    body: 'No update today yet on: {{leads}}. A two-line update keeps them moving.',
  },
  'performance.reviewed': {
    subject: 'Your {{period}} performance review is ready',
    body: '{{reviewer}} has reviewed your {{period}} scorecard. Overall {{score}}. Open it to read the notes and acknowledge.',
  },
  'project.update_filed': {
    subject: '{{project}}: {{status_label}} · {{progress}}%',
    body: '{{person}} ({{seat}}) filed today\'s update on {{project}}. Completed: {{completed}}. Next: {{next}}.',
  },
  'project.update_flagged': {
    subject: '{{status_label}}: {{project}}',
    body: '{{person}} ({{seat}}) marked {{project}} {{status_label}}. Blocker ({{blocker_type}}): {{blocker}}. '
      + 'Help needed: {{help}}. Estimated delay: {{delay}}.',
  },
  'project.update_due': {
    subject: 'Daily project update pending on {{count}} project(s)',
    body: 'Hi {{user.name}}, today\'s update is not filed yet for: {{projects}}. Your project owners read these every evening.',
  },
  'project.digest': {
    subject: 'Projects today: {{blocked}} blocked, {{at_risk}} at risk, {{on_track}} on track',
    body: '{{filed}} of {{expected}} updates filed across your {{projects}} project(s).{{missing_note}}{{flag_note}}',
  },
  'attendance.late_check_in': {
    subject: 'Late check-in approval required: {{person}}',
    body: '{{person}} checked in at {{actual}} on {{work_date}}. Scheduled start {{scheduled}} '
      + '({{late_minutes}} min late). It stays pending until you approve or reject it.',
  },
  'attendance.network_review': {
    subject: 'Check-in to review: {{person}} (not on office network)',
    body: '{{person}} checked in at {{actual}} on {{work_date}} from a network that is not an '
      + 'approved office connection.{{late_note}} It stays pending until you approve or reject it.',
  },
  'attendance.approved': {
    subject: 'Attendance approved for {{work_date}}',
    body: '{{person}} approved your check-in on {{work_date}}. The day counts as present.',
  },
  'attendance.rejected': {
    subject: 'Attendance not approved for {{work_date}}',
    body: '{{person}} did not approve your check-in on {{work_date}}: {{note}}',
  },
  'todo.submission_open': {
    subject: 'Advance Planner is open',
    body: 'Hi {{user.name}}, the Advance Planner is now open. Please submit your planned tasks for {{todo_day}} before {{deadline}}.',
  },
  'todo.reminder': {
    subject: 'Reminder: plan not submitted yet',
    body: 'Reminder: your plan for {{todo_day}} has not been submitted yet. Please complete it before {{deadline}}.',
  },
  'todo.overdue': {
    subject: 'Overdue: plan for {{todo_day}}',
    body: 'The {{deadline}} deadline has passed and your plan for {{todo_day}} is overdue.{{late_note}}',
  },
  'todo.escalation': {
    subject: 'Plan not submitted: {{person}}',
    body: '{{person}} has not submitted the plan for {{todo_day}}. Deadline: {{deadline}}. Current status: {{status}}.',
  },
  'todo.submitted': {
    subject: 'Plan submitted: {{person}}',
    body: '{{person}} submitted the plan for {{todo_day}} ({{count}} task(s)). It is waiting for your review.',
  },
  'todo.approved': {
    subject: 'Plan approved for {{todo_day}}',
    body: '{{reviewer}} approved your plan for {{todo_day}}.',
  },
  'todo.changes_requested': {
    subject: 'Changes needed on your plan',
    body: 'Your plan for {{todo_day}} requires changes from {{reviewer}}: {{note}}',
  },
  'todo.task_added': {
    subject: '{{person}} added a task for {{todo_day}}',
    body: '{{person}} added "{{note}}" to the plan for {{todo_day}}.',
  },
  'todo.converted': {
    subject: '{{count}} planned task(s) are now action items',
    body: '{{person}} turned {{count}} task(s) from the plan for {{todo_day}} into action items, assigned to {{employee}} and validated by {{reviewer}}.',
  },
  'todo.carried_over': {
    subject: '{{count}} unfinished task(s) moved to {{todo_day}}',
    body: 'Not completed, so now on your plan for {{todo_day}}: {{tasks}}.',
  },
  'todo.comment': {
    subject: '{{person}} commented on the plan for {{todo_day}}',
    body: '{{person}}: {{note}}',
  },
  'chat.broadcast': {
    subject: 'Announcement from {{author}}',
    body: '{{author}} posted to {{channel}}: {{preview}}',
  },
  'chat.mention': {
    subject: '{{author}} mentioned you in {{channel}}',
    body: '{{author}} in {{channel}}: {{preview}}',
  },
  'escalation.raised': {
    subject: 'Escalation L{{level}}: {{title}}',
    body: '{{title}} has been escalated to you by {{from}}. Reason: {{reason}}.',
  },
  'invoice.sent': {
    subject: 'Invoice {{number}} - {{amount}}',
    body: 'Invoice {{number}} for {{amount}} has been sent to {{client}}. Due {{due_date}}.',
  },
  'invoice.due_soon': {
    subject: 'Invoice {{number}} due {{when}}',
    body: 'Invoice {{number}} ({{amount}}) for {{client}} is due {{when}} on {{due_date}}.',
  },
  'invoice.overdue': {
    subject: 'Invoice {{number}} overdue',
    body: 'Invoice {{number}} ({{amount}}) for {{client}} is {{days_overdue}} day(s) overdue. Balance {{balance}}.',
  },
  'invoice.paid': {
    subject: 'Payment received - {{number}}',
    body: 'Payment of {{amount}} recorded against invoice {{number}} ({{client}}).',
  },
  'reimbursement.submitted': {
    subject: 'Reimbursement {{number}} from {{employee}}',
    body: '{{employee}} has claimed {{amount}} for "{{description}}" spent on {{expense_date}}. It is waiting on your approval.',
  },
  'reimbursement.finance_review': {
    subject: 'Reimbursement {{number}} ready for finance review',
    body: '{{number}} ({{employee}}, {{amount}}) was approved by {{decided_by}} and is now in finance review.',
  },
  'reimbursement.decided': {
    subject: 'Reimbursement {{number}} {{status}}',
    body: 'Your claim {{number}} for {{amount}} was {{status}} by {{decided_by}} at {{stage}} review.{{note}}',
  },
  'reimbursement.paid': {
    subject: 'Reimbursement {{number}} paid',
    body: '{{amount}} has been paid to you against {{number}} by {{method}}{{reference}}.',
  },
  'lead.no_next_action': {
    subject: 'Lead without next action: {{client}}',
    body: '{{client}} has no next action set. Every lead must always carry a next action + date.',
  },
  'follow_up.due': {
    subject: 'Follow-up due: {{client}}',
    body: 'Follow-up "{{next_action}}" for {{client}} is due {{due_date}}.',
  },
  'leave.requested': {
    subject: 'Leave request from {{user.name}}',
    body: '{{user.name}} requested {{days}} day(s) {{leave_type}} from {{from_date}} to {{to_date}}. Reason: {{reason}}.',
  },
  'leave.manager_verified': {
    subject: 'Leave awaiting HR approval: {{employee}}',
    body: '{{manager}} verified {{employee}}\'s {{days}} day(s) leave from {{from_date}} to {{to_date}}. It needs your final approval.',
  },
  'leave.decided': {
    subject: 'Leave {{status}}',
    body: 'Your leave request ({{from_date}} to {{to_date}}) was {{status}}{{note}}.',
  },
  'proposal.viewed': {
    subject: 'Proposal {{number}} viewed',
    body: '{{client}} just opened proposal {{number}} ({{title}}). Views: {{view_count}}.',
  },
  'proposal.accepted': {
    subject: 'Proposal {{number}} ACCEPTED',
    body: '{{client}} accepted proposal {{number}} - {{amount}}. Accepted by {{accepted_by}}.',
  },
  'digest.daily': {
    subject: 'Your day: {{due_today}} due, {{overdue}} overdue',
    body: 'Good morning {{user.name}}. Due today: {{due_today}}. Overdue: {{overdue}}. Follow-ups: {{follow_ups}}. Meetings: {{meetings}}.',
  },
  'digest.weekly_escalation': {
    subject: 'Weekly escalation report',
    body: '{{escalations}} escalation(s), {{overdue}} overdue item(s), SOP adherence {{sop_adherence}}%, follow-up completion {{follow_up_pct}}%.',
  },
  'report.ready': {
    subject: '{{title}} is ready',
    body: '{{title}} for {{period}} has been generated and is awaiting dispatch.',
  },
  'mention.comment': {
    subject: '{{from}} mentioned you',
    body: '{{from}} mentioned you on {{entity}}: "{{excerpt}}"',
  },
  'team.join_request': {
    subject: 'Join request: {{person}} ({{role}})',
    body: '{{person}} ({{email}}) used the join link and asked to join as {{role}}{{designation}}. Approve or reject it on the Team page.',
  },
  'sop.published': {
    subject: 'SOP updated: {{title}} v{{version}}',
    body: '{{title}} has been published at version {{version}}. Please review and acknowledge.',
  },
};

async function templateFor(tenantId, eventKey, channel) {
  const custom = await get(
    'SELECT subject, body FROM notification_templates WHERE tenant_id = ? AND event_key = ? AND channel = ? AND active = 1',
    [tenantId, eventKey, channel],
  );
  return custom || DEFAULT_TEMPLATES[eventKey] || { subject: eventKey, body: eventKey };
}

// --------------------------------------------------------------- preferences
const DEFAULT_PREFS = {
  in_app: true,
  email: true,
  whatsapp: true,
  teams: false,
  push: true,
};

/** B2: channel preference per user and per event type. */
export function channelsFor(user, eventKey) {
  const prefs = parseJson(user.notification_prefs, {}) || {};
  const global = { ...DEFAULT_PREFS, ...(prefs.channels || {}) };
  const perEvent = prefs.events?.[eventKey];
  const merged = perEvent ? { ...global, ...perEvent } : global;
  return CHANNELS.filter((c) => merged[c]);
}

// ------------------------------------------------------------------- sending
const addressFor = (user, channel) => {
  if (channel === 'whatsapp') return user.whatsapp || user.phone;
  if (channel === 'email') return user.email;
  if (channel === 'teams') return config.providers.teamsWebhook;
  return user.id;
};

/**
 * Queue + deliver a notification to one user across their preferred channels.
 * Every send is logged with delivery status (B5). `dedupeKey` makes the
 * reminder ladder safely re-runnable.
 */
export async function notify({
  tenantId, user, eventKey, vars = {}, link = null, channels = null, dedupeKey = null,
}) {
  if (!user) return [];
  let targets = channels || channelsFor(user, eventKey);
  // Every message that reaches the bell also pops up in the browser, unless the
  // person has switched pop-ups off for it - whichever channels the caller chose.
  if (targets.includes('in_app') && !targets.includes('push') && channelsFor(user, eventKey).includes('push')) {
    targets = [...targets, 'push'];
  }
  const results = [];

  for (const channel of targets) {
    const tpl = await templateFor(tenantId, eventKey, channel === 'push' ? 'in_app' : channel);
    const scope = { ...vars, user };
    const subject = renderTemplate(tpl.subject || eventKey, scope);
    const body = renderTemplate(tpl.body, scope);
    const key = dedupeKey ? `${dedupeKey}:${channel}:${user.id}` : null;

    if (key && await get('SELECT id FROM notifications WHERE tenant_id = ? AND dedupe_key = ?', [tenantId, key])) {
      continue; // already sent this rung of the ladder
    }

    // Browser pop-up: nothing to record for someone who has it off everywhere.
    if (channel === 'push') {
      const res = await pushToUser(user.id, { title: subject, body, link: link || '/', tag: key || uuid() });
      if (res.skipped) continue;
      await run(
        `INSERT INTO notifications (id, tenant_id, user_id, event_key, channel, title, body, link,
           status, provider, provider_ref, error, dedupe_key, meta, sent_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [uuid(), tenantId, user.id, eventKey, 'push', subject, body, link, res.ok ? 'delivered' : 'failed', 'webpush', null,
          res.error ? String(res.error).slice(0, 300) : null, key, JSON.stringify(vars), res.ok ? nowIso() : null, nowIso()],
      );
      results.push({ channel, status: res.ok ? 'delivered' : 'failed', error: res.error || null });
      continue;
    }

    const id = uuid();
    const provider = providerFor(channel);
    let status = 'queued';
    let error = null;
    let ref = null;

    try {
      const to = addressFor(user, channel);
      if (!to && channel !== 'in_app') {
        status = 'failed';
        error = `no ${channel} address on file`;
      } else {
        const res = await provider.send({ channel, to, subject, body });
        status = res.ok ? (channel === 'in_app' ? 'sent' : 'delivered') : 'failed';
        error = res.error || null;
        ref = res.ref || null;
      }
    } catch (err) {
      status = 'failed';
      error = err.message;
    }

    await run(
      `INSERT INTO notifications (id, tenant_id, user_id, event_key, channel, title, body, link,
         status, provider, provider_ref, error, dedupe_key, meta, sent_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, user.id, eventKey, channel, subject, body, link, status, provider.id, ref,
        error, key, JSON.stringify(vars), status === 'failed' ? null : nowIso(), nowIso()],
    );
    results.push({ id, channel, status, error });
  }
  return results;
}

/** Fan out one event to several users. */
export async function notifyMany({ tenantId, userIds, ...rest }) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return [];
  const users = await all(
    `SELECT * FROM users WHERE tenant_id = ? AND id IN (${ids.map(() => '?').join(',')}) AND deleted_at IS NULL AND status != 'disabled'`,
    [tenantId, ...ids],
  );
  const out = [];
  for (const user of users) out.push(...(await notify({ tenantId, user, ...rest })));
  return out;
}

/** Notify everyone holding a given role in the tenant. */
export async function notifyRole({ tenantId, roles, ...rest }) {
  const list = Array.isArray(roles) ? roles : [roles];
  const users = (await all(
    `SELECT id FROM users WHERE tenant_id = ? AND role IN (${list.map(() => '?').join(',')}) AND deleted_at IS NULL`,
    [tenantId, ...list],
  )).map((u) => u.id);
  return notifyMany({ tenantId, userIds: users, ...rest });
}
