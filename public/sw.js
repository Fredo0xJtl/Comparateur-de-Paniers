const CACHE_NAME = 'drive-price-splitter-static-v4';

// Ce fichier est copié tel quel depuis public/ : Vite ne le transforme pas et
// ne peut donc pas y réécrire le chemin public (`base` dans vite.config.ts).
// Les chemins sont donc dérivés de l'emplacement RÉEL du service worker :
// '/' quand l'application est servie à la racine (dev ou `vite preview`),
// '/Comparateur-de-Paniers/' sur GitHub Pages. En dur, '/'
// pointait vers la racine du domaine — un fichier qui n'existe pas là-bas, et
// une application hors ligne cassée.
const BASE_PATH = new URL('./', self.location).pathname;
const STATIC_ASSETS = [BASE_PATH, `${BASE_PATH}manifest.webmanifest`, `${BASE_PATH}icon.svg`];

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
    const cached = (await caches.match(request)) ?? (await caches.match(BASE_PATH));
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
    await trimCache(cache);
  }

  return networkResponse;
}

// Chaque nouvelle version de l'app apporte des fichiers aux noms différents
// (hash), et les anciens n'étaient jamais retirés : le cache grossissait sans
// fin. On garde les plus récents ; `keys()` les rend dans l'ordre d'ajout,
// donc les premiers sont les plus anciens. Une version complète compte une
// vingtaine de fichiers, 60 laisse de la marge.
const MAX_CACHE_ENTRIES = 60;

async function trimCache(cache) {
  const keys = await cache.keys();
  const excess = keys.length - MAX_CACHE_ENTRIES;
  if (excess <= 0) return;
  await Promise.all(keys.slice(0, excess).map((key) => cache.delete(key)));
}
