import { createApp } from './app.js';
import { config } from './config.js';
import { get, init, closeBackend } from './db/index.js';
import { startJobRunner, stopJobRunner } from './services/jobs.js';
import { nowIso } from './lib/util.js';

/**
 * Long-running server: `npm start` locally, or the Docker image on a VPS.
 * On Vercel the same app runs as a serverless function instead - see
 * ../../api/index.js - and background jobs come in through /api/v1/cron/tick.
 */

await init();

/**
 * SEED_ON_BOOT fills an empty database with the demo workspace, so a fresh
 * deployment is a working app rather than an empty login screen.
 */
if (config.seedOnBoot && !(await get('SELECT id FROM tenants LIMIT 1'))) {
  console.log(JSON.stringify({ t: nowIso(), msg: 'empty database, seeding the demo workspace' }));
  await import('./seed.js');
}

// Clients added to the register before delivery records existed would be
// missing from every project, proposal and invoice picker. Idempotent.
{
  const { backfillDeliveryRecords } = await import('./services/clientAccounts.js');
  const repaired = await backfillDeliveryRecords();
  if (repaired) {
    console.log(JSON.stringify({ t: nowIso(), msg: 'linked client accounts to delivery records', count: repaired }));
  }
}

const app = await createApp();

const server = app.listen(config.port, () => {
  console.log(JSON.stringify({
    t: nowIso(),
    msg: 'Phoenixx OS API listening',
    port: config.port,
    env: config.env,
    docs: `${config.apiBaseUrl}/api/v1/openapi.json`,
  }));
  startJobRunner();
});

let shuttingDown = false;
const shutdown = async (signal) => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(JSON.stringify({ t: nowIso(), msg: `received ${signal}, shutting down` }));
  stopJobRunner();
  server.close();
  try { await closeBackend(); } catch { /* already closed */ }
  process.exit(0);
};

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    setTimeout(() => process.exit(1), 10_000).unref();
    shutdown(signal);
  });
}

process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
});
