import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  manualFields,
  normalizeManualTarget,
} from "../src/manualWorkoutControl";
import {
  equipmentControlAvailable,
  manualControlAvailable,
} from "../src/equipmentControl";
import { WorkoutReadings } from "../src/WorkoutReadings";
import { ControlMode } from "../src/ControlMode";
describe("bike resistance levels", () => {
  it("allows manual FTMS levels without enabling watt programmes", () => {
    const features = { speed: false, power: false, resistance: true };
    expect(manualControlAvailable("Bike", true, false, features)).toBe(true);
    expect(equipmentControlAvailable("Bike", true, false, features)).toBe(
      false,
    );
    const fields = manualFields(
      "Bike",
      false,
      features,
      { resistance: { min: 1, max: 32, increment: 1 } },
      { resistance: 7, power: 200 },
    );
    expect(fields.map((f) => f.key)).toEqual(["resistance"]);
    expect(fields[0].value).toBe(7);
    expect(fields[0].range.max).toBe(32);
    expect(normalizeManualTarget(8.3, fields[0].range)).toBe(8);
  });
  it("exposes both targets on dual-capability bikes and only watts on ERG bikes", () => {
    expect(
      manualFields(
        "Bike",
        false,
        { power: true, resistance: true },
        {},
        {},
      ).map((f) => f.key),
    ).toEqual(["resistance", "power"]);
    expect(
      manualFields(
        "Bike",
        false,
        { power: true, resistance: false },
        {},
        {},
      ).map((f) => f.key),
    ).toEqual(["power"]);
  });
  it("uses iFIT advertised resistance capability and levels without guessing power", () => {
    expect(
      manualControlAvailable("Bike", true, true, null, { resistance: true }),
    ).toBe(true);
    expect(
      manualControlAvailable("Bike", true, true, null, { resistance: false }),
    ).toBe(false);
    const fields = manualFields(
      "Bike",
      true,
      null,
      {},
      { resistance: 3 },
      { resistance: true },
      [1, 2, 3, 4, 5, 6],
    );
    expect(fields.map((f) => f.key)).toEqual(["resistance"]);
    expect(fields[0].range).toEqual({ min: 1, max: 6, increment: 1 });
  });
  it("denies telemetry-only equipment and unsupported fields", () => {
    expect(
      manualControlAvailable("Bike", false, false, { resistance: true }),
    ).toBe(false);
    expect(
      manualControlAvailable("Bike", true, false, {
        power: false,
        resistance: false,
      }),
    ).toBe(false);
    expect(manualFields("Bike", true, null, {}, {})).toEqual([]);
  });
  it("shows measured bike level even when watts are missing", () => {
    const html = renderToStaticMarkup(
      <WorkoutReadings
        kind="Bike"
        speed={null}
        power={null}
        resistance={5}
        time="01:00"
      />,
    );
    expect(html).toContain("RESISTANCE");
    expect(html).toContain("5<span>level");
    expect(html).not.toContain("POWER");
  });
  it("enables Manual independently of the automatic-mode restriction", () => {
    const html = renderToStaticMarkup(
      <ControlMode
        value="follow"
        onChange={() => {}}
        busy={false}
        automaticUnavailable="Power unavailable"
        manualUnavailable=""
      />,
    );
    expect(html).toMatch(/<button[^>]*>Manual<\/button>/);
    const manual = html.match(/<button[^>]*>Manual<\/button>/)![0];
    expect(manual).not.toContain("disabled");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Automatic<\/button>/);
  });
});
