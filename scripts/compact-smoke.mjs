import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { openLibrary, collectProgrammes } from "./ui-helpers.mjs";
const b = await chromium.launch({ args: ["--no-sandbox"] });
const layoutFailures = [];
async function fits(p, label) {
  const box = await p.evaluate(() => ({
    height: document.documentElement.scrollHeight,
    width: document.documentElement.scrollWidth,
    h: innerHeight,
    w: innerWidth,
  }));
  if (box.height > box.h + 1)
    await p.screenshot({
      path: "/tmp/fit-overflow-" + label.replace(/[^a-z0-9]/gi, "-") + ".png",
    });
  if (box.height > box.h + 1)
    layoutFailures.push(`${label}: height ${box.height}/${box.h}`);
  if (box.width > box.w)
    layoutFailures.push(`${label}: width ${box.width}/${box.w}`);
}
try {
  for (const [width, height] of [
    [320, 640],
    [412, 844],
    [1280, 800],
  ]) {
    const p = await b.newPage({
      viewport: { width, height },
      reducedMotion: "reduce",
    });
    if (process.env.FIT_VIDEO_FIXTURE) {
      const bytes = await readFile(process.env.FIT_VIDEO_FIXTURE);
      await p.route("https://videos.fit.silvio.cloud/video.webm", (r) =>
        r.fulfill({
          status: 200,
          contentType: "video/webm",
          headers: { "Accept-Ranges": "bytes" },
          body: bytes,
        }),
      );
      await p.route("**/api/video-info", (r) =>
        r.fulfill({
          contentType: "application/json",
          body: JSON.stringify({
            videos: [
              {
                file: "video.webm",
                name: "Forest walk",
                deviceTypes: ["Treadmill", "Bike", "Rower"],
              },
            ],
          }),
        }),
      );
    }
    p.setDefaultTimeout(15000);
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(process.env.FIT_TEST_URL || "http://localhost:8787");
    await p.getByRole("button", { name: "Start", exact: true }).waitFor();
    for (const screen of [
      "Home",
      "Library",
      "Discover",
      "Equipment",
      "Journal",
      "Settings",
    ]) {
      if (screen === "Equipment")
        await p.getByRole("button", { name: "Equipment connection" }).click();
      else
        await p
          .getByRole("navigation")
          .getByRole("button", { name: screen, exact: true })
          .click();
      await fits(p, `${width} ${screen}`);
      await p.screenshot({ path: `/tmp/fit-compact-${screen}-${width}.png` });
    }
    assert.equal((await collectProgrammes(p)).length, 9);
    await p
      .getByRole("navigation")
      .getByRole("button", { name: "Home", exact: true })
      .click();
    await p.getByRole("button", { name: "Start", exact: true }).click();
    await fits(p, `${width} connection`);
    await p.getByText("More connection options", { exact: true }).click();
    await p.getByRole("button", { name: "Explore demo", exact: true }).click();
    await p.getByRole("heading", { name: "Find your rhythm." }).waitFor();
    await fits(p, `${width} programme choice`);
    await p
      .locator(".setup-programme")
      .filter({ has: p.locator(".setup-duration", { hasText: "30 min" }) })
      .click();
    await fits(p, `${width} scene choice`);
    await p.locator(".setup-scene").click();
    await fits(p, `${width} review`);
    await p.getByRole("button", { name: "Start journey", exact: true }).click();
    const dialog = p.getByRole("dialog", { name: "Scenic video" });
    await dialog.waitFor();
    await p.waitForFunction(
      () => document.querySelector(".native-video")?.currentTime > 0.1,
    );
    const mode = dialog.getByRole("group", { name: "Equipment control mode" });
    assert.equal(
      await mode
        .getByRole("button", { name: "Automatic", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await mode
      .getByRole("button", { name: "Follow machine", exact: true })
      .click();
    assert.equal(
      await mode
        .getByRole("button", { name: "Follow machine", exact: true })
        .getAttribute("aria-pressed"),
      "true",
    );
    await p.waitForFunction(
      () => !document.querySelector(".native-video").paused,
    );
    await mode.getByRole("button", { name: "Automatic", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Pause workout", exact: true })
      .click();
    await mode
      .getByRole("button", { name: "Follow machine", exact: true })
      .click();
    await mode.getByRole("button", { name: "Automatic", exact: true }).click();
    assert(
      await p.locator(".native-video").evaluate((v) => v.paused),
      "changing control mode must not resume a paused workout",
    );
    await mode
      .getByRole("button", { name: "Follow machine", exact: true })
      .click();
    await dialog
      .getByRole("button", { name: "Resume workout", exact: true })
      .click();
    assert.equal(
      await mode
        .getByRole("button", { name: "Follow machine", exact: true })
        .getAttribute("aria-pressed"),
      "true",
      "follow mode survives pause/resume",
    );
    await p.waitForFunction(
      () => !document.querySelector(".native-video").paused,
    );
    if (width === 320) {
      await p.setViewportSize({ width: 640, height: 320 });
      const buttons = await Promise.all(
        [
          "Follow machine",
          "Automatic",
          "Pause workout",
          "Stop workout",
          "Exit immersive view",
        ].map((name) =>
          dialog.getByRole("button", { name, exact: true }).boundingBox(),
        ),
      );
      for (const rect of buttons)
        assert(
          rect &&
            rect.x >= 0 &&
            rect.y >= 0 &&
            rect.x + rect.width <= 640 &&
            rect.y + rect.height <= 320,
          "all immersive controls fit landscape",
        );
      await p.screenshot({ path: "/tmp/fit-control-landscape.png" });
      await p.setViewportSize({ width, height });
    }
    if (width === 320) {
      await dialog
        .getByRole("button", { name: "Pause workout", exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Exit immersive view", exact: true })
        .click();
      p.on("dialog", (d) => d.accept());
      await p.reload();
      await p
        .getByRole("alert")
        .filter({ hasText: "Recovered workout" })
        .waitFor();
      await p
        .getByRole("navigation")
        .getByRole("button", { name: "Live", exact: true })
        .click();
      assert.equal(
        await p
          .getByRole("group", { name: "Equipment control mode" })
          .getByRole("button", { name: "Follow machine", exact: true })
          .getAttribute("aria-pressed"),
        "true",
        "follow mode survives reload",
      );
      await p
        .getByRole("button", { name: "Resume programme", exact: true })
        .click();
      await dialog.waitFor();
      assert.equal(
        await dialog
          .getByRole("group", { name: "Equipment control mode" })
          .getByRole("button", { name: "Follow machine", exact: true })
          .getAttribute("aria-pressed"),
        "true",
      );
    }
    await dialog
      .getByRole("button", { name: "Exit immersive view", exact: true })
      .click();
    await fits(p, `${width} live scenery`);
    await p
      .getByRole("group", { name: "Session view" })
      .getByRole("button", { name: "Session", exact: true })
      .click();
    await fits(p, `${width} live readings`);
    await p.getByRole("button", { name: "Stop & finish", exact: true }).click();
    await p.getByRole("heading", { name: "Your journey." }).waitFor();
    await fits(p, `${width} recorded history`);
    if (width === 320) {
      await p.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const request = indexedDB.open("smart-fit");
            request.onsuccess = () => {
              const db = request.result,
                tx = db.transaction("data", "readwrite"),
                records = tx.objectStore("data").get("history");
              records.onsuccess = () =>
                tx.objectStore("data").put(
                  {
                    ...records.result[0],
                    id: "tracking-only-check",
                    automatic: false,
                    controlMode: "follow",
                    demo: true,
                    elapsed: 0,
                    status: "active",
                    events: [],
                    samples: [],
                  },
                  "active",
                );
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
              tx.onerror = reject;
            };
            request.onerror = reject;
          }),
      );
      await p.reload();
      await p
        .getByRole("alert")
        .filter({ hasText: "Recovered workout" })
        .waitFor();
      await p
        .getByRole("navigation")
        .getByRole("button", { name: "Live", exact: true })
        .click();
      await p.getByRole("button", { name: "Open video", exact: true }).click();
      await p
        .getByRole("button", { name: "Immersive view", exact: true })
        .click();
      const disabled = dialog
        .getByRole("group", { name: "Equipment control mode" })
        .getByRole("button", { name: "Automatic", exact: true });
      assert.equal(
        await disabled.isDisabled(),
        true,
        "tracking-only sessions cannot acquire automatic control",
      );
      await dialog
        .getByRole("button", { name: "Stop workout", exact: true })
        .click();
    }
    assert.deepEqual(errors, []);
    await p.close();
    console.log(
      `CHECKED ${width}x${height}: all default screens and setup steps fit, nine programmes accessible, immersive control switching, pause/resume and stop.`,
    );
  }
  assert.deepEqual(
    layoutFailures,
    [],
    "Default screen layouts should fit each viewport",
  );
  console.log("PASS all compact layouts and immersive control modes.");
} finally {
  await b.close();
}
