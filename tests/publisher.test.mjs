import { it, expect } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
it("publishes a verified NAS export atomically, preserves scenes and rejects changed assets", async () => {
  const work = await mkdtemp(join(tmpdir(), "fit-publisher-"));
  try {
    const source = join(work, "export"),
      root = join(work, "nas"),
      prefix = "hls/test-video";
    await mkdir(join(source, prefix), { recursive: true });
    const scene = {
      id: "test-video",
      name: "Test scene",
      kind: "Treadmill",
      reference: 5,
      seconds: 60,
      author: "Test",
      source: "https://example.com/scene",
      format: "route",
      src: "/media/" + prefix + "/fallback.mp4",
      hlsSrc: "/media/" + prefix + "/master.m3u8",
      poster: "/media/" + prefix + "/poster.jpg",
    };
    const files = [];
    for (const [name, content] of [
      ["master.m3u8", "#EXTM3U\n"],
      ["fallback.mp4", "video"],
      ["poster.jpg", "image"],
    ]) {
      await writeFile(join(source, prefix, name), content);
      files.push({
        key: prefix + "/" + name,
        bytes: Buffer.byteLength(content),
        sha256: createHash("sha256").update(content).digest("hex"),
      });
    }
    await writeFile(
      join(source, "upload.json"),
      JSON.stringify({ version: 1, scene, files }),
    );
    const publish = () =>
      spawnSync(
        process.execPath,
        ["scripts/publish-nas.mjs", source, "--root", root],
        { cwd: process.cwd(), encoding: "utf8" },
      );
    const first = publish();
    expect(first.status, first.stderr).toBe(0);
    const catalogue = await readFile(join(root, "catalog.json"), "utf8");
    expect(JSON.parse(catalogue).scenes).toEqual([scene]);
    expect(publish().status).toBe(0);
    expect(await readFile(join(root, "catalog.json"), "utf8")).toBe(catalogue);
    await writeFile(join(source, prefix, "fallback.mp4"), "tampered");
    expect(publish().status).not.toBe(0);
    expect(await readFile(join(root, "catalog.json"), "utf8")).toBe(catalogue);
    expect(await readFile(join(root, prefix, "fallback.mp4"), "utf8")).toBe(
      "video",
    );
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
