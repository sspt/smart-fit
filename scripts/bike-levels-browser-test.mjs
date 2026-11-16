import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { serveWorkoutFixture } from "./workout-fixture.mjs";
const { origin, close } = await serveWorkoutFixture();
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const { ifit, dual } of [
    { ifit: false, dual: false },
    { ifit: true, dual: false },
    { ifit: false, dual: true },
  ]) {
    const page = await browser.newPage({
        viewport: { width: 320, height: 740 },
        serviceWorkers: "block",
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/api/auth/status", (r) =>
      r.fulfill({
        json: {
          configured: false,
          user: null,
          providers: { google: false, strava: false },
          linked: [],
        },
      }),
    );
    await page.route("**/api/strava/status", (r) =>
      r.fulfill({ json: { configured: true, connected: false } }),
    );
    await page.addInitScript(
      ({ ifit, dual }) => {
        window.__commands = [];
        window.__fixture = {
          ifit,
          connected: true,
          running: true,
          features: {
            speed: false,
            incline: false,
            power: dual,
            resistance: true,
          },
          ranges: ifit
            ? {}
            : {
                resistance: { min: 1, max: 16, increment: 1 },
                power: { min: 0, max: 400, increment: 5 },
              },
          metrics: {
            speedKmh: 20,
            powerW: 180,
            resistanceLevel: 4,
            totalDistanceM: 0,
          },
        };
        Element.prototype.requestFullscreen = undefined;
      },
      { ifit, dual },
    );
    await page.goto(origin);
    await page.getByRole("button", { name: "Start", exact: true }).waitFor();
    await page.evaluate(async () => {
      const db = await new Promise((resolve) => {
        const r = indexedDB.open("smart-fit", 1);
        r.onsuccess = () => resolve(r.result);
      });
      const programme = {
        id: "bike-level-fixture",
        name: "Level workout",
        kind: "Bike",
        repeat: 1,
        blocks: [
          {
            name: "Steady",
            duration: 600,
            power: 100,
            speed: 5,
            incline: 0,
            resistance: 3,
          },
        ],
      };
      const tx = db.transaction("data", "readwrite");
      tx.objectStore("data").put(
        {
          id: "bike-level-session",
          programme,
          started: Date.now(),
          elapsed: 0,
          status: "active",
          demo: false,
          samples: [],
          events: [],
          automatic: false,
          controlMode: "follow",
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
    });
    await page.reload();
    await page.locator(".active-session").click();
    const modes = page.locator(".live-tools");
    assert.equal(
      await modes
        .getByRole("button", { name: "Automatic", exact: true })
        .isDisabled(),
      !dual,
    );
    assert.equal(
      await modes
        .getByRole("button", { name: "Manual", exact: true })
        .isDisabled(),
      false,
    );
    await modes.getByRole("button", { name: "Manual", exact: true }).click();
    const panel = page.locator(".live-screen > .workout-adjustments");
    await panel.locator("summary").click();
    const level = panel.getByRole("spinbutton", {
      name: "Set resistance (level)",
      exact: true,
    });
    assert(await level.isDisabled());
    assert.equal(await level.inputValue(), "4");
    assert.equal(await level.getAttribute("max"), ifit ? "6" : "16");
    assert.equal(
      await panel
        .getByRole("spinbutton", { name: "Set power (W)", exact: true })
        .count(),
      dual ? 1 : 0,
    );
    assert.equal(
      await panel.getByRole("spinbutton", { name: /Set speed/ }).count(),
      0,
    );
    await page
      .getByRole("button", { name: "Resume programme", exact: true })
      .click();
    await page.waitForFunction(() =>
      window.__commands.some((c) => c[0] === "start"),
    );
    await page.waitForFunction(
      () => !document.querySelector(".session-actions button")?.disabled,
    );
    assert.equal(
      (
        await page.evaluate(() =>
          window.__commands.filter((c) => ["power", "speed"].includes(c[0])),
        )
      ).length,
      0,
      "Manual resume must not send programme watts or speed",
    );
    await level.fill("5");
    await level
      .locator("xpath=ancestor::form")
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    await panel
      .getByRole("status")
      .filter({ hasText: "Resistance request sent." })
      .waitFor();
    assert.deepEqual(
      await page.evaluate(() =>
        window.__commands.filter((c) =>
          ["speed", "power", "resistance"].includes(c[0]),
        ),
      ),
      [["resistance", 5]],
    );
    await page.getByRole("button", { name: "Session", exact: true }).click();
    const readings = page.locator(".readings-panel .metric-grid");
    assert((await readings.innerText()).includes("Resistance"));
    assert((await readings.innerText()).includes("4"));
    await page.getByRole("button", { name: "Pause", exact: true }).click();
    await page.waitForFunction(() =>
      window.__commands.some((c) => c[0] === "pause"),
    );
    assert(await level.isDisabled());
    await page
      .getByRole("button", { name: "Resume programme", exact: true })
      .click();
    await page.waitForFunction(
      () => window.__commands.filter((c) => c[0] === "start").length === 2,
    );
    await page.getByRole("button", { name: "Scenery", exact: true }).click();
    await page.getByRole("button", { name: "Open video", exact: true }).click();
    await page
      .getByRole("button", { name: "Immersive view", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Scenic video" });
    assert(
      (await dialog.locator(".immersion-readings").innerText()).includes(
        "RESISTANCE",
      ),
    );
    await dialog.locator(".workout-adjustments summary").click();
    const immersedLevel = dialog.getByRole("spinbutton", {
      name: "Set resistance (level)",
      exact: true,
    });
    await immersedLevel.fill("6");
    await immersedLevel
      .locator("xpath=ancestor::form")
      .getByRole("button", { name: "Apply", exact: true })
      .click();
    await dialog
      .getByRole("status")
      .filter({ hasText: "Resistance request sent." })
      .waitFor();
    assert.deepEqual(
      await page.evaluate(() =>
        window.__commands.filter((c) =>
          ["speed", "power", "resistance"].includes(c[0]),
        ),
      ),
      [
        ["resistance", 5],
        ["resistance", 6],
      ],
    );
    await page.screenshot({
      path: `artifacts/bike-levels-${ifit ? "ifit" : dual ? "dual" : "ftms"}.png`,
    });
    await dialog
      .getByRole("button", { name: "Stop workout", exact: true })
      .click();
    await page.getByRole("region", { name: "Workout recap" }).waitFor();
    await page.waitForFunction(() =>
      window.__commands.some((c) => c[0] === "disconnect"),
    );
    assert(
      (await page.evaluate(() => window.__commands.map((c) => c[0]))).includes(
        "stop",
      ),
    );
    if (!dual) {
      await page.evaluate(async () => {
        const db = await new Promise((resolve) => {
          const r = indexedDB.open("smart-fit", 1);
          r.onsuccess = () => resolve(r.result);
        });
        const tx = db.transaction("data", "readwrite");
        tx.objectStore("data").put({ kind: "Bike" }, "lastJourney");
        await new Promise((resolve) => (tx.oncomplete = resolve));
        db.close();
      });
      await page.reload();
      await page.getByRole("button", { name: "Start", exact: true }).click();
      await page.locator(".setup-programme").first().click();
      await page.locator(".setup-scene").click();
      await page
        .getByText("Manual resistance · adjust levels during your workout", {
          exact: true,
        })
        .waitFor();
      await page
        .getByRole("button", { name: "Start journey", exact: true })
        .click();
      const freshDialog = page.getByRole("dialog", { name: "Scenic video" });
      await freshDialog.waitFor();
      assert.equal(
        await freshDialog
          .getByRole("button", { name: "Manual", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
      await page.waitForFunction(() =>
        window.__commands.some((c) => c[0] === "start"),
      );
      assert.equal(
        (
          await page.evaluate(() =>
            window.__commands.filter((c) =>
              ["power", "speed", "resistance"].includes(c[0]),
            ),
          )
        ).length,
        0,
        "Fresh manual journeys must not translate watts into levels",
      );
      await freshDialog
        .getByRole("button", { name: "Stop workout", exact: true })
        .click();
      await page.getByRole("region", { name: "Workout recap" }).waitFor();
    }
    assert.deepEqual(errors, []);
    await page.close();
    console.log(
      `${ifit ? "iFIT" : dual ? "Dual-target FTMS" : "Resistance-only FTMS"} bike: levels, measured resistance, manual resume, pause, immersive control and stop passed`,
    );
  }
} finally {
  await browser.close();
  await close();
}
