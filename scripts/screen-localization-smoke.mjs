import assert from "node:assert/strict";
import { chromium } from "playwright";

const origin = process.env.FIT_TEST_URL || "http://localhost:5174";
const browser = await chromium.launch({
  executablePath: "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  for (const width of [320, 412, 1280]) {
    const page = await browser.newPage({
      viewport: { width, height: 844 },
      locale: "pt-PT",
      serviceWorkers: "block",
    });
    try {
      page.setDefaultTimeout(7000);
      for (const [route, screen] of [
        ["home", "Train"],
        ["discover", "Explore"],
        ["library", "Programmes"],
        ["journal", "History"],
        ["settings", "Settings"],
        ["equipment", "Devices"],
        ["setup", "Setup"],
        ["live", "Live"],
      ]) {
        await page.goto(`${origin}/#${route}`);
        await page.locator(`main[data-page="${screen}"]`).waitFor();
        await page
          .getByRole("navigation", { name: "Navegação principal" })
          .waitFor();
        assert(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
          screen,
        );
      }

      await page.goto(origin + "/#library");
      await page
        .getByText("30 min · Remo por intervalos", { exact: true })
        .waitFor();
      const surface = (locator) =>
        locator.evaluate((item) => getComputedStyle(item).backgroundColor);
      assert.equal(
        await surface(page.locator(".library-toolbar")),
        await surface(page.locator("main > nav")),
      );
      await page
        .getByRole("button", { name: "Criar programa", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Programa automático de perda de peso" })
        .click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByLabel("Velocidade mínima de caminhada (km/h)")
        .waitFor();
      await dialog
        .getByLabel("Equipamento", { exact: true })
        .selectOption("Bike");
      await dialog.getByLabel(/Potência.*\(W\)/i).waitFor();
      await dialog.getByRole("button", { name: "Rever programa" }).click();
      await page.getByRole("dialog").getByLabel("Nome do programa").waitFor();
      assert.match(
        await page.getByLabel("Nome do programa").inputValue(),
        /Ciclismo para perder peso/,
      );
      await page.keyboard.press("Escape");

      await page.goto(origin + "/#discover");
      const preview = page
        .getByRole("button", { name: /^Pré-visualizar percurso:/ })
        .first();
      const label = await preview.getAttribute("aria-label");
      assert(label);
      assert(!label.includes("Nature escape"));
      await preview.click();
      await page.getByRole("button", { name: "Usar este percurso" }).waitFor();
      await page.evaluate(async () => {
        const db = await new Promise((resolve, reject) => {
          const request = indexedDB.open("smart-fit", 1);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transaction = db.transaction("data", "readwrite");
        transaction.objectStore("data").put(
          {
            id: "screen-smoke-session",
            programme: {
              id: "screen-smoke-programme",
              name: "Treino de verificação",
              kind: "Treadmill",
              repeat: 1,
              blocks: [
                {
                  name: "Aquecimento",
                  duration: 90,
                  speed: 5,
                  incline: 0,
                  power: 0,
                  resistance: 1,
                },
              ],
            },
            started: Date.now(),
            elapsed: 23,
            phase: 0,
            cycle: 0,
            phaseElapsed: 23,
            phaseDistance: 0,
            distance: 0,
            status: "active",
            demo: false,
            automatic: false,
            controlMode: "follow",
            samples: [],
            events: [],
          },
          "active",
        );
        await new Promise((resolve, reject) => {
          transaction.oncomplete = resolve;
          transaction.onerror = () => reject(transaction.error);
        });
        db.close();
      });
      await page.goto(origin + "/#live");
      await page.reload();
      await page
        .getByRole("button", { name: "Em treino", exact: true })
        .waitFor();
      const live = page.locator(".live-screen");
      await live
        .getByText(
          "Volte a ligar o equipamento para usar o controlo automático.",
          { exact: true },
        )
        .waitFor();
      await live.getByText("Passadeira · 00:23", { exact: true }).waitFor();
      await live.getByRole("button", { name: "Sessão", exact: true }).click();
      await live
        .getByRole("button", {
          name: "Terminar registo do treino",
          exact: true,
        })
        .waitFor();
      assert(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
        "active workout",
      );
      console.log(
        `PASS ${width}px: navigation, Library, programme builder, route preview and recovered workout`,
      );
    } finally {
      await page.close();
    }
  }
} finally {
  await browser.close();
}
