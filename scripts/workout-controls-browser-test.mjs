// Exercise the production UI with isolated simulated hardware. The deployed assets are never modified.
import { serveWorkoutFixture } from "./workout-fixture.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const { origin, close } = await serveWorkoutFixture();
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const kind of ["Treadmill", "Bike", "Rower"]) {
    const page = await browser.newPage({
      viewport: { width: 320, height: 740 },
      serviceWorkers: "block",
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/auth/status", (r) =>
      r.fulfill({
        json: {
          configured: false,
          user: null,
          providers: { google: false, strava: false },
          linked: [],
          local: false,
        },
      }),
    );
    await page.addInitScript(() => {
      window.__commands = [];
      window.__fixture = {
        connected: true,
        running: true,
        features: { speed: true, incline: true, power: true, resistance: true },
        ranges: {
          speed: { min: 1, max: 18, increment: 0.5 },
          incline: { min: 0, max: 8, increment: 1 },
          power: { min: 0, max: 400, increment: 5 },
          resistance: { min: 1, max: 20, increment: 1 },
        },
        metrics: { speedKmh: 5, powerW: 0, inclinePct: 0, totalDistanceM: 0 },
      };
      Element.prototype.requestFullscreen = undefined;
    });
    await page.goto(origin);
    await page.getByRole("button", { name: "Start", exact: true }).waitFor();
    await page.evaluate(async (kind) => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("smart-fit", 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const b = {
        name: "First",
        duration: 600,
        distance: 10,
        speed: 5,
        incline: 0,
        power: 100,
        resistance: 3,
      };
      const programme = {
        id: "fixture",
        name: "Control test",
        kind,
        repeat: 1,
        blocks: [
          b,
          {
            ...b,
            name: "Second",
            distance: undefined,
            speed: 8,
            power: 200,
            resistance: 6,
          },
        ],
      };
      const tx = db.transaction("data", "readwrite");
      tx.objectStore("data").put(
        {
          id: "session",
          programme,
          started: Date.now(),
          elapsed: 0,
          status: "active",
          demo: false,
          samples: [],
          events: [],
          automatic: true,
          controlMode: "automatic",
          phase: 0,
          cycle: 0,
          phaseElapsed: 0,
          phaseDistance: 0,
          distance: 0,
        },
        "active",
      );
      await new Promise((resolve) => (tx.oncomplete = resolve));
      db.close();
    }, kind);
    await page.reload();
    await page.locator(".active-session").click();
    const panel = page.locator(".live-screen > .workout-adjustments");
    await panel.locator("summary").click();
    const key =
      kind === "Treadmill" ? "speed" : kind === "Bike" ? "power" : "resistance";
    const input = panel.getByRole("spinbutton", {
      name: new RegExp("Set " + key),
    });
    assert(
      await input.isDisabled(),
      "Recovered sessions cannot adjust until explicitly resumed",
    );
    await page
      .getByRole("button", { name: "Resume programme", exact: true })
      .click();
    await page.waitForFunction(() =>
      window.__commands.some((c) => c[0] === "start"),
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".session-actions button")?.disabled === false,
    );
    await page.evaluate(() => (window.__commands = []));
    await input.fill(key === "speed" ? "6" : key === "power" ? "123" : "5");
    await input
      .locator("xpath=ancestor::form")
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    await panel
      .getByRole("status")
      .filter({ hasText: "request sent" })
      .waitFor();
    assert.deepEqual(await page.evaluate(() => window.__commands), [
      [key, key === "speed" ? 6 : key === "power" ? 125 : 5],
    ]);
    assert.equal(
      await page
        .locator(".live-tools")
        .getByRole("button", { name: "Manual", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await page.evaluate(() => (window.__fixture.metrics.totalDistanceM = 12));
    await page.waitForTimeout(1200);
    assert.equal(
      (await page.evaluate(() => window.__commands)).length,
      1,
      "Programme transition must not overwrite manual target",
    );
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForFunction(() =>
      window.__commands.some((c) => c[0] === "pause"),
    );
    assert(await input.isDisabled());
    await page
      .getByRole("button", { name: "Resume programme", exact: true })
      .click();
    await page.waitForFunction(
      () => window.__commands.filter((c) => c[0] === "start").length === 1,
    );
    await page.waitForTimeout(250);
    assert.equal(
      (
        await page.evaluate(() =>
          window.__commands.filter((c) =>
            ["speed", "incline", "power", "resistance"].includes(c[0]),
          ),
        )
      ).length,
      1,
      "Resume holds programme targets in Manual mode",
    );
    await page.getByRole("button", { name: "Session", exact: true }).click();
    const metrics = page.locator(".readings-panel .metric-grid");
    assert.equal(await metrics.locator(".metric").count(), 2);
    assert(!(await metrics.innerText()).includes("Heart rate"));
    await page.evaluate(() => {
      window.__fixture.metrics.speedKmh = null;
      window.__fixture.metrics.powerW = null;
    });
    await page.waitForFunction(
      () =>
        document.querySelector(".readings-panel .metric-grid").children
          .length === 0,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.getByRole("button", { name: "Scenery", exact: true }).click();
    await page.getByRole("button", { name: "Open video", exact: true }).click();
    await page
      .getByRole("button", { name: "Immersive view", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Scenic video" });
    await dialog.locator(".workout-adjustments summary").click();
    assert.equal(
      await panel.evaluate((e) => e.inert),
      true,
      "Background equipment controls must be inert",
    );
    for (const viewport of [
      { width: 320, height: 740 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      const stop = dialog.getByRole("button", {
        name: "Stop workout",
        exact: true,
      });
      const bounds = await stop.boundingBox();
      assert(
        bounds && bounds.y >= 0 && bounds.y + bounds.height <= viewport.height,
        "Stop remains visible",
      );
      await page.screenshot({
        path: `artifacts/workout-controls-${kind}-${viewport.width}.png`,
      });
    }
    await dialog
      .getByRole("button", { name: "Exit immersive view", exact: true })
      .click();
    if (kind === "Bike") {
      await page.getByRole("button", { name: "Session", exact: true }).click();
      await page.evaluate(() => {
        window.__fixture.fail = "power";
      });
      await input.fill("160");
      await input
        .locator("xpath=ancestor::form")
        .getByRole("button", { name: "Apply", exact: true })
        .click();
      await panel
        .getByRole("status")
        .filter({ hasText: "Machine rejected target" })
        .waitFor();
      assert(await input.isDisabled(), "Failed requests pause session control");
      assert(!(await panel.innerText()).includes("Power request sent."));
    }
    await page
      .getByRole("button", { name: "Stop & finish", exact: true })
      .click();
    await page.waitForFunction(() =>
      window.__commands.some((c) => c[0] === "stop"),
    );
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `${kind}: manual targets, pause/resume, stop, missing readings, mobile immersive layout passed`,
    );
  }
} finally {
  await browser.close();
  await close();
}
