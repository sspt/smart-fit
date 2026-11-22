import { t } from "./i18n";
import { useEffect, useRef, useState } from "react";
/** Content size follows available space; overflow remains accessible at high zoom. */
export function usePageSize(scenery = false) {
  const size = () =>
    window.innerWidth >= 1050
      ? window.innerHeight >= 760
        ? scenery
          ? 9
          : 6
        : scenery
          ? 6
          : 3
      : window.innerWidth >= 701
        ? scenery
          ? 6
          : 4
        : window.innerHeight >= 760
          ? scenery
            ? 6
            : 3
          : scenery
            ? 5
            : 2;
  const [count, setCount] = useState(size);
  useEffect(() => {
    const change = () => setCount(size());
    change();
    window.addEventListener("resize", change);
    return () => window.removeEventListener("resize", change);
  }, [scenery]);
  return count;
}
export function InfiniteScroll({
  page,
  count,
  size,
  onChange,
  label,
}: {
  page: number;
  count: number;
  size: number;
  onChange: (page: number) => void;
  label: string;
}) {
  const sentinel = useRef<HTMLDivElement>(null);
  const more = (page + 1) * size < count;
  useEffect(() => {
    const element = sentinel.current;
    if (!more || !element || typeof IntersectionObserver === "undefined")
      return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          onChange(page + 1);
        }
      },
      { root: element.closest(".list-scroll"), rootMargin: "0px 0px 240px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [more, page, onChange]);
  if (!more) return null;
  return (
    <div className="list-sentinel" ref={sentinel}>
      {typeof IntersectionObserver === "undefined" && (
        <button
          type="button"
          onClick={() => onChange(page + 1)}
          aria-label={label}
        >
          {t("Load more")}
        </button>
      )}
    </div>
  );
}
