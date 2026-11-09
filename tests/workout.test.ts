import { it, expect } from "vitest";
import { advance, currentSegment, targetAt } from "../src/workout";
import type { Session } from "../src/store";
const block = {
  name: "Work",
  duration: 5,
  speed: 4,
  incline: 0,
  power: 100,
  resistance: 3,
};
const make = (): Session => ({
  id: "test",
  started: 0,
  elapsed: 0,
  status: "active",
  demo: true,
  events: [],
  samples: [],
  programme: {
    id: "p",
    name: "p",
    kind: "Treadmill",
    repeat: 2,
    blocks: [block],
  },
});
it("finishes finite repeats without infinite looping", () => {
  let s = make();
  for (let i = 0; i < 10; i++) s = advance(s, 1, 1);
  expect(currentSegment(s)).toBeNull();
  expect(s.elapsed).toBe(10);
  expect(s.distance).toBe(10);
});
it("distance segment ignores its nominal time and waits for distance", () => {
  let s = make();
  s.programme.blocks = [{ ...block, distance: 10 }];
  for (let i = 0; i < 7; i++) s = advance(s, 1, 1);
  expect(s.cycle ?? 0).toBe(0);
  for (let i = 0; i < 3; i++) s = advance(s, 1, 1);
  expect(s.cycle).toBe(1);
  expect(s.phaseDistance).toBe(0);
});
it("does not catch up after suspension", () => {
  const s = make();
  expect(advance(s, 60, 100)).toBe(s);
});
it("interpolates ramps and snaps resistance", () => {
  const b = {
    ...block,
    ramp: true,
    endSpeed: 8,
    endIncline: 4,
    endPower: 200,
    endResistance: 6,
  };
  const t = targetAt(b, 0.5);
  expect(t.speed).toBe(6);
  expect(t.incline).toBe(2);
  expect(t.power).toBe(150);
  expect(t.resistance).toBe(5);
});
