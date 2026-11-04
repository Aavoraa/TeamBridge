/**
 * Browser pop-ups (Web Push). The service worker in /sw.js shows them; this
 * file switches them on and off and keeps the server's record of "which
 * browser belongs to whom" in step with who is signed in.
 *
 * Not used in the native mobile app, which has no web push.
 */
import { api } from './api';
import { API_BASE } from './config';
import { isNative } from './storage';

export const pushSupported = () => !isNative
  && typeof window !== 'undefined'
  && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

export type PushState = {
  supported: boolean;
  configured: boolean;            // the server has keys
  permission: NotificationPermission | 'unsupported';
  subscribed: boolean;            // this browser is on for the signed-in person
};

/** Lets on-screen switches catch up with a change made in the background (e.g. at sign-in). */
export const PUSH_CHANGED = 'phoenixx:push-changed';
const announce = () => window.dispatchEvent(new Event(PUSH_CHANGED));

function keyBytes(base64url: string) {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function registration() {
  return (await navigator.serviceWorker.getRegistration('/')) || navigator.serviceWorker.register('/sw.js');
}

async function serverConfig() {
  const { data } = await api.get('/notifications/push/config');
  return data as { enabled: boolean; public_key: string | null };
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return { supported: false, configured: false, permission: 'unsupported', subscribed: false };
  const cfg = await serverConfig().catch(() => ({ enabled: false, public_key: null }));
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  return { supported: true, configured: cfg.enabled, permission: Notification.permission, subscribed: !!sub && Notification.permission === 'granted' };
}

/** Subscribe this browser (asking permission if needed) and tell the server it is the signed-in person's. */
export async function enablePush(): Promise<void> {
  if (!pushSupported()) throw new Error('This browser cannot show pop-ups.');
  const cfg = await serverConfig();
  if (!cfg.enabled || !cfg.public_key) throw new Error('Pop-ups are not set up on the server yet.');
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error('Chrome blocked pop-ups for this site. Click the icon left of the address bar → Notifications → Allow.');
  }
  const reg = await registration();
  await navigator.serviceWorker.ready;
  const key = keyBytes(cfg.public_key);
  let sub = await reg.pushManager.getSubscription();
  try {
    sub = sub || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch {
    // Subscribed earlier under different server keys: start over.
    await sub?.unsubscribe().catch(() => {});
    sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  }
  await api.post('/notifications/push/subscribe', sub.toJSON());
  announce();
}

/** Stop pop-ups in this browser for everyone. */
export async function disablePush(): Promise<void> {
  if (!pushSupported()) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await api.post('/notifications/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe().catch(() => {});
  announce();
}

/**
 * On every sign-in: if this browser already allows pop-ups, make sure the
 * server routes them to whoever just signed in. Silent - it never prompts.
 */
export async function syncPush(): Promise<void> {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  await enablePush().catch(() => {});
}

/**
 * On sign-out: this browser stops receiving the signed-out person's pop-ups.
 * Takes the access token captured at sign-out, because the stored one is
 * cleared before this finishes.
 */
export async function forgetPushForThisBrowser(accessToken: string | null): Promise<void> {
  if (!pushSupported() || !accessToken) return;
  const reg = await navigator.serviceWorker.getRegistration('/');
  const sub = reg ? await reg.pushManager.getSubscription() : null;
  if (!sub) return;
  await fetch(`${API_BASE}/notifications/push/unsubscribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ endpoint: sub.endpoint }),
  }).catch(() => {});
}
