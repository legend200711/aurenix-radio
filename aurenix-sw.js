/**
 * AURENIX — Service Worker (v6 — GitHub Pages /aurenix-radio/ base path)
 *
 * All paths are prefixed with /aurenix-radio/ to match the GitHub Pages
 * deployment at https://legend200711.github.io/aurenix-radio/
 *
 * Cache scope: ALL AURENIX cache names start with "aurenix-" so the
 * activate handler only deletes our own old caches, never other apps'.
 */

const BASE  = '/aurenix-radio';
const CACHE = 'aurenix-v12';

// Static shell assets — cache first.
const SHELL = [
  BASE + '/aurenix-network.css',
  BASE + '/aurenix-mobile.css',
  BASE + '/aurenix-favicon.svg',
  BASE + '/aurenix-manifest.json',
  BASE + '/aurenix-icon-192.png',
  BASE + '/aurenix-icon-512.png',
];

// JS engine files — always network, never stale cache.
const JS_ENGINES = [
  BASE + '/aurenix-broadcast.js',
  BASE + '/aurenix-mobile.js',
  BASE + '/aurenix-live-tv-engine.js',
  BASE + '/aurenix-channel-engine.js',
  BASE + '/aurenix-control.js',
  BASE + '/firebase-client.js',
  BASE + '/supabase-client.js',
  BASE + '/index.html',
  BASE + '/',
  BASE,          // trailing-slash-less variant
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
      .then(keys => Promise.all(
        keys
          .filter(k => k.startsWith('aurenix-') && k !== CACHE)
          .map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (!url.protocol.startsWith('http')) return;

  // Always network: Firebase, Supabase, Google APIs, CDNs
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

  // JS engine files — always network, never cached.
  if (JS_ENGINES.includes(url.pathname)) {
    e.respondWith(fetch(e.request).catch(() => caches.match(e.request)));
    return;
  }

  // Shell assets — cache first, network fallback.
  if (SHELL.includes(url.pathname)) {
    e.respondWith(caches.match(e.request).then(c => c || fetch(e.request)));
    return;
  }

  // Navigation fallback — serve the app shell when offline.
  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request).catch(() => caches.match(BASE + '/index.html'))
    );
  }
});

// Handle skipWaiting message from the app on update.
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
