import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { parseRange } from "../worker/media.ts";
import { openLibrary } from "./ui-helpers.mjs";
const root = resolve(process.env.NAS_QA_ROOT || "/workspace/nas-media-test"),
  app = process.env.FIT_TEST_URL || "http://localhost:8787",
  origin = new URL(app).origin;
const catalog = JSON.parse(await readFile(root + "/catalog.json", "utf8"));
const fourk = catalog.scenes.find((s) => s.name === "QA 4K fixture");
assert(
  fourk,
  "Publish the local-only 4K fixture into the test NAS folder first.",
);
const requests = [];
const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Credentials", "true");
  res.setHeader("Access-Control-Allow-Headers", "Range, If-Range");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405);
    res.end();
    return;
  }
  if (!req.headers.cookie?.includes("test-nas-session=allowed")) {
    res.writeHead(401);
    res.end("Sign in first");
    return;
  }
  const url = new URL(req.url, "http://localhost");
  if (!url.pathname.startsWith("/fitness/")) {
    res.writeHead(404);
    res.end();
    return;
  }
  const file = resolve(
    root,
    decodeURIComponent(url.pathname.slice("/fitness/".length)),
  );
  if (!file.startsWith(root + sep)) {
    res.writeHead(404);
    res.end();
    return;
  }
  try {
    const meta = await stat(file),
      mime = {
        json: "application/json",
        m3u8: "application/vnd.apple.mpegurl",
        m4s: "video/iso.segment",
        mp4: "video/mp4",
        jpg: "image/jpeg",
      };
    res.setHeader(
      "Content-Type",
      mime[file.split(".").pop()] || "application/octet-stream",
    );
    res.setHeader("Accept-Ranges", "bytes");
    const range = parseRange(req.headers.range || null, meta.size);
    res.setHeader("Content-Length", range ? range.length : meta.size);
    if (range)
      res.setHeader(
        "Content-Range",
        `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`,
      );
    requests.push({ path: url.pathname, authenticated: true, range: !!range });
    res.writeHead(range ? 206 : 200);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(
      file,
      range
        ? { start: range.offset, end: range.offset + range.length - 1 }
        : undefined,
    ).pipe(res);
  } catch {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const base = `http://localhost:${server.address().port}/fitness`;
const browser = await chromium.launch({ args: ["--no-sandbox"] });
async function setup(context, page) {
  await context.addCookies([
    { name: "test-nas-session", value: "allowed", url: base, sameSite: "Lax" },
  ]);
  await page.goto(app);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.locator(".settings-media summary").click();
  await page.getByLabel("Media folder URL").fill(base);
  await page
    .getByLabel("Use the server’s existing login session", { exact: true })
    .check();
  await page.getByRole("button", { name: "Save & test", exact: true }).click();
  await page
    .getByRole("status")
    .filter({ hasText: "Connected. Your NAS scenes" })
    .waitFor();
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
  const context = await browser.newContext({
      viewport: { width: 412, height: 900 },
      reducedMotion: "reduce",
    }),
    page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const mediaRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("/hls/")) mediaRequests.push(r.url());
  });
  await setup(context, page);
  await page.waitForFunction(() => {
    const v = document.querySelector(".native-video");
    return (
      v?.src.startsWith("blob:") &&
      !v.paused &&
      v.videoWidth > 0 &&
      v.currentTime > 0.1
    );
  });
  await page.getByText("Video options", { exact: true }).click();
  const quality = page.getByLabel("Video quality", { exact: true });
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
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.getByLabel("Scenery", { exact: true }).selectOption(fourk.id);
  await quality.selectOption({ label: "2160p · 4K" });
  await page.waitForFunction(() => {
    const v = document.querySelector(".native-video");
    return (
      v.videoWidth === 3840 &&
      v.videoHeight === 2160 &&
      !v.paused &&
      v.getVideoPlaybackQuality().totalVideoFrames > 0
    );
  });
  assert(
    mediaRequests.length > 0 &&
      mediaRequests.every((url) => url.startsWith(base + "/hls/")),
    "NAS media must stream directly to browser",
  );
  await page
    .getByRole("button", { name: "Stop & finish", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.locator(".settings-media summary").click();
  assert.equal(await page.getByLabel("Media folder URL").inputValue(), base);
  assert.equal(
    await page
      .getByLabel("Use the server’s existing login session", { exact: true })
      .isChecked(),
    true,
  );
  assert.deepEqual(errors, []);
  await context.close();
  console.log(
    "PASS direct cross-origin NAS HLS, authenticated requests, manual/automatic quality, 1.4x sync, actual 4K decoding and saved server settings.",
  );
  const fallbackContext = await browser.newContext({ reducedMotion: "reduce" }),
    fallback = await fallbackContext.newPage();
  fallback.setDefaultTimeout(45000);
  await fallback.route("**/fitness/hls/**/master.m3u8", (r) =>
    r.fulfill({
      status: 404,
      body: "Unavailable",
      headers: {
        "Access-Control-Allow-Origin": origin,
        "Access-Control-Allow-Credentials": "true",
      },
    }),
  );
  await setup(fallbackContext, fallback);
  await fallback.waitForFunction((base) => {
    const v = document.querySelector(".native-video");
    return (
      v?.src === base + "/forest-walk-v1.mp4" && !v.paused && v.videoWidth > 0
    );
  }, base);
  assert(
    requests.some((r) => r.range),
    "Progressive fallback must use HTTP byte ranges",
  );
  await fallbackContext.close();
  console.log(
    "PASS protected NAS MP4 fallback uses authenticated HTTP ranges when HLS is unavailable.",
  );
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}
