import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { serveWorkoutFixture } from "./workout-fixture.mjs";
const { origin, close } = await serveWorkoutFixture();
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const errors = [];
async function setup({
  duration = 3,
  distance,
  mode = "automatic",
  strava = true,
  fail = "",
  retry = false,
  statusDelay = 0,
  ifit = false,
} = {}) {
  const page = await browser.newPage({
    viewport: { width: 320, height: 740 },
    serviceWorkers: "block",
  });
  page.on("pageerror", (e) => errors.push(e.message));
  const uploads = [];
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
  await page.route("**/api/strava/status", async (r) => {
    if (statusDelay)
      await new Promise((resolve) => setTimeout(resolve, statusDelay));
    return r.fulfill({
      json: {
        configured: true,
        connected: strava,
        ...(strava ? { athlete: { id: 77, name: "Fixture athlete" } } : {}),
      },
    });
  });
  await page.route("**/api/strava/upload", async (r) => {
    uploads.push(r.request().postDataJSON());
    await r.fulfill(
      retry && uploads.length === 1
        ? { status: 503, json: { error: "Temporary outage" } }
        : { json: { state: "synced", activityId: 12345 } },
    );
  });
  await page.addInitScript(
    ({ fail, ifit }) => {
      window.__commands = [];
      window.__fixture = {
        connected: true,
        running: true,
        fail,
        ifit,
        delay: "stop",
        features: { speed: true, incline: true, power: true, resistance: true },
        ranges: {
          speed: { min: 1, max: 18, increment: 0.5 },
          incline: { min: 0, max: 8, increment: 1 },
        },
        metrics: { speedKmh: 5, inclinePct: 0, totalDistanceM: 0 },
      };
      Element.prototype.requestFullscreen = undefined;
      window.__data = async (key) => {
        const db = await new Promise((resolve, reject) => {
          const r = indexedDB.open("smart-fit", 1);
          r.onsuccess = () => resolve(r.result);
          r.onerror = () => reject(r.error);
        });
        try {
          return await new Promise((resolve, reject) => {
            const r = db.transaction("data").objectStore("data").get(key);
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
          });
        } finally {
          db.close();
        }
      };
    },
    { fail, ifit },
  );
  await page.goto(origin);
  await page.getByRole("button", { name: "Start", exact: true }).waitFor();
  await page.evaluate(
    async ({ duration, distance, mode }) => {
      const db = await new Promise((resolve) => {
        const r = indexedDB.open("smart-fit", 1);
        r.onsuccess = () => resolve(r.result);
      });
      const programme = {
        id: "completion-fixture",
        name: "Completion test",
        kind: "Treadmill",
        repeat: 1,
        blocks: [
          {
            name: "Final interval",
            duration,
            distance,
            speed: 5,
            incline: 0,
            power: 100,
            resistance: 3,
          },
        ],
      };
      const session = {
        id: "completion-session",
        programme,
        started: Date.now(),
        elapsed: 0,
        status: "active",
        demo: false,
        samples: [],
        events: [],
        automatic: true,
        controlMode: mode,
        phase: 0,
        cycle: 0,
        phaseElapsed: 0,
        phaseDistance: distance ? distance - 5 : 0,
        distance: 0,
      };
      const tx = db.transaction("data", "readwrite");
      for (const [k, v] of Object.entries({
        active: session,
        stravaAutomatic: false,
        knownDevice: {
          id: "fixture",
          name: "Fixture",
          kind: "Treadmill",
          protocol: "FTMS",
        },
        autoConnect: true,
      }))
        tx.objectStore("data").put(v, k);
      await new Promise((resolve) => (tx.oncomplete = resolve));
      db.close();
    },
    { duration, distance, mode },
  );
  await page.reload();
  await page.locator(".active-session").click();
  return { page, uploads };
}
async function untilData(page, key, predicate) {
  for (let n = 0; n < 150; n++) {
    const value = await page.evaluate((key) => window.__data(key), key);
    if (predicate(value)) return value;
    await page.waitForTimeout(100);
  }
  throw Error(
    `Timed out waiting for ${key}: ` +
      JSON.stringify(await page.evaluate((key) => window.__data(key), key)),
  );
}
async function resume(page) {
  await page
    .getByRole("button", { name: "Resume programme", exact: true })
    .click();
  await page.waitForFunction(() =>
    window.__commands.some((c) => c[0] === "start"),
  );
  await page.waitForFunction(
    () => !document.querySelector(".session-actions button")?.disabled,
  );
}
async function stop(page) {
  await page.evaluate(() => {
    const b = document.querySelector(".session-actions button.danger");
    b.click();
    b.click();
  });
  await page.getByRole("region", { name: "Workout recap" }).waitFor();
  await page.waitForFunction(() =>
    window.__commands.some((c) => c[0] === "disconnect"),
  );
  const commands = await page.evaluate(() =>
    window.__commands.map((c) => c[0]),
  );
  assert.equal(
    commands.filter((c) => c === "stop").length,
    1,
    "Repeated Stop must stop once",
  );
  assert.equal(
    commands.filter((c) => c === "disconnect").length,
    1,
    "Disconnect once",
  );
  assert(commands.indexOf("stop") < commands.indexOf("disconnect"));
  assert(
    !commands.includes("connect"),
    "No automatic reconnection after finishing",
  );
}
try {
  {
    const { page, uploads } = await setup();
    await resume(page);
    await page
      .locator(".live-screen > .workout-continuation")
      .getByRole("button", { name: "Continue for 10 min" })
      .click();
    await page.waitForFunction(
      async () => (await window.__data("active"))?.extensionSeconds === 600,
    );
    await page.waitForFunction(
      async () => (await window.__data("active"))?.cycle === 1,
    );
    assert(
      !(await page.evaluate(() => window.__commands.map((c) => c[0]))).includes(
        "stop",
      ),
    );
    assert.equal(
      uploads.length,
      0,
      "No sync or disconnect at the original endpoint",
    );
    await page.reload();
    await page.locator(".active-session").click();
    assert.equal(
      (await page.evaluate(() => window.__data("active"))).extensionSeconds,
      600,
      "Extra time survives recovery",
    );
    assert.equal(
      (await page.evaluate(() => window.__commands)).length,
      0,
      "Recovery never starts the machine",
    );
    await resume(page);
    await stop(page);
    await page.waitForFunction(
      async () =>
        (await window.__data("stravaOutbox"))?.[0]?.state === "synced",
    );
    assert.equal(uploads.length, 1, "Syncs with legacy automatic setting off");
    assert.equal(uploads[0].id, "completion-session");
    assert(uploads[0].tcx.includes("TrainingCenterDatabase"));
    const history = await page.evaluate(() => window.__data("history"));
    assert.equal(history.length, 1);
    assert.equal(history[0].programme.blocks[0].duration, 3);
    assert.equal(history[0].extensionSeconds, 600);
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await page
      .getByText(
        "Completed workouts sync automatically when Strava is connected. Older workouts can be synced from your Journal.",
        { exact: true },
      )
      .waitFor();
    assert.equal(
      await page
        .getByRole("checkbox", {
          name: "Automatically sync new completed workouts",
        })
        .count(),
      0,
    );
    await page.close();
    console.log(
      "Timed continuation, recovery, single save/stop/disconnect and seamless Strava upload passed",
    );
  }
  {
    const { page, uploads } = await setup({
      distance: 1000,
      duration: 600,
      mode: "manual",
      strava: false,
      ifit: true,
    });
    await resume(page);
    await page.getByRole("button", { name: "Open video", exact: true }).click();
    await page
      .getByRole("button", { name: "Immersive view", exact: true })
      .click();
    const dialog = page.getByRole("dialog", { name: "Scenic video" });
    for (const viewport of [
      { width: 320, height: 740 },
      { width: 844, height: 390 },
    ]) {
      await page.setViewportSize(viewport);
      for (const name of ["Continue for 10 min", "Stop workout"]) {
        const bounds = await dialog
          .getByRole("button", { name, exact: true })
          .boundingBox();
        assert(
          bounds &&
            bounds.y >= 0 &&
            bounds.y + bounds.height <= viewport.height,
          `${name} remains visible`,
        );
      }
      await page.screenshot({
        path: `artifacts/workout-continuation-${viewport.width}.png`,
      });
    }
    await dialog.getByRole("button", { name: "Continue for 10 min" }).click();
    await page.waitForFunction(
      async () => (await window.__data("active"))?.extensionSeconds === 600,
    );
    await page.waitForTimeout(350);
    await page.evaluate(() => (window.__fixture.metrics.totalDistanceM = 12));
    await page.waitForFunction(
      async () => (await window.__data("active"))?.cycle === 1,
    );
    assert.equal(
      (
        await page.evaluate(() =>
          window.__commands.filter((c) => ["speed", "incline"].includes(c[0])),
        )
      ).length,
      0,
      "Manual targets remain held during extra time",
    );
    await dialog
      .getByRole("button", { name: "Exit immersive view", exact: true })
      .click();
    await stop(page);
    assert.equal(uploads.length, 0, "Disconnected Strava never uploads");
    await page.close();
    console.log(
      "Immersive distance continuation preserves Manual mode and disconnects without Strava passed",
    );
  }
  {
    const { page, uploads } = await setup({ duration: 2, retry: true });
    await resume(page);
    await page.getByRole("region", { name: "Workout recap" }).waitFor();
    await page.waitForFunction(
      async () => (await window.__data("stravaOutbox"))?.[0]?.retryAfter > 0,
    );
    assert.equal(uploads.length, 1);
    assert(
      (await page.evaluate(() => window.__commands.map((c) => c[0]))).includes(
        "disconnect",
      ),
    );
    await page.evaluate(async () => {
      const jobs = await window.__data("stravaOutbox");
      jobs[0].retryAfter = 0;
      const db = await new Promise((resolve) => {
        const r = indexedDB.open("smart-fit", 1);
        r.onsuccess = () => resolve(r.result);
      });
      const tx = db.transaction("data", "readwrite");
      tx.objectStore("data").put(jobs, "stravaOutbox");
      await new Promise((resolve) => (tx.oncomplete = resolve));
      db.close();
    });
    await page.reload();
    await page.waitForFunction(
      async () =>
        (await window.__data("stravaOutbox"))?.[0]?.state === "synced",
    );
    await untilData(
      page,
      "stravaOutbox",
      (jobs) => jobs?.[0]?.state === "synced",
    );
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].id, uploads[1].id);
    assert.equal(
      (await page.evaluate(() => window.__data("history"))).length,
      1,
    );
    await page.close();
    console.log(
      "Normal completion disconnects promptly; failed Strava upload persists and retries after reload passed",
    );
  }
  {
    const { page, uploads } = await setup({ duration: 600, fail: "stop" });
    await resume(page);
    await page
      .getByRole("button", { name: "Stop & finish", exact: true })
      .click();
    await page
      .getByRole("alert")
      .filter({ hasText: "Machine rejected target" })
      .waitFor();
    assert(
      !(await page.evaluate(() => window.__commands.map((c) => c[0]))).includes(
        "disconnect",
      ),
    );
    assert.equal(uploads.length, 0);
    assert(await page.evaluate(() => window.__data("active")));
    assert.equal(
      (await page.evaluate(() => window.__data("history"))).length,
      0,
    );
    await page.evaluate(() => (window.__fixture.fail = ""));
    await page
      .getByRole("button", { name: "Stop & finish", exact: true })
      .click();
    await page.getByRole("region", { name: "Workout recap" }).waitFor();
    await page.waitForFunction(
      async () =>
        (await window.__data("stravaOutbox"))?.[0]?.state === "synced",
    );
    await page.close();
    console.log(
      "Failed physical stop retains the active workout and connection, with no premature upload passed",
    );
  }
  {
    const { page, uploads } = await setup({ duration: 1, statusDelay: 2500 });
    await resume(page);
    await page.getByRole("region", { name: "Workout recap" }).waitFor();
    await page.waitForFunction(() =>
      window.__commands.some((c) => c[0] === "disconnect"),
    );
    await untilData(
      page,
      "stravaOutbox",
      (jobs) => jobs?.[0]?.state === "synced",
    );
    assert.equal(
      uploads.length,
      1,
      "A delayed connection check must not lose the workout",
    );
    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.close();
    console.log(
      "Delayed Strava status does not block equipment disconnect or lose automatic sync passed",
    );
  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error("Completion browser check failed:", error);
  throw error;
} finally {
  await browser.close();
  await close();
}
