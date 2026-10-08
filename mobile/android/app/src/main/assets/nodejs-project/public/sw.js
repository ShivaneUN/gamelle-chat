/* Garde la page contrôleur sur le téléphone. Le serveur reste la source
   dès qu'il répond. S'il est arrêté, on réaffiche la dernière page reçue. */
const CACHE = 'gamelle-controller-v1';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

function isControllerNav(request, url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname !== '/controller.html' && url.pathname !== '/') return false;
  if (request.mode === 'navigate') return true;
  const accept = request.headers.get('accept') || '';
  return accept.includes('text/html');
}

function isShellAsset(url) {
  if (url.origin !== self.location.origin) return false;
  if (url.pathname === '/sw.js') return false;
  if (url.pathname === '/socket.io/socket.io.js') return true;
  if (url.pathname.startsWith('/socket.io/')) return false;
  if (url.pathname.startsWith('/api/')) return false;
  if (url.pathname.startsWith('/media/')) return false;
  return /\.(?:js|css|png|ico|svg|webp)$/i.test(url.pathname);
}

function strippedResponse(res) {
  const headers = new Headers(res.headers);
  [
    'cache-control',
    'pragma',
    'expires',
    'cdn-cache-control',
    'cloudflare-cdn-cache-control',
    'surrogate-control',
  ].forEach((name) => headers.delete(name));
  return res.blob().then((body) => new Response(body, {
    status: 200,
    statusText: 'OK',
    headers,
  }));
}

async function remember(request, res) {
  try {
    if (!res || !res.ok) return;
    const stored = await strippedResponse(res);
    const cache = await caches.open(CACHE);
    await cache.put(request, stored.clone());
    return stored;
  } catch (e) {}
}

async function cachedController() {
  const cache = await caches.open(CACHE);
  return cache.match('/controller.html');
}

function tunnelDown(res) {
  if (!res) return true;
  return res.status >= 500;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const nav = isControllerNav(request, url);
  const shell = isShellAsset(url);
  if (!nav && !shell) return;

  event.respondWith((async () => {
    try {
      const res = await fetch(request);
      if (nav) {
        if (res.ok && res.headers.get('x-gamelle-page') === 'controller') {
          const stored = await remember(new Request('/controller.html'), res.clone());
          if (stored) await remember(request, stored.clone());
          return res;
        }
        if (tunnelDown(res)) {
          const cached = await cachedController();
          if (cached) return cached;
        }
        return res;
      }
      if (res.ok) {
        await remember(request, res.clone());
        return res;
      }
      const cache = await caches.open(CACHE);
      const cached = await cache.match(request) || await cache.match(request, { ignoreSearch: true });
      return cached || res;
    } catch (e) {
      if (nav) {
        const cached = await cachedController();
        if (cached) return cached;
      } else {
        const cache = await caches.open(CACHE);
        const cached = await cache.match(request) || await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
      }
      throw e;
    }
  })());
});
