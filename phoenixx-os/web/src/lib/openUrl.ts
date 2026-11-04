/**
 * Opening a link that is not part of the app.
 *
 * `window.open` inside a WebView is unreliable: depending on the platform it is
 * either swallowed or replaces the app's own page, which strands the user with
 * no way back. The Browser plugin presents an in-app browser (SFSafariViewController
 * on iOS, Custom Tabs on Android) with a Done button, and falls back to a normal
 * new tab on the web.
 */
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';

export async function openUrl(url: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}
