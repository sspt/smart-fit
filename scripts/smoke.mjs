import { openLibrary, collectProgrammes } from "./ui-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 412, height: 915 },
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("requestfailed", (r) => console.log("FAILED", r.url(), r.failure()));
page.on("console", (m) => {
  if (m.type() === "error") console.log("ERROR", m.text());
});
await page.goto(process.env.FIT_TEST_URL || "http://localhost:4173");
await openLibrary(page);
assert.equal(
  await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  true,
  "mobile must not overflow",
);
await page.getByRole("button", { name: "Create programme" }).click();
await page.getByLabel("Programme name").fill("Smoke test");
await page.getByRole("button", { name: "Save programme" }).click();
await page.getByRole("heading", { name: "Smoke test", exact: true }).waitFor();
await page
  .getByRole("button", { name: "Equipment connection", exact: true })
  .click();
await page.getByText("More connection options", { exact: true }).click();
await page.getByRole("button", { name: "Explore demo" }).click();
await openLibrary(page);
await page
  .getByRole("button", { name: "Start Smoke test", exact: true })
  .click();
await page.getByRole("button", { name: "Pause", exact: true }).waitFor();
await page.waitForTimeout(1600);
await page.getByRole("button", { name: "Pause", exact: true }).click();
await page
  .getByRole("button", { name: "Resume programme", exact: true })
  .waitFor();
page.on("dialog", (d) => d.accept());
await page.reload();
await page
  .getByRole("alert")
  .filter({ hasText: "Recovered workout" })
  .waitFor();
await page.getByRole("button", { name: "Live", exact: true }).click();
await page.getByRole("button", { name: "Stop & finish" }).click();
await page.getByRole("heading", { name: "Your journey." }).waitFor();
await page.getByRole("heading", { name: "Smoke test", exact: true }).waitFor();
await page.reload();
await openLibrary(page);
await page.getByRole("heading", { name: "Smoke test", exact: true }).waitFor();
await page.evaluate(async () => {
  await navigator.serviceWorker.ready;
});
await page.reload();
await openLibrary(page);
await context.setOffline(true);
await page.reload();
await openLibrary(page);
await page.getByRole("button", { name: "Journal", exact: false }).click();
await page.getByRole("heading", { name: "Smoke test", exact: true }).waitFor();
await page.screenshot({ path: "/tmp/smart-fit-mobile.png", fullPage: true });
assert.deepEqual(errors, []);
console.log(
  "PASS: mobile layout, editor, demo lifecycle, recovery, persistent history, offline reload; no JS errors.",
);
await browser.close();
