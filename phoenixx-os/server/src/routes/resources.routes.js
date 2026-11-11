import { Router } from 'express';
import { z } from 'zod';
import { get, all, run } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';
import { ok, created, validate, notFound, badRequest, forbidden, audit, ApiError } from '../lib/http.js';
import { saveFile, readFile } from '../services/storage.js';
import { attachmentToPdf } from '../services/attachmentPdf.js';
import { seesAllProjects, associatedSql, canSeeProject } from '../services/projectOversight.js';

/**
 * Resources: the documents kept for a client or a project - contracts, briefs,
 * brand assets, reports - to store, view, download, and download as PDF.
 *
 * Who sees what:
 * - A project's documents: anyone who can see the project (its team, its
 *   owners, and the roles that see every project).
 * - A client's documents: owners and managers, and anyone on a project for
 *   that client - so the people doing the work have the brief and the brand
 *   guide without being given the whole CRM.
 * Anyone who can see a document's project may add to it; only owners and
 * managers add client-level documents. The uploader, owners and managers delete.
 *
 * Files live under resources/<tenant>/, which the generic /files route never
 * serves: every read comes through here and passes the rules above.
 */
export const resourcesRouter = Router();

export const CATEGORIES = ['contract', 'brief', 'brand', 'design', 'report', 'invoice', 'other'];
const MANAGING_ROLES = ['owner', 'super_admin', 'manager'];
const manages = (auth) => MANAGING_ROLES.includes(auth.role);
const MAX_BYTES = 15 * 1024 * 1024;

/** The client accounts whose documents this person may read: null = all. */
async function visibleClientIds(auth) {
  if (manages(auth)) return null;
  return (await all(
    `SELECT DISTINCT c.client_account_id AS id FROM projects p JOIN clients c ON c.id = p.client_id
      WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND c.client_account_id IS NOT NULL AND ${associatedSql('p')}`,
    [auth.tenantId, auth.userId, auth.userId],
  )).map((r) => r.id);
}

async function canSeeClientDocs(auth, clientAccountId) {
  const ids = await visibleClientIds(auth);
  return ids === null || ids.includes(clientAccountId);
}

/** The row, if this person may read it; 404 otherwise (no hint it exists). */
async function readable(req) {
  const r = await get('SELECT * FROM resources WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL',
    [req.params.id, req.auth.tenantId]);
  if (!r) throw notFound('Document');
  const okToSee = r.project_id ? await canSeeProject(req.auth, r.project_id)
    : await canSeeClientDocs(req.auth, r.client_account_id);
  if (!okToSee) throw notFound('Document');
  return r;
}

const SELECT = `
  SELECT r.id, r.client_account_id, r.project_id, r.title, r.category, r.notes, r.filename, r.mime, r.size_bytes,
         r.uploaded_by, r.created_at, u.name AS uploaded_by_name,
         COALESCE(ca.name, pca.name, pc.name) AS client_name, p.name AS project_name,
         COALESCE(r.client_account_id, pc.client_account_id) AS effective_client_id
    FROM resources r
    LEFT JOIN users u ON u.id = r.uploaded_by
    LEFT JOIN client_accounts ca ON ca.id = r.client_account_id
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN clients pc ON pc.id = p.client_id
    LEFT JOIN client_accounts pca ON pca.id = pc.client_account_id`;

const withRights = (auth) => (r) => ({ ...r, can_delete: r.uploaded_by === auth.userId || manages(auth) });

// ------------------------------------------------------------------- list
/**
 * Filters: client_account_id (that client's own documents and its projects'),
 * project_id, scope=client|project, category, q (title, file name, notes).
 */
resourcesRouter.get('/', async (req, res) => {
  const { tenantId } = req.auth;
  const where = ['r.tenant_id = ?', 'r.deleted_at IS NULL'];
  const params = [tenantId];

  // Visibility first.
  const clientIds = await visibleClientIds(req.auth);
  const vis = [];
  if (seesAllProjects(req.auth)) vis.push('r.project_id IS NOT NULL');
  else { vis.push(`(r.project_id IS NOT NULL AND ${associatedSql('p')})`); params.push(req.auth.userId, req.auth.userId); }
  if (clientIds === null) vis.push('r.project_id IS NULL');
  else if (clientIds.length) { vis.push(`(r.project_id IS NULL AND r.client_account_id IN (${clientIds.map(() => '?').join(',')}))`); params.push(...clientIds); }
  where.push(`(${vis.join(' OR ')})`);

  const q = req.query;
  if (q.project_id) { where.push('r.project_id = ?'); params.push(String(q.project_id)); }
  if (q.client_account_id) {
    where.push('(r.client_account_id = ? OR pc.client_account_id = ?)');
    params.push(String(q.client_account_id), String(q.client_account_id));
  }
  if (q.scope === 'client') where.push('r.project_id IS NULL');
  if (q.scope === 'project') where.push('r.project_id IS NOT NULL');
  if (q.category && CATEGORIES.includes(String(q.category))) { where.push('r.category = ?'); params.push(String(q.category)); }
  if (q.q) {
    const like = `%${String(q.q).toLowerCase()}%`;
    where.push('(LOWER(r.title) LIKE ? OR LOWER(r.filename) LIKE ? OR LOWER(COALESCE(r.notes, \'\')) LIKE ?)');
    params.push(like, like, like);
  }
  const rows = await all(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC LIMIT 500`, params);
  return ok(res, rows.map(withRights(req.auth)));
});

/** Where this person can file a document: clients (managers only) and visible projects. */
resourcesRouter.get('/targets', async (req, res) => {
  const { tenantId } = req.auth;
  const clients = manages(req.auth) ? await all(
    "SELECT id, name FROM client_accounts WHERE tenant_id = ? AND deleted_at IS NULL AND status != 'archived' ORDER BY name",
    [tenantId],
  ) : [];
  const projects = seesAllProjects(req.auth)
    ? await all(
      `SELECT p.id, p.name, c.client_account_id, COALESCE(ca.name, c.name) AS client_name FROM projects p
         JOIN clients c ON c.id = p.client_id LEFT JOIN client_accounts ca ON ca.id = c.client_account_id
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL ORDER BY p.name`, [tenantId])
    : await all(
      `SELECT p.id, p.name, c.client_account_id, COALESCE(ca.name, c.name) AS client_name FROM projects p
         JOIN clients c ON c.id = p.client_id LEFT JOIN client_accounts ca ON ca.id = c.client_account_id
        WHERE p.tenant_id = ? AND p.deleted_at IS NULL AND ${associatedSql('p')} ORDER BY p.name`,
      [tenantId, req.auth.userId, req.auth.userId]);
  // Clients a non-manager can filter by: those of their projects.
  const filterClients = manages(req.auth) ? clients : Object.values(Object.fromEntries(
    projects.filter((p) => p.client_account_id).map((p) => [p.client_account_id, { id: p.client_account_id, name: p.client_name }]),
  )).sort((a, b) => a.name.localeCompare(b.name));
  return ok(res, { clients, projects, filter_clients: filterClients, categories: CATEGORIES, can_add_client_docs: manages(req.auth) });
});

/**
 * The folder view: each company this person may see, its own document count,
 * and its projects with theirs. A company has many projects; a project whose
 * client is only a pipeline record (no client account) is grouped under that
 * client's name and has no company-level folder.
 */
resourcesRouter.get('/summary', async (req, res) => {
  const { tenantId, userId } = req.auth;
  const projParams = [tenantId];
  let projWhere = 'p.tenant_id = ? AND p.deleted_at IS NULL';
  if (!seesAllProjects(req.auth)) { projWhere += ` AND ${associatedSql('p')}`; projParams.push(userId, userId); }
  const projects = await all(
    `SELECT p.id, p.name, p.status, c.client_account_id, c.id AS lead_id, COALESCE(ca.name, c.name) AS client_name,
            (SELECT COUNT(*) FROM resources r WHERE r.project_id = p.id AND r.deleted_at IS NULL) AS doc_count,
            (SELECT MAX(r.created_at) FROM resources r WHERE r.project_id = p.id AND r.deleted_at IS NULL) AS last_doc_at
       FROM projects p JOIN clients c ON c.id = p.client_id
       LEFT JOIN client_accounts ca ON ca.id = c.client_account_id AND ca.deleted_at IS NULL
      WHERE ${projWhere} ORDER BY p.name`, projParams,
  );

  const companies = new Map();
  const company = (key, fields) => {
    if (!companies.has(key)) companies.set(key, { ...fields, doc_count: 0, last_doc_at: null, projects: [] });
    return companies.get(key);
  };
  // Every client account a manager can see, even one with no projects yet.
  const clientIds = await visibleClientIds(req.auth);
  const accounts = clientIds === null
    ? await all("SELECT id, name, industry FROM client_accounts WHERE tenant_id = ? AND deleted_at IS NULL AND status != 'archived'", [tenantId])
    : clientIds.length ? await all(
      `SELECT id, name, industry FROM client_accounts WHERE tenant_id = ? AND deleted_at IS NULL AND id IN (${clientIds.map(() => '?').join(',')})`,
      [tenantId, ...clientIds],
    ) : [];
  const counts = accounts.length ? await all(
    `SELECT client_account_id AS id, COUNT(*) AS n, MAX(created_at) AS last_at FROM resources
      WHERE tenant_id = ? AND deleted_at IS NULL AND project_id IS NULL GROUP BY client_account_id`, [tenantId],
  ) : [];
  const countOf = Object.fromEntries(counts.map((c) => [c.id, c]));
  for (const a of accounts) {
    const c = company(a.id, { id: a.id, name: a.name, industry: a.industry, has_company_folder: true });
    c.doc_count = Number(countOf[a.id]?.n || 0);
    c.last_doc_at = countOf[a.id]?.last_at || null;
  }
  for (const p of projects) {
    const key = p.client_account_id || `lead:${p.lead_id}`;
    const c = company(key, {
      id: p.client_account_id || null, name: p.client_name, industry: null, has_company_folder: !!p.client_account_id,
    });
    c.projects.push({ id: p.id, name: p.name, status: p.status, doc_count: Number(p.doc_count || 0), last_doc_at: p.last_doc_at });
  }
  const list = [...companies.entries()].map(([key, c]) => {
    const total = c.doc_count + c.projects.reduce((n, p) => n + p.doc_count, 0);
    const last = [c.last_doc_at, ...c.projects.map((p) => p.last_doc_at)].filter(Boolean).sort().pop() || null;
    return { key, ...c, total_docs: total, last_doc_at: last };
  }).sort((a, b) => a.name.localeCompare(b.name));
  return ok(res, { companies: list, can_add_client_docs: manages(req.auth) });
});

// ----------------------------------------------------------------- upload
const uploadSchema = z.object({
  client_account_id: z.string().optional().nullable(),
  project_id: z.string().optional().nullable(),
  title: z.string().trim().max(200).optional().nullable(),
  category: z.enum(CATEGORIES).optional(),
  notes: z.string().max(2000).optional().nullable(),
  filename: z.string().min(1).max(200),
  mime: z.string().max(120).optional().nullable(),
  content_base64: z.string().max(21_000_000),
});

resourcesRouter.post('/', async (req, res) => {
  const { tenantId, userId } = req.auth;
  const body = validate(uploadSchema, req.body);
  if (!!body.client_account_id === !!body.project_id) {
    throw badRequest('Choose a client or a project for this document', [{ field: 'target', message: 'Choose a client or a project' }]);
  }
  if (body.project_id) {
    const p = await get('SELECT id FROM projects WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [body.project_id, tenantId]);
    if (!p || !await canSeeProject(req.auth, p.id)) throw notFound('Project');
  } else {
    if (!manages(req.auth)) throw forbidden('Only owners and managers add documents to a client. Add it to the project instead.');
    const c = await get('SELECT id FROM client_accounts WHERE id = ? AND tenant_id = ? AND deleted_at IS NULL', [body.client_account_id, tenantId]);
    if (!c) throw notFound('Client');
  }
  const buffer = Buffer.from(body.content_base64, 'base64');
  if (!buffer.length) throw badRequest('The file is empty');
  if (buffer.length > MAX_BYTES) throw badRequest('Files are limited to 15 MB');

  const id = uuid();
  const safeName = body.filename.replace(/[^\w.\- ]/g, '_');
  const path = `resources/${tenantId}/${id}-${safeName}`;
  await saveFile(path, buffer, body.mime || undefined);
  const ts = nowIso();
  await run(
    `INSERT INTO resources (id, tenant_id, client_account_id, project_id, title, category, notes, filename, mime,
       size_bytes, storage_path, uploaded_by, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, tenantId, body.project_id ? null : body.client_account_id, body.project_id || null,
      body.title?.trim() || body.filename.replace(/\.[^.]+$/, ''), body.category || 'other', body.notes?.trim() || null,
      body.filename, body.mime || null, buffer.length, path, userId, ts, ts],
  );
  await audit(req, { entity: 'resource', entityId: id, action: 'create', after: { filename: body.filename } });
  return created(res, withRights(req.auth)(await get(`${SELECT} WHERE r.id = ?`, [id])));
});

/** Rename, re-categorise, or add a note. */
resourcesRouter.patch('/:id', async (req, res) => {
  const r = await readable(req);
  if (!(r.uploaded_by === req.auth.userId || manages(req.auth))) throw forbidden('Only the person who added it, or a manager, can change it');
  const body = validate(z.object({
    title: z.string().trim().min(1).max(200).optional(),
    category: z.enum(CATEGORIES).optional(),
    notes: z.string().max(2000).optional().nullable(),
  }), req.body);
  const sets = Object.keys(body);
  if (sets.length) {
    await run(`UPDATE resources SET ${sets.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
      [...sets.map((k) => (k === 'notes' ? (body.notes?.trim() || null) : body[k])), nowIso(), r.id]);
  }
  return ok(res, withRights(req.auth)(await get(`${SELECT} WHERE r.id = ?`, [r.id])));
});

resourcesRouter.delete('/:id', async (req, res) => {
  const r = await readable(req);
  if (!(r.uploaded_by === req.auth.userId || manages(req.auth))) throw forbidden('Only the person who added it, or a manager, can delete it');
  await run('UPDATE resources SET deleted_at = ? WHERE id = ?', [nowIso(), r.id]);
  await audit(req, { entity: 'resource', entityId: r.id, action: 'delete', before: { filename: r.filename } });
  return ok(res, { id: r.id });
});

// ------------------------------------------------------------------- files
const SAFE_INLINE = /^(application\/pdf|image\/(png|jpe?g|gif|webp)|text\/(plain|csv))$/i;
const disposition = (kind, filename) => `${kind}; filename="${filename.replace(/["\\\r\n]/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

/** The file as uploaded: inline to view, ?download=1 to save. */
resourcesRouter.get('/:id/file', async (req, res) => {
  const r = await readable(req);
  const file = await readFile(r.storage_path);
  if (!file) throw notFound('File');
  // Only types that cannot run script are shown inline; anything else (HTML,
  // SVG...) is always a download, and sandboxed in case a browser renders it.
  const mime = r.mime || file.mime;
  const inline = req.query.download !== '1' && SAFE_INLINE.test(mime);
  res.setHeader('Content-Type', inline ? mime : 'application/octet-stream');
  res.setHeader('Content-Length', file.size);
  res.setHeader('Content-Disposition', disposition(inline ? 'inline' : 'attachment', r.filename));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', 'sandbox');
  res.end(file.data);
});

/** As a PDF: PDFs as they are; images and text converted. */
resourcesRouter.get('/:id/pdf', async (req, res) => {
  const r = await readable(req);
  const file = await readFile(r.storage_path);
  if (!file) throw notFound('File');
  const pdf = await attachmentToPdf({ data: file.data, mime: r.mime || file.mime, filename: r.filename });
  if (!pdf) throw new ApiError(415, 'not_convertible', 'This file type cannot be turned into a PDF. Download the original instead.');
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Length', pdf.length);
  res.setHeader('Content-Disposition', disposition('attachment', `${r.filename.replace(/\.[^.]+$/, '') || 'document'}.pdf`));
  res.end(pdf);
});
