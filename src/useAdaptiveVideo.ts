import { useEffect, useRef, useState, type RefObject } from "react";
import type Hls from "hls.js";
export type Quality = { index: number; width: number; height: number };
export const qualityLabel = (q: { width: number; height: number }) => {
  const short = Math.min(q.width, q.height);
  return `${short}p${short >= 2160 ? " · 4K" : ""}`;
};
export function useAdaptiveVideo(
  video: RefObject<HTMLVideoElement>,
  mp4: string | undefined,
  manifest: string | undefined,
  onReset: () => void,
  withCredentials = false,
) {
  const instance = useRef<Hls | null>(null);
  const reset = useRef(onReset);
  reset.current = onReset;
  const [qualities, setQualities] = useState<Quality[]>([]),
    [choice, setChoice] = useState(-1),
    [active, setActive] = useState(""),
    [transport, setTransport] = useState<"mp4" | "hls">("mp4");
  useEffect(() => {
    const element = video.current;
    let disposed = false,
      fallbackUsed = false;
    setQualities([]);
    setChoice(-1);
    setActive("");
    setTransport("mp4");
    if (!element || !mp4) return;
    // Progressive video needs no CORS permission unless credentials are requested.
    // HLS uses JavaScript requests and still requires server CORS headers.
    if (withCredentials || manifest)
      element.crossOrigin = withCredentials ? "use-credentials" : "anonymous";
    else element.removeAttribute("crossorigin");
    const fallback = () => {
      if (disposed || fallbackUsed) return;
      fallbackUsed = true;
      reset.current();
      instance.current?.destroy();
      instance.current = null;
      setQualities([]);
      setChoice(-1);
      setTransport("mp4");
      element.src = mp4;
      element.load();
    };
    const resized = () => {
      if (element.videoWidth && element.videoHeight)
        setActive(
          qualityLabel({
            width: element.videoWidth,
            height: element.videoHeight,
          }),
        );
    };
    element.addEventListener("resize", resized);
    element.addEventListener("loadedmetadata", resized);
    void (async () => {
      if (!manifest) {
        fallback();
        return;
      }
      try {
        const { default: Hls } = await import("hls.js");
        if (disposed) return;
        if (Hls.isSupported()) {
          reset.current();
          const player = new Hls({
            xhrSetup: (xhr) => {
              xhr.withCredentials = withCredentials;
            },
            capLevelToPlayerSize: true,
            capLevelOnFPSDrop: true,
            maxBufferLength: 40,
            maxMaxBufferLength: 120,
            backBufferLength: 12,
            maxBufferSize: 48 * 1024 * 1024,
            abrEwmaDefaultEstimate: 2_000_000,
          });
          instance.current = player;
          player.on(Hls.Events.MANIFEST_PARSED, () => {
            if (disposed) return;
            setQualities(
              player.levels.map((level, index) => ({
                index,
                width: level.width,
                height: level.height,
              })),
            );
            setTransport("hls");
          });
          player.on(Hls.Events.ERROR, (_event, data) => {
            if (data.fatal) fallback();
          });
          player.loadSource(manifest);
          player.attachMedia(element);
        } else if (element.canPlayType("application/vnd.apple.mpegurl")) {
          reset.current();
          element.addEventListener("error", fallback);
          element.src = manifest;
          setTransport("hls");
        } else fallback();
      } catch {
        fallback();
      }
    })();
    return () => {
      disposed = true;
      instance.current?.destroy();
      instance.current = null;
      element.removeEventListener("resize", resized);
      element.removeEventListener("loadedmetadata", resized);
      element.removeEventListener("error", fallback);
      element.pause();
      element.removeAttribute("src");
      element.load();
    };
  }, [video, mp4, manifest, withCredentials]);
  return {
    qualities,
    choice,
    active,
    transport,
    selectQuality(index: number) {
      if (
        instance.current &&
        (index === -1 || qualities.some((q) => q.index === index))
      ) {
        instance.current.currentLevel = index;
        setChoice(index);
      }
    },
  };
}
