import { openLibrary, collectProgrammes } from "./ui-helpers.mjs";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const browser = await chromium.launch({
  headless: true,
  args: ["--no-sandbox"],
});
try {
  for (const width of [320, 412]) {
    const context = await browser.newContext({
      viewport: { width, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.goto("http://localhost:4173");
    await openLibrary(page);
    const nav = await page
      .getByRole("navigation", { name: "Main navigation" })
      .boundingBox();
    assert.ok(nav.y > 700, "navigation belongs at the bottom");
    await page.getByRole("button", { name: "Create programme" }).click();
    const dialog = page.getByRole("dialog", { name: "Build your session" });
    await dialog.getByLabel("Programme name").fill("Mobile builder");
    await dialog.getByRole("button", { name: "Bike", exact: true }).click();
    await dialog.getByRole("spinbutton", { name: /^Power/ }).fill("125");
    await dialog
      .getByRole("button", { name: "Treadmill", exact: true })
      .click();
    await dialog.getByLabel("Segment name").fill("Warm-up");
    await dialog.getByRole("spinbutton", { name: /^Minutes/ }).fill("2");
    await dialog.getByRole("spinbutton", { name: /^Seconds/ }).fill("30");
    await dialog.getByRole("spinbutton", { name: /^Speed/ }).fill("6.5");
    await dialog.getByRole("spinbutton", { name: /^Incline/ }).fill("1");
    await dialog.getByRole("switch").check();
    await dialog.getByRole("spinbutton", { name: /^End speed/ }).fill("8");
    await dialog.getByRole("spinbutton", { name: /^End incline/ }).fill("2");
    await dialog.getByRole("button", { name: "Increase repeat" }).click();
    await dialog.getByRole("button", { name: "Duplicate segment 1" }).click();
    await dialog.getByLabel("Segment name").fill("Recovery");
    await dialog.getByRole("switch").uncheck();
    await dialog.getByRole("button", { name: "Move segment 2 up" }).click();
    await dialog
      .getByRole("button", { name: "Add segment", exact: true })
      .click();
    await dialog.getByLabel("Segment name").fill("Distance finish");
    await dialog.getByRole("button", { name: "Distance", exact: true }).click();
    await dialog.getByRole("spinbutton", { name: /^Distance/ }).fill("750");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      "editor must fit phone width",
    );
    const box = await dialog.boundingBox();
    assert.equal(box.x, 0);
    assert.equal(box.y, 0);
    assert.equal(box.height, 844);
    assert.equal(box.width, width);
    // The title and Save remain available while the segment list scrolls.
    const save = dialog.getByRole("button", { name: "Save programme" });
    await page
      .locator(".editor-content")
      .evaluate((el) => el.scrollTo(0, el.scrollHeight));
    const saveBox = await save.boundingBox();
    assert.ok(saveBox.y < 90);
    await page.locator(".editor-content").evaluate((el) => el.scrollTo(0, 0));
    await dialog.getByLabel("Programme name").fill("");
    await save.click();
    await dialog.getByRole("alert").waitFor();
    await dialog.getByLabel("Programme name").fill("Mobile builder");
    await save.click();
    await page
      .getByRole("heading", { name: "Mobile builder", exact: true })
      .waitFor();
    await page
      .getByRole("heading", { name: "Mobile builder", exact: true })
      .locator("..")
      .getByRole("button", { name: "Edit programme" })
      .click();
    const names = await dialog
      .getByRole("button", { name: /^Edit segment/ })
      .allTextContents();
    assert.ok(names[0].includes("Recovery"));
    assert.ok(names[1].includes("Warm-up"));
    assert.ok(names[2].includes("750 m"));
    await dialog.getByRole("button", { name: /Edit segment 3:/ }).click();
    await dialog.getByRole("spinbutton", { name: /^Distance/ }).waitFor();
    assert.equal(
      await dialog.getByRole("spinbutton", { name: /^Distance/ }).inputValue(),
      "750",
    );
    assert.equal(
      await dialog.getByRole("spinbutton", { name: /^Repeat/ }).inputValue(),
      "2",
    );
    await dialog.getByRole("button", { name: "Duplicate segment 3" }).click();
    assert.equal(
      await dialog.getByRole("button", { name: /^Edit segment/ }).count(),
      4,
    );
    await dialog.getByRole("button", { name: "Remove segment 4" }).click();
    assert.equal(
      await dialog.getByRole("button", { name: /^Edit segment/ }).count(),
      3,
    );
    await page.screenshot({
      path: `/tmp/smart-fit-editor-${width}.png`,
      fullPage: false,
    });
    await save.click();
    await page
      .getByRole("heading", { name: "Mobile builder", exact: true })
      .waitFor();
    await page.screenshot({
      path: `/tmp/smart-fit-home-${width}.png`,
      fullPage: false,
    });
    assert.deepEqual(errors, []);
    await context.close();
    console.log(
      `PASS ${width}px: bottom navigation; full-screen editor; time/distance, ramp, repeat, reorder/copy/remove, validation and save/reopen.`,
    );
  }
  const desktop = await browser.newPage({
    viewport: { width: 1280, height: 900 },
  });
  await desktop.goto("http://localhost:4173");
  await openLibrary(desktop);
  await desktop.getByRole("button", { name: "Create programme" }).click();
  const desktopBox = await desktop.getByRole("dialog").boundingBox();
  assert.ok(desktopBox.width <= 640 && desktopBox.x > 0);
  await desktop.screenshot({ path: "/tmp/smart-fit-editor-desktop.png" });
  console.log("PASS desktop: contained editor dialog.");
} finally {
  await browser.close();
}
