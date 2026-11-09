import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { openLibrary, collectProgrammes } from "./ui-helpers.mjs";
const b = await chromium.launch({ args: ["--no-sandbox"] });
try {
  for (const width of [320, 412, 1280]) {
    const p = await b.newPage({ viewport: { width, height: 900 } });
    const errors = [];
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto("http://localhost:8787");
    await p.getByRole("heading", { name: "The world can wait." }).waitFor();
    await p.getByRole("button", { name: "Pause opening scenery" }).click();
    assert.equal(await p.locator(".entrance-film").count(), 0);
    await p.getByRole("button", { name: "Play opening scenery" }).click();
    await p.waitForFunction(
      () => document.querySelector(".entrance-film")?.readyState >= 2,
    );
    await openLibrary(p);
    assert.equal((await collectProgrammes(p)).length, 9);
    await p.getByText("Filter programmes", { exact: true }).click();
    await p
      .getByRole("group", { name: "Filter by equipment" })
      .getByRole("button", { name: "Bike", exact: true })
      .click();
    assert.equal(await p.locator(".cards>.card").count(), 3);
    await p
      .getByRole("group", { name: "Filter by duration" })
      .getByRole("button", { name: "30 min", exact: true })
      .click();
    assert.equal(await p.locator(".cards>.card").count(), 1);
    await p
      .getByRole("searchbox", { name: "Search programmes" })
      .fill("nothing matches");
    await p.getByRole("heading", { name: "No matching programmes" }).waitFor();
    await p.getByRole("button", { name: "Clear filters" }).click();
    assert.equal((await collectProgrammes(p)).length, 9);
    await p
      .getByRole("navigation")
      .getByRole("button", { name: "Discover", exact: true })
      .click();
    assert.equal(await p.locator(".routes-grid .route-card").count(), 3);
    await p
      .getByRole("group", { name: "Filter by equipment" })
      .getByRole("button", { name: "Rower", exact: true })
      .click();
    assert.equal(await p.locator(".routes-grid .route-card").count(), 1);
    await p.getByRole("button", { name: /^Preview / }).click();
    const dialog = p.getByRole("dialog", { name: "Scenery preview" });
    await dialog.waitFor();
    await p.waitForFunction(
      () => document.querySelector(".route-preview video")?.readyState >= 1,
    );
    await dialog
      .getByRole("button", { name: "Use this scene", exact: true })
      .click();
    await p.getByRole("heading", { name: "Connect your equipment." }).waitFor();
    assert.equal(
      await p
        .getByRole("button", { name: "Rower Pace & resistance" })
        .getAttribute("aria-pressed"),
      "true",
    );
    await p.getByRole("button", { name: "Equipment connection" }).click();
    await p
      .getByRole("heading", { name: "Your equipment", exact: true })
      .waitFor();
    for (const name of ["Journal", "Settings", "Home"]) {
      await p
        .getByRole("navigation")
        .getByRole("button", { name, exact: true })
        .click();
      assert(
        await p.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    }
    assert.deepEqual(errors, []);
    await p.close();
    console.log(
      `PASS ${width}px: paged library, filters, real scenery preview and guided entry, equipment and navigation.`,
    );
  }
  const p = await b.newPage({ reducedMotion: "reduce" });
  await p.goto("http://localhost:8787");
  await p.getByRole("button", { name: "Play opening scenery" }).waitFor();
  assert.equal(await p.locator(".entrance-film").count(), 0);
  await p.close();
} finally {
  await b.close();
}
