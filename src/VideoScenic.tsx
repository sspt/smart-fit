import { ControlMode, type MachineControlMode } from "./ControlMode";
import { AppIcon } from "./AppIcon";
import { useEffect, useRef, useState } from "react";
import type { Kind } from "./store";
import { playbackRate } from "./videoRoutes";
import { useMediaServer, useVideoRoutes } from "./VideoCatalog";
import { useAdaptiveVideo, qualityLabel } from "./useAdaptiveVideo";
import { useSceneryLoop } from "./useSceneryLoop";
import { defaultVideoUrl } from "./videoRoutes";
import { sceneDuration } from "./catalog";
export function VideoScenic({
  controlMode,
  onControlMode,
  automaticUnavailable,
  speed,
  running,
  kind,
  time,
  onPause,
  onStop,
  busy,
  initialRouteId,
  autoImmerse = false,
}: {
  controlMode: MachineControlMode;
  onControlMode: (mode: MachineControlMode) => void;
  automaticUnavailable: string;
  speed: number | null;
  running: boolean;
  kind: Kind;
  time: string;
  onPause: () => void;
  onStop: () => void;
  busy: boolean;
  initialRouteId?: string;
  autoImmerse?: boolean;
}) {
  const videoRoutes = useVideoRoutes();
  const mediaServer = useMediaServer();
  const routes = videoRoutes.filter((r) => r.kind === kind);
  const [route, setRoute] = useState(initialRouteId ?? routes[0].id),
    [enabled, setEnabled] = useState(autoImmerse),
    [ready, setReady] = useState(false),
    [following, setFollowing] = useState(autoImmerse),
    [expanded, setExpanded] = useState(autoImmerse),
    [reference, setReference] = useState(routes[0].reference),
    [rate, setRate] = useState(1),
    [error, setError] = useState(""),
    [status, setStatus] = useState("Ready to open scenery"),
    [file, setFile] = useState<{ url: string; name: string } | null>(null);
  const container = useRef<HTMLElement>(null),
    returnFocus = useRef<HTMLElement | null>(null);
  const video = useRef<HTMLVideoElement>(null),
    followingRef = useRef(false),
    syncPause = useRef(false),
    generation = useRef(0);
  followingRef.current = following;
  const found = routes.find((r) => r.id === route);
  const selected = found ?? routes[0];
  const unavailable = route !== "local" && !found;
  const videoError = unavailable
    ? route.startsWith("phone-video-")
      ? "Select your phone video again, or choose another scene."
      : "Saved scene unavailable. Reconnect the video server or choose another scene."
    : error;
  const src = route === "local" ? file?.url : found?.src;
  const adaptive = useAdaptiveVideo(
    video,
    enabled ? src : undefined,
    enabled && route !== "local" && !unavailable ? selected.hlsSrc : undefined,
    () => {
      generation.current++;
      syncPause.current = true;
      setReady(false);
    },
    mediaServer.config.credentials &&
      !!mediaServer.config.baseUrl &&
      !!src?.startsWith(mediaServer.config.baseUrl + "/"),
  );
  const nasVideo =
    selected.skipSeconds !== undefined ||
    src === defaultVideoUrl ||
    (!!mediaServer.config.baseUrl &&
      !!src?.startsWith(mediaServer.config.baseUrl + "/"));
  useSceneryLoop(video, enabled, src, nasVideo, selected.skipSeconds ?? 30);
  useEffect(() => {
    setFollowing(enabled);
    setReady(false);
    setError("");
    setStatus("Ready to open scenery");
    generation.current++;
    try {
      const n = Number(localStorage.getItem("native-video-reference:" + route));
      setReference(
        n > 0 && Number.isFinite(n)
          ? n
          : route === "local"
            ? 5
            : selected.reference,
      );
    } catch {
      setReference(route === "local" ? 5 : selected.reference);
    }
  }, [route, src]);
  useEffect(() => {
    if (autoImmerse) {
      setEnabled(true);
      setFollowing(true);
      setExpanded(true);
    }
  }, [autoImmerse]);
  useEffect(
    () => () => {
      if (file) URL.revokeObjectURL(file.url);
    },
    [file],
  );
  useEffect(() => {
    const element = video.current;
    return () => {
      generation.current++;
      syncPause.current = true;
      if (element) {
        element.pause();
      }
    };
  }, [enabled, src]);
  useEffect(() => {
    if (!enabled || !ready) return;
    const el = video.current;
    if (!el) return;
    const wanted = playbackRate(speed, reference);
    if (!following || !running || wanted == null) {
      syncPause.current = true;
      el.pause();
      setStatus(
        !following
          ? "Video sync paused"
          : !running
            ? "Workout paused"
            : speed == null
              ? "Waiting for device telemetry"
              : reference <= 0
                ? "Set a valid reference speed"
                : "Device stopped",
      );
      return;
    }
    try {
      el.playbackRate = wanted;
      setRate(el.playbackRate);
      setStatus(
        wanted !== speed! / reference
          ? "Following device · player speed limit reached"
          : "Following device speed",
      );
      syncPause.current = false;
      const token = generation.current;
      void el.play().catch((e) => {
        if (token !== generation.current || e.name === "AbortError") return;
        setFollowing(false);
        setError(
          "Playback could not start. Tap Follow device to retry, or choose a local MP4 file.",
        );
      });
    } catch {
      setFollowing(false);
      setError("This browser does not support the requested playback speed.");
    }
  }, [speed, running, reference, following, enabled, ready]);
  async function exitImmersive() {
    setExpanded(false);
    if (document.fullscreenElement === container.current)
      try {
        await document.exitFullscreen();
      } catch {}
  }
  async function enterImmersive() {
    returnFocus.current = document.activeElement as HTMLElement;
    setExpanded(true);
    try {
      await container.current?.requestFullscreen?.({ navigationUI: "hide" });
    } catch {
      /* The viewport-filling layout also works when browser fullscreen is unavailable. */
    }
  }
  useEffect(() => {
    if (!expanded) return;
    document.body.classList.add("scenic-expanded");
    const saved: { element: HTMLElement; inert: boolean }[] = [];
    let element: HTMLElement | null = container.current;
    while (element && element !== document.body) {
      for (const sibling of Array.from(element.parentElement?.children ?? [])) {
        if (sibling !== element && sibling instanceof HTMLElement) {
          saved.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      element = element.parentElement;
    }
    container.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void exitImmersive();
      }
      if (event.key === "Tab") {
        const buttons = Array.from(
          container.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),[tabindex="0"]',
          ) ?? [],
        ).filter((el) => el.getClientRects().length);
        const first = buttons[0],
          last = buttons[buttons.length - 1];
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === container.current)
        ) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    const fullscreen = () => {
      if (!document.fullscreenElement) setExpanded(false);
    };
    document.addEventListener("keydown", keydown);
    document.addEventListener("fullscreenchange", fullscreen);
    return () => {
      document.body.classList.remove("scenic-expanded");
      saved.forEach(({ element, inert }) => (element.inert = inert));
      document.removeEventListener("keydown", keydown);
      document.removeEventListener("fullscreenchange", fullscreen);
      if (returnFocus.current?.isConnected) returnFocus.current.focus();
    };
  }, [expanded]);
  function follow() {
    if (following) {
      setFollowing(false);
      return;
    }
    setError("");
    setFollowing(true);
    const el = video.current,
      wanted = playbackRate(speed, reference);
    if (el && running && wanted != null) {
      el.playbackRate = wanted;
      syncPause.current = false;
      const token = generation.current;
      void el.play().catch((e) => {
        if (token !== generation.current || e.name === "AbortError") return;
        setFollowing(false);
        setError(
          "Unable to play video. Check the connection or try a local MP4 file.",
        );
      });
    }
  }
  return (
    <section
      className={"scenic-mode video-mode " + (expanded ? "expanded" : "")}
      ref={container}
      role={expanded ? "dialog" : undefined}
      aria-modal={expanded ? true : undefined}
      tabIndex={expanded ? -1 : undefined}
      aria-label="Scenic video"
    >
      <div className="scenic-toolbar">
        <label className="button phone-video-picker">
          Choose video from phone
          <input
            hidden
            type="file"
            accept="video/*"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setRoute(mediaServer.choosePhoneVideo(f, kind));
              setEnabled(true);
              e.target.value = "";
            }}
          />
        </label>
        <div>
          <strong>Real-world scenery</strong>
          <small>
            {kind} · {time}
          </small>
        </div>
        <button
          onClick={() => {
            generation.current++;
            setEnabled(!enabled);
            setExpanded(false);
            setFollowing(!enabled);
            setReady(false);
            setError("");
          }}
        >
          {enabled ? "Close video" : "Open video"}
        </button>
      </div>
      {!enabled && (
        <p className="scenic-caption">
          Open scenery to move through nature at your own pace.
        </p>
      )}
      {enabled && (
        <>
          <video
            key={src}
            ref={video}
            className="video-player native-video"
            poster={
              route === "local" || unavailable ? undefined : selected.poster
            }
            preload="metadata"
            playsInline
            muted
            loop
            controls={!expanded}
            controlsList="nofullscreen noremoteplayback"
            disablePictureInPicture
            onLoadedMetadata={() => {
              setReady(true);
              setError("");
            }}
            onError={() => {
              if (adaptive.transport === "hls") return;
              setError(
                "Video could not load. Check your connection, retry, or choose a local MP4 file.",
              );
              setFollowing(false);
              setReady(false);
            }}
            onWaiting={() =>
              setStatus("Buffering scenery… workout tracking continues")
            }
            onRateChange={() => {
              const el = video.current,
                wanted = playbackRate(speed, reference);
              if (el) {
                if (
                  followingRef.current &&
                  running &&
                  wanted != null &&
                  Math.abs(el.playbackRate - wanted) > 0.001
                )
                  el.playbackRate = wanted;
                setRate(el.playbackRate);
              }
            }}
            onPause={() => {
              if (!syncPause.current && followingRef.current) {
                setFollowing(false);
                setStatus(
                  "Video paused. Tap Follow device to resume synchronisation.",
                );
              }
            }}
            onPlay={() => {
              if (!followingRef.current) {
                const wanted = playbackRate(speed, reference);
                if (running && wanted != null) {
                  setFollowing(true);
                  setError("");
                  if (video.current) video.current.playbackRate = wanted;
                } else {
                  syncPause.current = true;
                  video.current?.pause();
                }
              }
            }}
          />
          {expanded && (
            <>
              <div className="immersion-top">
                <div className="immersion-route">
                  <span>
                    {kind} ·{" "}
                    {route === "local"
                      ? "Your video"
                      : selected.format === "route"
                        ? "Nature route"
                        : "Scenic loop"}
                  </span>
                  <strong>
                    {route === "local"
                      ? file?.name
                      : unavailable
                        ? "Saved scene unavailable"
                        : selected.name}
                  </strong>
                </div>
                <ControlMode
                  value={controlMode}
                  onChange={onControlMode}
                  busy={busy}
                  automaticUnavailable={automaticUnavailable}
                />
                <button
                  className="immersion-exit"
                  aria-label="Exit immersive view"
                  onClick={() => void exitImmersive()}
                >
                  <AppIcon name="close" size={22} />
                  <span>Exit</span>
                </button>
              </div>
              <div className="immersion-bottom">
                <div className="immersion-readings">
                  <div>
                    <small>DEVICE SPEED</small>
                    <strong>
                      {speed == null ? "—" : speed.toFixed(1)}
                      <span>km/h</span>
                    </strong>
                  </div>
                  <div>
                    <small>WORKOUT TIME</small>
                    <strong>{time}</strong>
                  </div>
                  <div className="immersion-rate">
                    <small>VIDEO SPEED</small>
                    <strong>
                      {rate.toFixed(2)}
                      <span>×</span>
                    </strong>
                  </div>
                </div>
                <div
                  className={
                    "immersion-status " + (videoError ? "has-error" : "")
                  }
                  role="status"
                >
                  {videoError ||
                    (!running
                      ? "Workout paused"
                      : !following
                        ? "Ready to follow your device"
                        : status)}
                </div>
                {running && !following && (
                  <button
                    className="immersion-retry"
                    disabled={!ready}
                    onClick={follow}
                  >
                    Resume scenery
                  </button>
                )}
                <div className="immersion-actions">
                  <button
                    className="immersion-pause"
                    disabled={busy}
                    onClick={onPause}
                  >
                    <AppIcon name={running ? "pause" : "play"} size={20} />
                    {running ? "Pause workout" : "Resume workout"}
                  </button>
                  <button className="danger immersion-stop" onClick={onStop}>
                    <span className="stop-square" />
                    Stop workout
                  </button>
                </div>
              </div>
            </>
          )}
          <div
            className={"video-status " + (videoError ? "has-error" : "")}
            role="status"
          >
            {videoError || status} · Device{" "}
            {speed == null ? "—" : speed.toFixed(1) + " km/h"} · Video{" "}
            {rate.toFixed(2)}×
          </div>
          <div className="scenic-controls">
            <button
              className="primary"
              onClick={() =>
                void (expanded ? exitImmersive() : enterImmersive())
              }
            >
              {expanded ? "Exit immersive view" : "Immersive view"}
            </button>
          </div>
          <details className="video-settings" open={!!videoError}>
            <summary>Video options</summary>
            <div className="video-options">
              <label>
                Scenery
                <select
                  aria-label="Scenery"
                  value={route}
                  onChange={(e) => setRoute(e.target.value)}
                >
                  {unavailable && (
                    <option value={route}>Saved scene unavailable</option>
                  )}
                  {routes.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                  {file && <option value="local">{file.name}</option>}
                </select>
              </label>
              <label>
                Video quality
                <select
                  aria-label="Video quality"
                  value={adaptive.choice}
                  disabled={adaptive.qualities.length < 2}
                  onChange={(e) =>
                    adaptive.selectQuality(Number(e.target.value))
                  }
                >
                  <option value={-1}>
                    Automatic{adaptive.active ? ` · ${adaptive.active}` : ""}
                  </option>
                  {adaptive.qualities.map((q) => (
                    <option key={q.index} value={q.index}>
                      {qualityLabel(q)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Video reference speed (km/h)
                <input
                  type="number"
                  inputMode="decimal"
                  min="0.1"
                  max="100"
                  step="0.1"
                  value={reference}
                  onChange={(e) => {
                    const n = Number(e.target.value);
                    setReference(n);
                    if (n > 0 && Number.isFinite(n))
                      try {
                        localStorage.setItem(
                          "native-video-reference:" + route,
                          String(n),
                        );
                      } catch {}
                  }}
                />
              </label>
            </div>
            <p className="video-explanation">
              {route === "local" || src?.startsWith("blob:")
                ? "Your file stays on this device and is not uploaded."
                : `${sceneDuration(selected)} ${selected.format === "route" ? "nature route" : "scenic loop"}. Playback repeats if your session outlasts the recording.`}{" "}
              {nasVideo &&
                `Playback starts at ${selected.skipSeconds ?? 30}s on each loop, with a gentle fade at both ends. `}
              Reference speed is an estimate; adjust it to match the footage.
              Video speed follows device speed continuously between 0.1× and 4×.
            </p>
            <div className="scenic-controls">
              <button
                disabled={
                  !ready || !Number.isFinite(reference) || reference <= 0
                }
                aria-pressed={following}
                onClick={follow}
              >
                {following ? "Pause video sync" : "Follow device"}
              </button>
            </div>
            <div className="video-footer">
              <label className="button">
                Choose local video
                <input
                  hidden
                  type="file"
                  accept="video/*"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    setRoute(mediaServer.choosePhoneVideo(f, kind));
                    e.target.value = "";
                  }}
                />
              </label>
              <button
                onClick={() => {
                  setReady(false);
                  setFollowing(true);
                  setError("");
                  video.current?.load();
                }}
              >
                Reload video
              </button>
              {route !== "local" && !src?.startsWith("blob:") && (
                <small>
                  Footage:{" "}
                  <a href={selected.source} target="_blank" rel="noreferrer">
                    {selected.author}
                  </a>{" "}
                  {selected.source.startsWith("https://www.pexels.com/") && (
                    <>
                      ·{" "}
                      <a
                        href="https://www.pexels.com/license/"
                        target="_blank"
                        rel="noreferrer"
                      >
                        Licence
                      </a>
                    </>
                  )}
                </small>
              )}
            </div>
          </details>
        </>
      )}
    </section>
  );
}
