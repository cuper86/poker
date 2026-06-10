const CACHE = "poker-v1";
const ASSETS = ["/", "/manifest.json"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
  ));
  self.clients.claim();
});

self.addEventListener("fetch", e => {
  // No cachear WebSocket ni peticiones dinámicas
  if (e.request.url.includes("ws://") || e.request.url.includes("wss://")) return;
  e.respondWith(
    fetch(e.request).catch(() => caches.match(e.request))
  );
});
