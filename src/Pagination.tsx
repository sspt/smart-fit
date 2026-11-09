import { useEffect, useState } from "react";
/** Content size follows available space; overflow remains accessible at high zoom. */
export function usePageSize() {
  const size = () =>
    window.innerWidth >= 1050
      ? window.innerHeight >= 760
        ? 6
        : 3
      : window.innerWidth >= 701
        ? 4
        : window.innerHeight >= 760
          ? 3
          : 2;
  const [count, setCount] = useState(size);
  useEffect(() => {
    const change = () => setCount(size());
    window.addEventListener("resize", change);
    return () => window.removeEventListener("resize", change);
  }, []);
  return count;
}
export function Pagination({
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
  const pages = Math.max(1, Math.ceil(count / size));
  return (
    <div className="pagination" role="group" aria-label={label}>
      <button
        disabled={page === 0}
        onClick={() => onChange(page - 1)}
        aria-label={`Previous ${label.toLowerCase()}`}
      >
        ‹
      </button>
      <span aria-live="polite">
        {count === 0
          ? "No items"
          : `${page * size + 1}–${Math.min((page + 1) * size, count)} of ${count}`}
      </span>
      <button
        disabled={page >= pages - 1}
        onClick={() => onChange(page + 1)}
        aria-label={`Next ${label.toLowerCase()}`}
      >
        ›
      </button>
    </div>
  );
}
