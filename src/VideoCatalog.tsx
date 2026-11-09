import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Kind } from "./store";
import {
  videoRoutes as starters,
  defaultVideoRoutes,
  type VideoRoute,
} from "./videoRoutes";
const videoRoutes = [...defaultVideoRoutes, ...starters];
import { parseVideoInfo } from "./videoInfo";
import { parseCatalog } from "./catalog";
import { load, save } from "./store";
import {
  defaultMediaServer,
  normaliseMediaServer,
  serverScenes,
  type MediaServerConfig,
} from "./mediaServer";
type CatalogState = {
  routes: VideoRoute[];
  config: MediaServerConfig;
  loading: boolean;
  error: string;
  count: number;
  choosePhoneVideo: (file: File, kind: Kind) => string;
  configure: (config: MediaServerConfig) => Promise<void>;
};
const Catalog = createContext<CatalogState>({
  routes: videoRoutes,
  config: defaultMediaServer,
  loading: false,
  error: "",
  count: 0,
  choosePhoneVideo: () => "",
  configure: async () => {},
});
export const useVideoRoutes = () => useContext(Catalog).routes;
export const useMediaServer = () => useContext(Catalog);
export function VideoCatalogProvider({ children }: { children: ReactNode }) {
  const [routes, setRoutes] = useState(videoRoutes),
    [config, setConfig] = useState(defaultMediaServer),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [count, setCount] = useState(0);
  const [infoRoutes, setInfoRoutes] = useState<VideoRoute[] | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/video-info", {
      signal: controller.signal,
      cache: "no-cache",
    })
      .then(async (response) => {
        if (!response.ok) throw Error("Video info unavailable");
        return parseVideoInfo(await response.json());
      })
      .then(setInfoRoutes)
      .catch(() => {
        /* Keep the working default library if the catalogue is unavailable. */
      });
    return () => controller.abort();
  }, []);
  const library =
    infoRoutes === null
      ? routes
      : [
          ...infoRoutes,
          ...routes.filter(
            (r) => !defaultVideoRoutes.some((d) => d.id === r.id),
          ),
        ];
  const [phoneVideo, setPhoneVideo] = useState<VideoRoute | null>(null);
  useEffect(
    () => () => {
      if (phoneVideo) URL.revokeObjectURL(phoneVideo.src);
    },
    [phoneVideo?.src],
  );
  const sequence = useRef(0),
    pending = useRef<AbortController | null>(null);
  const localDevelopment =
    location.hostname === "localhost" || location.hostname === "127.0.0.1";
  async function request(next: MediaServerConfig, persist: boolean) {
    const token = ++sequence.current;
    pending.current?.abort();
    const controller = new AbortController();
    pending.current = controller;
    const timer = setTimeout(() => controller.abort(), 15000);
    setLoading(true);
    setError("");
    try {
      const response = await fetch(
        next.baseUrl ? next.baseUrl + "/catalog.json" : "/media/catalog.json",
        {
          signal: controller.signal,
          credentials: next.credentials ? "include" : "omit",
        },
      );
      let scenes: VideoRoute[] = [];
      if (!response.ok) {
        if (next.baseUrl || response.status !== 404)
          throw Error(
            "Video catalogue is not accessible. Check the HTTPS URL, login and CORS settings.",
          );
      } else {
        if (response.headers.get("Content-Type")?.includes("text/html"))
          throw Error(
            "The server returned a web page instead of catalog.json. Check the media folder URL or sign in first.",
          );
        scenes = parseCatalog(await response.json());
      }
      if (token !== sequence.current) return;
      const ids = new Set(videoRoutes.map((r) => r.id));
      setRoutes([
        ...serverScenes(
          scenes.filter((r) => !ids.has(r.id)),
          next,
        ),
        ...videoRoutes,
      ]);
      setCount(scenes.length);
      setConfig(next);
      if (persist) await save("mediaServer", next);
    } catch (e) {
      if (token !== sequence.current) return;
      const message =
        e instanceof Error && e.name !== "AbortError"
          ? e.message
          : "Video server did not respond. Check its URL and connection.";
      if (next.baseUrl || persist) setError(message);
      if (persist) throw Error(message);
    } finally {
      clearTimeout(timer);
      if (token === sequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    let disposed = false;
    void load<MediaServerConfig>("mediaServer", defaultMediaServer)
      .then((raw) => {
        if (disposed) return;
        let next = defaultMediaServer;
        try {
          next = normaliseMediaServer(raw, localDevelopment);
        } catch {}
        setConfig(next);
        return request(next, false);
      })
      .catch(() => {
        if (!disposed) void request(defaultMediaServer, false);
      });
    return () => {
      disposed = true;
      sequence.current++;
      pending.current?.abort();
    };
  }, []);
  return (
    <Catalog.Provider
      value={{
        routes: phoneVideo ? [phoneVideo, ...library] : library,
        choosePhoneVideo: (file, kind) => {
          const id = "phone-video-" + crypto.randomUUID();
          setPhoneVideo({
            id,
            name: file.name,
            kind,
            reference: 5,
            seconds: 1,
            format: "route",
            src: URL.createObjectURL(file),
            poster: "",
            author: "",
            source: "",
          });
          return id;
        },
        config,
        loading,
        error,
        count,
        configure: (next) =>
          request(normaliseMediaServer(next, localDevelopment), true),
      }}
    >
      {children}
    </Catalog.Provider>
  );
}
