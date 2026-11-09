import type { Programme, Segment } from "./store";

const segment = (
  name: string,
  minutes: number,
  target: Partial<Segment>,
): Segment => ({
  name,
  duration: minutes * 60,
  speed: 0,
  incline: 0,
  power: 0,
  resistance: 1,
  ...target,
});
const walk = (name: string, minutes: number, speed: number, incline = 0) =>
  segment(name, minutes, { speed, incline });
const ride = (name: string, minutes: number, power: number) =>
  segment(name, minutes, { power });
const row = (name: string, minutes: number, resistance: number) =>
  segment(name, minutes, { resistance });
const intervals = (work: () => Segment, recovery: () => Segment) =>
  Array.from({ length: 4 }, () => [work(), recovery()]).flat();

// Fixed, editable starting targets; longer sessions add endurance, not intensity.
// Each complete session includes its own warm-up/cooldown exactly once.
export const defaultProgrammes: Programme[] = [
  {
    id: "default-treadmill-15-v1",
    name: "15 min · Easy walk",
    kind: "Treadmill",
    repeat: 1,
    blocks: [
      walk("Warm up", 3, 3.5),
      walk("Comfortable walk", 9, 5),
      walk("Cool down", 3, 3.5),
    ],
  },
  {
    id: "default-treadmill-30-v1",
    name: "30 min · Brisk walk intervals",
    kind: "Treadmill",
    repeat: 1,
    blocks: [
      walk("Warm up", 5, 3.5),
      ...intervals(
        () => walk("Brisk walk", 3, 5.5, 1),
        () => walk("Easy recovery", 2, 4),
      ),
      walk("Cool down", 5, 3.5),
    ],
  },
  {
    id: "default-treadmill-45-v1",
    name: "45 min · Steady walk",
    kind: "Treadmill",
    repeat: 1,
    blocks: [
      walk("Warm up", 5, 3.5),
      walk("Settle into your rhythm", 10, 5),
      walk("Gentle incline", 15, 5, 1),
      walk("Steady flat walk", 10, 5),
      walk("Cool down", 5, 3.5),
    ],
  },
  {
    id: "default-bike-15-v1",
    name: "15 min · Easy ride",
    kind: "Bike",
    repeat: 1,
    blocks: [
      ride("Warm up", 3, 50),
      ride("Comfortable spin", 9, 90),
      ride("Cool down", 3, 50),
    ],
  },
  {
    id: "default-bike-30-v1",
    name: "30 min · Ride intervals",
    kind: "Bike",
    repeat: 1,
    blocks: [
      ride("Warm up", 5, 50),
      ...intervals(
        () => ride("Steady push", 3, 110),
        () => ride("Easy recovery", 2, 70),
      ),
      ride("Cool down", 5, 50),
    ],
  },
  {
    id: "default-bike-45-v1",
    name: "45 min · Endurance ride",
    kind: "Bike",
    repeat: 1,
    blocks: [
      ride("Warm up", 5, 50),
      ride("Find your rhythm", 10, 80),
      ride("Steady endurance", 15, 100),
      ride("Ease back", 10, 80),
      ride("Cool down", 5, 50),
    ],
  },
  {
    id: "default-rower-15-v1",
    name: "15 min · Easy row",
    kind: "Rower",
    repeat: 1,
    blocks: [
      row("Warm up", 3, 1),
      row("Comfortable strokes", 9, 3),
      row("Cool down", 3, 1),
    ],
  },
  {
    id: "default-rower-30-v1",
    name: "30 min · Row intervals",
    kind: "Rower",
    repeat: 1,
    blocks: [
      row("Warm up", 5, 1),
      ...intervals(
        () => row("Strong, smooth strokes", 3, 4),
        () => row("Easy recovery", 2, 2),
      ),
      row("Cool down", 5, 1),
    ],
  },
  {
    id: "default-rower-45-v1",
    name: "45 min · Endurance row",
    kind: "Rower",
    repeat: 1,
    blocks: [
      row("Warm up", 5, 1),
      row("Find your rhythm", 10, 3),
      row("Steady endurance", 15, 4),
      row("Ease back", 10, 3),
      row("Cool down", 5, 1),
    ],
  },
];

// Only remove the exact original examples. Edited examples and custom sessions survive.
const oldBlock = (name = "Steady", duration = 180): Segment => ({
  name,
  duration,
  speed: 5,
  incline: 0,
  resistance: 3,
  power: 100,
});
const legacyExamples: Programme[] = [
  {
    id: "walk",
    name: "Easy morning walk",
    kind: "Treadmill",
    repeat: 1,
    blocks: [
      { ...oldBlock("Warm up", 180), speed: 3 },
      { ...oldBlock("Find your rhythm", 600), speed: 5 },
      { ...oldBlock("Cool down", 180), speed: 3 },
    ],
  },
  {
    id: "ride",
    name: "Power intervals",
    kind: "Bike",
    repeat: 3,
    blocks: [
      { ...oldBlock("Push", 60), power: 150 },
      { ...oldBlock("Recover", 120), power: 70 },
    ],
  },
  {
    id: "row",
    name: "River intervals",
    kind: "Rower",
    repeat: 4,
    blocks: [
      oldBlock("Strong strokes", 90),
      { ...oldBlock("Easy recovery", 60), resistance: 1 },
    ],
  },
];
export function installDefaults(saved: Programme[]): Programme[] {
  const kept = saved.filter(
    (p) =>
      !legacyExamples.some((old) => JSON.stringify(old) === JSON.stringify(p)),
  );
  const existing = new Set(kept.map((p) => p.id));
  return [
    ...structuredClone(defaultProgrammes.filter((p) => !existing.has(p.id))),
    ...kept,
  ];
}
