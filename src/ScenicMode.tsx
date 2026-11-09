import { useEffect, useRef, useState } from "react";
import type { Kind } from "./store";
export function ScenicMode({
  speed,
  running,
  kind,
  time,
  onPause,
  onStop,
  busy,
}: {
  speed: number | null;
  running: boolean;
  kind: Kind;
  time: string;
  onPause: () => void;
  onStop: () => void;
  busy: boolean;
}) {
  const [enabled, setEnabled] = useState(false),
    [expanded, setExpanded] = useState(false),
    [simple, setSimple] = useState(false),
    [sound, setSound] = useState(false),
    [error, setError] = useState("");
  const host = useRef<HTMLDivElement>(null);
  const motion = useRef({ speed: 0, running: false, cycling: false });
  motion.current = {
    speed: speed ?? 0,
    running: running && speed != null,
    cycling: kind === "Bike",
  };
  useEffect(() => {
    if (!enabled || !host.current) return;
    let cancelled = false,
      cleanup: (() => void) | undefined;
    const canvas = document.createElement("canvas");
    canvas.className = "forest-canvas";
    canvas.setAttribute(
      "aria-label",
      "Forest route driven by equipment movement",
    );
    host.current.append(canvas);
    setError("");
    import("./sceneryRenderer")
      .then(({ createForest }) => {
        if (!cancelled)
          cleanup = createForest(
            canvas,
            () => motion.current,
            () => setSimple(true),
          );
      })
      .catch(() => {
        setError(
          "Scenery could not load. Your workout controls remain available.",
        );
      });
    return () => {
      cancelled = true;
      cleanup?.();
      canvas.remove();
      host.current?.replaceChildren();
    };
  }, [enabled]);
  useEffect(() => {
    if (!expanded) return;
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", listener);
    document.body.classList.add("scenic-expanded");
    return () => {
      document.removeEventListener("keydown", listener);
      document.body.classList.remove("scenic-expanded");
    };
  }, [expanded]);
  useEffect(() => {
    if (!enabled || !sound || !running) return;
    let context: AudioContext;
    try {
      context = new AudioContext();
      const buffer = context.createBuffer(
          1,
          context.sampleRate * 3,
          context.sampleRate,
        ),
        data = buffer.getChannelData(0);
      let previous = 0;
      for (let i = 0; i < data.length; i++) {
        previous = (previous + Math.random() * 0.02 - 0.01) / 1.02;
        data[i] = previous * 3;
      }
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      const filter = context.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 500;
      const gain = context.createGain();
      gain.gain.value = running ? 0.07 : 0;
      source.connect(filter).connect(gain).connect(context.destination);
      source.start();
      context.resume().catch(() => setSound(false));
      return () => {
        source.stop();
        void context.close();
      };
    } catch {
      setSound(false);
    }
  }, [sound, enabled, running]);
  return (
    <section
      className={"scenic-mode " + (expanded ? "expanded" : "")}
      aria-label="Scenic mode"
    >
      <div className="scenic-toolbar">
        <div>
          <strong>Forest escape</strong>
          <small>
            {kind === "Bike" ? "Countryside forest road" : "Woodland trail"}
            {simple ? " · Simple graphics" : ""}
          </small>
        </div>
        <button
          onClick={() => {
            setEnabled(!enabled);
            setExpanded(false);
            setSimple(false);
          }}
        >
          {enabled ? "Close scenery" : "Open scenery"}
        </button>
      </div>
      {enabled && (
        <>
          <div className="scenic-stage">
            <div ref={host} className="forest-host" />
            {error && (
              <p className="scenic-message" role="alert">
                {error}
              </p>
            )}
            <div className="scenic-readout">
              <span>
                {running ? "In motion" : "Paused"} · {time}
              </span>
              <strong>
                {speed == null
                  ? "Waiting for speed"
                  : `${speed.toFixed(1)} km/h`}
              </strong>
            </div>
            {!running && (
              <div className="scenic-paused">
                Take a breath.<small>Resume your programme when ready.</small>
              </div>
            )}
          </div>
          <div className="scenic-controls">
            <button aria-pressed={sound} onClick={() => setSound(!sound)}>
              {sound ? "Sound off" : "Wind ambience"}
            </button>
            <button
              aria-pressed={expanded}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Exit immersive view" : "Immersive view"}
            </button>
            <button className="primary" disabled={busy} onClick={onPause}>
              {running ? "Pause workout" : "Resume workout"}
            </button>
            <button className="danger" onClick={onStop}>
              Stop workout
            </button>
          </div>
          <p className="scenic-caption">
            Scenery follows measured speed. Terrain never changes machine
            targets. Keep this app visible.
          </p>
        </>
      )}
    </section>
  );
}
