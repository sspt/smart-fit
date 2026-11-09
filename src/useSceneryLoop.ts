import { useEffect, type RefObject } from "react";

export function sceneryWindow(
  duration: number,
  skipIntro: boolean,
  skipSeconds = 30,
) {
  // Short clips remain usable; never seek beyond their end.
  const start =
    skipIntro && Number.isFinite(duration) && duration > skipSeconds + 1
      ? skipSeconds
      : 0;
  return {
    start,
    fade: Number.isFinite(duration) ? Math.min(2, (duration - start) / 2) : 0,
  };
}
export function sceneryBrightness(
  time: number,
  duration: number,
  start: number,
  fade: number,
) {
  if (fade <= 0) return 1;
  return Math.max(
    0,
    Math.min(1, (time - start) / fade, (duration - time) / fade),
  );
}

export function useSceneryLoop(
  video: RefObject<HTMLVideoElement>,
  enabled: boolean,
  source: string | undefined,
  nas: boolean,
  skipSeconds = 30,
) {
  useEffect(() => {
    const el = video.current;
    if (!el || !enabled || !nas) return;
    let frame = 0;
    const update = () => {
      const { start, fade } = sceneryWindow(el.duration, true, skipSeconds);
      // The native loop keeps playback/rate and pause state intact. Clamp its
      // rewind to the scenic start before revealing any frames of the intro.
      const beforeStart = el.currentTime < start;
      el.style.filter = `brightness(${beforeStart || el.seeking ? 0 : sceneryBrightness(el.currentTime, el.duration, start, fade)})`;
      if (beforeStart && el.readyState >= 1 && !el.seeking) {
        try {
          el.currentTime = start;
        } catch {
          /* Retry once metadata/seekability is ready. */
        }
      }
    };
    const tick = () => {
      update();
      frame = requestAnimationFrame(tick);
    };
    el.style.filter = "brightness(0)";
    el.addEventListener("loadedmetadata", update);
    el.addEventListener("seeking", update);
    el.addEventListener("timeupdate", update);
    tick();
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("loadedmetadata", update);
      el.removeEventListener("seeking", update);
      el.removeEventListener("timeupdate", update);
      el.style.removeProperty("filter");
    };
  }, [video, enabled, source, nas, skipSeconds]);
}
