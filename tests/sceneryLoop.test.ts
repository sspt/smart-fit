import { expect, it } from "vitest";
import { sceneryWindow, sceneryBrightness } from "../src/useSceneryLoop";
it("skips NAS intros but keeps phone videos and short clips playable", () => {
  expect(sceneryWindow(2870, true)).toEqual({ start: 30, fade: 2 });
  expect(sceneryWindow(100, true, 8).start).toBe(8);
  expect(sceneryWindow(100, true, 0).start).toBe(0);
  expect(sceneryWindow(15, true).start).toBe(0);
  expect(sceneryWindow(100, false).start).toBe(0);
  expect(sceneryWindow(NaN, true)).toEqual({ start: 0, fade: 0 });
});
it("fades in after the trimmed start and to black before the end", () => {
  for (const [time, brightness] of [
    [0, 0],
    [30, 0],
    [31, 0.5],
    [32, 1],
    [100, 1],
    [2869, 0.5],
    [2870, 0],
  ])
    expect(sceneryBrightness(time, 2870, 30, 2)).toBe(brightness);
});
