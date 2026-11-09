import { useEffect, useRef, useState } from "react";
import type { VideoRoute } from "./videoRoutes";
import { useSceneryLoop } from "./useSceneryLoop";
import { AppIcon } from "./AppIcon";
export function useImmersiveBackground(
  route: VideoRoute,
  poster: string,
  suspended: boolean,
) {
  const video = useRef<HTMLVideoElement>(null);
  const [motion, setMotion] = useState(false),
    [visible, setVisible] = useState(!document.hidden);
  useEffect(() => {
    const preference = matchMedia("(prefers-reduced-motion: reduce)");
    const update = () =>
      setMotion(
        !preference.matches && !(navigator as any).connection?.saveData,
      );
    const visibility = () => setVisible(!document.hidden);
    update();
    preference.addEventListener("change", update);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      preference.removeEventListener("change", update);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);
  const active = motion && visible && !suspended;
  // Unmounting during workouts avoids decoding two videos at once.
  useSceneryLoop(
    video,
    active,
    route.src,
    route.skipSeconds !== undefined || route.src.startsWith("https://"),
    route.skipSeconds ?? 30,
  );
  useEffect(() => {
    if (active) void video.current?.play().catch(() => {});
  }, [active, route.src]);
  return {
    background: (
      <div
        className="world-backdrop"
        aria-hidden="true"
        style={{ backgroundImage: `url(${poster})` }}
      >
        {active && (
          <video
            key={route.src}
            ref={video}
            className="world-film"
            src={route.src}
            muted
            autoPlay
            loop
            playsInline
            preload="metadata"
            tabIndex={-1}
          />
        )}
        <div className="world-shade" />
      </div>
    ),
    control: (
      <button
        className="background-motion"
        aria-label={
          motion ? "Pause background scenery" : "Play background scenery"
        }
        aria-pressed={motion}
        onClick={() => setMotion(!motion)}
        title={motion ? "Pause background scenery" : "Play background scenery"}
      >
        <AppIcon name={motion ? "pause" : "play"} size={15} />
        <span>Scene</span>
      </button>
    ),
  };
}
