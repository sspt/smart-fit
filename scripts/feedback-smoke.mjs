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
    await page.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
    await page.getByRole("button", { name: "Start", exact: true }).waitFor();
    await page.waitForFunction(async () => {
      const db = await new Promise((r) => {
        const q = indexedDB.open("smart-fit", 1);
        q.onsuccess = () => r(q.result);
      });
      return await new Promise((r) => {
        const q = db.transaction("data").objectStore("data").get("history");
        q.onsuccess = () => {
          db.close();
          r(q.result !== undefined);
        };
      });
    });
    await page.evaluate(async () => {
      const db = await new Promise((resolve, reject) => {
        const r = indexedDB.open("smart-fit", 1);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
      const tx = db.transaction("data", "readwrite");
      const programme = {
        id: "feedback-test",
        name: "Feedback test",
        kind: "Treadmill",
        repeat: 1,
        blocks: [
          {
            name: "Warm",
            duration: 30,
            speed: 5,
            incline: 0,
            power: 100,
            resistance: 3,
          },
          {
            name: "Steady",
            duration: 30,
            speed: 6,
            incline: 2,
            power: 100,
            resistance: 3,
          },
        ],
      };
      const active = {
        id: "active-test",
        programme,
        started: Date.now(),
        elapsed: 23,
        phase: 0,
        cycle: 0,
        phaseElapsed: 23,
        phaseDistance: 0,
        distance: 150,
        status: "active",
        demo: true,
        automatic: true,
        controlMode: "automatic",
        samples: [{ at: 1, speed: 5, power: 100, distance: 1, resistance: 3 }],
        events: [],
      };
      tx.objectStore("data").put(active, "active");
      tx.objectStore("data").put(
        [
          {
            ...active,
            id: "previous",
            started: Date.now() - 60000,
            status: "completed",
            distance: 140,
          },
          {
            ...active,
            id: "real",
            demo: false,
            elapsed: 120,
            status: "completed",
          },
        ],
        "history",
      );
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    await page.reload();
    await page.locator(".active-session").click();
    await page
      .getByRole("button", { name: "Resume programme", exact: true })
      .click();
    const openVideo = page.getByRole("button", {
      name: "Open video",
      exact: true,
    });
    if (await openVideo.isVisible()) await openVideo.click();
    // Check cue after entering immersion.
    const immersive = page.getByRole("button", {
      name: /immersive|full.screen/i,
    });
    if (await immersive.count()) await immersive.first().click();
    // Cue is computed only while running; verify it in the scenery overlay markup.
    await page.locator(".interval-cue").waitFor({ state: "attached" });
    assert.match(
      await page.locator(".interval-cue").textContent(),
      /Next: Steady/,
    );
    const exit = page.getByRole("button", { name: "Exit immersive view" });
    if (await exit.isVisible()) await exit.click();
    await page
      .getByRole("button", { name: "Stop & finish", exact: true })
      .click();
    await page.getByRole("region", { name: "Workout recap" }).waitFor();
    assert.match(
      await page.locator(".workout-recap").innerText(),
      /Previous attempt/,
    );
    assert.match(
      await page.locator(".weekly-progress").innerText(),
      /1 session · 2 minutes/,
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await page.getByRole("button", { name: "Dismiss workout recap" }).click();
    assert.equal(await page.locator(".workout-recap").count(), 0);
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px: interval cue, recap, previous attempt, weekly total and dismissal`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
