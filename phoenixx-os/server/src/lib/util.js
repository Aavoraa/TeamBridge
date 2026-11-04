import crypto from 'node:crypto';

// ------------------------------------------------------------------------ ids
export const uuid = () => crypto.randomUUID();
export const token = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ------------------------------------------------------------------ timestamps
/** All persisted timestamps are UTC ISO-8601 (AR6). */
export const nowIso = () => new Date().toISOString();
export const todayIso = (d = new Date()) => d.toISOString().slice(0, 10);
export const monthIso = (d = new Date()) => d.toISOString().slice(0, 7);

export const addDays = (dateish, days) => {
  const d = new Date(dateish);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};
export const addMonths = (dateish, months) => {
  const d = new Date(dateish);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
};
export const daysBetween = (a, b) =>
  Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
export const startOfMonth = (m) => `${m}-01T00:00:00.000Z`;
export const endOfMonth = (m) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo, 0, 23, 59, 59, 999)).toISOString();
};
export const monthsBack = (n, from = new Date()) => {
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(monthIso(addMonths(from, -i)));
  return out;
};

/** Indian financial year label for a date: 2026-05-01 -> "2026-27" (fyStart=4). */
export function financialYear(dateish, fyStartMonth = 4) {
  const d = new Date(dateish);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const startYear = m >= fyStartMonth ? y : y - 1;
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

// ---------------------------------------------------------------------- money
/** Money is stored as integer minor units + a currency code (AR6). */
export const toMinor = (major) => Math.round(Number(major || 0) * 100);
export const toMajor = (minor) => Number(minor || 0) / 100;

/** Indian grouping (lakh/crore) vs international, per tenant number_format. */
export function formatMoney(minor, currency = 'INR', format = 'indian') {
  const locale = format === 'indian' ? 'en-IN' : 'en-US';
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(toMajor(minor));
}

// ---------------------------------------------------------------------- misc
export const slugify = (s) =>
  String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

export const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export const round1 = (n) => Math.round(Number(n || 0) * 10) / 10;
export const pct = (num, den) => (den ? round1((num / den) * 100) : 0);

export const parseJson = (s, fallback) => {
  if (s == null) return fallback;
  if (typeof s === 'object') return s;
  try { return JSON.parse(s); } catch { return fallback; }
};

export const unique = (arr) => [...new Set(arr)];
export const groupBy = (arr, keyFn) =>
  arr.reduce((acc, x) => {
    const k = keyFn(x);
    (acc[k] ||= []).push(x);
    return acc;
  }, {});
export const sum = (arr, f = (x) => x) => arr.reduce((a, x) => a + (Number(f(x)) || 0), 0);

/** Tiny mustache-style renderer for notification templates (B5). */
export function renderTemplate(tpl, vars = {}) {
  return String(tpl).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const val = key.split('.').reduce((o, k) => (o == null ? o : o[k]), vars);
    return val == null ? '' : String(val);
  });
}

// ------------------------------------------------------------------------ csv
export function toCsv(rows, columns) {
  if (!rows.length && !columns) return '';
  const cols = columns || Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => esc(r[c])).join(','))].join('\n');
}

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  const src = text.replace(/\r\n?/g, '\n');
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows.shift().map((h) => h.trim());
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

// ------------------------------------------------- async array helpers
// Array.prototype.forEach / filter / every do not wait for an async callback.
// These do, one element at a time, in order - the same order the synchronous
// originals ran in, which matters when each step writes to the database.
export async function forEachSeq(arr, fn) {
  let i = 0;
  for (const x of arr) await fn(x, i++, arr);
}
export async function filterSeq(arr, fn) {
  const out = [];
  let i = 0;
  for (const x of arr) if (await fn(x, i++, arr)) out.push(x);
  return out;
}
export async function everySeq(arr, fn) {
  let i = 0;
  for (const x of arr) if (!(await fn(x, i++, arr))) return false;
  return true;
}
