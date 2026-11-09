import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
const html = await readFile("dist/index.html", "utf8");
const id = createHash("sha256").update(html).digest("hex").slice(0, 12);
await writeFile(
  "dist/sw.js",
  (await readFile("public/sw.js", "utf8")).replace("__BUILD__", id),
);

await writeFile(
  "dist/offline-assets.json",
  JSON.stringify((await readdir("dist/assets")).map((n) => "/assets/" + n)),
);
