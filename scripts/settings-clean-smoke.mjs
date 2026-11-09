import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const width of [320, 412, 1280]) {
    const page = await browser.newPage({
        viewport: { width, height: 844 },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/strava/status", (r) =>
      r.fulfill({ json: { configured: true, connected: false } }),
    );
    await page.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
    const settings = async () =>
      page
        .getByRole("navigation")
        .getByRole("button", { name: "Settings", exact: true })
        .click();
    await settings();
    await page
      .getByRole("heading", { name: "Settings", exact: true })
      .waitFor();
    await page.getByRole("heading", { name: "Strava", exact: true }).waitFor();
    await page
      .getByRole("button", { name: "Connect Strava", exact: true })
      .waitFor();
    assert.equal(
      await page
        .getByRole("button", { name: "Request persistent storage" })
        .count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "Clear app cache" }).isVisible(),
      false,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Delete history", exact: true })
        .isVisible(),
      false,
    );
    const units = page.getByLabel("Display units");
    await units.selectOption("mi");
    const download = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export backup", exact: true })
      .click();
    const file = await download,
      stream = await file.createReadStream(),
      chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    const bytes = Buffer.concat(chunks),
      backup = JSON.parse(bytes.toString());
    assert.equal(backup.settings.units, "mi");
    await units.selectOption("km");
    page.once("dialog", (d) => d.accept());
    await page
      .locator('input[type=file][accept="application/json"]')
      .setInputFiles({
        name: "backup.json",
        mimeType: "application/json",
        buffer: bytes,
      });
    await page.waitForFunction(
      () => document.querySelector(".clean-settings select")?.value === "mi",
    );
    await page.reload();
    await settings();
    assert.equal(await page.getByLabel("Display units").inputValue(), "mi");
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    if (width === 412)
      await page.screenshot({
        path: "artifacts/previews/settings-clean.png",
        fullPage: true,
      });
    await page.getByText("App & data tools", { exact: true }).click();
    assert(
      await page.getByRole("button", { name: "Clear app cache" }).isVisible(),
    );
    assert(
      await page
        .getByRole("button", { name: "Delete history", exact: true })
        .isVisible(),
    );
    page.once("dialog", (d) => d.dismiss());
    await page
      .getByRole("button", { name: "Delete history", exact: true })
      .click();
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px: clean Settings, Strava, units, backup/restore, hidden tools and delete confirmation`,
    );
    await page.close();
  }
  const page = await browser.newPage();
  await page.route("**/api/strava/status", (r) =>
    r.fulfill({
      json: {
        configured: true,
        connected: true,
        athlete: { name: "Test athlete" },
      },
    }),
  );
  await page.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Disconnect Strava", exact: true })
    .waitFor();
  assert(
    await page
      .getByLabel("Automatically sync new completed workouts")
      .isVisible(),
  );
  console.log("PASS connected Strava state and sync preference retained");
  await page.close();
} finally {
  await browser.close();
}
