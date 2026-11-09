const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const b = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  for (const width of [320, 768, 1440]) {
    const p = await b.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width, height: 900 },
      reducedMotion: "reduce",
    });
    await p.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
    await p
      .getByRole("navigation")
      .getByRole("button", { name: "Library", exact: true })
      .click();
    const tiles = p.locator(".programme-duration-tile");
    assert((await tiles.count()) > 0);
    assert.equal(await p.locator(".programme-library .equipment").count(), 0);
    for (const tile of await tiles.all()) {
      assert(await tile.locator("svg").isVisible());
      assert((await tile.locator("strong").innerText()).match(/\d/));
      assert.equal(
        await tile.evaluate((e) => getComputedStyle(e).backgroundImage),
        "none",
      );
    }
    assert(
      await p.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    console.log(
      "PASS " +
        width +
        "px: clock and duration tiles; no image placeholders or horizontal overflow",
    );
    if (width === 768)
      await p.screenshot({
        path: "/workspace/smart-fit/artifacts/previews/programme-duration-tablet.png",
        fullPage: true,
      });
    await p.close();
  }
  await b.close();
})();
