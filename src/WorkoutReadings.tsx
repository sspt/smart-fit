import type { Kind } from "./store";
import { validReading } from "./manualWorkoutControl";
export type WorkoutReadingsProps = {
  kind: Kind;
  speed: number | null;
  time: string;
  incline?: number | null;
  power?: number | null;
  resistance?: number | null;
  distance?: number | null;
  calories?: number | null;
};
export function WorkoutReadings(p: WorkoutReadingsProps) {
  const readings = [
    { label: "DEVICE SPEED", value: p.speed, unit: "km/h", decimals: 1 },
    p.kind === "Treadmill"
      ? { label: "INCLINE", value: p.incline, unit: "%", decimals: 1 }
      : p.kind === "Bike"
        ? { label: "POWER", value: p.power, unit: "W", decimals: 0 }
        : { label: "RESISTANCE", value: p.resistance, unit: "", decimals: 0 },
    {
      label: "DISTANCE",
      value: validReading(p.distance) ? p.distance / 1000 : null,
      unit: "km",
      decimals: 2,
    },
    { label: "ENERGY", value: p.calories, unit: "kcal", decimals: 0 },
  ];
  return (
    <div className="immersion-readings" aria-label="Workout metrics">
      {readings
        .filter((r) => validReading(r.value))
        .map((r) => (
          <div key={r.label}>
            <small>{r.label}</small>
            <strong>
              {r.value!.toFixed(r.decimals)}
              <span>{r.unit}</span>
            </strong>
          </div>
        ))}
      {p.time && (
        <div>
          <small>WORKOUT TIME</small>
          <strong>{p.time}</strong>
        </div>
      )}
    </div>
  );
}
export function hasMetricValue(value: unknown) {
  return typeof value === "number"
    ? Number.isFinite(value)
    : typeof value === "string" &&
        value.trim() !== "" &&
        Number.isFinite(Number(value));
}
