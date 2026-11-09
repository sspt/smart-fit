import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { WorkoutReadings } from "../src/WorkoutReadings";
import { equipmentControlAvailable } from "../src/equipmentControl";

describe("immersive equipment readings", () => {
  for (const [kind, expected, absent] of [
    ["Treadmill", "INCLINE", "POWER"],
    ["Bike", "POWER", "INCLINE"],
    ["Rower", "RESISTANCE", "INCLINE"],
  ] as const) {
    it(`shows the correct ${kind} metric and workout totals`, () => {
      const html = renderToStaticMarkup(
        <WorkoutReadings
          kind={kind}
          speed={5}
          time="12:34"
          incline={3.5}
          power={150}
          resistance={7}
          distance={1250}
          calories={85}
        />,
      );
      expect(html).toContain(expected);
      expect(html).not.toContain(absent);
      expect(html).toContain("1.25");
      expect(html).toContain("85");
      expect(html).toContain("kcal");
      expect(html).toContain("12:34");
      expect(html).not.toContain("VIDEO SPEED");
    });
  }
  it("preserves zero and shows missing measurements as unavailable", () => {
    const html = renderToStaticMarkup(
      <WorkoutReadings
        kind="Treadmill"
        speed={null}
        time="00:00"
        incline={0}
        distance={0}
        calories={null}
      />,
    );
    expect(html).toContain("0.0<span>%");
    expect(html).toContain("0.00<span>km");
    expect(html).toContain("—<span>kcal");
  });
});

describe("equipment control availability", () => {
  const features = { speed: true, power: false, resistance: false };
  it("enables connected FTMS treadmills without a certification checkbox", () => {
    expect(equipmentControlAvailable("Treadmill", true, false, features)).toBe(
      true,
    );
  });
  it("keeps telemetry-only equipment and unsupported targets out of automatic mode", () => {
    expect(equipmentControlAvailable("Treadmill", false, false, features)).toBe(
      false,
    );
    expect(equipmentControlAvailable("Bike", true, false, features)).toBe(
      false,
    );
    expect(equipmentControlAvailable("Rower", true, false, features)).toBe(
      false,
    );
  });
  it("retains the supported iFIT treadmill and rower controls", () => {
    expect(equipmentControlAvailable("Treadmill", true, true, null)).toBe(true);
    expect(equipmentControlAvailable("Rower", true, true, null)).toBe(true);
    expect(equipmentControlAvailable("Bike", true, true, null)).toBe(false);
  });
});
