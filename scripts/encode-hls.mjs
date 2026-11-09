// Offline preparation only. Originals are never overwritten or uploaded here.
import { parseArgs } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  stat,
  rename,
  rm,
} from "node:fs/promises";
import { resolve, join, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
const { values: a } = parseArgs({
  options: {
    input: { type: "string" },
    id: { type: "string" },
    name: { type: "string" },
    kind: { type: "string" },
    reference: { type: "string" },
    author: { type: "string" },
    source: { type: "string" },
    out: { type: "string" },
    fallback: { type: "string" },
    loop: { type: "boolean", default: false },
    preset: { type: "string", default: "medium" },
    threads: { type: "string", default: "2" },
  },
});
if (
  !a.input ||
  !a.id ||
  !a.name ||
  !a.kind ||
  !a.reference ||
  !a.author ||
  !a.source ||
  !/^[a-z0-9-]{1,60}$/.test(a.id) ||
  !["Treadmill", "Bike", "Rower"].includes(a.kind) ||
  !(Number(a.reference) > 0 && Number(a.reference) <= 100) ||
  !["ultrafast", "veryfast", "fast", "medium", "slow"].includes(a.preset) ||
  !/^\d+$/.test(a.threads) ||
  Number(a.threads) < 1 ||
  Number(a.threads) > 64
)
  throw Error(
    "Required: --input FILE --id slug --name TITLE --kind Treadmill|Bike|Rower --reference KMH --author NAME --source HTTPS_URL [--out DIR] [--loop] [--fallback /media/existing.mp4]",
  );
if (!["http:", "https:"].includes(new URL(a.source).protocol))
  throw Error("Source must be an http(s) credit URL.");
if (
  a.fallback &&
  !/^\/media\/(?:[a-z0-9-]+\/){0,5}[a-z0-9-]+\.mp4$/.test(a.fallback)
)
  throw Error("Fallback must reference an existing app MP4.");
const input = resolve(a.input),
  root = resolve(a.out || "media-exports");
if (!(await stat(input)).isFile())
  throw Error("Input must be a local video file.");
function probe(file) {
  const p = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height,duration,avg_frame_rate,r_frame_rate,sample_aspect_ratio,color_transfer:stream_tags=rotate:stream_side_data=rotation",
      "-show_entries",
      "format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );
  if (p.status !== 0) throw Error("ffprobe failed: " + p.stderr);
  return JSON.parse(p.stdout);
}
function run(command, args) {
  return new Promise((done, fail) => {
    const p = spawn(command, args, { stdio: "inherit" });
    p.once("error", fail);
    p.once("exit", (code) =>
      code === 0 ? done() : fail(Error(command + " failed with " + code)),
    );
  });
}
const info = probe(input),
  s = info.streams[0],
  streamSeconds = Number(s?.duration),
  seconds =
    Number.isFinite(streamSeconds) && streamSeconds > 0
      ? streamSeconds
      : Number(info.format.duration);
if (!s || !(seconds > 0 && seconds <= 86400))
  throw Error("No supported video track or invalid duration.");
const rotation = Number(
  s.side_data_list?.find((x) => x.rotation != null)?.rotation ??
    s.tags?.rotate ??
    0,
);
const sar = String(s.sample_aspect_ratio || "1:1")
  .split(":")
  .map(Number);
let width = s.width * (sar[1] > 0 ? sar[0] / sar[1] : 1),
  height = s.height;
if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width];
const rateText =
  s.avg_frame_rate && s.avg_frame_rate !== "0/0"
    ? s.avg_frame_rate
    : s.r_frame_rate;
const [fn, fd] = String(rateText).split("/").map(Number);
const validRate = Number.isFinite(fn / fd) && fn / fd > 0;
const fps = Math.min(60, validRate ? fn / fd : 30);
const fpsText = validRate && fn / fd <= 60 ? rateText : String(fps);
const short = Math.floor(Math.min(width, height) / 2) * 2;
const tiers = [360, 540, 720, 1080, 1440, 2160].filter((t) => t <= short);
if (!tiers.length) tiers.push(short);
else if (short < 2160 && !tiers.includes(short)) tiers.push(short);
const hdr = ["smpte2084", "arib-std-b67"].includes(s.color_transfer);
const config = {
  version: 3,
  encoderVersion: spawnSync("ffmpeg", ["-version"], {
    encoding: "utf8",
  }).stdout.split("\n")[0],
  threads: Number(a.threads),
  tiers,
  fps: fpsText,
  preset: a.preset,
  loop: a.loop,
  reference: Number(a.reference),
  name: a.name,
  kind: a.kind,
  author: a.author,
  source: a.source,
  fallback: a.fallback ?? null,
};
const hasher = createHash("sha256");
for await (const chunk of createReadStream(input)) hasher.update(chunk);
const sourceHash = hasher.digest("hex");
const version = createHash("sha256")
    .update(sourceHash)
    .update(JSON.stringify(config))
    .digest("hex")
    .slice(0, 12),
  id = `${a.id}-${version}`,
  key = `hls/${id}`,
  target = join(root, id);
await mkdir(root, { recursive: true });
try {
  const existing = JSON.parse(
    await readFile(join(target, "upload.json"), "utf8"),
  );
  if (existing.sourceSha256 === sourceHash) {
    console.log("Already prepared: " + target);
    process.exit(0);
  }
  throw Error("Existing export does not match source.");
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
const staging = join(root, `.building-${id}-${randomUUID()}`),
  media = join(staging, key);
await mkdir(media, { recursive: true });
const levels = [];
const tone = hdr
  ? "zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,"
  : "";

try {
  for (const tier of tiers) {
    const ratio = Math.min(tier / short, 3840 / Math.max(width, height), 1),
      w = Math.floor((width * ratio) / 2) * 2,
      h = Math.floor((height * ratio) / 2) * 2;
    const rate =
      tier >= 2160
        ? 20000
        : tier >= 1440
          ? 11000
          : tier >= 1080
            ? 6000
            : tier >= 720
              ? 3000
              : tier >= 540
                ? 1600
                : 800;
    if (levels.some((l) => l.width === w && l.height === h)) continue;
    const mb = Math.ceil(w / 16) * Math.ceil(h / 16);
    const level = [
      [31, 3600, 108000],
      [32, 5120, 216000],
      [41, 8192, 245760],
      [42, 8704, 522240],
      [51, 36864, 983040],
      [52, 36864, 2073600],
    ].find(([, frames, rate]) => mb <= frames && mb * fps <= rate * 1.001)?.[0];
    if (!level)
      throw Error("Source geometry exceeds supported H.264 delivery limits.");
    const folder = `${tier}p`,
      dir = join(media, folder);
    await mkdir(dir);
    console.log(
      `Encoding ${folder}: ${w}×${h}, ${fps.toFixed(2)}fps, silent${hdr ? ", HDR → SDR" : ""}`,
    );
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      "-i",
      input,
      "-map",
      "0:v:0",
      "-an",
      "-sn",
      "-dn",
      "-map_metadata",
      "-1",
      "-vf",
      `${tone}scale=${w}:${h}:flags=lanczos,setsar=1,fps=${fpsText},format=yuv420p,setpts=PTS-STARTPTS`,
      "-c:v",
      "libx264",
      "-profile:v",
      "high",
      "-level:v",
      (level / 10).toFixed(1),
      "-preset",
      a.preset,
      "-crf",
      "22",
      "-maxrate",
      `${Math.ceil(rate * 1.35)}k`,
      "-bufsize",
      `${Math.ceil(rate * 2.7)}k`,
      "-g",
      String(Math.round(fps * 2)),
      "-keyint_min",
      String(Math.round(fps * 2)),
      "-sc_threshold",
      "0",
      "-force_key_frames",
      "expr:gte(t,n_forced*2)",
      "-threads",
      a.threads,
      "-f",
      "hls",
      "-hls_time",
      "4",
      "-hls_playlist_type",
      "vod",
      "-hls_list_size",
      "0",
      "-hls_flags",
      "independent_segments",
      "-hls_segment_type",
      "fmp4",
      "-hls_fmp4_init_filename",
      "init.mp4",
      "-hls_segment_filename",
      join(dir, "segment-%05d.m4s"),
      join(dir, "index.m3u8"),
    ]);
    const playlist = await readFile(join(dir, "index.m3u8"), "utf8");
    const entries = [
      ...playlist.matchAll(/#EXTINF:([\d.]+),\s*\n([^#\r\n]+)/g),
    ];
    let bytes = 0,
      peak = 0;
    for (const m of entries) {
      const size = (await stat(join(dir, m[2]))).size;
      bytes += size;
      peak = Math.max(peak, (size * 8) / Number(m[1]));
    }
    levels.push({
      tier,
      width: w,
      height: h,
      folder,
      bandwidth: Math.ceil(peak * 1.1),
      average: Math.ceil((bytes * 8) / seconds),
      codec: `avc1.6400${level.toString(16).padStart(2, "0")}`,
    });
  }
  let master = "#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-INDEPENDENT-SEGMENTS\n";
  for (const l of levels)
    master += `#EXT-X-STREAM-INF:BANDWIDTH=${l.bandwidth},AVERAGE-BANDWIDTH=${l.average},RESOLUTION=${l.width}x${l.height},FRAME-RATE=${fps.toFixed(3)},CODECS="${l.codec}"\n${l.folder}/index.m3u8\n`;
  await writeFile(join(media, "master.m3u8"), master);
  const fallbackLevel =
    [...levels].reverse().find((l) => l.tier <= 1080) || levels[0];
  if (!a.fallback)
    await run("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      join(media, fallbackLevel.folder, "index.m3u8"),
      "-map",
      "0:v:0",
      "-c",
      "copy",
      "-an",
      "-movflags",
      "+faststart",
      join(media, "fallback.mp4"),
    ]);
  await run("ffmpeg", [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(Math.min(2, seconds / 3)),
    "-i",
    input,
    "-frames:v",
    "1",
    "-vf",
    `${tone}scale=960:960:force_original_aspect_ratio=decrease`,
    "-q:v",
    "3",
    join(media, "poster.jpg"),
  ]);
  const scene = {
    id,
    name: a.name,
    kind: a.kind,
    reference: Number(a.reference),
    seconds,
    author: a.author,
    source: a.source,
    poster: `/media/${key}/poster.jpg`,
    src: a.fallback || `/media/${key}/fallback.mp4`,
    hlsSrc: `/media/${key}/master.m3u8`,
    format: a.loop ? "loop" : "route",
  };
  const files = [];
  async function walk(dir, prefix = "") {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const rel = prefix + entry.name,
        path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path, rel + "/");
      else {
        const digest = createHash("sha256");
        for await (const chunk of createReadStream(path)) digest.update(chunk);
        const hash = digest.digest("hex");
        files.push({
          key: key + "/" + rel,
          bytes: (await stat(path)).size,
          sha256: hash,
        });
      }
    }
  }
  await walk(media);
  await writeFile(
    join(staging, "upload.json"),
    JSON.stringify(
      {
        version: 1,
        source: basename(input),
        sourceSha256: sourceHash,
        config,
        scene,
        levels,
        files,
      },
      null,
      2,
    ) + "\n",
  );
  await rename(staging, target);
  console.log(
    `Prepared ${target}\nUpload: node scripts/upload-hls.mjs ${JSON.stringify(target)} --remote r2:smart-fit-scenery`,
  );
} catch (error) {
  await rm(staging, { recursive: true, force: true });
  throw error;
}
