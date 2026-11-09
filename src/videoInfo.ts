import type { Kind } from "./store";
import type { VideoRoute } from "./videoRoutes";
export const videoInfoBase = "https://videos.fit.silvio.cloud/";
export function parseVideoInfo(data: unknown): VideoRoute[] {
  const videos = (data as any)?.videos;
  if (!Array.isArray(videos) || videos.length > 500)
    throw Error("Invalid info.json: expected a videos array.");
  const seen = new Set<string>();
  return videos.flatMap((v: any) => {
    if (
      !v ||
      typeof v.file !== "string" ||
      !v.file ||
      typeof v.name !== "string" ||
      !v.name.trim() ||
      v.name.length > 120
    )
      throw Error("Invalid video entry.");
    const url = new URL(v.file, videoInfoBase);
    if (
      url.origin !== new URL(videoInfoBase).origin ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !/\.(webm|mp4)$/i.test(url.pathname)
    )
      throw Error("Invalid video file URL.");
    const reference = v.referenceSpeed ?? 5,
      skip = v.skipSeconds ?? 30;
    if (
      !Number.isFinite(reference) ||
      reference <= 0 ||
      reference > 100 ||
      !Number.isFinite(skip) ||
      skip < 0 ||
      skip > 86400
    )
      throw Error("Invalid reference speed or skip period.");
    if (
      !Array.isArray(v.deviceTypes) ||
      !v.deviceTypes.length ||
      v.deviceTypes.some(
        (k: unknown) => !["Treadmill", "Bike", "Rower"].includes(k as string),
      )
    )
      throw Error("Invalid deviceTypes.");
    if (seen.has(url.href)) throw Error("Duplicate video file.");
    seen.add(url.href);
    // Stable, reversible IDs retain per-video settings across catalogue reorderings.
    const id =
      url.pathname === "/video.webm"
        ? "nas-default"
        : "nas-info-" + encodeURIComponent(url.pathname);
    return [...new Set<Kind>(v.deviceTypes)].map((kind) => ({
      id: id + "-" + kind.toLowerCase(),
      name: v.name.trim(),
      kind,
      reference,
      skipSeconds: skip,
      seconds: 0,
      format: "route" as const,
      src: url.href,
      poster: "",
      author: "Video library",
      source: url.href,
    }));
  });
}
