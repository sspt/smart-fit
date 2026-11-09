import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
const origin = process.env.FIT_TEST_URL || "http://localhost:5174";
try {
  for (const [width, height] of [
    [320, 640],
    [390, 844],
    [844, 390],
  ]) {
    const page = await browser.newPage({
        viewport: { width, height },
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
        isMobile: true,
        hasTouch: true,
      }),
      errors = [],
      api = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("request", (r) => {
      if (new URL(r.url()).pathname.startsWith("/api/")) api.push(r.url());
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "bluetooth", { value: undefined });
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async (text) => {
            window.copiedLink = text;
          },
        },
      });
    });
    await page.goto(origin);
    await page
      .getByRole("heading", { name: "Your journey needs a different device." })
      .waitFor();
    assert.match(
      await page.locator("main").innerText(),
      /doesn’t support Web Bluetooth/,
    );
    assert.equal(await page.locator("video,nav,.equipment-screen").count(), 0);
    assert.equal(
      await page.getByRole("button", { name: "Start", exact: true }).count(),
      0,
    );
    await page.getByRole("button", { name: "Copy website link" }).click();
    await page.getByRole("button", { name: "Link copied" }).waitFor();
    assert.equal(
      await page.evaluate(() => window.copiedLink),
      "https://kwest.fit",
    );
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(api, []);
    if (width === 390)
      await page.screenshot({
        path: "artifacts/previews/iphone-landing.png",
        fullPage: true,
      });
    console.log(
      `PASS iPhone ${width}x${height}: landing, no app/API/Bluetooth flow, copy link, no overflow`,
    );
    await page.close();
  }
  const page = await browser.newPage({ viewport: { width: 412, height: 844 } }),
    errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
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
    const db = await new Promise((r) => {
        const q = indexedDB.open("smart-fit", 1);
        q.onsuccess = () => r(q.result);
      }),
      tx = db.transaction("data", "readwrite"),
      store = tx.objectStore("data");
    const programme = {
        id: "test",
        name: "Recorded workout",
        kind: "Treadmill",
        repeat: 1,
        blocks: [
          {
            name: "Steady",
            duration: 60,
            speed: 5,
            incline: 0,
            power: 100,
            resistance: 3,
          },
        ],
      },
      real = {
        id: "real",
        programme,
        started: Date.now(),
        elapsed: 60,
        status: "completed",
        demo: false,
        samples: [],
        events: [],
      },
      old = {
        ...real,
        id: "old-demo",
        programme: { ...programme, name: "Old demo workout" },
        demo: true,
      };
    store.put([real, old], "history");
    store.put({ ...old, status: "active" }, "active");
    await new Promise((r, j) => {
      tx.oncomplete = r;
      tx.onerror = j;
    });
    db.close();
  });
  await page.reload();
  await page.getByRole("button", { name: "Start", exact: true }).waitFor();
  assert.equal(await page.locator(".active-session").count(), 0);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Journal", exact: true })
    .click();
  await page.getByRole("heading", { name: "Recorded workout" }).waitFor();
  assert.equal(await page.locator(".history").count(), 1);
  assert(!/demo|simulated/i.test(await page.locator("body").innerText()));
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  assert(!/demo|simulated/i.test(await page.locator("body").innerText()));
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Export backup", exact: true })
    .click();
  const file = await download,
    stream = await file.createReadStream(),
    chunks = [];
  for await (const c of stream) chunks.push(c);
  assert.equal(JSON.parse(Buffer.concat(chunks).toString()).history.length, 2);
  assert.deepEqual(errors, []);
  console.log(
    "PASS normal app retained; demo recovery/references hidden, original history preserved in backup",
  );
  await page.close();
} finally {
  await browser.close();
}
