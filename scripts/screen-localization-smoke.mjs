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

      const header = page.locator("#root > header");
      async function assertHeaderVisible() {
        assert(await header.isVisible());
        assert.equal((await header.boundingBox()).y, 0);
      }
      async function assertTransparentToolbar(selector) {
        const style = await page.locator(selector).evaluate((item) => {
          const { backgroundColor, backgroundImage, backdropFilter } =
            getComputedStyle(item);
          return { backgroundColor, backgroundImage, backdropFilter };
        });
        assert.deepEqual(style, {
          backgroundColor: "rgba(0, 0, 0, 0)",
          backgroundImage: "none",
          backdropFilter: "none",
        });
      }
      await page.goto(origin + "/#setup");
      await page.locator(".setup-topline").waitFor();
      await assertTransparentToolbar(".setup-topline");
      await assertHeaderVisible();

      await page.goto(origin + "/#home");
      const install = page.getByRole("button", {
        name: /^Instalar kwest\.fit/,
      });
      await install.waitFor();
      assert.equal(await install.count(), 1);
      assert.equal(await page.locator(".home-library-link").count(), 0);
      await install.click();
      await page.locator(".home-install").getByRole("status").waitFor();
      await page.evaluate(() => {
        const event = new Event("beforeinstallprompt", { cancelable: true });
        event.prompt = async () =>
          document.body.setAttribute("data-install-requested", "true");
        window.dispatchEvent(event);
      });
      await install.click();
      assert.equal(
        await page.locator("body").getAttribute("data-install-requested"),
        "true",
      );
      await page.evaluate(() =>
        window.dispatchEvent(new Event("appinstalled")),
      );
      await install.waitFor({ state: "detached" });
      await assertHeaderVisible();

      await page.goto(origin + "/#library");
      await page
        .getByText("30 min · Remo por intervalos", { exact: true })
        .waitFor();
      await assertTransparentToolbar(".library-toolbar");
      const toolbarTop = (await page.locator(".library-toolbar").boundingBox())
        .y;
      await page.locator(".list-scroll").evaluate((item) => {
        item.scrollTop = 180;
      });
      assert.equal(
        (await page.locator(".library-toolbar").boundingBox()).y,
        toolbarTop,
      );
      await assertHeaderVisible();
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
      await assertTransparentToolbar(".discover-toolbar");
      await preview.click();
      await page.getByRole("button", { name: "Usar este percurso" }).waitFor();
      await assertHeaderVisible();
      assert(
        (await page.getByRole("dialog").boundingBox()).y >=
          (await header.boundingBox()).height,
      );
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
      await live
        .getByRole("button", { name: "Abrir vídeo", exact: true })
        .click();
      await live
        .getByRole("button", { name: "Visão imersiva", exact: true })
        .click();
      const expanded = live.locator(".video-mode.expanded");
      await expanded.waitFor();
      await assertHeaderVisible();
      assert(
        (await expanded.boundingBox()).y >= (await header.boundingBox()).height,
      );
      await page.keyboard.press("Escape");
      await expanded.waitFor({ state: "detached" });
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
