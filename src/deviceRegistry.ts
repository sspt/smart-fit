// Per-device quirks registry.
//
// The problem this solves, in one sentence: every device-specific behaviour
// this app has discovered so far was encoded by editing a *global* constant,
// and the history is two rounds of "we tuned it for device A and broke device
// B". The speed write scale went spec → ÷10 for one treadmill. iFit's
// CurrentDistance got a ÷10 added for one device, then removed when a second
// device showed the opposite error. Neither is a global truth; both are
// properties of a particular machine.
//
// So deviations live here as data, keyed by device, instead of in the code
// paths as constants. Adding support for a newly-reported machine becomes an
// added row that cannot affect any other device, rather than an edit to
// shared behaviour that silently can.
//
// Where the entries come from: the active debugger (see deviceProbe.ts and
// screens/DeviceProbe.tsx) produces a report whose findings map directly onto
// the fields below, and emits a paste-ready entry — so the loop is "user runs
// the probe → we paste the proposed entry here → that machine works". Every
// entry records which report it came from and what was actually confirmed
// versus assumed, because an unverified guess in here is worse than no entry
// at all: it silently overrides behaviour that would otherwise self-correct.
//
// This module deliberately imports nothing from ble.ts/ifit.ts/deviceProbe.ts
// so it can be consumed by all three without a cycle.

export type DeviceProtocol = "FTMS" | "iFit";

// How confident we are in a given entry. Anything below 'confirmed' is
// applied the same way at runtime, but the distinction is what stops a guess
// from being mistaken for evidence months later when nobody remembers.
export type QuirkConfidence =
  | "confirmed" // measured against the real machine, in a probe report
  | "reported" // a user described the behaviour, not independently measured
  | "assumed"; // inferred from a sibling model / protocol family

export interface DeviceQuirks {
  // --- Control Point write scaling (FTMS) ---
  // raw = value × scale. The FTMS spec says 0.01 km/h (×100) and 0.1% (×10),
  // but the first real treadmill this app supported needs ×10 / ×1. Neither
  // is "the" right answer, which is exactly why it belongs here. Getting this
  // wrong in the unsafe direction makes a treadmill accelerate hard, so an
  // entry should only ever be written from a measured probe result.
  speedWriteScale?: number;
  inclineWriteScale?: number;

  // Set Target Resistance is split across real devices between a UINT8 and a
  // SINT16 parameter — the FTMS 1.0 spec has errata here. ble.ts tries
  // SINT16 first and retries as UINT8 on an Invalid Parameter rejection; an
  // entry here skips the wasted first attempt.
  resistanceParamWidth?: "sint16" | "uint8";

  // --- Data trust ---
  // false = this device's Total Distance field is known not to advance (or to
  // advance wrongly). ble.ts already discovers this at runtime by watching
  // whether the field ever moves, but that costs the first stretch of every
  // session; knowing up front means the speed-integrated estimate is used
  // from the first notification.
  distanceTrustworthy?: boolean;
  // Multiplier applied to the device's reported distance to get metres. Only
  // for devices confirmed to report a different unit — the iFit
  // CurrentDistance saga is the cautionary tale for making this global.
  distanceScale?: number;
  // false = the advertised Expended Energy value is known to carry another
  // counter (or otherwise be invalid), so it must not be shown as calories.
  caloriesTrustworthy?: boolean;
  // The device puts cumulative metres in FTMS's Expended Energy slot. The
  // value is useful, but must be routed to distance rather than Kcal.
  caloriesFieldIsDistanceM?: boolean;

  // --- iFit specifics ---
  // Feeds resistanceLevelToRaw/rawToResistanceLevel. ifit.ts reads BitField
  // 42 per connection where the device answers; this is the fallback for
  // devices that don't, replacing a hardcoded guess.
  maxResistanceLevel?: number;

  // --- Known reporting artifacts ---
  // The device pushes a cached (often contradictory) Machine Status value the
  // instant a client subscribes. ble.ts ignores the first event on every
  // device regardless; recording it here documents which machines actually do
  // it, so the blanket rule has evidence behind it.
  machineStatusFirstEventStale?: boolean;
  // Every real target change is followed by a spurious echo of exactly 0.
  targetEchoZeroArtifact?: boolean;
  // The device restarts its own odometer partway through a session.
  distanceResetsMidSession?: boolean;

  // The device blanks most live values to exactly 0 after a few seconds of
  // inactivity, then restores them when the user resumes — the counters were
  // never actually lost, they just stop being reported while idle. Confirmed
  // on the NordicTrack RW300 and expected across the iFit rower family.
  //
  // This matters far more than it looks, because a blanked 0 is
  // indistinguishable from a real reading at the byte level, and cumulative
  // counters are exactly the fields that break when a 0 is believed:
  //   - iFit's accumulator tracks the *minimum* distance ever seen as its
  //     session baseline, so one blanked 0 re-baselines to zero and every
  //     later reading is over-counted by the whole pre-pause distance.
  //   - ble.ts's accumulator treats a drop below the baseline *after* the
  //     field has proven itself as a genuine device-side odometer reset, and
  //     banks the distance so far before restarting. A blank-then-restore
  //     therefore banks the pre-pause distance and then counts it a second
  //     time when the real value comes back — the session total roughly
  //     doubles across every pause.
  // Both paths now treat a cumulative field dropping to exactly 0 as "not
  // reported this tick" rather than as data, so this flag is documentation of
  // a device family rather than a behaviour switch. It is still worth
  // recording: it is the explanation for otherwise inexplicable readings in a
  // report, and it tells a future reader that zero-runs in the timeline are
  // expected rather than a fault.
  blanksValuesWhenIdle?: boolean;

  // Which iFit protocol generation this console speaks. Both share exactly
  // one BLE service and one DeviceTx/DeviceRx pair, so nothing observable at
  // connect time distinguishes them — only sending a command in each dialect
  // does. This app implements FitPro1; recording 'FitPro2' on an entry is
  // what stops the connect path from spending a full timeout sequence
  // rediscovering that a known machine cannot be talked to.
  ifitGeneration?: "FitPro1" | "FitPro2";

  // The device reports itself as activation-locked even after the ENABLE
  // handshake — writes are accepted at the transport level and discarded.
  // Recorded so the UI can say control is unavailable rather than offering
  // controls that silently do nothing.
  activationLocked?: boolean;
}

// Identity beyond the advertised name, read from the Device Information
// Service (FTMS) or the metadata commands (iFit). Recorded on an entry purely
// as documentation — matching is still by name, because that is all that is
// available at picker time, before a GATT connection exists. The value is in
// disambiguation after the fact: an advertised name is frequently a model
// code or shared across a whole product line, and firmware revision is what
// separates two units of the same model that behave differently.
export interface DeviceIdentity {
  manufacturerName?: string;
  modelNumber?: string;
  hardwareRevision?: string;
  firmwareRevision?: string;
  softwareRevision?: string;
  /** iFit's own numeric identity, from DeviceInfo/SystemInfo. */
  ifitModel?: number;
  ifitPartNumber?: number;
}

export interface DeviceRegistryEntry {
  /** Human label for the machine this row is about. */
  label: string;
  protocol: DeviceProtocol;
  /** What the machine reported about itself, for disambiguation. */
  identity?: DeviceIdentity;
  /** Case-insensitive exact advertised name. Most specific matcher. */
  name?: string;
  /** Case-insensitive prefix of the advertised name. */
  namePrefix?: string;
  /** Last resort for families with variable names. */
  namePattern?: RegExp;
  quirks: DeviceQuirks;
  confidence: QuirkConfidence;
  /** Where the evidence came from — a probe report id, a ticket, a session. */
  source: string;
  /** What was actually observed, in plain language. */
  evidence: string;
}

// --- The registry ---------------------------------------------------------
// Ordered most-specific-first is NOT required; lookup scores specificity
// itself (see matchDevice). Keep entries grouped by protocol for readability.

export const DEVICE_REGISTRY: DeviceRegistryEntry[] = [
  {
    label: "Adidas 1819 treadmill",
    protocol: "FTMS",
    name: "ADIDAS 1819",
    confidence: "confirmed",
    source:
      "Device probe report R2vDOvYkWFuHG0ez1hMTSqWVytC7IgW (2026-07-26) plus the connection reports that preceded it",
    evidence:
      "Total Distance sat frozen at 6700m across 78s of continuous belt movement. Target speed asked for 3 km/h at scale x10 and the device settled at exactly 3 km/h, confirming this family does NOT use the spec's x100. First Machine Status event claimed Stopped while the data characteristic reported real movement. One target change echoed back as exactly 0. Flags mask constant at 0x058c.",
    quirks: {
      // The standard Total Distance field was frozen in the original probe,
      // but the value carried in Expended Energy is the machine's correct,
      // changing cumulative metre counter and is remapped by ble.ts.
      distanceTrustworthy: true,
      caloriesTrustworthy: false,
      caloriesFieldIsDistanceM: true,
      speedWriteScale: 10,
      // Same family as speed, and the historical evidence in ble.ts's
      // setTargetIncline comment came from this same machine — but the probe
      // did not exercise incline, so this records the app's existing default
      // rather than a fresh measurement.
      inclineWriteScale: 1,
      machineStatusFirstEventStale: true,
      targetEchoZeroArtifact: true,
    },
  },
  {
    label: "SMB1-580D indoor bike",
    protocol: "FTMS",
    name: "SMB1-580D",
    confidence: "confirmed",
    source: "Device probe report ZoyIhOLvAYubknahfin7K9AdFZRzoeOb (2026-07-26)",
    evidence:
      "Declares targetFeatures 0xc — resistance and power only, no speed or incline — and its Supported Speed Range reads back all zeros. Distance advanced 0m → 260m over 64s and agreed with the speed-integrated estimate within 7%, so the field is sound. Exposes no Machine Status. Flags mask constant at 0xb54.",
    quirks: {
      distanceTrustworthy: true,
      // No speedWriteScale: this machine accepts no speed target at all, so
      // recording one would imply a capability it does not have. The probe
      // previously did exactly that and produced a fabricated scale of 42.7.
    },
  },
  {
    label: "NordicTrack RW300 rower (iFit)",
    protocol: "iFit",
    name: "I_RW",
    confidence: "confirmed",
    source:
      'Device probe reports RAnnSn1kcUNYFlx3AlWTkpHNUXXN0G (2026-07-26) and 4qL09YualV09vGHPXXr58ahqjv5oia (2026-07-27), plus the original RW300 capture analysis; a second, separate "I_RW" unit filed device probe report 3qqVy880LkiXGeY4CIVF2ctUnlz9STi (2026-07-31, prod support_requests) with the same "console shows a countdown instead of running" symptom',
    evidence:
      "Reports no speed field (this protocol has no rower speed characteristic); pace arrives via FiveHundredSplit (408 s/500m observed) and is converted. 26 resistance levels, matching the machine the resistance formula was originally calibrated against. " +
      "Blanks most live values to exactly 0 after a few seconds without rowing and restores them when the user resumes — the probe caught this as distance reading 3m then 0m with Mode switching to Pause(3), which was initially and wrongly diagnosed as a mid-session odometer reset. Stroke count and stroke rate are the reliable effort signals between blanks. " +
      "ActualResistance(18)'s raw value does not share Resistance(2)'s step-size scale on this unit: writing level 3 to Resistance and reading Resistance back confirmed level 3, but ActualResistance decoded to level 6 under the same shared ResistanceConverter formula the decompiled source implies both fields use — while the console's own display genuinely showed 3 (user-confirmed). This is why ifit.ts's metricsFromDecoded now reads Resistance first and only falls back to ActualResistance when a device doesn't report Resistance at all. " +
      "A second \"I_RW\" unit's probe report (3qqVy880LkiXGeY4CIVF2ctUnlz9STi, decoded byte-for-byte from the prod database) turned out to show a DIFFERENT mechanism from the ENABLE-race/write-settle bug above — confirmed by decoding the actual log, not assumed: CurrentTime(20) jumped straight to 300 (WarmupTime/WarmupTimeout both read exactly 300 = 5 minutes) and counted down for the rest of the movement stage the instant the user started rowing, with `running` never resolving true/false (Mode outside {Idle,Running,Pause,Resume} the whole time) and, critically, NO WorkoutMode write anywhere in the log — this probe run never called resetToIdle/startDevice at all. So the console entered its own WARM_UP countdown purely from sensing motion while Idle, autonomously, independent of any BLE command. Reproduced against ifitMimic.ts (simulateMovementStart — see ifitMimic.test.ts's \"autonomous warm-up-on-movement\" suite) and now handled live by ifit.ts: the poll loop watches for Mode=WARM_UP while the app already believes it asked for Running (intendedRunningRef) and re-runs the confirmed Idle-then-Running sequence to recover. Separately, the same report's resistance write (asked for level 3, raw 1114 — confirmed correct via resistanceLevelToRaw(3,26)) got no response at all from the device probe's own single-shot exchange (no retry, unlike the live sendControlWrite path) and every later read of Resistance/ActualResistance stayed 0 — no evidence in the log of resistance ever landing at level 1.",
    quirks: {
      maxResistanceLevel: 26,
      // The RW300 predates FitPro2 and answered FitPro1 metadata commands in
      // its probe run, so this is observed rather than assumed.
      ifitGeneration: "FitPro1",
      // Explicitly NOT distanceResetsMidSession: the counter is not reset,
      // it stops being reported while idle and comes back intact. Recording
      // it as a reset would licence exactly the banking behaviour that
      // double-counts distance across every pause.
      blanksValuesWhenIdle: true,
    },
  },
];

// --- Lookup ---------------------------------------------------------------

// Higher scores win. Exact name beats a prefix; a longer prefix beats a
// shorter one; a pattern is the fallback. This lets a family-wide entry
// (namePrefix 'I_') coexist with a model-specific one ('I_RW') without the
// generic row shadowing the specific one.
function specificity(entry: DeviceRegistryEntry): number {
  if (entry.name) return 1000;
  if (entry.namePrefix) return 100 + entry.namePrefix.length;
  if (entry.namePattern) return 10;
  return 0;
}

function entryMatches(
  entry: DeviceRegistryEntry,
  protocol: DeviceProtocol,
  deviceName: string,
): boolean {
  if (entry.protocol !== protocol) return false;
  const name = deviceName.trim().toLowerCase();
  if (entry.name) return name === entry.name.trim().toLowerCase();
  if (entry.namePrefix)
    return name.startsWith(entry.namePrefix.trim().toLowerCase());
  if (entry.namePattern) return entry.namePattern.test(deviceName);
  return false;
}

/** The single best-matching registry entry, or null when the device is unknown. */
export function matchDevice(
  protocol: DeviceProtocol,
  deviceName: string | null | undefined,
): DeviceRegistryEntry | null {
  if (!deviceName) return null;
  let best: DeviceRegistryEntry | null = null;
  let bestScore = -1;
  for (const entry of DEVICE_REGISTRY) {
    if (!entryMatches(entry, protocol, deviceName)) continue;
    const score = specificity(entry);
    if (score > bestScore) {
      best = entry;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Quirks to apply for a device. Always returns an object — an unknown device
 * yields `{}`, which every consumer must treat as "use the normal adaptive
 * behaviour", never as "these values are zero". That distinction matters:
 * the registry is an override layer, not a source of defaults. Runtime
 * discovery (ble.ts watching whether distance ever moves, ifit.ts reading
 * BitField 42) stays in place for everything an entry doesn't speak to.
 */
export function lookupQuirks(
  protocol: DeviceProtocol,
  deviceName: string | null | undefined,
): DeviceQuirks {
  return matchDevice(protocol, deviceName)?.quirks ?? {};
}

/** One-line summary for logs and the probe UI. */
export function describeMatch(
  protocol: DeviceProtocol,
  deviceName: string | null | undefined,
): string {
  const entry = matchDevice(protocol, deviceName);
  if (!entry)
    return `No registry entry for "${deviceName ?? "unknown device"}" (${protocol}) — using adaptive defaults.`;
  const applied = Object.entries(entry.quirks)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
  return `Registry match: ${entry.label} [${entry.confidence}] — ${applied || "no overrides"}`;
}

// --- Authoring helpers ----------------------------------------------------

/**
 * Renders an entry as pasteable TypeScript source for this file. The probe
 * uses this so a report arrives with the registry row already written, which
 * is the difference between "here is a diagnosis" and "here is the fix".
 */
export function formatRegistryEntrySource(entry: DeviceRegistryEntry): string {
  const quirkLines = Object.entries(entry.quirks)
    .map(([k, v]) => `    ${k}: ${typeof v === "string" ? `'${v}'` : v},`)
    .join("\n");
  const matcher = entry.name
    ? `  name: '${entry.name}',`
    : entry.namePrefix
      ? `  namePrefix: '${entry.namePrefix}',`
      : `  namePattern: ${String(entry.namePattern)},`;
  const identityEntries = Object.entries(entry.identity ?? {}).filter(
    ([, v]) => v !== undefined && v !== "",
  );
  const identityBlock = identityEntries.length
    ? [
        "  identity: {",
        ...identityEntries.map(
          ([k, v]) =>
            `    ${k}: ${typeof v === "string" ? `'${String(v).replace(/'/g, "\\'")}'` : v},`,
        ),
        "  },",
      ]
    : [];
  return [
    "{",
    `  label: '${entry.label.replace(/'/g, "\\'")}',`,
    `  protocol: '${entry.protocol}',`,
    matcher,
    ...identityBlock,
    `  confidence: '${entry.confidence}',`,
    `  source: '${entry.source.replace(/'/g, "\\'")}',`,
    `  evidence: '${entry.evidence.replace(/'/g, "\\'")}',`,
    "  quirks: {",
    quirkLines,
    "  },",
    "},",
  ]
    .filter(Boolean)
    .join("\n");
}
