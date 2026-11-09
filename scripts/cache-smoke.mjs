import { openLibrary, collectProgrammes } from "./ui-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const context = await browser.newContext({
    viewport: { width: 320, height: 844 },
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(process.env.FIT_TEST_URL || "http://localhost:8787");
  await openLibrary(page);
  await page.waitForFunction(
    async () =>
      (await navigator.serviceWorker.getRegistrations()).some((r) => r.active),
    null,
    { timeout: 15000 },
  );
  await page.evaluate(async () => {
    await (
      await caches.open("smart-fit-obsolete")
    ).put("/old-build", new Response("old"));
    await (
      await caches.open("unrelated-cache")
    ).put("/keep", new Response("keep"));
    localStorage.setItem("cache-test", "keep");
    await new Promise((resolve, reject) => {
      const request = indexedDB.open("smart-fit");
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction("data", "readwrite");
        tx.objectStore("data").put({ value: "keep" }, "cache-test");
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = reject;
      };
      request.onerror = reject;
    });
  });
  assert(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    "header fits 320px",
  );
  console.log("seeded caches and persistent data");
  await context.setOffline(true);
  await page.getByRole("button", { name: "Clear app cache" }).click();
  await page
    .getByRole("alert")
    .filter({ hasText: "Could not refresh" })
    .waitFor();
  assert(
    await page.evaluate(() => caches.has("smart-fit-obsolete")),
    "offline failure preserves cache",
  );
  console.log("offline preservation passed");
  await context.setOffline(false);
  await page.getByRole("button", { name: "Clear app cache" }).click();
  await page.waitForURL(/dev-refresh=/);
  console.log("fresh navigation complete");
  await openLibrary(page);
  assert.equal(
    await page.evaluate(() => caches.has("smart-fit-obsolete")),
    false,
  );
  assert.equal(await page.evaluate(() => caches.has("unrelated-cache")), true);
  assert.equal(
    await page.evaluate(() => localStorage.getItem("cache-test")),
    "keep",
  );
  assert.equal(
    await page.evaluate(
      () =>
        new Promise((resolve) => {
          const r = indexedDB.open("smart-fit");
          r.onsuccess = () => {
            const db = r.result;
            const tx = db.transaction("data");
            const v = tx.objectStore("data").get("cache-test");
            v.onsuccess = () => {
              resolve(v.result.value);
              db.close();
            };
          };
        }),
    ),
    "keep",
  );
  assert.equal((await collectProgrammes(page)).length, 9);
  console.log("cache and persistent data checks passed");
  await page
    .getByRole("button", { name: "Equipment connection", exact: true })
    .click();
  await page.getByText("More connection options", { exact: true }).click();
  await page.getByRole("button", { name: "Explore demo" }).click();
  await openLibrary(page);
  await page
    .getByRole("button", { name: /^Start / })
    .first()
    .click();
  await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
  await page.waitForFunction(
    () => document.querySelector(".cache-refresh").disabled,
  );
  assert.equal(
    await page.getByRole("button", { name: "Clear app cache" }).isDisabled(),
    true,
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS cache refresh: 320px header, offline preservation, real service worker cache removal, reload, IndexedDB/localStorage preservation and active-session guard.",
  );
} finally {
  await browser.close();
}
