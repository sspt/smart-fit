import { useEffect, useRef, useState, type ReactNode } from "react";
import { Pagination, usePageSize } from "./Pagination";
import { AppIcon } from "./AppIcon";
import { useMediaServer, useVideoRoutes } from "./VideoCatalog";
import { sceneDuration } from "./catalog";
import type { Programme, Kind } from "./store";
const steps = ["Connect", "Programme", "Scene", "Start"];
const duration = (p: Programme) => {
  const seconds =
    p.blocks.reduce((n, b) => n + (b.distance ? 0 : b.duration), 0) * p.repeat;
  const metres = p.blocks.reduce((n, b) => n + (b.distance ?? 0), 0) * p.repeat;
  return [
    seconds ? `${Math.round(seconds / 60)} min` : "",
    metres ? `${metres.toLocaleString()} m` : "",
  ]
    .filter(Boolean)
    .join(" + ");
};
export function GuidedSetup({
  step,
  onStep,
  connected,
  kind,
  programmes,
  programmeId,
  onProgramme,
  sceneId,
  onScene,
  devicePanel,
  deviceName,
  automatic,
  busy,
  onStart,
  onCancel,
}: {
  step: number;
  onStep: (n: number) => void;
  connected: boolean;
  kind: Kind;
  programmes: Programme[];
  programmeId: string | null;
  onProgramme: (id: string) => void;
  sceneId: string | null;
  onScene: (id: string) => void;
  devicePanel: ReactNode;
  deviceName: string;
  automatic: boolean;
  busy: boolean;
  onStart: () => void;
  onCancel: () => void;
}) {
  const videoRoutes = useVideoRoutes();
  const { choosePhoneVideo } = useMediaServer();
  const pageSize = usePageSize();
  const [programmePage, setProgrammePage] = useState(0);
  const choices = programmes.filter((p) => p.kind === kind);
  const scenes = videoRoutes.filter((r) => r.kind === kind);
  const [scenePage, setScenePage] = useState(0);
  useEffect(() => {
    if (step === 2)
      setScenePage(
        Math.max(
          0,
          scenes.findIndex((r) => r.id === sceneId),
        ),
      );
  }, [step, sceneId, kind, videoRoutes.length]);
  useEffect(() => setProgrammePage(0), [kind, pageSize, programmes.length]);
  const heading = useRef<HTMLHeadingElement>(null);
  const connectionSeen = useRef(connected);
  const programme = programmes.find(
    (p) => p.id === programmeId && p.kind === kind,
  );
  const scene = videoRoutes.find((r) => r.id === sceneId && r.kind === kind);
  const canContinue =
    connected && (step === 0 || !!programme) && (step < 2 || !!scene);
  useEffect(() => {
    if (!connected) connectionSeen.current = false;
    if (step === 0 && connected && !busy && !connectionSeen.current) {
      connectionSeen.current = true;
      onStep(1);
    }
  }, [connected, busy, step, onStep]);
  useEffect(() => {
    heading.current?.focus();
    window.scrollTo(0, 0);
  }, [step]);
  return (
    <section
      className={`guided-setup setup-step-${step}`}
      aria-label="Set up your journey"
    >
      <div className="setup-topline">
        <p className="eyebrow">YOUR NEXT ESCAPE</p>
        <button
          onClick={step > 0 ? () => onStep(step - 1) : onCancel}
          disabled={busy}
        >
          {step > 0 ? "Back" : "Close"}{" "}
          <AppIcon name={step > 0 ? "back" : "close"} size={16} />
        </button>
      </div>
      <ol className="setup-progress" aria-label="Setup progress">
        {steps.map((label, index) => (
          <li
            key={label}
            aria-current={step === index ? "step" : undefined}
            className={index < step ? "complete" : ""}
          >
            <span>
              {index < step ? <AppIcon name="check" size={15} /> : index + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      <div className="setup-intro">
        <p className="eyebrow">STEP {step + 1} OF 4</p>
        <h1 ref={heading} tabIndex={-1}>
          {
            [
              "Connect your equipment.",
              "Find your rhythm.",
              "Choose your elsewhere.",
              "Your scene is set.",
            ][step]
          }
        </h1>
        <p>
          {
            [
              "First, connect the machine you’ll be moving with.",
              `Choose a programme for your ${kind.toLowerCase()}.`,
              "Pick the scenery that will move at your pace.",
              "Everything is ready. Start when you are.",
            ][step]
          }
        </p>
      </div>
      {step === 0 && devicePanel}
      {step === 1 && (
        <div
          className="setup-programmes"
          role="group"
          aria-label="Choose a programme"
        >
          {choices
            .slice(programmePage * pageSize, (programmePage + 1) * pageSize)
            .map((p) => (
              <button
                key={p.id}
                className="setup-programme"
                aria-pressed={p.id === programmeId}
                disabled={busy}
                onClick={() => {
                  onProgramme(p.id);
                  onStep(scene ? 3 : 2);
                }}
              >
                <span className="setup-duration">{duration(p)}</span>
                <span>
                  <strong>{p.name}</strong>
                  <small>
                    {p.blocks.length} segments · {p.kind}
                  </small>
                </span>
                <span className="selection-dot">
                  {p.id === programmeId && <AppIcon name="check" size={16} />}
                </span>
              </button>
            ))}
          {choices.length > pageSize && (
            <Pagination
              page={programmePage}
              size={pageSize}
              count={choices.length}
              onChange={setProgrammePage}
              label="Setup programme pages"
            />
          )}
          {!programmes.some((p) => p.kind === kind) && (
            <p>
              No programmes for this equipment yet. Close setup and create one
              from Home.
            </p>
          )}
        </div>
      )}
      {step === 2 && (
        <div className="setup-scenes" role="group" aria-label="Choose a scene">
          <label className="button primary phone-video-picker">
            Choose video from phone
            <input
              type="file"
              accept="video/*"
              hidden
              disabled={busy}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                onScene(choosePhoneVideo(file, kind));
                onStep(3);
                e.target.value = "";
              }}
            />
          </label>
          {scenes.slice(scenePage, scenePage + 1).map((r) => (
            <button
              key={r.id}
              className="setup-scene"
              aria-pressed={sceneId === r.id}
              disabled={busy}
              onClick={() => {
                onScene(r.id);
                onStep(3);
              }}
              style={{ backgroundImage: `url(${r.poster})` }}
            >
              <span className="selection-dot">
                {sceneId === r.id && <AppIcon name="check" size={16} />}
              </span>
              <span className="setup-scene-title">
                <small>
                  {r.src.startsWith("blob:")
                    ? "Video from your phone"
                    : `${sceneDuration(r)} ${r.format === "route" ? "nature route" : "scenic loop"}`}{" "}
                  · follows your speed
                </small>
                <strong>{r.name.replace(" · scenic loop", "")}</strong>
              </span>
            </button>
          ))}
          {scenes.length > 1 && (
            <Pagination
              page={scenePage}
              size={1}
              count={scenes.length}
              onChange={setScenePage}
              label="Setup scene pages"
            />
          )}
          <p className="setup-hint">
            Scenery follows your pace and repeats if your session outlasts the
            recording.
          </p>
        </div>
      )}
      {step === 3 && programme && scene && (
        <div
          className="setup-review"
          style={{ backgroundImage: `url(${scene.poster})` }}
        >
          {scene.src.startsWith("blob:") && (
            <label className="phone-video-speed">
              Video reference speed (km/h)
              <input
                type="number"
                inputMode="decimal"
                min="0.1"
                max="100"
                step="0.1"
                aria-label="Video reference speed (km/h)"
                key={scene.id}
                defaultValue={(() => {
                  try {
                    return (
                      Number(
                        localStorage.getItem(
                          "native-video-reference:" + scene.id,
                        ),
                      ) || 5
                    );
                  } catch {
                    return 5;
                  }
                })()}
                onBlur={(e) => {
                  const n = Number(e.target.value);
                  if (!Number.isFinite(n) || n <= 0 || n > 100) {
                    e.target.value = "5";
                    try {
                      localStorage.setItem(
                        "native-video-reference:" + scene.id,
                        "5",
                      );
                    } catch {}
                  }
                }}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value > 0 && value <= 100)
                    try {
                      localStorage.setItem(
                        "native-video-reference:" + scene.id,
                        String(value),
                      );
                    } catch {}
                }}
              />
              <small>
                5 km/h plays at normal speed when your machine reports 5 km/h.
                The file stays on your phone; select it again after reloading.
              </small>
            </label>
          )}
          <p className="eyebrow">READY FOR YOUR ESCAPE</p>
          <h2>
            <button
              className="review-change review-scene-heading"
              onClick={() => onStep(2)}
              aria-label="Change scene"
            >
              {scene.name.replace(" · scenic loop", "")}
              <AppIcon name="arrow" size={17} />
            </button>
          </h2>
          <dl>
            <div>
              <dt>Equipment</dt>
              <dd>
                <button
                  className="review-change"
                  onClick={() => onStep(0)}
                  aria-label="Change equipment"
                >
                  {deviceName}
                  <AppIcon name="arrow" size={14} />
                </button>
              </dd>
            </div>
            <div>
              <dt>Programme</dt>
              <dd>
                <button
                  className="review-change"
                  onClick={() => onStep(1)}
                  aria-label="Change programme"
                >
                  {programme.name}
                  <AppIcon name="arrow" size={14} />
                </button>
              </dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>{duration(programme)}</dd>
            </div>
            <div>
              <dt>Control</dt>
              <dd>
                {automatic
                  ? "Automatic targets · physical controls take priority"
                  : "Tracking only · use the machine’s controls"}
              </dd>
            </div>
          </dl>
          <p>
            The scenery opens full screen and follows your device speed. Pause
            and stop stay on screen.
          </p>
        </div>
      )}
      {(step === 3 || (step === 0 && connected)) && (
        <div className="setup-footer">
          <span>
            {step === 0
              ? connected
                ? `Connected · ${deviceName}`
                : "Waiting for your equipment"
              : programme
                ? `${kind} · ${duration(programme)}`
                : `Choose a ${kind.toLowerCase()} programme`}
          </span>
          {(step === 3 || (step === 0 && connected)) && (
            <button
              className="primary"
              disabled={busy || !canContinue}
              onClick={step === 3 ? onStart : () => onStep(1)}
            >
              {busy
                ? "Please wait…"
                : step === 3
                  ? "Start journey"
                  : "Continue"}
              <AppIcon name={step === 3 ? "play" : "arrow"} size={17} />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
