/* Garde la page contrôleur sur le téléphone. Le serveur reste la source
   dès qu'il répond. S'il est arrêté, on réaffiche la dernière page reçue. */
const CACHE = 'gamelle-controller-v2';
const SHELL = [
  '/style.css',
  '/socket.io/socket.io.js',
  '/webrtc-config.js',
  '/message-library-ui.js',
  '/alarm-sounds.js',
  '/schedule-ui.js',
  '/alarm-ui.js',
  '/talk-pcm.js',
  '/qr.js',
  '/controller.js',
  '/logo.png',
  '/favicon-192.png',
  '/apple-touch-icon.png',
  '/manifest.webmanifest',
];

function isControllerHtml(text, res) {
  if (res && res.headers && res.headers.get && res.headers.get('x-gamelle-page') === 'controller') return true;
  return String(text || '').includes('name="gamelle-page" content="controller"');
}

function cleanHeaders(src) {
  const headers = new Headers(src || undefined);
  [
    'cache-control',
    'pragma',
    'expires',
    'cdn-cache-control',
    'cloudflare-cdn-cache-control',
    'surrogate-control',
    'content-encoding',
    'content-length',
    'transfer-encoding',
  ].forEach((name) => headers.delete(name));
  return headers;
}

async function putText(cache, url, text, contentType) {
  await cache.put(url, new Response(text, {
    status: 200,
    headers: { 'Content-Type': contentType || 'text/plain; charset=utf-8' },
  }));
}

async function rememberResponse(cache, request, res) {
  if (!res || !res.ok) return;
  const headers = cleanHeaders(res.headers);
  const body = await res.blob();
  await cache.put(request, new Response(body, { status: 200, statusText: 'OK', headers }));
}

async function precache() {
  const cache = await caches.open(CACHE);
  try {
    const res = await fetch('/controller.html', { cache: 'reload', credentials: 'same-origin' });
    const text = await res.text();
    if (res.ok && isControllerHtml(text, res)) {
      await putText(cache, '/controller.html', text, 'text/html; charset=utf-8');
    }
  } catch (e) {}
  await Promise.all(SHELL.map(async (url) => {
    try {
      const res = await fetch(url, { cache: 'reload', credentials: 'same-origin' });
      if (!res.ok) return;
      await rememberResponse(cache, url, res);
    } catch (e) {}
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await Promise.race([
      precache(),
      new Promise((resolve) => setTimeout(resolve, 8000)),
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
  })());
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
  return /\.(?:js|css|png|ico|svg|webp|webmanifest)$/i.test(url.pathname);
}

function tunnelDown(res) {
  if (!res) return true;
  return res.status >= 500;
}

function isCloudflareError(text) {
  const t = String(text || '');
  if (!t || isControllerHtml(t)) return false;
  return /error code:\s*1033|Error 1033|cf-error-details|cf-error-code/i.test(t);
}

async function cachedController() {
  const cache = await caches.open(CACHE);
  return cache.match('/controller.html');
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  const nav = isControllerNav(request, url);
  const shell = isShellAsset(url);
  if (!nav && !shell) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await fetch(url.pathname + url.search, {
        cache: 'reload',
        credentials: 'same-origin',
        redirect: 'follow',
        headers: nav ? { Accept: 'text/html' } : undefined,
      });
      if (nav) {
        const text = await res.clone().text().catch(() => '');
        if (res.ok && isControllerHtml(text, res)) {
          await putText(cache, '/controller.html', text, 'text/html; charset=utf-8');
          return res;
        }
        if (tunnelDown(res) || isCloudflareError(text)) {
          const cached = await cachedController();
          if (cached) return cached;
        }
        return res;
      }
      if (res.ok) {
        await rememberResponse(cache, request, res.clone());
        return res;
      }
      const cached = await cache.match(request) || await cache.match(request, { ignoreSearch: true });
      return cached || res;
    } catch (e) {
      if (nav) {
        const cached = await cachedController();
        if (cached) return cached;
      } else {
        const cached = await cache.match(request) || await cache.match(request, { ignoreSearch: true });
        if (cached) return cached;
      }
      throw e;
    }
  })());
});
