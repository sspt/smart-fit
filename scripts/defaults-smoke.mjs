import { openLibrary, collectProgrammes } from "./ui-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
try {
  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Populate an old installation before the new application starts.
  await page.goto("http://localhost:4173/manifest.webmanifest");
  await page.evaluate(async () => {
    const b = (name, duration, speed) => ({
      name,
      duration,
      speed,
      incline: 0,
      resistance: 3,
      power: 100,
    });
    const old = {
      id: "walk",
      name: "Easy morning walk",
      kind: "Treadmill",
      repeat: 1,
      blocks: [
        b("Warm up", 180, 3),
        b("Find your rhythm", 600, 5),
        b("Cool down", 180, 3),
      ],
    };
    const custom = { ...old, id: "personal", name: "My saved session" };
    const edited = { ...old, id: "ride", name: "My edited example" };
    await new Promise((resolve, reject) => {
      const r = indexedDB.open("smart-fit", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("data");
      r.onsuccess = () => {
        const db = r.result,
          t = db.transaction("data", "readwrite");
        t.objectStore("data").put([old, custom, edited], "programmes");
        t.oncomplete = () => {
          db.close();
          resolve();
        };
        t.onerror = () => reject(t.error);
      };
    });
  });
  await page.goto("http://localhost:4173");
  const installed = await collectProgrammes(page);
  assert.equal(installed.length, 11);
  assert(installed.includes("My saved session"));
  assert(installed.includes("My edited example"));
  assert(!installed.includes("Easy morning walk"));
  for (const minutes of ["15 min", "30 min", "45 min"])
    assert.equal(
      installed.filter((name) => name.startsWith(minutes)).length,
      3,
    );
  await page
    .getByRole("searchbox", { name: "Search programmes" })
    .fill("15 min · Easy walk");
  await page
    .getByRole("heading", { name: "15 min · Easy walk", exact: true })
    .locator("..")
    .getByRole("button", { name: "Edit programme" })
    .click();
  page.on("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete programme", exact: true })
    .click();
  await page.reload();
  const after = await collectProgrammes(page);
  assert.equal(after.length, 10);
  assert(after.includes("My saved session"));
  assert(!after.includes("15 min · Easy walk"));
  assert.deepEqual(errors, []);
  console.log(
    "PASS: defaults installed on existing library, edited/custom sessions preserved, exact durations shown, deletions respected after reload.",
  );
  await context.close();
  const fresh = await browser.newPage();
  await fresh.goto("http://localhost:4173");
  await openLibrary(fresh);
  assert.equal((await collectProgrammes(fresh)).length, 9);
  console.log("PASS: fresh installation has exactly nine defaults.");
} finally {
  await browser.close();
}
