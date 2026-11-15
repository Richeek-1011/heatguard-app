// Service worker: makes the app installable and opens instantly.
// The API is never cached: vitals must always be live.
const CACHE = 'heatguard-v2';
const SHELL = ['./', 'index.html', 'styles.css', 'js/logic.js', 'js/app.js', 'manifest.webmanifest', 'icons/icon.svg', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')
      || url.pathname.endsWith('config.js')) return;
  // network first, cache as fallback (new versions show up straight away)
  e.respondWith(fetch(e.request)
    .then((res) => { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res; })
    .catch(() => caches.match(e.request).then((r) => r || caches.match('index.html'))));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window' }).then((list) => {
    if (list.length) return list[0].focus();
    return self.clients.openWindow('./');
  }));
});
