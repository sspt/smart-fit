import type { Programme, Segment } from "./store";
export type WeightLossOptions = {
  minutes: 15 | 20 | 30 | 45;
  level: "starting" | "active";
} & (
  | {
      kind: "Treadmill";
      minSpeed: number;
      maxSpeed: number;
      maxIncline: number;
    }
  | { kind: "Bike" | "Rower"; comfortable: number }
);
export const weightLossLimits = {
  Treadmill: {
    min: 1,
    max: 8,
    step: 0.1,
    label: "Comfortable walking speed (km/h)",
    initial: 4,
  },
  Bike: {
    min: 20,
    max: 400,
    step: 5,
    label: "Comfortable power (W)",
    initial: 60,
  },
  Rower: {
    min: 1,
    max: 20,
    step: 1,
    label: "Comfortable resistance level",
    initial: 3,
  },
};
export function weightLossProgramme(
  options: WeightLossOptions,
  id: string = crypto.randomUUID(),
): Programme {
  const { kind, minutes, level } = options,
    limits = weightLossLimits[kind],
    walking = options.kind === "Treadmill" ? options : undefined,
    comfortable =
      options.kind === "Treadmill" ? options.maxSpeed : options.comfortable;
  if (
    !limits ||
    ![15, 20, 30, 45].includes(minutes) ||
    !["starting", "active"].includes(level) ||
    !Number.isFinite(comfortable) ||
    comfortable < limits.min ||
    comfortable > limits.max ||
    (kind === "Rower" && !Number.isInteger(comfortable))
  )
    throw Error("Choose valid equipment, time and a comfortable target.");
  if (walking) {
    const { minSpeed, maxSpeed, maxIncline } = walking;
    if (
      !Number.isFinite(minSpeed) ||
      minSpeed < limits.min ||
      minSpeed > limits.max ||
      [minSpeed, maxSpeed].some(
        (v) => Math.abs(v * 10 - Math.round(v * 10)) > 1e-7,
      )
    )
      throw Error("Choose walking speeds from 1 to 8 km/h in 0.1 steps.");
    if (minSpeed > maxSpeed)
      throw Error("Minimum speed must be at most maximum speed.");
    if (
      !Number.isFinite(maxIncline) ||
      maxIncline < 0 ||
      maxIncline > 15 ||
      !Number.isInteger(maxIncline * 2)
    )
      throw Error("Choose a maximum incline from 0 to 15% in 0.5 steps.");
  }
  // Round the midpoint down so a narrow speed range cannot put a hill at maximum speed.
  const middleSpeed = walking
    ? Math.floor((walking.minSpeed + walking.maxSpeed) * 5 + 1e-7) / 10
    : 0;
  const round = (v: number) =>
    kind === "Treadmill"
      ? Math.round(v * 10) / 10
      : kind === "Bike"
        ? Math.round(v / 5) * 5
        : Math.round(v);
  const target = (ratio: number) =>
    Math.min(comfortable, Math.max(limits.min, round(comfortable * ratio)));
  const segment = (
    name: string,
    duration: number,
    value: number,
    incline = 0,
  ): Segment => ({
    name,
    duration,
    speed: walking
      ? Math.max(
          walking.minSpeed,
          Math.min(walking.maxSpeed, Math.round(value * 10) / 10),
        )
      : 0,
    power: kind === "Bike" ? value : 0,
    resistance: kind === "Rower" ? value : 1,
    incline,
  });
  const edge = (minutes === 15 ? 3 : 5) * 60,
    blocks = [
      segment(
        "Warm up · easy effort",
        edge,
        walking ? walking.minSpeed : target(0.7),
      ),
    ];
  let remaining = minutes * 60 - edge * 2;
  if (level === "starting")
    blocks.push(
      segment(
        "Steady · conversational effort",
        remaining,
        walking ? middleSpeed : target(1),
        walking
          ? Math.min(walking.maxIncline, Math.round(walking.maxIncline) / 2)
          : 0,
      ),
    );
  else {
    let workIndex = 0;
    while (remaining > 0) {
      const work = Math.min(180, remaining);
      const uphill = walking && walking.maxIncline > 0 && workIndex % 2 === 1;
      blocks.push(
        segment(
          uphill
            ? "Incline walk"
            : walking
              ? "Brisk flat walk"
              : "Comfortable effort",
          work,
          uphill ? middleSpeed : target(1),
          uphill ? walking.maxIncline : 0,
        ),
      );
      workIndex++;
      remaining -= work;
      if (remaining > 0) {
        const recovery = Math.min(120, remaining);
        blocks.push(
          segment(
            "Easy recovery",
            recovery,
            walking ? walking.minSpeed : target(0.8),
          ),
        );
        remaining -= recovery;
      }
    }
  }
  blocks.push(
    segment(
      "Cool down · easy effort",
      edge,
      walking ? walking.minSpeed : target(0.7),
    ),
  );
  const activity =
    kind === "Treadmill" ? "walk" : kind === "Bike" ? "ride" : "row";
  return {
    id,
    name: `${minutes} min · Weight-loss ${activity} · ${level === "starting" ? "Steady" : "Intervals"}`,
    kind,
    repeat: 1,
    blocks,
  };
}
