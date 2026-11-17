'use strict';
/*
 * The menu's service worker. One job: show "your order is ready" when the
 * POS calls an order whose phone asked to be told (menu.js, the ready
 * section). It does not handle fetches, so it never caches or changes how
 * the menu loads.
 *
 * The push carries data only: { type: 'order-ready', publicId, lang }. The
 * words live here, not on the POS.
 */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', (e) => { e.waitUntil(self.clients.claim()); });

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = {}; }
  const id = String(d.publicId || '');
  if (d.type !== 'order-ready' || !/^[a-f0-9]{32}$/.test(id)) return;
  e.waitUntil(self.registration.showNotification('Your order is ready', {
    body: 'Beanery',
    icon: '/menu/logo.svg',
    tag: 'order-' + id,
    renotify: true,
    vibrate: [300, 120, 300],
  }));
});

// A tap goes back to the menu tab the guest ordered from, which still holds
// their table and their orders; a new tab only when that one is gone.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
    for (const c of list) {
      if (c.url.indexOf('/menu/') !== -1 && 'focus' in c) return c.focus();
    }
    return self.clients.openWindow('/menu/');
  }));
});
