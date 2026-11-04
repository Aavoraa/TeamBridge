import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { useTempDatabase, seedPlan } from './helpers.js';

useTempDatabase();

const db = await import('../src/db/index.js');
await db.migrate();
await seedPlan(db);
const { provisionTenant } = await import('../src/services/provisioning.js');

const { tenantId, ownerId } = await provisionTenant({
  agencyName: 'Trial Agency', ownerName: 'Owner', ownerEmail: 'owner@trial.test', password: 'Password@123',
  planCode: 'growth',
});
const now = () => new Date().toISOString();
const count = async (sql, params = []) => Number((await db.get(sql, params)).n);

async function trialData() {
  const sub = crypto.randomUUID();
  await db.run(`INSERT INTO todo_submissions (id, tenant_id, user_id, todo_date, plan_date, status, created_at, updated_at)
          VALUES (?,?,?, '2026-10-07', '2026-10-06', 'SUBMITTED', ?, ?)`, [sub, tenantId, ownerId, now(), now()]);
  await db.run(`INSERT INTO todo_tasks (id, tenant_id, submission_id, task, created_at, updated_at) VALUES (?,?,?, 'trial task', ?, ?)`,
    [crypto.randomUUID(), tenantId, sub, now(), now()]);
  await db.run(`INSERT INTO todo_comments (id, tenant_id, submission_id, user_id, kind, body, created_at) VALUES (?,?,?,?, 'comment', 'hi', ?)`,
    [crypto.randomUUID(), tenantId, sub, ownerId, now()]);
  for (const key of ['todo.submitted', 'invoice.paid']) {
    await db.run(`INSERT INTO notifications (id, tenant_id, user_id, event_key, channel, title, status, created_at)
            VALUES (?,?,?,?, 'in_app', 't', 'sent', ?)`, [crypto.randomUUID(), tenantId, ownerId, key, now()]);
  }
  await db.run(`INSERT INTO audit_logs (id, tenant_id, actor_id, entity, entity_id, action, created_at)
          VALUES (?,?,?, 'todo_submission', ?, 'submit', ?)`, [crypto.randomUUID(), tenantId, ownerId, sub, now()]);
}

describe('clearing the To-Do trial data', () => {
  test('a database that has not had it yet loses its To-Do plans, and only those', async () => {
    // Stand in for the live database: trial data on file, clean-up not yet run.
    await db.run("DELETE FROM one_time_migrations WHERE key = '2026-10-06-clear-todo-trial-data'");
    await db.run("UPDATE tenants SET todo_settings = ? WHERE id = ?", [JSON.stringify({ enabled: true }), tenantId]);
    await trialData();

    await db.migrate();

    assert.equal(await count('SELECT COUNT(*) AS n FROM todo_submissions'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM todo_tasks'), 0);
    assert.equal(await count('SELECT COUNT(*) AS n FROM todo_comments'), 0);
    assert.equal(await count("SELECT COUNT(*) AS n FROM notifications WHERE event_key LIKE 'todo.%'"), 0);
    // Kept: other notifications, the settings, people and the audit trail.
    assert.equal(await count("SELECT COUNT(*) AS n FROM notifications WHERE event_key = 'invoice.paid'"), 1);
    assert.ok((await db.get('SELECT todo_settings FROM tenants WHERE id = ?', [tenantId])).todo_settings);
    assert.equal(await count('SELECT COUNT(*) AS n FROM users WHERE id = ?', [ownerId]), 1);
    assert.equal(await count("SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'todo_submission'"), 1);
  });

  test('it runs once: real plans filed afterwards survive every restart', async () => {
    await trialData();
    await db.migrate();
    await db.migrate();
    assert.equal(await count('SELECT COUNT(*) AS n FROM todo_submissions'), 1);
    assert.equal(await count('SELECT COUNT(*) AS n FROM todo_tasks'), 1);
  });
});
