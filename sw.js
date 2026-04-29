// Minimal service worker - exists to satisfy PWA install criteria and to keep
// the shell available offline. The app is a single-page HTML so we just cache
// the shell + icons; everything else (Mistral API, Cloudflare Worker) needs
// the network anyway.
const CACHE = 'inputin-shell-v1';
const SHELL = ['./', './index.html', './manifest.webmanifest', './assets/inputin-icon.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        return res;
      }).catch(() => caches.match(req).then((m) => m || caches.match('./index.html')))
    );
    return;
  }

  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.status === 200 && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);
    })
  );
});

// ============================================================================
// PUSH NOTIFICATIONS
// ============================================================================
// The Cloudflare Worker pushes encrypted JSON payloads here on cron triggers
// (daily reminder, weekly summary). Payload shape:
//   { kind, title, body, url? }
// We keep this defensive — falls back to a generic notification if the payload
// is missing or invalid.

self.addEventListener('push', (event) => {
  let payload = null;
  try {
    if (event.data) payload = event.data.json();
  } catch {
    try { payload = { title: 'inputIn', body: event.data && event.data.text() || '' }; } catch {}
  }
  const title = (payload && payload.title) || 'inputIn';
  const opts = {
    body:  (payload && payload.body)  || '',
    icon:  './assets/inputin-icon.png',
    badge: './assets/inputin-icon.png',
    data:  { url: (payload && payload.url) || './', kind: payload && payload.kind || '' },
    tag:   (payload && payload.kind) || 'inputin',
    renotify: true,
  };
  event.waitUntil(self.registration.showNotification(title, opts));
});

// Click handler — focus an existing app tab if one is open, else open a new
// tab to the URL embedded in the notification (or the app root).
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const w of wins) {
        try {
          const u = new URL(w.url);
          if (u.origin === self.location.origin) {
            return w.focus().then(() => w.navigate ? w.navigate(target) : w);
          }
        } catch {}
      }
      return self.clients.openWindow(target);
    })
  );
});
