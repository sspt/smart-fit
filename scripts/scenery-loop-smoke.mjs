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
    await p.route("https://videos.fit.silvio.cloud/video.webm", (r) => {
      const range = r.request().headers().range;
      const m = range?.match(/bytes=(\d+)-(\d*)/);
      const start = m ? Number(m[1]) : 0,
        end = m?.[2] ? Math.min(Number(m[2]), bytesRead - 1) : bytesRead - 1;
      return r.fulfill({
        status: m ? 206 : 200,
        contentType: "video/webm",
        headers: {
          "Accept-Ranges": "bytes",
          ...(m
            ? { "Content-Range": `bytes ${start}-${end}/${bytesRead}` }
            : {}),
        },
        body: bytes.subarray(start, end + 1),
      });
    });
    console.log(
      "Testing loop behaviour with a local 36-second synthetic video; remote TLS is not tested.",
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
        return v?.videoWidth > 0 && !v.paused && v.currentTime >= 30.1;
      },
      {},
      { timeout: 25000 },
    );
    const result = await p.locator("video.native-video").evaluate((v) => ({
      src: v.src,
      width: v.videoWidth,
      height: v.videoHeight,
      rate: v.playbackRate,
      duration: v.duration,
      cors: v.getAttribute("crossorigin"),
    }));
    assert.equal(result.src, "https://videos.fit.silvio.cloud/video.webm");
    assert.equal(result.width, 320);
    assert.equal(result.cors, null);
    assert.equal(result.rate, 0.7);
    assert.equal(result.duration, 36);
    await p.locator("video.native-video").evaluate((v) => {
      v.currentTime = 35.5;
    });
    await p.waitForFunction(() => {
      const v = document.querySelector("video.native-video");
      return (
        v.currentTime > 35 && Number(v.style.filter.match(/[\d.]+/)[0]) < 0.5
      );
    });
    await p.waitForFunction(() => {
      const v = document.querySelector("video.native-video");
      return v.currentTime >= 30 && v.currentTime < 31.5 && !v.paused;
    });
    assert.equal(
      await p.locator("video.native-video").evaluate((v) => v.playbackRate),
      0.7,
    );
    await p.getByRole("button", { name: "Pause workout", exact: true }).click();
    await p.waitForFunction(
      () => document.querySelector("video.native-video").paused,
    );
    console.log(
      "PASS 30-second skip, fade-out, automatic loop back to 30s, machine-speed sync and pause.",
    );
  } catch (e) {
    console.log(
      "PLAYBACK",
      await p.locator("video.native-video").evaluate((v) => ({
        src: v.src,
        error: v.error?.message,
        ready: v.readyState,
        time: v.currentTime,
        seeking: v.seeking,
        paused: v.paused,
        buffered: Array.from({ length: v.buffered.length }, (_, i) => [
          v.buffered.start(i),
          v.buffered.end(i),
        ]),
      })),
    );
    throw e;
  }
} finally {
  await b.close();
}
