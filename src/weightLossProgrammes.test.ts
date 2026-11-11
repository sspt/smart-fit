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
              kind === "Treadmill"
                ? {
                    kind,
                    minutes,
                    level,
                    minSpeed: 3,
                    maxSpeed: comfortable,
                    maxIncline: 2,
                  }
                : { kind, minutes, level, comfortable },
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
          if (kind === "Treadmill") {
            expect(
              p.blocks.every(
                (b) =>
                  b.speed >= 3 &&
                  b.speed <= comfortable &&
                  b.incline >= 0 &&
                  b.incline <= 2,
              ),
            ).toBe(true);
            expect(p.blocks.some((b) => b.incline > 0)).toBe(true);
            expect(p.blocks[0].incline).toBe(0);
            expect(p.blocks.at(-1)?.incline).toBe(0);
          } else expect(p.blocks.every((b) => b.incline === 0)).toBe(true);
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
          {
            kind: "Treadmill",
            minutes: 20,
            level: "starting",
            minSpeed: 1,
            maxSpeed: comfortable,
            maxIncline: 2,
          },
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

describe("treadmill speed and incline limits", () => {
  const options = {
    kind: "Treadmill",
    minutes: 30,
    level: "active",
    minSpeed: 3,
    maxSpeed: 5,
    maxIncline: 4,
  } as const;
  it("alternates faster flat walking and slower hills, with flat recovery", () => {
    const p = weightLossProgramme(options, "test"),
      hills = p.blocks.filter((b) => b.incline > 0),
      flatWork = p.blocks.filter((b) => b.name === "Brisk flat walk");
    expect(hills.length).toBeGreaterThan(0);
    expect(hills.every((b) => b.speed === 4 && b.incline === 4)).toBe(true);
    expect(flatWork.every((b) => b.speed === 5 && b.incline === 0)).toBe(true);
    expect(
      p.blocks
        .filter((b) => /Warm up|Cool down|Easy recovery/.test(b.name))
        .every((b) => b.speed === 3 && b.incline === 0),
    ).toBe(true);
  });
  it.each([0, 0.5, 2, 15])(
    "respects a %s%% incline cap at both activity levels",
    (maxIncline) => {
      for (const level of ["starting", "active"] as const) {
        const p = weightLossProgramme(
          { ...options, maxIncline, level },
          "test",
        );
        expect(
          p.blocks.every(
            (b) =>
              b.incline >= 0 &&
              b.incline <= maxIncline &&
              Number.isInteger(b.incline * 2),
          ),
        ).toBe(true);
        if (maxIncline === 0)
          expect(p.blocks.every((b) => b.incline === 0)).toBe(true);
      }
    },
  );
  it("keeps hills below maximum speed even with a 0.1 km/h range", () => {
    const p = weightLossProgramme(
      { ...options, minSpeed: 3, maxSpeed: 3.1 },
      "test",
    );
    expect(
      p.blocks.filter((b) => b.incline > 0).every((b) => b.speed === 3),
    ).toBe(true);
  });
  it("supports a fixed speed when minimum and maximum match", () => {
    const p = weightLossProgramme(
      { ...options, minSpeed: 4, maxSpeed: 4 },
      "test",
    );
    expect(p.blocks.every((b) => b.speed === 4)).toBe(true);
  });
  it.each([
    { minSpeed: 6 },
    { minSpeed: NaN },
    { minSpeed: 0 },
    { minSpeed: 3.25 },
    { maxSpeed: Infinity },
    { maxSpeed: 4.25 },
    { maxIncline: NaN },
    { maxIncline: -1 },
    { maxIncline: 16 },
    { maxIncline: 0.25 },
  ])("rejects invalid bounds %j", (patch) => {
    expect(() =>
      weightLossProgramme({ ...options, ...patch }, "test"),
    ).toThrow();
  });
});
