import { useEffect, useRef, useState } from "react";
import { ControlMode, type MachineControlMode } from "./ControlMode";
import { WorkoutReadings } from "./WorkoutReadings";
import { IntervalCue } from "./WorkoutFeedback";

const key = "kwest-immersive-layout";
const elements = [
  ["Percurso", "Route", 1],
  ["Modo de controlo", "Control mode", 2],
  ["Sair", "Exit", 3],
  ["Ajustar equipamento", "Equipment adjustments", 4],
  ["Próximo intervalo", "Next interval", 5],
  ["Métricas", "Metrics", 6],
  ["Pausar / Retomar", "Pause / Resume", 7],
  ["Parar treino", "Stop workout", 8],
] as const;
const positions = [
  ["Topo esquerdo", "Top left"],
  ["Topo ao centro", "Top centre"],
  ["Topo direito", "Top right"],
  ["Meio esquerdo", "Middle left"],
  ["Meio ao centro", "Middle centre"],
  ["Meio direito", "Middle right"],
  ["Fundo esquerdo", "Bottom left"],
  ["Fundo ao centro", "Bottom centre"],
  ["Fundo direito", "Bottom right"],
];
const defaults = elements.map(([, , slot]) => Number(slot));
const required = [2, 6, 7];

export function readImmersiveLayout(): number[] | null {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      Array.isArray(value) &&
      value.length === elements.length &&
      value.every((slot) => Number.isInteger(slot) && slot >= 0 && slot <= 9) &&
      required.every((index) => value[index] > 0) &&
      new Set(value.filter(Boolean)).size === value.filter(Boolean).length
    )
      return value;
  } catch {}
  return null;
}

export function immersiveSlot(layout: number[] | null, index: number) {
  return layout ? { "data-immersive-slot": layout[index] } : {};
}

export function ImmersiveLayoutEditor() {
  const [layout, setLayout] = useState(() => readImmersiveLayout() ?? defaults);
  const [status, setStatus] = useState("");
  const portuguese = (
    document.documentElement.lang || navigator.language
  ).startsWith("pt");
  const label = (pt: string, en: string) => (portuguese ? pt : en);
  const setSlot = (index: number, slot: number) => {
    const occupied = slot ? layout.indexOf(slot) : -1;
    if (occupied !== -1 && required.includes(occupied) && !layout[index])
      return;
    setLayout(
      layout.map((previous, item) =>
        item === index ? slot : item === occupied ? layout[index] : previous,
      ),
    );
    setStatus("");
  };
  function save(value: number[] | null) {
    try {
      if (value) localStorage.setItem(key, JSON.stringify(value));
      else localStorage.removeItem(key);
      setStatus(label("Disposição guardada.", "Layout saved."));
    } catch {
      setStatus(
        label(
          "Não foi possível guardar a disposição.",
          "Could not save the layout.",
        ),
      );
    }
  }
  return (
    <details className="settings-group immersive-layout-editor">
      <summary>
        {label("Personalizar vista imersiva", "Customise immersive view")}
      </summary>
      <ImmersiveSimulation layout={layout} label={label} />
      {elements.map(([pt, en], index) => (
        <label key={en}>
          {label(pt, en)}
          <select
            aria-label={label(pt, en)}
            value={layout[index]}
            onChange={(event) => setSlot(index, Number(event.target.value))}
          >
            {!required.includes(index) && (
              <option value={0}>{label("Ocultar", "Hide")}</option>
            )}
            {positions.map(([positionPt, positionEn], slot) => (
              <option
                key={positionEn}
                value={slot + 1}
                disabled={
                  !layout[index] &&
                  required.some((item) => layout[item] === slot + 1)
                }
              >
                {label(positionPt, positionEn)}
              </option>
            ))}
          </select>
        </label>
      ))}
      <div className="actions">
        <button type="button" className="primary" onClick={() => save(layout)}>
          {label("Guardar disposição", "Save layout")}
        </button>
        <button
          type="button"
          onClick={() => {
            setLayout(defaults);
            save(null);
          }}
        >
          {label("Repor disposição", "Restore layout")}
        </button>
      </div>
      <p role="status">{status}</p>
    </details>
  );
}

function ImmersiveSimulation({
  layout,
  label,
}: {
  layout: number[];
  label: (pt: string, en: string) => string;
}) {
  const [kind, setKind] = useState<"Treadmill" | "Bike" | "Rower">("Treadmill");
  const [mode, setMode] = useState<MachineControlMode>("follow");
  const [run, setRun] = useState<"running" | "paused" | "stopped">("running");
  const [seconds, setSeconds] = useState(72);
  const [adjustment, setAdjustment] = useState(0);
  const [moving, setMoving] = useState(
    () => !matchMedia("(prefers-reduced-motion: reduce)").matches,
  );
  const [visible, setVisible] = useState(false);
  const preview = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const details = preview.current?.closest("details");
    if (!details) return;
    const update = () => setVisible(details.open);
    update();
    details.addEventListener("toggle", update);
    return () => details.removeEventListener("toggle", update);
  }, []);
  useEffect(() => {
    if (!visible || run !== "running") return;
    const timer = window.setInterval(
      () => setSeconds((value) => value + 1),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [visible, run]);
  useEffect(() => {
    if (visible && moving && run === "running")
      void video.current?.play().catch(() => {});
    else video.current?.pause();
  }, [visible, moving, run]);

  const equipment =
    kind === "Treadmill"
      ? label("Passadeira", "Treadmill")
      : kind === "Bike"
        ? label("Bicicleta", "Bike")
        : label("Remo", "Rower");
  const speed = kind === "Treadmill" ? 6 : kind === "Bike" ? 23 : 9;
  const time = [Math.floor(seconds / 60), seconds % 60]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
  function restart() {
    setSeconds(0);
    setAdjustment(0);
    setMode("follow");
    setRun("running");
  }

  return (
    <>
      <p className="subtle">
        {label(
          "Simulação com dados de exemplo. Experimente os controlos e veja as alterações à medida que ajusta a disposição.",
          "Simulation with sample data. Try the controls and see changes as you adjust the layout.",
        )}
      </p>
      <div className="immersive-simulation-tools">
        <label>
          {label("Equipamento simulado", "Simulated equipment")}
          <select
            aria-label={label("Equipamento simulado", "Simulated equipment")}
            value={kind}
            onChange={(event) => {
              setKind(event.target.value as typeof kind);
              setAdjustment(0);
            }}
          >
            <option value="Treadmill">
              {label("Passadeira", "Treadmill")}
            </option>
            <option value="Bike">{label("Bicicleta", "Bike")}</option>
            <option value="Rower">{label("Remo", "Rower")}</option>
          </select>
        </label>
        <button
          type="button"
          aria-pressed={moving}
          onClick={() => setMoving((value) => !value)}
        >
          {label("Vídeo em movimento", "Moving video")}
        </button>
        <button
          type="button"
          onClick={() => {
            void preview.current
              ?.requestFullscreen?.({ navigationUI: "hide" })
              .catch(() => {});
          }}
        >
          {label("Pré-visualizar em ecrã inteiro", "Preview fullscreen")}
        </button>
      </div>
      <div
        className="immersive-layout-preview expanded"
        data-custom-immersive=""
        ref={preview}
        tabIndex={0}
        aria-label={label(
          "Simulação da vista imersiva",
          "Immersive view simulation",
        )}
      >
        <video
          ref={video}
          className="immersive-simulation-video"
          aria-hidden="true"
          muted
          loop
          playsInline
          preload="none"
          src={
            visible && moving ? "https://media.kwest.fit/video.webm" : undefined
          }
        />
        <div className="immersion-route" {...immersiveSlot(layout, 0)}>
          <span>{equipment}</span>
          <strong>{label("Caminho da floresta", "Woodland path")}</strong>
        </div>
        <div className="immersive-slot" {...immersiveSlot(layout, 1)}>
          <ControlMode
            value={mode}
            onChange={setMode}
            busy={false}
            automaticUnavailable=""
          />
        </div>
        <button
          type="button"
          className="immersion-exit"
          {...immersiveSlot(layout, 2)}
          onClick={() => {
            if (document.fullscreenElement === preview.current)
              void document.exitFullscreen();
            else setRun("paused");
          }}
        >
          {label("Sair", "Exit")}
        </button>
        <div className="immersion-adjustments" {...immersiveSlot(layout, 3)}>
          <details>
            <summary>
              {label("Ajustar equipamento", "Equipment adjustments")}
            </summary>
            <div className="immersive-simulation-stepper">
              <button
                type="button"
                aria-label={label("Diminuir", "Decrease")}
                onClick={() =>
                  setAdjustment((value) => Math.max(-3, value - 1))
                }
              >
                −
              </button>
              <output>{adjustment + (kind === "Treadmill" ? 4 : 6)}</output>
              <button
                type="button"
                aria-label={label("Aumentar", "Increase")}
                onClick={() => setAdjustment((value) => Math.min(6, value + 1))}
              >
                +
              </button>
            </div>
          </details>
        </div>
        <div className="immersive-slot" {...immersiveSlot(layout, 4)}>
          <IntervalCue
            text={label("A seguir · Recuperação", "Next · Recovery")}
          />
        </div>
        <div className="immersive-slot" {...immersiveSlot(layout, 5)}>
          <WorkoutReadings
            kind={kind}
            speed={speed + adjustment * 0.5}
            time={time}
            incline={kind === "Treadmill" ? 4 + adjustment : null}
            power={kind === "Bike" ? 140 + adjustment * 5 : null}
            resistance={kind === "Treadmill" ? null : 6 + adjustment}
            distance={(seconds * speed) / 3.6}
            calories={Math.round(seconds / 6)}
          />
        </div>
        <button
          type="button"
          className="immersion-pause primary"
          {...immersiveSlot(layout, 6)}
          onClick={() =>
            run === "stopped"
              ? restart()
              : setRun(run === "running" ? "paused" : "running")
          }
        >
          {run === "running"
            ? label("Pausar", "Pause")
            : run === "paused"
              ? label("Retomar", "Resume")
              : label("Reiniciar", "Restart")}
        </button>
        <button
          type="button"
          className="danger immersion-stop"
          {...immersiveSlot(layout, 7)}
          onClick={() => setRun("stopped")}
        >
          {label("Parar treino", "Stop workout")}
        </button>
        <div className="immersion-status" role="status">
          {run === "running"
            ? label("Simulação em curso", "Simulation running")
            : run === "paused"
              ? label("Simulação em pausa", "Simulation paused")
              : label("Simulação terminada", "Simulation stopped")}
        </div>
      </div>
    </>
  );
}

let workoutFullscreen = false;

export function startWorkoutFullscreen() {
  const root = document.documentElement;
  if (document.fullscreenElement || !root.requestFullscreen) return;
  workoutFullscreen = true;
  void root.requestFullscreen({ navigationUI: "hide" }).catch(() => {
    workoutFullscreen = false;
  });
}

export function isWorkoutFullscreen() {
  return (
    workoutFullscreen && document.fullscreenElement === document.documentElement
  );
}

export function exitWorkoutFullscreen() {
  if (isWorkoutFullscreen()) void document.exitFullscreen().catch(() => {});
  workoutFullscreen = false;
}
