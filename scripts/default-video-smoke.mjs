import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { open } from "node:fs/promises";
const b = await chromium.launch({
  args: ["--no-sandbox"],
  proxy: process.env.HTTPS_PROXY
    ? { server: process.env.HTTPS_PROXY, bypass: "localhost,127.0.0.1" }
    : undefined,
});
try {
  const p = await b.newPage({
    viewport: { width: 412, height: 844 },
    reducedMotion: "reduce",
  });
  if (process.env.FIT_VIDEO_FIXTURE) {
    const handle = await open(process.env.FIT_VIDEO_FIXTURE, "r");
    const bytes = Buffer.alloc(12 * 1024 * 1024);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    await handle.close();
    await p.route("https://videos.fit.silvio.cloud/video.webm", (r) =>
      r.fulfill({
        status: 200,
        contentType: "video/webm",
        body: bytes.subarray(0, bytesRead),
      }),
    );
    console.log(
      "Testing real source bytes through a local fixture; remote browser TLS is not tested in this mode.",
    );
  }
  p.on("requestfailed", (r) =>
    console.log("FAILED", r.url(), r.failure()?.errorText),
  );
  p.on("pageerror", (e) => console.log("ERROR", e.message));
  await p.goto(process.env.FIT_TEST_URL || "http://localhost:4173");
  await p.getByRole("button", { name: "Start", exact: true }).click();
  await p.getByText("More connection options", { exact: true }).click();
  await p.getByRole("button", { name: "Explore demo", exact: true }).click();
  await p.locator(".setup-programme").first().click();
  await p.locator(".setup-scene").first().click();
  await p.getByRole("button", { name: "Start journey", exact: true }).click();
  try {
    await p.waitForFunction(
      () => {
        const v = document.querySelector(".native-video");
        return v?.videoWidth > 0 && !v.paused && v.currentTime > 0.1;
      },
      {},
      { timeout: 25000 },
    );
    const result = await p
      .locator("video.native-video")
      .evaluate((v) => ({
        src: v.src,
        width: v.videoWidth,
        height: v.videoHeight,
        rate: v.playbackRate,
        duration: v.duration,
        cors: v.getAttribute("crossorigin"),
      }));
    assert.equal(result.src, "https://videos.fit.silvio.cloud/video.webm");
    assert.equal(result.width, 3840);
    assert.equal(result.cors, null);
    assert.equal(result.rate, 0.7);
    console.log("PASS direct default video", result);
  } catch (e) {
    console.log(
      "PLAYBACK",
      await p
        .locator("video.native-video")
        .evaluate((v) => ({
          src: v.src,
          error: v.error?.message,
          ready: v.readyState,
        })),
    );
    throw e;
  }
} finally {
  await b.close();
}
