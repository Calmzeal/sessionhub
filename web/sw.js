'use strict';

/* ============================================================
   SessionHub service worker
   - Cache the app shell on install.
   - Cache-first for shell, network fallback for same-origin GET.
   - Never cache /api/* (auth + live data) — WS is not intercepted.
   - Small and safe: registration failures leave the app fully usable.
   ============================================================ */

const CACHE = 'sessionhub-shell-v1';
const SHELL = [
  './',
  './index.html',
  './app.js',
  './style.css',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/favicon-32.png',
  './icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.allSettled(SHELL.map((url) => cache.add(url)))
    ).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== self.location.origin) return;          // only same-origin
  if (url.pathname.startsWith('/api/')) return;             // never cache API
  if (url.pathname === '/ws' || url.pathname.startsWith('/ws')) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(req);
    if (cached) {
      // background network update (shell refresh for next load)
      fetch(req).then((fresh) => {
        if (fresh && fresh.ok) cache.put(req, fresh.clone());
      }).catch(() => { /* offline — keep cached copy */ });
      return cached;
    }
    try {
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      // offline fallback: navigation → cached shell
      if (req.mode === 'navigate') {
        const shell = await cache.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Offline', { status: 503, statusText: 'Offline' });
    }
  })());
});
