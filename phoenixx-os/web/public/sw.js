/**
 * Phoenixx OS service worker: browser pop-ups only.
 *
 * It caches nothing and handles no fetches - the app works exactly as it does
 * without it. Its single job is to show a pop-up when the server pushes a
 * notification (even with no Phoenixx tab open) and, when one is clicked, to
 * bring a Phoenixx tab forward on the right page.
 */

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }

  event.waitUntil((async () => {
    // Any open tab refreshes its bell straight away.
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    tabs.forEach((tab) => tab.postMessage({ type: 'phoenixx:notification' }));

    await self.registration.showNotification(data.title || 'Phoenixx OS', {
      body: data.body || '',
      icon: '/phoenix-mark.png',
      badge: '/phoenix-mark.png',
      tag: data.tag,
      data: { link: data.link || '/' },
    });
  })());
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.link || '/', self.location.origin).href;

  event.waitUntil((async () => {
    const tabs = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const tab = tabs.find((t) => new URL(t.url).origin === self.location.origin);
    if (tab) {
      await tab.focus();
      // The app routes it itself, so a half-filled form elsewhere is not reloaded away.
      tab.postMessage({ type: 'phoenixx:navigate', url: target });
      return;
    }
    await self.clients.openWindow(target);
  })());
});
