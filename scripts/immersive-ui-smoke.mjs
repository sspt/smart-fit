import { chromium } from "@playwright/test";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const b = await chromium.launch({ args: ["--no-sandbox"] });
try {
  const p = await b.newPage({
    viewport: { width: 412, height: 844 },
    reducedMotion: "no-preference",
  });
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  const bytes = await readFile("/tmp/fit-loop-36.webm");
  await p.route("https://videos.fit.silvio.cloud/video.webm", (r) => {
    const m = r
        .request()
        .headers()
        .range?.match(/bytes=(\d+)-(\d*)/),
      start = m ? Number(m[1]) : 0,
      end = m?.[2]
        ? Math.min(Number(m[2]), bytes.length - 1)
        : bytes.length - 1;
    return r.fulfill({
      status: m ? 206 : 200,
      contentType: "video/webm",
      headers: {
        "Accept-Ranges": "bytes",
        ...(m
          ? { "Content-Range": `bytes ${start}-${end}/${bytes.length}` }
          : {}),
      },
      body: bytes.subarray(start, end + 1),
    });
  });
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
  await p.goto(process.env.FIT_TEST_URL || "http://localhost:4173");
  await p.waitForFunction(() => {
    const v = document.querySelector(".world-film");
    return v?.videoWidth > 0 && !v.paused && v.currentTime > 30.1;
  });
  await p.locator(".world-film").evaluate((v) => (window.testAmbient = v));
  for (const name of ["Home", "Library", "Discover", "Journal", "Settings"]) {
    await p
      .getByRole("navigation")
      .getByRole("button", { name, exact: true })
      .click();
    assert.equal(
      await p.locator(".world-film").evaluate((v) => v === window.testAmbient),
      true,
    );
    const box = await p.locator(".world-film").boundingBox();
    assert.equal(box.width, 412);
    assert.equal(box.height, 844);
    assert.equal(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await p.screenshot({ path: `/tmp/fit-immersive-${name}.png` });
  }
  await p
    .getByRole("button", { name: "Pause background scenery", exact: true })
    .click();
  assert.equal(await p.locator(".world-film").count(), 0);
  await p
    .getByRole("button", { name: "Play background scenery", exact: true })
    .click();
  await p.waitForFunction(
    () => document.querySelector(".world-film")?.videoWidth > 0,
  );
  await p
    .getByRole("navigation")
    .getByRole("button", { name: "Home", exact: true })
    .click();
  await p.getByRole("button", { name: "Start", exact: true }).click();
  await p.getByText("More connection options", { exact: true }).click();
  await p.getByRole("button", { name: "Explore demo", exact: true }).click();
  await p.locator(".setup-programme").first().click();
  await p.locator(".setup-scene").first().click();
  await p.getByRole("button", { name: "Start journey", exact: true }).click();
  await p.waitForFunction(
    () => document.querySelector(".native-video")?.videoWidth > 0,
  );
  assert.equal(
    await p.locator(".world-film").count(),
    0,
    "no duplicate video decoder during workout",
  );
  assert.deepEqual(errors, []);
  console.log(
    "PASS full-screen video across all pages, continuous playback through navigation, motion toggle and single workout decoder.",
  );
  const reduced = await b.newPage({ reducedMotion: "reduce" });
  await reduced.goto(process.env.FIT_TEST_URL || "http://localhost:4173");
  await reduced.getByRole("button", { name: "Start", exact: true }).waitFor();
  assert.equal(await reduced.locator(".world-film").count(), 0);
  console.log("PASS reduced-motion static background.");
} finally {
  await b.close();
}
