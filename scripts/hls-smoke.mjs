import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { openLibrary } from "./ui-helpers.mjs";
const browser = await chromium.launch({ args: ["--no-sandbox"] });
const base = process.env.FIT_TEST_URL || "http://localhost:8787";
const exported = JSON.parse(
  await readFile(
    process.env.HLS_SCENE_EXPORT ||
      "/workspace/scenery-streams/woodland-hls-7682cee41c48/upload.json",
    "utf8",
  ),
);
const streamScene = exported.scene;
const stubCatalog = (page) =>
  page.route("**/media/catalog.json", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ version: 1, scenes: [streamScene] }),
    }),
  );
async function begin(page) {
  await page.goto(base);
  await page
    .getByRole("button", { name: "Equipment connection", exact: true })
    .click();
  await page.getByText("More connection options", { exact: true }).click();
  await page.getByRole("button", { name: "Explore demo", exact: true }).click();
  await openLibrary(page);
  await page
    .getByRole("button", { name: "Start 15 min · Easy walk", exact: true })
    .click();
  await page
    .getByRole("group", { name: "Session view" })
    .getByRole("button", { name: "Scenery", exact: true })
    .click();
  await page.getByRole("button", { name: "Open video", exact: true }).click();
}
try {
  const page = await browser.newPage({
    viewport: { width: 412, height: 900 },
    reducedMotion: "reduce",
  });
  page.setDefaultTimeout(45000);
  const errors = [],
    requested = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("request", (r) => {
    if (r.url().includes("/media/hls/")) requested.push(r.url());
  });
  await stubCatalog(page);
  await begin(page);
  await page.waitForFunction(() => {
    const v = document.querySelector(".native-video");
    return (
      v?.src.startsWith("blob:") &&
      v.videoWidth > 0 &&
      !v.paused &&
      v.currentTime > 0.1
    );
  });
  await page.getByText("Video options", { exact: true }).click();
  const quality = page.getByRole("combobox", {
    name: "Video quality",
    exact: true,
  });
  await quality.selectOption({ label: "360p" });
  await page.waitForFunction(
    () => document.querySelector(".native-video").videoWidth === 360,
  );
  await quality.selectOption({ label: "720p" });
  await page.waitForFunction(
    () => document.querySelector(".native-video").videoWidth === 720,
  );
  await page.getByLabel("Video reference speed").fill("2.5");
  await page.waitForFunction(
    () =>
      Math.abs(document.querySelector(".native-video").playbackRate - 1.4) <
      0.001,
  );
  await quality.selectOption("-1");
  assert.equal(await quality.inputValue(), "-1");
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  await page.waitForFunction(
    () => document.querySelector(".native-video").paused,
  );
  await page
    .getByRole("button", { name: "Resume programme", exact: true })
    .click();
  await page.waitForFunction(
    () => !document.querySelector(".native-video").paused,
  );
  assert(requested.some((u) => u.endsWith("master.m3u8")));
  assert(requested.some((u) => u.endsWith(".m4s")));
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    "PASS real fMP4 HLS decoding, 360p/720p quality changes, automatic mode, 1.4x device sync and pause/resume.",
  );
  const fallback = await browser.newPage({ reducedMotion: "reduce" });
  fallback.setDefaultTimeout(45000);
  await fallback.route("**/media/hls/**", (route) =>
    route.fulfill({
      status: 404,
      body: "Unavailable",
      contentType: "text/plain",
    }),
  );
  await stubCatalog(fallback);
  await begin(fallback);
  await fallback.waitForFunction(() => {
    const v = document.querySelector(".native-video");
    return (
      v?.src.includes("/media/forest-walk-v1.mp4") &&
      v.videoWidth > 0 &&
      !v.paused &&
      v.currentTime > 0.1
    );
  });
  await fallback.close();
  console.log(
    "PASS broken HLS manifest falls back to a real MP4 and continues following device speed.",
  );
  if (process.env.HLS_QA_SCENE) {
    const scene = JSON.parse(await readFile(process.env.HLS_QA_SCENE, "utf8"));
    const four = await browser.newPage({
      viewport: { width: 1280, height: 800 },
      reducedMotion: "reduce",
    });
    four.setDefaultTimeout(45000);
    await four.route("**/media/catalog.json", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ version: 1, scenes: [scene] }),
      }),
    );
    await begin(four);
    await four.getByText("Video options", { exact: true }).click();
    await four.getByLabel("Scenery", { exact: true }).selectOption(scene.id);
    await four
      .getByRole("combobox", { name: "Video quality", exact: true })
      .selectOption({ label: "2160p · 4K" });
    await four.waitForFunction(() => {
      const v = document.querySelector(".native-video");
      return (
        v.videoWidth === 3840 &&
        v.videoHeight === 2160 &&
        !v.paused &&
        v.getVideoPlaybackQuality().totalVideoFrames > 0
      );
    });
    await four.close();
    console.log(
      "PASS uploaded catalogue entry and actual 3840×2160 HLS video decoding using a local-only generated fixture.",
    );
  }
} finally {
  await browser.close();
}
