const CACHE_NAME = 'drive-price-splitter-static-v2';
const STATIC_ASSETS = ['/', '/manifest.webmanifest', '/icon.svg'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((cacheName) => cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      );
    })
  );
  self.clients.claim();
});

// Écouter le retour en avant-plan et notifier les clients
// pour qu'ils restaurent l'état au lieu de forcer un refresh
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'CLIENT_READY') {
    // Client a repris du focus — pas de refresh, juste restauration d'état
    event.ports[0].postMessage({ type: 'RESTORE_STATE' });
  }
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  const requestUrl = new URL(event.request.url);
  if (requestUrl.origin !== self.location.origin) {
    return;
  }

  // Les documents (le shell HTML) passent par le réseau EN PREMIER, cache en
  // secours. En cache-first, une fois `/` mis en cache l'utilisateur ne
  // recevait plus jamais une nouvelle version de l'app : le vieux HTML
  // continuait de référencer les anciens assets hashés, indéfiniment. Le
  // réseau d'abord garantit que le HTML frais (donc les nouveaux noms
  // d'assets) arrive dès qu'il est disponible, tout en gardant le mode hors
  // ligne grâce au fallback cache.
  if (event.request.mode === 'navigate' || event.request.destination === 'document') {
    event.respondWith(networkFirst(event.request));
    return;
  }

  event.respondWith(cacheFirst(event.request));
});

async function networkFirst(request) {
  try {
    const networkResponse = await fetch(request);
    if (networkResponse.ok) {
      const responseForCache = networkResponse.clone();
      const cache = await caches.open(CACHE_NAME);
      await cache.put(request, responseForCache);
    }
    return networkResponse;
  } catch (error) {
    // Hors ligne : servir la dernière version connue du shell, sinon la
    // racine (une navigation vers une route interne doit retomber sur le
    // shell, c'est une SPA).
    const cached = (await caches.match(request)) ?? (await caches.match('/'));
    if (cached) {
      return cached;
    }
    throw error;
  }
}

// Les assets buildés portent un hash dans leur nom : une fois en cache ils
// sont immuables, cache-first est donc le bon mode pour eux.
async function cacheFirst(request) {
  const cachedResponse = await caches.match(request);
  if (cachedResponse) {
    return cachedResponse;
  }

  const networkResponse = await fetch(request);
  const shouldCache =
    networkResponse.ok &&
    (request.destination === 'script' ||
      request.destination === 'style' ||
      request.destination === 'manifest' ||
      request.destination === 'image');

  if (shouldCache) {
    const responseForCache = networkResponse.clone();
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, responseForCache);
  }

  return networkResponse;
}
