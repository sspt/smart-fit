import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const [width, height, reference] of [
    [320, 640, 5],
    [412, 844, 2.5],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.FIT_TEST_URL || "http://localhost:4173");
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await page.getByText("More connection options", { exact: true }).click();
    await page
      .getByRole("button", { name: "Explore demo", exact: true })
      .click();
    await page.locator(".setup-programme").first().click();
    await page
      .locator(".phone-video-picker input")
      .setInputFiles("/workspace/scenery-downloads/forest-walk-v1.mp4");
    const speed = page.getByLabel("Video reference speed (km/h)", {
      exact: true,
    });
    assert.equal(await speed.inputValue(), "5");
    await speed.fill(String(reference));
    await speed.blur();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    );
    assert.equal(overflow, false);
    await page.screenshot({ path: `/tmp/fit-phone-review-${width}.png` });
    await page
      .getByRole("button", { name: "Start journey", exact: true })
      .click();
    await page.waitForFunction((ref) => {
      const v = document.querySelector(".native-video");
      return (
        v?.src.startsWith("blob:") &&
        v.videoWidth > 0 &&
        !v.paused &&
        v.currentTime > 0.1 &&
        Math.abs(v.playbackRate - 3.5 / ref) < 0.01
      );
    }, reference);
    await page
      .getByRole("button", { name: "Pause workout", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector(".native-video").paused,
    );
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS ${width}px phone file, default/custom reference, real decoding, speed sync and pause.`,
    );
  }
} finally {
  await browser.close();
}
