export type MachineControlMode = "follow" | "automatic";
export function ControlMode({
  value,
  onChange,
  busy,
  automaticUnavailable,
}: {
  value: MachineControlMode;
  onChange: (mode: MachineControlMode) => void;
  busy: boolean;
  automaticUnavailable: string;
}) {
  return (
    <div className="control-mode-wrap">
      <div
        className="control-mode"
        role="group"
        aria-label="Equipment control mode"
      >
        <button
          aria-pressed={value === "follow"}
          onClick={() => onChange("follow")}
          title="Follow the machine. Hold automatic programme targets."
        >
          Follow machine
        </button>
        <button
          aria-pressed={value === "automatic"}
          disabled={busy || !!automaticUnavailable}
          onClick={() => onChange("automatic")}
          title={
            automaticUnavailable ||
            "Apply the current programme targets. Video still follows measured speed."
          }
        >
          Automatic
        </button>
      </div>
      {automaticUnavailable && (
        <small className="control-mode-note">{automaticUnavailable}</small>
      )}
    </div>
  );
}
