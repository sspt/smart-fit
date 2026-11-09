const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage({
      ignoreHTTPSErrors: true,
      viewport: { width: 768, height: 1024 },
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.addInitScript(() => {
      window.__pickerCalls = [];
      Object.defineProperty(navigator, "bluetooth", {
        configurable: true,
        value: {
          getDevices: async () => [],
          requestDevice: async (options) => {
            window.__pickerCalls.push(options);
            throw new DOMException("User cancelled", "NotFoundError");
          },
        },
      });
    });
    await page.goto(process.env.FIT_TEST_URL || "http://localhost:5176");
    await page
      .getByRole("button", { name: "Equipment connection", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Connect equipment", exact: true })
      .click();
    await page.waitForFunction(() => window.__pickerCalls.length === 1);
    await page.getByText("More connection options", { exact: true }).click();
    for (const [index, name] of ["Connect FTMS", "Connect iFIT"].entries()) {
      await page.getByRole("button", { name, exact: true }).click();
      await page.waitForFunction(
        (count) => window.__pickerCalls.length === count,
        index + 2,
      );
    }
    const options = await page.evaluate(() => window.__pickerCalls);
    for (const [i, option] of options.entries()) {
      assert.notEqual(option.acceptAllDevices, true);
      assert(option.filters.length > 0);
      assert(
        option.filters.some((f) =>
          f.services?.includes("00001533-1412-efde-1523-785feabcd123"),
        ),
      );
      assert(option.filters.some((f) => f.namePrefix === "I_"));
      if (i < 2)
        assert(option.filters.some((f) => f.services?.includes(0x1826)));
      else assert(!option.filters.some((f) => f.services?.includes(0x1826)));
    }
    assert.deepEqual(errors, []);
    console.log(
      "PASS: main Connect, direct FTMS and direct iFIT request filtered devices; cancellation produces no runtime errors",
    );
  } finally {
    await browser.close();
  }
})();
