import { useState } from "react";
import type { Kind, Programme } from "./store";
import {
  weightLossProgramme,
  weightLossLimits,
  type WeightLossOptions,
} from "./weightLossProgrammes";
export function WeightLossBuilder({
  initialKind,
  onCreate,
  disabled = false,
}: {
  initialKind: Kind;
  onCreate: (p: Programme) => void;
  disabled?: boolean;
}) {
  const [kind, setKind] = useState<Kind>(initialKind),
    [minutes, setMinutes] = useState<WeightLossOptions["minutes"]>(20),
    [level, setLevel] = useState<WeightLossOptions["level"]>("starting"),
    [values, setValues] = useState({ Treadmill: "4", Bike: "60", Rower: "3" }),
    [error, setError] = useState("");
  const limits = weightLossLimits[kind];
  return (
    <details className="weight-loss-builder">
      <summary>
        Weight-loss programmes <span>Tailor a session</span>
      </summary>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          try {
            setError("");
            onCreate(
              weightLossProgramme({
                kind,
                minutes,
                level,
                comfortable: Number(values[kind]),
              }),
            );
          } catch (error) {
            setError(
              error instanceof Error ? error.message : "Check your choices.",
            );
          }
        }}
      >
        <p>
          Tailor a steady session or gentle intervals to your comfortable
          effort.
        </p>
        <div className="weight-loss-fields">
          <label>
            Equipment
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value as Kind)}
            >
              <option>Treadmill</option>
              <option>Bike</option>
              <option>Rower</option>
            </select>
          </label>
          <label>
            Session length
            <select
              value={minutes}
              onChange={(e) =>
                setMinutes(
                  Number(e.target.value) as WeightLossOptions["minutes"],
                )
              }
            >
              {[15, 20, 30, 45].map((n) => (
                <option key={n} value={n}>
                  {n} minutes
                </option>
              ))}
            </select>
          </label>
          <label>
            Activity level
            <select
              value={level}
              onChange={(e) =>
                setLevel(e.target.value as WeightLossOptions["level"])
              }
            >
              <option value="starting">Starting out</option>
              <option value="active">Already active</option>
            </select>
          </label>
          <label>
            {limits.label}
            <input
              required
              type="number"
              inputMode="decimal"
              min={limits.min}
              max={limits.max}
              step={limits.step}
              value={values[kind]}
              onChange={(e) => setValues({ ...values, [kind]: e.target.value })}
            />
          </label>
        </div>
        <p className="subtle">
          Choose an effort where you can still talk. Warm-up and cooldown are
          included. Review targets before saving.
        </p>
        <p className="subtle">
          Weight change also depends on nutrition and recovery.
        </p>
        {error && <p role="alert">{error}</p>}
        <button className="primary" type="submit" disabled={disabled}>
          Review programme
        </button>
      </form>
    </details>
  );
}
