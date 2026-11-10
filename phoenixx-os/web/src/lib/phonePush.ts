/**
 * Phone notifications in the Android app (Firebase Cloud Messaging).
 *
 * After sign-in the app asks for permission once, registers with Firebase, and
 * hands the device token to the server, which then sends every notification
 * that would pop up in a browser to this phone as well. Signing out removes the
 * token, so a shared phone never shows the previous person's notifications.
 *
 * A tap on a notification opens the page it is about - also when the tap is
 * what launched the app, which is why the link is parked until the router
 * picks it up (usePhonePushLinks).
 *
 * Inert on the web, and inert in an app built without google-services.json:
 * there the Firebase plugin would crash on register, so the build records
 * whether the file was present (__FCM_READY__, vite.config.ts).
 */
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Capacitor } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { api } from './api';
import { API_BASE } from './config';
import { store } from './storage';

const TOKEN_KEY = 'phoenixx.fcmToken';
const OPEN_EVENT = 'phoenixx:open-link';
let pendingLink: string | null = null;
let listening = false;

export const phonePushAvailable = () => Capacitor.isNativePlatform() && __FCM_READY__;

/** Listeners go on at app start, before sign-in, so a tap that launched the app is not missed. */
export async function listenForPhonePush(): Promise<void> {
  if (!phonePushAvailable() || listening) return;
  listening = true;
  await PushNotifications.addListener('registration', ({ value }) => {
    store.set(TOKEN_KEY, value);
    api.post('/notifications/push/device', { token: value, platform: Capacitor.getPlatform() }).catch(() => {});
  });
  await PushNotifications.addListener('registrationError', (e) => console.warn('Phone notifications unavailable:', e.error));
  // A notification arriving while the app is open: the bell refreshes itself.
  await PushNotifications.addListener('pushNotificationReceived', () => window.dispatchEvent(new Event('phoenixx:notification')));
  await PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
    const link = String(notification.data?.link || '');
    if (!link.startsWith('/')) return; // only pages inside the app
    pendingLink = link;
    window.dispatchEvent(new Event(OPEN_EVENT));
  });
  if (Capacitor.getPlatform() === 'android') {
    // The server sends to this channel. High importance: sound and a heads-up banner.
    await PushNotifications.createChannel({
      id: 'general', name: 'Notifications', description: 'Tasks, approvals, meetings and chat',
      importance: 4, visibility: 1, vibration: true,
    }).catch(() => {});
  }
}

/** After sign-in, and on every launch while signed in. Asks for permission the first time only. */
export async function syncPhonePush(): Promise<void> {
  if (!phonePushAvailable()) return;
  try {
    await listenForPhonePush();
    let perm = await PushNotifications.checkPermissions();
    if (perm.receive === 'prompt' || perm.receive === 'prompt-with-rationale') perm = await PushNotifications.requestPermissions();
    if (perm.receive !== 'granted') return;
    await PushNotifications.register(); // the token arrives on the 'registration' listener
  } catch (e) {
    console.warn('Phone notifications could not start:', e);
  }
}

/** Signing out: this phone stops receiving the person's notifications. */
export async function forgetPhonePush(accessToken: string | null): Promise<void> {
  if (!phonePushAvailable()) return;
  const token = store.get(TOKEN_KEY);
  if (token && accessToken) {
    await fetch(`${API_BASE}/notifications/push/device/remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ token }),
    }).catch(() => {});
  }
  await PushNotifications.removeAllDeliveredNotifications().catch(() => {});
}

/** Inside the router: opens the page a tapped notification is about. */
export function usePhonePushLinks(): void {
  const navigate = useNavigate();
  const qc = useQueryClient();
  useEffect(() => {
    if (!phonePushAvailable()) return;
    const arrived = () => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['m', 'home'] });
    };
    window.addEventListener('phoenixx:notification', arrived);
    const open = () => {
      if (!pendingLink) return;
      const link = pendingLink;
      pendingLink = null;
      navigate(link);
    };
    open(); // a tap that launched the app
    window.addEventListener(OPEN_EVENT, open);
    return () => {
      window.removeEventListener(OPEN_EVENT, open);
      window.removeEventListener('phoenixx:notification', arrived);
    };
  }, [navigate, qc]);
}
