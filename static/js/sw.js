/* Service worker for the Carry PWA.
 *
 * Deliberately conservative about what it stores. Pages are rendered per-user
 * and can contain someone's check-ins and email, so HTML is NEVER
 * written to the cache -- navigations always go to the network, and if that
 * fails the user gets a generic offline page instead. Only static assets
 * (CSS/JS/images/fonts) and that offline page are cached.
 *
 * Served from / (see the /sw.js route in app.py) so its scope covers the whole
 * site; a worker under /static/ could only control /static/.
 */

// Bump this to retire every previously cached asset in one go.
const CACHE = "carry-v3";

const OFFLINE_URL = "/offline";

const PRECACHE = [
  OFFLINE_URL,
  "/static/css/carry-ui.css",
  "/static/js/app.js",
  "/static/js/carry-ui.js",
  "/static/image/icon-192.png",
  "/static/image/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll is all-or-nothing: one 404 would abort the whole install and
      // leave the site with no worker at all. Cache each entry on its own so a
      // missing file only costs us that file.
      .then((cache) => Promise.all(PRECACHE.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Never touch POSTs, other origins, or the auth endpoints.
  if (req.method !== "GET" || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/auth")) return;

  // Page loads: network only, with a static offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match(OFFLINE_URL, { ignoreSearch: true }))
    );
    return;
  }

  // Static assets: serve from cache immediately, refresh in the background so
  // a deploy is picked up on the next load rather than never.
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((hit) => {
          const fresh = fetch(req)
            .then((res) => {
              if (res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || fresh;
        })
      )
    );
  }
});
