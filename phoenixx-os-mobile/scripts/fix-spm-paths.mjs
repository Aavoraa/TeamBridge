/**
 * Repairs the iOS Package.swift after a sync run on Windows.
 *
 * `cap sync` writes local plugin paths using the host's path separator, so on
 * Windows the generated file contains backslash paths like
 * `..\..\..\node_modules\@capacitor\app` instead of forward slashes.
 *
 * Swift Package Manager only understands forward slashes, and worse, Swift
 * parses those backslashes as escape sequences — the `\n` in `\node_modules`
 * becomes a literal newline. The file is corrupt, not merely non-portable, and
 * the failure only surfaces later on a Mac or a CI runner, where the cause is
 * far from obvious.
 *
 * Running `cap sync` on macOS produces correct paths, so this is a no-op there.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../ios/App/CapApp-SPM/Package.swift',
);

if (!existsSync(FILE)) process.exit(0); // the iOS platform was never added

const BACKSLASH = String.fromCharCode(92);
const before = readFileSync(FILE, 'utf8');

// Rewrites only inside `path: "..."` literals, so nothing else in the file is
// touched — the Capacitor header warns that it is machine-managed.
const after = before.replace(
  /(path:\s*")([^"]*)(")/g,
  (_match, open, path, close) => `${open}${path.split(BACKSLASH).join('/')}${close}`,
);

if (after === before) process.exit(0);

writeFileSync(FILE, after);
console.log('  fixed Windows path separators in ios/App/CapApp-SPM/Package.swift');
