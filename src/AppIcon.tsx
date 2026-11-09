export function AppIcon({ name, size = 24 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    clock: "M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0M12 6v6l4 2",
    Explore: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20m4-16-2 8-8 2 2-8z",
    search: "M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15m5.5-2 5 5",
    Train: "M5 19V5h14M5 19l5-7 4 3 5-10",
    Devices: "m10 3 8 6-12 9 4 3V3l8 12-12-6",
    Live: "M3 12h4l3-7 4 14 3-7h4",
    History: "M4 7V3m0 4h4M4 7a9 9 0 1 1-1 8M12 7v5l3 2",
    Settings: "M4 7h16M4 17h16M8 4v6m8 4v6",
    Treadmill: "M5 19h14M7 16l6-7 4 1 2-5M11 5h2M5 10l4-2 3 2",
    Bike: "M8 17a4 4 0 1 1-8 0 4 4 0 0 1 8 0m16 0a4 4 0 1 1-8 0 4 4 0 0 1 8 0M4 17l6-9 6 9H4m6-9h7l3 9M8 5h4",
    Rower: "M3 19h18M5 15h8l4-3M10 5h1M8 9l4 2 4-4M12 11l-2 5M4 5l16 13",
    plus: "M12 5v14M5 12h14",
    close: "m6 6 12 12M18 6 6 18",
    up: "m6 15 6-6 6 6",
    down: "m6 9 6 6 6-6",
    copy: "M8 8h12v12H8zM4 16V4h12",
    trash: "M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
    check: "m5 12 4 4L19 6",
    play: "m9 5 11 7-11 7z",
    refresh: "M20 7V3m0 4h-4M20 7a9 9 0 1 0 1 8",
    back: "m14 6-6 6 6 6",
    arrow: "M6 18 18 6M6 6h12v12",
    pause: "M8 5v14M16 5v14",
    Home: "m3 10 9-7 9 7M5 9v12h14V9M9 21v-8h6v8",
  };
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={paths[name] ?? paths.Train} />
    </svg>
  );
}
