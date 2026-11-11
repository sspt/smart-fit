import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { openLibrary } from "./ui-helpers.mjs";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const [width, kind, target, label, level, minutes] of [
    [
      320,
      "Treadmill",
      "4.2",
      "Comfortable walking speed (km/h)",
      "starting",
      "20",
    ],
    [412, "Treadmill", "4.2", "", "active", "30"],
    [412, "Bike", "85", "Comfortable power (W)", "active", "30"],
    [1280, "Rower", "4", "Comfortable resistance level", "active", "45"],
  ]) {
    const page = await browser.newPage({
        viewport: { width, height: 844 },
        reducedMotion: "reduce",
      }),
      errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto(process.env.FIT_TEST_URL || "http://localhost:5174");
    await openLibrary(page);
    const builder = page.locator(".weight-loss-builder");
    assert.equal(await builder.getAttribute("open"), null);
    await builder.locator("summary").click();
    await builder
      .getByRole("combobox", { name: "Equipment", exact: true })
      .selectOption(kind);
    await builder
      .getByRole("combobox", { name: "Session length", exact: true })
      .selectOption(minutes);
    await builder
      .getByRole("combobox", { name: "Activity level", exact: true })
      .selectOption(level);
    if (kind === "Treadmill") {
      await builder
        .getByLabel("Minimum walking speed (km/h)", { exact: true })
        .fill("5");
      await builder
        .getByLabel("Maximum walking speed (km/h)", { exact: true })
        .fill(target);
      await builder
        .getByLabel("Maximum incline (%)", { exact: true })
        .fill("2");
      await builder
        .getByRole("button", { name: "Review programme", exact: true })
        .click();
      await builder
        .getByRole("alert")
        .filter({ hasText: "Minimum speed must be at most maximum speed." })
        .waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
      await builder
        .getByLabel("Minimum walking speed (km/h)", { exact: true })
        .fill("3");
    } else await builder.getByLabel(label, { exact: true }).fill(target);
    if (width === 412 && kind === "Treadmill")
      await page.screenshot({
        path: "artifacts/previews/weight-loss-treadmill-bounds.png",
        fullPage: true,
      });
    assert(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await builder
      .getByRole("button", { name: "Review programme", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    const name = await page
      .getByLabel("Programme name", { exact: true })
      .inputValue();
    assert.match(name, /Weight-loss/);
    await page
      .getByRole("button", { name: "Save programme", exact: true })
      .click();
    await page.getByRole("heading", { name, exact: true }).waitFor();
    await page.waitForFunction(async (name) => {
      const db = await new Promise((r) => {
        const q = indexedDB.open("smart-fit", 1);
        q.onsuccess = () => r(q.result);
      });
      return await new Promise((r) => {
        const q = db.transaction("data").objectStore("data").get("programmes");
        q.onsuccess = () => {
          db.close();
          r(q.result?.some((p) => p.name === name));
        };
      });
    }, name);
    const stored = await page.evaluate(async (name) => {
      const db = await new Promise((r) => {
        const q = indexedDB.open("smart-fit", 1);
        q.onsuccess = () => r(q.result);
      });
      return await new Promise((r) => {
        const q = db.transaction("data").objectStore("data").get("programmes");
        q.onsuccess = () => {
          db.close();
          r(q.result.find((p) => p.name === name));
        };
      });
    }, name);
    assert.equal(
      stored.blocks.reduce((n, b) => n + b.duration, 0),
      Number(minutes) * 60,
    );
    assert.equal(stored.kind, kind);
    const key =
      kind === "Treadmill" ? "speed" : kind === "Bike" ? "power" : "resistance";
    if (kind === "Treadmill") {
      assert(
        stored.blocks.every(
          (b) =>
            b.speed >= 3 &&
            b.speed <= Number(target) &&
            b.incline >= 0 &&
            b.incline <= 2,
        ),
      );
      assert(stored.blocks.some((b) => b.incline > 0));
      assert.equal(stored.blocks[0].incline, 0);
      assert.equal(stored.blocks.at(-1).incline, 0);
      if (level === "active") {
        const hills = stored.blocks.filter((b) => b.incline > 0);
        assert(hills.every((b) => b.speed < Number(target)));
        assert.equal(Math.max(...hills.map((b) => b.incline)), 2);
      }
    } else
      assert.equal(
        Math.max(...stored.blocks.map((b) => b[key])),
        Number(target),
      );
    await page.reload();
    await openLibrary(page);
    await page.getByRole("heading", { name, exact: true }).waitFor();
    const card = page
      .locator(".card")
      .filter({ has: page.getByRole("heading", { name, exact: true }) });
    await card
      .getByRole("button", { name: "Edit programme", exact: true })
      .click();
    await page.getByRole("dialog").waitFor();
    await page.getByRole("button", { name: "Close programme editor" }).click();
    assert.deepEqual(errors, []);
    console.log(
      `PASS ${width}px ${kind}: tailor, review, save, exact targets/duration, reload and edit`,
    );
    await page.close();
  }
} finally {
  await browser.close();
}
