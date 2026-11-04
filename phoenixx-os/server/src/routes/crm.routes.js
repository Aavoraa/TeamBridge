import { forEachSeq } from '../lib/util.js';
import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo, tx } from '../db/index.js';
import {
  uuid, nowIso, todayIso, daysBetween, parseJson, toCsv, parseCsv, slugify,
} from '../lib/util.js';
import {
  ok, created, validate, notFound, badRequest, conflict, audit, paginate, pageMeta, sortClause,
} from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { scopeFilter } from '../middleware/auth.js';
import { scoreClient } from '../services/scoring.js';
import { upsertDeadline } from '../services/deadlines.js';
import { emitWebhook } from '../services/webhooks.js';
import { seesAllProjects, associatedSql } from '../services/projectOversight.js';

const router = Router();

const clientSchema = z.object({
  name: z.string().min(2).max(160),
  legal_name: z.string().optional().nullable(),
  industry: z.string().optional().nullable(),
  // The client master record this lead belongs to, when it is one already on
  // file. Optional — most new leads are for companies you have no account for.
  client_account_id: z.string().optional().nullable(),
  stage_id: z.string().optional().nullable(),
  status: z.enum(['lead', 'active', 'churned', 'lost']).optional(),
  owner_id: z.string().optional().nullable(),
  source: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  gstin: z.string().optional().nullable(),
  pan: z.string().optional().nullable(),
  address: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  state_code: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  currency: z.string().optional(),
  service_lines: z.array(z.string()).optional(),
  engagement_model: z.enum(['retainer', 'project', 'hybrid']).optional(),
  mrr_minor: z.number().int().min(0).optional(),
  deal_value_minor: z.number().int().min(0).optional(),
  next_action: z.string().optional().nullable(),
  next_action_date: z.string().optional().nullable(),
  next_action_owner_id: z.string().optional().nullable(),
  scope_total: z.number().int().min(0).optional(),
  scope_delivered: z.number().int().min(0).optional(),
  satisfaction: z.number().min(1).max(5).optional().nullable(),
  renewal_date: z.string().optional().nullable(),
  tags: z.array(z.string()).optional(),
  notes: z.string().optional().nullable(),
});

const SELECT = `
  SELECT c.*, u.name AS owner_name, u.avatar_url AS owner_avatar,
         s.name AS stage_name, s.code AS stage_code, s.sort AS stage_sort, s.probability,
         rc.label AS retention_reason_label,
         ca.name AS client_account_name,
         (SELECT COUNT(*) FROM activities a WHERE a.client_id = c.id) AS activity_count,
         (SELECT COALESCE(SUM(i.balance_minor),0) FROM invoices i
           WHERE i.client_id = c.id AND i.deleted_at IS NULL AND i.status NOT IN ('draft','written_off')) AS outstanding_minor
    FROM clients c
    LEFT JOIN users u ON u.id = c.owner_id
    LEFT JOIN pipeline_stages s ON s.id = c.stage_id
    LEFT JOIN reason_codes rc ON rc.id = c.retention_reason_code_id
    LEFT JOIN client_accounts ca ON ca.id = c.client_account_id`;

const SORTS = {
  name: 'c.name',
  created_at: 'c.created_at',
  health: 'c.health_score',
  risk: 'c.risk_score',
  retention: 'c.retention_score',
  conversion: 'c.conversion_score',
  next_action_date: 'c.next_action_date',
  value: 'c.deal_value_minor',
};

const hydrate = (row) => (row ? {
  ...row,
  service_lines: parseJson(row.service_lines, []),
  tags: parseJson(row.tags, []),
} : row);

// -------------------------------------------------------------------- list
router.get('/clients', requires('crm', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['c.tenant_id = ?', 'c.deleted_at IS NULL'];
  const params = [req.auth.tenantId];

  const scope = await scopeFilter(req, 'c.owner_id');
  if (scope.where) { filters.push(scope.where); params.push(...scope.params); }

  const q = req.query;
  if (q.status) { const s = String(q.status).split(','); filters.push(`c.status IN (${s.map(() => '?').join(',')})`); params.push(...s); }
  if (q.stage_id) { filters.push('c.stage_id = ?'); params.push(q.stage_id); }
  if (q.client_account_id) { filters.push('c.client_account_id = ?'); params.push(q.client_account_id); }
  // Only companies on the Clients page (the client register), as the default Clients view shows them:
  // not archived, not deleted. Leads and stray pipeline rows are left out.
  if (q.on_register === 'true') {
    filters.push("c.client_account_id IN (SELECT ca.id FROM client_accounts ca WHERE ca.tenant_id = c.tenant_id AND ca.deleted_at IS NULL AND ca.status != 'archived')");
  }
  if (q.owner_id) { filters.push('c.owner_id = ?'); params.push(q.owner_id); }
  if (q.industry) { filters.push('c.industry = ?'); params.push(q.industry); }
  if (q.engagement_model) { filters.push('c.engagement_model = ?'); params.push(q.engagement_model); }
  if (q.retention_risk === 'true') filters.push('c.retention_risk = 1');
  if (q.filter === 'no_next_action') filters.push("(c.next_action IS NULL OR c.next_action = '' OR c.next_action_date IS NULL)");
  if (q.filter === 'follow_up_due') { filters.push('c.next_action_date <= ?'); params.push(todayIso()); }
  if (q.service_line_id) { filters.push('c.service_lines LIKE ?'); params.push(`%${q.service_line_id}%`); }
  if (q.search) {
    filters.push('(c.name LIKE ? OR c.legal_name LIKE ? OR c.industry LIKE ? OR c.city LIKE ?)');
    const t = `%${q.search}%`;
    params.push(t, t, t, t);
  }

  const where = filters.join(' AND ');
  const order = sortClause(req, SORTS, 's.sort ASC, c.updated_at DESC');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM clients c WHERE ${where}`, params))?.n || 0);
  const rows = (await all(`${SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...params, limit, offset]))
    .map(hydrate);

  return ok(res, rows, pageMeta(page, limit, total));
});

/** E1 - the pipeline board, grouped by stage. */
/**
 * Everything that must happen when a client crosses into a new stage: history
 * row, activity entry, webhook. Returns the patch fields the caller should
 * merge. Shared by PATCH /clients/:id and the board's move endpoint so a drag
 * and a dropdown produce identical records.
 */
async function recordStageChange({ tenantId, userId, before, toStageId }) {
  const from = before.stage_id ? await get('SELECT name FROM pipeline_stages WHERE id = ?', [before.stage_id]) : null;
  const to = await get('SELECT * FROM pipeline_stages WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [toStageId, tenantId]);
  if (!to) throw badRequest('Unknown pipeline stage');

  await run(
    `INSERT INTO stage_history (id, tenant_id, client_id, from_stage_id, to_stage_id, from_stage,
       to_stage, days_in_previous, changed_by, changed_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [uuid(), tenantId, before.id, before.stage_id, toStageId, from?.name ?? null, to.name,
      before.stage_entered_at ? daysBetween(before.stage_entered_at, new Date()) : null, userId, nowIso()],
  );
  await run(
    `INSERT INTO activities (id, tenant_id, client_id, type, subject, body, occurred_at, user_id, created_at)
     VALUES (?,?,?, 'stage_change', ?, ?, ?, ?, ?)`,
    [uuid(), tenantId, before.id, `Moved to ${to.name}`,
      `Stage changed from ${from?.name || 'none'} to ${to.name}`, nowIso(), userId, nowIso()],
  );
  await emitWebhook(tenantId, 'client.stage_changed', {
    client_id: before.id, name: before.name, from: from?.name, to: to.name,
  });
  return { stage_entered_at: nowIso() };
}

/**
 * Board position between two neighbours. Fractional, so dropping a card
 * rewrites one row rather than renumbering the stage. `null` means the gap has
 * run out of floating-point room and the stage needs renumbering first — which
 * takes roughly 50 drops into the same gap.
 */
function sortBetween(prev, next) {
  if (!prev && !next) return 0;
  if (!prev) return next.board_sort - 1;
  if (!next) return prev.board_sort + 1;
  const mid = (prev.board_sort + next.board_sort) / 2;
  return mid === prev.board_sort || mid === next.board_sort ? null : mid;
}

/** E1 - drag-and-drop board move: reorder within a stage, or across stages. */
router.post('/pipeline/move', requires('crm', 'edit'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(z.object({
    client_id: z.string(),
    stage_id: z.string(),
    prev_id: z.string().nullish(),   // card immediately above the drop point
    next_id: z.string().nullish(),   // card immediately below it
  }), req.body);

  const r = repo('clients', tenantId);
  const before = await r.findById(body.client_id);
  if (!before) throw notFound('Client');

  // Neighbours are re-read under the caller's tenant, so a spoofed id from
  // another workspace resolves to nothing rather than moving this card.
  const neighbour = async (id) => (id ? await r.findById(id) : null);

  const out = await tx(async () => {
    const patch = { board_sort: 0, updated_at: nowIso() };

    if (body.stage_id !== before.stage_id) {
      Object.assign(patch, await recordStageChange({ tenantId, userId, before, toStageId: body.stage_id }));
    } else if (!await get('SELECT id FROM pipeline_stages WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
      [body.stage_id, tenantId])) {
      throw badRequest('Unknown pipeline stage');
    }

    let sort = sortBetween(await neighbour(body.prev_id), await neighbour(body.next_id));
    if (sort === null) {
      // Gap exhausted: space the stage out, then retry between the same pair.
      await forEachSeq(await all('SELECT id FROM clients WHERE tenant_id = ? AND stage_id = ? AND deleted_at IS NULL ORDER BY board_sort, deal_value_minor DESC',
        [tenantId, body.stage_id]), async (row, i) => await run('UPDATE clients SET board_sort = ? WHERE id = ? AND tenant_id = ?', [i * 1024, row.id, tenantId]));
      sort = sortBetween(await neighbour(body.prev_id), await neighbour(body.next_id)) ?? 0;
    }
    patch.board_sort = sort;
    patch.stage_id = body.stage_id;

    return await r.update(body.client_id, patch);
  });

  await scoreClient(tenantId, out.id);
  await audit(req, { entity: 'client', entityId: out.id, action: 'update', before, after: out });
  return ok(res, hydrate(await get(`${SELECT} WHERE c.id = ?`, [out.id])));
});

router.get('/pipeline', requires('crm', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const stages = await all(
    'SELECT * FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort',
    [tenantId],
  );
  const scope = await scopeFilter(req, 'c.owner_id');
  const extra = scope.where ? ` AND ${scope.where}` : '';

  return ok(res, await Promise.all(stages.map(async (stage) => {
    const clients = (await all(
      `${SELECT} WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.stage_id = ?
         AND c.status IN ('lead','active')${extra}
       ORDER BY c.board_sort ASC, c.deal_value_minor DESC LIMIT 100`,
      [tenantId, stage.id, ...scope.params],
    )).map(hydrate);
    return {
      ...stage,
      clients,
      count: clients.length,
      value_minor: clients.reduce((a, c) => a + (c.deal_value_minor || 0), 0),
    };
  })));
});

/**
 * Every client on file in the tenant, id and name only - the list the pickers
 * need when another module links a record to a client (action items, meetings,
 * projects, proposals). Deliberately outside `scopeFilter`: an employee sees
 * only the clients they own on the pipeline, but they still have to be able to
 * raise a task against any client the firm works with. Nothing commercial is
 * exposed here, so the wider read costs nothing.
 */
router.get('/clients/options', requires('crm', 'view'), async (req, res) => ok(res, await all(
  `SELECT id, name, status, client_account_id FROM clients
     WHERE tenant_id = ? AND deleted_at IS NULL
     ORDER BY LOWER(name)`,
  [req.auth.tenantId],
)));

router.get('/clients/export', requires('crm', 'export'), async (req, res) => {
  const rows = (await all(
    `${SELECT} WHERE c.tenant_id = ? AND c.deleted_at IS NULL ORDER BY c.name`,
    [req.auth.tenantId],
  )).map((r) => ({
    name: r.name, legal_name: r.legal_name, industry: r.industry, status: r.status,
    stage: r.stage_name, owner: r.owner_name, source: r.source, city: r.city, state: r.state,
    gstin: r.gstin, engagement_model: r.engagement_model,
    mrr: (r.mrr_minor || 0) / 100, deal_value: (r.deal_value_minor || 0) / 100,
    next_action: r.next_action, next_action_date: r.next_action_date,
    conversion_score: r.conversion_score, risk_score: r.risk_score,
    relevancy_score: r.relevancy_score, retention_score: r.retention_score, health_score: r.health_score,
  }));
  await audit(req, { entity: 'client', action: 'export', after: { count: rows.length } });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="clients.csv"');
  return res.send(toCsv(rows));
});

// ------------------------------------------------------------------ single
router.get('/clients/:id', requires('crm', 'view'), async (req, res) => {
  const { tenantId } = req.auth;
  const client = await get(`${SELECT} WHERE c.id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL`,
    [req.params.id, tenantId]);
  if (!client) throw notFound('Client');

  return ok(res, {
    ...hydrate(client),
    contacts: await all('SELECT * FROM contacts WHERE client_id = ? AND deleted_at IS NULL ORDER BY is_primary DESC, name',
      [client.id]),
    // E3 - unified activity timeline across calls, messages, proposals and invoices.
    timeline: (await all(
      `SELECT a.*, u.name AS user_name, ct.name AS contact_name FROM activities a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN contacts ct ON ct.id = a.contact_id
        WHERE a.client_id = ? ORDER BY a.occurred_at DESC LIMIT 120`,
      [client.id],
    )).map((a) => ({ ...a, meta: parseJson(a.meta, {}) })),
    projects: await all(
      `SELECT p.*, u.name AS manager_name, l.name AS lead_name,
              (SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = p.id AND pm.deleted_at IS NULL) AS team_size
         FROM projects p
         LEFT JOIN users u ON u.id = p.manager_id
         LEFT JOIN users l ON l.id = p.lead_id
        WHERE p.client_id = ? AND p.deleted_at IS NULL
          ${seesAllProjects(req.auth) ? '' : `AND ${associatedSql('p')}`}
        ORDER BY p.created_at DESC`,
      // Employees and managers see only the projects they are associated with.
      seesAllProjects(req.auth) ? [client.id] : [client.id, req.auth.userId, req.auth.userId],
    ),
    proposals: await all(
      "SELECT id, number, title, status, total_minor, sent_at, view_count, accepted_at, valid_until FROM proposals WHERE client_id = ? AND deleted_at IS NULL ORDER BY created_at DESC",
      [client.id],
    ),
    invoices: await all(
      'SELECT id, number, status, issue_date, due_date, total_minor, paid_minor, balance_minor FROM invoices WHERE client_id = ? AND deleted_at IS NULL ORDER BY issue_date DESC',
      [client.id],
    ),
    action_items: await all(
      `SELECT a.id, a.title, a.status, a.due_date, a.due_time, a.due_at, a.priority, u.name AS owner_name
         FROM action_items a LEFT JOIN users u ON u.id = a.owner_id
        WHERE a.client_id = ? AND a.deleted_at IS NULL ORDER BY a.due_at LIMIT 30`,
      [client.id],
    ),
    stage_history: await all('SELECT * FROM stage_history WHERE client_id = ? ORDER BY changed_at DESC LIMIT 20', [client.id]),
    score_history: (await all(
      'SELECT snapshot_date, conversion, risk, relevancy, retention, health FROM client_score_history WHERE client_id = ? ORDER BY snapshot_date DESC LIMIT 30',
      [client.id],
    )).reverse(),
    scores: await scoreClient(tenantId, client.id, { persist: false }),
  });
});

// ------------------------------------------------------------------ create
async function findDuplicate(tenantId, name, website, gstin) {
  // E8 - duplicate detection on normalised name, domain and GSTIN.
  const norm = slugify(name);
  const domain = website ? String(website).replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0] : null;
  return (await all(
    'SELECT id, name, website, gstin FROM clients WHERE tenant_id = ? AND deleted_at IS NULL',
    [tenantId],
  )).find((c) => slugify(c.name) === norm
    || (gstin && c.gstin && c.gstin.toUpperCase() === String(gstin).toUpperCase())
    || (domain && c.website && c.website.includes(domain)));
}

router.post('/clients', requires('crm', 'create'), async (req, res) => {
  const body = validate(clientSchema, req.body);
  const { tenantId, userId } = req.auth;

  if (req.query.force !== 'true') {
    const dup = await findDuplicate(tenantId, body.name, body.website, body.gstin);
    if (dup) {
      throw conflict('A client with a matching name, domain or GSTIN already exists', {
        existing: dup,
        hint: 'Re-send with ?force=true to create it anyway',
      });
    }
  }

  const firstStage = body.stage_id
    ? await get('SELECT * FROM pipeline_stages WHERE id = ? AND tenant_id = ?', [body.stage_id, tenantId])
    : await get('SELECT * FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort LIMIT 1', [tenantId]);

  const id = uuid();
  const ts = nowIso();

  await tx(async () => {
    await run(
      `INSERT INTO clients (id, tenant_id, name, legal_name, industry, client_account_id, stage_id, status,
         owner_id, source,
         website, gstin, pan, address, city, state, state_code, country, currency, service_lines,
         engagement_model, mrr_minor, deal_value_minor, next_action, next_action_date, next_action_owner_id,
         scope_total, scope_delivered, renewal_date, tags, notes, stage_entered_at, last_activity_at,
         created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, body.name, body.legal_name ?? null, body.industry ?? null,
        body.client_account_id ?? null, firstStage?.id ?? null,
        body.status || 'lead', body.owner_id || userId, body.source ?? null, body.website ?? null,
        body.gstin ?? null, body.pan ?? null, body.address ?? null, body.city ?? null, body.state ?? null,
        body.state_code ?? null, body.country || 'India', body.currency || 'INR',
        JSON.stringify(body.service_lines || []), body.engagement_model || 'project',
        body.mrr_minor || 0, body.deal_value_minor || 0, body.next_action ?? null,
        body.next_action_date ?? null, body.next_action_owner_id ?? null,
        body.scope_total || 0, body.scope_delivered || 0, body.renewal_date ?? null,
        JSON.stringify(body.tags || []), body.notes ?? null, ts, ts, ts, ts],
    );
    await run(
      `INSERT INTO stage_history (id, tenant_id, client_id, to_stage_id, to_stage, changed_by, changed_at)
       VALUES (?,?,?,?,?,?,?)`,
      [uuid(), tenantId, id, firstStage?.id ?? null, firstStage?.name ?? null, userId, ts],
    );
  });

  if (body.next_action_date) {
    await upsertDeadline({
      tenantId, sourceType: 'follow_up', sourceId: id,
      title: `Follow up: ${body.name}`, dueAt: body.next_action_date,
      ownerId: body.next_action_owner_id || body.owner_id || userId,
      meta: { client: body.name, next_action: body.next_action },
    });
  }

  await scoreClient(tenantId, id);
  await audit(req, { entity: 'client', entityId: id, action: 'create', after: { name: body.name } });
  return created(res, hydrate(await get(`${SELECT} WHERE c.id = ?`, [id])));
});

// ------------------------------------------------------------------ update
router.patch('/clients/:id', requires('crm', 'edit'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const r = repo('clients', tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Client');

  const body = validate(clientSchema.partial().extend({
    retention_reason_code_id: z.string().optional().nullable(),
    retention_reason_note: z.string().optional().nullable(),
    churn_reason_code_id: z.string().optional().nullable(),
  }), req.body);

  const patch = { ...body, updated_at: nowIso() };
  if (body.service_lines) patch.service_lines = JSON.stringify(body.service_lines);
  if (body.tags) patch.tags = JSON.stringify(body.tags);

  // E7 - a retention-risk flag must carry a structured reason code, never free text.
  if (body.retention_reason_code_id) {
    const rc = await get("SELECT * FROM reason_codes WHERE id = ? AND tenant_id = ? AND category = 'retention_risk' AND active = 1",
      [body.retention_reason_code_id, tenantId]);
    if (!rc) throw badRequest('Pick a retention-risk reason from the managed list');
  }

  // Marking a client churned requires a churn reason code.
  if (body.status === 'churned' && before.status !== 'churned') {
    if (!body.churn_reason_code_id) throw badRequest('Churning a client requires a structured churn reason code');
    const rc = await get("SELECT * FROM reason_codes WHERE id = ? AND tenant_id = ? AND category = 'churn'",
      [body.churn_reason_code_id, tenantId]);
    if (!rc) throw badRequest('That churn reason code does not exist');
    patch.churned_at = nowIso();
  }
  if (body.status === 'active' && before.status !== 'active' && !before.onboarded_at) {
    patch.onboarded_at = nowIso();
  }

  // Stage change: log history and emit the webhook (AR3).
  if (body.stage_id && body.stage_id !== before.stage_id) {
    Object.assign(patch, await recordStageChange({ tenantId, userId, before, toStageId: body.stage_id }));
  }

  const after = await r.update(req.params.id, patch);

  if (after.next_action_date) {
    await upsertDeadline({
      tenantId, sourceType: 'follow_up', sourceId: after.id,
      title: `Follow up: ${after.name}`, dueAt: after.next_action_date,
      ownerId: after.next_action_owner_id || after.owner_id,
      meta: { client: after.name, next_action: after.next_action },
    });
  }

  await scoreClient(tenantId, after.id);
  await audit(req, { entity: 'client', entityId: after.id, action: 'update', before, after });
  return ok(res, hydrate(await get(`${SELECT} WHERE c.id = ?`, [after.id])));
});

router.delete('/clients/:id', requires('crm', 'delete'), async (req, res) => {
  const r = repo('clients', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Client');
  await r.softDelete(req.params.id, nowIso());
  await audit(req, { entity: 'client', entityId: req.params.id, action: 'delete', before });
  return ok(res, { ok: true });
});

// ---------------------------------------------------------------- contacts
const contactSchema = z.object({
  name: z.string().min(2).max(120),
  designation: z.string().optional().nullable(),
  email: z.string().email().optional().nullable().or(z.literal('')),
  phone: z.string().optional().nullable(),
  whatsapp: z.string().optional().nullable(),
  is_primary: z.boolean().optional(),
  consent_whatsapp: z.boolean().optional(),
  notes: z.string().optional().nullable(),
});

router.post('/clients/:id/contacts', requires('crm', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  if (!await get('SELECT id FROM clients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [req.params.id, tenantId])) {
    throw notFound('Client');
  }
  const body = validate(contactSchema, req.body);
  const id = uuid();

  await tx(async () => {
    if (body.is_primary) await run('UPDATE contacts SET is_primary = 0 WHERE client_id = ?', [req.params.id]);
    await run(
      `INSERT INTO contacts (id, tenant_id, client_id, name, designation, email, phone, whatsapp,
         is_primary, consent_whatsapp, notes, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, req.params.id, body.name, body.designation ?? null, body.email || null,
        body.phone ?? null, body.whatsapp ?? null, body.is_primary ? 1 : 0,
        body.consent_whatsapp ? 1 : 0, body.notes ?? null, nowIso(), nowIso()],
    );
  });
  return created(res, await get('SELECT * FROM contacts WHERE id = ?', [id]));
});

router.patch('/contacts/:id', requires('crm', 'edit'), async (req, res) => {
  const r = repo('contacts', req.auth.tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Contact');

  const body = validate(contactSchema.partial(), req.body);
  const patch = { ...body, updated_at: nowIso() };
  if (body.is_primary != null) {
    patch.is_primary = body.is_primary ? 1 : 0;
    if (body.is_primary) await run('UPDATE contacts SET is_primary = 0 WHERE client_id = ?', [before.client_id]);
  }
  if (body.consent_whatsapp != null) patch.consent_whatsapp = body.consent_whatsapp ? 1 : 0;
  if (body.email === '') patch.email = null;

  return ok(res, await r.update(req.params.id, patch));
});

router.delete('/contacts/:id', requires('crm', 'edit'), async (req, res) => {
  await repo('contacts', req.auth.tenantId).softDelete(req.params.id, nowIso());
  return ok(res, { ok: true });
});

// -------------------------------------------------------------- activities
const activitySchema = z.object({
  type: z.enum(['call', 'whatsapp', 'email', 'meeting', 'note', 'grievance', 'proposal', 'invoice']),
  direction: z.enum(['inbound', 'outbound']).optional(),
  subject: z.string().optional().nullable(),
  body: z.string().optional().nullable(),
  outcome: z.enum(['connected', 'no_response', 'positive', 'negative', 'scheduled']).optional().nullable(),
  occurred_at: z.string().optional(),
  contact_id: z.string().optional().nullable(),
  duration_minutes: z.number().int().min(0).optional().nullable(),
  // E4 - logging a touchpoint is the natural moment to set the next action.
  next_action: z.string().optional().nullable(),
  next_action_date: z.string().optional().nullable(),
});

router.post('/clients/:id/activities', requires('crm', 'create'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const client = await get('SELECT * FROM clients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, tenantId]);
  if (!client) throw notFound('Client');

  const body = validate(activitySchema, req.body);
  const id = uuid();
  const at = body.occurred_at || nowIso();

  await tx(async () => {
    await run(
      `INSERT INTO activities (id, tenant_id, client_id, contact_id, type, direction, subject, body,
         outcome, occurred_at, user_id, duration_minutes, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [id, tenantId, client.id, body.contact_id ?? null, body.type, body.direction || 'outbound',
        body.subject ?? null, body.body ?? null, body.outcome ?? null, at, userId,
        body.duration_minutes ?? null, nowIso()],
    );
    const patch = { last_activity_at: at, updated_at: nowIso() };
    if (body.next_action !== undefined) patch.next_action = body.next_action;
    if (body.next_action_date !== undefined) patch.next_action_date = body.next_action_date;
    const cols = Object.keys(patch);
    await run(`UPDATE clients SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`,
      [...cols.map((c) => patch[c]), client.id]);
  });

  if (body.next_action_date) {
    await upsertDeadline({
      tenantId, sourceType: 'follow_up', sourceId: client.id,
      title: `Follow up: ${client.name}`, dueAt: body.next_action_date,
      ownerId: client.next_action_owner_id || client.owner_id,
      meta: { client: client.name, next_action: body.next_action },
    });
  }

  await scoreClient(tenantId, client.id);
  return created(res, await get('SELECT * FROM activities WHERE id = ?', [id]));
});

// ---------------------------------------------------------------- scoring
router.post('/clients/:id/rescore', requires('crm', 'edit'), async (req, res) => {
  const scores = await scoreClient(req.auth.tenantId, req.params.id, { persist: true, snapshot: true });
  if (!scores) throw notFound('Client');
  return ok(res, scores);
});

/** E6 - manual adjustment, always with a reason code. */
router.post('/clients/:id/score-adjustments', requires('crm', 'approve'), async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(z.object({
    score_type: z.enum(['conversion', 'risk', 'relevancy', 'retention']),
    delta: z.number().min(-50).max(50),
    reason_code_id: z.string(),
    note: z.string().optional().nullable(),
    expires_at: z.string().optional().nullable(),
  }), req.body);

  if (!await get('SELECT id FROM clients WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [req.params.id, tenantId])) {
    throw notFound('Client');
  }
  if (!await get('SELECT id FROM reason_codes WHERE id = ? AND tenant_id = ? AND active = 1', [body.reason_code_id, tenantId])) {
    throw badRequest('Pick a reason from the managed reason-code list');
  }

  const id = uuid();
  await run(
    `INSERT INTO score_adjustments (id, tenant_id, client_id, score_type, delta, reason_code_id, note,
       user_id, expires_at, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, req.params.id, body.score_type, body.delta, body.reason_code_id,
      body.note ?? null, userId, body.expires_at ?? null, nowIso()],
  );

  await audit(req, { entity: 'client', entityId: req.params.id, action: 'update', after: { score_adjustment: body } });
  return created(res, {
    adjustment: await get('SELECT * FROM score_adjustments WHERE id = ?', [id]),
    scores: await scoreClient(tenantId, req.params.id, { persist: true }),
  });
});

router.get('/clients/:id/score-adjustments', requires('crm', 'view'), async (req, res) => ok(res, await all(
  `SELECT sa.*, rc.label AS reason_label, rc.code AS reason_code, u.name AS user_name
     FROM score_adjustments sa
     JOIN reason_codes rc ON rc.id = sa.reason_code_id
     LEFT JOIN users u ON u.id = sa.user_id
    WHERE sa.tenant_id = ? AND sa.client_id = ? ORDER BY sa.created_at DESC`,
  [req.auth.tenantId, req.params.id],
)));

router.delete('/score-adjustments/:id', requires('crm', 'approve'), async (req, res) => {
  const adj = await get('SELECT * FROM score_adjustments WHERE id = ? AND tenant_id = ?', [req.params.id, req.auth.tenantId]);
  if (!adj) throw notFound('Adjustment');
  await run('DELETE FROM score_adjustments WHERE id = ?', [req.params.id]);
  await scoreClient(req.auth.tenantId, adj.client_id);
  return ok(res, { ok: true });
});

// --------------------------------------------------- E7 client work traction
router.get('/traction', requires('crm', 'view'), async (req, res) => {
  const rows = (await all(
    `SELECT c.id, c.name, c.status, c.engagement_model, c.scope_total, c.scope_delivered,
            c.health_score, c.risk_score, c.retention_score, c.retention_risk, c.renewal_date,
            rc.label AS retention_reason,
            (SELECT COUNT(*) FROM action_items a WHERE a.client_id = c.id AND a.deleted_at IS NULL
               AND a.status NOT IN ('done','cancelled')) AS open_items,
            (SELECT COALESCE(SUM(i.taxable_minor),0) FROM invoices i WHERE i.client_id = c.id
               AND i.deleted_at IS NULL AND i.status NOT IN ('draft','written_off')) AS billed_minor,
            (SELECT COALESCE(SUM(i.balance_minor),0) FROM invoices i WHERE i.client_id = c.id
               AND i.deleted_at IS NULL AND i.status NOT IN ('draft','written_off')) AS outstanding_minor
       FROM clients c
       LEFT JOIN reason_codes rc ON rc.id = c.retention_reason_code_id
      WHERE c.tenant_id = ? AND c.deleted_at IS NULL AND c.status = 'active'
      ORDER BY c.health_score ASC`,
    [req.auth.tenantId],
  )).map((r) => ({
    ...r,
    delivery_pct: r.scope_total ? Math.round((r.scope_delivered / r.scope_total) * 100) : null,
  }));
  return ok(res, rows);
});

// ------------------------------------------------------------- CSV import
router.post('/clients/import', requires('crm', 'create'), async (req, res) => {
  const { csv, dry_run: dryRun = false } = validate(
    z.object({ csv: z.string().min(1), dry_run: z.boolean().optional() }), req.body,
  );
  const { tenantId, userId } = req.auth;
  const rows = parseCsv(csv);
  if (!rows.length) throw badRequest('The file has no data rows');

  const stage = await get('SELECT * FROM pipeline_stages WHERE tenant_id = ? AND deleted_at IS NULL ORDER BY sort LIMIT 1', [tenantId]);
  const results = { created: 0, skipped: 0, errors: [], duplicates: [] };

  const process = async () => {
    await forEachSeq(rows, async (row, i) => {
      const name = row.name || row.Name || row.company || row.Company;
      if (!name) { results.errors.push({ row: i + 2, error: 'missing name' }); return; }

      const dup = await findDuplicate(tenantId, name, row.website, row.gstin);
      if (dup) { results.skipped++; results.duplicates.push({ row: i + 2, name, existing_id: dup.id }); return; }
      if (dryRun) { results.created++; return; }

      const id = uuid();
      const ts = nowIso();
      await run(
        `INSERT INTO clients (id, tenant_id, name, legal_name, industry, stage_id, status, owner_id,
           source, website, gstin, city, state, state_code, country, currency, service_lines,
           engagement_model, mrr_minor, deal_value_minor, next_action, next_action_date, tags,
           notes, stage_entered_at, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, '[]', ?,?,?,?,?, '[]', ?,?,?,?)`,
        [id, tenantId, name, row.legal_name || null, row.industry || null, stage?.id ?? null,
          row.status || 'lead', row.owner_id || userId, row.source || 'import', row.website || null,
          row.gstin || null, row.city || null, row.state || null, row.state_code || null,
          row.country || 'India', row.currency || 'INR', row.engagement_model || 'project',
          Math.round(Number(row.mrr || 0) * 100), Math.round(Number(row.deal_value || 0) * 100),
          row.next_action || null, row.next_action_date || null, row.notes || null, ts, ts, ts],
      );
      results.created++;
    });
  };

  if (dryRun) await process(); else await tx(process);
  if (!dryRun) await audit(req, { entity: 'client', action: 'create', after: { imported: results.created } });

  return ok(res, { ...results, dry_run: dryRun, total_rows: rows.length });
});

export { router as crmRouter };
