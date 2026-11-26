import type { ReactNode } from "react";
import { startWorkoutFullscreen } from "./workoutFullscreen";
import { AppIcon } from "./AppIcon";
import { getLanguage, t } from "./i18n";

type Props = {
  time: string;
  speed: number | null;
  power?: number | null;
  kind?: string;
  units?: string;
  running: boolean;
  busy: boolean;
  onPause: () => void;
  onStop: () => void;
  onExit: () => void;
  adjustmentPanel: ReactNode;
  alerts: ReactNode;
};

export function ImmersiveControls({
  time,
  speed,
  power,
  kind,
  units = "km",
  running,
  busy,
  onPause,
  onStop,
  onExit,
  adjustmentPanel,
  alerts,
}: Props) {
  const pauseLabel = t(running ? "Pause workout" : "Resume workout");
  const stopLabel = t("Stop workout");
  const exitLabel = t("Exit immersive view");
  const showPower = kind === "Bike" && power != null && Number.isFinite(power);
  const speedUnit = units === "mi" ? "mi" : "km";
  const value = showPower
    ? power
    : speed == null
      ? null
      : speed * (speedUnit === "mi" ? 0.621371 : 1);
  return (
    <>
      <button
        type="button"
        className="immersion-essential-exit"
        aria-label={exitLabel}
        title={exitLabel}
        onClick={onExit}
      >
        <AppIcon name="close" size={20} />
      </button>
      {document.fullscreenEnabled && (
        <button
          type="button"
          className="immersion-fullscreen-retry"
          onClick={startWorkoutFullscreen}
        >
          {t("Full screen")}
        </button>
      )}
      <div className="immersion-essential">
        <div className="immersion-essential-alerts">{alerts}</div>
        <div className="immersion-essential-bar">
          <span
            className="immersion-essential-time"
            aria-label={t("WORKOUT TIME") + " " + time}
          >
            {time}
          </span>
          <span
            className="immersion-essential-speed"
            aria-label={t(showPower ? "POWER" : "DEVICE SPEED")}
          >
            {value != null && Number.isFinite(value)
              ? value.toLocaleString(getLanguage(), {
                  minimumFractionDigits: showPower ? 0 : 1,
                  maximumFractionDigits: showPower ? 0 : 1,
                })
              : "—"}{" "}
            <small>{showPower ? "W" : `${speedUnit}/h`}</small>
          </span>
          <details className="immersion-essential-adjust">
            <summary aria-label={t("Adjust equipment")}>
              <AppIcon name="Settings" size={17} />
              {t("Adjust")}
            </summary>
            <div className="immersion-essential-panel">
              <div className="immersion-essential-panel-heading">
                <strong>{t("Manual adjustment")}</strong>
                <button
                  type="button"
                  aria-label={t("Close")}
                  onClick={(event) => {
                    const disclosure = event.currentTarget.closest("details");
                    if (!disclosure) return;
                    disclosure.open = false;
                    disclosure.querySelector("summary")?.focus();
                  }}
                >
                  <AppIcon name="close" size={16} />
                </button>
              </div>
              {adjustmentPanel}
            </div>
          </details>
          <button
            type="button"
            className="immersion-pause"
            aria-label={pauseLabel}
            title={pauseLabel}
            disabled={busy}
            onClick={onPause}
          >
            <AppIcon name={running ? "pause" : "play"} size={18} />
          </button>
          <button
            type="button"
            className="danger immersion-stop"
            aria-label={stopLabel}
            title={stopLabel}
            onClick={onStop}
          >
            <span className="stop-square" />
          </button>
        </div>
      </div>
    </>
  );
}
