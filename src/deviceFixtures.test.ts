// Runs the *current* parsers over real captured frames and checks the decode
// still matches what was recorded.
//
// This is the regression net described in deviceFixtures.ts: a parser change
// that alters how a real device's bytes read fails here rather than shipping.
// If one of these fails, the question to ask is "which device did I just
// break, and was that deliberate?" — and if it was deliberate, the fixture's
// expected values need updating *with an explanation*, not silently.
import { describe, it, expect } from "vitest";
import { DEVICE_FIXTURES } from "./deviceFixtures";
import { FTMS_PROBE } from "./ble";
import { IFIT_PROBE, DEFAULT_MAX_RESISTANCE_LEVEL } from "./ifit";
import {
  probeMetricsFromFtms,
  probeMetricsFromIfit,
  type ProbeMetrics,
} from "./deviceProbe";

function bytesOf(hex: string): number[] {
  return hex
    .trim()
    .split(/\s+/)
    .map((b) => parseInt(b, 16));
}

function decodeFixture(f: (typeof DEVICE_FIXTURES)[number]): ProbeMetrics {
  const bytes = bytesOf(f.rawHex);
  if (f.protocol === "FTMS") {
    const view = new DataView(new Uint8Array(bytes).buffer);
    return probeMetricsFromFtms(
      FTMS_PROBE.parseForCharacteristic(f.charUuid!, view),
    );
  }
  const decoded = IFIT_PROBE.metricsFromDecoded(
    IFIT_PROBE.decodeReadValues(bytes, f.readIds!),
    DEFAULT_MAX_RESISTANCE_LEVEL,
  );
  return probeMetricsFromIfit(decoded);
}

describe("golden fixtures", () => {
  it("has fixtures to check", () => {
    expect(DEVICE_FIXTURES.length).toBeGreaterThan(0);
  });

  for (const f of DEVICE_FIXTURES) {
    it(`${f.device} (${f.protocol}) — ${f.note}`, () => {
      expect(decodeFixture(f)).toEqual(f.expected);
    });
  }

  it("carries what each protocol needs to be decoded independently", () => {
    for (const f of DEVICE_FIXTURES) {
      expect(f.rawHex.length, `${f.device} has no bytes`).toBeGreaterThan(0);
      if (f.protocol === "FTMS") {
        expect(
          f.charUuid,
          `${f.device} FTMS fixture needs a charUuid`,
        ).toBeDefined();
      } else {
        // Without the ids, an iFit frame's payload cannot be located — the
        // fixture would silently depend on READ_IDS_BY_CARDIO_TYPE never
        // changing, which is the coupling a fixture exists to avoid.
        expect(
          f.readIds?.length,
          `${f.device} iFit fixture needs readIds`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

// A few of these frames are the direct evidence behind specific registry
// entries and app behaviours. Asserting the link explicitly means a future
// edit that invalidates the reasoning fails loudly rather than leaving a
// registry entry justified by a frame that no longer decodes that way.
describe("fixtures still support the conclusions drawn from them", () => {
  const byNote = (needle: string) =>
    DEVICE_FIXTURES.find((f) => f.note.includes(needle))!;

  it("the Adidas frame still shows the frozen 6700m odometer", () => {
    expect(decodeFixture(byNote("frozen at 6700m")).distanceM).toBe(6700);
  });

  it("the rower still derives speed from pace, having no speed field", () => {
    const m = decodeFixture(byNote("mid-stroke"));
    expect(m.speedKmh).toBeCloseTo(1800 / 408, 6);
    expect(m.strokeCount).toBe(1);
  });

  // The blanked frame is why blanksValuesWhenIdle exists rather than
  // distanceResetsMidSession: every counter reads 0 while the device reports
  // itself paused, and the real values come back on resume.
  it("the blanked rower frame reads as paused with zeroed counters", () => {
    const m = decodeFixture(byNote("idle-blanked"));
    expect(m.running).toBe(false);
    expect(m.distanceM).toBe(0);
    expect(m.elapsedTimeSec).toBe(0);
    expect(m.speedKmh).toBeNull(); // split pace of 0 must not become Infinity
  });
});
