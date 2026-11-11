import { describe, it, expect } from "vitest";
import {
  weightLossProgramme,
  weightLossLimits,
  type WeightLossOptions,
} from "./weightLossProgrammes";
import type { Kind } from "./store";
describe("tailored weight-loss sessions", () => {
  for (const kind of ["Treadmill", "Bike", "Rower"] as Kind[])
    for (const minutes of [15, 20, 30, 45] as const)
      for (const level of ["starting", "active"] as const) {
        it(`${kind} ${minutes} ${level} keeps the chosen duration and effort ceiling`, () => {
          const comfortable = weightLossLimits[kind].initial,
            p = weightLossProgramme(
              { kind, minutes, level, comfortable },
              "test",
            );
          expect(p.blocks.reduce((n, b) => n + b.duration, 0) * p.repeat).toBe(
            minutes * 60,
          );
          expect(p.blocks[0].name).toContain("Warm up");
          expect(p.blocks.at(-1)?.name).toContain("Cool down");
          const key =
            kind === "Treadmill"
              ? "speed"
              : kind === "Bike"
                ? "power"
                : "resistance";
          expect(
            p.blocks.every(
              (b) =>
                b.duration >= 5 &&
                b[key] <= comfortable &&
                b[key] >= weightLossLimits[kind].min,
            ),
          ).toBe(true);
          expect(p.blocks.every((b) => b.incline === 0)).toBe(true);
          if (level === "starting") expect(p.blocks).toHaveLength(3);
          else
            expect(p.blocks.some((b) => b.name === "Easy recovery")).toBe(true);
          expect(p.kind).toBe(kind);
          expect(p.id).toBe("test");
        });
      }
  it("uses the supplied target rather than generic catalogue intensity", () => {
    const p = weightLossProgramme(
      { kind: "Bike", minutes: 30, level: "active", comfortable: 85 },
      "test",
    );
    expect(Math.max(...p.blocks.map((b) => b.power))).toBe(85);
  });
  it.each([NaN, Infinity, 0, 9])(
    "rejects invalid walking target %s",
    (comfortable) => {
      expect(() =>
        weightLossProgramme(
          { kind: "Treadmill", minutes: 20, level: "starting", comfortable },
          "test",
        ),
      ).toThrow();
    },
  );
  it("rejects unsupported duration, machine and fractional resistance", () => {
    for (const patch of [
      { kind: "Other" },
      { minutes: 1 },
      { level: "hard" },
      { kind: "Rower", comfortable: 2.5 },
    ])
      expect(() =>
        weightLossProgramme(
          {
            ...{
              kind: "Bike",
              minutes: 20,
              level: "starting",
              comfortable: 60,
            },
            ...patch,
          } as WeightLossOptions,
          "test",
        ),
      ).toThrow();
  });
});
