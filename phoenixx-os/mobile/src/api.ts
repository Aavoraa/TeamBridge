import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';

/**
 * The mobile client talks to exactly the same versioned API as the web app
 * (PRD 5.1). Nothing here computes business logic - it reads and writes what
 * the API exposes, and queues writes when the device is offline (AR5).
 */

const BASE = `${Constants.expoConfig?.extra?.apiBaseUrl || 'http://10.0.2.2:4010'}/api/v1`;

const ACCESS = 'phoenixx.access';
const REFRESH = 'phoenixx.refresh';
const QUEUE = 'phoenixx.outbox';
const LAST_SYNC = 'phoenixx.lastSync';

let accessToken: string | null = null;
let refreshToken: string | null = null;

export async function loadTokens() {
  const [[, a], [, r]] = await AsyncStorage.multiGet([ACCESS, REFRESH]);
  accessToken = a;
  refreshToken = r;
  return { accessToken, refreshToken };
}

export async function setTokens(access: string, refresh?: string) {
  accessToken = access;
  if (refresh) refreshToken = refresh;
  const pairs: [string, string][] = [[ACCESS, access]];
  if (refresh) pairs.push([REFRESH, refresh]);
  await AsyncStorage.multiSet(pairs);
}

export async function clearTokens() {
  accessToken = null;
  refreshToken = null;
  await AsyncStorage.multiRemove([ACCESS, REFRESH]);
}

export class ApiError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

let refreshing: Promise<boolean> | null = null;

async function refreshSession(): Promise<boolean> {
  if (!refreshToken) return false;
  refreshing ||= (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
      if (!res.ok) return false;
      const json = await res.json();
      await setTokens(json.data.access_token, json.data.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
      setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

type Options = { method?: string; body?: any; params?: Record<string, any>; retryOn401?: boolean };

export async function request<T = any>(path: string, opts: Options = {}): Promise<T> {
  const { method = 'GET', body, params, retryOn401 = true } = opts;

  let url = `${BASE}${path}`;
  if (params) {
    const qs = Object.entries(params)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    if (qs) url += `${url.includes('?') ? '&' : '?'}${qs}`;
  }

  const send = () => fetch(url, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let res = await send();

  if (res.status === 401 && retryOn401 && refreshToken) {
    if (await refreshSession()) res = await send();
  }

  if (!res.ok) {
    let payload: any = {};
    try { payload = await res.json(); } catch { /* non-JSON error */ }
    throw new ApiError(res.status, payload?.error?.code || 'error',
      payload?.error?.message || 'Something went wrong');
  }

  return res.status === 204 ? (undefined as T) : res.json();
}

export const api = {
  get: <T = any>(path: string, params?: Record<string, any>) =>
    request<{ data: T; meta?: any }>(path, { params }),
  post: <T = any>(path: string, body?: any) =>
    request<{ data: T }>(path, { method: 'POST', body }),
  patch: <T = any>(path: string, body?: any) =>
    request<{ data: T }>(path, { method: 'PATCH', body }),
};

/* ======================================================= OFFLINE OUTBOX */
/**
 * AR5 - writes made without a connection are queued locally and replayed on
 * reconnect. Each entry carries a device-generated id so a retried flush can
 * never apply the same action twice.
 */
export type QueuedOp = {
  client_id: string;
  type:
  | 'action_item.create' | 'action_item.update' | 'action_item.complete'
  | 'attendance.check_in' | 'attendance.check_out'
  | 'activity.log' | 'comment.create';
  payload: Record<string, any>;
  created_at: string;
};

const deviceId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export async function readQueue(): Promise<QueuedOp[]> {
  const raw = await AsyncStorage.getItem(QUEUE);
  return raw ? JSON.parse(raw) : [];
}

export async function enqueue(type: QueuedOp['type'], payload: Record<string, any>) {
  const queue = await readQueue();
  const op: QueuedOp = { client_id: deviceId(), type, payload, created_at: new Date().toISOString() };
  queue.push(op);
  await AsyncStorage.setItem(QUEUE, JSON.stringify(queue));
  return op;
}

/** Sends a write, falling back to the outbox if the device is offline. */
export async function writeOrQueue(
  type: QueuedOp['type'],
  payload: Record<string, any>,
  online: () => Promise<any>,
): Promise<{ queued: boolean; result?: any }> {
  try {
    const result = await online();
    return { queued: false, result };
  } catch (err: any) {
    // A validation or permission failure is a real answer, not a connectivity
    // problem - only network-level failures are worth queueing.
    if (err instanceof ApiError) throw err;
    await enqueue(type, payload);
    return { queued: true };
  }
}

export async function flushQueue(): Promise<{ applied: number; failed: number; conflicts: string[] } | null> {
  const queue = await readQueue();
  if (!queue.length) return null;

  const res = await api.post<any[]>('/sync/queue', { operations: queue });
  const results = res.data;

  const failed = results.filter((r) => r.status === 'failed');
  const conflicts = results
    .filter((r) => r.conflict)
    .map((r) => r.message as string);

  // Anything that failed for a non-transient reason is dropped rather than
  // retried forever; the user is told instead.
  await AsyncStorage.setItem(QUEUE, JSON.stringify([]));

  return {
    applied: results.filter((r) => r.status === 'applied').length,
    failed: failed.length,
    conflicts,
  };
}

export async function pullDelta() {
  const since = (await AsyncStorage.getItem(LAST_SYNC)) || '1970-01-01T00:00:00.000Z';
  const res = await api.get('/sync', { updated_since: since, limit: 300 });
  await AsyncStorage.setItem(LAST_SYNC, res.meta.synced_at);
  return res;
}

export const API_BASE = BASE;
