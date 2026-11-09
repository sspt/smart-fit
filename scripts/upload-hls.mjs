// Requires rclone configured with a bucket-scoped Cloudflare R2 S3 credential.
// Media goes first; the catalogue is published only after verification.
import { parseArgs } from "node:util";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseCatalog } from "../src/catalog.ts";
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { remote: { type: "string" } },
});
if (
  positionals.length !== 1 ||
  !values.remote ||
  !/^[-a-zA-Z0-9_]+:[-a-zA-Z0-9_/]+$/.test(values.remote)
)
  throw Error(
    "Usage: node scripts/upload-hls.mjs EXPORT_DIRECTORY --remote r2:smart-fit-scenery",
  );
const root = resolve(positionals[0]),
  receipt = JSON.parse(await readFile(join(root, "upload.json"), "utf8"));
if (
  receipt.version !== 1 ||
  !Array.isArray(receipt.files) ||
  !receipt.files.length
)
  throw Error("Invalid export receipt");
const [scene] = parseCatalog({ version: 1, scenes: [receipt.scene] });
const prefix = scene.hlsSrc.slice("/media/".length).replace("/master.m3u8", "");
for (const file of receipt.files) {
  if (
    !file ||
    typeof file.key !== "string" ||
    !file.key.startsWith(prefix + "/") ||
    !/^(?:[a-z0-9-]+\/){1,5}[a-z0-9-]+\.(mp4|m3u8|m4s|jpg)$/.test(file.key)
  )
    throw Error("Unsafe export path");
  const path = join(root, file.key),
    hash = createHash("sha256");
  if ((await stat(path)).size !== file.bytes)
    throw Error("Size mismatch: " + file.key);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  if (hash.digest("hex") !== file.sha256)
    throw Error("Hash mismatch: " + file.key);
}
function run(args, { capture = false, allowMissing = false } = {}) {
  return new Promise((done, fail) => {
    let out = "";
    const p = spawn("rclone", args, {
      stdio: ["ignore", capture ? "pipe" : "inherit", "inherit"],
    });
    if (capture) p.stdout.on("data", (b) => (out += b));
    p.on("error", fail);
    p.on("exit", (code) =>
      code === 0
        ? done(out)
        : allowMissing && (code === 3 || code === 4)
          ? done(null)
          : fail(Error("rclone failed with " + code)),
    );
  });
}
const remote = values.remote.replace(/\/$/, "");
const work = await mkdtemp(join(tmpdir(), "smart-fit-publish-"));
try {
  for (const key of [scene.hlsSrc, scene.poster])
    if (!receipt.files.some((f) => "/media/" + f.key === key))
      throw Error("Export is missing " + key);
  const list = join(work, "files.txt");
  await writeFile(
    list,
    receipt.files.map((f) => f.key.slice("hls/".length)).join("\n") + "\n",
  );
  await run([
    "copy",
    join(root, "hls"),
    remote + "/hls",
    "--files-from",
    list,
    "--immutable",
    "--transfers",
    "2",
    "--checkers",
    "4",
    "--s3-chunk-size",
    "64Mi",
    "--progress",
  ]);
  await run([
    "check",
    join(root, "hls"),
    remote + "/hls",
    "--files-from",
    list,
    "--one-way",
    "--size-only",
  ]);
  if (!receipt.files.some((f) => "/media/" + f.key === scene.src))
    await run(
      ["lsjson", "--stat", remote + "/" + scene.src.slice("/media/".length)],
      { capture: true },
    );
  // Publish the small mutable catalogue last. Use a single publisher.
  const previous = await run(["cat", remote + "/catalog.json"], {
    capture: true,
    allowMissing: true,
  });
  const existing = previous === null ? [] : parseCatalog(JSON.parse(previous));
  const scenes = [...existing.filter((s) => s.id !== scene.id), scene];
  parseCatalog({ version: 1, scenes });
  const file = join(work, "catalog.json");
  await writeFile(file, JSON.stringify({ version: 1, scenes }, null, 2) + "\n");
  await run([
    "copyto",
    file,
    remote + "/catalog.json",
    "--header-upload",
    "Content-Type: application/json",
  ]);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(
  `Published ${scene.name}. Reload the app after the catalogue cache expires (up to 60 seconds).`,
);
