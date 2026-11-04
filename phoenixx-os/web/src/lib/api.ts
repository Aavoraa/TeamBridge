/**
 * Thin client over the versioned REST API. The web app holds no business
 * logic — it reads and writes exactly what the API exposes, which is the same
 * contract the mobile app consumes.
 */

import { API_BASE } from './config';
import { store } from './storage';
import { saveAndOpen } from './nativeFiles';

const BASE = API_BASE;

const ACCESS_KEY = 'phoenixx.access';
const REFRESH_KEY = 'phoenixx.refresh';

export const tokens = {
  get access() { return store.get(ACCESS_KEY); },
  get refresh() { return store.get(REFRESH_KEY); },
  set(access: string, refresh?: string) {
    store.set(ACCESS_KEY, access);
    if (refresh) store.set(REFRESH_KEY, refresh);
  },
  clear() {
    store.remove(ACCESS_KEY);
    store.remove(REFRESH_KEY);
  },
};

export class ApiError extends Error {
  status: number;
  code: string;
  details?: { field: string; message: string }[];

  constructor(status: number, code: string, message: string, details?: any) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level messages keyed by field name, for inline form errors. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries((this.details || []).map((d) => [d.field, d.message]));
  }
}

let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!tokens.refresh) return false;
  // Concurrent 401s share one refresh rather than racing each other.
  refreshing ||= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: tokens.refresh }),
      });
      if (!res.ok) return false;
      const json = await res.json();
      tokens.set(json.data.access_token, json.data.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

type Options = RequestInit & { params?: Record<string, any>; raw?: boolean; idempotencyKey?: string };

export async function request<T = any>(path: string, options: Options = {}): Promise<T> {
  const { params, raw, idempotencyKey, ...init } = options;

  let url = `${BASE}${path}`;
  if (params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `${url.includes('?') ? '&' : '?'}${s}`;
  }

  const send = async (): Promise<Response> => fetch(url, {
    ...init,
    headers: {
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(tokens.access ? { Authorization: `Bearer ${tokens.access}` } : {}),
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
      ...init.headers,
    },
  });

  let res = await send();

  if (res.status === 401 && tokens.refresh) {
    const ok = await refreshSession();
    if (ok) res = await send();
    else {
      tokens.clear();
      window.dispatchEvent(new CustomEvent('phoenixx:signed-out'));
    }
  }

  if (raw) return res as T;

  if (!res.ok) {
    let body: any = {};
    try { body = await res.json(); } catch { /* non-JSON error body */ }
    throw new ApiError(
      res.status,
      body?.error?.code || 'error',
      body?.error?.message || res.statusText || 'Request failed',
      body?.error?.details,
    );
  }

  if (res.status === 204) return undefined as T;
  const json = await res.json();
  return json;
}

/** Unwraps the `data` envelope for the common case. */
export const api = {
  get: <T = any>(path: string, params?: Record<string, any>) =>
    request<{ data: T; meta?: any }>(path, { params }),
  post: <T = any>(path: string, body?: any, opts: Options = {}) =>
    request<{ data: T }>(path, { method: 'POST', body: body ? JSON.stringify(body) : undefined, ...opts }),
  patch: <T = any>(path: string, body?: any, opts: Options = {}) =>
    request<{ data: T }>(path, { method: 'PATCH', body: body ? JSON.stringify(body) : undefined, ...opts }),
  put: <T = any>(path: string, body?: any, opts: Options = {}) =>
    request<{ data: T }>(path, { method: 'PUT', body: body ? JSON.stringify(body) : undefined, ...opts }),
  del: <T = any>(path: string, opts: Options = {}) =>
    request<{ data: T }>(path, { method: 'DELETE', ...opts }),

  /** Triggers a browser download for CSV/PDF endpoints; the share sheet on a device. */
  async download(path: string, filename: string, params?: Record<string, any>) {
    const res = await request<Response>(path, { params, raw: true });
    if (!res.ok) throw new ApiError(res.status, 'download_failed', 'Could not download that file');
    const blob = await res.blob();
    if (await saveAndOpen(blob, filename)) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  },

  /** Opens a PDF endpoint in a new tab with the auth header applied. */
  async openPdf(path: string) {
    const res = await request<Response>(path, { raw: true });
    if (!res.ok) throw new ApiError(res.status, 'pdf_failed', 'Could not open that document');
    const blob = await res.blob();
    // A WebView has no tabs, so the file goes to the system viewer instead.
    if (await saveAndOpen(blob, `${path.split('/').filter(Boolean).join('-') || 'document'}.pdf`)) return;
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  },
};
