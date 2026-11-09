import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const fallback of [false, true]) {
    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      isMobile: true,
      hasTouch: true,
    });
    if (fallback)
      await context.addInitScript(() => {
        const original = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function (type, ...args) {
          if (String(type).includes("webgl")) return null;
          return original.call(this, type, ...args);
        };
      });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4173");
    await page.getByRole("button", { name: "Equipment", exact: true }).click();
    await page.getByText("More connection options", { exact: true }).click();
    await page.getByRole("button", { name: "Explore demo" }).click();
    await page.getByRole("button", { name: "Home", exact: true }).click();
    await page
      .getByRole("button", { name: "Start 15 min · Easy walk", exact: true })
      .click();
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => !!navigator.serviceWorker.controller);
    await context.setOffline(true);
    await page.getByRole("button", { name: "Open scenery" }).click();
    await page.locator(".forest-host canvas").waitFor();
    await page.waitForTimeout(1500);
    assert.equal(await page.locator(".forest-host canvas").count(), 1);
    await page
      .getByRole("button", { name: "Immersive view", exact: true })
      .click();
    const scene = page.getByRole("region", { name: "Scenic mode" });
    const box = await scene.boundingBox();
    assert.equal(box.x, 0);
    assert.equal(box.y, 0);
    await page
      .getByRole("button", { name: "Pause workout", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Resume workout", exact: true })
      .waitFor();
    await page.waitForTimeout(250);
    const before = await page.locator(".forest-host canvas").screenshot();
    await page.waitForTimeout(200);
    const after = await page.locator(".forest-host canvas").screenshot();
    assert.ok(before.equals(after), "paused scenery stays still");
    await page.screenshot({
      path: `/tmp/fit-scenery-${fallback ? "simple" : "3d"}.png`,
    });
    await page.setViewportSize({ width: 915, height: 412 });
    assert.ok(
      await page
        .getByRole("button", { name: "Stop workout", exact: true })
        .isVisible(),
    );
    await page
      .getByRole("button", { name: "Stop workout", exact: true })
      .click();
    await page.getByRole("heading", { name: "Your journey." }).waitFor();
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      "PASS scenery " +
        (fallback ? "Canvas fallback" : "WebGL") +
        ": mobile expansion, pause freezes movement, landscape controls, stop archives.",
    );
  }
} finally {
  await browser.close();
}
