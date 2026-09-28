/**
 * AURENIX — Service Worker (v4 — Mobile App Edition)
 * Caches static shell assets only.
 * All JS engine files are always fetched from the network so viewers
 * always get the latest broadcast/player logic without a hard refresh.
 * The mobile layer (aurenix-mobile.js, aurenix-mobile.css) follows the
 * same network-only rule as the other JS engines.
 */

// Bump this version any time shell assets change.
const CACHE = 'aurenix-v10';

// Only truly static, rarely-changing shell assets go here.
const SHELL = [
  '/aurenix-network.css',
  '/aurenix-mobile.css',
  '/aurenix-favicon.svg',
  '/aurenix-manifest.json',
];

// JS engine files that must NEVER be served from cache.
// This guarantees viewers always run the latest player code.
const JS_ENGINES = [
  '/aurenix-broadcast.js',
  '/aurenix-mobile.js',
  '/aurenix-live-tv-engine.js',
  '/aurenix-channel-engine.js',
  '/aurenix-control.js',
  '/firebase-client.js',
  '/supabase-client.js',
  '/index.html',
  '/',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.allSettled(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (!url.protocol.startsWith('http')) return;

  // Always network: Firebase, Supabase, Google APIs, gstatic (Firebase SDK CDN)
  if (
    url.hostname.endsWith('firebaseio.com') ||
    url.hostname.endsWith('firestore.googleapis.com') ||
    url.hostname.endsWith('identitytoolkit.googleapis.com') ||
    url.hostname.endsWith('securetoken.googleapis.com') ||
    url.hostname.endsWith('firebaseapp.com') ||
    url.hostname.endsWith('googleapis.com') ||
    url.hostname === 'www.gstatic.com' ||
    url.hostname.endsWith('supabase.co') ||
    url.hostname.endsWith('supabase.in') ||
    url.hostname.endsWith('jsdelivr.net')
  ) { return; }

  // JS engine files — always network, never cache.
  if (JS_ENGINES.includes(url.pathname)) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Static shell assets — cache first, network fallback.
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
    return;
  }

  // Navigation fallback — offline shell
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
  }
});

// Handle messages from the app (e.g. skipWaiting request)
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
