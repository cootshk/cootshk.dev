/* Service worker for Modpack Builder.
 * Scope: /modpack/. It controls this page, so it also intercepts the requests
 * the page makes to out-of-scope shared assets (../cdn/shared/...) and the
 * JSZip CDN — all of which we precache for offline use. Modrinth API/CDN and
 * loader-metadata requests always go to the network (never cached). */

const CACHE = 'modpack-v2';

// Relative URLs resolve against this SW's location (/modpack/sw.js).
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon.svg',
  '../cdn/shared/styles/tokens.css',
  '../cdn/shared/scripts/util.js',
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const host = new URL(req.url).hostname;
  // Dynamic data — always network, never cached.
  if (/(?:^|\.)(?:modrinth\.com|fabricmc\.net|quiltmc\.org|neoforged\.net|minecraftforge\.net)$/.test(host)) {
    return;
  }

  // Network-first for the app shell so code/style updates always show when
  // online; the cache is refreshed on every successful fetch and only used as
  // an offline fallback (→ index.html for navigations).
  event.respondWith(
    fetch(req).then(res => {
      if (res && res.ok && (res.type === 'basic' || res.type === 'cors')) {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then(hit => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./index.html');
      return Response.error();
    }))
  );
});
