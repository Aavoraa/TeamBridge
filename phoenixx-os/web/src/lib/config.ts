/**
 * Where the API lives.
 *
 * On the web the app is served by the same Express process that serves the API,
 * so a relative path is correct and there is no CORS involved — that is why
 * VITE_API_URL is empty for a normal web build.
 *
 * Inside the Capacitor shell the page origin is the device itself
 * (`http://localhost` on Android, `capacitor://localhost` on iOS), so a
 * relative path resolves to the WebView's own bundle and every API call would
 * fail. The mobile build therefore sets VITE_API_URL to the deployed server's
 * absolute origin — see phoenixx-os-mobile/.env.
 */
export const API_ORIGIN = (import.meta.env.VITE_API_URL || '').replace(/\/+$/, '');

/** Versioned API root. Every request in lib/api.ts is built from this. */
export const API_BASE = `${API_ORIGIN}/api/v1`;
