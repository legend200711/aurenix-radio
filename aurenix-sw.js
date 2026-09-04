/**
 * AURENIX — Service Worker
 * aurenix-sw.js
 *
 * Provides:
 *  - App shell caching for offline/installable PWA
 *  - Cache-first for static assets
 *  - Network-first for API calls (Supabase)
 *  - Background sync support
 */

const CACHE_NAME    = 'aurenix-radio-v4';
const SHELL_CACHE   = 'aurenix-shell-v4';

/* Static app shell — cached on install */
const APP_SHELL = [
  '/aurenix.html',
  '/aurenix-radio.html',
  '/aurenix-core.css',
  '/aurenix-extensions.css',
  '/aurenix-nav.js',
  '/aurenix-bg.js',
  '/aurenix-crow.js',
  '/aurenix-radio.js',
  '/aurenix-auth.js',
  '/aurenix-admin.js',
  '/supabase-client.js',
  '/aurenix-favicon.svg',
  '/aurenix-manifest.json',
];

/* ═══════════════════════════════════════════
   INSTALL — pre-cache app shell
═══════════════════════════════════════════ */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then((cache) => {
      return Promise.allSettled(
        APP_SHELL.map(url => cache.add(url).catch(() => {
          // Non-fatal: shell works even if some assets fail to cache
        }))
      );
    }).then(() => self.skipWaiting())
  );
});

/* ═══════════════════════════════════════════
   ACTIVATE — clean old caches
═══════════════════════════════════════════ */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys
          .filter(k => k !== CACHE_NAME && k !== SHELL_CACHE)
          .map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

/* ═══════════════════════════════════════════
   FETCH — routing strategy
═══════════════════════════════════════════ */
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Skip non-GET requests
  if (event.request.method !== 'GET') return;

  // Skip chrome-extension and other non-http schemes
  if (!url.protocol.startsWith('http')) return;

  // Skip Supabase API calls — always network
  if (url.hostname.endsWith('supabase.co') || url.hostname.endsWith('supabase.in')) {
    event.respondWith(networkOnly(event.request));
    return;
  }

  // DO NOT intercept the 24-hour cloud stream subdirectory or its assets.
  // That system has its own caching and must load freely from the network.
  if (url.pathname.startsWith('/24-hour-cloud-stream/')) {
    return; // let the browser handle it natively
  }

  // DO NOT intercept live.html, live-hub.html, live-room.html — they are
  // separate full-page applications that must load from the network.
  if (url.pathname.match(/^\/(live\.html|live-hub\.html|live-room\.html)$/)) {
    return; // let the browser handle it natively
  }

  // App shell assets — cache first, then network
  if (APP_SHELL.includes(url.pathname)) {
    event.respondWith(cacheFirst(event.request, SHELL_CACHE));
    return;
  }

  // Navigation — network first, fall back to appropriate shell
  if (event.request.mode === 'navigate') {
    const dest = url.pathname;
    if (dest === '/' || dest === '/aurenix.html' || dest === '/index.html') {
      event.respondWith(
        fetch(event.request).catch(() => caches.match('/aurenix.html'))
      );
    } else if (dest === '/aurenix-radio.html') {
      event.respondWith(
        fetch(event.request).catch(() => caches.match('/aurenix-radio.html'))
      );
    }
    // All other navigations (live.html, cloud stream, etc.) — pure network, no fallback
    return;
  }

  // Other static assets (images, etc.) — stale while revalidate
  if (url.pathname.match(/\.(png|jpg|jpeg|svg|ico|woff2|woff|ttf)$/i)) {
    event.respondWith(staleWhileRevalidate(event.request, CACHE_NAME));
    return;
  }

  // Default — network first
  event.respondWith(networkFirst(event.request));
});

/* ═══════════════════════════════════════════
   CACHE STRATEGIES
═══════════════════════════════════════════ */

async function cacheFirst(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(cacheName);
      cache.put(request, response.clone());
    }
    return response;
  } catch(_) {
    return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
  }
}

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch(_) {
    const cached = await caches.match(request);
    return cached || new Response('Offline', { status: 503 });
  }
}

async function staleWhileRevalidate(request, cacheName) {
  const cached = await caches.match(request);
  const networkFetch = fetch(request).then(response => {
    if (response.ok) {
      caches.open(cacheName).then(cache => cache.put(request, response.clone()));
    }
    return response;
  }).catch(() => null);
  return cached || (await networkFetch) || new Response('Offline', { status: 503 });
}

async function networkOnly(request) {
  try { return await fetch(request); }
  catch(_) { return new Response('Network unavailable', { status: 503 }); }
}

/* ═══════════════════════════════════════════
   PUSH NOTIFICATIONS (future)
═══════════════════════════════════════════ */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  try {
    const data = event.data.json();
    event.waitUntil(
      self.registration.showNotification(data.title || 'AURENIX', {
        body:  data.body  || '',
        icon:  '/aurenix-favicon.svg',
        badge: '/aurenix-favicon.svg',
        data:  data,
      })
    );
  } catch(_) {}
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/aurenix.html';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(list => {
      const client = list.find(c => c.url === url && 'focus' in c);
      if (client) return client.focus();
      return clients.openWindow(url);
    })
  );
});
