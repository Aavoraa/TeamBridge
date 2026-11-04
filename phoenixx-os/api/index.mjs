import { createApp } from '../server/src/app.js';

/**
 * Vercel serverless entry: every /api/* request is rewritten here (vercel.json)
 * and handed to the same Express app `npm start` runs.
 *
 * The app is built once per function instance and reused by every request it
 * serves. Building it opens the database connection and brings the schema up
 * to date - a single version check after the first deploy (see
 * migrateIfNeeded). If that fails, the next request tries again rather than
 * the instance staying broken.
 */
let appPromise;

function app() {
  if (!appPromise) {
    appPromise = createApp().catch((err) => {
      appPromise = undefined;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(req, res) {
  try {
    const instance = await app();
    return instance(req, res);
  } catch (err) {
    console.error('[startup]', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      error: { code: 'unavailable', message: 'The service is starting up or cannot reach its database. Try again shortly.' },
    }));
  }
}
