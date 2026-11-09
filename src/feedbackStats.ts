import type { Session } from "./store";
export const finite = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);
export function sessionStats(s: Session) {
  const seconds = finite(s.elapsed) ? Math.max(0, s.elapsed) : 0;
  const distance = finite(s.distance) ? Math.max(0, s.distance) : null;
  const key = s.programme.kind === "Bike" ? "power" : "speed";
  const values = s.samples.map((x) => x[key]).filter(finite);
  return {
    seconds,
    distance,
    average: values.length
      ? values.reduce((a, b) => a + b, 0) / values.length
      : null,
    key,
  };
}
export function previousAttempt(s: Session, history: Session[]) {
  // Compare only the same programme revision and real/demo category.
  return history
    .filter(
      (x) =>
        x.id !== s.id &&
        x.started < s.started &&
        x.status === "completed" &&
        x.demo === s.demo &&
        JSON.stringify(x.programme) === JSON.stringify(s.programme),
    )
    .sort((a, b) => b.started - a.started)[0];
}
export function weeklyStats(history: Session[], now = new Date()) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const sessions = history.filter(
    (s) =>
      !s.demo && s.started >= start.getTime() && s.started <= now.getTime(),
  );
  return {
    count: sessions.length,
    minutes: Math.floor(
      sessions.reduce((n, s) => n + sessionStats(s).seconds, 0) / 60,
    ),
  };
}
export function intervalCue(s: Session | null, running: boolean, units = "km") {
  if (!s || !running || s.controlMode === "follow") return "";
  const block = s.programme.blocks[s.phase ?? 0];
  if (!block) return "";
  const remaining = block.distance
    ? block.distance - (s.phaseDistance ?? 0)
    : block.duration - (s.phaseElapsed ?? 0);
  if (remaining <= 0 || remaining > (block.distance ? 20 : 10)) return "";
  let index = (s.phase ?? 0) + 1,
    cycle = s.cycle ?? 0;
  if (index >= s.programme.blocks.length) {
    index = 0;
    cycle++;
  }
  const next = cycle < s.programme.repeat ? s.programme.blocks[index] : null;
  const when = block.distance
    ? `${Math.ceil(remaining)} m`
    : `${Math.ceil(remaining)}s`;
  if (!next) return `Finish in ${when}`;
  const target =
    s.programme.kind === "Treadmill"
      ? `${(next.speed * (units === "mi" ? 0.621371 : 1)).toFixed(1)} ${units}/h · ${next.incline}% incline`
      : s.programme.kind === "Bike"
        ? `${next.power} W`
        : `Resistance ${next.resistance}`;
  return `Next: ${next.name} · ${target} in ${when}`;
}
