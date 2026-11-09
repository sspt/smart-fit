import type { Session, Segment } from "./store";
export function currentSegment(s: Session) {
  const index = s.phase ?? 0,
    cycle = s.cycle ?? 0;
  if (cycle >= s.programme.repeat) return null;
  const b = s.programme.blocks[index];
  if (!b) return null;
  const progress = b.distance
    ? (s.phaseDistance ?? 0) / b.distance
    : (s.phaseElapsed ?? 0) / b.duration;
  return {
    block: b,
    index,
    cycle,
    progress: Math.min(1, progress),
    remaining: b.distance
      ? Math.max(0, b.distance - (s.phaseDistance ?? 0))
      : Math.max(0, b.duration - (s.phaseElapsed ?? 0)),
  };
}
export function advance(s: Session, seconds: number, metres: number): Session {
  if (!Number.isFinite(seconds) || seconds < 0 || seconds > 3) return s;
  const current = currentSegment(s);
  if (!current) return s;
  let phase = s.phase ?? 0,
    cycle = s.cycle ?? 0,
    phaseElapsed = (s.phaseElapsed ?? 0) + seconds,
    phaseDistance = (s.phaseDistance ?? 0) + Math.max(0, metres);
  if (
    current.block.distance
      ? phaseDistance >= current.block.distance
      : phaseElapsed >= current.block.duration
  ) {
    phase++;
    phaseElapsed = 0;
    phaseDistance = 0;
    if (phase >= s.programme.blocks.length) {
      phase = 0;
      cycle++;
    }
  }
  return {
    ...s,
    elapsed: s.elapsed + seconds,
    phase,
    cycle,
    phaseElapsed,
    phaseDistance,
    distance: (s.distance ?? 0) + Math.max(0, metres),
  };
}
export function targetAt(b: Segment, progress: number): Segment {
  if (!b.ramp) return b;
  const t = Math.max(0, Math.min(1, progress));
  return {
    ...b,
    speed: b.speed + ((b.endSpeed ?? b.speed) - b.speed) * t,
    incline: b.incline + ((b.endIncline ?? b.incline) - b.incline) * t,
    power: b.power + ((b.endPower ?? b.power) - b.power) * t,
    resistance: Math.round(
      b.resistance + ((b.endResistance ?? b.resistance) - b.resistance) * t,
    ),
  };
}
