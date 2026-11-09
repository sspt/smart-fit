/** Preserve the newer live application while applying this source-controlled visual refresh.
 * The repository predates production's Strava integration. This writes local artifacts only;
 * it never uploads assets, changes a Worker, or publishes an environment.
 */
import { chromium } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve, dirname } from "node:path";

const origin = "https://kwest.fit";
const output = resolve("artifacts/visual-release");
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  const page = await browser.newPage({ ignoreHTTPSErrors: true });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  async function download(path) {
    if (!path.startsWith("/") || path.startsWith("//") || path.includes(".."))
      throw new Error("Invalid asset path");
    const result = await page.evaluate(async (path) => {
      const response = await fetch(path, { cache: "no-store" });
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let i = 0; i < bytes.length; i += 16384)
        binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
      return {
        status: response.status,
        body: btoa(binary),
        type: response.headers.get("Content-Type"),
      };
    }, path);
    if (result.status !== 200)
      throw new Error(`Cannot fetch ${path}: ${result.status}`);
    return Buffer.from(result.body, "base64");
  }
  async function save(path, bytes) {
    const target = resolve(output, "." + path);
    if (!target.startsWith(output + "/"))
      throw new Error("Invalid output path");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  let html = (await download("/")).toString();
  const originalHtml = html;
  const assetList = JSON.parse(
    (await download("/offline-assets.json")).toString(),
  );
  const assets = new Set([
    ...assetList,
    ...[...html.matchAll(/(?:src|href)="(\/assets\/[^"\s]+)"/g)].map(
      (m) => m[1],
    ),
  ]);
  for (const path of assets) await save(path, await download(path));
  const cssPath = html.match(/href="(\/assets\/[^"\s]+\.css)"/)?.[1];
  if (!cssPath) throw new Error("Published stylesheet not found");
  const style = await readFile("src/modern.css", "utf8");
  const css =
    (await readFile(resolve(output, "." + cssPath), "utf8")) + "\n" + style;
  const hash = createHash("sha256").update(css).digest("hex").slice(0, 12);
  const nextCss = `/assets/visual-${hash}.css`;
  await save(nextCss, css);
  assets.add(nextCss);
  html = html
    .replace(cssPath, nextCss)
    .replace(
      "</head>",
      '<link rel="icon" type="image/svg+xml" href="/logo.svg" />\n<link rel="apple-touch-icon" href="/icon-192.png" />\n<link rel="preload" href="/fonts/manrope-latin.woff2" as="font" type="font/woff2" crossorigin />\n</head>',
    )
    .replace('content="#0c0e0e"', 'content="#0b1c16"');
  await save("/index.html", html);
  for (const path of [
    "/logo.svg",
    "/icon-192.png",
    "/icon-512.png",
    "/manifest.webmanifest",
    "/fonts/manrope-latin.woff2",
    "/fonts/manrope-latin-ext.woff2",
    "/fonts/OFL-Manrope.txt",
  ]) {
    await save(path, await readFile("public" + path));
    assets.add(path);
  }
  const originalSw = (await download("/sw.js")).toString();
  const version = createHash("sha256").update(html).digest("hex").slice(0, 12);
  // Cache namespaces have been content-versioned in every published shell.
  const sw = originalSw.replace(
    /(const\s+(?:CACHE|CACHE_NAME|VERSION)\s*=\s*["'])([^"']+)(["'])/,
    (_m, a, value, z) => a + value + "-visual-" + version + z,
  );
  if (sw === originalSw)
    throw new Error(
      "Inspect current service worker before preparing its new cache namespace",
    );
  await save("/sw.js", sw);
  await save("/offline-assets.json", JSON.stringify([...assets]));
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/visual-release-baseline.json",
    JSON.stringify(
      {
        origin,
        capturedAt: new Date().toISOString(),
        originalHtmlSha256: createHash("sha256")
          .update(originalHtml)
          .digest("hex"),
        visualVersion: version,
        applicationScripts: [
          ...html.matchAll(/src="(\/assets\/[^"\s]+\.js)"/g),
        ].map((m) => m[1]),
        note: "Application JavaScript is unchanged from production. Worker code, credentials and deployment settings are untouched.",
      },
      null,
      2,
    ),
  );
  console.log(`Prepared local visual release: ${output}`);
} finally {
  await browser.close();
}
