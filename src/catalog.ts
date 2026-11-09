import type { VideoRoute } from "./videoRoutes";
const mediaPath =
  /^\/media\/(?:[a-z0-9-]+\/){0,5}[a-z0-9-]+\.(?:mp4|m3u8|jpg|webp)$/;
export function parseCatalog(value: unknown): VideoRoute[] {
  if (
    !value ||
    typeof value !== "object" ||
    (value as any).version !== 1 ||
    !Array.isArray((value as any).scenes) ||
    (value as any).scenes.length > 500
  )
    throw Error("Invalid video catalogue");
  const seen = new Set<string>();
  return (value as any).scenes.map((r: any) => {
    if (
      !r ||
      typeof r !== "object" ||
      typeof r.id !== "string" ||
      !/^[a-z0-9-]{1,100}$/.test(r.id) ||
      seen.has(r.id) ||
      typeof r.name !== "string" ||
      !r.name.trim() ||
      r.name.length > 120 ||
      !["Treadmill", "Bike", "Rower"].includes(r.kind) ||
      !Number.isFinite(r.reference) ||
      r.reference <= 0 ||
      r.reference > 100 ||
      !Number.isFinite(r.seconds) ||
      r.seconds <= 0 ||
      r.seconds > 86400 ||
      typeof r.src !== "string" ||
      !mediaPath.test(r.src) ||
      !r.src.endsWith(".mp4") ||
      typeof r.hlsSrc !== "string" ||
      !mediaPath.test(r.hlsSrc) ||
      !r.hlsSrc.endsWith(".m3u8") ||
      typeof r.poster !== "string" ||
      !mediaPath.test(r.poster) ||
      !/\.(jpg|webp)$/.test(r.poster) ||
      typeof r.author !== "string" ||
      r.author.length > 160 ||
      typeof r.source !== "string" ||
      !/^https?:\/\//.test(r.source) ||
      !["loop", "route"].includes(r.format)
    )
      throw Error("Invalid video catalogue scene");
    const source = new URL(r.source);
    if (!["http:", "https:"].includes(source.protocol))
      throw Error("Invalid source");
    seen.add(r.id);
    return {
      id: r.id,
      name: r.name,
      kind: r.kind,
      reference: r.reference,
      seconds: r.seconds,
      src: r.src,
      hlsSrc: r.hlsSrc,
      poster: r.poster,
      author: r.author,
      source: r.source,
      format: r.format,
    };
  });
}
export function sceneDuration(route: VideoRoute) {
  if (route.seconds <= 0) return "Full-length";
  const seconds = Math.round(route.seconds);
  return seconds < 60
    ? `${seconds} sec`
    : `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ""}`;
}
