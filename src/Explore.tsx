import { useEffect, useRef, useState } from "react";
import { Pagination, usePageSize } from "./Pagination";
import { AppIcon } from "./AppIcon";
import type { VideoRoute } from "./videoRoutes";
import { useVideoRoutes } from "./VideoCatalog";
import { sceneDuration } from "./catalog";
import type { Kind } from "./store";
export type ActivityFilter = "All" | Kind;
export function ActivityChips({
  value,
  onChange,
  includeAll = true,
}: {
  includeAll?: boolean;
  value: ActivityFilter;
  onChange: (value: ActivityFilter) => void;
}) {
  return (
    <div
      className="activity-chips"
      role="group"
      aria-label="Filter by equipment"
    >
      {(["All", "Treadmill", "Bike", "Rower"] as const)
        .filter((kind) => includeAll || kind !== "All")
        .map((kind) => (
          <button
            key={kind}
            aria-label={kind === "All" ? "All activities" : kind}
            aria-pressed={value === kind}
            onClick={() => onChange(kind)}
          >
            {kind !== "All" && <AppIcon name={kind} size={19} />}
            <span>{kind === "All" ? "All" : kind}</span>
          </button>
        ))}
    </div>
  );
}
export function RouteCard({
  route,
  onPreview,
}: {
  route: VideoRoute;
  onPreview: (route: VideoRoute) => void;
}) {
  return (
    <article className="route-card">
      <button
        onClick={() => onPreview(route)}
        className="route-photo"
        aria-label={"Preview " + route.name}
        style={{ backgroundImage: `url(${route.poster})` }}
      >
        <span className="route-kind">
          <AppIcon name={route.kind} size={17} />
          {route.kind}
        </span>
        <span className="route-play">
          <AppIcon name="play" size={21} />
        </span>
        <span className="route-length">
          {sceneDuration(route)} {route.format === "route" ? "route" : "loop"}
        </span>
      </button>
      <div className="route-details">
        <small>
          {route.kind} ·{" "}
          {route.format === "route" ? "Nature route" : "Scenic loop"}
        </small>
        <h3>{route.name.replace(" · scenic loop", "")}</h3>
        <p>
          {route.format === "route" ? "Continuous footage" : "Scenic loop"} ·
          moves at your pace
        </p>
      </div>
    </article>
  );
}
export function Explore({
  filter,
  onFilter,
  onPreview,
}: {
  filter: ActivityFilter;
  onFilter: (v: ActivityFilter) => void;
  onPreview: (r: VideoRoute) => void;
}) {
  const videoRoutes = useVideoRoutes();
  const size = usePageSize();
  const pageSize = window.innerWidth <= 700 ? size + 1 : size;
  const [page, setPage] = useState(0);
  const category = filter === "All" ? "Treadmill" : filter;
  const scenes = videoRoutes.filter((r) => r.kind === category);
  useEffect(() => setPage(0), [filter, pageSize, videoRoutes.length]);
  return (
    <section className="explore-screen">
      <div className="screen-heading">
        <div>
          <p className="eyebrow">THE SCENERY COLLECTION</p>
          <h1>Choose your elsewhere.</h1>
          <p>A woodland path. An autumn ride. A river with no hurry.</p>
        </div>
        <span className="inventory-count">{scenes.length} scenes</span>
      </div>
      <ActivityChips value={category} onChange={onFilter} includeAll={false} />
      <div className="routes-grid">
        {scenes.slice(page * pageSize, (page + 1) * pageSize).map((route) => (
          <RouteCard key={route.id} route={route} onPreview={onPreview} />
        ))}
      </div>
      {scenes.length > pageSize && (
        <Pagination
          page={page}
          size={pageSize}
          count={scenes.length}
          onChange={setPage}
          label="Scenery pages"
        />
      )}
    </section>
  );
}
export function RoutePreview({
  route,
  onClose,
  onTrain,
}: {
  route: VideoRoute;
  onClose: () => void;
  onTrain: () => void;
}) {
  const dialog = useRef<HTMLElement>(null),
    video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    document.body.classList.add("previewing");
    const saved: { element: HTMLElement; inert: boolean }[] = [];
    let element: HTMLElement | null = dialog.current;
    while (element && element !== document.body) {
      for (const sibling of Array.from(element.parentElement?.children ?? [])) {
        if (sibling !== element && sibling instanceof HTMLElement) {
          saved.push({ element: sibling, inert: sibling.inert });
          sibling.inert = true;
        }
      }
      element = element.parentElement;
    }
    dialog.current?.focus();
    const media = video.current;
    return () => {
      media?.pause();
      media?.removeAttribute("src");
      media?.load();
      document.body.classList.remove("previewing");
      saved.forEach(({ element, inert }) => (element.inert = inert));
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="route-preview-backdrop">
      <section
        className="route-preview"
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-label="Scenery preview"
        tabIndex={-1}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            const elements = Array.from(
              dialog.current?.querySelectorAll<HTMLElement>("button,a,video") ??
                [],
            );
            const first = elements[0],
              last = elements[elements.length - 1];
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
        }}
      >
        <div className="preview-heading">
          <span>
            <AppIcon name={route.kind} size={21} />
            {route.kind} scenery
          </span>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close scenery preview"
          >
            <AppIcon name="close" />
          </button>
        </div>
        <video
          ref={video}
          src={route.src}
          poster={route.poster}
          muted
          playsInline
          controls
          loop
          preload="metadata"
        />
        <div className="preview-info">
          <small>
            {sceneDuration(route)} ·{" "}
            {route.format === "route" ? "NATURE ROUTE" : "SCENIC LOOP"}
          </small>
          <h2>{route.name.replace(" · scenic loop", "")}</h2>
          <p>
            Connect your {route.kind.toLowerCase()} to match video playback to
            your speed.{" "}
            {route.format === "route"
              ? "Continuous footage, repeated if your session outlasts the recording."
              : "This is a short scenic loop, not a full-length route."}
          </p>
          <a href={route.source} target="_blank" rel="noreferrer">
            Footage by {route.author}
          </a>
          <button className="primary" onClick={onTrain}>
            Use this scene
            <AppIcon name="Train" size={19} />
          </button>
        </div>
      </section>
    </div>
  );
}
