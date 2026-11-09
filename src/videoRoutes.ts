import type { Kind } from "./store";
import forestPoster from "./assets/forest.jpg";
import cyclingPoster from "./assets/cycling.jpg";
import riverPoster from "./assets/river.jpg";
export type VideoRoute = {
  skipSeconds?: number;
  hlsSrc?: string;
  format?: "loop" | "route";
  id: string;
  name: string;
  kind: Kind;
  reference: number;
  src: string;
  seconds: number;
  author: string;
  source: string;
  poster: string;
};
export const videoRoutes: VideoRoute[] = [
  {
    id: "forest-walk-v1",
    format: "loop",
    poster: forestPoster,
    name: "Woodland path · scenic loop",
    kind: "Treadmill",
    reference: 5,
    src: "/media/forest-walk-v1.mp4",
    seconds: 16,
    author: "Michael Andrew",
    source: "https://www.pexels.com/video/11351927/",
  },
  {
    id: "autumn-cycle-v3",
    format: "loop",
    poster: cyclingPoster,
    name: "Autumn forest ride · scenic loop",
    kind: "Bike",
    reference: 20,
    src: "/media/autumn-cycle-v3.mp4",
    seconds: 119,
    author: "Bejan Adrian",
    source: "https://www.pexels.com/video/34605588/",
  },
  {
    id: "river-canoe-v2",
    format: "loop",
    poster: riverPoster,
    name: "River canoe POV · scenic loop",
    kind: "Rower",
    reference: 8,
    src: "/media/river-canoe-v2.mp4",
    seconds: 46,
    author: "Altaf Shah",
    source: "https://www.pexels.com/video/11496495/",
  },
];
// Public progressive video: kept separate from the short decorative starter clips.
export const defaultVideoUrl = "https://videos.fit.silvio.cloud/video.webm";
export const defaultVideoRoutes: VideoRoute[] = (
  ["Treadmill", "Bike", "Rower"] as Kind[]
).map((kind) => ({
  id: "nas-default-" + kind.toLowerCase(),
  name: "Nature escape · 4K",
  kind,
  reference: 5,
  seconds: 2870,
  format: "route",
  src: defaultVideoUrl,
  poster: "",
  author: "Video library",
  source: defaultVideoUrl,
}));
export function playbackRate(
  speed: number | null,
  reference: number,
): number | null {
  if (
    speed == null ||
    !Number.isFinite(speed) ||
    speed <= 0 ||
    !Number.isFinite(reference) ||
    reference <= 0
  )
    return null;
  return Math.max(0.1, Math.min(4, speed / reference));
}
