import { it, expect } from "vitest";
import {
  playbackRate,
  videoRoutes,
  defaultVideoRoutes,
  defaultVideoUrl,
} from "../src/videoRoutes";
it("matches real speed continuously rather than discrete YouTube rates", () => {
  expect(playbackRate(7, 5)).toBe(1.4);
  expect(playbackRate(6.7, 5)).toBe(1.34);
  expect(playbackRate(10, 20)).toBe(0.5);
  expect(playbackRate(100, 5)).toBe(4);
  expect(playbackRate(0.1, 5)).toBe(0.1);
});
it("pauses on missing or invalid speed/reference", () => {
  for (const n of [null, 0, -1, NaN, Infinity])
    expect(playbackRate(n, 5)).toBeNull();
  expect(playbackRate(5, 0)).toBeNull();
  expect(playbackRate(5, NaN)).toBeNull();
});
it("offers directly hosted footage for every equipment type", () => {
  for (const kind of ["Treadmill", "Bike", "Rower"])
    expect(videoRoutes.some((r) => r.kind === kind)).toBe(true);
  for (const r of videoRoutes) {
    expect(r.src).toMatch(/^\/media\/[a-z0-9-]+\.mp4$/);
    expect(r.source).toMatch(/^https:\/\/www.pexels.com\/video\//);
    expect(r.seconds).toBeGreaterThan(0);
  }
});

it("defaults every equipment type to the direct NAS video at 5 km/h", () => {
  expect(defaultVideoRoutes.map((r) => r.kind)).toEqual([
    "Treadmill",
    "Bike",
    "Rower",
  ]);
  for (const r of defaultVideoRoutes) {
    expect(r.src).toBe(defaultVideoUrl);
    expect(r.reference).toBe(5);
    expect(r.seconds).toBe(2870);
  }
});
