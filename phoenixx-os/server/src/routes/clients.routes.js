import { Router } from 'express';
import { z } from 'zod';
import { get, all, run, repo } from '../db/index.js';
import { uuid, nowIso, parseJson, toCsv } from '../lib/util.js';
import {
  ok, created, validate, notFound, conflict, badRequest, audit, paginate, pageMeta, sortClause,
} from '../lib/http.js';
import { requires } from '../middleware/rbac.js';
import { ensureDeliveryRecord } from '../services/clientAccounts.js';
import { normalizeWebsite, requestProfile, profileView } from '../services/companyProfile.js';
import { sendStoredFile } from '../services/storage.js';

/**
 * The client master - the register behind the Clients page.
 *
 * This is the list of companies you actually do business with, entered and
 * edited here directly rather than as a by-product of working a lead. It is a
 * separate table from the CRM pipeline (see db/schema.sql, MODULE E): a lead is
 * an opportunity with a stage and a deal value, an account is a client on file.
 * A lead can point at an account so saved details are reused for lead and
 * campaign work instead of being retyped.
 *
 * Permissions ride on the existing `crm` module rather than a new one, so the
 * role templates and any custom roles a tenant has already built keep working
 * without a migration.
 */
const router = Router();

const accountSchema = z.object({
  name: z.string().min(2).max(160),
  legal_name: z.string().max(200).optional().nullable(),
  industry: z.string().max(80).optional().nullable(),
  status: z.enum(['active', 'inactive', 'archived']).optional(),
  owner_id: z.string().optional().nullable(),
  contact_name: z.string().max(120).optional().nullable(),
  contact_designation: z.string().max(120).optional().nullable(),
  email: z.string().email().max(160).optional().nullable().or(z.literal('')),
  phone: z.string().max(40).optional().nullable(),
  whatsapp: z.string().max(40).optional().nullable(),
  website: z.string().max(200).optional().nullable(),
  gstin: z.string().max(20).optional().nullable(),
  pan: z.string().max(15).optional().nullable(),
  address: z.string().max(400).optional().nullable(),
  city: z.string().max(80).optional().nullable(),
  state: z.string().max(80).optional().nullable(),
  state_code: z.string().max(4).optional().nullable(),
  country: z.string().max(80).optional().nullable(),
  currency: z.string().length(3).optional(),
  payment_terms_days: z.number().int().min(0).max(365).optional(),
  tags: z.array(z.string()).optional(),
  notes: z.string().max(4000).optional().nullable(),
});

// `stage_id IS NOT NULL` is what separates a real opportunity from the
// stage-less delivery record every account carries. Without it the page would
// report "1 lead" against a client that has no pipeline activity at all.
const SELECT = `
  SELECT a.*, u.name AS owner_name, u.avatar_url AS owner_avatar,
         (SELECT COUNT(*) FROM clients c
           WHERE c.client_account_id = a.id AND c.deleted_at IS NULL
             AND c.stage_id IS NOT NULL) AS lead_count
    FROM client_accounts a
    LEFT JOIN users u ON u.id = a.owner_id`;

const SORTS = {
  name: 'a.name',
  city: 'a.city',
  industry: 'a.industry',
  status: 'a.status',
  created_at: 'a.created_at',
  updated_at: 'a.updated_at',
};

const hydrate = (row) => (row ? { ...row, tags: parseJson(row.tags, []) } : row);

/** Empty strings arrive from HTML inputs; store them as NULL, not ''. */
const nullify = (v) => (v === '' || v === undefined ? null : v);

/** A website, when given, must be a public web address; stored with its https://. */
function checkWebsite(body) {
  if (body.website === undefined || body.website === null || String(body.website).trim() === '') return;
  const url = normalizeWebsite(body.website);
  if (!url) throw badRequest('That website address does not look right', [{ field: 'website', message: 'Enter a web address like example.com' }]);
  body.website = url;
}

const profileRow = (tenantId, id) => get(
  'SELECT * FROM client_website_profiles WHERE client_account_id = ? AND tenant_id = ?', [id, tenantId],
);

/**
 * Same company on the books twice is the failure mode this register exists to
 * prevent, so a create is refused when the name, GSTIN or email already
 * belongs to a live account. `?force=true` is the deliberate override.
 */
async function findDuplicate(tenantId, { name, gstin, email }, excludeId) {
  const where = ['tenant_id = ?', 'deleted_at IS NULL'];
  const params = [tenantId];
  if (excludeId) { where.push('id != ?'); params.push(excludeId); }

  const clauses = ['LOWER(name) = LOWER(?)'];
  params.push(name);
  if (gstin) { clauses.push('gstin = ?'); params.push(gstin); }
  if (email) { clauses.push('LOWER(email) = LOWER(?)'); params.push(email); }

  return await get(
    `SELECT id, name, city, status FROM client_accounts
      WHERE ${where.join(' AND ')} AND (${clauses.join(' OR ')}) LIMIT 1`,
    params,
  );
}

// ------------------------------------------------------------------- list
router.get('/', requires('crm', 'view'), async (req, res) => {
  const { page, limit, offset } = paginate(req);
  const filters = ['a.tenant_id = ?', 'a.deleted_at IS NULL'];
  const params = [req.auth.tenantId];
  const q = req.query;

  // Archived rows stay out of the way unless asked for, so the default view is
  // the list of clients you can actually act on.
  if (q.status) {
    const s = String(q.status).split(',');
    filters.push(`a.status IN (${s.map(() => '?').join(',')})`);
    params.push(...s);
  } else if (q.include_archived !== 'true') {
    filters.push("a.status != 'archived'");
  }

  if (q.owner_id) { filters.push('a.owner_id = ?'); params.push(q.owner_id); }
  if (q.industry) { filters.push('a.industry = ?'); params.push(q.industry); }
  if (q.city) { filters.push('a.city = ?'); params.push(q.city); }
  if (q.search) {
    filters.push(`(a.name LIKE ? OR a.legal_name LIKE ? OR a.email LIKE ?
                   OR a.city LIKE ? OR a.industry LIKE ? OR a.contact_name LIKE ?)`);
    const t = `%${q.search}%`;
    params.push(t, t, t, t, t, t);
  }

  const where = filters.join(' AND ');
  const order = sortClause(req, SORTS, 'a.name ASC');
  const total = Number((await get(`SELECT COUNT(*) AS n FROM client_accounts a WHERE ${where}`, params))?.n || 0);
  const rows = (await all(`${SELECT} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`,
    [...params, limit, offset])).map(hydrate);

  return ok(res, rows, pageMeta(page, limit, total));
});

// ----------------------------------------------------------------- export
router.get('/export', requires('crm', 'export'), async (req, res) => {
  const rows = (await all(
    `${SELECT} WHERE a.tenant_id = ? AND a.deleted_at IS NULL ORDER BY a.name`,
    [req.auth.tenantId],
  )).map(hydrate);

  const csv = toCsv(rows.map((r) => ({
    Name: r.name,
    'Legal name': r.legal_name,
    Industry: r.industry,
    Status: r.status,
    Contact: r.contact_name,
    Email: r.email,
    Phone: r.phone,
    Website: r.website,
    GSTIN: r.gstin,
    City: r.city,
    State: r.state,
    'Payment terms (days)': r.payment_terms_days,
    'Account manager': r.owner_name,
    Leads: r.lead_count,
  })));

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="clients.csv"');
  return res.send(csv);
});

// --------------------------------------------------------------- read one
router.get('/:id', requires('crm', 'view'), async (req, res) => {
  const row = await get(`${SELECT} WHERE a.id = ? AND a.tenant_id = ? AND a.deleted_at IS NULL`,
    [req.params.id, req.auth.tenantId]);
  if (!row) throw notFound('Client');

  // What this client is attached to, so the page can show the work as well as
  // the details, and so a delete can explain what it would strand.
  const leads = await all(
    `SELECT c.id, c.name, c.status, c.deal_value_minor, c.mrr_minor, s.name AS stage_name
       FROM clients c LEFT JOIN pipeline_stages s ON s.id = c.stage_id
      WHERE c.client_account_id = ? AND c.tenant_id = ? AND c.deleted_at IS NULL
        AND c.stage_id IS NOT NULL
      ORDER BY c.updated_at DESC LIMIT 50`,
    [req.params.id, req.auth.tenantId],
  );

  return ok(res, { ...hydrate(row), leads, company_profile: profileView(await profileRow(req.auth.tenantId, row.id)) });
});

// ----------------------------------------------------------------- create
router.post('/', requires('crm', 'create'), async (req, res) => {
  const body = validate(accountSchema, req.body);
  checkWebsite(body);
  const { tenantId, userId } = req.auth;

  if (req.query.force !== 'true') {
    const dup = await findDuplicate(tenantId, body);
    if (dup) {
      throw conflict('A client with that name, GSTIN or email is already on file', {
        existing: dup,
        hint: 'Re-send with ?force=true to add it anyway',
      });
    }
  }

  const id = uuid();
  const ts = nowIso();
  await run(
    `INSERT INTO client_accounts (id, tenant_id, name, legal_name, industry, status, owner_id,
       contact_name, contact_designation, email, phone, whatsapp, website, gstin, pan,
       address, city, state, state_code, country, currency, payment_terms_days, tags, notes,
       created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, body.name, nullify(body.legal_name), nullify(body.industry),
      body.status || 'active', nullify(body.owner_id) || userId,
      nullify(body.contact_name), nullify(body.contact_designation), nullify(body.email),
      nullify(body.phone), nullify(body.whatsapp), nullify(body.website),
      nullify(body.gstin), nullify(body.pan), nullify(body.address), nullify(body.city),
      nullify(body.state), nullify(body.state_code), body.country || 'India',
      body.currency || 'INR', body.payment_terms_days ?? 30,
      JSON.stringify(body.tags || []), nullify(body.notes), ts, ts],
  );

  // So the client is immediately pickable when creating a project, proposal or
  // invoice — those all read the pipeline table.
  await ensureDeliveryRecord(tenantId, userId, await get('SELECT * FROM client_accounts WHERE id = ?', [id]));

  if (body.website) await requestProfile({ tenantId, clientAccountId: id, website: body.website, userId });

  await audit(req, { entity: 'client_account', entityId: id, action: 'create', after: { name: body.name } });
  return created(res, hydrate(await get(`${SELECT} WHERE a.id = ?`, [id])));
});

// ----------------------------------------------------------------- update
router.patch('/:id', requires('crm', 'edit'), async (req, res) => {
  const { tenantId } = req.auth;
  const r = repo('client_accounts', tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Client');

  const body = validate(accountSchema.partial(), req.body);
  checkWebsite(body);

  if (body.name && req.query.force !== 'true') {
    const dup = await findDuplicate(tenantId, { ...before, ...body }, before.id);
    if (dup) {
      throw conflict('Another client with that name, GSTIN or email is already on file', {
        existing: dup,
        hint: 'Re-send with ?force=true to save it anyway',
      });
    }
  }

  const patch = { updated_at: nowIso() };
  for (const [key, value] of Object.entries(body)) {
    patch[key] = key === 'tags' ? JSON.stringify(value || []) : nullify(value);
  }
  // A blank name would leave the row unidentifiable in every picker it appears in.
  if (patch.name === null) delete patch.name;

  await r.update(before.id, patch);

  // Also repairs an account created before delivery records existed, so editing
  // a client is enough to make it selectable everywhere.
  const after = await get('SELECT * FROM client_accounts WHERE id = ?', [before.id]);
  const deliveryId = await ensureDeliveryRecord(tenantId, req.auth.userId, after);
  // Keep the name in step, or the pickers would still show the old one.
  if (patch.name) {
    await run('UPDATE clients SET name = ?, updated_at = ? WHERE id = ? AND tenant_id = ?',
      [after.name, nowIso(), deliveryId, tenantId]);
  }

  // A new or changed website gets a fresh company profile; a cleared one drops it.
  if (body.website !== undefined && (nullify(body.website) || null) !== (before.website || null)) {
    await requestProfile({ tenantId, clientAccountId: before.id, website: body.website, userId: req.auth.userId });
  }

  await audit(req, { entity: 'client_account', entityId: before.id, action: 'update', before, after: patch });
  return ok(res, hydrate(await get(`${SELECT} WHERE a.id = ?`, [before.id])));
});

// ---------------------------------------------------------- company profile
/** Status of the AI company profile, for the page to poll while it is made. */
router.get('/:id/profile', requires('crm', 'view'), async (req, res) => {
  const account = await get('SELECT id FROM client_accounts WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!account) throw notFound('Client');
  return ok(res, profileView(await profileRow(req.auth.tenantId, account.id)));
});

/** Make it again from the current website. */
router.post('/:id/profile', requires('crm', 'edit'), async (req, res) => {
  const account = await get('SELECT id, website FROM client_accounts WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!account) throw notFound('Client');
  if (!normalizeWebsite(account.website)) throw badRequest('Add the website for this client first');
  await requestProfile({ tenantId: req.auth.tenantId, clientAccountId: account.id, website: account.website, userId: req.auth.userId });
  await audit(req, { entity: 'client_account', entityId: account.id, action: 'profile_regenerate' });
  return ok(res, profileView(await profileRow(req.auth.tenantId, account.id)));
});

/** The two-page PDF. */
router.get('/:id/profile.pdf', requires('crm', 'view'), async (req, res) => {
  const account = await get('SELECT id, name FROM client_accounts WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!account) throw notFound('Client');
  const row = await profileRow(req.auth.tenantId, account.id);
  if (!row?.pdf_path) throw notFound('Company profile');
  const filename = `${account.name.replace(/[^\w.\- ]/g, '').trim() || 'client'} - company profile.pdf`;
  const disposition = req.query.download === '1' ? 'attachment' : 'inline';
  if (!(await sendStoredFile(res, row.pdf_path, { filename, disposition }))) throw notFound('Company profile');
});

// ----------------------------------------------------------------- archive
/**
 * Soft delete. Any lead pointing here is detached rather than deleted - the
 * pipeline record is the sales team's, and losing a live opportunity because
 * someone tidied up the client register would be the wrong trade.
 */
router.delete('/:id', requires('crm', 'delete'), async (req, res) => {
  const { tenantId } = req.auth;
  const r = repo('client_accounts', tenantId);
  const before = await r.findById(req.params.id);
  if (!before) throw notFound('Client');

  // Counted before the detach, and only real opportunities — the stage-less
  // delivery record is bookkeeping, not something worth telling anyone about.
  const detachedLeads = Number((await get(
    `SELECT COUNT(*) AS n FROM clients
      WHERE client_account_id = ? AND tenant_id = ? AND deleted_at IS NULL
        AND stage_id IS NOT NULL`,
    [before.id, tenantId],
  ))?.n || 0);

  await run(
    'UPDATE clients SET client_account_id = NULL WHERE client_account_id = ? AND tenant_id = ?',
    [before.id, tenantId],
  );
  await r.softDelete(before.id, nowIso());

  await audit(req, { entity: 'client_account', entityId: before.id, action: 'delete', before });
  return ok(res, { id: before.id, detached_leads: detachedLeads });
});

export { router as clientsRouter };
