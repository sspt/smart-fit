import { describe, it, expect } from "vitest";
import {
  intervalCue,
  weeklyStats,
  previousAttempt,
  sessionStats,
} from "./feedbackStats";
import type { Session } from "./store";
const block = (name: string, duration: number) => ({
  name,
  duration,
  speed: 5,
  incline: 0,
  resistance: 3,
  power: 100,
});
const session = (extra: Partial<Session> = {}): Session => ({
  id: "a",
  started: 100,
  elapsed: 60,
  status: "completed",
  demo: false,
  programme: {
    id: "p",
    name: "Test",
    kind: "Treadmill",
    repeat: 1,
    blocks: [block("Warm", 30), block("Steady", 30)],
  },
  samples: [],
  events: [],
  ...extra,
});
describe("workout feedback", () => {
  it("cues upcoming intervals and completion, suppressing paused/follow sessions", () => {
    const s = session({ phaseElapsed: 21 });
    expect(intervalCue(s, true)).toContain("Next: Steady");
    expect(intervalCue(s, false)).toBe("");
    expect(intervalCue({ ...s, controlMode: "follow" }, true)).toBe("");
    expect(intervalCue({ ...s, phase: 1 }, true)).toBe("Finish in 9s");
  });
  it("counts local Monday week, excludes demos and future records", () => {
    const now = new Date(2026, 10, 11, 12);
    const start = new Date(2026, 10, 9).getTime();
    expect(
      weeklyStats(
        [
          session({ started: start, elapsed: 180 }),
          session({ started: start - 1 }),
          session({ started: start, demo: true }),
          session({ started: now.getTime() + 1 }),
        ],
        now,
      ),
    ).toEqual({ count: 1, minutes: 3 });
  });
  it("compares matching revisions and demo category only", () => {
    const s = session({ id: "new", started: 300 });
    const old = session({ started: 200 });
    expect(previousAttempt(s, [old])).toBe(old);
    expect(previousAttempt(s, [{ ...old, demo: true }])).toBeUndefined();
    expect(
      previousAttempt(s, [
        { ...old, programme: { ...old.programme, repeat: 2 } },
      ]),
    ).toBeUndefined();
  });
  it("does not invent unavailable readings", () => {
    expect(sessionStats(session()).distance).toBeNull();
    expect(sessionStats(session()).average).toBeNull();
  });
});
