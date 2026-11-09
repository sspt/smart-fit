import { describe, it, expect } from "vitest";
import { defaultProgrammes, installDefaults } from "../src/defaultProgrammes";
describe("complete default workouts", () => {
  it("offers exactly 15, 30 and 45 minutes for each machine", () => {
    expect(new Set(defaultProgrammes.map((p) => p.id)).size).toBe(9);
    for (const kind of ["Treadmill", "Bike", "Rower"]) {
      const programmes = defaultProgrammes.filter((p) => p.kind === kind);
      expect(
        programmes.map(
          (p) => p.blocks.reduce((n, b) => n + b.duration, 0) * p.repeat,
        ),
      ).toEqual([900, 1800, 2700]);
      for (const p of programmes) {
        expect(p.repeat).toBe(1);
        expect(p.blocks[0].name).toBe("Warm up");
        expect(p.blocks.at(-1)?.name).toBe("Cool down");
        expect(p.blocks.filter((b) => b.name === "Warm up")).toHaveLength(1);
        expect(p.blocks.filter((b) => b.name === "Cool down")).toHaveLength(1);
        expect(p.blocks.every((b) => b.duration > 0 && !b.distance)).toBe(true);
      }
    }
  });
  it("uses modest equipment-specific targets and recovery between intervals", () => {
    for (const p of defaultProgrammes) {
      const key =
        p.kind === "Treadmill"
          ? "speed"
          : p.kind === "Bike"
            ? "power"
            : "resistance";
      const targets = p.blocks.map((b) => b[key]);
      expect(targets[0]).toBeLessThan(Math.max(...targets));
      expect(targets.at(-1)).toBeLessThan(Math.max(...targets));
      if (p.name.startsWith("30")) {
        for (let i = 1; i < 9; i += 2)
          expect(targets[i + 1]).toBeLessThan(targets[i]);
      }
      expect(Math.max(...targets)).toBeLessThanOrEqual(
        p.kind === "Treadmill" ? 5.5 : p.kind === "Bike" ? 110 : 4,
      );
    }
  });
  it("preserves custom programmes and edited defaults without mutating saved data", () => {
    const custom = {
      ...structuredClone(defaultProgrammes[0]),
      id: "custom",
      name: "My personal walk",
    };
    const edited = {
      ...structuredClone(defaultProgrammes[1]),
      name: "My adjusted intervals",
    };
    const before = structuredClone([custom, edited]);
    const result = installDefaults([custom, edited]);
    expect(result).toHaveLength(10);
    expect(result.find((p) => p.id === edited.id)).toEqual(edited);
    expect(result.find((p) => p.id === "custom")).toEqual(custom);
    expect([custom, edited]).toEqual(before);
  });
  it("replaces only unchanged legacy examples", () => {
    const b = (name: string, duration: number, speed: number) => ({
      name,
      duration,
      speed,
      incline: 0,
      resistance: 3,
      power: 100,
    });
    const old = {
      id: "walk",
      name: "Easy morning walk",
      kind: "Treadmill" as const,
      repeat: 1,
      blocks: [
        b("Warm up", 180, 3),
        b("Find your rhythm", 600, 5),
        b("Cool down", 180, 3),
      ],
    };
    expect(installDefaults([old]).map((p) => p.id)).not.toContain("walk");
    expect(
      installDefaults([{ ...old, name: "My edited walk" }]).map((p) => p.id),
    ).toContain("walk");
  });
});
