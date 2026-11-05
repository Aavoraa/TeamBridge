import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { dueAtIso, DEFAULT_TZ } from '../lib/dueTime.js';
import { query, execSql, transaction, backend, closeBackend } from './driver.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * PostgreSQL. See driver.js for how the connection is chosen (a real server via
 * DATABASE_URL in production, in-process PGlite for development and tests).
 *
 * Every helper here is async. The code was originally written against SQLite's
 * synchronous driver; the query text and helper names did not change, only
 * that each call is now awaited.
 */

export { closeBackend };

// --------------------------------------------------------------- schema DDL
/**
 * schema.sql is written in the portable subset of SQLite and PostgreSQL. The
 * three differences are settled here rather than by keeping two copies:
 *   INTEGER -> BIGINT            money is minor units; paise overflow int4 at ~2 crore
 *   REAL    -> DOUBLE PRECISION  PostgreSQL's REAL is single precision
 *   PRAGMA  -> dropped           SQLite connection settings
 */
export function toPgDdl(sql) {
  return sql
    .replace(/^\s*PRAGMA[^;]*;\s*$/gim, '')
    .replace(/\bINTEGER\b/g, 'BIGINT')
    .replace(/\bREAL\b/g, 'DOUBLE PRECISION');
}

/** Splits a script into statements, ignoring `;` inside comments and strings. */
function splitStatements(sql) {
  const out = [];
  let cur = '';
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      i = j === -1 ? sql.length : j;
      cur += '\n';
    } else if (c === '/' && sql[i + 1] === '*') {
      const j = sql.indexOf('*/', i + 2);
      i = j === -1 ? sql.length : j + 1;
    } else if (c === "'") {
      const j = sql.indexOf("'", i + 1);
      cur += sql.slice(i, j + 1);
      i = j;
    } else if (c === ';') {
      if (cur.trim()) out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/**
 * SQLite lets a table reference one declared further down the file;
 * PostgreSQL does not. Tables are emitted after everything they reference,
 * keeping file order otherwise, then every other statement in file order.
 */
export function schemaStatements(sql) {
  const stmts = splitStatements(toPgDdl(sql));
  const tables = new Map();
  const rest = [];
  for (const s of stmts) {
    const m = /^CREATE TABLE IF NOT EXISTS\s+(\w+)/i.exec(s);
    if (m) {
      const refs = new Set([...s.matchAll(/REFERENCES\s+(\w+)/gi)].map((r) => r[1]));
      refs.delete(m[1]);
      tables.set(m[1], { sql: s, refs });
    } else {
      rest.push(s);
    }
  }
  const ordered = [];
  const state = new Map();
  const visit = (name) => {
    const t = tables.get(name);
    if (!t || state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`schema.sql: foreign-key cycle through ${name}`);
    state.set(name, 'visiting');
    for (const r of t.refs) visit(r);
    state.set(name, 'done');
    ordered.push(t.sql);
  };
  for (const name of tables.keys()) visit(name);
  return [...ordered, ...rest];
}

/**
 * Fingerprint of everything migrate() would do. A serverless cold start that
 * finds the database already at this version skips the migration entirely,
 * so a new instance answers its first request in one round trip, not hundreds.
 */
let schemaVersion;
function currentSchemaVersion() {
  if (!schemaVersion) {
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    schemaVersion = crypto.createHash('sha256')
      .update(sql)
      .update(JSON.stringify(ADDED_COLUMNS))
      .update(JSON.stringify(ADDED_INDEXES))
      .update(JSON.stringify(ONE_TIME.map(([k]) => k)))
      .digest('hex')
      .slice(0, 16);
  }
  return schemaVersion;
}

/** Apply schema.sql and the additive migrations (idempotent). Always runs in full. */
export async function migrate() {
  // Two cold starts racing each other on a fresh deploy: the advisory lock
  // makes the second wait for the first rather than both running DDL.
  await transaction(async () => {
    await execSql('SELECT pg_advisory_xact_lock(4207731)');
    const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    await execSql(schemaStatements(sql).join(';\n') + ';');
    await loadColumns();
    await addColumns();
    await addIndexes();
    await loadColumns();
  });
  await backfill();
  await runOneTime();
  await execSql('CREATE TABLE IF NOT EXISTS app_schema_version (id INTEGER PRIMARY KEY, version TEXT NOT NULL, applied_at TEXT NOT NULL)');
  await run(
    `INSERT INTO app_schema_version (id, version, applied_at) VALUES (1, ?, ?)
     ON CONFLICT (id) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
    [currentSchemaVersion(), new Date().toISOString()],
  );
}

/**
 * migrate(), unless this exact schema version is already in place - which is
 * the normal case for every serverless cold start after the first.
 */
export async function migrateIfNeeded() {
  const exists = await get(
    `SELECT 1 AS ok FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_name = 'app_schema_version'`,
  );
  const known = exists ? await get('SELECT version FROM app_schema_version WHERE id = 1') : undefined;
  if (known?.version === currentSchemaVersion()) {
    await loadColumns();
    return false;
  }
  await migrate();
  return true;
}

/** Opens the connection and brings the schema up to date. Safe to call often. */
let readyPromise;
export function init() {
  if (!readyPromise) {
    readyPromise = (async () => {
      await backend();
      await migrateIfNeeded();
    })().catch((err) => {
      readyPromise = undefined; // let the next request try again
      throw err;
    });
  }
  return readyPromise;
}

/** Drops every table. Used by `npm run reset` and nothing else. */
export async function dropAll() {
  await execSql('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  columnCache.clear();
  readyPromise = undefined;
}

/**
 * Indexes over columns that arrive through `ADDED_COLUMNS`. They cannot live in
 * schema.sql: that file is applied before the ALTERs, so on an existing
 * database the column would not be there yet and the CREATE INDEX would fail
 * the whole migration.
 */
const ADDED_INDEXES = [
  // Overdue is asked of the instant now, on every list, counter and My Day.
  ['action_items', 'due_at', 'CREATE INDEX IF NOT EXISTS ix_ai_due_at ON action_items(tenant_id, status, due_at)'],
  // HR's queue of late arrivals waiting on a ruling.
  ['attendance', 'scheduled_start', 'CREATE INDEX IF NOT EXISTS ix_att_status ON attendance(tenant_id, status, work_date)'],
  // A planner task becomes at most one action item, ever - deleted ones
  // included, so a retry can never bring a removed item back as a duplicate.
  // The database says no, not just the code, so two requests racing each
  // other cannot both win.
  ['action_items', 'source_plan_id', `CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_planner_task
     ON action_items(tenant_id, source_id) WHERE source_type = 'advance_planner'`],
  ['action_items', 'source_plan_id', 'CREATE INDEX IF NOT EXISTS ix_ai_source_plan ON action_items(tenant_id, source_plan_id)'],
  ['meetings', 'kind', 'CREATE INDEX IF NOT EXISTS ix_meet_kind_time ON meetings(tenant_id, kind, scheduled_at)'],
  ['meetings', 'invite_token', 'CREATE UNIQUE INDEX IF NOT EXISTS ux_meet_invite_token ON meetings(invite_token) WHERE invite_token IS NOT NULL'],
  ['meetings', 'room_name', 'CREATE UNIQUE INDEX IF NOT EXISTS ux_meet_room ON meetings(room_name) WHERE room_name IS NOT NULL'],
  ['meetings', 'series_id', 'CREATE INDEX IF NOT EXISTS ix_meet_series ON meetings(series_id)'],
  ['meeting_attendees', 'response', 'CREATE INDEX IF NOT EXISTS ix_matt_user ON meeting_attendees(tenant_id, user_id, meeting_id)'],
];


/**
 * Additive migrations for columns introduced after a database already exists.
 * `CREATE TABLE IF NOT EXISTS` cannot add a column to a table that is already
 * there, so anything new has to arrive as an ALTER guarded by a column check.
 * Each entry must be nullable or carry a DEFAULT - SQLite cannot add a NOT NULL
 * column without one.
 */
const ADDED_COLUMNS = [
  // Manual card order inside a pipeline stage (Kanban board drag-and-drop).
  // REAL, not INTEGER: positions are assigned as the midpoint between the two
  // neighbours, so a reorder touches one row instead of renumbering the column.
  ['clients', 'board_sort', 'REAL NOT NULL DEFAULT 0'],
  // Links a pipeline lead to the client master record it belongs to. Nullable:
  // most leads are for companies not yet on file, and they stay that way until
  // someone attaches them. No REFERENCES clause here - SQLite cannot add a
  // foreign key with ALTER TABLE, so on an existing database this is a plain
  // TEXT column; new databases get the constraint from schema.sql.
  ['clients', 'client_account_id', 'TEXT'],
  // Delivery lead on a project, alongside the existing manager_id. Mirrors the
  // project_members row holding the 'lead' seat.
  ['projects', 'lead_id', 'TEXT'],
  // Security-question account recovery. The question is shown back to whoever
  // is trying to recover, so it is stored in the clear; the answer never is.
  ['users', 'security_question', 'TEXT'],
  ['users', 'security_answer_hash', 'TEXT'],
  ['users', 'security_updated_at', 'TEXT'],
  // Wrong-answer throttling lives on the row rather than in the in-memory rate
  // limiter: a lockout has to survive a restart and cannot be shed by moving IP.
  ['users', 'recovery_failed_attempts', 'INTEGER NOT NULL DEFAULT 0'],
  ['users', 'recovery_locked_until', 'TEXT'],
  // Single-use, short-lived, stored as a SHA-256 digest like refresh tokens.
  ['users', 'recovery_token', 'TEXT'],
  ['users', 'recovery_token_expires_at', 'TEXT'],
  // Creator sign-off on completed work. `validation_status` is NULL while the
  // task is still being worked, 'pending' once the assignee marks it done,
  // then 'validated' or 'changes_requested' once the creator has ruled. Left
  // nullable rather than defaulted so existing rows read as "no validation
  // ever asked for", which is exactly what they are.
  ['action_items', 'validation_status', 'TEXT'],
  ['action_items', 'completed_by', 'TEXT'],
  ['action_items', 'validated_by', 'TEXT'],
  ['action_items', 'validated_at', 'TEXT'],
  ['action_items', 'validation_note', 'TEXT'],
  // How many times the work has come back for changes. Drives the "2nd
  // attempt" hint in the UI and is the number a manager actually wants.
  ['action_items', 'rework_count', 'INTEGER NOT NULL DEFAULT 0'],
  // Same-day scheduling. `due_time` is the workspace-local 'HH:MM' the task is
  // wanted by, NULL for a task that is simply due that day; `due_at` is the UTC
  // instant the date and time resolve to and is what every overdue test reads.
  // Both nullable: a task with no due date has neither.
  ['action_items', 'due_time', 'TEXT'],
  ['action_items', 'due_at', 'TEXT'],
  // The working day, as HR defines it. Workspace defaults first, then the
  // per-employee overrides that fall back to them when NULL.
  ['tenants', 'work_start', "TEXT NOT NULL DEFAULT '09:30'"],
  ['tenants', 'work_end', "TEXT NOT NULL DEFAULT '18:30'"],
  ['tenants', 'late_grace_minutes', 'INTEGER NOT NULL DEFAULT 10'],
  // JSON weekday numbers, 0 = Sunday. Sunday alone is the weekly off: a six-day
  // week is the norm here, and a Saturday that is not worked is a holiday
  // somebody puts on the calendar rather than a standing rule.
  ['tenants', 'week_off_days', "TEXT NOT NULL DEFAULT '[0]'"],
  ['users', 'work_start', 'TEXT'],
  ['users', 'work_end', 'TEXT'],
  ['users', 'grace_minutes', 'INTEGER'],
  // The schedule a day was actually judged against, and HR's ruling on it.
  ['attendance', 'scheduled_start', 'TEXT'],
  ['attendance', 'scheduled_end', 'TEXT'],
  ['attendance', 'approved_by', 'TEXT'],
  ['attendance', 'approved_at', 'TEXT'],
  ['attendance', 'approval_note', 'TEXT'],
  // Office-network check. Off until HR switches it on, so a workspace that has
  // never configured a network keeps the attendance it always had.
  ['tenants', 'network_check', 'INTEGER NOT NULL DEFAULT 0'],
  // What the server saw at check-in. `network_verified` is NULL when the check
  // was off, 1 for an approved network, 0 otherwise. `client_ip` is HR-only.
  ['attendance', 'network_verified', 'INTEGER'],
  ['attendance', 'verification_method', 'TEXT'],
  ['attendance', 'network_id', 'TEXT'],
  ['attendance', 'network_label', 'TEXT'],
  ['attendance', 'client_ip', 'TEXT'],
  // Why the day is waiting on HR: comma-separated late|off_network|offline.
  ['attendance', 'review_reason', 'TEXT'],
  // The approved hourly permission that made a late arrival an agreed one.
  ['attendance', 'permission_id', 'TEXT'],
  // When the current session began, for a day with more than one: set on
  // checking in again after a check-out, NULL for an ordinary single session.
  ['attendance', 'session_started_at', 'TEXT'],
  // Performance scorecards v2. `pillars` is the JSON breakdown - every pillar's
  // score, weight, raw inputs and the records that pulled it down - so a score
  // can be explained without recomputing it. `system_score` is the data half;
  // `overall_score` blends in the manager's rating.
  ['performance_reviews', 'scorecard_kind', 'TEXT'],
  ['performance_reviews', 'system_score', 'REAL'],
  ['performance_reviews', 'band', 'TEXT'],
  ['performance_reviews', 'pillars', 'TEXT'],
  ['performance_reviews', 'computed_at', 'TEXT'],
  ['performance_reviews', 'period_end', 'TEXT'],
  ['performance_reviews', 'acknowledged_at', 'TEXT'],
  // Workspace overrides of the scorecard weights; NULL means the defaults.
  ['tenants', 'performance_weights', 'TEXT'],
  // delivery | marketing. A marketing project carries a lead pipeline.
  ['projects', 'kind', "TEXT NOT NULL DEFAULT 'delivery'"],
  // Marketing thresholds and report times; NULL means the defaults.
  ['tenants', 'marketing_settings', 'TEXT'],
  // Tomorrow's To-Do schedule (times, working days, toggles); NULL means the defaults.
  ['tenants', 'todo_settings', 'TEXT'],
  // A planned task ticked off on the day, like a card marked complete.
  ['todo_tasks', 'done_at', 'TEXT'],
  ['todo_tasks', 'done_by', 'TEXT'],
  // The sub-steps under a task: JSON [{ text, done }], ticked off one by one.
  ['todo_tasks', 'checklist', "TEXT NOT NULL DEFAULT '[]'"],
  // Added to a plan after it was filed (no re-approval), and by whom.
  ['todo_tasks', 'added_at', 'TEXT'],
  ['todo_tasks', 'added_by', 'TEXT'],
  // Carry-over: an unfinished task moves to the next working day's plan. The
  // copy remembers the day it was first planned; the original, where it went.
  ['todo_tasks', 'carried_from_date', 'TEXT'],
  ['todo_tasks', 'carried_from_task_id', 'TEXT'],
  ['todo_tasks', 'carried_to_date', 'TEXT'],
  // An action item made from an Advance Planner task: `source_type` is
  // 'advance_planner', `source_id` the planner task, and this the plan it sat
  // on, so a plan can list its items without walking task rows.
  ['action_items', 'source_plan_id', 'TEXT'],
  // A report about one project (the marketing reports) is only shown to the
  // people who can see that project.
  ['report_runs', 'project_id', 'TEXT'],
  // Leave is approved in two steps: the reporting manager verifies it, then
  // HR gives the final word. `stage` is whose desk it is on: manager | hr.
  ['leave_requests', 'stage', 'TEXT'],
  ['leave_requests', 'manager_id', 'TEXT'],
  ['leave_requests', 'manager_approved_by', 'TEXT'],
  ['leave_requests', 'manager_approved_at', 'TEXT'],
  ['leave_requests', 'manager_note', 'TEXT'],
  // Insertion order, for history read back in the order it happened. SQLite
  // gave this away as the hidden rowid; PostgreSQL has nothing equivalent.
  ['action_validations', 'seq', 'BIGSERIAL'],
  ['attendance_events', 'seq', 'BIGSERIAL'],
  // Department, for department-wide meeting invitations and reporting. Free
  // text HR maintains on the employee record; NULL = not set.
  ['users', 'department', 'TEXT'],
  // AI Meetings: the same meetings table as Meetings & MOM, extended for live
  // video meetings (kind = 'live'). Existing rows keep kind 'standard'.
  ['meetings', 'kind', "TEXT NOT NULL DEFAULT 'standard'"],
  ['meetings', 'description', 'TEXT'],
  ['meetings', 'department', 'TEXT'],
  ['meetings', 'host_id', 'TEXT'],
  ['meetings', 'room_name', 'TEXT'],          // LiveKit room; unique per meeting
  ['meetings', 'invite_token', 'TEXT'],       // the shareable link's secret part
  ['meetings', 'access', "TEXT NOT NULL DEFAULT 'invited'"], // invited | workspace (anyone in the workspace with the link)
  ['meetings', 'recording_allowed', 'INTEGER NOT NULL DEFAULT 0'],
  ['meetings', 'transcription_allowed', 'INTEGER NOT NULL DEFAULT 0'],
  ['meetings', 'started_at', 'TEXT'],
  ['meetings', 'ended_at', 'TEXT'],
  ['meetings', 'recurrence', 'TEXT'],         // daily | weekly | monthly; NULL = one-off
  ['meetings', 'recurrence_until', 'TEXT'],
  ['meetings', 'series_id', 'TEXT'],          // shared by every occurrence of a recurring meeting
  ['meetings', 'cancelled_at', 'TEXT'],
  ['meetings', 'cancel_reason', 'TEXT'],
  ['meetings', 'reminder_sent_at', 'TEXT'],
  ['meetings', 'ai_meeting_id', 'TEXT'],      // the AI Meeting Intelligence analysis of this meeting
  ['meetings', 'updated_by', 'TEXT'],
  ['meeting_attendees', 'response', "TEXT NOT NULL DEFAULT 'pending'"], // pending | accepted | declined
  ['meeting_attendees', 'responded_at', 'TEXT'],
  ['meeting_attendees', 'role', "TEXT NOT NULL DEFAULT 'participant'"], // host | participant
  ['meeting_attendees', 'invited_via', 'TEXT'],  // individual | department:<name> | link
  ['meeting_attendees', 'deleted_at', 'TEXT'],
  // Host controls: a locked meeting admits no new people (those in it stay);
  // a blocked attendee was removed by the host and cannot rejoin this meeting.
  ['meetings', 'locked', 'INTEGER NOT NULL DEFAULT 0'],
  ['meeting_attendees', 'blocked', 'INTEGER NOT NULL DEFAULT 0'],
  // Recording and transcription (Phase 5): what the host switched on, and when.
  ['meetings', 'capture_active', 'INTEGER NOT NULL DEFAULT 0'],
  ['meetings', 'capture_video', 'INTEGER NOT NULL DEFAULT 0'],
  ['meetings', 'capture_audio', 'INTEGER NOT NULL DEFAULT 0'],
  ['meetings', 'capture_started_at', 'TEXT'],
  ['meetings', 'captions_on', 'INTEGER NOT NULL DEFAULT 0'],
  // A part transcribed from one person's microphone already knows who spoke.
  ['ai_meeting_parts', 'speaker_label', 'TEXT'],
  ['ai_meeting_parts', 'speaker_user_id', 'TEXT'],
  // Which personal invitation a join request came from (routes/join.routes.js).
  ['join_requests', 'invite_id', 'TEXT'],
];


async function addIndexes() {
  for (const [table, column, sql] of ADDED_INDEXES) {
    if (tableExists(table) && hasColumn(table, column)) await execSql(sql);
  }
}

async function addColumns() {
  for (const [table, column, decl] of ADDED_COLUMNS) {
    if (!tableExists(table) || hasColumn(table, column)) continue;
    await execSql(`ALTER TABLE ${assertIdent(table, 'table')} ADD COLUMN IF NOT EXISTS ${assertIdent(column, 'column')} ${toPgDdl(decl)}`);
  }
}

/**
 * Data changes that must happen exactly once per database - not a schema
 * change, so they cannot be expressed as CREATE ... IF NOT EXISTS. Each key is
 * recorded when it runs, so a restart never repeats it.
 */
const ONE_TIME = [
  // The Tomorrow's To-Do module went live on 2026-10-06 after a day of trials.
  // Every plan filed during the trial is cleared so the module starts on real
  // plans only. Settings, reporting lines and the audit log are kept.
  ['2026-10-06-clear-todo-trial-data', async () => {
    if (!tableExists('todo_submissions')) return;
    await execSql(`
      DELETE FROM todo_comments;
      DELETE FROM todo_tasks;
      DELETE FROM todo_submissions;
      DELETE FROM notifications WHERE event_key LIKE 'todo.%';
    `);
  }],
];

async function runOneTime() {
  await execSql('CREATE TABLE IF NOT EXISTS one_time_migrations (key TEXT PRIMARY KEY, ran_at TEXT NOT NULL)');
  for (const [key, fn] of ONE_TIME) {
    if (await get('SELECT key FROM one_time_migrations WHERE key = ?', [key])) continue;
    await transaction(async () => {
      await fn();
      await run('INSERT INTO one_time_migrations (key, ran_at) VALUES (?, ?) ON CONFLICT (key) DO NOTHING',
        [key, new Date().toISOString()]);
    });
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: 'one-time migration ran', key }));
  }
}

async function backfill() {
  // Creator validation arrived after these tasks were already closed. They
  // were finished under the rules of the day, so they count as settled.
  if (tableExists('action_items') && hasColumn('action_items', 'validation_status')) {
    await execSql(`UPDATE action_items
                SET validation_status = 'validated',
                    validated_at = COALESCE(completed_at, updated_at)
              WHERE status = 'done' AND validation_status IS NULL`);
  }

  // Every task that predates same-day scheduling has a date and no time, which
  // has always meant "by the end of that day" - so that is the instant it gets.
  if (tableExists('action_items') && hasColumn('action_items', 'due_at')) await backfillDueAt();

  // Leave filed before the two-step approval: a request still waiting on a
  // reporting manager stays with them first; everything else is HR's.
  if (tableExists('leave_requests') && hasColumn('leave_requests', 'stage')) {
    await execSql(`UPDATE leave_requests
                SET stage = 'manager', manager_id = approver_id
              WHERE stage IS NULL AND status = 'pending' AND approver_id IN (
                SELECT id FROM users WHERE role NOT IN ('owner', 'hr', 'super_admin'))`);
    await execSql(`UPDATE leave_requests SET stage = 'hr' WHERE stage IS NULL`);
  }

  // Saturday is a working day: corrects the first cut's default once. Guarded
  // by a marker, because HR is then free to choose Saturday off deliberately.
  await once('week_off_saturday_is_working', async () => {
    await execSql(`UPDATE tenants SET week_off_days = '[0]' WHERE week_off_days = '[0,6]'`);
  });

  // Phoenixx's own office connections, entered once as starting data so HR
  // does not begin from an empty list.
  await once('approved_networks_phoenixx_seed', async () => {
    if (!tableExists('approved_networks')) return;
    const tenants = await all(
      `SELECT id FROM tenants WHERE LOWER(slug) LIKE 'phoenixx%' OR LOWER(name) LIKE 'phoenixx%'`,
    );
    const ts = new Date().toISOString();
    const seed = [
      ['Airtel office', 'Airtel_renn_1546-5G_EXT', '117.98.188.168', 'Airtel extender (5 GHz)'],
      ['Airtel office', 'Airtel_renn_1546-5G', '117.98.188.168', 'Airtel router (5 GHz)'],
      ['ACT office', 'ACTFIBERNET_5G', '49.206.113.67', 'ACT router (5 GHz)'],
      ['ACT office', 'ACTFIBERNET', '49.206.113.67', 'ACT router (2.4 GHz)'],
    ];
    for (const t of tenants) {
      if (await get('SELECT 1 FROM approved_networks WHERE tenant_id = ? LIMIT 1', [t.id])) continue;
      for (const [name, ssid, ip, desc] of seed) {
        await run(
          `INSERT INTO approved_networks (id, tenant_id, network_name, ssid, public_ip, description,
             created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
          [crypto.randomUUID(), t.id, name, ssid, ip, desc, ts, ts],
        );
      }
    }
  });

  // A workspace left with no weekly off at all goes back to Sunday.
  if (tableExists('tenants') && hasColumn('tenants', 'week_off_days')) {
    await execSql(`UPDATE tenants SET week_off_days = '[0]'
              WHERE week_off_days IS NULL OR TRIM(week_off_days) IN ('', '[]')`);
  }

  if (tableExists('project_owners')) await backfillProjectOwners();
}

/**
 * Every project answers to at least one owner. Projects that predate owners -
 * or were written straight into the table, as the seed does - get their
 * project manager when that person is a workspace Owner or Manager, and the
 * workspace Owner(s) otherwise.
 */
export async function backfillProjectOwners() {
  const orphans = await all(
    `SELECT p.id, p.tenant_id, p.manager_id FROM projects p
      WHERE p.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM project_owners po WHERE po.project_id = p.id)`,
  );
  if (!orphans.length) return;

  const at = new Date().toISOString();
  const byTenant = new Map();
  for (const p of orphans) {
    if (!byTenant.has(p.tenant_id)) {
      byTenant.set(p.tenant_id, await all(
        `SELECT id, role FROM users WHERE tenant_id = ? AND deleted_at IS NULL
            AND status != 'disabled' AND role IN ('owner','manager')`,
        [p.tenant_id],
      ));
    }
    const people = byTenant.get(p.tenant_id);
    const manager = people.find((u) => u.id === p.manager_id);
    const owners = manager ? [manager] : people.filter((u) => u.role === 'owner');
    for (const u of owners) {
      await run(
        'INSERT INTO project_owners (id, tenant_id, project_id, user_id, created_at) VALUES (?,?,?,?,?)',
        [crypto.randomUUID(), p.tenant_id, p.id, u.id, at],
      );
    }
  }
}

/** Runs `fn` the first time this database sees `key`, and never again. */
async function once(key, fn) {
  if (!tableExists('schema_meta')) return;
  if (await get('SELECT key FROM schema_meta WHERE key = ?', [key])) return;
  await fn();
  await run('INSERT INTO schema_meta (key, value, applied_at) VALUES (?,?,?) ON CONFLICT DO NOTHING',
    [key, 'applied', new Date().toISOString()]);
}

async function backfillDueAt() {
  const stale = await all(
    `SELECT a.id, a.due_date, a.due_time, COALESCE(t.timezone, ?) AS tz
       FROM action_items a LEFT JOIN tenants t ON t.id = a.tenant_id
      WHERE a.due_date IS NOT NULL AND a.due_date != '' AND a.due_at IS NULL`,
    [DEFAULT_TZ],
  );
  for (const row of stale) {
    const at = dueAtIso(row.due_date, row.due_time, row.tz);
    if (at) await run('UPDATE action_items SET due_at = ? WHERE id = ?', [at, row.id]);
  }
}

// -------------------------------------------------------------- query helpers
export const all = async (sql, params = []) => (await query(sql, params)).rows;
export const get = async (sql, params = []) => (await query(sql, params)).rows[0];
/** `changes` mirrors what node:sqlite returned, so callers testing it still work. */
export const run = async (sql, params = []) => {
  const r = await query(sql, params);
  return { changes: r.rowCount };
};
export const pluck = async (sql, params = []) => {
  const row = await get(sql, params);
  return row ? Object.values(row)[0] : undefined;
};
/** Several statements, no parameters. */
export const exec = (sql) => execSql(sql);

/**
 * Runs `fn` in a transaction. Every query beneath it - however deep - uses the
 * transaction's connection (see driver.js). Commits when `fn` resolves, rolls
 * back if it throws.
 */
export function tx(fn) {
  return transaction(fn);
}

// ------------------------------------------------------ tenant-scoped repository
// Defence in depth (AR1): callers never hand-write `tenant_id = ?`; the repo
// injects it. In the PostgreSQL target this layer is backed by RLS policies too.
const IDENT = /^[a-z_][a-z0-9_]*$/i;
const assertIdent = (s, what) => {
  if (!IDENT.test(s)) throw new Error(`unsafe ${what}: ${s}`);
  return s;
};

export function repo(table, tenantId) {
  assertIdent(table, 'table');
  if (!tenantId) throw new Error(`repo(${table}) requires a tenantId`);

  const softDeletable = hasColumn(table, 'deleted_at');
  const alive = softDeletable ? ' AND deleted_at IS NULL' : '';

  return {
    table,
    tenantId,
    findById(id, { withDeleted = false } = {}) {
      return get(
        `SELECT * FROM ${table} WHERE id = ? AND tenant_id = ?${withDeleted ? '' : alive}`,
        [id, tenantId],
      );
    },
    findAll({ where = '', params = [], order = '', limit, offset, withDeleted = false } = {}) {
      let sql = `SELECT * FROM ${table} WHERE tenant_id = ?${withDeleted ? '' : alive}`;
      if (where) sql += ` AND (${where})`;
      if (order) sql += ` ORDER BY ${order}`;
      if (limit != null) sql += ` LIMIT ${Number(limit)}`;
      if (offset) sql += ` OFFSET ${Number(offset)}`;
      return all(sql, [tenantId, ...params]);
    },
    async count({ where = '', params = [], withDeleted = false } = {}) {
      let sql = `SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?${withDeleted ? '' : alive}`;
      if (where) sql += ` AND (${where})`;
      return Number((await pluck(sql, [tenantId, ...params])) || 0);
    },
    async insert(data) {
      const row = { ...data, tenant_id: tenantId };
      const cols = Object.keys(row).map((c) => assertIdent(c, 'column'));
      await run(
        `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
        cols.map((c) => row[c]),
      );
      return this.findById(row.id, { withDeleted: true });
    },
    async update(id, data) {
      const cols = Object.keys(data).map((c) => assertIdent(c, 'column'));
      if (!cols.length) return this.findById(id);
      await run(
        `UPDATE ${table} SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND tenant_id = ?`,
        [...cols.map((c) => data[c]), id, tenantId],
      );
      return this.findById(id, { withDeleted: true });
    },
    async softDelete(id, at) {
      if (!softDeletable) return this.hardDelete(id);
      await run(`UPDATE ${table} SET deleted_at = ? WHERE id = ? AND tenant_id = ?`, [at, id, tenantId]);
      return true;
    },
    async hardDelete(id) {
      await run(`DELETE FROM ${table} WHERE id = ? AND tenant_id = ?`, [id, tenantId]);
      return true;
    },
  };
}

/**
 * Table -> columns, read once from the catalogue when the database is opened
 * and again after each migration. Kept synchronous because `repo()` and the
 * migration guards ask it on every call; the schema only changes in migrate().
 */
const columnCache = new Map();

export async function loadColumns() {
  const rows = await all(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = current_schema()`,
  );
  columnCache.clear();
  for (const r of rows) {
    if (!columnCache.has(r.table_name)) columnCache.set(r.table_name, new Set());
    columnCache.get(r.table_name).add(r.column_name);
  }
}

export function hasColumn(table, column) {
  assertIdent(table, 'table');
  return columnCache.get(table)?.has(column) ?? false;
}

export function tableExists(table) {
  return columnCache.has(table);
}
