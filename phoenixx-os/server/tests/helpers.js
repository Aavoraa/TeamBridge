import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Every test file runs in its own process (`node --test`), so each one can point
 * DB_FILE at a throwaway database before anything imports the db module. That
 * keeps tests hermetic and lets them run in any order.
 */
export function useTempDatabase() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phoenixx-test-'));
  // A fresh in-memory PostgreSQL (PGlite) per test process - or, with
  // TEST_DATABASE_URL set, a fresh schema per process on a real server.
  if (process.env.TEST_DATABASE_URL) {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
    process.env.PG_SCHEMA = `t_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
  } else {
    process.env.DATABASE_URL = 'memory://';
  }
  process.env.STORAGE_DIR = path.join(dir, 'storage');
  process.env.JOBS_ENABLED = 'false';
  process.env.JWT_ACCESS_SECRET = 'test-access-secret';
  process.env.JWT_REFRESH_SECRET = 'test-refresh-secret';
  process.env.NODE_ENV = 'test';
  // Tests never reach real outside services, whatever keys a developer has in
  // server/.env: blank them so dotenv (which never overrides a set variable)
  // leaves them out. A test that wants one sets it before calling this.
  for (const k of EXTERNAL_KEYS) if (process.env[k] === undefined) process.env[k] = '';
  return dir;
}

const EXTERNAL_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'TRANSCRIBE_PROVIDER',
  'LIVEKIT_URL', 'LIVEKIT_API_KEY', 'LIVEKIT_API_SECRET',
  'RECORDING_S3_BUCKET', 'RECORDING_S3_REGION', 'RECORDING_S3_ACCESS_KEY_ID', 'RECORDING_S3_SECRET_ACCESS_KEY', 'RECORDING_S3_ENDPOINT',
  'EMAIL_PROVIDER', 'SMTP_HOST', 'SMTP_USER', 'SMTP_PASS',
];

/** Minimal platform fixtures: one plan, so tenants can be provisioned. */
export async function seedPlan(db) {
  const { run, get } = db;
  if (await get('SELECT id FROM plans LIMIT 1')) return get('SELECT * FROM plans LIMIT 1');
  const id = crypto.randomUUID();
  await run(
    `INSERT INTO plans (id, code, name, band_min_users, band_max_users, price_monthly_minor,
       price_yearly_minor, addon_user_monthly_minor, features, limits, sort, created_at)
     VALUES (?, 'growth', 'Growth', 1, 30, 1399900, 13999000, 44900, ?, ?, 0, ?)`,
    [id, JSON.stringify({ custom_roles: true, client_portal: true, api_access: false }),
      JSON.stringify({ clients: 200, storage_mb: 20000, wa_credits: 5000 }),
      new Date().toISOString()],
  );
  return get('SELECT * FROM plans WHERE id = ?', [id]);
}

/** Boots the API on an ephemeral port and returns a small request helper. */
export async function startServer() {
  const { createApp } = await import('../src/app.js');
  const app = await createApp();

  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}/api/v1`;

  const request = async (method, path, { body, token, headers = {} } = {}) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = { raw: text }; }
    return { status: res.status, body: json, headers: res.headers };
  };

  return {
    base,
    close: () => new Promise((r) => server.close(r)),
    get: (p, o) => request('GET', p, o),
    post: (p, body, o) => request('POST', p, { body, ...o }),
    put: (p, body, o) => request('PUT', p, { body, ...o }),
    patch: (p, body, o) => request('PATCH', p, { body, ...o }),
    del: (p, o) => request('DELETE', p, o),
  };
}

/** Signs up a tenant through the public API and returns its session. */
export async function signUpTenant(api, overrides = {}) {
  const suffix = crypto.randomUUID().slice(0, 8);
  const res = await api.post('/auth/signup', {
    agency_name: `Test Agency ${suffix}`,
    owner_name: 'Test Owner',
    email: `owner-${suffix}@example.com`,
    password: 'Password@123',
    plan_code: 'growth',
    ...overrides,
  });
  if (res.status !== 201) throw new Error(`signup failed: ${JSON.stringify(res.body)}`);
  return res.body.data;
}

export const rupees = (n) => Math.round(n * 100);
