import { useState } from "react";

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
      <div
        className="immersive-layout-preview"
        aria-label={label("Pré-visualização", "Preview")}
      >
        {positions.map(([pt, en], index) => {
          const item = elements[layout.indexOf(index + 1)];
          return (
            <span key={en} title={label(pt, en)}>
              {item ? label(item[0], item[1]) : "—"}
            </span>
          );
        })}
      </div>
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
