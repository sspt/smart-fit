import { useEffect, useRef, useState } from "react";
import {
  block,
  validProgramme,
  type Programme,
  type Segment,
  type Kind,
} from "./store";
import { AppIcon } from "./AppIcon";
const fmt = (seconds: number) =>
  `${Math.floor(seconds / 60)}m${seconds % 60 ? " " + (seconds % 60) + "s" : ""}`;
const targets = {
  Treadmill: [
    ["speed", "Speed", "km/h", 0, 25, 0.1],
    ["incline", "Incline", "%", -6, 40, 0.5],
  ],
  Bike: [["power", "Power", "W", 0, 2000, 5]],
  Rower: [["resistance", "Resistance", "level", 0, 100, 1]],
} as const;
export function ProgrammeEditor({
  value,
  existing,
  onSave,
  onClose,
  onDelete,
}: {
  value: Programme;
  existing: boolean;
  onSave: (p: Programme) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(() => structuredClone(value)),
    [open, setOpen] = useState(0),
    [error, setError] = useState("");
  const dialog = useRef<HTMLElement>(null),
    scroll = useRef<HTMLDivElement>(null),
    initial = useRef(JSON.stringify(value));
  const close = () => {
    if (
      JSON.stringify(draft) !== initial.current &&
      !confirm("Discard unsaved programme changes?")
    )
      return;
    onClose();
  };
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    document.body.classList.add("editing");
    dialog.current?.focus();
    return () => {
      document.body.classList.remove("editing");
      previous?.focus();
    };
  }, []);
  function keydown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
    if (e.key === "Tab") {
      const all = Array.from(
        dialog.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,[tabindex="0"]',
        ) ?? [],
      ).filter((el) => el.getClientRects().length);
      const first = all[0],
        last = all[all.length - 1];
      if (
        e.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === dialog.current)
      ) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    }
  }
  function update(i: number, patch: Partial<Segment>) {
    setDraft((d) => ({
      ...d,
      blocks: d.blocks.map((b, j) => (j === i ? { ...b, ...patch } : b)),
    }));
    setError("");
  }
  function move(i: number, to: number) {
    if (to < 0 || to >= draft.blocks.length) return;
    const blocks = [...draft.blocks];
    [blocks[i], blocks[to]] = [blocks[to], blocks[i]];
    setDraft({ ...draft, blocks });
    setOpen(to);
  }
  function add() {
    setDraft((d) => ({ ...d, blocks: [...d.blocks, block("New segment")] }));
    setOpen(draft.blocks.length);
    requestAnimationFrame(() =>
      scroll.current?.scrollTo({
        top: scroll.current.scrollHeight,
        behavior: "smooth",
      }),
    );
  }
  function save() {
    if (!validProgramme({ ...draft, name: draft.name.trim() })) {
      setError(
        "Enter a name, repeat 1–100, duration 5 seconds–24 hours or distance 10–100,000 m. Check target limits.",
      );
      return;
    }
    onSave({ ...draft, name: draft.name.trim() });
  }
  const seconds =
    draft.blocks.reduce((n, b) => n + (b.distance ? 0 : b.duration), 0) *
    draft.repeat;
  const metres =
    draft.blocks.reduce((n, b) => n + (b.distance ?? 0), 0) * draft.repeat;
  return (
    <div className="editor-backdrop">
      <section
        className="programme-editor"
        role="dialog"
        aria-modal="true"
        aria-labelledby="editor-title"
        tabIndex={-1}
        ref={dialog}
        onKeyDown={keydown}
      >
        <div className="editor-top">
          <button
            className="icon-button"
            onClick={close}
            aria-label="Close programme editor"
          >
            <AppIcon name="close" />
          </button>
          <div>
            <small>{existing ? "EDIT PROGRAMME" : "NEW PROGRAMME"}</small>
            <h2 id="editor-title">Build your session</h2>
          </div>
          <button
            className="primary save-button"
            onClick={save}
            aria-label="Save programme"
          >
            <AppIcon name="check" size={18} />
            Save
          </button>
        </div>
        <div className="editor-content" ref={scroll}>
          {error && (
            <div className="notice editor-error" role="alert">
              {error}
            </div>
          )}
          <section className="editor-details">
            <label>
              Programme name
              <input
                maxLength={80}
                autoComplete="off"
                placeholder="Give your session a name"
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <fieldset>
              <legend>Equipment</legend>
              <div className="equipment-picker">
                {(["Treadmill", "Bike", "Rower"] as Kind[]).map((kind) => (
                  <button
                    key={kind}
                    aria-pressed={draft.kind === kind}
                    className={draft.kind === kind ? "selected" : ""}
                    onClick={() => setDraft({ ...draft, kind })}
                  >
                    <AppIcon name={kind} />
                    {kind}
                  </button>
                ))}
              </div>
            </fieldset>
            <div className="repeat-setting">
              <div>
                <strong>Repeat programme</strong>
                <p>How many times through the segments?</p>
              </div>
              <NumberControl
                label="Repeat"
                value={draft.repeat}
                min={1}
                max={100}
                step={1}
                onChange={(repeat) => setDraft({ ...draft, repeat })}
                compact
              />
            </div>
          </section>
          <div className="segments-heading">
            <div>
              <h3>Workout segments</h3>
              <p>Tap a segment to change its targets.</p>
            </div>
            <span className="count-badge">{draft.blocks.length}</span>
          </div>
          <div className="segment-list">
            {draft.blocks.map((b, i) => {
              const expanded = open === i;
              return (
                <section
                  className={"segment-card " + (expanded ? "expanded" : "")}
                  key={i}
                >
                  <button
                    className="segment-summary"
                    aria-expanded={expanded}
                    aria-controls={"segment-content-" + i}
                    aria-label={`Edit segment ${i + 1}: ${b.name}`}
                    onClick={() => setOpen(expanded ? -1 : i)}
                  >
                    <span className="segment-number">
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <span className="segment-title">
                      <strong>{b.name || "Untitled segment"}</strong>
                      <small>
                        {b.distance ? `${b.distance} m` : fmt(b.duration)} ·{" "}
                        {draft.kind === "Treadmill"
                          ? `${b.speed} km/h · ${b.incline}%`
                          : draft.kind === "Bike"
                            ? `${b.power} W`
                            : `Level ${b.resistance}`}
                        {b.ramp ? " · Ramp" : ""}
                      </small>
                    </span>
                    <AppIcon name={expanded ? "up" : "down"} size={20} />
                  </button>
                  {expanded && (
                    <div
                      className="segment-content"
                      id={"segment-content-" + i}
                    >
                      <label>
                        Segment name
                        <input
                          maxLength={80}
                          autoComplete="off"
                          value={b.name}
                          onChange={(e) => update(i, { name: e.target.value })}
                        />
                      </label>
                      <fieldset>
                        <legend>Segment ends after</legend>
                        <div className="segmented-control">
                          <button
                            aria-pressed={!b.distance}
                            onClick={() => update(i, { distance: undefined })}
                          >
                            Time
                          </button>
                          <button
                            aria-pressed={!!b.distance}
                            onClick={() =>
                              update(i, { distance: b.distance ?? 500 })
                            }
                          >
                            Distance
                          </button>
                        </div>
                      </fieldset>
                      {b.distance ? (
                        <NumberControl
                          label="Distance"
                          unit="m"
                          value={b.distance}
                          min={10}
                          max={100000}
                          step={50}
                          onChange={(distance) => update(i, { distance })}
                        />
                      ) : (
                        <div className="duration-grid">
                          <NumberControl
                            label="Minutes"
                            unit="min"
                            value={Math.floor(b.duration / 60)}
                            min={0}
                            max={1440}
                            step={1}
                            onChange={(n) =>
                              update(i, {
                                duration: n * 60 + (b.duration % 60),
                              })
                            }
                          />
                          <NumberControl
                            label="Seconds"
                            unit="sec"
                            value={b.duration % 60}
                            min={0}
                            max={59}
                            step={5}
                            onChange={(n) =>
                              update(i, {
                                duration: Math.floor(b.duration / 60) * 60 + n,
                              })
                            }
                          />
                        </div>
                      )}
                      <div className="target-heading">
                        <span>{b.ramp ? "Starting targets" : "Targets"}</span>
                        <small>{draft.kind}</small>
                      </div>
                      <div className="target-grid">
                        {targets[draft.kind].map(
                          ([key, label, unit, min, max, step]) => (
                            <NumberControl
                              key={key}
                              label={label}
                              unit={unit}
                              value={b[key]}
                              min={min}
                              max={max}
                              step={step}
                              onChange={(n) => update(i, { [key]: n })}
                            />
                          ),
                        )}
                      </div>
                      <label className="ramp-toggle">
                        <span>
                          <strong>Gradually ramp targets</strong>
                          <small>
                            Build or reduce effort across this segment
                          </small>
                        </span>
                        <input
                          type="checkbox"
                          role="switch"
                          checked={!!b.ramp}
                          onChange={(e) =>
                            update(i, {
                              ramp: e.target.checked,
                              endSpeed: b.endSpeed ?? b.speed,
                              endIncline: b.endIncline ?? b.incline,
                              endPower: b.endPower ?? b.power,
                              endResistance: b.endResistance ?? b.resistance,
                            })
                          }
                        />
                      </label>
                      {b.ramp && (
                        <>
                          <div className="target-heading">
                            <span>Finishing targets</span>
                          </div>
                          <div className="target-grid">
                            {targets[draft.kind].map(
                              ([key, label, unit, min, max, step]) => {
                                const endKey = ("end" +
                                  key[0].toUpperCase() +
                                  key.slice(1)) as
                                  | "endSpeed"
                                  | "endIncline"
                                  | "endPower"
                                  | "endResistance";
                                return (
                                  <NumberControl
                                    key={key}
                                    label={"End " + label.toLowerCase()}
                                    unit={unit}
                                    value={b[endKey] ?? b[key]}
                                    min={min}
                                    max={max}
                                    step={step}
                                    onChange={(n) => update(i, { [endKey]: n })}
                                  />
                                );
                              },
                            )}
                          </div>
                        </>
                      )}
                      <div className="segment-tools">
                        <button
                          aria-label={`Move segment ${i + 1} up`}
                          disabled={i === 0}
                          onClick={() => move(i, i - 1)}
                        >
                          <AppIcon name="up" size={18} />
                          <span>Up</span>
                        </button>
                        <button
                          aria-label={`Move segment ${i + 1} down`}
                          disabled={i === draft.blocks.length - 1}
                          onClick={() => move(i, i + 1)}
                        >
                          <AppIcon name="down" size={18} />
                          <span>Down</span>
                        </button>
                        <button
                          aria-label={`Duplicate segment ${i + 1}`}
                          onClick={() => {
                            const blocks = [...draft.blocks];
                            blocks.splice(i + 1, 0, {
                              ...b,
                              name: b.name + " copy",
                            });
                            setDraft({ ...draft, blocks });
                            setOpen(i + 1);
                          }}
                        >
                          <AppIcon name="copy" size={18} />
                          <span>Copy</span>
                        </button>
                        <button
                          aria-label={`Remove segment ${i + 1}`}
                          disabled={draft.blocks.length === 1}
                          onClick={() => {
                            setDraft({
                              ...draft,
                              blocks: draft.blocks.filter((_, j) => j !== i),
                            });
                            setOpen(Math.max(0, i - 1));
                          }}
                        >
                          <AppIcon name="trash" size={18} />
                          <span>Remove</span>
                        </button>
                      </div>
                    </div>
                  )}
                </section>
              );
            })}
          </div>
          <button className="add-segment" onClick={add}>
            <AppIcon name="plus" size={20} />
            Add segment
          </button>
          <div className="programme-tools">
            <button
              onClick={() => {
                setDraft({
                  ...draft,
                  id: crypto.randomUUID(),
                  name: draft.name + " copy",
                });
                setError("");
              }}
            >
              Save as a copy
            </button>
            {existing && draft.id === value.id && (
              <button
                className="text-danger"
                onClick={() => {
                  if (confirm("Delete this programme?")) onDelete();
                }}
              >
                Delete programme
              </button>
            )}
          </div>
        </div>
        <div className="editor-bottom">
          <div>
            <small>SESSION TOTAL</small>
            <strong>
              {seconds ? fmt(seconds) : ""}
              {seconds && metres ? " + " : ""}
              {metres ? `${metres.toLocaleString()} m` : ""}
            </strong>
          </div>
          <span>
            {draft.blocks.length} segments · {draft.repeat}{" "}
            {draft.repeat === 1 ? "round" : "rounds"}
          </span>
        </div>
      </section>
    </div>
  );
}
function NumberControl({
  label,
  unit,
  value,
  min,
  max,
  step,
  onChange,
  compact = false,
}: {
  label: string;
  unit?: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (n: number) => void;
  compact?: boolean;
}) {
  const id = useRef("field-" + crypto.randomUUID());
  const change = (n: number) =>
    onChange(Math.round(Math.min(max, Math.max(min, n)) * 100) / 100);
  return (
    <div className={"number-field " + (compact ? "compact" : "")}>
      <label htmlFor={id.current}>
        {label}
        {unit && <span>{unit}</span>}
      </label>
      <div className="stepper">
        <button
          aria-label={"Decrease " + label.toLowerCase()}
          disabled={value <= min}
          onClick={() => change(value - step)}
        >
          −
        </button>
        <input
          id={id.current}
          type="number"
          inputMode={step < 1 ? "decimal" : "numeric"}
          min={min}
          max={max}
          step={step}
          value={Number.isFinite(value) ? value : ""}
          onChange={(e) =>
            onChange(e.target.value === "" ? 0 : Number(e.target.value))
          }
          onBlur={() => change(value)}
        />
        <button
          aria-label={"Increase " + label.toLowerCase()}
          disabled={value >= max}
          onClick={() => change(value + step)}
        >
          +
        </button>
      </div>
    </div>
  );
}
