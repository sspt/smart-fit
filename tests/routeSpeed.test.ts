import { expect, it } from "vitest";
import { readSpeedSamples, routeSpeedAt } from "../src/routeSpeed";
import { playbackRate } from "../src/videoRoutes";

it("interpolates at video time and recalculates after a backward seek", () => {
  const profile = readSpeedSamples({
    samples: [
      { video_time_s: 0, speed_kmh: 36 },
      { video_time_s: 1, speed_kmh: 38 },
      { video_time_s: 2, speed_kmh: 0 },
    ],
  });
  expect(routeSpeedAt(profile, 1)).toBe(38);
  expect(playbackRate(18.5, routeSpeedAt(profile, 0.5)!)).toBe(0.5);
  expect(routeSpeedAt(profile, 2)).toBe(0);
  expect(routeSpeedAt(profile, 3)).toBeUndefined();
  expect(playbackRate(0, routeSpeedAt(profile, 0)!)).toBeNull();
});
