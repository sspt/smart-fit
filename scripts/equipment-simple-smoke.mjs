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
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "bluetooth", {
        value: {
          requestDevice: async (options) => {
            window.pickerOptions = options;
            throw new DOMException("Cancelled", "NotFoundError");
          },
        },
      });
    });
    await page.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
    await page
      .getByRole("button", { name: "Equipment connection", exact: true })
      .click();
    const panel = page.locator(".equipment-screen");
    assert.deepEqual(await panel.getByRole("button").allTextContents(), [
      "Connect equipment",
      "Export diagnostics",
    ]);
    assert.equal(await panel.locator("details").count(), 0);
    await panel.getByLabel("Equipment type").selectOption("Bike");
    await panel
      .getByRole("button", { name: "Connect equipment", exact: true })
      .click();
    await page.waitForFunction(() => !!window.pickerOptions);
    assert(
      (await page.evaluate(() => window.pickerOptions)).filters.length > 0,
    );
    const download = page.waitForEvent("download");
    await panel
      .getByRole("button", { name: "Export diagnostics", exact: true })
      .click();
    const file = await download;
    assert.match(file.suggestedFilename(), /diagnostics.json$/);
    const stream = await file.createReadStream(),
      chunks = [];
    for await (const c of stream) chunks.push(c);
    assert.equal(typeof JSON.parse(Buffer.concat(chunks).toString()), "object");
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
    // The shared guided setup uses the same compact panel.
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Home", exact: true })
      .click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.locator(".equipment-screen").waitFor();
    assert.deepEqual(
      await page
        .locator(".equipment-screen")
        .getByRole("button")
        .allTextContents(),
      ["Connect equipment", "Export diagnostics"],
    );
    console.log(
      `PASS ${width}px: two equipment actions, filtered Bluetooth picker, diagnostics download and guided setup`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
