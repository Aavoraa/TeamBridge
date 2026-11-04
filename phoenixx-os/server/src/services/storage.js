import { get, run } from '../db/index.js';
import { nowIso } from '../lib/util.js';

/**
 * File storage: generated PDFs and uploaded attachments, kept in PostgreSQL
 * (`stored_files`). A serverless function has no disk that survives the
 * request, and keeping files beside the rows that reference them means one
 * thing to back up and nothing else to configure.
 *
 * Paths are the same relative keys the app always used (`documents/x.pdf`,
 * `attachments/<tenant>/<id>-name`), so existing `pdf_path` / `storage_path`
 * values and `/api/v1/files/...` URLs keep their meaning. Who may read a file
 * is still decided by the route serving it, never here.
 */

const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', txt: 'text/plain', csv: 'text/csv' };
export const mimeFor = (p) => MIME[String(p).split('.').pop().toLowerCase()] || 'application/octet-stream';

export async function saveFile(path, buffer, mime = mimeFor(path)) {
  await run(
    `INSERT INTO stored_files (path, mime, size_bytes, data, created_at) VALUES (?,?,?,?,?)
     ON CONFLICT (path) DO UPDATE SET mime = excluded.mime, size_bytes = excluded.size_bytes,
       data = excluded.data, created_at = excluded.created_at`,
    [path, mime, buffer.length, buffer, nowIso()],
  );
  return path;
}

/** The file, or undefined. `data` is a Buffer. */
export async function readFile(path) {
  const row = await get('SELECT mime, size_bytes, data FROM stored_files WHERE path = ?', [path]);
  if (!row) return undefined;
  return { mime: row.mime || mimeFor(path), size: Number(row.size_bytes), data: Buffer.from(row.data) };
}

/** Sends a stored file as the response, or 404s through the caller's handler. */
export async function sendStoredFile(res, path, { filename, disposition = 'inline' } = {}) {
  const file = await readFile(path);
  if (!file) return false;
  res.setHeader('Content-Type', file.mime);
  res.setHeader('Content-Length', file.size);
  if (filename) res.setHeader('Content-Disposition', `${disposition}; filename="${filename}"`);
  res.end(file.data);
  return true;
}
