import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
const b = await chromium.launch({ args: ["--no-sandbox"] });
const base = process.env.FIT_TEST_URL || "http://localhost:4173";
async function fake(page, support = true, granted = true) {
  await page.addInitScript(
    ({ support, granted }) => {
      window.bleCalls = { picker: 0, enumerate: 0, connect: 0, writes: 0 };
      const data = new EventTarget();
      Object.assign(data, {
        uuid: "00002acd-0000-1000-8000-00805f9b34fb",
        properties: { notify: true, read: true },
        startNotifications: async () => data,
        readValue: async () => new DataView(new ArrayBuffer(4)),
        writeValue: async () => {
          window.bleCalls.writes++;
        },
      });
      const service = {
        getCharacteristics: async () => [data],
        getCharacteristic: async () => {
          throw new DOMException("Not exposed", "NotFoundError");
        },
      };
      const device = new EventTarget();
      Object.assign(device, { id: "test-ftms", name: "Remembered treadmill" });
      device.gatt = {
        connected: false,
        connect: async () => {
          window.bleCalls.connect++;
          device.gatt.connected = true;
          return { getPrimaryService: async () => service };
        },
        disconnect: () => {
          device.gatt.connected = false;
        },
      };
      const bt = {
        requestDevice: async () => {
          window.bleCalls.picker++;
          return device;
        },
      };
      if (support)
        bt.getDevices = async () => {
          window.bleCalls.enumerate++;
          return granted ? [device] : [];
        };
      Object.defineProperty(navigator, "bluetooth", {
        value: bt,
        configurable: true,
      });
    },
    { support, granted },
  );
}
try {
  const c = await b.newContext({
      viewport: { width: 412, height: 844 },
      reducedMotion: "reduce",
    }),
    p = await c.newPage();
  await fake(p);
  const errors = [];
  p.on("pageerror", (e) => errors.push(e.message));
  await p.goto(base);
  await p
    .getByRole("button", { name: "Equipment connection", exact: true })
    .click();
  await p
    .getByRole("button", { name: "Connect equipment", exact: true })
    .click();
  await p.getByText("Connected · FTMS", { exact: true }).waitFor();
  assert.equal((await p.evaluate(() => window.bleCalls)).picker, 1);
  await p.reload();
  await p
    .getByRole("button", { name: "Equipment connection", exact: true })
    .click();
  await p.getByText("Connected · FTMS", { exact: true }).waitFor();
  assert.deepEqual(await p.evaluate(() => window.bleCalls), {
    picker: 0,
    enumerate: 1,
    connect: 1,
    writes: 0,
  });
  assert.equal(await p.locator(".active-session").count(), 0);
  await p.getByText("More connection options", { exact: true }).click();
  await p.getByRole("button", { name: "Disconnect", exact: true }).click();
  await p
    .getByRole("button", { name: "Connect Remembered treadmill", exact: true })
    .waitFor();
  assert.equal(
    (await p.evaluate(() => window.bleCalls)).connect,
    1,
    "manual disconnect must not trigger auto reconnect",
  );
  await p
    .getByLabel("Automatically reconnect to remembered equipment")
    .uncheck();
  await p.waitForFunction(
    () =>
      new Promise((resolve) => {
        const o = indexedDB.open("smart-fit", 1);
        o.onsuccess = () => {
          const r = o.result
            .transaction("data")
            .objectStore("data")
            .get("autoConnect");
          r.onsuccess = () => resolve(r.result === false);
        };
      }),
  );
  await p.reload();
  await p
    .getByRole("button", { name: "Equipment connection", exact: true })
    .click();
  await p
    .getByRole("button", { name: "Connect Remembered treadmill", exact: true })
    .waitFor();
  assert.equal((await p.evaluate(() => window.bleCalls)).enumerate, 0);
  await p.getByText("More connection options", { exact: true }).click();
  await p
    .getByRole("button", { name: "Forget remembered device", exact: true })
    .click();
  await p.waitForFunction(
    () =>
      new Promise((resolve) => {
        const o = indexedDB.open("smart-fit", 1);
        o.onsuccess = () => {
          const r = o.result
            .transaction("data")
            .objectStore("data")
            .get("knownDevice");
          r.onsuccess = () => resolve(r.result === null);
        };
      }),
  );
  await p.reload();
  await p
    .getByRole("button", { name: "Equipment connection", exact: true })
    .click();
  await p
    .getByRole("button", { name: "Connect equipment", exact: true })
    .waitFor();
  assert.equal((await p.evaluate(() => window.bleCalls)).connect, 0);
  assert.deepEqual(errors, []);
  console.log(
    "PASS first pairing, saved ID, silent reopen reconnect, no movement writes, disconnect suppression, opt-out and forgetting.",
  );
  // Known record with a browser that cannot enumerate: no automatic chooser.
  const unsupported = await b.newContext({ reducedMotion: "reduce" }),
    q = await unsupported.newPage();
  await fake(q, false);
  await q.goto(base);
  await q.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const r = indexedDB.open("smart-fit", 1);
        r.onsuccess = () => {
          const tx = r.result.transaction("data", "readwrite");
          tx.objectStore("data").put(
            {
              id: "test-ftms",
              name: "Remembered treadmill",
              kind: "Treadmill",
              protocol: "FTMS",
            },
            "knownDevice",
          );
          tx.oncomplete = () => resolve();
          tx.onerror = reject;
        };
      }),
  );
  await q.reload();
  await q
    .getByRole("button", { name: "Equipment connection", exact: true })
    .click();
  await q
    .getByRole("button", { name: "Connect Remembered treadmill", exact: true })
    .click();
  await q.getByText("Connected · FTMS", { exact: true }).waitFor();
  assert.equal((await q.evaluate(() => window.bleCalls)).picker, 1);
  console.log(
    "PASS unsupported getDevices uses the picker only after explicit Connect.",
  );
} finally {
  await b.close();
}
