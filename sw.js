const CACHE_NAME = '2dobyu-v13';
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  const requestUrl = new URL(event.request.url);
  const isSameOrigin = requestUrl.origin === self.location.origin;
  const isDocument = event.request.mode === 'navigate' || event.request.destination === 'document';

  if (isSameOrigin && isDocument) {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const cacheCopy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cacheCopy));
          }
          return networkResponse;
        })
        .catch(async () => {
          const directMatch = await caches.match(event.request);
          if (directMatch) return directMatch;
          return caches.match('./index.html');
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then((networkResponse) => {
        if (isSameOrigin && networkResponse && networkResponse.status === 200) {
          const cacheCopy = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cacheCopy));
        }
        return networkResponse;
      });
    })
  );
});

async function notifyClientsTriggerSync() {
  const clientsList = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
  clientsList.forEach((client) => client.postMessage({ type: 'TRIGGER_SYNC' }));
}

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'REGISTER_SYNC') return;
  if (!self.registration || !self.registration.sync) return;
  event.waitUntil(self.registration.sync.register('2dobyu-sync'));
});

self.addEventListener('sync', (event) => {
  if (event.tag !== '2dobyu-sync') return;
  event.waitUntil(notifyClientsTriggerSync());
});