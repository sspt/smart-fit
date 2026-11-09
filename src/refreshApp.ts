/** Refresh app assets without touching IndexedDB or local preferences. */
export async function refreshApp() {
  const url = new URL(location.href);
  url.searchParams.set("dev-refresh", Date.now().toString());
  // Check that a fresh app shell is reachable before removing offline assets.
  const response = await fetch(url, { cache: "no-store" });
  if (
    !response.ok ||
    !response.headers.get("content-type")?.includes("text/html")
  )
    throw Error(
      "Could not reach the app. Connect to the internet and try again.",
    );
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    for (const registration of registrations) {
      const worker =
        registration.active ?? registration.waiting ?? registration.installing;
      if (worker && new URL(worker.scriptURL).pathname === "/sw.js")
        await registration.unregister();
    }
  }
  if ("caches" in window) {
    for (const key of await caches.keys())
      if (key.startsWith("smart-fit-")) await caches.delete(key);
  }
  // A unique navigation URL bypasses the browser's cached app shell as well.
  location.replace(url.href);
}
