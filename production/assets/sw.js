const CACHE = "smart-fit-cfe4d832da02-visual-2210fb11fb5a-visual-eec56c39bb22-equipment-3dda26b9d817-visual-13030669f897-programmes-57dcdc91015e-visual-3979cc63d064-settings-b43450d0ea98-visual-8276ae9c07fc-bluetooth-573f5e5911e7-visual-4f4c2b7f2a19";
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
