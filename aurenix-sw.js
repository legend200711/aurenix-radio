/**
 * AURENIX — Service Worker (v3)
 * Caches static shell assets only.
 * All JS engine files are always fetched from the network so viewers
 * always get the latest broadcast/player logic without a hard refresh.
 */

// Bump this version any time shell assets change.
const CACHE = 'aurenix-v7';

// Only truly static, rarely-changing shell assets go here.
// JavaScript engine files are intentionally excluded so they are always
// network-fetched — stale player code was a secondary cause of viewer issues.
const SHELL = [
  '/aurenix-network.css',
  '/aurenix-favicon.svg',
  '/aurenix-manifest.json',
];

// JS engine files that must NEVER be served from cache.
const JS_ENGINES = [
  '/aurenix-broadcast.js',
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
  // This guarantees viewers always run the latest player code.
  if (JS_ENGINES.includes(url.pathname)) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Static shell assets — cache first, network fallback.
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
    return;
  }

  // Navigation fallback
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/index.html')));
  }
});
