import { describe, it, expect } from "vitest";
import {
  DEVICE_REGISTRY,
  matchDevice,
  lookupQuirks,
  describeMatch,
  formatRegistryEntrySource,
  type DeviceRegistryEntry,
} from "./deviceRegistry";

describe("device matching", () => {
  it("matches an exact advertised name, case-insensitively and ignoring surrounding space", () => {
    expect(matchDevice("FTMS", "ADIDAS 1819")?.label).toMatch(/Adidas 1819/);
    expect(matchDevice("FTMS", "adidas 1819")?.label).toMatch(/Adidas 1819/);
    expect(matchDevice("FTMS", "  ADIDAS 1819 ")?.label).toMatch(/Adidas 1819/);
  });

  it("does not match across protocols", () => {
    // I_RW is an iFit rower; the same name arriving over FTMS is a different
    // machine and must not inherit its quirks.
    expect(matchDevice("iFit", "I_RW")).not.toBeNull();
    expect(matchDevice("FTMS", "I_RW")).toBeNull();
  });

  it("returns null for an unknown device and for a missing name", () => {
    expect(matchDevice("FTMS", "SOME NEW TREADMILL")).toBeNull();
    expect(matchDevice("FTMS", null)).toBeNull();
    expect(matchDevice("FTMS", "")).toBeNull();
  });

  it("yields empty quirks — not defaults — for an unknown device", () => {
    // The distinction matters: consumers must read {} as "use the adaptive
    // behaviour", never as "these values are zero".
    expect(lookupQuirks("FTMS", "SOME NEW TREADMILL")).toEqual({});
    expect(
      lookupQuirks("FTMS", "SOME NEW TREADMILL").speedWriteScale,
    ).toBeUndefined();
  });
});

describe("specificity ordering", () => {
  const entries: DeviceRegistryEntry[] = [];
  // Exercised through the exported matcher by temporarily extending the real
  // registry, so the ordering rule is tested as it actually ships.
  const push = (e: DeviceRegistryEntry) => {
    entries.push(e);
    DEVICE_REGISTRY.push(e);
  };
  const cleanup = () => {
    for (const e of entries)
      DEVICE_REGISTRY.splice(DEVICE_REGISTRY.indexOf(e), 1);
    entries.length = 0;
  };

  it("prefers an exact name over a prefix, and a longer prefix over a shorter one", () => {
    try {
      push({
        label: "family",
        protocol: "iFit",
        namePrefix: "I_",
        quirks: { maxResistanceLevel: 10 },
        confidence: "assumed",
        source: "t",
        evidence: "t",
      });
      push({
        label: "sub-family",
        protocol: "iFit",
        namePrefix: "I_TM",
        quirks: { maxResistanceLevel: 20 },
        confidence: "assumed",
        source: "t",
        evidence: "t",
      });
      push({
        label: "specific",
        protocol: "iFit",
        name: "I_TM900",
        quirks: { maxResistanceLevel: 30 },
        confidence: "confirmed",
        source: "t",
        evidence: "t",
      });

      expect(matchDevice("iFit", "I_TM900")?.label).toBe("specific");
      expect(matchDevice("iFit", "I_TM500")?.label).toBe("sub-family");
      expect(matchDevice("iFit", "I_BK")?.label).toBe("family");
    } finally {
      cleanup();
    }
  });

  it("falls back to a pattern only when no name or prefix matches", () => {
    try {
      push({
        label: "pattern",
        protocol: "FTMS",
        namePattern: /^ZZ-\d+$/,
        quirks: {},
        confidence: "assumed",
        source: "t",
        evidence: "t",
      });
      expect(matchDevice("FTMS", "ZZ-42")?.label).toBe("pattern");
      expect(matchDevice("FTMS", "ZZ-nope")).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("the shipped entries", () => {
  it("has every entry carrying a matcher, a source and evidence", () => {
    for (const e of DEVICE_REGISTRY) {
      expect(
        e.name || e.namePrefix || e.namePattern,
        `${e.label} has no matcher`,
      ).toBeTruthy();
      expect(e.source.length, `${e.label} has no source`).toBeGreaterThan(0);
      expect(e.evidence.length, `${e.label} has no evidence`).toBeGreaterThan(
        0,
      );
    }
  });

  it("does not contain duplicate matchers for the same protocol", () => {
    const seen = new Set<string>();
    for (const e of DEVICE_REGISTRY) {
      const key = `${e.protocol}|${e.name ?? ""}|${e.namePrefix ?? ""}|${String(e.namePattern ?? "")}`;
      expect(seen.has(key), `duplicate matcher for ${e.label}`).toBe(false);
      seen.add(key);
    }
  });

  // The three machines that produced real probe reports.
  it("records the Adidas treadmill's frozen odometer and confirmed x10 write scale", () => {
    const q = lookupQuirks("FTMS", "ADIDAS 1819");
    expect(q.distanceTrustworthy).toBe(true);
    expect(q.caloriesTrustworthy).toBe(false);
    expect(q.caloriesFieldIsDistanceM).toBe(true);
    expect(q.speedWriteScale).toBe(10);
    expect(q.machineStatusFirstEventStale).toBe(true);
    expect(q.targetEchoZeroArtifact).toBe(true);
  });

  it("records the bike as distance-trustworthy and claims no speed scale for it", () => {
    const q = lookupQuirks("FTMS", "SMB1-580D");
    expect(q.distanceTrustworthy).toBe(true);
    // The bike accepts no speed target at all — asserting a scale would imply
    // a capability it does not have, which is what the bogus 42.7 was.
    expect(q.speedWriteScale).toBeUndefined();
    expect(q.inclineWriteScale).toBeUndefined();
  });

  it("records the rower's resistance level count and its idle blanking", () => {
    const q = lookupQuirks("iFit", "I_RW");
    expect(q.maxResistanceLevel).toBe(26);
    expect(q.blanksValuesWhenIdle).toBe(true);
    // Explicitly NOT a mid-session reset. That was the original (wrong)
    // reading of this device's 3m → 0m distance, and recording it as a reset
    // licences the banking behaviour that double-counts distance across every
    // pause — the counter is blanked while idle and restored intact.
    expect(q.distanceResetsMidSession).toBeUndefined();
  });
});

describe("describeMatch", () => {
  it("names the entry and the overrides it applies", () => {
    const s = describeMatch("FTMS", "ADIDAS 1819");
    expect(s).toMatch(/Registry match/);
    expect(s).toMatch(/confirmed/);
    expect(s).toMatch(/speedWriteScale=10/);
  });

  it("says plainly when a device is unknown", () => {
    expect(describeMatch("FTMS", "MYSTERY 9000")).toMatch(/No registry entry/);
    expect(describeMatch("FTMS", "MYSTERY 9000")).toMatch(/adaptive defaults/);
  });
});

describe("formatRegistryEntrySource", () => {
  it("renders a pasteable entry with the matcher and quirks", () => {
    const src = formatRegistryEntrySource({
      label: "Test Machine",
      protocol: "FTMS",
      name: "TEST 1",
      confidence: "confirmed",
      source: "probe",
      evidence: "saw a thing",
      quirks: { distanceTrustworthy: false, speedWriteScale: 100 },
    });
    expect(src).toMatch(/label: 'Test Machine'/);
    expect(src).toMatch(/protocol: 'FTMS'/);
    expect(src).toMatch(/name: 'TEST 1'/);
    expect(src).toMatch(/distanceTrustworthy: false/);
    expect(src).toMatch(/speedWriteScale: 100/);
  });

  it("escapes apostrophes so the output stays valid source", () => {
    const src = formatRegistryEntrySource({
      label: "Bob's Bike",
      protocol: "FTMS",
      namePrefix: "BOB",
      confidence: "reported",
      source: "Bob's ticket",
      evidence: "it's odd",
      quirks: {},
    });
    expect(src).toMatch(/label: 'Bob\\'s Bike'/);
    expect(src).toMatch(/namePrefix: 'BOB'/);
  });
});
