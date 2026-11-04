/**
 * Key/value storage that survives the OS.
 *
 * The web app keeps tokens and the theme in `localStorage`. That is fine in a
 * browser, but inside a WebView the system can clear web storage whenever it
 * reclaims space — on a phone that shows up as the user being randomly signed
 * out. Capacitor's Preferences plugin writes to SharedPreferences (Android) and
 * UserDefaults (iOS) instead, which the OS does not evict.
 *
 * Preferences is async and the existing call sites (`tokens.access` and the
 * theme initialiser) are synchronous, so native reads are served from an
 * in-memory cache that `hydrate()` fills once before the app renders; writes go
 * to the cache immediately and to the plugin in the background. On the web
 * nothing changes — it is plain `localStorage`, same keys as before.
 */
import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';

const native = Capacitor.isNativePlatform();
const cache = new Map<string, string>();

/** Every key that must be readable synchronously on the first render. */
const HYDRATE_KEYS = ['phoenixx.access', 'phoenixx.refresh', 'phoenixx.theme'];

/**
 * Loads the native store into the cache. Awaited in main.tsx before the first
 * render, so a signed-in user is never briefly shown the login screen.
 * A no-op on the web.
 */
export async function hydrate(): Promise<void> {
  if (!native) return;
  await Promise.all(HYDRATE_KEYS.map(async (key) => {
    try {
      const { value } = await Preferences.get({ key });
      if (value != null) cache.set(key, value);
    } catch { /* a missing key is not an error worth blocking startup for */ }
  }));
}

export const store = {
  get(key: string): string | null {
    if (!native) return localStorage.getItem(key);
    return cache.has(key) ? cache.get(key)! : null;
  },

  set(key: string, value: string): void {
    if (!native) { localStorage.setItem(key, value); return; }
    cache.set(key, value);
    void Preferences.set({ key, value }).catch(() => {});
  },

  remove(key: string): void {
    if (!native) { localStorage.removeItem(key); return; }
    cache.delete(key);
    void Preferences.remove({ key }).catch(() => {});
  },
};

export const isNative = native;
