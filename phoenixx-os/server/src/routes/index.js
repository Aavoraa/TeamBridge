import crypto from 'node:crypto';
import express, { Router } from 'express';
import { get, all } from '../db/index.js';
import { nowIso } from '../lib/util.js';
import { ok } from '../lib/http.js';
import { authenticate, requireSuperAdmin } from '../middleware/auth.js';
import { rateLimit } from '../middleware/common.js';

import { authRouter } from './auth.routes.js';
import { actionItemsRouter } from './actionItems.routes.js';
import { taskRequestsRouter } from './taskRequests.routes.js';
import { meetingsRouter } from './meetings.routes.js';
import { notificationsRouter } from './notifications.routes.js';
import { chatRouter } from './chat.routes.js';
import { hrRouter } from './hr.routes.js';
import { sopRouter, kpiRouter } from './sop.routes.js';
import { crmRouter } from './crm.routes.js';
import { clientsRouter } from './clients.routes.js';
import { proposalsRouter, publicProposalRouter } from './proposals.routes.js';
import { invoicesRouter } from './invoices.routes.js';
import { financeRouter } from './finance.routes.js';
import { todosRouter } from './todos.routes.js';
import { todoPlanRouter } from './todoPlan.routes.js';
import { projectsRouter } from './projects.routes.js';
import { projectUpdatesRouter } from './projectUpdates.routes.js';
import { marketingRouter } from './marketing.routes.js';
import { reportsRouter } from './reports.routes.js';
import { dashboardRouter } from './dashboard.routes.js';
import { settingsRouter } from './settings.routes.js';
import { usersRouter } from './users.routes.js';
import { publicJoinRouter, joinAdminRouter } from './join.routes.js';
import { calendarRouter } from './calendar.routes.js';
import { billingRouter } from './billing.routes.js';
import { adminRouter } from './admin.routes.js';
import { syncRouter, fileRouter } from './sync.routes.js';
import { assistantRouter } from './assistant.routes.js';
import { meetingIntelRouter } from './meetingIntel.routes.js';
import { liveMeetingsRouter } from './liveMeetings.routes.js';
import { livekitConfigured, webhooks, applyWebhook } from '../services/livekit.js';
import { openapi } from '../openapi.js';
import { runDueJobs } from '../services/jobs.js';
import { avatarPublicRouter, avatarRouter } from './avatars.routes.js';

const api = Router();

// ------------------------------------------------------------------- public
api.get('/health', (req, res) => res.json({
  status: 'ok',
  time: nowIso(),
  version: '1.0.0',
  service: 'phoenixx-os-api',
}));

api.get('/openapi.json', (req, res) => res.json(openapi));

api.get('/announcements', async (req, res) => ok(res, await all(
  `SELECT id, title, body, level FROM announcements
    WHERE (active_from IS NULL OR active_from <= ?) AND (active_to IS NULL OR active_to >= ?)
    ORDER BY created_at DESC`,
  [nowIso(), nowIso()],
)));

api.get('/plans', async (req, res) => ok(res, (await all('SELECT * FROM plans WHERE active = 1 ORDER BY sort'))
  .map((p) => ({ ...p, features: JSON.parse(p.features || '{}'), limits: JSON.parse(p.limits || '{}') }))));

/**
 * Background jobs on a serverless host. There is no process to keep a timer,
 * so a scheduler calls this every few minutes and it runs whatever is due
 * (see runDueJobs). Vercel Cron, or any external pinger, sends
 * `Authorization: Bearer <CRON_SECRET>`. Without CRON_SECRET set it refuses
 * every call, so it can never be triggered anonymously.
 */
function cronAuthorized(req) {
  const secret = process.env.CRON_SECRET || '';
  const given = (req.get('authorization') || '').replace(/^Bearer\s+/i, '') || req.get('x-cron-secret') || '';
  if (!secret || !given) return false;
  const a = Buffer.from(secret);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

api.all('/cron/tick', async (req, res) => {
  if (!cronAuthorized(req)) {
    return res.status(401).json({ error: { code: 'unauthorized', message: 'Missing or wrong cron secret' } });
  }
  const started = Date.now();
  const ran = await runDueJobs();
  return ok(res, { ran, ms: Date.now() - started });
});

/**
 * LiveKit webhooks (room started/finished, people joining/leaving). Public,
 * but every request must carry LiveKit's signature over the exact body, which
 * is why the body is read raw here. Anything unsigned is refused.
 */
api.post('/livekit/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  if (!livekitConfigured()) return res.status(503).json({ error: { code: 'video_not_configured', message: 'LiveKit is not configured' } });
  let event;
  try {
    event = await webhooks().receive(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : '', req.get('authorization'));
  } catch {
    return res.status(401).json({ error: { code: 'bad_signature', message: 'Webhook signature did not verify' } });
  }
  return ok(res, await applyWebhook(event));
});

api.use('/auth', authRouter);

// E5 - proposal share links are deliberately unauthenticated.
api.use('/public/proposals', rateLimit({ max: 120 }), publicProposalRouter);
// Personal invitation links: the invitee creates their own account; the owner approves it.
api.use('/public/join', rateLimit({ max: 30, windowMs: 15 * 60_000 }), publicJoinRouter);
// Profile photos: shown by plain <img> tags, so read without sign-in (see avatars.routes).
api.use('/avatars', avatarPublicRouter);

// ---------------------------------------------------------------- protected
api.use(authenticate);
api.use(rateLimit());

api.use('/action-items', actionItemsRouter);
// Employees ask to take a task on themselves; their manager or project lead approves it.
api.use('/task-requests', taskRequestsRouter);
api.use('/me/avatar', avatarRouter);
// My Day's personal list. No RBAC module: every row is pinned to the caller.
api.use('/todos', todosRouter);
api.use('/todo-plan', todoPlanRouter);
api.use('/meetings', meetingsRouter);
api.use('/notifications', notificationsRouter);
api.use('/chat', chatRouter);
// AI Task Assistant: owners and managers create tasks by voice or a typed sentence.
api.use('/assistant', assistantRouter);
// AI Meeting Intelligence: recordings/transcripts -> proposed tasks -> approval.
api.use('/meeting-intel', meetingIntelRouter);
// AI Meetings: live internal video meetings (scheduling, invitations, rooms).
api.use('/ai-meetings', liveMeetingsRouter);
api.use('/hr', hrRouter);
api.use('/sop', sopRouter);
api.use('/kpis', kpiRouter);
api.use('/crm', crmRouter);
// The client master. /crm stays the pipeline; this is the register behind it.
api.use('/clients', clientsRouter);
api.use('/proposals', proposalsRouter);
api.use('/invoices', invoicesRouter);
api.use('/finance', financeRouter);
// Daily project updates first: its /updates/... paths must win over /:id.
api.use('/projects', projectUpdatesRouter);
api.use('/projects', projectsRouter);
// Marketing projects and their lead pipelines.
api.use('/marketing', marketingRouter);
api.use('/reports', reportsRouter);
api.use('/dashboard', dashboardRouter);
api.use('/settings', settingsRouter);
api.use('/users', usersRouter);
api.use('/team-join', joinAdminRouter);
api.use('/calendar', calendarRouter);
api.use('/billing', billingRouter);
api.use('/sync', syncRouter);
api.use('/files', fileRouter);

// S9 - platform console
api.use('/admin', requireSuperAdmin, adminRouter);

export { api };
