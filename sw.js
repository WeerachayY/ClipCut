// Offline support.
// App code (html, js, css, icons): network-first. Each request asks the server whether the file changed
// (cache: 'no-cache' → a cheap 304 when it did not), so every module of a page comes from the same release.
// The cache is only used when offline. Never serve app code from the cache while online: a page built from
// files of two releases breaks in odd ways (buttons that do nothing, missing styles).
// Vendored libraries (ffmpeg core): cache-first, a given path never changes.
// VERSION must match js/version.js (checked by tests).
const VERSION = 'clipcut-0.5.0';
const SHELL = ['./', './index.html', './css/app.css', './js/main.js', './manifest.webmanifest', './icons/favicon.svg', './icons/icon.svg', './icons/icon-192.png'];

// Releases up to 0.4.0 served app code stale-while-revalidate, so the first visit after an update could mix
// old and new files. Pages they controlled are reloaded once when this worker takes over.
const LEGACY = new Set(['clipcut-0.1.0', 'clipcut-0.2.0', 'clipcut-0.3.0', 'clipcut-0.4.0']);

/** Same response, but the browser must ask again next time: with the server's max-age=600 its memory cache
 *  would otherwise hand out the old file for 10 minutes without even asking this worker. */
function mustRevalidate(res) {
  const headers = new Headers(res.headers);
  headers.set('Cache-Control', 'no-cache');
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache (GitHub Pages lets it keep files for 10 minutes)
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const work = (async () => {
    const old = (await caches.keys()).filter((k) => k.startsWith('clipcut-') && k !== VERSION);
    await Promise.all(old.map((k) => caches.delete(k)));
    await self.clients.claim();
    return old.some((k) => LEGACY.has(k));
  })();
  e.waitUntil(work);
  // Not inside waitUntil: the reload's own request waits for activation to finish, so awaiting it there deadlocks.
  work.then(async (reload) => {
    if (!reload) return;
    const pages = await self.clients.matchAll({ type: 'window' });
    pages.forEach((p) => p.navigate(p.url).catch(() => {}));
  });
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.headers.has('range')) return; // media range requests: let the browser handle them

  if (url.pathname.includes('/vendor/')) {
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
    return;
  }

  e.respondWith((async () => {
    const c = await caches.open(VERSION);
    try {
      // A navigation request cannot be copied with new options (and must keep its redirect mode),
      // so it goes as is; index.html only bootstraps css/app.css and js/main.js, which are revalidated below.
      const net = req.mode === 'navigate' ? await fetch(req) : await fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' });
      if (!net.ok || net.redirected) return net;
      const res = mustRevalidate(net);
      c.put(req.url, res.clone());
      return res;
    } catch (err) {
      const hit = (await c.match(req.url, { ignoreSearch: true }))
        || (req.mode === 'navigate' ? await c.match('./index.html') : undefined);
      if (hit) return hit;
      throw err;
    }
  })());
});
