/**
 * Builds the web app for the device and stages it as the Capacitor web root.
 *
 * This is the whole reason the mobile project holds no React source: the app
 * shipped to the store is the same bundle the browser gets, built from
 * ../phoenixx-os/web with one thing changed — VITE_API_URL, which points the
 * client at an absolute API origin because a relative path on a device resolves
 * to the device.
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const WEB = resolve(ROOT, '../phoenixx-os/web');
const WWW = join(ROOT, 'www');

/** Minimal .env reader — enough for KEY=value, quotes and # comments. */
function readEnvFile(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

if (!existsSync(join(WEB, 'package.json'))) {
  console.error(`\n  Cannot find the web app at ${WEB}`);
  console.error('  This project builds phoenixx-os/web — keep the two folders side by side.\n');
  process.exit(1);
}

// A real environment variable wins over .env, so CI can inject the URL.
const env = { ...readEnvFile(join(ROOT, '.env')), ...process.env };
const apiUrl = (env.VITE_API_URL || '').replace(/\/+$/, '');

if (!apiUrl) {
  console.error('\n  VITE_API_URL is not set.');
  console.error('  Copy .env.example to .env and put your API origin in it.');
  console.error('  Without it the app builds, installs, and fails every request.\n');
  process.exit(1);
}
if (!/^https?:\/\//.test(apiUrl)) {
  console.error(`\n  VITE_API_URL must be absolute, got: ${apiUrl}\n`);
  process.exit(1);
}
if (apiUrl.includes('/api/v1')) {
  console.error(`\n  VITE_API_URL must be the origin only — drop the /api/v1, it is added for you.`);
  console.error(`  Got: ${apiUrl}\n`);
  process.exit(1);
}
if (apiUrl.startsWith('http://')) {
  console.warn(`\n  WARNING: ${apiUrl} is plain http.`);
  console.warn('  Android and iOS block cleartext traffic in release builds — see README.\n');
}

console.log(`\n  Building phoenixx-os/web against ${apiUrl}\n`);

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
execSync(`${npm} run build`, {
  cwd: WEB,
  stdio: 'inherit',
  env: { ...process.env, VITE_API_URL: apiUrl },
});

// Replaced wholesale rather than merged, so a file deleted from the web app
// cannot survive in an old bundle and get shipped.
rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });
cpSync(join(WEB, 'dist'), WWW, { recursive: true });

console.log(`\n  Staged the bundle in www/ — run "npx cap sync" to push it into android/ and ios/.\n`);
