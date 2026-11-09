const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const b = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    for (const width of [320, 768, 1440]) {
      const p = await b.newPage({
        ignoreHTTPSErrors: true,
        viewport: { width, height: 900 },
        reducedMotion: "reduce",
      });
      const errors = [];
      p.on("pageerror", (e) => errors.push(e.message));
      await p.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
      assert.equal(await p.locator("header .background-motion").count(), 0);
      assert.equal(await p.locator("header .cache-refresh").count(), 0);
      await p
        .getByRole("navigation")
        .getByRole("button", { name: "Settings", exact: true })
        .click();
      assert.equal(await p.locator(".settings .cache-refresh").count(), 1);
      assert(
        await p.getByRole("button", { name: "Clear app cache" }).isVisible(),
      );
      assert.equal(
        await p.getByLabel("Maximum treadmill speed (km/h)").count(),
        0,
      );
      assert.equal(await p.locator(".settings-media").count(), 0);
      assert(
        await p
          .locator(".settings details")
          .evaluateAll((es) => es.every((e) => e.open)),
      );
      assert(
        await p
          .getByRole("button", { name: "Export backup", exact: true })
          .isVisible(),
      );
      assert(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      assert.deepEqual(errors, []);
      console.log(
        "PASS " +
          width +
          "px: clean header, cache in settings, removed manual speed and video server, sections expanded",
      );
      if (width === 768)
        await p.screenshot({
          path: "/workspace/smart-fit/artifacts/previews/settings-tablet.png",
          fullPage: true,
        });
      await p.close();
    }
  } finally {
    await b.close();
  }
})();
