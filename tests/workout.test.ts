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

it("offers extension only near the end of the final repetition", async () => {
  const { workoutEnding, extendWorkout } = await import("../src/workout");
  let s = make();
  expect(workoutEnding(s)).toBeNull();
  expect(extendWorkout(s)).toBe(s);
  s = { ...s, cycle: 1, phaseElapsed: 4 };
  expect(workoutEnding(s)?.remaining).toBe(1);
  const extended = extendWorkout(s);
  expect(extended.extensionSeconds).toBe(600);
  expect(extended.programme).toBe(s.programme);
  expect(workoutEnding(extended)).toBeNull();
  s = advance(extended, 1, 1);
  expect(currentSegment(s)?.block.name).toBe("Extra time");
  expect(currentSegment(s)?.remaining).toBe(600);
  for (let i = 0; i < 540; i++) s = advance(s, 1, 2);
  expect(workoutEnding(s)?.remaining).toBe(60);
  s = extendWorkout(s);
  expect(currentSegment(s)?.remaining).toBe(660);
  for (let i = 0; i < 660; i++) s = advance(s, 1, 2);
  expect(currentSegment(s)).toBeNull();
  expect(s.elapsed).toBe(1201);
  expect(s.distance).toBe(2401);
});
it("continues distance workouts at the final ramp endpoint, without replaying the programme", async () => {
  const { workoutEnding, extendWorkout } = await import("../src/workout");
  let s = make();
  s = {
    ...s,
    cycle: 1,
    programme: {
      ...s.programme,
      blocks: [
        {
          ...block,
          distance: 1000,
          ramp: true,
          endSpeed: 8,
          endIncline: 4,
          endPower: 180,
          endResistance: 6,
        },
      ],
    },
    phaseDistance: 801,
  };
  expect(workoutEnding(s)?.remaining).toBe(199);
  s = extendWorkout(s);
  for (let i = 0; i < 10; i++) s = advance(s, 1, 20);
  const segment = currentSegment(s)!;
  expect(segment.extension).toBe(true);
  expect(segment.block).toMatchObject({
    speed: 8,
    incline: 4,
    power: 180,
    resistance: 6,
    ramp: false,
    distance: undefined,
    duration: 600,
  });
  s = advance(s, 2, 5);
  expect(currentSegment(s)?.remaining).toBe(598);
});
it("does not offer extra time after a workout has finished", async () => {
  const { workoutEnding, extendWorkout } = await import("../src/workout");
  const s = { ...make(), cycle: 2 };
  expect(workoutEnding(s)).toBeNull();
  expect(extendWorkout(s)).toBe(s);
});
