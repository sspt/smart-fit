import type { VideoRoute } from "./videoRoutes";
export type MediaServerConfig = { baseUrl: string; credentials: boolean };
export const defaultMediaServer: MediaServerConfig = {
  baseUrl: "",
  credentials: false,
};
export function normaliseMediaServer(
  value: unknown,
  allowLocal = false,
): MediaServerConfig {
  if (!value || typeof value !== "object")
    throw Error("Enter a video server URL.");
  const raw = (value as any).baseUrl;
  if (typeof raw !== "string") throw Error("Enter a video server URL.");
  if (!raw.trim()) return defaultMediaServer;
  const url = new URL(raw.trim());
  if (url.username || url.password || url.search || url.hash)
    throw Error(
      "Use the HTTPS media folder URL without passwords, query parameters or a fragment.",
    );
  if (
    url.protocol !== "https:" &&
    !(
      allowLocal &&
      url.protocol === "http:" &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
  )
    throw Error("Use HTTPS with a valid certificate for your NAS hostname.");
  return {
    baseUrl: url.href.replace(/\/+$/, ""),
    credentials: (value as any).credentials === true,
  };
}
export function mediaUrl(path: string, config: MediaServerConfig) {
  return config.baseUrl ? config.baseUrl + path.slice("/media".length) : path;
}
export function serverScenes(
  routes: VideoRoute[],
  config: MediaServerConfig,
): VideoRoute[] {
  return routes.map((r) => ({
    ...r,
    src: mediaUrl(r.src, config),
    hlsSrc: r.hlsSrc ? mediaUrl(r.hlsSrc, config) : undefined,
    poster: mediaUrl(r.poster, config),
  }));
}
