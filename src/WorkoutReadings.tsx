import type { Kind } from "./store";

export type WorkoutReadingsProps = {
  kind: Kind;
  speed: number | null;
  time: string;
  incline?: number | null;
  power?: number | null;
  resistance?: number | null;
  /** Accumulated distance for this workout, in metres. */
  distance?: number | null;
  calories?: number | null;
};

const reading = (value: number | null | undefined, decimals = 0) =>
  value == null || !Number.isFinite(value) ? "—" : value.toFixed(decimals);

export function WorkoutReadings(p: WorkoutReadingsProps) {
  const equipment =
    p.kind === "Treadmill"
      ? { label: "INCLINE", value: p.incline, unit: "%", decimals: 1 }
      : p.kind === "Bike"
        ? { label: "POWER", value: p.power, unit: "W", decimals: 0 }
        : { label: "RESISTANCE", value: p.resistance, unit: "", decimals: 0 };
  return (
    <div className="immersion-readings" aria-label="Workout metrics">
      <div>
        <small>DEVICE SPEED</small>
        <strong>
          {reading(p.speed, 1)}
          <span>km/h</span>
        </strong>
      </div>
      <div>
        <small>{equipment.label}</small>
        <strong>
          {reading(equipment.value, equipment.decimals)}
          <span>{equipment.unit}</span>
        </strong>
      </div>
      <div>
        <small>DISTANCE</small>
        <strong>
          {reading(p.distance == null ? null : p.distance / 1000, 2)}
          <span>km</span>
        </strong>
      </div>
      <div>
        <small>ENERGY</small>
        <strong>
          {reading(p.calories)}
          <span>kcal</span>
        </strong>
      </div>
      <div>
        <small>WORKOUT TIME</small>
        <strong>{p.time}</strong>
      </div>
    </div>
  );
}
