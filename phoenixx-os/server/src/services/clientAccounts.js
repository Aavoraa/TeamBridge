import { get, all, run } from '../db/index.js';
import { uuid, nowIso } from '../lib/util.js';

/**
 * Keeps the client register and the pipeline table in step.
 *
 * The Clients page writes to client_accounts, but projects, invoices,
 * proposals and recurring invoices all carry a foreign key to clients(id) —
 * 34 joins across 16 files, including the invoicing and GST paths. Rather than
 * re-point all of that, every account gets a matching row in `clients`, linked
 * by client_account_id, so existing queries keep working untouched.
 *
 * That row is created with NO stage, which is what keeps it off the CRM board:
 * the board selects by stage, so a stage-less row never appears on it. A client
 * on the register is not an opportunity in the funnel.
 */

/**
 * Idempotent. Prefers linking a row that already exists — a company already
 * being worked as a lead keeps its history and its board card rather than
 * gaining a duplicate.
 */
export async function ensureDeliveryRecord(tenantId, userId, account) {
  if (!account) return null;

  const existing = await get(
    `SELECT id, client_account_id FROM clients
      WHERE tenant_id = ? AND deleted_at IS NULL
        AND (client_account_id = ? OR LOWER(name) = LOWER(?))
      ORDER BY client_account_id IS NULL, created_at LIMIT 1`,
    [tenantId, account.id, account.name],
  );

  if (existing) {
    if (!existing.client_account_id) {
      await run('UPDATE clients SET client_account_id = ?, updated_at = ? WHERE id = ?',
        [account.id, nowIso(), existing.id]);
    }
    return existing.id;
  }

  const id = uuid();
  const ts = nowIso();
  await run(
    `INSERT INTO clients (id, tenant_id, name, legal_name, industry, client_account_id, stage_id,
       status, owner_id, website, gstin, pan, address, city, state, state_code, country, currency,
       service_lines, engagement_model, tags, created_at, updated_at)
     VALUES (?,?,?,?,?,?, NULL, 'active', ?,?,?,?,?,?,?,?,?,?, '[]', 'project', '[]', ?, ?)`,
    [id, tenantId, account.name, account.legal_name, account.industry, account.id,
      account.owner_id || userId, account.website, account.gstin, account.pan, account.address,
      account.city, account.state, account.state_code, account.country || 'India',
      account.currency || 'INR', ts, ts],
  );
  return id;
}

/**
 * Repairs accounts created before delivery records existed — without this they
 * are invisible in every project, proposal and invoice picker, with no way for
 * the person who added them to work out why. Runs once at boot; cheap, and a
 * no-op on a database that is already consistent.
 */
export async function backfillDeliveryRecords() {
  const orphans = await all(
    `SELECT a.* FROM client_accounts a
      WHERE a.deleted_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM clients c
           WHERE c.client_account_id = a.id AND c.deleted_at IS NULL
        )`,
  );
  for (const account of orphans) {
    await ensureDeliveryRecord(account.tenant_id, account.owner_id, account);
  }
  return orphans.length;
}

/**
 * A client typed by name, as the New project form sends it. Reuses the client
 * already on the register under that name (any case), otherwise adds a plain
 * one to the Clients page, where the rest of its details can be filled in later.
 * Returns the `clients` row id that projects point at.
 */
export async function clientIdForName(tenantId, userId, rawName) {
  const name = String(rawName || '').replace(/\s+/g, ' ').trim();
  if (!name) return null;
  let account = await get(
    `SELECT * FROM client_accounts
      WHERE tenant_id = ? AND deleted_at IS NULL AND LOWER(name) = LOWER(?)
      ORDER BY status = 'archived', created_at LIMIT 1`,
    [tenantId, name],
  );
  if (!account) {
    const id = uuid();
    const ts = nowIso();
    await run(
      `INSERT INTO client_accounts (id, tenant_id, name, status, owner_id, country, currency,
         payment_terms_days, tags, created_at, updated_at)
       VALUES (?,?,?, 'active', ?, 'India', 'INR', 30, '[]', ?, ?)`,
      [id, tenantId, name, userId, ts, ts],
    );
    account = await get('SELECT * FROM client_accounts WHERE id = ?', [id]);
  }
  return ensureDeliveryRecord(tenantId, userId, account);
}
