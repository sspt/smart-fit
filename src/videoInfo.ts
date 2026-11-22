import {
  activityTypes,
  lengthCategories,
  routeName,
} from "./routePresentation";
import type { Kind } from "./store";
import type { VideoRoute } from "./videoRoutes";
export const videoInfoBase = "https://videos.fit.silvio.cloud/";
export function parseVideoInfo(
  data: unknown,
  legacyBase = videoInfoBase,
): VideoRoute[] {
  const videos = (data as any)?.videos;
  if (!Array.isArray(videos) || videos.length > 500)
    throw Error("Invalid info.json: expected a videos array.");
  const seen = new Set<string>();
  return videos.flatMap((v: any) => {
    const folder = v?.path;
    if (
      folder !== undefined &&
      (typeof folder !== "string" ||
        !/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\/?$/.test(folder))
    )
      throw Error("Invalid video folder.");
    const base = folder ? "https://media.kwest.fit/" : legacyBase;
    const file = folder ? folder.replace(/\/?$/, "/video.mp4") : v?.file;
    if (
      !v ||
      typeof file !== "string" ||
      !file ||
      typeof v.name !== "string" ||
      !v.name.trim() ||
      v.name.length > 120
    )
      throw Error("Invalid video entry.");
    const url = new URL(file, base);
    if (
      url.origin !== new URL(base).origin ||
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
    function artwork(value: unknown, extensions: RegExp, origin = base) {
      if (typeof value !== "string" || !value) return "";
      try {
        const image = new URL(value, origin);
        if (
          image.origin === new URL(origin).origin &&
          !image.username &&
          !image.password &&
          !image.search &&
          !image.hash &&
          extensions.test(image.pathname)
        )
          return image.href;
      } catch {}
      return "";
    }
    const text = (value: unknown) =>
      typeof value === "string" && value.trim() ? value.trim() : undefined;
    const place = v.location;
    const name = text(place?.name);
    const location = name
      ? {
          name,
          region: text(place.region),
          country: text(place.country),
          countryCode:
            typeof place.countryCode === "string" &&
            /^[a-z]{2}$/i.test(place.countryCode)
              ? place.countryCode.toUpperCase()
              : undefined,
          latitude:
            Number.isFinite(place.latitude) && Math.abs(place.latitude) <= 90
              ? place.latitude
              : undefined,
          longitude:
            Number.isFinite(place.longitude) && Math.abs(place.longitude) <= 180
              ? place.longitude
              : undefined,
          source: text(place.source),
        }
      : undefined;
    return [...new Set<Kind>(v.deviceTypes)].map((kind) => {
      const route: VideoRoute = {
        id: id + "-" + kind.toLowerCase(),
        name: v.name.trim(),
        originalName: text(v.originalName),
        country: text(v.country),
        distanceKm:
          Number.isFinite(v.distanceKm) && v.distanceKm >= 0
            ? v.distanceKm
            : undefined,
        lengthCategory: lengthCategories.find(
          (value) => value === v.lengthCategory,
        ),
        activityType: activityTypes.find((value) => value === v.activityType),
        location,
        gif: artwork(v.gif, /\.gif$/i, "https://media.kwest.fit/") || undefined,
        kind,
        reference,
        skipSeconds: skip,
        seconds:
          Number.isFinite(v.durationSeconds) && v.durationSeconds > 0
            ? v.durationSeconds
            : 0,
        ...(folder ? { percursoSrc: new URL("percurso.json", url).href } : {}),
        format: "route",
        src: url.href,
        poster: artwork(v.poster, /\.(jpg|jpeg|png|webp|avif)$/i),
        author: text(v.author) ?? "Video library",
        source: url.href,
      };
      return { ...route, name: routeName(route) };
    });
  });
}
