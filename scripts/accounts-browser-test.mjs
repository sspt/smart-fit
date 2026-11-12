import fs from "node:fs/promises";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { openLibrary } from "./ui-helpers.mjs";
const origin = process.env.FIT_TEST_URL || "http://localhost:8787",
  browser = await chromium.launch({
    executablePath: "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
const tag = crypto.randomUUID(),
  aliceEmail = `alice-${tag}@example.test`,
  bobEmail = `bob-${tag}@example.test`,
  password = "Test-" + crypto.randomUUID() + "!";
if (process.env.LIVE_TEST_RECEIPT)
  await fs.writeFile(
    process.env.LIVE_TEST_RECEIPT,
    JSON.stringify({ emails: [aliceEmail, bobEmail] }),
  );
const errors = [];
async function pageFor(width = 412) {
  const p = await browser.newPage({
    viewport: { width, height: 844 },
    reducedMotion: "reduce",
  });
  p.on("pageerror", (e) => errors.push(e.message));
  await p.addInitScript(() => {
    window.__accountTestFetch = window.fetch.bind(window);
  });
  await p.goto(origin);
  await p.getByRole("button", { name: "Start", exact: true }).waitFor();
  return p;
}
async function settings(p) {
  await p
    .getByRole("navigation")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await p.locator(".account-panel").waitFor();
}
async function reload(p, fn) {
  await Promise.all([p.waitForEvent("load"), fn()]);
  await p.getByRole("button", { name: "Start", exact: true }).waitFor();
}
async function auth(p, register, name, email) {
  await settings(p);
  await p.getByText("Sign in with email", { exact: true }).click();
  const panel = p.locator(".account-panel");
  if (register) {
    await panel
      .getByRole("button", { name: "Create an account", exact: true })
      .click();
    await panel.getByLabel("Your name", { exact: true }).fill(name);
  }
  await panel.getByLabel("Email", { exact: true }).fill(email);
  await panel.getByLabel("Password", { exact: true }).fill(password);
  await reload(p, () =>
    panel
      .getByRole("button", {
        name: register ? "Create account" : "Sign in",
        exact: true,
      })
      .click(),
  );
  await settings(p);
  await panel.getByText(name, { exact: true }).waitFor();
}
async function browserApi(p, path, headers = {}) {
  return p.evaluate(
    async ({ path, headers }) => {
      const r = await window.__accountTestFetch(path, {
        headers,
        credentials: "same-origin",
      });
      return { status: r.status, ok: r.ok, data: await r.json() };
    },
    { path, headers },
  );
}
async function cloudValue(p, kind, id) {
  const r = await browserApi(p, `/api/data/${kind}/` + encodeURIComponent(id));
  return r.ok ? r.data.value : null;
}
async function until(fn, predicate) {
  for (let i = 0; i < 150; i++) {
    const value = await fn();
    if (predicate(value)) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error("Timed out waiting for persisted cloud data");
}
async function findProgramme(p, name) {
  await openLibrary(p);
  await p.getByLabel("Search programmes", { exact: true }).fill(name);
  await p.getByRole("heading", { name, exact: true }).waitFor();
  return p
    .locator(".card")
    .filter({ has: p.getByRole("heading", { name, exact: true }) });
}
async function rename(p, from, to) {
  const card = await findProgramme(p, from);
  await card
    .getByRole("button", { name: "Edit programme", exact: true })
    .click();
  await p.getByLabel("Programme name", { exact: true }).fill(to);
  await p.getByRole("button", { name: "Save programme", exact: true }).click();
  await p.getByLabel("Search programmes", { exact: true }).fill(to);
  await p.getByRole("heading", { name: to, exact: true }).waitFor();
}
try {
  const a = await pageFor(320);
  await a.waitForFunction(async () => {
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
  await a.evaluate(async () => {
    const db = await new Promise((r) => {
        const q = indexedDB.open("smart-fit", 1);
        q.onsuccess = () => r(q.result);
      }),
      tx = db.transaction("data", "readwrite"),
      p = {
        id: "guest-custom",
        name: "Guest walk",
        kind: "Treadmill",
        repeat: 1,
        blocks: [
          {
            name: "Walk",
            duration: 900,
            speed: 4,
            incline: 1,
            power: 0,
            resistance: 1,
          },
        ],
      };
    tx.objectStore("data").put([p], "programmes");
    tx.objectStore("data").put(
      [
        {
          id: "guest-history",
          programme: p,
          started: Date.now(),
          elapsed: 900,
          status: "completed",
          demo: false,
          samples: [],
          events: [],
        },
      ],
      "history",
    );
    await new Promise((r) => (tx.oncomplete = r));
    db.close();
  });
  await a.reload();
  await a.getByRole("button", { name: "Start", exact: true }).waitFor();
  await auth(a, true, "Alice", aliceEmail);
  const alice = (await browserApi(a, "/api/auth/status")).data.user;
  await openLibrary(a);
  assert.equal(
    await a.getByRole("heading", { name: "Guest walk", exact: true }).count(),
    0,
  );
  console.log("PASS signup isolates guest data until explicit import");
  await settings(a);
  await a.getByText("Account options", { exact: true }).click();
  a.once("dialog", (d) => d.accept());
  await reload(a, () =>
    a.getByRole("button", { name: "Import device data", exact: true }).click(),
  );
  await findProgramme(a, "Guest walk");
  await until(
    () => cloudValue(a, "programmes", "guest-custom"),
    (v) => v?.name === "Guest walk",
  );
  assert((await cloudValue(a, "history", "guest-history")).elapsed === 900);
  console.log("PASS explicit guest import syncs programmes and history");
  let failedOnce = false;
  await a.route("**/api/data/programmes/guest-custom", async (route) => {
    if (route.request().method() === "PUT" && !failedOnce) {
      failedOnce = true;
      await route.fulfill({
        status: 503,
        json: { error: "Temporary test outage" },
      });
    } else await route.continue();
  });
  await rename(a, "Guest walk", "Retry walk");
  await until(
    () => cloudValue(a, "programmes", "guest-custom"),
    (v) => v?.name === "Retry walk",
  );
  assert(failedOnce);
  await a.unroute("**/api/data/programmes/guest-custom");
  await rename(a, "Retry walk", "Guest walk");
  await until(
    () => cloudValue(a, "programmes", "guest-custom"),
    (v) => v?.name === "Guest walk",
  );
  console.log(
    "PASS transient service failures retry without losing local edits",
  );
  const b = await pageFor();
  await auth(b, false, "Alice", aliceEmail);
  await findProgramme(b, "Guest walk");
  await b
    .getByRole("navigation")
    .getByRole("button", { name: "Journal", exact: true })
    .click();
  await b.getByRole("heading", { name: "Guest walk", exact: true }).waitFor();
  console.log("PASS another device restores programmes and history from D1");
  await settings(a);
  await reload(a, () =>
    a.getByRole("button", { name: "Sign out", exact: true }).click(),
  );
  await findProgramme(a, "Guest walk");
  await auth(a, true, "Bob", bobEmail);
  assert.equal(
    (await browserApi(a, "/api/data/programmes/guest-custom")).status,
    404,
  );
  await openLibrary(a);
  assert.equal(
    await a.getByRole("heading", { name: "Guest walk", exact: true }).count(),
    0,
  );
  console.log("PASS account switching cannot expose another user’s programmes");
  await b.context().setOffline(true);
  await rename(b, "Guest walk", "Offline walk");
  await b.waitForFunction(async (id) => {
    const db = await new Promise((r) => {
      const q = indexedDB.open("smart-fit", 1);
      q.onsuccess = () => r(q.result);
    });
    return await new Promise((r) => {
      const q = db
        .transaction("data")
        .objectStore("data")
        .get("account:" + id + ":cloud-state");
      q.onsuccess = () => {
        db.close();
        r(
          q.result?.outbox?.["programmes:guest-custom"]?.value?.name ===
            "Offline walk",
        );
      };
    });
  }, alice.id);
  const c = await pageFor(1280);
  await auth(c, false, "Alice", aliceEmail);
  await rename(c, "Guest walk", "Cloud walk");
  await until(
    () => cloudValue(c, "programmes", "guest-custom"),
    (v) => v?.name === "Cloud walk",
  );
  await b.context().setOffline(false);
  await settings(b);
  await b.locator(".account-conflicts").waitFor();
  assert.equal(
    (await cloudValue(c, "programmes", "guest-custom")).name,
    "Cloud walk",
  );
  b.once("dialog", (d) => d.accept());
  await reload(b, () =>
    b
      .getByRole("button", { name: "Keep this device’s version", exact: true })
      .click(),
  );
  await until(
    () => cloudValue(b, "programmes", "guest-custom"),
    (v) => v?.name === "Offline walk",
  );
  console.log(
    "PASS offline outbox, stale-write rejection and explicit conflict resolution",
  );
  await settings(b);
  await b.getByText("Account options", { exact: true }).click();
  b.once("dialog", (d) => d.accept());
  await b
    .getByRole("button", { name: "Import device data", exact: true })
    .click();
  await b.getByText("No new device data to import.", { exact: true }).waitFor();
  // An active session makes account switching unavailable.
  await b.evaluate(async (id) => {
    const db = await new Promise((r) => {
        const q = indexedDB.open("smart-fit", 1);
        q.onsuccess = () => r(q.result);
      }),
      tx = db.transaction("data", "readwrite"),
      r = tx.objectStore("data").get("account:" + id + ":history");
    r.onsuccess = () => {
      const history = r.result;
      tx.objectStore("data").put(
        {
          ...history[0],
          id: "active-test",
          status: "active",
          automatic: false,
        },
        "account:" + id + ":active",
      );
    };
    await new Promise((r) => (tx.oncomplete = r));
    db.close();
  }, alice.id);
  await b.reload();
  await b
    .getByRole("button", { name: "Resume journey", exact: true })
    .waitFor();
  await settings(b);
  assert(
    await b.getByRole("button", { name: "Sign out", exact: true }).isDisabled(),
  );
  assert(
    await b.getByRole("button", { name: "Sync now", exact: true }).isDisabled(),
  );
  assert(
    await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
  );
  await b.screenshot({
    path: "artifacts/previews/accounts.png",
    fullPage: true,
  });
  assert.deepEqual(errors, []);
  console.log("PASS active-session account guard and mobile layout");
  const mismatched = await browserApi(b, "/api/strava/status", {
    "X-Kwest-Account": "another-user",
  });
  assert.equal(mismatched.status, 401);
  console.log("PASS Strava cannot fall back to another account’s connection");
} finally {
  await browser.close();
}
