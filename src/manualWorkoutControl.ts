import type { Kind } from "./store";
export type TargetKey = "speed" | "incline" | "power" | "resistance";
export type TargetRange = { min: number; max: number; increment: number };
export type ManualField = {
  key: TargetKey;
  label: string;
  unit: string;
  range: TargetRange;
  value: number | null;
};
const fallback: Record<TargetKey, TargetRange> = {
  speed: { min: 1, max: 18, increment: 0.5 },
  incline: { min: 0, max: 8, increment: 1 },
  power: { min: 0, max: 1000, increment: 5 },
  resistance: { min: 1, max: 20, increment: 1 },
};
export const validReading = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
export function manualFields(
  kind: Kind,
  ifit: boolean,
  features: any,
  ranges: any,
  values: Partial<Record<TargetKey, number | null>>,
  ifitFields?: any,
  levels?: number[],
): ManualField[] {
  if (ifit && kind === "Bike") return [];
  const keys: TargetKey[] =
    kind === "Treadmill"
      ? [
          "speed",
          ...((ifit ? ifitFields?.incline : features?.incline)
            ? ["incline" as const]
            : []),
        ]
      : kind === "Bike"
        ? ["power"]
        : ["resistance"];
  return keys
    .filter((key) =>
      ifit ? ifitFields?.[key] !== false : !features || features[key] !== false,
    )
    .flatMap((key) => {
      const reported =
        ranges?.[key] ||
        (ifit && key === "resistance"
          ? { min: levels?.[0] ?? 1, max: levels?.at(-1) ?? 26, increment: 1 }
          : fallback[key]);
      if (
        !reported ||
        ![reported.min, reported.max, reported.increment].every(validReading) ||
        reported.min > reported.max ||
        reported.increment <= 0
      )
        return [];
      return [
        {
          key,
          label: {
            speed: "Speed",
            incline: "Incline",
            power: "Power",
            resistance: "Resistance",
          }[key],
          unit: {
            speed: "km/h",
            incline: "%",
            power: "W",
            resistance: "level",
          }[key],
          range: { ...reported },
          value: validReading(values[key]) ? values[key]! : null,
        },
      ];
    });
}
export function normalizeManualTarget(value: number, range: TargetRange) {
  if (
    !validReading(value) ||
    ![range.min, range.max, range.increment].every(validReading) ||
    range.increment <= 0 ||
    range.min > range.max ||
    value < range.min ||
    value > range.max
  )
    throw Error("Choose a target inside the equipment range.");
  return Number(
    Math.max(
      range.min,
      Math.min(
        range.max,
        Math.round(value / range.increment) * range.increment,
      ),
    ).toFixed(6),
  );
}
export async function applyManualTarget(options: {
  key: TargetKey;
  value: number;
  fields: ManualField[];
  lock: { current: boolean };
  ready: () => boolean;
  hold: () => void;
  acquire: () => Promise<void>;
  valid: () => boolean;
  send: (key: TargetKey, value: number) => Promise<unknown>;
  ack: (key: TargetKey, value: number) => void;
}) {
  if (options.lock.current)
    throw Error("Wait for the current equipment request.");
  const field = options.fields.find((x) => x.key === options.key);
  if (!field) throw Error("This equipment does not support that target.");
  const value = normalizeManualTarget(options.value, field.range);
  if (!options.ready())
    throw Error("Resume and reconnect the equipment before adjusting it.");
  options.lock.current = true;
  try {
    options.hold();
    await options.acquire();
    if (!options.valid() || !options.ready())
      throw Error(
        "Equipment request cancelled. Check the session before trying again.",
      );
    await options.send(options.key, value);
    if (!options.valid())
      throw Error(
        "Session changed before the equipment confirmed the request.",
      );
    options.ack(options.key, value);
    return value;
  } finally {
    options.lock.current = false;
  }
}

export function knownWorkoutDistance(
  total: unknown,
  speed: unknown,
  counter: unknown,
): number | null {
  return validReading(total) &&
    (total > 0 || validReading(speed) || validReading(counter))
    ? total
    : null;
}
