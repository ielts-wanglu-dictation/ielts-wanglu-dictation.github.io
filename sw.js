// The production build replaces this key with a hash of all application assets.
// Bump the source key when testing changed assets directly with a local server.
const CACHE = "wanglu-personal-v1.0.0";
const ASSETS = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./data.js",
  "./core.js",
  "./audio.js",
  "./backup.js",
  "./backup-config.js",
  "./icon.svg",
  "./manifest.webmanifest",
];
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("wanglu-personal-") && k !== CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  // Cache only application assets, never arbitrary URLs, backups or third-party audio.
  if (
    !ASSETS.some(
      (asset) =>
        new URL(asset, self.registration.scope).pathname === url.pathname,
    )
  )
    return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      const cached = await cache.match(event.request, { ignoreSearch: true });
      return cached || fetch(event.request);
    }),
  );
});
