import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';

/**
 * The connection to PostgreSQL.
 *
 * Two backends behind one small interface, chosen by DATABASE_URL:
 *
 *   postgres://...  -> node-postgres pool. Production (Neon / Supabase on
 *                      Vercel) and anyone running a real server locally.
 *   anything else   -> PGlite: the real PostgreSQL engine compiled to WASM and
 *                      run in-process. Local development and the test suite
 *                      need no database server at all. `memory://` keeps it in
 *                      RAM (tests); a path keeps it on disk (dev).
 *
 * Both run the same SQL engine, so a query that works under one works under
 * the other; only the transport differs.
 *
 * The codebase writes SQLite-style `?` placeholders. They are rewritten to
 * PostgreSQL's `$1, $2 ...` here, once per distinct statement, so the ~1,500
 * call sites keep reading the way they always have.
 */

// ------------------------------------------------------------ SQL rewriting
const translated = new Map();

/**
 * `?` -> `$n`, and LIKE -> ILIKE (SQLite's LIKE is case-insensitive for ASCII,
 * PostgreSQL's is not, and every search box in the app relies on the former).
 * Quoted strings, quoted identifiers and comments are left untouched.
 */
export function toPg(sql) {
  const hit = translated.get(sql);
  if (hit !== undefined) return hit;

  let out = '';
  let n = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'" || c === '"') {
      // Copy a quoted run verbatim; a doubled quote is an escaped quote.
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === c) {
          if (sql[j + 1] === c) { j += 2; continue; }
          break;
        }
        j++;
      }
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === '-' && sql[i + 1] === '-') {
      const j = sql.indexOf('\n', i);
      const end = j === -1 ? sql.length : j;
      out += sql.slice(i, end);
      i = end;
    } else if (c === '?') {
      out += `$${++n}`;
      i++;
    } else if ((c === 'L' || c === 'l') && /^like\b/i.test(sql.slice(i, i + 5)) && !/[\w$]/.test(sql[i - 1] || '')) {
      out += 'ILIKE';
      i += 4;
    } else {
      out += c;
      i++;
    }
  }
  translated.set(sql, out);
  return out;
}

// --------------------------------------------------------------- backends
async function pgBackend(url) {
  const { default: pg } = await import('pg');
  // BIGINT and NUMERIC arrive as strings by default (they can exceed 2^53).
  // Money here is minor units well inside that range, and the code was written
  // against SQLite, which hands back plain numbers - so do the same.
  pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));
  pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
  // No column is BOOLEAN; a boolean only ever comes from an expression such as
  // `x IS NOT NULL AS covered`. SQLite answered those with 1 / 0 and the API -
  // and both apps reading it - still expects that.
  pg.types.setTypeParser(16, (v) => (v === null ? null : v === 't' ? 1 : 0));

  /**
   * TLS is decided here, not by the URL. node-postgres lets `sslmode=require`
   * in a connection string (Neon and Supabase both hand those out) override the
   * `ssl` option and turn it into full certificate verification, which
   * Supabase's pooler certificate fails. So the SSL parameters are taken off
   * the URL and the connection is always encrypted, except to a local server
   * or when the URL explicitly says sslmode=disable.
   */
  const parsed = new URL(url);
  const sslmode = parsed.searchParams.get('sslmode');
  for (const k of ['sslmode', 'ssl', 'sslrootcert', 'sslcert', 'sslkey', 'uselibpqcompat']) parsed.searchParams.delete(k);
  const local = ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname);
  const pool = new pg.Pool({
    connectionString: parsed.toString(),
    // Serverless: each function instance holds a handful at most; the
    // provider's pooled endpoint multiplexes them.
    max: Number(process.env.PG_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 15_000,
    ssl: local || sslmode === 'disable' ? false : { rejectUnauthorized: false },
  });
  pool.on('error', (err) => console.error('[pg pool]', err.message));
  // Optional: confine this process to one schema of a shared database (the
  // test suite runs each file in its own). Queued ahead of any other query.
  const schema = process.env.PG_SCHEMA;
  if (schema) {
    if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error(`invalid PG_SCHEMA: ${schema}`);
    pool.on('connect', (client) => {
      client.query(`CREATE SCHEMA IF NOT EXISTS ${schema}; SET search_path TO ${schema}`).catch(() => {});
    });
  }

  return {
    kind: 'pg',
    async query(text, params) {
      const r = await pool.query(text, params);
      return { rows: r.rows, rowCount: r.rowCount ?? 0 };
    },
    async exec(text) {
      await pool.query(text);
    },
    async connect() {
      const client = await pool.connect();
      return {
        async query(text, params) {
          const r = await client.query(text, params);
          return { rows: r.rows, rowCount: r.rowCount ?? 0 };
        },
        async exec(text) { await client.query(text); },
        release: (err) => client.release(err),
      };
    },
    end: () => pool.end(),
  };
}

async function pgliteBackend(location) {
  const { PGlite } = await import('@electric-sql/pglite');
  if (location !== 'memory://') fs.mkdirSync(location, { recursive: true });
  const parsers = {
    20: (v) => (v === null ? null : Number(v)), // int8
    1700: (v) => (v === null ? null : Number(v)), // numeric
  };
  const db = await PGlite.create(location === 'memory://' ? undefined : location, { parsers });

  // PGlite is one session. A transaction owns it outright until it ends, so
  // every other query queues behind a simple lock.
  let tail = Promise.resolve();
  const lock = () => {
    let release;
    const held = new Promise((r) => { release = r; });
    const prev = tail;
    tail = prev.then(() => held);
    return prev.then(() => release);
  };
  const q = async (text, params) => {
    const r = await db.query(text, params);
    // Match node-postgres above: NUMERIC -> number, BOOLEAN -> 1 / 0. PGlite
    // applies no custom parser to either, so convert by column type here.
    const numeric = [];
    const bool = [];
    for (const f of r.fields || []) {
      if (f.dataTypeID === 1700) numeric.push(f.name);
      else if (f.dataTypeID === 16) bool.push(f.name);
    }
    if (numeric.length || bool.length) {
      for (const row of r.rows) {
        for (const k of numeric) if (row[k] != null) row[k] = Number(row[k]);
        for (const k of bool) if (row[k] != null) row[k] = row[k] ? 1 : 0;
      }
    }
    return { rows: r.rows, rowCount: r.affectedRows ?? r.rows.length };
  };

  return {
    kind: 'pglite',
    async query(text, params) {
      const release = await lock();
      try { return await q(text, params); } finally { release(); }
    },
    async exec(text) {
      const release = await lock();
      try { await db.exec(text); } finally { release(); }
    },
    async connect() {
      const release = await lock();
      return {
        query: q,
        exec: async (text) => { await db.exec(text); },
        release: () => release(),
      };
    },
    end: () => db.close(),
  };
}

// ------------------------------------------------------------- the handle
let backendPromise;

export function databaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || '';
}

/** Opens the connection on first use, so importing this module is free. */
export function backend() {
  if (!backendPromise) {
    const url = databaseUrl();
    // A serverless function has no disk worth keeping, so the in-process
    // fallback would silently lose every write. Say what is missing instead.
    if (process.env.VERCEL && !/^postgres(ql)?:\/\//.test(url)) {
      throw new Error('DATABASE_URL is not set: add your Neon / Supabase connection string in the Vercel project settings.');
    }
    backendPromise = /^postgres(ql)?:\/\//.test(url)
      ? pgBackend(url)
      : pgliteBackend(url || process.env.PGLITE_DIR || './data/pglite');
  }
  return backendPromise;
}

export async function closeBackend() {
  if (!backendPromise) return;
  const b = await backendPromise;
  backendPromise = undefined;
  await b.end();
}

// ----------------------------------------------------------- transactions
/**
 * The open transaction, if any, for the current async call chain. Every query
 * issued anywhere beneath `tx(fn)` - however many service calls deep - lands on
 * the transaction's connection without anyone passing it along.
 */
const current = new AsyncLocalStorage();

export async function query(sql, params = []) {
  const text = toPg(sql);
  const ctx = current.getStore();
  try {
    if (ctx && !ctx.done) return await ctx.conn.query(text, params);
    const b = await backend();
    return await b.query(text, params);
  } catch (err) {
    // Name the statement in the log; the stack alone stops at the driver.
    if (err && typeof err === 'object' && !err.sql) {
      err.sql = text.replace(/\s+/g, ' ').slice(0, 300);
      if (process.env.NODE_ENV !== 'production' || process.env.LOG_SQL_ERRORS) {
        console.error('[sql]', err.message, '::', err.sql);
      }
    }
    throw err;
  }
}

/** Runs several statements with no parameters (DDL, migrations). */
export async function execSql(sql) {
  const ctx = current.getStore();
  if (ctx && !ctx.done) return ctx.conn.exec(sql);
  const b = await backend();
  return b.exec(sql);
}

export async function transaction(fn) {
  const outer = current.getStore();
  // Already inside one: join it. SQLite refused nested BEGINs outright, so no
  // caller relies on an inner rollback being independent.
  if (outer && !outer.done) return fn();

  const b = await backend();
  const conn = await b.connect();
  const ctx = { conn, done: false };
  let failed;
  try {
    await conn.exec('BEGIN');
    const out = await current.run(ctx, fn);
    await conn.exec('COMMIT');
    return out;
  } catch (err) {
    failed = err;
    try { await conn.exec('ROLLBACK'); } catch { /* connection already gone */ }
    throw err;
  } finally {
    // Anything the transaction started but did not await (a notification sent
    // in the background, say) falls back to the pool instead of a released
    // connection.
    ctx.done = true;
    conn.release(failed && /terminat|connection/i.test(String(failed.message)) ? failed : undefined);
  }
}
