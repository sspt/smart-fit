import type { Kind, Programme, Segment } from "./store";
export type WeightLossOptions = {
  kind: Kind;
  minutes: 15 | 20 | 30 | 45;
  level: "starting" | "active";
  comfortable: number;
};
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
  const { kind, minutes, level, comfortable } = options,
    limits = weightLossLimits[kind];
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
  const round = (v: number) =>
    kind === "Treadmill"
      ? Math.round(v * 10) / 10
      : kind === "Bike"
        ? Math.round(v / 5) * 5
        : Math.round(v);
  const target = (ratio: number) =>
    Math.min(comfortable, Math.max(limits.min, round(comfortable * ratio)));
  const segment = (name: string, duration: number, value: number): Segment => ({
    name,
    duration,
    speed: kind === "Treadmill" ? value : 0,
    power: kind === "Bike" ? value : 0,
    resistance: kind === "Rower" ? value : 1,
    incline: 0,
  });
  const edge = (minutes === 15 ? 3 : 5) * 60,
    blocks = [segment("Warm up · easy effort", edge, target(0.7))];
  let remaining = minutes * 60 - edge * 2;
  if (level === "starting")
    blocks.push(
      segment("Steady · conversational effort", remaining, target(1)),
    );
  else
    while (remaining > 0) {
      const work = Math.min(180, remaining);
      blocks.push(segment("Comfortable effort", work, target(1)));
      remaining -= work;
      if (remaining > 0) {
        const recovery = Math.min(120, remaining);
        blocks.push(segment("Easy recovery", recovery, target(0.8)));
        remaining -= recovery;
      }
    }
  blocks.push(segment("Cool down · easy effort", edge, target(0.7)));
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
