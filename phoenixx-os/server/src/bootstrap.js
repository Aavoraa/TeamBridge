/**
 * Clean production setup: an empty database becomes your real workspace,
 * with no demo data.
 *
 *   node src/bootstrap.js path/to/team.json [--dry-run]
 *
 * It creates the tables, the subscription plans, one workspace (with the
 * standard starter settings: pipeline stages, service lines, leave types, SOP
 * and KPI templates), its owner, and every user in the file. Nobody's password
 * passes through here: each person gets a one-time link to set their own.
 *
 * It refuses to run on a database that already has a workspace, so it can
 * never mix your data with anything else. See team.example.json.
 */
import fs from 'node:fs';
import { z } from 'zod';
import { config } from './config.js';

const file = process.argv[2];
const dryRun = process.argv.includes('--dry-run');
if (!file || !fs.existsSync(file)) {
  console.error('Usage: node src/bootstrap.js path/to/team.json [--dry-run]');
  process.exit(1);
}

const ROLES = ['owner', 'manager', 'employee', 'finance', 'hr'];
const person = z.object({
  name: z.string().trim().min(2).max(120),
  email: z.string().trim().toLowerCase().email(),
  phone: z.string().trim().max(20).optional().nullable(),
  designation: z.string().trim().max(120).optional().nullable(),
  department: z.string().trim().max(80).optional().nullable(),
});
const schema = z.object({
  workspace: z.object({
    name: z.string().trim().min(2).max(120),
    city: z.string().trim().max(80).optional().nullable(),
    timezone: z.string().trim().default('Asia/Kolkata'),
    currency: z.string().trim().length(3).default('INR'),
    plan: z.enum(['starter', 'growth', 'scale']).default('scale'),
  }),
  owner: person,
  users: z.array(person.extend({
    role: z.enum(ROLES).default('employee'),
    /** Their reporting manager, by email: the owner or someone else in this file. */
    manager_email: z.string().trim().toLowerCase().email().optional().nullable(),
  })).default([]),
});

const parsed = schema.safeParse(JSON.parse(fs.readFileSync(file, 'utf8')));
if (!parsed.success) {
  console.error('The team file has problems:');
  for (const i of parsed.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
  process.exit(1);
}
const team = parsed.data;

// Checks that need no database: duplicate emails and managers that are not in the file.
const emails = [team.owner.email, ...team.users.map((u) => u.email)];
const dupes = emails.filter((e, i) => emails.indexOf(e) !== i);
if (dupes.length) { console.error(`Each email may appear once: ${[...new Set(dupes)].join(', ')}`); process.exit(1); }
const unknownManagers = team.users.filter((u) => u.manager_email && !emails.includes(u.manager_email));
if (unknownManagers.length) {
  console.error(`These managers are not in the file: ${unknownManagers.map((u) => `${u.name} -> ${u.manager_email}`).join('; ')}`);
  process.exit(1);
}
console.log(`Workspace "${team.workspace.name}": owner ${team.owner.email}, ${team.users.length} more user(s).`);
if (dryRun) { console.log('Dry run: the file is valid. Nothing was written.'); process.exit(0); }

const { get, run, tx, init, closeBackend } = await import('./db/index.js');
const { uuid, nowIso, token, addMonths } = await import('./lib/util.js');
const { seedPlans } = await import('./db/plans.js');
const { provisionTenant } = await import('./services/provisioning.js');

await init();
if (await get('SELECT id FROM tenants LIMIT 1')) {
  console.error('This database already has a workspace. Bootstrap only runs on an empty database - nothing was changed.');
  await closeBackend();
  process.exit(1);
}
await seedPlans();

const links = [];
const ts = nowIso();
// The owner's password is a throwaway nobody knows; the invite link replaces it.
const { tenantId, ownerId } = await provisionTenant({
  agencyName: team.workspace.name,
  ownerName: team.owner.name,
  ownerEmail: team.owner.email,
  password: token(24),
  phone: team.owner.phone || null,
  city: team.workspace.city || null,
  planCode: team.workspace.plan,
});

await tx(async () => {
  await run('UPDATE tenants SET timezone = ?, currency = ?, updated_at = ? WHERE id = ?',
    [team.workspace.timezone, team.workspace.currency, ts, tenantId]);
  // Your own company's workspace: an active plan, not a 14-day trial.
  const plan = await get('SELECT id FROM plans WHERE code = ?', [team.workspace.plan]);
  await run(
    `UPDATE subscriptions SET plan_id = ?, status = 'active', seats = ?, trial_ends_at = NULL,
       current_period_start = ?, current_period_end = ?, updated_at = ? WHERE tenant_id = ?`,
    [plan.id, emails.length, ts, addMonths(new Date(), 12).toISOString(), ts, tenantId],
  );
  const ownerToken = token(24);
  await run(`UPDATE users SET status = 'invited', invite_token = ?, designation = COALESCE(?, designation),
               department = ?, updated_at = ? WHERE id = ?`,
    [ownerToken, team.owner.designation || null, team.owner.department || null, ts, ownerId]);
  links.push({ name: team.owner.name, email: team.owner.email, role: 'owner', token: ownerToken });

  const ids = new Map([[team.owner.email, ownerId]]);
  for (const u of team.users) ids.set(u.email, uuid());
  for (const u of team.users) {
    const inviteToken = token(24);
    await run(
      `INSERT INTO users (id, tenant_id, email, password_hash, name, phone, whatsapp, role, designation, department,
         manager_id, employment_type, date_of_joining, status, invite_token, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, 'full_time', ?, 'invited', ?, ?, ?)`,
      [ids.get(u.email), tenantId, u.email, '!', u.name, u.phone || null, u.phone || null, u.role,
        u.designation || null, u.department || null, u.manager_email ? ids.get(u.manager_email) : null,
        ts.slice(0, 10), inviteToken, ts, ts],
    );
    links.push({ name: u.name, email: u.email, role: u.role, token: inviteToken });
  }
});
await closeBackend();

const base = config.webBaseUrl.replace(/\/+$/, '');
console.log(`\n✓ Workspace created with ${links.length} people. Send each person their own link (it works once):\n`);
for (const l of links) console.log(`  ${l.name} <${l.email}> (${l.role})\n    ${base}/accept-invite?token=${l.token}\n`);
console.log('A link that expires or gets lost can be sent again from Team, by the owner.');
