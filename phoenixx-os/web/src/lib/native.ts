/**
 * Everything the app does *because* it is running as an installed app.
 *
 * All of it is inert on the web — `initNative()` returns immediately unless it
 * is actually running inside the Capacitor shell, so importing this from
 * main.tsx costs the web build nothing but a platform check.
 */
import { Capacitor } from '@capacitor/core';
import { App as CapApp } from '@capacitor/app';
import { SplashScreen } from '@capacitor/splash-screen';
import { StatusBar, Style } from '@capacitor/status-bar';
import { Keyboard, KeyboardResize } from '@capacitor/keyboard';
import { store } from './storage';

/**
 * Marks the document so CSS can tell an installed app from a browser tab —
 * safe-area padding, no text selection, no rubber-band scroll. Synchronous and
 * called before the first render so nothing reflows once it lands.
 */
export function tagPlatform(): void {
  const root = document.documentElement;
  if (Capacitor.isNativePlatform()) root.classList.add('native');
  root.classList.add(`platform-${Capacitor.getPlatform()}`);
}

/**
 * The status bar text has to be the opposite of the bar's background, and the
 * app's theme can change at runtime, so this is re-applied whenever the theme
 * toggles rather than only at startup.
 */
export async function applyStatusBarTheme(dark: boolean): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;
  try {
    await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light });
    if (Capacitor.getPlatform() === 'android') {
      // iOS refuses a background colour when the view extends under the bar.
      await StatusBar.setBackgroundColor({ color: dark ? '#0f172a' : '#1e40af' });
    }
  } catch { /* the bar is cosmetic — never let it break startup */ }
}

export async function initNative(): Promise<void> {
  if (!Capacitor.isNativePlatform()) return;

  // The web layout already handles the notch via env(safe-area-inset-*), so the
  // page is allowed to draw under the status bar.
  try { await StatusBar.setOverlaysWebView({ overlay: false }); } catch { /* iOS-only paths */ }
  await applyStatusBarTheme(store.get('phoenixx.theme') === 'dark');

  // Resizing the WebView (rather than the body) keeps sticky headers and
  // bottom bars where they belong when the keyboard opens.
  try {
    await Keyboard.setResizeMode({ mode: KeyboardResize.Native });
    await Keyboard.setScroll({ isDisabled: false });
  } catch { /* not available on every platform */ }

  /**
   * Android's hardware back button.
   *
   * Without a handler, back closes the app from any screen — which loses the
   * user's place on every accidental press. History is the right thing to walk
   * because the app is a single BrowserRouter stack; only at the bottom of that
   * stack does back mean "leave".
   */
  CapApp.addListener('backButton', ({ canGoBack }) => {
    // A modal or drawer listens for this and swallows it before we get here.
    const consumed = !window.dispatchEvent(
      new CustomEvent('phoenixx:back', { cancelable: true }),
    );
    if (consumed) return;
    if (canGoBack && window.history.length > 1) window.history.back();
    else CapApp.exitApp();
  });

  // The splash is dismissed by us, not on a timer, so the user never sees the
  // blank frame between the native launch screen and React's first paint.
  try { await SplashScreen.hide(); } catch { /* already hidden */ }
}
