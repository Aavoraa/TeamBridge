import { forEachSeq } from '../lib/util.js';
import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, tx } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, forbidden, conflict, audit } from '../lib/http.js';
import { requires, can } from '../middleware/rbac.js';
import { visibleProjectIds } from '../services/projectOversight.js';
import * as M from '../services/marketing.js';

const router = Router();

/**
 * Marketing leads belong to the team of their marketing project. Anyone with
 * CRM access reaches them, and so does anyone on a marketing project's team -
 * an employee without CRM still works their own project's leads. Every route
 * then limits them to the projects they can see and work (below).
 */
function leadsAccess(action) {
  return async (req, _res, next) => {
    if (await can(req.auth, 'crm', action)) return next();
    if (action !== 'delete' && await M.onMarketingProject(req.auth)) return next();
    return next(forbidden('Marketing leads are for the marketing project team'));
  };
}

/**
 * Marketing projects and their leads - see services/marketing.js for the rules.
 *
 * Reading follows project visibility (employees and managers see only the
 * projects they are on or own). Working a lead - add, edit, log, update,
 * move its status - is for anyone on the project, its owners or the
 * assignee. Steering it - ⭐ on/off, priority, dead, revive, delete - is for
 * the project manager and team lead.
 */

const parse = (raw, fallback) => { try { return raw ? JSON.parse(raw) : fallback; } catch { return fallback; } };
const money = z.number().int().min(0);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max = 2000) => z.string().max(max).optional().nullable();

async function projectOr404(req, projectId) {
  const p = await M.marketingProjectFor(req.auth, projectId);
  if (!p) throw notFound('Marketing project');
  return p;
}
async function leadOr404(req, leadId) {
  const lead = await get('SELECT * FROM leads WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [leadId, req.auth.tenantId]);
  if (!lead) throw notFound('Lead');
  const project = await projectOr404(req, lead.project_id);
  return { lead, project };
}
const mustWork = async (req, project, lead) => {
  if (!await M.canWorkLead(req.auth, project.id, lead)) throw forbidden('Only people on this marketing project can work its leads');
};
const mustSteer = async (req, project) => {
  if (!await M.canSteerLead(req.auth, project.id)) throw forbidden('Only the project manager or team lead can do that');
};
const leadById = async (req, id) => {
  const ctx = await M.healthContext(req.auth.tenantId);
  return M.decorateLeads([await get(`${M.LEAD_SELECT} WHERE l.id = ?`, [id])], ctx)[0];
};

// ------------------------------------------------------------------ meta
router.get('/meta', leadsAccess('view'), async (req, res) => ok(res, {
  statuses: M.STATUSES,
  sources: M.SOURCES,
  temperatures: M.TEMPERATURES,
  priorities: M.PRIORITIES,
  progressive_reasons: M.PROGRESSIVE_REASONS,
  dead_reasons: M.DEAD_REASONS,
  outcomes: M.OUTCOMES,
  activity_types: M.ACTIVITY_TYPES,
  settings: await M.settingsFor(req.auth.tenantId),
  defaults: M.DEFAULT_SETTINGS,
  can_edit_settings: await can(req.auth, 'settings', 'edit'),
}));

router.put('/settings', requires('settings', 'edit'), async (req, res) => {
  const before = await M.settingsFor(req.auth.tenantId);
  const after = await M.saveSettings(req.auth.tenantId, req.body || {});
  await audit(req, { entity: 'marketing_settings', entityId: req.auth.tenantId, action: 'update', before, after });
  return ok(res, after);
});

// -------------------------------------------------------------- projects
/** Every marketing project this person can see, with headline numbers. */
router.get('/projects', leadsAccess('view'), async (req, res) => {
  const ids = await visibleProjectIds(req.auth);
  if (!ids.length) return ok(res, []);
  const ctx = await M.healthContext(req.auth.tenantId);
  const projects = await all(
    `SELECT p.id, p.name, p.status, c.name AS client_name FROM projects p JOIN clients c ON c.id = p.client_id
      WHERE p.tenant_id = ? AND p.kind = 'marketing' AND p.deleted_at IS NULL
        AND p.id IN (${ids.map(() => '?').join(',')}) ORDER BY p.name`,
    [req.auth.tenantId, ...ids],
  );
  return ok(res, await Promise.all(projects.map(async (p) => {
    const leads = M.decorateLeads(await all('SELECT * FROM leads WHERE tenant_id = ? AND project_id = ? AND deleted_at IS NULL', [req.auth.tenantId, p.id]), ctx);
    const open = leads.filter((l) => M.OPEN_STATUSES.includes(l.status));
    return {
      ...p,
      total: leads.length,
      open: open.length,
      progressive: open.filter((l) => l.is_progressive).length,
      stalled: open.filter((l) => l.is_progressive && l.health?.id === 'stalled').length,
      followups_due: open.filter((l) => l.next_followup_date && l.next_followup_date <= ctx.today).length,
      won: leads.filter((l) => l.status === 'won').length,
      dead: leads.filter((l) => l.status === 'dead').length,
      can_steer: await M.canSteerLead(req.auth, p.id),
      can_work: await M.canWorkLead(req.auth, p.id),
    };
  })));
});

router.get('/projects/:pid/overview', leadsAccess('view'), async (req, res) => {
  const project = await projectOr404(req, req.params.pid);
  return ok(res, {
    ...await M.overviewFor(req.auth.tenantId, project),
    can_steer: await M.canSteerLead(req.auth, project.id),
    can_work: await M.canWorkLead(req.auth, project.id),
  });
});

// ----------------------------------------------------------------- leads
const VIEWS = ['all', 'mine', 'new', 'followup_today', 'progressive', 'owner_attention', 'won'];

router.get('/projects/:pid/leads', leadsAccess('view'), async (req, res) => {
  const project = await projectOr404(req, req.params.pid);
  const ctx = await M.healthContext(req.auth.tenantId);
  const view = VIEWS.includes(req.query.view) ? req.query.view : 'all';
  const filters = ['l.tenant_id = ?', 'l.project_id = ?', 'l.deleted_at IS NULL'];
  const params = [req.auth.tenantId, project.id];
  const open = `l.status IN (${M.OPEN_STATUSES.map(() => '?').join(',')})`;

  if (view === 'won') { filters.push("l.status = 'won'"); } else { filters.push("l.status != 'dead'"); }
  if (view === 'mine') { filters.push('l.assigned_to = ?'); params.push(req.auth.userId); }
  if (view === 'new') { filters.push("l.status = 'new'"); }
  if (view === 'followup_today') { filters.push(`${open} AND l.next_followup_date IS NOT NULL AND l.next_followup_date <= ?`); params.push(...M.OPEN_STATUSES, ctx.today); }
  if (view === 'progressive') { filters.push(`l.is_progressive = 1 AND ${open}`); params.push(...M.OPEN_STATUSES); }
  if (view === 'owner_attention') { filters.push(`l.owner_action_required = 1 AND ${open}`); params.push(...M.OPEN_STATUSES); }
  if (req.query.status) { filters.push('l.status = ?'); params.push(req.query.status); }
  if (req.query.assigned_to) { filters.push('l.assigned_to = ?'); params.push(req.query.assigned_to); }
  if (req.query.source) { filters.push('l.source = ?'); params.push(req.query.source); }
  if (req.query.temperature) { filters.push('l.temperature = ?'); params.push(req.query.temperature); }
  if (req.query.search) {
    filters.push('(l.company_name LIKE ? OR l.contact_name LIKE ? OR l.email LIKE ? OR l.phone LIKE ?)');
    const q = `%${req.query.search}%`; params.push(q, q, q, q);
  }

  const rows = M.decorateLeads(await all(`${M.LEAD_SELECT} WHERE ${filters.join(' AND ')}
      ORDER BY l.is_progressive DESC, CASE l.progressive_priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
               COALESCE(l.next_followup_date, '9999') ASC, l.updated_at DESC`, params), ctx);
  if (req.query.health) return ok(res, rows.filter((r) => r.health?.id === req.query.health));
  return ok(res, rows);
});

const leadSchema = z.object({
  company_name: z.string().trim().min(1).max(200),
  contact_name: text(160), designation: text(160), phone: text(40), email: text(200),
  website: text(300), location: text(200), industry: text(120),
  source: z.enum(M.SOURCES).optional().nullable(),
  assigned_to: z.string().optional().nullable(),
  status: z.enum(M.STATUSES.map((s) => s.id)).optional(),
  temperature: z.enum(M.TEMPERATURES).optional(),
  expected_value_minor: money.optional(),
  expected_close_date: day.optional().nullable(),
  next_action: text(500),
  next_followup_date: day.optional().nullable(),
  notes: text(4000),
  /** Save even though it looks like an existing lead. */
  force: z.boolean().optional(),
});

async function assignee(req, project, userId) {
  if (!userId) return null;
  const u = await get("SELECT id, name FROM users WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL AND role != 'client'", [userId, req.auth.tenantId]);
  if (!u) throw badRequest('That person is not in this workspace');
  return u;
}

async function insertLead(req, project, body, { source = 'manual', at = nowIso() } = {}) {
  const id = uuid();
  const lead = {
    id, project_id: project.id,
  };
  await run(
    `INSERT INTO leads (id, tenant_id, project_id, company_name, contact_name, designation, phone, email, website,
       location, industry, source, assigned_to, status, temperature, expected_value_minor, expected_close_date,
       next_action, next_followup_date, notes, last_activity_at, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, req.auth.tenantId, project.id, body.company_name.trim(), body.contact_name ?? null, body.designation ?? null,
      body.phone ?? null, body.email ?? null, body.website ?? null, body.location ?? null, body.industry ?? null,
      body.source ?? null, body.assigned_to ?? null, body.status || 'new', body.temperature || 'cold',
      body.expected_value_minor || 0, body.expected_close_date ?? null, body.next_action ?? null,
      body.next_followup_date ?? null, body.notes ?? null, at, req.auth.userId, at, at],
  );
  await M.logActivity(req.auth.tenantId, lead, req.auth.userId, 'lead_created',
    source === 'import' ? 'Lead imported from CSV' : 'Lead created', { status: body.status || 'new' }, at);
  if (body.assigned_to) {
    const u = await get('SELECT name FROM users WHERE id = ?', [body.assigned_to]);
    await M.logActivity(req.auth.tenantId, lead, req.auth.userId, 'assigned', `Assigned to ${u?.name}`, { to: body.assigned_to }, at);
  }
  return id;
}

router.post('/projects/:pid/leads', leadsAccess('create'), async (req, res) => {
  const project = await projectOr404(req, req.params.pid);
  await mustWork(req, project);
  const body = validate(leadSchema, req.body);
  await assignee(req, project, body.assigned_to);
  if (body.status === 'won') throw badRequest('Create the lead first, then move it to Won');

  const dup = await M.findDuplicate(req.auth.tenantId, body);
  if (dup && !body.force) {
    throw conflict(`This looks like an existing lead: ${dup.company_name} (${M.statusLabel(dup.status)}) in ${dup.project_name}.`,
      [{ field: 'duplicate_of', message: dup.id }]);
  }
  const id = await tx(async () => await insertLead(req, project, body));
  await audit(req, { entity: 'lead', entityId: id, action: 'create', after: { company: body.company_name, project: project.name } });
  return created(res, await leadById(req, id));
});

/** CSV import: header row, then one lead per row. Duplicates are reported and skipped. */
router.post('/projects/:pid/leads/import', leadsAccess('create'), async (req, res) => {
  const project = await projectOr404(req, req.params.pid);
  await mustWork(req, project);
  const { csv, assigned_to: defaultAssignee } = validate(z.object({ csv: z.string().min(1).max(5_000_000), assigned_to: z.string().optional().nullable() }), req.body);
  await assignee(req, project, defaultAssignee);

  const rows = M.parseCsv(csv);
  if (rows.length < 2) throw badRequest('The file needs a header row and at least one lead');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z]+/g, '_').replace(/^_|_$/g, ''));
  const ALIASES = {
    company_name: ['company', 'company_name', 'organisation', 'organization', 'business'],
    contact_name: ['contact', 'contact_name', 'contact_person', 'name'],
    designation: ['designation', 'title', 'role'],
    phone: ['phone', 'mobile', 'phone_number', 'contact_number'],
    email: ['email', 'email_address'],
    website: ['website', 'url', 'site'],
    location: ['location', 'city', 'place'],
    industry: ['industry', 'sector'],
    source: ['source', 'lead_source'],
    notes: ['notes', 'note', 'remarks'],
    assignee_email: ['assigned_to', 'assignee', 'owner', 'assignee_email'],
  };
  const col = Object.fromEntries(Object.entries(ALIASES).map(([k, names]) => [k, header.findIndex((h) => names.includes(h))]));
  if (col.company_name < 0) throw badRequest('No company column found - name one of the columns "Company"');

  const users = Object.fromEntries((await all("SELECT id, LOWER(email) AS email FROM users WHERE tenant_id = ? AND deleted_at IS NULL", [req.auth.tenantId])).map((u) => [u.email, u.id]));
  const result = { created: 0, duplicates: [], errors: [] };
  await tx(async () => {
    await forEachSeq(rows.slice(1), async (r, i) => {
      const v = (k) => (col[k] >= 0 ? String(r[col[k]] ?? '').trim() || null : null);
      const line = i + 2;
      const body = {
        company_name: v('company_name'), contact_name: v('contact_name'), designation: v('designation'),
        phone: v('phone'), email: v('email'), website: v('website'), location: v('location'), industry: v('industry'),
        notes: v('notes'),
        source: M.SOURCES.includes(String(v('source') || '').toLowerCase()) ? String(v('source')).toLowerCase() : (v('source') ? 'other' : 'campaign'),
        assigned_to: (v('assignee_email') && users[v('assignee_email').toLowerCase()]) || defaultAssignee || null,
      };
      if (!body.company_name) { result.errors.push({ line, message: 'No company name' }); return; }
      const dup = await M.findDuplicate(req.auth.tenantId, body);
      if (dup) { result.duplicates.push({ line, company: body.company_name, existing: dup.company_name, project: dup.project_name }); return; }
      await insertLead(req, project, body, { source: 'import' });
      result.created += 1;
    });
  });
  await audit(req, { entity: 'lead', action: 'create', after: { imported: result.created, project: project.name, duplicates: result.duplicates.length } });
  return created(res, result);
});

router.get('/leads/:id', leadsAccess('view'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  const tenantId = req.auth.tenantId;
  const timeline = (await all(
    `SELECT a.*, u.name AS user_name FROM lead_activities a LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = ? AND a.lead_id = ? ORDER BY a.created_at DESC LIMIT 300`,
    [tenantId, lead.id],
  )).map((a) => ({ ...a, meta: parse(a.meta, {}) }));
  return ok(res, {
    ...await leadById(req, lead.id),
    project: { id: project.id, name: project.name },
    timeline,
    updates: await all(
      `SELECT u.*, us.name AS user_name FROM lead_updates u JOIN users us ON us.id = u.user_id
        WHERE u.tenant_id = ? AND u.lead_id = ? AND u.deleted_at IS NULL ORDER BY u.update_date DESC LIMIT 60`,
      [tenantId, lead.id],
    ),
    progressive_history: await all(
      `SELECT h.*, u.name AS user_name FROM progressive_lead_history h LEFT JOIN users u ON u.id = h.changed_by
        WHERE h.tenant_id = ? AND h.lead_id = ? ORDER BY h.changed_at DESC`,
      [tenantId, lead.id],
    ),
    dead_record: await get(
      `SELECT d.*, u.name AS marked_by_name FROM dead_leads d LEFT JOIN users u ON u.id = d.marked_by
        WHERE d.lead_id = ? ORDER BY d.marked_at DESC LIMIT 1`, [lead.id]),
    can_work: await M.canWorkLead(req.auth, project.id, lead),
    can_steer: await M.canSteerLead(req.auth, project.id),
  });
});

const TRACKED = {
  company_name: 'Company', contact_name: 'Contact', designation: 'Designation', phone: 'Phone', email: 'Email',
  website: 'Website', location: 'Location', industry: 'Industry', source: 'Source', temperature: 'Temperature',
  expected_value_minor: 'Expected value', expected_close_date: 'Expected close', next_action: 'Next action',
  next_followup_date: 'Next follow-up', notes: 'Notes',
};

/**
 * Edit a lead. Status (the dropdown), assignee and every other field change
 * here, and each kind of change lands on the timeline as its own entry.
 */
router.patch('/leads/:id', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustWork(req, project, lead);
  const body = validate(leadSchema.partial().extend({
    status_note: text(1000),
    /** Moving to Won: also create the client in the CRM (default yes). */
    create_client: z.boolean().optional(),
  }), req.body);
  if (lead.status === 'dead') throw badRequest('This lead is dead - revive it before changing it');
  if (body.assigned_to !== undefined) await assignee(req, project, body.assigned_to);
  if (body.company_name || body.phone || body.email) {
    const dup = await M.findDuplicate(req.auth.tenantId, { ...lead, ...body }, lead.id);
    if (dup && !body.force) throw conflict(`That would duplicate ${dup.company_name} in ${dup.project_name}.`, [{ field: 'duplicate_of', message: dup.id }]);
  }

  const at = nowIso();
  const tenantId = req.auth.tenantId;
  await tx(async () => {
    const patch = {};
    const changed = [];
    for (const k of Object.keys(TRACKED)) {
      if (body[k] !== undefined && (body[k] ?? null) !== (lead[k] ?? null)) { patch[k] = body[k]; changed.push(k); }
    }
    if (body.status && body.status !== lead.status) patch.status = body.status;
    if (body.assigned_to !== undefined && (body.assigned_to ?? null) !== (lead.assigned_to ?? null)) patch.assigned_to = body.assigned_to;
    if (!Object.keys(patch).length) return;

    if (patch.status === 'won') patch.won_at = at;
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    await run(`UPDATE leads SET ${sets}, last_activity_at = ?, updated_at = ? WHERE id = ?`, [...Object.values(patch), at, at, lead.id]);

    if (patch.status) {
      await M.logActivity(tenantId, lead, req.auth.userId, 'status_changed',
        `${M.statusLabel(lead.status)} → ${M.statusLabel(patch.status)}${body.status_note ? ` · ${body.status_note}` : ''}`,
        { from: lead.status, to: patch.status, note: body.status_note ?? null }, at);
    }
    if (patch.assigned_to !== undefined) {
      const u = patch.assigned_to ? await get('SELECT name FROM users WHERE id = ?', [patch.assigned_to]) : null;
      await M.logActivity(tenantId, lead, req.auth.userId, 'assigned', u ? `Assigned to ${u.name}` : 'Unassigned', { from: lead.assigned_to, to: patch.assigned_to }, at);
    }
    if (changed.length) {
      const followup = changed.includes('next_followup_date') || changed.includes('next_action');
      await M.logActivity(tenantId, lead, req.auth.userId, followup && changed.length <= 2 ? 'followup_scheduled' : 'details_updated',
        followup && changed.length <= 2
          ? `Next: ${patch.next_action ?? lead.next_action ?? '—'}${(patch.next_followup_date ?? lead.next_followup_date) ? ` on ${patch.next_followup_date ?? lead.next_followup_date}` : ''}`
          : `Updated ${changed.map((k) => TRACKED[k].toLowerCase()).join(', ')}`,
        { fields: changed, before: Object.fromEntries(changed.map((k) => [k, lead[k] ?? null])) }, at);
    }
    if (patch.status === 'won') await convertWon(req, { ...lead, ...patch }, body.create_client !== false, at);
  });

  const after = await leadById(req, lead.id);
  if (body.status && body.status !== lead.status && lead.is_progressive) {
    const eventKey = body.status === 'won' ? 'marketing.progressive_converted' : 'marketing.priority_status_change';
    if (body.status === 'won' || ['critical', 'high'].includes(lead.progressive_priority)) {
      await M.tell({ tenantId, userIds: [...await M.steerersOf(tenantId, project.id), ...(body.status === 'won' ? await M.ownersOf(tenantId, project.id) : [])], except: req.auth.userId,
        eventKey, vars: { lead: lead.company_name, project: project.name, from: M.statusLabel(lead.status), to: M.statusLabel(body.status), person: req.auth.name },
        lead, dedupeKey: `mkt:status:${lead.id}:${body.status}` });
    }
  }
  await audit(req, { entity: 'lead', entityId: lead.id, action: 'update', before: lead, after: body });
  return ok(res, after);
});

/** Won: close the ⭐ if it had one, and (by default) hand the company to the CRM as a client. */
async function convertWon(req, lead, createClient, at) {
  const tenantId = req.auth.tenantId;
  if (lead.is_progressive) {
    await run('UPDATE leads SET is_progressive = 0, updated_at = ? WHERE id = ?', [at, lead.id]);
    await M.historyEntry(tenantId, lead.id, 'converted', { reason: 'Lead won', priority: lead.progressive_priority, by: req.auth.userId });
  }
  if (!createClient || lead.converted_client_id) return;
  const stage = await get("SELECT id FROM pipeline_stages WHERE tenant_id = ? AND code = 'onboarding' AND deleted_at IS NULL", [tenantId])
    || await get('SELECT id FROM pipeline_stages WHERE tenant_id = ? AND is_won = 1 AND deleted_at IS NULL ORDER BY sort LIMIT 1', [tenantId]);
  const clientId = uuid();
  await run(
    `INSERT INTO clients (id, tenant_id, name, industry, stage_id, status, owner_id, source, website, city,
       deal_value_minor, notes, stage_entered_at, last_activity_at, onboarded_at, created_at, updated_at)
     VALUES (?,?,?,?,?, 'active', ?,?,?,?,?,?,?,?,?,?,?)`,
    [clientId, tenantId, lead.company_name, lead.industry ?? null, stage?.id ?? null, lead.assigned_to ?? req.auth.userId,
      `marketing:${lead.source || 'other'}`, lead.website ?? null, lead.location ?? null, lead.expected_value_minor || 0,
      `Converted from a marketing lead.${lead.notes ? `\n${lead.notes}` : ''}`, at, at, at, at, at],
  );
  if (lead.contact_name || lead.email || lead.phone) {
    await run(`INSERT INTO contacts (id, tenant_id, client_id, name, designation, email, phone, is_primary, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,1,?,?)`,
    [uuid(), tenantId, clientId, lead.contact_name || lead.company_name, lead.designation ?? null, lead.email ?? null, lead.phone ?? null, at, at]);
  }
  await run(`INSERT INTO activities (id, tenant_id, client_id, type, subject, body, occurred_at, user_id, meta, created_at)
       VALUES (?,?,?, 'note', 'Converted from marketing', ?, ?, ?, '{}', ?)`,
  [uuid(), tenantId, clientId, `Won on a marketing project. Lead history is on the marketing lead.`, at, req.auth.userId, at]);
  await run('UPDATE leads SET converted_client_id = ? WHERE id = ?', [clientId, lead.id]);
  await M.logActivity(tenantId, lead, req.auth.userId, 'converted', 'Converted to a CRM client', { client_id: clientId }, at);
}

// ---------------------------------------------------------- activities
router.post('/leads/:id/activities', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustWork(req, project, lead);
  const body = validate(z.object({
    type: z.enum(M.ACTIVITY_TYPES),
    description: z.string().trim().min(1).max(2000),
    outcome: z.enum(['connected', 'no_response', 'positive', 'negative']).optional().nullable(),
  }), req.body);
  const at = nowIso();
  await tx(async () => {
    await M.logActivity(req.auth.tenantId, lead, req.auth.userId, body.type, body.description, { outcome: body.outcome ?? null }, at);
    await M.touch(lead.id, at);
    // Reaching out to a brand-new lead is what "contacted" means.
    if (lead.status === 'new' && body.type !== 'note' && body.outcome !== 'no_response') {
      await run("UPDATE leads SET status = 'contacted' WHERE id = ?", [lead.id]);
      await M.logActivity(req.auth.tenantId, lead, req.auth.userId, 'status_changed', 'New → Contacted', { from: 'new', to: 'contacted', auto: true }, at);
    }
  });
  return created(res, await leadById(req, lead.id));
});

// --------------------------------------------------------- daily update
const updateSchema = z.object({
  outcome: z.enum(M.OUTCOMES.map((o) => o.id)),
  progress_note: text(2000),
  next_action: z.string().trim().max(500).optional().nullable(),
  next_followup_date: day.optional().nullable(),
  owner_action_required: z.boolean().optional(),
  owner_action_text: text(1000),
  owner_action_due: day.optional().nullable(),
  owner_action_priority: z.enum(M.PRIORITIES).optional().nullable(),
});

router.post('/leads/:id/updates', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustWork(req, project, lead);
  if (!M.OPEN_STATUSES.includes(lead.status)) throw badRequest('Daily updates are for open leads');
  const body = validate(updateSchema, req.body);
  const tenantId = req.auth.tenantId;
  const ctx = await M.healthContext(tenantId);
  const closing = body.outcome === 'converted';

  if (body.outcome !== 'no_response' && !body.progress_note?.trim()) throw badRequest('Say what happened', [{ field: 'progress_note', message: 'Describe the progress' }]);
  if (!closing && !body.next_action?.trim()) throw badRequest('Every update needs a next action', [{ field: 'next_action', message: 'What happens next?' }]);
  if (!closing && !body.next_followup_date) throw badRequest('Every update needs a next follow-up date', [{ field: 'next_followup_date', message: 'When?' }]);
  if (body.owner_action_required && !body.owner_action_text?.trim()) throw badRequest('Say what the owner needs to do', [{ field: 'owner_action_text', message: 'Describe the action' }]);

  const at = nowIso();
  const existing = await get('SELECT id FROM lead_updates WHERE tenant_id = ? AND lead_id = ? AND user_id = ? AND update_date = ? AND deleted_at IS NULL',
    [tenantId, lead.id, req.auth.userId, ctx.today]);
  const outcome = M.OUTCOMES.find((o) => o.id === body.outcome);

  await tx(async () => {
    if (existing) {
      await run(`UPDATE lead_updates SET outcome = ?, progress_note = ?, next_action = ?, next_followup_date = ?, owner_action_required = ?,
             owner_action_text = ?, updated_at = ? WHERE id = ?`,
      [body.outcome, body.progress_note ?? null, body.next_action ?? null, body.next_followup_date ?? null,
        body.owner_action_required ? 1 : 0, body.owner_action_text ?? null, at, existing.id]);
    } else {
      await run(`INSERT INTO lead_updates (id, tenant_id, lead_id, project_id, user_id, update_date, outcome, progress_note, next_action,
             next_followup_date, owner_action_required, owner_action_text, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [uuid(), tenantId, lead.id, project.id, req.auth.userId, ctx.today, body.outcome, body.progress_note ?? null,
        body.next_action ?? null, body.next_followup_date ?? null, body.owner_action_required ? 1 : 0, body.owner_action_text ?? null, at, at]);
    }
    await M.logActivity(tenantId, lead, req.auth.userId, 'daily_update',
      `${outcome.label}${body.progress_note ? `: ${body.progress_note}` : ''}`,
      { outcome: body.outcome, next_action: body.next_action ?? null, next_followup_date: body.next_followup_date ?? null }, at);

    const patch = { last_outcome: body.outcome };
    if (!closing) { patch.next_action = body.next_action; patch.next_followup_date = body.next_followup_date; }
    const sets = Object.keys(patch).map((k) => `${k} = ?`).join(', ');
    await run(`UPDATE leads SET ${sets}, last_activity_at = ?, updated_at = ? WHERE id = ?`, [...Object.values(patch), at, at, lead.id]);

    // The outcome moves the status - forwards only.
    if (M.isForward(lead.status, outcome.moves_to)) {
      await run('UPDATE leads SET status = ?, won_at = CASE WHEN ? = \'won\' THEN ? ELSE won_at END WHERE id = ?', [outcome.moves_to, outcome.moves_to, at, lead.id]);
      await M.logActivity(tenantId, lead, req.auth.userId, 'status_changed', `${M.statusLabel(lead.status)} → ${M.statusLabel(outcome.moves_to)}`,
        { from: lead.status, to: outcome.moves_to, auto: true }, at);
      if (outcome.moves_to === 'won') await convertWon(req, { ...lead, status: 'won' }, true, at);
    }
    if (body.owner_action_required) await raiseOwnerAction(req, project, lead, body, at);
  });
  return created(res, await leadById(req, lead.id));
});

// ----------------------------------------------------------- ⭐ flag
const starSchema = z.object({
  on: z.boolean(),
  reasons: z.array(z.enum(M.PROGRESSIVE_REASONS.map((r) => r.id))).optional(),
  reason_note: text(500),
  priority: z.enum(M.PRIORITIES).optional(),
  next_action: z.string().trim().max(500).optional(),
  next_followup_date: day.optional(),
  /** Why the ⭐ is being removed. */
  reason: z.string().trim().max(500).optional(),
});

router.post('/leads/:id/progressive', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustSteer(req, project);
  if (!M.OPEN_STATUSES.includes(lead.status)) throw badRequest('Only open leads can carry a ⭐');
  const body = validate(starSchema, req.body);
  const tenantId = req.auth.tenantId;
  const at = nowIso();

  if (body.on) {
    if (lead.is_progressive) throw badRequest('This lead is already ⭐ progressive');
    if (!body.reasons?.length) throw badRequest('Pick at least one reason this lead is progressive', [{ field: 'reasons', message: 'Pick a reason' }]);
    if (body.reasons.includes('other') && !body.reason_note?.trim()) throw badRequest('Describe the "other" reason', [{ field: 'reason_note', message: 'Describe it' }]);
    if (!body.priority) throw badRequest('Set a priority', [{ field: 'priority', message: 'Pick one' }]);
    if (!body.next_action) throw badRequest('A ⭐ lead needs a next action', [{ field: 'next_action', message: 'What happens next?' }]);
    if (!body.next_followup_date) throw badRequest('A ⭐ lead needs a follow-up date', [{ field: 'next_followup_date', message: 'When?' }]);
    const labels = body.reasons.map((r) => M.PROGRESSIVE_REASONS.find((x) => x.id === r).label);
    await tx(async () => {
      await run(`UPDATE leads SET is_progressive = 1, progressive_priority = ?, progressive_reasons = ?, progressive_note = ?,
             progressive_since = ?, next_action = ?, next_followup_date = ?, last_activity_at = ?, updated_at = ? WHERE id = ?`,
      [body.priority, JSON.stringify(body.reasons), body.reason_note ?? null, at, body.next_action, body.next_followup_date, at, at, lead.id]);
      await M.historyEntry(tenantId, lead.id, 'enabled', { reason: [...labels, body.reason_note].filter(Boolean).join('; '), priority: body.priority, by: req.auth.userId });
      await M.logActivity(tenantId, lead, req.auth.userId, 'progressive_enabled', `⭐ Marked progressive (${body.priority}): ${labels.join(', ')}`,
        { reasons: body.reasons, priority: body.priority }, at);
    });
    await M.tell({ tenantId, userIds: [...await M.steerersOf(tenantId, project.id), ...await M.ownersOf(tenantId, project.id), lead.assigned_to], except: req.auth.userId,
      eventKey: 'marketing.progressive_added', vars: { lead: lead.company_name, project: project.name, priority: body.priority, reasons: labels.join(', '), person: req.auth.name },
      lead, dedupeKey: `mkt:star:${lead.id}:${at}` });
  } else {
    if (!lead.is_progressive) throw badRequest('This lead is not ⭐ progressive');
    if (!body.reason) throw badRequest('Say why the ⭐ is being removed', [{ field: 'reason', message: 'Give a reason' }]);
    await tx(async () => {
      await run('UPDATE leads SET is_progressive = 0, last_activity_at = ?, updated_at = ? WHERE id = ?', [at, at, lead.id]);
      await M.historyEntry(tenantId, lead.id, 'disabled', { reason: body.reason, priority: lead.progressive_priority, by: req.auth.userId });
      await M.logActivity(tenantId, lead, req.auth.userId, 'progressive_disabled', `⭐ removed: ${body.reason}`, { reason: body.reason }, at);
    });
  }
  await audit(req, { entity: 'lead', entityId: lead.id, action: 'update', after: { progressive: body.on } });
  return ok(res, await leadById(req, lead.id));
});

router.patch('/leads/:id/progressive', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustSteer(req, project);
  const body = validate(z.object({ priority: z.enum(M.PRIORITIES) }), req.body);
  if (!lead.is_progressive) throw badRequest('This lead is not ⭐ progressive');
  if (body.priority === lead.progressive_priority) return ok(res, await leadById(req, lead.id));
  const at = nowIso();
  await tx(async () => {
    await run('UPDATE leads SET progressive_priority = ?, updated_at = ? WHERE id = ?', [body.priority, at, lead.id]);
    await M.historyEntry(req.auth.tenantId, lead.id, 'priority_changed', { reason: `${lead.progressive_priority} → ${body.priority}`, priority: body.priority, by: req.auth.userId });
    await M.logActivity(req.auth.tenantId, lead, req.auth.userId, 'priority_changed', `⭐ priority ${lead.progressive_priority} → ${body.priority}`, { from: lead.progressive_priority, to: body.priority }, at);
  });
  return ok(res, await leadById(req, lead.id));
});

// -------------------------------------------------------- owner action
async function raiseOwnerAction(req, project, lead, body, at) {
  await run(`UPDATE leads SET owner_action_required = 1, owner_action_text = ?, owner_action_due = ?, owner_action_priority = ?,
         owner_action_raised_by = ?, owner_action_raised_at = ? WHERE id = ?`,
  [body.owner_action_text.trim(), body.owner_action_due ?? null, body.owner_action_priority || 'normal', req.auth.userId, at, lead.id]);
  await M.logActivity(req.auth.tenantId, lead, req.auth.userId, 'owner_action_raised', `Owner action needed: ${body.owner_action_text.trim()}`,
    { due: body.owner_action_due ?? null, priority: body.owner_action_priority || 'normal' }, at);
  await M.tell({ tenantId: req.auth.tenantId, userIds: await M.ownersOf(req.auth.tenantId, project.id), except: req.auth.userId,
    eventKey: 'marketing.owner_action', vars: { lead: lead.company_name, project: project.name, action: body.owner_action_text.trim(), due: body.owner_action_due || 'no date', person: req.auth.name },
    lead, dedupeKey: `mkt:owner_action:${lead.id}:${at}` });
}

router.post('/leads/:id/owner-action', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustWork(req, project, lead);
  const body = validate(z.object({
    owner_action_text: z.string().trim().min(2).max(1000),
    owner_action_due: day.optional().nullable(),
    owner_action_priority: z.enum(M.PRIORITIES).optional(),
  }), req.body);
  const at = nowIso();
  await tx(async () => { await raiseOwnerAction(req, project, lead, body, at); await M.touch(lead.id, at); });
  return created(res, await leadById(req, lead.id));
});

router.post('/leads/:id/owner-action/resolve', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustWork(req, project, lead);
  if (!lead.owner_action_required) throw badRequest('There is no open owner action on this lead');
  const { note } = validate(z.object({ note: text(1000) }), req.body);
  const at = nowIso();
  await tx(async () => {
    await run('UPDATE leads SET owner_action_required = 0, last_activity_at = ?, updated_at = ? WHERE id = ?', [at, at, lead.id]);
    await M.logActivity(req.auth.tenantId, lead, req.auth.userId, 'owner_action_resolved',
      `Owner action done: ${lead.owner_action_text}${note ? ` · ${note}` : ''}`, { note: note ?? null }, at);
  });
  return ok(res, await leadById(req, lead.id));
});

/** Every open owner action across the marketing projects this person can see. */
router.get('/owner-attention', leadsAccess('view'), async (req, res) => {
  const ids = await visibleProjectIds(req.auth);
  if (!ids.length) return ok(res, []);
  const ctx = await M.healthContext(req.auth.tenantId);
  const rows = M.decorateLeads(await all(
    `${M.LEAD_SELECT} WHERE l.tenant_id = ? AND l.deleted_at IS NULL AND l.owner_action_required = 1
       AND l.status IN (${M.OPEN_STATUSES.map(() => '?').join(',')}) AND p.kind = 'marketing'
       AND l.project_id IN (${ids.map(() => '?').join(',')})`,
    [req.auth.tenantId, ...M.OPEN_STATUSES, ...ids],
  ), ctx);
  const rank = { critical: 0, high: 1, normal: 2 };
  rows.sort((a, b) => (rank[a.owner_action_priority] ?? 2) - (rank[b.owner_action_priority] ?? 2)
    || String(a.owner_action_due || '9999').localeCompare(String(b.owner_action_due || '9999')));
  return ok(res, rows);
});

// ------------------------------------------------------------- dead
router.post('/leads/:id/dead', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustSteer(req, project);
  if (!M.OPEN_STATUSES.includes(lead.status)) throw badRequest('Only open leads can be marked dead');
  const body = validate(z.object({ reason_code: z.enum(M.DEAD_REASONS.map((r) => r.id)), note: text(1000) }), req.body);
  if (body.reason_code === 'other' && !body.note?.trim()) throw badRequest('Describe the reason', [{ field: 'note', message: 'Why did it die?' }]);
  const tenantId = req.auth.tenantId;
  const at = nowIso();
  const label = M.DEAD_REASONS.find((r) => r.id === body.reason_code).label;

  await tx(async () => {
    await run(`INSERT INTO dead_leads (id, tenant_id, lead_id, project_id, reason_code, reason_note, status_at_death, was_progressive,
           snapshot, marked_by, marked_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, lead.id, project.id, body.reason_code, body.note ?? null, lead.status, lead.is_progressive ? 1 : 0,
      JSON.stringify(lead), req.auth.userId, at]);
    await run(`UPDATE leads SET status = 'dead', dead_at = ?, is_progressive = 0, owner_action_required = 0, last_activity_at = ?, updated_at = ?
          WHERE id = ?`, [at, at, at, lead.id]);
    if (lead.is_progressive) await M.historyEntry(tenantId, lead.id, 'dead', { reason: label, priority: lead.progressive_priority, by: req.auth.userId });
    await M.logActivity(tenantId, lead, req.auth.userId, 'marked_dead', `Marked dead: ${label}${body.note ? ` · ${body.note}` : ''}`,
      { reason_code: body.reason_code, from: lead.status }, at);
  });
  if (lead.is_progressive) {
    await M.tell({ tenantId, userIds: [...await M.steerersOf(tenantId, project.id), ...await M.ownersOf(tenantId, project.id)], except: req.auth.userId,
      eventKey: 'marketing.progressive_lost', vars: { lead: lead.company_name, project: project.name, reason: label, person: req.auth.name },
      lead, dedupeKey: `mkt:dead:${lead.id}:${at}` });
  }
  await audit(req, { entity: 'lead', entityId: lead.id, action: 'update', after: { dead: body.reason_code } });
  return ok(res, await leadById(req, lead.id));
});

router.post('/leads/:id/revive', leadsAccess('edit'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustSteer(req, project);
  if (lead.status !== 'dead') throw badRequest('Only a dead lead can be revived');
  const { note } = validate(z.object({ note: z.string().trim().min(2).max(1000) }), req.body);
  const record = await get('SELECT * FROM dead_leads WHERE lead_id = ? AND revived_at IS NULL ORDER BY marked_at DESC LIMIT 1', [lead.id]);
  const back = record?.status_at_death && M.OPEN_STATUSES.includes(record.status_at_death) ? record.status_at_death : 'contacted';
  const at = nowIso();
  await tx(async () => {
    if (record) await run('UPDATE dead_leads SET revived_at = ?, revived_by = ?, revive_note = ? WHERE id = ?', [at, req.auth.userId, note, record.id]);
    await run('UPDATE leads SET status = ?, dead_at = NULL, last_activity_at = ?, updated_at = ? WHERE id = ?', [back, at, at, lead.id]);
    await M.logActivity(req.auth.tenantId, lead, req.auth.userId, 'revived', `Revived to ${M.statusLabel(back)}: ${note}`, { to: back }, at);
  });
  return ok(res, await leadById(req, lead.id));
});

router.get('/projects/:pid/dead-leads', leadsAccess('view'), async (req, res) => {
  const project = await projectOr404(req, req.params.pid);
  return ok(res, (await all(
    `SELECT d.id, d.lead_id, d.reason_code, d.reason_note, d.status_at_death, d.was_progressive, d.marked_at,
            d.revived_at, d.revive_note, l.company_name, l.contact_name, l.status AS current_status,
            l.expected_value_minor, mb.name AS marked_by_name, rb.name AS revived_by_name, a.name AS assigned_name
       FROM dead_leads d JOIN leads l ON l.id = d.lead_id
       LEFT JOIN users mb ON mb.id = d.marked_by LEFT JOIN users rb ON rb.id = d.revived_by
       LEFT JOIN users a ON a.id = l.assigned_to
      WHERE d.tenant_id = ? AND d.project_id = ? ${req.query.include_revived === 'true' ? '' : 'AND d.revived_at IS NULL'}
      ORDER BY d.marked_at DESC`,
    [req.auth.tenantId, project.id],
  )).map((d) => ({ ...d, reason_label: M.DEAD_REASONS.find((r) => r.id === d.reason_code)?.label || d.reason_code })));
});

router.delete('/leads/:id', leadsAccess('delete'), async (req, res) => {
  const { lead, project } = await leadOr404(req, req.params.id);
  await mustSteer(req, project);
  await run('UPDATE leads SET deleted_at = ?, updated_at = ? WHERE id = ?', [nowIso(), nowIso(), lead.id]);
  await audit(req, { entity: 'lead', entityId: lead.id, action: 'delete', before: lead });
  return ok(res, { ok: true });
});

// ---------------------------------------------------- project timeline
router.get('/projects/:pid/activities', leadsAccess('view'), async (req, res) => {
  const project = await projectOr404(req, req.params.pid);
  const limit = Math.min(Number(req.query.limit) || 100, 300);
  return ok(res, (await all(
    `SELECT a.*, u.name AS user_name, l.company_name, l.is_progressive FROM lead_activities a
       JOIN leads l ON l.id = a.lead_id LEFT JOIN users u ON u.id = a.user_id
      WHERE a.tenant_id = ? AND a.project_id = ? ORDER BY a.created_at DESC LIMIT ?`,
    [req.auth.tenantId, project.id, limit],
  )).map((a) => ({ ...a, meta: parse(a.meta, {}) })));
});

// --------------------------------------------------------------- reports
router.get('/projects/:pid/reports', leadsAccess('view'), async (req, res) => {
  const project = await projectOr404(req, req.params.pid);
  return ok(res, await all(
    `SELECT id, kind, title, period_start, period_end, generated_at FROM report_runs
      WHERE tenant_id = ? AND project_id = ? ORDER BY generated_at DESC LIMIT 60`,
    [req.auth.tenantId, project.id],
  ));
});

router.post('/projects/:pid/reports', leadsAccess('view'), async (req, res) => {
  const project = await projectOr404(req, req.params.pid);
  if (!await M.canWorkLead(req.auth, project.id)) throw forbidden('Only people on this marketing project can generate its reports');
  const { kind } = validate(z.object({ kind: z.enum(['marketing_daily', 'marketing_weekly']) }), req.body);
  const report = kind === 'marketing_daily'
    ? await M.generateDailyReport(req.auth.tenantId, project)
    : await M.generateWeeklyReport(req.auth.tenantId, project);
  return created(res, { id: report.id, title: report.title, kind: report.kind, period_start: report.period_start, period_end: report.period_end });
});

export { router as marketingRouter };
