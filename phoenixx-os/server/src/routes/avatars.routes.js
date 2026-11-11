import { Router } from 'express';
import crypto from 'node:crypto';
import { z } from 'zod';
import { get, run } from '../db/index.js';
import { nowIso } from '../lib/util.js';
import { ok, validate, badRequest, notFound, audit } from '../lib/http.js';
import { saveFile, readFile } from '../services/storage.js';

/**
 * Profile photos. Anyone signed in sets their own; everyone in the workspace
 * sees it wherever that person appears (lists, chat, tasks, the team page).
 *
 * The picture is served without sign-in so a plain <img> tag can show it - in
 * the browser and in the phone app alike - but its address carries a random
 * part that only the workspace's own pages hand out, and a new upload gets a
 * new address. Stored with the app's other files (services/storage).
 */

const MAX_BYTES = 2 * 1024 * 1024;
const PREFIX = '/api/v1/avatars/';
const FILE_RE = /^[0-9a-f-]{36}-[0-9a-f]{16}\.(jpg|png|webp)$/;

/** Only real JPEG, PNG or WebP images, judged by their bytes, not by what the upload claims. */
function imageKind(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

/** The stored-file path behind one of our avatar URLs, or null for anything else. */
const storedPath = (url) => (typeof url === 'string' && url.startsWith(PREFIX) ? `avatars/${url.slice(PREFIX.length)}` : null);

async function forget(url) {
  const path = storedPath(url);
  if (path) await run('DELETE FROM stored_files WHERE path = ?', [path]);
}

// --------------------------------------------------------------- public
export const avatarPublicRouter = Router();

avatarPublicRouter.get('/:tenant/:file', async (req, res) => {
  const { tenant, file } = req.params;
  if (!/^[0-9a-f-]{36}$/.test(tenant) || !FILE_RE.test(file)) throw notFound('Photo');
  const stored = await readFile(`avatars/${tenant}/${file}`);
  if (!stored) throw notFound('Photo');
  res.setHeader('Content-Type', stored.mime);
  res.setHeader('Content-Length', stored.size);
  // The address changes with every upload, so the picture can be cached for good.
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  // The phone app shows it from its own origin.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.end(stored.data);
});

// ------------------------------------------------------- your own photo
export const avatarRouter = Router();

avatarRouter.post('/', async (req, res) => {
  const { image } = validate(z.object({ image: z.string().min(20).max(4_000_000) }), req.body);
  const b64 = image.replace(/^data:image\/[a-z+]+;base64,/i, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw badRequest('That file is not a picture');
  if (buf.length > MAX_BYTES) throw badRequest('Use a photo under 2 MB');
  const kind = imageKind(buf);
  if (!kind) throw badRequest('Use a JPG, PNG or WebP photo');

  const { tenantId, userId } = req.auth;
  const name = `${userId}-${crypto.randomBytes(8).toString('hex')}.${kind.ext}`;
  await saveFile(`avatars/${tenantId}/${name}`, buf, kind.mime);
  const before = await get('SELECT avatar_url FROM users WHERE id = ?', [userId]);
  const url = `${PREFIX}${tenantId}/${name}`;
  await run('UPDATE users SET avatar_url = ?, updated_at = ? WHERE id = ?', [url, nowIso(), userId]);
  await forget(before?.avatar_url);
  await audit(req, { entity: 'user', entityId: userId, action: 'update', after: { avatar: 'changed' } });
  return ok(res, { avatar_url: url });
});

avatarRouter.delete('/', async (req, res) => {
  const { userId } = req.auth;
  const before = await get('SELECT avatar_url FROM users WHERE id = ?', [userId]);
  await run('UPDATE users SET avatar_url = NULL, updated_at = ? WHERE id = ?', [nowIso(), userId]);
  await forget(before?.avatar_url);
  await audit(req, { entity: 'user', entityId: userId, action: 'update', after: { avatar: 'removed' } });
  return ok(res, { avatar_url: null });
});
