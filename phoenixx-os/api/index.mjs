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

/** Connection strings and anything that looks like a password never leave the server. */
function redact(s) {
  return String(s || '')
    .replace(/postgres(ql)?:\/\/[^\s"']+/gi, 'postgres://***')
    .replace(/(password|secret|token|key)=[^\s&"']+/gi, '$1=***')
    .slice(0, 300);
}

/**
 * What the sign-in page shows when the API cannot start. Configuration
 * problems get a plain instruction; anything else gets the error code and a
 * redacted message, so it can be fixed without access to the function logs.
 */
function publicReason(err) {
  const msg = String(err?.message || '');
  const code = err?.code ? ` [${err.code}]` : '';
  if (/^Refusing to start:|DATABASE_URL is not set/.test(msg)) return msg;
  if (/password authentication failed/i.test(msg)) {
    return 'The database rejected the username or password in DATABASE_URL.';
  }
  if (/ECONNREFUSED|ENOTFOUND|getaddrinfo|ETIMEDOUT|timeout/i.test(msg + code)) {
    return `Cannot reach the database. Check the host in DATABASE_URL.${code}`;
  }
  return `The service could not start: ${redact(msg)}${code}`;
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
