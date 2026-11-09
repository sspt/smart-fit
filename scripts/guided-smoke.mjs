import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const [width, kind] of [
    [320, "Treadmill"],
    [412, "Bike"],
    [1280, "Rower"],
  ]) {
    const context = await browser.newContext({
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.FIT_TEST_URL || "http://localhost:8787");
    await page.getByRole("heading", { name: "The world can wait." }).waitFor();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    const wizard = page.getByRole("region", { name: "Set up your journey" });
    await wizard
      .getByRole("heading", { name: "Connect your equipment." })
      .waitFor();
    assert.equal(
      await wizard
        .getByRole("button", { name: "Continue", exact: true })
        .count(),
      0,
    );
    await wizard
      .getByRole("button", { name: new RegExp("^" + kind + " ") })
      .click();
    await wizard.getByText("More connection options", { exact: true }).click();
    await wizard
      .getByRole("button", { name: "Explore demo", exact: true })
      .click();
    await wizard.getByRole("heading", { name: "Find your rhythm." }).waitFor();
    assert.equal(await wizard.locator(".setup-programme").count(), 3);
    assert.equal(
      await wizard.locator(".setup-footer button").count(),
      0,
      "no redundant Next button",
    );
    await wizard
      .locator(".setup-programme")
      .filter({ has: page.locator(".setup-duration", { hasText: "30 min" }) })
      .click();
    await wizard
      .getByRole("heading", { name: "Choose your elsewhere." })
      .waitFor();
    assert.equal(await wizard.locator(".setup-footer button").count(), 0);
    await page.screenshot({ path: `/tmp/fit-simple-scene-${width}.png` });
    await wizard.locator(".setup-scene").click();
    await wizard.getByRole("heading", { name: "Your scene is set." }).waitFor();
    await wizard
      .getByRole("button", { name: "Change scene", exact: true })
      .click();
    assert.equal(
      await wizard.locator(".setup-scene").getAttribute("aria-pressed"),
      "true",
    );
    await wizard.locator(".setup-scene").click();
    assert.equal(
      await page.locator(".active-session").count(),
      0,
      "no workout before explicit start",
    );
    assert.equal(await wizard.locator(".setup-footer button").count(), 1);
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({ path: `/tmp/fit-simple-review-${width}.png` });
    await wizard
      .getByRole("button", { name: "Start journey", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Scenic video" }).waitFor();
    const expected = {
      Treadmill: "forest-walk-v1",
      Bike: "autumn-cycle-v3",
      Rower: "river-canoe-v2",
    }[kind];
    await page.waitForFunction((expected) => {
      const v = document.querySelector(".native-video");
      return (
        v?.src.includes(expected) &&
        v.videoWidth > 0 &&
        !v.paused &&
        v.currentTime > 0.1
      );
    }, expected);
    const bounds = await page.locator(".native-video").boundingBox();
    assert.equal(Math.round(bounds.width), width);
    assert.equal(Math.round(bounds.height), 900);
    await page
      .getByRole("button", { name: "Pause workout", exact: true })
      .click();
    await page.waitForFunction(
      () => document.querySelector(".native-video").paused,
    );
    await page
      .getByRole("button", { name: "Resume workout", exact: true })
      .click();
    await page.waitForFunction(
      () => !document.querySelector(".native-video").paused,
    );
    if (kind === "Bike") {
      await page
        .getByRole("button", { name: "Pause workout", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Exit immersive view", exact: true })
        .click();
      page.on("dialog", (d) => d.accept());
      await page.reload();
      await page
        .getByRole("alert")
        .filter({ hasText: "Recovered workout" })
        .waitFor();
      await page
        .getByRole("navigation")
        .getByRole("button", { name: "Live", exact: true })
        .click();
      assert.equal(
        await page.locator(".video-mode.expanded").count(),
        0,
        "no auto-resume after recovery",
      );
      await page
        .getByRole("button", { name: "Resume programme", exact: true })
        .click();
      await page.getByRole("dialog", { name: "Scenic video" }).waitFor();
      await page.waitForFunction(
        () => !document.querySelector(".native-video").paused,
      );
      assert(
        (await page.locator(".native-video").getAttribute("src")).includes(
          expected,
        ),
      );
    }
    await page
      .getByRole("button", { name: "Stop workout", exact: true })
      .click();
    await page.getByRole("heading", { name: "Your journey." }).waitFor();
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Home", exact: true })
      .click();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await wizard.getByRole("heading", { name: "Your scene is set." }).waitFor();
    assert.equal(
      await page.locator(".active-session").count(),
      0,
      "remembered setup still needs Start",
    );
    await wizard
      .getByRole("button", { name: "Change programme", exact: true })
      .click();
    await wizard
      .locator(".setup-programme")
      .filter({ has: page.locator(".setup-duration", { hasText: "15 min" }) })
      .click();
    await wizard.getByRole("heading", { name: "Your scene is set." }).waitFor();
    assert(
      (await wizard.locator(".setup-review").innerText()).includes("15 min"),
    );
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Home", exact: true })
      .click();
    await page.reload();
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await wizard
      .getByRole("heading", { name: "Connect your equipment." })
      .waitFor();
    await wizard.getByText("More connection options", { exact: true }).click();
    await wizard
      .getByRole("button", { name: "Explore demo", exact: true })
      .click();
    await wizard.getByRole("heading", { name: "Your scene is set." }).waitFor();
    assert(
      (await wizard.locator(".setup-review").innerText()).includes("30 min"),
      "only actually started choices are remembered",
    );
    assert.equal(await page.locator(".active-session").count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS ${width}px ${kind}: tap-to-advance, explicit start, real playback and session controls, repeat shortcut, edit selections, saved choices after reload; recovery requires explicit resume.`,
    );
  }
} finally {
  await browser.close();
}
