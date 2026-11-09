import type { Kind } from "./store";
type Props = {
  kind: Kind;
  connected: boolean;
  busy: boolean;
  running: boolean;
  hasSession: boolean;
  deviceName?: string | null;
  error?: string;
  hint?: string;
  onKind: (kind: Kind) => void;
  onConnect: () => void;
  onExport: () => void;
};
export function EquipmentConnection(p: Props) {
  return (
    <section
      className={"equipment-screen " + (p.connected ? "is-connected" : "")}
    >
      <p className="eyebrow">THE CONNECTION</p>
      <h1>Your equipment</h1>
      <p>Android Chrome · Bluetooth · Keep the app visible during workouts.</p>
      <div className="panel">
        <label>
          Equipment type
          <select
            aria-label="Equipment type"
            value={p.kind}
            disabled={p.hasSession || p.connected || p.busy}
            onChange={(e) => p.onKind(e.target.value as Kind)}
          >
            {(["Treadmill", "Bike", "Rower"] as Kind[]).map((kind) => (
              <option key={kind} value={kind}>
                {kind}
              </option>
            ))}
          </select>
        </label>
        <p role="status">
          {p.connected
            ? `Connected${p.deviceName ? " · " + p.deviceName : ""}`
            : p.busy
              ? "Connecting…"
              : "Select your machine using the Bluetooth picker."}
        </p>
        <div className="actions">
          <button
            className="primary connect-primary"
            disabled={p.connected || p.busy || p.running}
            onClick={p.onConnect}
          >
            {p.connected
              ? "Connected"
              : p.busy
                ? "Connecting…"
                : "Connect equipment"}
          </button>
          <button onClick={p.onExport}>Export diagnostics</button>
        </div>
        {p.error && <p role="status">{p.error}</p>}
        {p.hint && !p.connected && <p role="status">{p.hint}</p>}
      </div>
    </section>
  );
}
