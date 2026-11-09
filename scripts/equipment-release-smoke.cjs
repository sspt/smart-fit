const { chromium } = require("playwright");
const assert = require("node:assert/strict");
(async () => {
  const b = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  for (const [kind, label] of [
    ["Treadmill", "INCLINE"],
    ["Bike", "POWER"],
    ["Rower", "RESISTANCE"],
  ]) {
    const p = await b.newPage({
      viewport: { width: 1024, height: 768 },
      reducedMotion: "reduce",
    });
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
    await p.getByRole("button", { name: "Start", exact: true }).click();
    await p.getByRole("button", { name: new RegExp("^" + kind + " ") }).click();
    await p.getByText("More connection options", { exact: true }).click();
    await p.getByRole("button", { name: "Explore demo", exact: true }).click();
    await p.locator(".setup-programme").first().click();
    await p.locator(".setup-scene").first().click();
    await p.getByRole("button", { name: "Start journey", exact: true }).click();
    const readings = p.getByLabel("Workout metrics");
    await readings.waitFor();
    assert.equal(await readings.locator(":scope > div").count(), 5);
    assert((await readings.innerText()).includes(label));
    assert(!(await readings.innerText()).includes("VIDEO SPEED"));
    assert((await readings.innerText()).includes("kcal"));
    assert(
      await readings.evaluate((e) =>
        [...e.children].every((v) => {
          const r = v.getBoundingClientRect();
          return r.left >= 0 && r.right <= innerWidth;
        }),
      ),
    );
    assert.deepEqual(errors, []);
    console.log(
      "PASS " +
        kind +
        ": compiled production shell starts demo; correct five metrics, no runtime errors",
    );
    await p.close();
  }
  const p = await b.newPage();
  await p.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
  await p
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await p.getByText("Connections · Strava", { exact: true }).waitFor();
  console.log("PASS retained Strava settings");
  await b.close();
})();
