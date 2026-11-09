// Publish only a prepared export into the NAS's dedicated static-media folder.
import { parseArgs } from "node:util";
import {
  readFile,
  writeFile,
  mkdir,
  stat,
  copyFile,
  rename,
  rm,
  chmod,
  realpath,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { resolve, join, dirname, sep } from "node:path";
import { parseCatalog } from "../src/catalog.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { root: { type: "string" } },
});
if (positionals.length !== 1 || !values.root)
  throw Error(
    "Usage: node scripts/publish-nas.mjs EXPORT_DIRECTORY --root /mnt/nas/fit-media",
  );
const source = await realpath(resolve(positionals[0])),
  root = resolve(values.root),
  receipt = JSON.parse(await readFile(join(source, "upload.json"), "utf8"));
if (
  receipt.version !== 1 ||
  !Array.isArray(receipt.files) ||
  !receipt.files.length
)
  throw Error("Invalid export receipt.");
const [scene] = parseCatalog({ version: 1, scenes: [receipt.scene] }),
  prefix = scene.hlsSrc.slice("/media/".length).replace("/master.m3u8", "");
async function digest(file) {
  const h = createHash("sha256");
  for await (const b of createReadStream(file)) h.update(b);
  return h.digest("hex");
}
for (const f of receipt.files) {
  if (
    !f ||
    typeof f.key !== "string" ||
    !f.key.startsWith(prefix + "/") ||
    !/^(?:[a-z0-9-]+\/){1,5}[a-z0-9-]+\.(?:mp4|m3u8|m4s|jpg)$/.test(f.key)
  )
    throw Error("Unsafe export path.");
  const path = await realpath(join(source, f.key));
  if (
    !path.startsWith(source + sep) ||
    (await stat(path)).size !== f.bytes ||
    (await digest(path)) !== f.sha256
  )
    throw Error("Export validation failed: " + f.key);
}
for (const asset of [scene.hlsSrc, scene.poster])
  if (!receipt.files.some((f) => "/media/" + f.key === asset))
    throw Error("Missing export asset " + asset);
await mkdir(root, { recursive: true, mode: 0o755 });
const lock = join(root, ".publish-lock");
try {
  await mkdir(lock);
} catch (e) {
  if (e.code === "EEXIST")
    throw Error(
      "Another publisher holds .publish-lock. Check for a running job before removing a stale lock.",
    );
  throw e;
}
const staging = join(root, ".incoming-" + randomUUID());
try {
  let existing = [];
  try {
    existing = parseCatalog(
      JSON.parse(await readFile(join(root, "catalog.json"), "utf8")),
    );
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (!receipt.files.some((f) => "/media/" + f.key === scene.src))
    await stat(join(root, scene.src.slice("/media/".length)));
  let present = false;
  try {
    await stat(join(root, prefix));
    present = true;
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  if (present) {
    for (const f of receipt.files)
      if ((await digest(join(root, f.key))) !== f.sha256)
        throw Error("Existing immutable media differs: " + f.key);
  } else {
    for (const f of receipt.files) {
      const to = join(staging, f.key);
      await mkdir(dirname(to), { recursive: true, mode: 0o755 });
      await copyFile(join(source, f.key), to);
      await chmod(to, 0o644);
      if ((await digest(to)) !== f.sha256)
        throw Error("NAS copy verification failed: " + f.key);
    }
    await mkdir(dirname(join(root, prefix)), { recursive: true, mode: 0o755 });
    await rename(join(staging, prefix), join(root, prefix));
  }
  const scenes = [...existing.filter((r) => r.id !== scene.id), scene];
  parseCatalog({ version: 1, scenes });
  const next = join(root, ".catalog-" + randomUUID() + ".json");
  await writeFile(
    next,
    JSON.stringify({ version: 1, scenes }, null, 2) + "\n",
    { mode: 0o644 },
  );
  await rename(next, join(root, "catalog.json"));
  console.log(
    `Published ${scene.name} into ${root}. Reload the app to see it.`,
  );
} finally {
  await rm(staging, { recursive: true, force: true });
  await rm(lock, { recursive: true, force: true });
}
