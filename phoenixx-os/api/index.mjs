/**
 * Vercel serverless entry: every /api/* request is rewritten here (vercel.json)
 * and handed to the same Express app `npm start` runs.
 *
 * The app is built once per function instance and reused by every request it
 * serves. Building it loads the configuration, opens the database connection
 * and brings the schema up to date - a single version check after the first
 * deploy (see migrateIfNeeded). If that fails, the next request tries again
 * rather than the instance staying broken.
 *
 * The app is imported here, not at the top of the file, so a configuration
 * problem (a missing secret, no DATABASE_URL) comes back as a readable JSON
 * error the sign-in page can show, instead of Vercel's blank 500.
 */
let appPromise;

function app() {
  if (!appPromise) {
    appPromise = import('../server/src/app.js')
      .then(({ createApp }) => createApp())
      .catch((err) => {
        appPromise = undefined;
        throw err;
      });
  }
  return appPromise;
}

/**
 * Only messages written for the operator are passed to the browser: they name
 * a missing setting, never its value. Anything else stays in the function log.
 */
function publicReason(err) {
  const msg = String(err?.message || '');
  if (/^Refusing to start:|DATABASE_URL/.test(msg)) return msg;
  if (/ECONNREFUSED|ENOTFOUND|password authentication failed|getaddrinfo|timeout|SSL/i.test(msg)) {
    return 'Cannot connect to the database. Check DATABASE_URL in the Vercel project settings.';
  }
  return 'The service could not start. See the function logs in Vercel for details.';
}

export default async function handler(req, res) {
  let instance;
  try {
    instance = await app();
  } catch (err) {
    console.error('[startup]', err);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { code: 'startup_failed', message: publicReason(err) } }));
    return;
  }
  return instance(req, res);
}
