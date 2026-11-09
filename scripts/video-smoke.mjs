import { openLibrary, collectProgrammes } from "./ui-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const page = await browser.newPage({ viewport: { width: 412, height: 915 } });
  const errors = [];
  const thirdParty = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (/youtube|googlevideo|ytimg/.test(r.url())) thirdParty.push(r.url());
  });
  const base = process.env.FIT_TEST_URL || "http://localhost:8787";
  await page.goto(base);
  await page
    .getByRole("button", { name: "Equipment connection", exact: true })
    .click();
  await page.getByText("More connection options", { exact: true }).click();
  await page.getByRole("button", { name: "Explore demo" }).click();
  await openLibrary(page);
  await page
    .getByRole("button", { name: "Start 15 min · Easy walk", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Session view" })
    .getByRole("button", { name: "Scenery", exact: true })
    .click();
  await page.getByRole("button", { name: "Open video", exact: true }).click();
  const video = page.locator("video");
  await page.waitForFunction(
    () => document.querySelector("video")?.readyState >= 1,
  );
  assert.ok(await video.evaluate((v) => v.videoWidth > 0 && v.duration > 0));
  await page.getByText("Video options", { exact: true }).click();
  await page.waitForFunction(
    () =>
      !document.querySelector("video").paused &&
      document.querySelector("video").currentTime > 0.2,
  );
  await page
    .getByRole("button", { name: "Pause video sync", exact: true })
    .click();
  await page.waitForFunction(() => document.querySelector("video").paused);
  await page
    .getByRole("button", { name: "Follow device", exact: true })
    .click();
  await page.getByLabel("Video reference speed").fill("2.5");
  await page.waitForFunction(
    () => Math.abs(document.querySelector("video").playbackRate - 1.4) < 0.001,
  );
  await video.evaluate((v) => {
    v.playbackRate = 0.75;
  });
  await page.waitForFunction(
    () => Math.abs(document.querySelector("video").playbackRate - 1.4) < 0.001,
  );
  await video.evaluate((v) => (v.currentTime = 5));
  await page.waitForFunction(
    () => document.querySelector("video").currentTime >= 5,
  );
  await video.evaluate((v) => {
    v.currentTime = v.duration - 0.1;
  });
  await page.waitForFunction(
    () =>
      document.querySelector("video").currentTime < 2 &&
      !document.querySelector("video").paused,
  );
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForFunction(() => document.querySelector("video").paused);
  const paused = await video.evaluate((v) => v.currentTime);
  await page.waitForTimeout(400);
  assert.ok(
    Math.abs((await video.evaluate((v) => v.currentTime)) - paused) < 0.1,
  );
  await page
    .getByRole("button", { name: "Resume programme", exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector("video").paused);
  await page
    .locator(".video-footer input[type=file]")
    .setInputFiles("/workspace/scenery-downloads/forest-walk-v1.mp4");
  await page.waitForFunction(
    () =>
      document.querySelector("video").src.startsWith("blob:") &&
      document.querySelector("video").readyState >= 1,
  );
  await page.context().setOffline(true);
  await page.waitForFunction(
    () =>
      !document.querySelector("video").paused &&
      document.querySelector("video").currentTime > 0.2,
  );
  await page.context().setOffline(false);
  await page
    .getByRole("button", { name: "Immersive view", exact: true })
    .click();
  async function assertImmersion() {
    const bounds = await video.boundingBox();
    const viewport = await page.evaluate(() => ({
      width: innerWidth,
      height: innerHeight,
    }));
    assert.ok(Math.abs(bounds.x) < 1 && Math.abs(bounds.y) < 1);
    assert.ok(
      Math.abs(bounds.width - viewport.width) < 1 &&
        Math.abs(bounds.height - viewport.height) < 1,
      "video must cover entire viewport behind overlays",
    );
    assert.equal(
      await video.evaluate((v) => getComputedStyle(v).objectFit),
      "cover",
    );
    assert.equal(await video.evaluate((v) => v.controls), false);
    for (const label of ["Stop workout", "Exit immersive view"]) {
      const b = await page
        .getByRole("button", { name: label, exact: true })
        .boundingBox();
      assert.ok(
        b &&
          b.x >= 0 &&
          b.y >= 0 &&
          b.x + b.width <= viewport.width + 1 &&
          b.y + b.height <= viewport.height + 1,
        label + " must stay on screen",
      );
    }
  }
  await assertImmersion();
  await page.screenshot({ path: "/tmp/fit-immersive-portrait.png" });
  await page
    .getByRole("button", { name: "Pause workout", exact: true })
    .click();
  await page.waitForFunction(() => document.querySelector("video").paused);
  await page
    .getByRole("button", { name: "Resume workout", exact: true })
    .click();
  await page.waitForFunction(() => !document.querySelector("video").paused);
  await page
    .getByRole("button", { name: "Exit immersive view", exact: true })
    .click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.setViewportSize({ width: 915, height: 412 });
  await page
    .getByRole("button", { name: "Immersive view", exact: true })
    .click();
  await assertImmersion();

  assert.ok(
    await page
      .getByRole("button", { name: "Stop workout", exact: true })
      .isVisible(),
  );
  await page.screenshot({ path: "/tmp/fit-native-video.png" });
  await page
    .getByRole("button", { name: "Exit immersive view", exact: true })
    .click();
  await page.getByRole("navigation", { name: "Main navigation" }).waitFor();
  assert.equal(
    await page
      .getByRole("navigation", { name: "Main navigation" })
      .evaluate((el) => el.inert),
    false,
  );
  await page.waitForFunction(() => !document.fullscreenElement);
  await page
    .getByRole("button", { name: "Immersive view", exact: true })
    .click();

  await page
    .getByRole("button", { name: "Exit immersive view", exact: true })
    .click();
  await page.waitForFunction(() => !document.fullscreenElement);
  await page.evaluate(() => {
    Element.prototype.requestFullscreen = undefined;
  });
  await page.setViewportSize({ width: 320, height: 640 });
  await page
    .getByRole("button", { name: "Immersive view", exact: true })
    .click();
  await assertImmersion();
  await page.setViewportSize({ width: 640, height: 320 });
  await assertImmersion();
  await page.getByRole("button", { name: "Stop workout", exact: true }).click();
  await page.getByRole("heading", { name: "Your journey." }).waitFor();
  assert.deepEqual(thirdParty, []);
  assert.deepEqual(errors, []);
  console.log(
    "PASS actual H.264 playback, continuous 1.4x sync, rate override, seeking/looping, pause/resume, offline local file and landscape Stop; no YouTube requests.",
  );
  // Decode each deployed clip, not just the default route.
  for (const name of ["autumn-cycle-v3", "river-canoe-v2"]) {
    await page.evaluate((name) => {
      const v = document.createElement("video");
      v.src = "/media/" + name + ".mp4";
      v.muted = true;
      v.preload = "auto";
      document.body.append(v);
    }, name);
    await page.waitForFunction(
      (name) =>
        Array.from(document.querySelectorAll("video")).some(
          (v) =>
            v.src.endsWith(name + ".mp4") &&
            v.readyState >= 2 &&
            v.videoWidth > 0,
        ),
      name,
    );
    console.log("PASS decode " + name);
  }
  const response = await page.request.get(base + "/media/forest-walk-v1.mp4", {
    headers: { Range: "bytes=100-199" },
  });
  assert.equal(response.status(), 206);
  assert.equal((await response.body()).length, 100);
  assert.ok(response.headers()["content-range"].startsWith("bytes 100-199/"));
  console.log("PASS real Worker/R2 byte-range response.");
} finally {
  await browser.close();
}
