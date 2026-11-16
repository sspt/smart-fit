import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyManualTarget,
  manualFields,
  normalizeManualTarget,
  knownWorkoutDistance,
} from "../src/manualWorkoutControl";
import { hasMetricValue, WorkoutReadings } from "../src/WorkoutReadings";
import { WorkoutAdjustments } from "../src/WorkoutAdjustments";
const fields = manualFields(
  "Bike",
  false,
  { power: true },
  { power: { min: 0, max: 400, increment: 5 } },
  { power: 0 },
);
function request(
  overrides: Partial<Parameters<typeof applyManualTarget>[0]> = {},
) {
  return {
    key: "power" as const,
    value: 123,
    fields,
    lock: { current: false },
    ready: () => true,
    hold: vi.fn(),
    acquire: vi.fn(async () => {}),
    valid: () => true,
    send: vi.fn(async () => {}),
    ack: vi.fn(),
    ...overrides,
  };
}
describe("manual workout commands", () => {
  it("honours hardware ranges and capability flags", () => {
    expect(fields[0].range.max).toBe(400);
    expect(manualFields("Bike", false, { power: false }, {}, {})).toEqual([]);
    expect(manualFields("Bike", true, null, {}, {})).toEqual([]);
    expect(
      manualFields(
        "Treadmill",
        true,
        null,
        {},
        {},
        { speed: true, incline: false },
      ).map((f) => f.key),
    ).toEqual(["speed"]);
    expect(
      manualFields(
        "Rower",
        true,
        null,
        {},
        {},
        { resistance: true },
        [1, 2, 3, 4],
      )[0].range.max,
    ).toBe(4);
    expect(
      manualFields(
        "Bike",
        false,
        { power: true },
        { power: { min: 0, max: 400, increment: 0 } },
        {},
      ),
    ).toEqual([]);
  });
  it("snaps targets and rejects invalid values before taking control", async () => {
    expect(normalizeManualTarget(123, fields[0].range)).toBe(125);
    for (const value of [-1, 401, NaN, Infinity]) {
      const r = request({ value });
      await expect(applyManualTarget(r)).rejects.toThrow("range");
      expect(r.hold).not.toHaveBeenCalled();
      expect(r.send).not.toHaveBeenCalled();
    }
  });
  it("holds automation before acquiring the controller, then sends exactly one command", async () => {
    const order: string[] = [];
    const r = request({
      hold: () => {
        order.push("hold");
      },
      acquire: async () => {
        order.push("acquire");
      },
      send: async (k, v) => {
        order.push(`${k}:${v}`);
      },
      ack: () => {
        order.push("ack");
      },
    });
    expect(await applyManualTarget(r)).toBe(125);
    expect(order).toEqual(["hold", "acquire", "power:125", "ack"]);
    expect(r.lock.current).toBe(false);
  });
  it("cancels without writing if paused, disconnected or superseded while acquiring", async () => {
    for (const gate of ["ready", "valid"] as const) {
      let allowed = true;
      const r = request({
        [gate]: () => allowed,
        acquire: async () => {
          allowed = false;
        },
      });
      await expect(applyManualTarget(r)).rejects.toThrow("cancelled");
      expect(r.send).not.toHaveBeenCalled();
      expect(r.lock.current).toBe(false);
    }
  });
  it("serializes applies and never acknowledges a rejected command", async () => {
    let release!: () => void;
    const r = request({
      acquire: () => new Promise<void>((resolve) => (release = resolve)),
      send: vi.fn(async () => {
        throw Error("Rejected by machine");
      }),
    });
    const first = applyManualTarget(r);
    await expect(applyManualTarget(r)).rejects.toThrow("Wait");
    release();
    await expect(first).rejects.toThrow("Rejected by machine");
    expect(r.send).toHaveBeenCalledTimes(1);
    expect(r.ack).not.toHaveBeenCalled();
    expect(r.lock.current).toBe(false);
  });
  it("does not acknowledge a session that changed during the command", async () => {
    let valid = true;
    const r = request({
      valid: () => valid,
      send: vi.fn(async () => {
        valid = false;
      }),
    });
    await expect(applyManualTarget(r)).rejects.toThrow("Session changed");
    expect(r.ack).not.toHaveBeenCalled();
  });
});
describe("unavailable readings", () => {
  it("distinguishes absent readings from valid zero", () => {
    for (const v of [null, undefined, "", "—", NaN, Infinity, false])
      expect(hasMetricValue(v)).toBe(false);
    for (const v of [0, "0", "0.0", 125]) expect(hasMetricValue(v)).toBe(true);
    expect(knownWorkoutDistance(0, null, null)).toBeNull();
    expect(knownWorkoutDistance(0, 0, null)).toBe(0);
    expect(knownWorkoutDistance(30, null, null)).toBe(30);
    const html = renderToStaticMarkup(
      <WorkoutReadings
        kind="Bike"
        speed={NaN}
        power={0}
        calories={Infinity}
        time="00:00"
      />,
    );
    expect(html).toContain("POWER");
    expect(html).toContain("WORKOUT TIME");
    expect(html).not.toContain("DEVICE SPEED");
    expect(html).not.toContain("ENERGY");
  });
  it("hides unsupported controls and disables paused commands", () => {
    expect(
      renderToStaticMarkup(
        <WorkoutAdjustments
          fields={[]}
          disabled={false}
          onApply={async () => 0}
        />,
      ),
    ).toBe("");
    const html = renderToStaticMarkup(
      <WorkoutAdjustments fields={fields} disabled onApply={async () => 0} />,
    );
    expect(html).toContain("Set power (W)");
    expect(html).toContain("disabled");
    expect(html).toContain('value="0"');
  });
});
