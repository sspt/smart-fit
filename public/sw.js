const CACHE = "smart-fit-__BUILD__";
self.addEventListener("install", (event) =>
  event.waitUntil(
    (async () => {
      const response = await fetch("/");
      const html = await response.text();
      const assets = [
        ...html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g),
      ].map((x) => x[1]);
      const extra = await (await fetch("/offline-assets.json")).json();
      const cache = await caches.open(CACHE);
      await cache.addAll([
        ...new Set([
          "/",
          "/manifest.webmanifest",
          "/icon-192.png",
          "/icon-512.png",
          ...assets,
          ...extra,
        ]),
      ]);
    })(),
  ),
);
// No skipWaiting: updates wait until all old app windows close.
self.addEventListener("activate", (event) =>
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys())
        if (key.startsWith("smart-fit-") && key !== CACHE)
          await caches.delete(key);
      await self.clients.claim();
    })(),
  ),
);
self.addEventListener("fetch", (event) => {
  const u = new URL(event.request.url);
  if (
    u.origin !== self.location.origin ||
    event.request.method !== "GET" ||
    u.pathname.startsWith("/ifit/") ||
    u.pathname.startsWith("/media/") ||
    u.pathname.startsWith("/api/")
  )
    return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(CACHE);
      const found = await cache.match(event.request, { ignoreVary: true });
      if (found) return found;
      try {
        return await fetch(event.request);
      } catch (error) {
        if (event.request.mode === "navigate") return await cache.match("/");
        throw error;
      }
    })(),
  );
});
