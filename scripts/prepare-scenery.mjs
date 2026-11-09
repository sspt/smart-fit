// Reproduce the licensed starter clips; never downloads from YouTube.
import { readFile, mkdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
const directory = process.env.SCENERY_DIR || "/workspace/scenery-downloads";
await mkdir(directory, { recursive: true });
const records = JSON.parse(await readFile("docs/scenery-sources.json", "utf8"));
for (const record of records) {
  if (
    !/^[a-z0-9-]+$/.test(record.id) ||
    !record.sourceFile.startsWith("https://videos.pexels.com/")
  )
    throw Error("Invalid media source");
  const source = join(directory, record.id + "-source.mp4"),
    output = join(directory, record.id + ".mp4");
  let args = [
    "-v",
    "error",
    "-i",
    source,
    "-map",
    "0:v:0",
    "-an",
    "-vf",
    record.id.startsWith("forest")
      ? "scale=720:1280:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30"
      : "scale=540:960:force_original_aspect_ratio=decrease:force_divisible_by=2,fps=30",
    "-c:v",
    "libx264",
    "-preset",
    record.id.startsWith("forest") ? "fast" : "veryfast",
    "-crf",
    record.id.startsWith("forest") ? "24" : "28",
  ];
  if (!record.id.startsWith("forest"))
    args.push(
      "-maxrate",
      record.id.startsWith("autumn") ? "550k" : "1000k",
      "-bufsize",
      record.id.startsWith("autumn") ? "1100k" : "2000k",
    );
  args.push(
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    "-threads",
    "2",
    output,
    "-y",
  );
  for (const [command, options] of [
    [
      "curl",
      ["--fail", "--silent", "--show-error", record.sourceFile, "-o", source],
    ],
    ["ffmpeg", args],
  ]) {
    const result = spawnSync(command, options, { stdio: "inherit" });
    if (result.status !== 0) throw Error(command + " failed");
  }
  console.log("Prepared " + output);
}
