import { useState, useEffect } from "react";
import {
  normalizeManualTarget,
  validReading,
  type ManualField,
  type TargetKey,
} from "./manualWorkoutControl";
export type WorkoutAdjustmentsProps = {
  fields: ManualField[];
  embedded?: boolean;
  disabled: boolean;
  onApply: (key: TargetKey, value: number) => Promise<number>;
};
function TargetField({
  field,
  disabled,
  onApply,
}: WorkoutAdjustmentsProps & { field: ManualField }) {
  const [draft, setDraft] = useState(
      validReading(field.value) &&
        field.value >= field.range.min &&
        field.value <= field.range.max
        ? String(field.value)
        : "",
    ),
    [edited, setEdited] = useState(false),
    [pending, setPending] = useState(false),
    [message, setMessage] = useState("");
  useEffect(() => {
    if (
      !edited &&
      validReading(field.value) &&
      field.value >= field.range.min &&
      field.value <= field.range.max
    )
      setDraft(String(field.value));
  }, [field.value, edited]);
  const change = (value: string) => {
      setEdited(true);
      setDraft(value);
      setMessage("");
    },
    locked = disabled || pending,
    number = draft.trim() === "" ? NaN : Number(draft),
    range = field.range;
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (locked) return;
        setMessage("");
        setPending(true);
        try {
          const value = normalizeManualTarget(number, range),
            sent = await onApply(field.key, value);
          setEdited(true);
          setDraft(String(sent));
          setMessage(`${field.label} request sent.`);
        } catch (e) {
          setMessage(
            e instanceof Error
              ? e.message
              : "Equipment did not confirm the request.",
          );
        } finally {
          setPending(false);
        }
      }}
    >
      <label>
        {field.label} ({field.unit})
        <div className="adjustment-input">
          <button
            type="button"
            aria-label={"Decrease " + field.label.toLowerCase()}
            disabled={locked || !validReading(number) || number <= range.min}
            onClick={() =>
              change(
                String(
                  Number(
                    Math.max(range.min, number - range.increment).toFixed(6),
                  ),
                ),
              )
            }
          >
            −
          </button>
          <input
            aria-label={
              "Set " + field.label.toLowerCase() + " (" + field.unit + ")"
            }
            type="number"
            inputMode="decimal"
            required
            value={draft}
            placeholder="Enter target"
            min={range.min}
            max={range.max}
            step="any"
            disabled={locked}
            onChange={(e) => change(e.target.value)}
          />
          <button
            type="button"
            aria-label={"Increase " + field.label.toLowerCase()}
            disabled={locked || !validReading(number) || number >= range.max}
            onClick={() =>
              change(
                String(
                  Number(
                    Math.min(range.max, number + range.increment).toFixed(6),
                  ),
                ),
              )
            }
          >
            +
          </button>
          <button type="submit" disabled={locked || !validReading(number)}>
            {pending ? "Sending…" : "Apply"}
          </button>
        </div>
      </label>
      <small>
        {range.min}–{range.max} {field.unit} · step {range.increment}
      </small>
      {message && <p role="status">{message}</p>}
    </form>
  );
}
export function WorkoutAdjustments(props: WorkoutAdjustmentsProps) {
  if (!props.fields.length) return null;
  const Panel = props.embedded ? "div" : "details";
  return (
    <Panel className="workout-adjustments">
      {!props.embedded && <summary>Adjust equipment</summary>}
      <div className="adjustment-fields">
        {props.fields.map((field) => (
          <TargetField
            {...props}
            field={field}
            key={`${field.key}:${field.range.min}:${field.range.max}:${field.range.increment}`}
          />
        ))}
        <p className="adjustment-help">
          Applying a target selects Manual mode. Programme changes stay on hold.
          Pause and Stop remain available.
        </p>
      </div>
    </Panel>
  );
}
