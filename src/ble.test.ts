import { describe, it, expect } from "vitest";
import {
  parseIndoorBikeData,
  parseRowerData,
  parseTreadmillData,
  parseCrossTrainerData,
  parseStepOrStairClimberData,
  parseMachineStatus,
} from "./ble";

function view(bytes: number[]): DataView {
  return new DataView(new Uint8Array(bytes).buffer);
}

function u16le(n: number): [number, number] {
  return [n & 0xff, (n >> 8) & 0xff];
}
function i16le(n: number): [number, number] {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, n, true);
  return [new Uint8Array(buf)[0], new Uint8Array(buf)[1]];
}

describe("parseIndoorBikeData", () => {
  it("reads instantaneous speed when its flag bit is clear", () => {
    // flags = 0x0000 -> speed present (bit clear means present, per the FTMS spec)
    const bytes = [...u16le(0x0000), ...u16le(2534)]; // 25.34 km/h
    const result = parseIndoorBikeData(view(bytes));
    expect(result.speedKmh).toBeCloseTo(25.34, 2);
    expect(result.cadenceRpm).toBeNull();
    expect(result.powerW).toBeNull();
  });

  it("reads cadence and power when their flags are set, skipping unset fields correctly", () => {
    // flags: 0x0001 (speed absent) | 0x0004 (cadence present) | 0x0040 (power present)
    const flags = 0x0001 | 0x0004 | 0x0040;
    const bytes = [...u16le(flags), ...u16le(160), ...i16le(215)]; // cadence raw 160 -> 80rpm, power 215W
    const result = parseIndoorBikeData(view(bytes));
    expect(result.speedKmh).toBeNull();
    expect(result.cadenceRpm).toBe(80);
    expect(result.powerW).toBe(215);
  });

  it("advances the offset past skipped optional fields to keep later fields aligned", () => {
    // flags: speed present (bit clear) | avg speed present (0x0002, skipped 2 bytes) | power present (0x0040)
    const flags = 0x0002 | 0x0040;
    const bytes = [
      ...u16le(flags),
      ...u16le(1000),
      ...u16le(9999) /* avg speed, skipped */,
      ...i16le(-5),
    ];
    const result = parseIndoorBikeData(view(bytes));
    expect(result.speedKmh).toBeCloseTo(10, 2);
    expect(result.powerW).toBe(-5);
  });

  it("reads expended energy (total kcal) and heart rate past power, skipping avg power/MET", () => {
    // flags: speed present | avg power (0x0080) | energy (0x0100) | heart rate (0x0200) | MET (0x0400)
    const flags = 0x0080 | 0x0100 | 0x0200 | 0x0400;
    const bytes = [
      ...u16le(flags),
      ...u16le(500), // speed 5.00 km/h
      ...u16le(999), // avg power, skipped
      ...u16le(320),
      0x00,
      0x00,
      0x00, // expended energy: total=320 kcal, per-hour+per-min skipped
      150, // heart rate
      5, // MET, skipped
    ];
    const result = parseIndoorBikeData(view(bytes));
    expect(result.caloriesKcal).toBe(320);
    expect(result.heartRateBpm).toBe(150);
  });

  it("reads elapsed time past heart rate/MET", () => {
    const flags = 0x0800; // elapsed time
    const bytes = [...u16le(flags), ...u16le(500), ...u16le(42)];
    expect(parseIndoorBikeData(view(bytes)).elapsedTimeSec).toBe(42);
  });

  it("returns fields parsed before a truncated payload instead of throwing", () => {
    // flags claim cadence + power present, but the buffer is cut off before power
    const flags = 0x0004 | 0x0040;
    const bytes = [...u16le(flags), ...u16le(1000), ...u16le(160)]; // speed, cadence — power bytes missing
    expect(() => parseIndoorBikeData(view(bytes))).not.toThrow();
    const result = parseIndoorBikeData(view(bytes));
    expect(result.cadenceRpm).toBe(80);
    expect(result.powerW).toBeNull();
  });
});

describe("parseRowerData", () => {
  it("reports stroke rate under cadenceRpm, with no speed field at all", () => {
    // flags = 0x0000 -> stroke rate + stroke count present
    const bytes = [
      ...u16le(0x0000),
      40 /* stroke rate raw -> 20rpm */,
      ...u16le(12),
    ];
    const result = parseRowerData(view(bytes));
    expect(result.speedKmh).toBeNull();
    expect(result.cadenceRpm).toBe(20);
  });

  // On a rower this is often the only monotonic evidence a session happened:
  // there is no speed field, and a real device was seen resetting its own
  // distance counter to zero mid-session.
  it("captures the cumulative stroke count alongside stroke rate", () => {
    const bytes = [...u16le(0x0000), 40, ...u16le(12)];
    expect(parseRowerData(view(bytes)).strokeCount).toBe(12);
  });

  it("leaves strokeCount null when the stroke field is absent", () => {
    const bytes = [
      ...u16le(0x0001) /* stroke rate/count absent */,
      ...u16le(0),
    ];
    expect(parseRowerData(view(bytes)).strokeCount).toBeNull();
  });

  it("reads total distance and power when flagged", () => {
    const flags =
      0x0001 /* stroke rate absent */ |
      0x0004 /* distance */ |
      0x0020; /* power */
    const bytes = [
      ...u16le(flags),
      0x10,
      0x27,
      0x00 /* 10000m as uint24 LE */,
      ...i16le(180),
    ];
    const result = parseRowerData(view(bytes));
    expect(result.cadenceRpm).toBeNull();
    expect(result.totalDistanceM).toBe(10000);
    expect(result.powerW).toBe(180);
  });

  it("derives speedKmh from Instantaneous Pace, since Rower Data has no speed field of its own", () => {
    // flags: stroke rate absent (0x0001) | inst. pace present (0x0008) — 120 sec/500m -> 15 km/h
    const flags = 0x0001 | 0x0008;
    const bytes = [...u16le(flags), ...u16le(120)];
    const result = parseRowerData(view(bytes));
    expect(result.speedKmh).toBeCloseTo(15, 2);
  });

  it("reads expended energy and heart rate past power/resistance", () => {
    // flags: stroke rate present (bit clear) | power (0x0020) | energy (0x0100) | heart rate (0x0200)
    const flags = 0x0020 | 0x0100 | 0x0200;
    const bytes = [
      ...u16le(flags),
      40,
      ...u16le(12), // stroke rate + stroke count
      ...i16le(180), // power
      ...u16le(410),
      0x00,
      0x00,
      0x00, // expended energy: total=410 kcal
      140, // heart rate
    ];
    const result = parseRowerData(view(bytes));
    expect(result.caloriesKcal).toBe(410);
    expect(result.heartRateBpm).toBe(140);
  });

  it("returns fields parsed before a truncated payload instead of throwing", () => {
    const flags = 0x0004; // stroke rate present (bit clear), distance present but truncated
    const bytes = [...u16le(flags), 40, ...u16le(12)]; // distance bytes missing
    expect(() => parseRowerData(view(bytes))).not.toThrow();
    expect(parseRowerData(view(bytes)).cadenceRpm).toBe(20);
  });
});

describe("parseTreadmillData", () => {
  it("reads speed but has no cadence field at all", () => {
    const bytes = [...u16le(0x0000), ...u16le(800)]; // 8.00 km/h
    const result = parseTreadmillData(view(bytes));
    expect(result.speedKmh).toBeCloseTo(8, 2);
    expect(result.cadenceRpm).toBeNull(); // no cadence field exists in the Treadmill Data spec at all
  });

  it("reads inclination as 0.1% units and skips the trailing ramp angle", () => {
    const flags =
      0x0001 /* speed absent */ | 0x0008; /* inclination + ramp angle */
    const bytes = [
      ...u16le(flags),
      ...i16le(35) /* 3.5% incline */,
      ...i16le(0) /* ramp angle, skipped */,
    ];
    const result = parseTreadmillData(view(bytes));
    expect(result.inclinePct).toBeCloseTo(3.5, 2);
  });

  // Real bytes from a device report (see FtmsMetrics.elapsedTimeSec's own
  // comment): flags 0x058c = speed present, total distance (bit2), incline +
  // ramp angle (bit3), expended energy (bit7), heart rate (bit8), elapsed
  // time (bit10) — confirms the offset walk correctly lands on elapsed time
  // past all of those, not just the fields this app already used.
  it("reads elapsed time (seconds) past total distance, incline, expended energy and heart rate", () => {
    const bytes = [
      0x8c,
      0x05, // flags = 0x058c
      0x64,
      0x00, // speed: 1.00 km/h
      0x2c,
      0x1a,
      0x00, // total distance: 6700m
      0x00,
      0x00,
      0xff,
      0x7f, // incline 0.0%, ramp angle 0x7fff (not-available sentinel)
      0x00,
      0x00,
      0x00,
      0x00,
      0x00, // expended energy (unused)
      0x00, // heart rate (unused)
      0x07,
      0x00, // elapsed time: 7 seconds
    ];
    const result = parseTreadmillData(view(bytes));
    expect(result.speedKmh).toBeCloseTo(1, 2);
    expect(result.totalDistanceM).toBe(6700);
    expect(result.elapsedTimeSec).toBe(7);
  });

  it("leaves elapsedTimeSec null when the device does not report that field", () => {
    const bytes = [...u16le(0x0000), ...u16le(500)]; // speed only
    expect(parseTreadmillData(view(bytes)).elapsedTimeSec).toBeNull();
  });

  it("reads expended energy (total kcal) and heart rate", () => {
    // flags: speed present | expended energy (0x0080) | heart rate (0x0100)
    const flags = 0x0080 | 0x0100;
    const bytes = [
      ...u16le(flags),
      ...u16le(800), // speed 8.00 km/h
      ...u16le(275),
      0x00,
      0x00,
      0x00, // expended energy: total=275 kcal
      128, // heart rate
    ];
    const result = parseTreadmillData(view(bytes));
    expect(result.caloriesKcal).toBe(275);
    expect(result.heartRateBpm).toBe(128);
  });

  it("returns fields parsed before a truncated payload instead of throwing", () => {
    const flags = 0x0008; // inclination + ramp angle present, but truncated
    const bytes = [...u16le(flags), ...u16le(500), ...i16le(35)]; // ramp angle bytes missing
    expect(() => parseTreadmillData(view(bytes))).not.toThrow();
    expect(parseTreadmillData(view(bytes)).speedKmh).toBeCloseTo(5, 2);
  });
});

describe("parseCrossTrainerData", () => {
  it("reads instantaneous speed when its flag bit is clear, same inversion as Indoor Bike Data", () => {
    const bytes = [...u16le(0x0000), ...u16le(1200)]; // 12.00 km/h
    const result = parseCrossTrainerData(view(bytes));
    expect(result.speedKmh).toBeCloseTo(12, 2);
  });

  it("reads total distance and power, skipping step/stride count in between", () => {
    // flags: speed present | total distance (0x0004) | step count (0x0008) | power (0x0100)
    const flags = 0x0004 | 0x0008 | 0x0100;
    const bytes = [
      ...u16le(flags),
      ...u16le(1000), // speed
      0x10,
      0x27,
      0x00, // total distance: 10000m
      ...u16le(80),
      ...u16le(80), // step count: inst + avg rate, skipped
      ...i16le(150), // power
    ];
    const result = parseCrossTrainerData(view(bytes));
    expect(result.totalDistanceM).toBe(10000);
    expect(result.powerW).toBe(150);
  });

  it("returns all-null metrics for a truncated payload instead of throwing", () => {
    const bytes = [0x00]; // flags byte itself is truncated
    expect(() => parseCrossTrainerData(view(bytes))).not.toThrow();
    expect(parseCrossTrainerData(view(bytes)).speedKmh).toBeNull();
  });
});

describe("parseStepOrStairClimberData", () => {
  it("returns all-null metrics — layout not yet decoded, see its own comment", () => {
    const result = parseStepOrStairClimberData(view([0x00, 0x00, 0x01, 0x02]));
    expect(result.speedKmh).toBeNull();
    expect(result.totalDistanceM).toBeNull();
    expect(result.powerW).toBeNull();
  });
});

describe("parseMachineStatus", () => {
  it("reports running: true for Started/Resumed by the User", () => {
    expect(parseMachineStatus(view([0x04]))?.running).toBe(true);
  });

  it("reports running: false for both Stopped/Paused and Stopped by Safety Key", () => {
    expect(parseMachineStatus(view([0x02]))?.running).toBe(false);
    expect(parseMachineStatus(view([0x03]))?.running).toBe(false);
  });

  // Spec text implies 0.01 km/h resolution, but a real-device report
  // confirmed this device family's Machine Status echoes back speed at the
  // same 0.1 km/h (÷10) scale its own setTargetSpeed write already had to
  // use — see parseMachineStatus's own comment for the raw-bytes evidence.
  it("decodes Target Speed Changed as km/h at 0.1 resolution (this device family, not the spec default)", () => {
    const bytes = [0x05, ...u16le(30)]; // 3.0 km/h
    expect(parseMachineStatus(view(bytes))?.targetSpeedKmh).toBeCloseTo(3.0, 2);
  });

  // Same story as speed above — setTargetIncline sends a plain, unscaled
  // percent, and Machine Status echoes it back the same way.
  it("decodes Target Incline Changed as a plain signed percent (this device family, not the spec default)", () => {
    const bytes = [0x06, ...i16le(-15)]; // -15%
    expect(parseMachineStatus(view(bytes))?.targetInclinePct).toBe(-15);
  });

  // UINT8 at 0.1 resolution — the spec/pyftms encoding, not the SINT16 an
  // earlier version of this used (that was this file's own *write*-side
  // Control Point encoding, a different field from Machine Status's echo).
  it("decodes Target Resistance Level Changed as an unsigned byte at 0.1 resolution", () => {
    const bytes = [0x07, 80]; // level 8.0
    expect(parseMachineStatus(view(bytes))?.targetResistanceLevel).toBeCloseTo(
      8,
      2,
    );
  });

  it("decodes Target Power Changed as signed watts", () => {
    const bytes = [0x08, ...i16le(220)];
    expect(parseMachineStatus(view(bytes))?.targetPowerW).toBe(220);
  });

  it("records an unrecognized-but-defined op code rather than returning a garbage event", () => {
    // Target Heart Rate Changed — a real, spec-defined op code this app
    // doesn't act on further, distinguished from a truly unknown byte.
    expect(parseMachineStatus(view([0x09]))).toEqual({ unhandledOpCode: 0x09 });
  });

  it("returns null for a truncated payload instead of reading out of bounds", () => {
    expect(parseMachineStatus(view([0x05, 0x10]))).toBeNull(); // op code present, value byte missing
  });

  it("reports reset: true for op code 0x01", () => {
    expect(parseMachineStatus(view([0x01]))?.reset).toBe(true);
  });

  // 0xFF, not 0x16 — 0x16 isn't a defined Machine Status op code at all, so
  // this handler had never once fired against a real device.
  it("reports controlPermissionLost: true for op code 0xFF", () => {
    expect(parseMachineStatus(view([0xff]))?.controlPermissionLost).toBe(true);
  });

  it("decodes Spin Down Status (0x14)", () => {
    expect(parseMachineStatus(view([0x14, 0x02]))?.spinDownStatus).toBe(2); // Success
  });

  it("decodes Indoor Bike Simulation Parameters Changed (0x12) as raw hex", () => {
    expect(
      parseMachineStatus(view([0x12, 0xaa, 0xbb]))?.simulationParamsChangedHex,
    ).toBe("12 aa bb");
  });

  it("decodes target speed/incline at the caller-supplied scale, for a spec-compliant device calibrated away from the default device family", () => {
    const speedBytes = [0x05, ...u16le(300)]; // raw 300
    expect(parseMachineStatus(view(speedBytes))?.targetSpeedKmh).toBeCloseTo(
      30,
      2,
    ); // default scale 10 -> 30.0 km/h
    expect(
      parseMachineStatus(view(speedBytes), 100)?.targetSpeedKmh,
    ).toBeCloseTo(3, 2); // spec scale 100 -> 3.0 km/h

    const inclineBytes = [0x06, ...i16le(30)]; // raw 30
    expect(parseMachineStatus(view(inclineBytes))?.targetInclinePct).toBe(30); // default scale 1 -> 30%
    expect(
      parseMachineStatus(view(inclineBytes), 10, 10)?.targetInclinePct,
    ).toBe(3); // spec scale 10 -> 3%
  });
});
