// Web Bluetooth gateway for cardio machines — FTMS (Fitness Machine Service,
// GATT UUID 0x1826). Android/Chrome only; every entry point feature-detects
// `navigator.bluetooth` (see web-bluetooth.d.ts for the ambient types) and
// callers are expected to hide the UI entirely when `supported` is false.
//
// Parses the three FTMS "Data" characteristics for live speed/cadence/power/
// distance: Indoor Bike Data (0x2AD2), Rower Data (0x2AD1), Treadmill Data
// (0x2ACD). Each is a flags-prefixed, variable-length record — which optional
// fields are present (and therefore each subsequent field's byte offset)
// depends on the flags bitmask, per the Bluetooth GATT Fitness Machine spec.
// Fields this app doesn't display are still walked over (offset advanced) so
// later fields parse at the right offset.
//
// Also implements the FTMS Control Point (0x2AD9) for simple device control
// (target power/speed/incline/resistance) — a separate, write+indicate
// protocol from the read-only Data characteristics above. Devices that don't
// expose a Control Point (common for rowers) simply stay read-only; this is
// detected per-connection, not assumed.
import { useCallback, useEffect, useRef, useState } from "react";
import type { CardioType, CardioBleSummary } from "./types";
import { IFIT_SERVICE_UUID } from "./ifit";
import { logBleEvent } from "./bleLog";
import {
  lookupQuirks,
  describeMatch,
  type DeviceQuirks,
} from "./deviceRegistry";
import { adminError, draftFormat, draftText } from "./i18n/adminDraft";
import {
  beginPassiveSession,
  endPassiveSession,
  recordFtmsMetrics,
  recordPassiveObservation,
} from "./passiveProbe";

const FTMS_SERVICE = 0x1826;
const CHAR_INDOOR_BIKE = 0x2ad2;
const CHAR_ROWER = 0x2ad1;
const CHAR_TREADMILL = 0x2acd;
// Cross Trainer (ellipticals — likely the single most common FTMS device
// after the three above), Step Climber and Stair Climber. Previously
// unrecognized entirely: a device exposing only one of these had no matching
// characteristic in CHAR_BY_CARDIO_TYPE/detectCardioType, so connecting threw
// NotFoundError and the app told the user their machine "doesn't support the
// standard Bluetooth fitness protocol" — wrong, it does, this app just wasn't
// looking for it.
const CHAR_CROSS_TRAINER = 0x2ace;
const CHAR_STEP_CLIMBER = 0x2acf;
const CHAR_STAIR_CLIMBER = 0x2ad0;
const CHAR_CONTROL_POINT = 0x2ad9;
const CHAR_FITNESS_MACHINE_FEATURE = 0x2acc;
const CHAR_SUPPORTED_SPEED_RANGE = 0x2ad4;
const CHAR_SUPPORTED_INCLINATION_RANGE = 0x2ad5;
const CHAR_SUPPORTED_RESISTANCE_RANGE = 0x2ad6;
const CHAR_SUPPORTED_POWER_RANGE = 0x2ad8;
const CHAR_SUPPORTED_HEART_RATE_RANGE = 0x2ad7;
const CHAR_TRAINING_STATUS = 0x2ad3;
const CHAR_MACHINE_STATUS = 0x2ada;

// Standard GATT services/characteristics outside FTMS itself. None are needed
// to run a workout, but together they are what lets a device be *identified*
// rather than merely named: the advertised name is often a model code, a
// serial-derived string, or shared across a whole product line, which makes a
// registry keyed on it alone fragile. Manufacturer + model + firmware is a
// far stronger key, and firmware in particular is what distinguishes two
// units of the same model that behave differently.
export const DEVICE_INFO_SERVICE = 0x180a;
export const DEVICE_INFO_CHARACTERISTICS: {
  uuid: number;
  name: string;
  kind: "string" | "hex";
}[] = [
  { uuid: 0x2a29, name: "manufacturerName", kind: "string" },
  { uuid: 0x2a24, name: "modelNumber", kind: "string" },
  { uuid: 0x2a25, name: "serialNumber", kind: "string" },
  { uuid: 0x2a27, name: "hardwareRevision", kind: "string" },
  { uuid: 0x2a26, name: "firmwareRevision", kind: "string" },
  { uuid: 0x2a28, name: "softwareRevision", kind: "string" },
  { uuid: 0x2a23, name: "systemId", kind: "hex" },
  { uuid: 0x2a50, name: "pnpId", kind: "hex" },
];
export const GENERIC_ACCESS_SERVICE = 0x1800;
// Appearance (0x2A01) carries a SIG-assigned category — the 0x0C80 block is
// "Cycling", 0x0C40 "Outdoor Sports"... For fitness equipment it is an
// independent second opinion on what the machine actually is, useful when
// detectCardioType has to fall back on the requested type.
export const CHAR_APPEARANCE = 0x2a01;
export const BATTERY_SERVICE = 0x180f;
export const CHAR_BATTERY_LEVEL = 0x2a19;

// Full 128-bit form of a standard 16-bit Bluetooth UUID, e.g. 0x2acd ->
// "00002acd-0000-1000-8000-00805f9b34fb" — what BluetoothRemoteGATTCharacteristic.uuid
// actually returns, so detectCardioType below can match against it directly.
function canonicalUuid16(n: number): string {
  return `0000${n.toString(16).padStart(4, "0")}-0000-1000-8000-00805f9b34fb`;
}

// Which equipment a connected FTMS device actually is, discovered from which
// of the "Data" characteristics it exposes — rather than trusting the
// cardioType the caller asked to connect as (the exercise slot the user
// happened to be on), which is frequently wrong: someone picks "Bike" as a
// placeholder, or a device gets swapped for a different one mid-programme.
// Connecting with the wrong assumed characteristic used to fail outright
// (service.getCharacteristic(wrongUuid) throws NotFoundError, which attach()
// previously had no way to distinguish from "this device has no FTMS at
// all" — misreporting a real Treadmill as "doesn't support the standard
// Bluetooth fitness protocol"). Indoor Bike Data can't be told apart from a
// genuine "Other" device over the wire (both use the same characteristic),
// so a requested 'Other' stays 'Other' rather than being relabeled 'Bike'.
//
// Returns the actual numeric characteristic UUID alongside the detected type
// (rather than callers deriving it from CHAR_BY_CARDIO_TYPE[type]) — that
// lookup table only has one entry per CardioType, but Cross Trainer/Step
// Climber/Stair Climber below all map to the *same* CardioType ('Other') as
// a plain Indoor Bike Data device, while needing a different parser.
function detectCardioType(
  chars: BluetoothRemoteGATTCharacteristic[],
  requestedType: CardioType,
): {
  type: CardioType;
  characteristic: BluetoothRemoteGATTCharacteristic;
  charUuid: number;
} | null {
  const byUuid = (n: number) =>
    chars.find((c) => c.uuid === canonicalUuid16(n));
  const treadmill = byUuid(CHAR_TREADMILL);
  const rower = byUuid(CHAR_ROWER);
  const bike = byUuid(CHAR_INDOOR_BIKE);

  // A multi-mode machine can expose more than one Data characteristic (e.g. a
  // combo cross-trainer/bike unit) — when the device actually has the
  // characteristic matching what the user selected, honor that instead of the
  // fixed priority order below, which would otherwise always win regardless
  // of what the user actually picked.
  if (requestedType === "Treadmill" && treadmill)
    return {
      type: "Treadmill",
      characteristic: treadmill,
      charUuid: CHAR_TREADMILL,
    };
  if (requestedType === "Rower" && rower)
    return { type: "Rower", characteristic: rower, charUuid: CHAR_ROWER };
  if (requestedType === "Bike" && bike)
    return { type: "Bike", characteristic: bike, charUuid: CHAR_INDOOR_BIKE };

  if (treadmill)
    return {
      type: "Treadmill",
      characteristic: treadmill,
      charUuid: CHAR_TREADMILL,
    };
  if (rower)
    return { type: "Rower", characteristic: rower, charUuid: CHAR_ROWER };
  if (bike)
    return {
      type: requestedType === "Other" ? "Other" : "Bike",
      characteristic: bike,
      charUuid: CHAR_INDOOR_BIKE,
    };

  // Cross Trainer / Step Climber / Stair Climber have no dedicated CardioType
  // in this app — same 'Other' fallback as a requested-Other device landing
  // on Indoor Bike Data above, just backed by their own real characteristic.
  const crossTrainer = byUuid(CHAR_CROSS_TRAINER);
  if (crossTrainer)
    return {
      type: "Other",
      characteristic: crossTrainer,
      charUuid: CHAR_CROSS_TRAINER,
    };
  const stepClimber = byUuid(CHAR_STEP_CLIMBER);
  if (stepClimber)
    return {
      type: "Other",
      characteristic: stepClimber,
      charUuid: CHAR_STEP_CLIMBER,
    };
  const stairClimber = byUuid(CHAR_STAIR_CLIMBER);
  if (stairClimber)
    return {
      type: "Other",
      characteristic: stairClimber,
      charUuid: CHAR_STAIR_CLIMBER,
    };
  return null;
}

export interface FtmsMetrics {
  speedKmh: number | null;
  cadenceRpm: number | null;
  powerW: number | null;
  totalDistanceM: number | null;
  inclinePct: number | null;
  // Treadmill Data only (bit 10) — a device-side seconds counter, distinct
  // from this app's own workout clock. A real-device report found it a far
  // more trustworthy "is this device really moving" signal than the
  // instantaneous speed field: across 3 consecutive notifications where
  // speed read 0.6, then 0.1, then a spurious 1.0 (the glitch this app has
  // been chasing for a dozen reports), this stayed frozen at exactly 7 the
  // entire time — meaning the device's *own* internal state considered
  // itself stopped even while its instantaneous-speed field was lying.
  // Appears to count seconds since the belt last genuinely started moving,
  // resetting to 0 on a real stop, rather than tracking total session time
  // (it was seen at 0 moments after a connect-time stop, then climbing from
  // 0 once real movement resumed) — not confirmed against the spec text,
  // only against this evidence.
  elapsedTimeSec: number | null;
  // Expended Energy and Heart Rate are defined in every FTMS Data
  // characteristic this app parses (Indoor Bike, Rower, Treadmill, Cross
  // Trainer) — previously walked past (offset advanced, value discarded) on
  // all of them, so FTMS-connected users never saw a calories or BPM tile
  // even on devices that report both, unlike the iFit path which surfaces
  // both. caloriesKcal is the *cumulative Total Energy* sub-field (not the
  // per-hour/per-minute rate sub-fields, which stay unsurfaced).
  heartRateBpm: number | null;
  caloriesKcal: number | null;
  // Rower Data only — cumulative stroke count, which sits immediately after
  // stroke rate in the same optional field and was previously walked past
  // without being captured. On a rower this is often the clearest evidence
  // the machine is doing anything at all: a real rower reported no speed
  // (Rower Data has no speed field) and a distance counter that reset to
  // zero mid-session, leaving stroke count as the only monotonic signal that
  // the session was real.
  strokeCount: number | null;
}

const EMPTY_METRICS: FtmsMetrics = {
  speedKmh: null,
  cadenceRpm: null,
  powerW: null,
  totalDistanceM: null,
  inclinePct: null,
  elapsedTimeSec: null,
  heartRateBpm: null,
  caloriesKcal: null,
  strokeCount: null,
};

// Which "Set Target" controls a connected device actually supports, read once
// per connection from the Fitness Machine Feature characteristic (0x2ACC) —
// bytes 4-7 (Target Setting Features, LE uint32), bits 0/1/2/3.
export interface TargetFeatures {
  speed: boolean;
  incline: boolean;
  resistance: boolean;
  power: boolean;
}

// The full Fitness Machine Features word (bytes 0-3) and Target Setting
// Features word (bytes 4-7) — all 17 bits of each, cross-checked against
// pyftms's MachineFeatures/MachineSettings enums. Previously only 2 of these
// 34 bits were ever decoded (Total Distance Supported, folded straight into
// distanceSupportedByDevice, and the 4 bits behind TargetFeatures above) —
// the other 30 were read off the wire and discarded. This is the device's
// own answer to "what can you do", from a read the app already performs;
// TargetFeatures stays as its own narrower type since Session.tsx/
// sessionStore.tsx already consume it by that shape — this is additive.
export interface MachineFeatures {
  averageSpeed: boolean;
  cadence: boolean;
  totalDistance: boolean;
  inclination: boolean;
  elevationGain: boolean;
  pace: boolean;
  stepCount: boolean;
  resistanceLevel: boolean;
  strideCount: boolean;
  expendedEnergy: boolean;
  heartRate: boolean;
  metabolicEquivalent: boolean;
  elapsedTime: boolean;
  remainingTime: boolean;
  powerMeasurement: boolean;
  forceOnBeltAndPowerOutput: boolean;
  userDataRetention: boolean;
}
export interface TargetSettingFeatures {
  speed: boolean;
  incline: boolean;
  resistance: boolean;
  power: boolean;
  heartRate: boolean;
  energy: boolean;
  steps: boolean;
  strides: boolean;
  distance: boolean;
  time: boolean;
  timeTwoZones: boolean;
  timeThreeZones: boolean;
  timeFiveZones: boolean;
  bikeSimulation: boolean;
  wheelCircumference: boolean;
  spinDown: boolean;
  cadence: boolean;
}
export function decodeMachineFeatures(dataBits: number): MachineFeatures {
  const has = (bit: number) => !!(dataBits & (1 << bit));
  return {
    averageSpeed: has(0),
    cadence: has(1),
    totalDistance: has(2),
    inclination: has(3),
    elevationGain: has(4),
    pace: has(5),
    stepCount: has(6),
    resistanceLevel: has(7),
    strideCount: has(8),
    expendedEnergy: has(9),
    heartRate: has(10),
    metabolicEquivalent: has(11),
    elapsedTime: has(12),
    remainingTime: has(13),
    powerMeasurement: has(14),
    forceOnBeltAndPowerOutput: has(15),
    userDataRetention: has(16),
  };
}
export function decodeTargetSettingFeatures(
  targetBits: number,
): TargetSettingFeatures {
  const has = (bit: number) => !!(targetBits & (1 << bit));
  return {
    speed: has(0),
    incline: has(1),
    resistance: has(2),
    power: has(3),
    heartRate: has(4),
    energy: has(5),
    steps: has(6),
    strides: has(7),
    distance: has(8),
    time: has(9),
    timeTwoZones: has(10),
    timeThreeZones: has(11),
    timeFiveZones: has(12),
    bikeSimulation: has(13),
    wheelCircumference: has(14),
    spinDown: has(15),
    cadence: has(16),
  };
}

// Device-reported min/max/increment for a controllable target, read once per
// connection from the optional Supported Speed/Inclination Range
// characteristics (0x2AD4/0x2AD5) — lets the UI clamp/step the speed and
// incline steppers to what this specific treadmill actually accepts instead
// of a generic guess. Null when the device doesn't expose the characteristic
// (common — it's optional in the spec); callers fall back to a sane default
// range in that case.
export interface SupportedRange {
  min: number;
  max: number;
  increment: number;
}
export interface SupportedRanges {
  speed: SupportedRange | null;
  incline: SupportedRange | null;
  // Supported Resistance Level Range (0x2AD6) / Supported Power Range
  // (0x2AD8) — previously not read at all, which left setTargetResistance
  // hardcoded to 1-20 and setTargetPower to 0-1000W regardless of what the
  // connected device actually supports (a 32-level bike or a 2000W trainer
  // would silently clip at the wrong bound).
  resistance: SupportedRange | null;
  power: SupportedRange | null;
  // Supported Heart Rate Range (0x2AD7) — declared in FTMS_PROBE and never
  // read at all until now. Format differs from the other three: three plain
  // UINT8 values (min/max/increment in BPM), not the SINT16-at-a-fixed-
  // resolution shape the speed/incline/resistance/power ranges use.
  heartRate: SupportedRange | null;
}
const EMPTY_SUPPORTED_RANGES: SupportedRanges = {
  speed: null,
  incline: null,
  resistance: null,
  power: null,
  heartRate: null,
};
// This app's own default policy when the device doesn't report its own
// range (common — all four characteristics are optional in the FTMS spec).
// Exported so the UI can show the same bounds it's actually clamped to.
export const DEFAULT_SPEED_RANGE: SupportedRange = {
  min: 1,
  max: 18,
  increment: 0.5,
};
export const DEFAULT_INCLINE_RANGE: SupportedRange = {
  min: 0,
  max: 8,
  increment: 1,
};
export const DEFAULT_RESISTANCE_RANGE: SupportedRange = {
  min: 1,
  max: 20,
  increment: 1,
};
export const DEFAULT_POWER_RANGE: SupportedRange = {
  min: 0,
  max: 1000,
  increment: 5,
};

// Rounds to the nearest multiple of the device's own reported step (or this
// app's default step, when the device doesn't report one) before clamping —
// previously a value was clamped to [min, max] but never snapped to
// `increment`, so a device with e.g. 0.5 km/h steps could be sent 3.7 and
// either reject it (Invalid Parameter) or round it unpredictably itself.
function snapToRange(value: number, range: SupportedRange): number {
  const snapped = Math.round(value / range.increment) * range.increment;
  return Math.max(range.min, Math.min(range.max, snapped));
}

// raw = value × scale for the Control Point's Set Target Speed/Inclination
// writes. The FTMS spec's own resolutions are 0.01 km/h and 0.1% (i.e. ×100
// and ×10), but the real device family this app was built against needs both
// one decimal place coarser — see setTargetSpeed's comment for the evidence.
// Named constants rather than inline literals because the device probe sends
// its own calibration command at this same scale: if these ever change, the
// probe's measurement has to change with them, or it would be measuring a
// scale the app doesn't actually use.
export const DEFAULT_SPEED_WRITE_SCALE = 100;
export const DEFAULT_INCLINE_WRITE_SCALE = 10;
// The spec's own scales, suggested by reportWriteScaleMismatch when a device
// demonstrates it follows them.
export const SPEC_SPEED_WRITE_SCALE = 100;
export const SPEC_INCLINE_WRITE_SCALE = 10;

function readUint24LE(view: DataView, offset: number): number {
  return (
    view.getUint8(offset) |
    (view.getUint8(offset + 1) << 8) |
    (view.getUint8(offset + 2) << 16)
  );
}

// Every parser below wraps its offset walk in try/catch: a flag bit claiming
// a field is present that firmware doesn't actually populate, or a payload
// truncated by a small ATT MTU, previously threw an uncaught RangeError out
// of the characteristicvaluechanged handler — silently dropping that
// notification (and, on a device that does this on every packet, dropping
// all of them with nothing in the BLE log explaining why). Catching it here
// means whatever fields were read *before* the truncation are still
// returned, and it's the same defensive pattern parseMachineStatus already
// used (see its own byteLength checks) — the data characteristics just
// hadn't gotten it yet.
export function parseIndoorBikeData(view: DataView): FtmsMetrics {
  let offset = 0;
  let speedKmh: number | null = null,
    cadenceRpm: number | null = null,
    powerW: number | null = null,
    totalDistanceM: number | null = null;
  let elapsedTimeSec: number | null = null,
    heartRateBpm: number | null = null,
    caloriesKcal: number | null = null;
  try {
    const flags = view.getUint16(offset, true);
    offset += 2;
    if (!(flags & 0x0001)) {
      speedKmh = view.getUint16(offset, true) / 100;
      offset += 2;
    } // inst. speed
    if (flags & 0x0002) offset += 2; // avg speed
    if (flags & 0x0004) {
      cadenceRpm = view.getUint16(offset, true) / 2;
      offset += 2;
    } // inst. cadence
    if (flags & 0x0008) offset += 2; // avg cadence
    if (flags & 0x0010) {
      totalDistanceM = readUint24LE(view, offset);
      offset += 3;
    } // total distance
    if (flags & 0x0020) offset += 2; // resistance level
    if (flags & 0x0040) {
      powerW = view.getInt16(offset, true);
      offset += 2;
    } // inst. power
    if (flags & 0x0080) offset += 2; // avg power
    if (flags & 0x0100) {
      caloriesKcal = view.getUint16(offset, true);
      offset += 5;
    } // expended energy: total kcal, then per-hour+per-min (skipped)
    if (flags & 0x0200) {
      heartRateBpm = view.getUint8(offset);
      offset += 1;
    } // heart rate
    if (flags & 0x0400) offset += 1; // metabolic equivalent
    if (flags & 0x0800) {
      elapsedTimeSec = view.getUint16(offset, true);
      offset += 2;
    } // elapsed time
    if (flags & 0x1000) offset += 2; // remaining time
  } catch {
    /* truncated payload — return whatever was parsed before the cutoff */
  }
  return {
    speedKmh,
    cadenceRpm,
    powerW,
    totalDistanceM,
    inclinePct: null,
    elapsedTimeSec,
    heartRateBpm,
    caloriesKcal,
    strokeCount: null,
  };
}

export function parseRowerData(view: DataView): FtmsMetrics {
  let offset = 0;
  let speedKmh: number | null = null,
    cadenceRpm: number | null = null,
    powerW: number | null = null,
    totalDistanceM: number | null = null;
  let elapsedTimeSec: number | null = null,
    heartRateBpm: number | null = null,
    caloriesKcal: number | null = null;
  let strokeCount: number | null = null;
  try {
    const flags = view.getUint16(offset, true);
    offset += 2;
    if (!(flags & 0x0001)) {
      cadenceRpm = view.getUint8(offset) / 2;
      offset += 1;
      strokeCount = view.getUint16(offset, true);
      offset += 2;
    } // stroke rate, then stroke count
    if (flags & 0x0002) offset += 1; // avg stroke rate
    if (flags & 0x0004) {
      totalDistanceM = readUint24LE(view, offset);
      offset += 3;
    } // total distance
    // Instantaneous Pace: seconds per 500m. Rower Data has no speed field at
    // all in the spec (unlike Bike/Treadmill/Cross Trainer) — previously this
    // meant a rower's autoDetect movement check and distanceEstimateM safety
    // net (see Accumulator's own comment) had nothing to work with beyond
    // cadence/power, and totalDistanceM alone degrades to a permanent 0m on a
    // rower whose raw distance field never proves itself. Pace converts
    // directly to speed (1800 = seconds in 500m x 3.6 km/h-per-m/s unit
    // conversion folded in) and fills both gaps.
    if (flags & 0x0008) {
      const paceSecPer500m = view.getUint16(offset, true);
      offset += 2;
      if (paceSecPer500m > 0) speedKmh = 1800 / paceSecPer500m;
    }
    if (flags & 0x0010) offset += 2; // avg pace
    if (flags & 0x0020) {
      powerW = view.getInt16(offset, true);
      offset += 2;
    } // inst. power
    if (flags & 0x0040) offset += 2; // avg power
    if (flags & 0x0080) offset += 2; // resistance level
    if (flags & 0x0100) {
      caloriesKcal = view.getUint16(offset, true);
      offset += 5;
    } // expended energy: total kcal, then per-hour+per-min (skipped)
    if (flags & 0x0200) {
      heartRateBpm = view.getUint8(offset);
      offset += 1;
    } // heart rate
    if (flags & 0x0400) offset += 1; // metabolic equivalent
    if (flags & 0x0800) {
      elapsedTimeSec = view.getUint16(offset, true);
      offset += 2;
    } // elapsed time
    if (flags & 0x1000) offset += 2; // remaining time
  } catch {
    /* truncated payload — return whatever was parsed before the cutoff */
  }
  return {
    speedKmh,
    cadenceRpm,
    powerW,
    totalDistanceM,
    inclinePct: null,
    elapsedTimeSec,
    heartRateBpm,
    caloriesKcal,
    strokeCount,
  };
}

export function parseTreadmillData(view: DataView): FtmsMetrics {
  let offset = 0;
  let speedKmh: number | null = null,
    powerW: number | null = null,
    totalDistanceM: number | null = null,
    inclinePct: number | null = null;
  let elapsedTimeSec: number | null = null,
    heartRateBpm: number | null = null,
    caloriesKcal: number | null = null;
  try {
    const flags = view.getUint16(offset, true);
    offset += 2;
    if (!(flags & 0x0001)) {
      speedKmh = view.getUint16(offset, true) / 100;
      offset += 2;
    } // inst. speed
    if (flags & 0x0002) offset += 2; // avg speed
    if (flags & 0x0004) {
      totalDistanceM = readUint24LE(view, offset);
      offset += 3;
    } // total distance
    if (flags & 0x0008) {
      inclinePct = view.getInt16(offset, true) / 10;
      offset += 4;
    } // inclination (0.1%), then ramp angle (unused)
    if (flags & 0x0010) offset += 4; // pos + neg elevation gain (2x uint16)
    if (flags & 0x0020) offset += 1; // inst. pace
    if (flags & 0x0040) offset += 1; // avg pace
    if (flags & 0x0080) {
      caloriesKcal = view.getUint16(offset, true);
      offset += 5;
    } // expended energy: total kcal, then per-hour+per-min (skipped)
    if (flags & 0x0100) {
      heartRateBpm = view.getUint8(offset);
      offset += 1;
    } // heart rate
    if (flags & 0x0200) offset += 1; // metabolic equivalent
    // See FtmsMetrics.elapsedTimeSec's own comment for what a real-device
    // report found this actually useful for — a device-side "is it really
    // moving" signal independent of (and, on that device, more trustworthy
    // than) the instantaneous speed field above.
    if (flags & 0x0400) {
      elapsedTimeSec = view.getUint16(offset, true);
      offset += 2;
    } // elapsed time
    if (flags & 0x0800) offset += 2; // remaining time
    if (flags & 0x1000) {
      offset += 2;
      powerW = view.getInt16(offset, true);
      offset += 2;
    } // force on belt, then power
    if (flags & 0x2000) offset += 3; // step count (uint24) — last field, so not walked further; nothing reads it yet
  } catch {
    /* truncated payload — return whatever was parsed before the cutoff */
  }
  return {
    speedKmh,
    cadenceRpm: null,
    powerW,
    totalDistanceM,
    inclinePct,
    elapsedTimeSec,
    heartRateBpm,
    caloriesKcal,
    strokeCount: null,
  };
}

// Cross Trainer Data (0x2ACE) — ellipticals, likely the single most common
// FTMS device family after Indoor Bike/Rower/Treadmill, and previously
// unrecognized entirely (see detectCardioType's comment). Field layout
// reconstructed from the FTMS spec's flags convention (shares the same
// leading speed/distance layout as Indoor Bike Data) — has not yet been
// confirmed against a real cross trainer the way the three parsers above
// have been against real hardware reports, so treat exact field boundaries
// past total distance as provisional until a real-device report comes in.
export function parseCrossTrainerData(view: DataView): FtmsMetrics {
  let offset = 0;
  let speedKmh: number | null = null,
    powerW: number | null = null,
    totalDistanceM: number | null = null,
    inclinePct: number | null = null;
  let elapsedTimeSec: number | null = null,
    heartRateBpm: number | null = null,
    caloriesKcal: number | null = null;
  try {
    const flags = view.getUint16(offset, true);
    offset += 2;
    if (!(flags & 0x0001)) {
      speedKmh = view.getUint16(offset, true) / 100;
      offset += 2;
    } // inst. speed
    if (flags & 0x0002) offset += 2; // avg speed
    if (flags & 0x0004) {
      totalDistanceM = readUint24LE(view, offset);
      offset += 3;
    } // total distance
    if (flags & 0x0008) offset += 4; // step count: inst. + avg step rate (2x uint16)
    if (flags & 0x0010) offset += 2; // stride count
    if (flags & 0x0020) offset += 4; // pos + neg elevation gain (2x uint16)
    if (flags & 0x0040) {
      inclinePct = view.getInt16(offset, true) / 10;
      offset += 4;
    } // inclination (0.1%), then ramp angle (unused)
    if (flags & 0x0080) offset += 2; // resistance level
    if (flags & 0x0100) {
      powerW = view.getInt16(offset, true);
      offset += 2;
    } // inst. power
    if (flags & 0x0200) offset += 2; // avg power
    if (flags & 0x0400) {
      caloriesKcal = view.getUint16(offset, true);
      offset += 5;
    } // expended energy: total kcal, then per-hour+per-min (skipped)
    if (flags & 0x0800) {
      heartRateBpm = view.getUint8(offset);
      offset += 1;
    } // heart rate
    if (flags & 0x1000) offset += 1; // metabolic equivalent
    if (flags & 0x2000) {
      elapsedTimeSec = view.getUint16(offset, true);
      offset += 2;
    } // elapsed time
    if (flags & 0x4000) offset += 2; // remaining time
    // bit 0x8000 (movement direction, uint8) intentionally not walked — it's
    // the last possible field, so a wrong guess here can't misalign anything.
  } catch {
    /* truncated payload — return whatever was parsed before the cutoff */
  }
  return {
    speedKmh,
    cadenceRpm: null,
    powerW,
    totalDistanceM,
    inclinePct,
    elapsedTimeSec,
    heartRateBpm,
    caloriesKcal,
    strokeCount: null,
  };
}

// Step Climber Data (0x2ACF) and Stair Climber Data (0x2AD0): recognized in
// detectCardioType so a device exposing only one of these can now connect at
// all (previously misreported as "doesn't support FTMS") and use the Control
// Point, but this app doesn't decode their field layout yet — it differs
// meaningfully from the four parsers above (step/floor-rate based, not
// speed/distance based) and hasn't been checked against a real device.
// Returning all-null metrics here is deliberate: showing a plausible-looking
// but wrong number would be worse than showing nothing. Fill this in once a
// real-device report is available, the way Cross Trainer Data above was.
export function parseStepOrStairClimberData(_view: DataView): FtmsMetrics {
  return { ...EMPTY_METRICS };
}

// Unlike setTargetSpeed/setTargetIncline's write-side quirk below, the
// Supported Speed/Inclination Range characteristics on the real tested
// device follow the FTMS spec's own resolution (0.01 km/h, 0.1%) rather than
// the coarser units the Set Target command expects — confirmed against a
// device whose actual minimum speed/incline step is 1.0 km/h / 1%, which
// this file previously misread as 10 km/h / 10% by reusing the write-side
// divisor here.
function parseSupportedSpeedRange(view: DataView): SupportedRange | null {
  if (view.byteLength < 6) return null;
  return {
    min: view.getUint16(0, true) / 100,
    max: view.getUint16(2, true) / 100,
    increment: Math.max(0.1, view.getUint16(4, true) / 100),
  };
}
function parseSupportedInclinationRange(view: DataView): SupportedRange | null {
  if (view.byteLength < 6) return null;
  return {
    min: view.getInt16(0, true) / 10,
    max: view.getInt16(2, true) / 10,
    increment: Math.max(0.1, view.getUint16(4, true) / 10),
  };
}
// Supported Resistance Level Range (0x2AD6): SINT16 min/max/increment at 0.1
// resolution, per spec — previously never read (see setTargetResistance's
// hardcoded 1-20 clamp), following the same spec-resolution assumption as
// the speed/incline ranges above rather than the write-side ÷10 quirk, since
// that quirk was confirmed specific to the Control Point *write* path, not
// these read-only Supported Range characteristics.
function parseSupportedResistanceRange(view: DataView): SupportedRange | null {
  if (view.byteLength < 6) return null;
  return {
    min: view.getInt16(0, true) / 10,
    max: view.getInt16(2, true) / 10,
    increment: Math.max(0.1, view.getUint16(4, true) / 10),
  };
}
// Supported Power Range (0x2AD8): SINT16 min/max/increment in plain watts (no
// scaling) — previously never read (see setTargetPower's hardcoded 0-1000W).
function parseSupportedPowerRange(view: DataView): SupportedRange | null {
  if (view.byteLength < 6) return null;
  return {
    min: view.getInt16(0, true),
    max: view.getInt16(2, true),
    increment: Math.max(1, view.getUint16(4, true)),
  };
}
// Supported Heart Rate Range (0x2AD7): three plain UINT8 values in BPM, per
// spec (cross-checked against pyftms, which reads this range with format
// "u1" — the only one of the four range characteristics that isn't a 2-byte
// field). Declared in FTMS_PROBE since this file's introduction but never
// actually read until now.
function parseSupportedHeartRateRange(view: DataView): SupportedRange | null {
  if (view.byteLength < 3) return null;
  return {
    min: view.getUint8(0),
    max: view.getUint8(1),
    increment: Math.max(1, view.getUint8(2)),
  };
}

function parseForCharacteristic(charUuid: number, view: DataView): FtmsMetrics {
  if (charUuid === CHAR_ROWER) return parseRowerData(view);
  if (charUuid === CHAR_TREADMILL) return parseTreadmillData(view);
  if (charUuid === CHAR_CROSS_TRAINER) return parseCrossTrainerData(view);
  if (charUuid === CHAR_STEP_CLIMBER || charUuid === CHAR_STAIR_CLIMBER)
    return parseStepOrStairClimberData(view);
  return parseIndoorBikeData(view);
}

// Machine Status (0x2ADA) — the FTMS characteristic actually designed for
// this app's "stay in sync with changes made on the console itself" problem:
// the Data characteristics (parsed above) only ever report live sensor
// readings (current speed, current incline, ...), never *why* they're
// changing or what the console's target is set to — so this app used to
// have to guess a console-side change happened by watching the current
// reading settle for a few seconds (see Session.tsx's old
// lastCommandedSpeedRef/SETTLE_MS heuristic). Machine Status instead pushes
// an explicit, authoritative event — Started/Stopped, or a specific target
// changed — the instant it happens, regardless of whether the app or the
// console's own buttons caused it. Optional per spec (plenty of devices
// don't expose it — callers must treat a stream of `null` from this as "not
// supported", not "nothing has changed yet"), and the exact byte layout
// below is standard FTMS but hasn't been confirmed against this app's own
// test hardware the way the Data characteristics above have been.
export interface MachineStatusEvent {
  running?: boolean;
  targetSpeedKmh?: number;
  targetInclinePct?: number;
  targetResistanceLevel?: number;
  targetPowerW?: number;
  // Op code 0x01 — the device's own odometer/session state has been reset.
  // Distinct from `running: false`: a Stop doesn't imply distance was zeroed,
  // this does.
  reset?: boolean;
  // Op code 0xFF — the device revoked this client's control (e.g. the
  // console's own app took over, or an inactivity timeout fired) *before*
  // the app ever tried a command and got the 0x05 rejection that
  // sendControlCommand's retry already handles. Surfacing it as its own
  // event lets attach() clear hasRequestedControlRef proactively instead of
  // waiting to discover the same thing the expensive way (send a command,
  // get rejected, re-request, resend).
  controlPermissionLost?: boolean;
  // Op code 0x14 — echoes the outcome of spinDownControl's own Start request:
  // 1=Requested, 2=Success, 3=Error, 4=StopPedaling (SpinDownStatusCode, per
  // spec). Previously unhandled, so spinDownControl fired with no way to
  // learn whether it actually did anything.
  spinDownStatus?: number;
  // Op code 0x12 — confirms the Control Point's Indoor Bike Simulation
  // Parameters were received; raw hex only, not yet decoded into its 4
  // component fields (wind speed/grade/Crr/Cw) — no real-device report has
  // confirmed those scales the way target speed/incline have.
  simulationParamsChangedHex?: string;
  // Any op code this app doesn't otherwise act on, recorded rather than
  // silently dropped — previously a device sending nothing but unhandled
  // statuses looked identical to one sending nothing at all.
  unhandledOpCode?: number;
}
// Full op code table, transcribed from the FTMS spec (cross-checked against
// pyftms's MachineStatusCode enum) — previously only 9 of these 22 were
// named at all, and one of the 9 (CONTROL_PERMISSION_LOST) was wrong: 0x16
// isn't even a defined status op code (the real one is 0xFF), so that
// handler had never once fired on a real device.
const MACHINE_STATUS_OP = {
  RESET: 0x01,
  STOPPED_OR_PAUSED: 0x02,
  STOPPED_BY_SAFETY_KEY: 0x03,
  STARTED_OR_RESUMED: 0x04,
  TARGET_SPEED_CHANGED: 0x05,
  TARGET_INCLINE_CHANGED: 0x06,
  TARGET_RESISTANCE_CHANGED: 0x07,
  TARGET_POWER_CHANGED: 0x08,
  TARGET_HEART_RATE_CHANGED: 0x09,
  TARGETED_ENERGY_CHANGED: 0x0a,
  TARGETED_STEPS_CHANGED: 0x0b,
  TARGETED_STRIDES_CHANGED: 0x0c,
  TARGETED_DISTANCE_CHANGED: 0x0d,
  TARGETED_TRAINING_TIME_CHANGED: 0x0e,
  TARGETED_TIME_TWO_ZONES_CHANGED: 0x0f,
  TARGETED_TIME_THREE_ZONES_CHANGED: 0x10,
  TARGETED_TIME_FIVE_ZONES_CHANGED: 0x11,
  INDOOR_BIKE_SIMULATION_CHANGED: 0x12,
  WHEEL_CIRCUMFERENCE_CHANGED: 0x13,
  SPIN_DOWN_STATUS: 0x14,
  TARGETED_CADENCE_CHANGED: 0x15,
  CONTROL_PERMISSION_LOST: 0xff,
} as const;
// speedScale/inclineScale let the caller pass the write-side scale currently
// in effect for this connection (see setTargetSpeed/setTargetIncline's own
// comment on why that scale is calibrated per-device rather than a fixed
// constant) — Machine Status echoes targets back at the same scale the
// Control Point write used, confirmed for the ÷10/unscaled device family this
// app was built against (see below), so a spec-compliant device calibrated
// to ÷100/÷10 needs this decode to follow along rather than staying pinned
// to that one family's scale.
export function parseMachineStatus(
  view: DataView,
  speedScale = 10,
  inclineScale = 1,
): MachineStatusEvent | null {
  if (view.byteLength < 1) return null;
  const opCode = view.getUint8(0);
  switch (opCode) {
    case MACHINE_STATUS_OP.RESET:
      return { reset: true };
    case MACHINE_STATUS_OP.STOPPED_OR_PAUSED:
    case MACHINE_STATUS_OP.STOPPED_BY_SAFETY_KEY:
      return { running: false };
    case MACHINE_STATUS_OP.STARTED_OR_RESUMED:
      return { running: true };
    case MACHINE_STATUS_OP.CONTROL_PERMISSION_LOST:
      return { controlPermissionLost: true };
    // The spec text says 0.01 km/h resolution here — but this app's own
    // setTargetSpeed write already had to use 0.1 (÷10, not ÷100) to match
    // this device family's real behavior (see its own comment), and a
    // real-device report confirmed Machine Status echoes back exactly what
    // was sent at that same ÷10 scale: raw 30 sent as a 3.0 km/h target,
    // echoed back as raw 30, and the device's own next Data-characteristic
    // reading showed speedKmh=3 moments later — ÷100 had been reading that
    // same raw 30 as 0.3, which is why every target speed looked like noise.
    case MACHINE_STATUS_OP.TARGET_SPEED_CHANGED:
      return view.byteLength >= 3
        ? { targetSpeedKmh: view.getUint16(1, true) / speedScale }
        : null;
    // Same story as speed above — setTargetIncline sends the raw percent
    // with no scaling at all (not the spec's implied 0.1% resolution), and a
    // real-device report confirmed the echo matches: raw 3 sent for a 3%
    // target, echoed back as raw 3, with the device's own next reading
    // showing inclinePct=3 right after.
    case MACHINE_STATUS_OP.TARGET_INCLINE_CHANGED:
      return view.byteLength >= 3
        ? { targetInclinePct: view.getInt16(1, true) / inclineScale }
        : null;
    // UINT8 at 0.1 resolution (u1.1, cross-checked against pyftms's own
    // MachineStatusModel.target_resistance) — not the SINT16 an earlier
    // version of this used, which was this file's own *write*-side encoding
    // (setTargetResistance's Control Point parameter genuinely is SINT16 —
    // see its own comment — but Machine Status's echo is a different,
    // narrower field). A 2-byte notification (opcode + 1 byte) previously
    // failed the `byteLength >= 3` guard and decoded as nothing at all; a
    // 3-byte one would have been misread.
    case MACHINE_STATUS_OP.TARGET_RESISTANCE_CHANGED:
      return view.byteLength >= 2
        ? { targetResistanceLevel: view.getUint8(1) / 10 }
        : null;
    case MACHINE_STATUS_OP.TARGET_POWER_CHANGED:
      return view.byteLength >= 3
        ? { targetPowerW: view.getInt16(1, true) }
        : null;
    case MACHINE_STATUS_OP.SPIN_DOWN_STATUS:
      return view.byteLength >= 2 ? { spinDownStatus: view.getUint8(1) } : null;
    case MACHINE_STATUS_OP.INDOOR_BIKE_SIMULATION_CHANGED:
      return {
        simulationParamsChangedHex: Array.from(
          new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" "),
      };
    default:
      // One of the several other Machine Status events this app doesn't act
      // on — recorded by op code rather than silently dropped, so a device
      // that's sending real events (just not ones this app decodes further)
      // is distinguishable from one sending nothing.
      return { unhandledOpCode: opCode };
  }
}

// Training Status (0x2AD3) — the machine's own view of what phase a session
// is in (idle, warming up, low/high intensity interval, cool down, ...).
// Nothing in the app acts on it yet, but it is a second authoritative signal
// about whether a device considers itself active, alongside Machine Status,
// and it is exactly the kind of thing worth capturing while a device is in
// front of us rather than discovering we need later.
const TRAINING_STATUS_NAMES: Record<number, string> = {
  0x00: "Other",
  0x01: "Idle",
  0x02: "Warming Up",
  0x03: "Low Intensity Interval",
  0x04: "High Intensity Interval",
  0x05: "Recovery Interval",
  0x06: "Isometric",
  0x07: "Heart Rate Control",
  0x08: "Fitness Test",
  0x09: "Speed Outside of Control Region (low)",
  0x0a: "Speed Outside of Control Region (high)",
  0x0b: "Cool Down",
  0x0c: "Watt Control",
  0x0d: "Manual Mode",
  0x0e: "Pre-Workout",
  0x0f: "Post-Workout",
};
export function parseTrainingStatus(
  view: DataView,
): { status: number; name: string; flags: number } | null {
  if (view.byteLength < 2) return null;
  const flags = view.getUint8(0);
  const status = view.getUint8(1);
  return {
    status,
    name: TRAINING_STATUS_NAMES[status] ?? `Unknown (0x${status.toString(16)})`,
    flags,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

// --- FTMS Control Point protocol (0x2AD9) ---
const OP_REQUEST_CONTROL = 0x00;
const OP_RESET = 0x01;
const OP_SET_TARGET_SPEED = 0x02;
const OP_SET_TARGET_INCLINE = 0x03;
const OP_SET_TARGET_RESISTANCE = 0x04;
const OP_SET_TARGET_POWER = 0x05;
const OP_SET_TARGET_HEART_RATE = 0x06;
const OP_START_RESUME = 0x07;
const OP_STOP_PAUSE = 0x08;
const STOP_PARAM = 0x01; // vs. 0x02 (Pause) — the emergency stop always means Stop, never Pause
const PAUSE_PARAM = 0x02;
// The remaining Control Point op codes this app doesn't send (goal-setting
// targets and time-in-zone targets) — named here purely so
// controlOpCodeLabel/the BLE log and probe report can identify them if a
// future feature or a probe run ever exercises one, not because anything
// here sends them yet.
const OP_SET_TARGETED_ENERGY = 0x09;
const OP_SET_TARGETED_STEPS = 0x0a;
const OP_SET_TARGETED_STRIDES = 0x0b;
const OP_SET_TARGETED_DISTANCE = 0x0c;
const OP_SET_TARGETED_TIME = 0x0d;
const OP_SET_TARGETED_TIME_TWO_ZONES = 0x0e;
const OP_SET_TARGETED_TIME_THREE_ZONES = 0x0f;
const OP_SET_TARGETED_TIME_FIVE_ZONES = 0x10;
// Indoor Bike Simulation Parameters — the primary control path real smart
// trainers use for "sim mode" (grade/wind/rolling resistance driving
// resistance instead of a flat target power/resistance level). Previously
// unreachable: this app only ever sent flat Set Target commands, so a
// trainer's sim-mode behavior (what most third-party apps like Zwift drive)
// had no equivalent here.
const OP_SET_SIMULATION_PARAMS = 0x11;
const OP_SET_WHEEL_CIRCUMFERENCE = 0x12;
const OP_SPIN_DOWN_CONTROL = 0x13;
const OP_SET_TARGETED_CADENCE = 0x14;
const OP_RESPONSE_CODE = 0x80;
const RESULT_SUCCESS = 0x01;
const RESULT_NOT_SUPPORTED = 0x02;
const RESULT_INVALID_PARAMETER = 0x03;
const RESULT_CONTROL_NOT_PERMITTED = 0x05;
const CONTROL_TIMEOUT_MS = 5000;

function controlOpCodeLabel(opCode: number): string {
  switch (opCode) {
    case OP_REQUEST_CONTROL:
      return "Request Control";
    case OP_RESET:
      return "Reset";
    case OP_SET_TARGET_SPEED:
      return "Set Target Speed";
    case OP_SET_TARGET_INCLINE:
      return "Set Target Incline";
    case OP_SET_TARGET_RESISTANCE:
      return "Set Target Resistance";
    case OP_SET_TARGET_POWER:
      return "Set Target Power";
    case OP_SET_TARGET_HEART_RATE:
      return "Set Target Heart Rate";
    case OP_START_RESUME:
      return "Start/Resume";
    case OP_STOP_PAUSE:
      return "Stop/Pause";
    case OP_SET_TARGETED_ENERGY:
      return "Set Targeted Expended Energy";
    case OP_SET_TARGETED_STEPS:
      return "Set Targeted Number of Steps";
    case OP_SET_TARGETED_STRIDES:
      return "Set Targeted Number of Strides";
    case OP_SET_TARGETED_DISTANCE:
      return "Set Targeted Distance";
    case OP_SET_TARGETED_TIME:
      return "Set Targeted Training Time";
    case OP_SET_TARGETED_TIME_TWO_ZONES:
      return "Set Targeted Time in Two Heart Rate Zones";
    case OP_SET_TARGETED_TIME_THREE_ZONES:
      return "Set Targeted Time in Three Heart Rate Zones";
    case OP_SET_TARGETED_TIME_FIVE_ZONES:
      return "Set Targeted Time in Five Heart Rate Zones";
    case OP_SET_SIMULATION_PARAMS:
      return "Set Indoor Bike Simulation Parameters";
    case OP_SET_WHEEL_CIRCUMFERENCE:
      return "Set Wheel Circumference";
    case OP_SPIN_DOWN_CONTROL:
      return "Spin Down Control";
    case OP_SET_TARGETED_CADENCE:
      return "Set Targeted Cadence";
    default:
      return `Op 0x${opCode.toString(16)}`;
  }
}

class ControlNotPermittedError extends Error {}
class InvalidParameterError extends Error {}

function controlResultMessage(code: number): string {
  switch (code) {
    case RESULT_NOT_SUPPORTED:
      return draftText("This device does not support that control.");
    case RESULT_INVALID_PARAMETER:
      return draftText("That value is not valid for this device.");
    case 0x04:
      return draftText("The device could not complete the operation.");
    case RESULT_CONTROL_NOT_PERMITTED:
      return draftText("Control was not permitted.");
    default:
      return draftText("The device returned an unknown error.");
  }
}

// --- Protocol surface consumed by the active debugger (deviceProbe.ts and
// the /device-probe screen) ---
//
// Exported as one block rather than scattered `export` keywords so the sync
// contract is greppable in a single place, and placed here (rather than
// beside the parsers) because it references the Control Point constants
// declared just above — a top-level const referencing them any earlier would
// hit the temporal dead zone at module load.
//
// The whole point of the probe is that it exercises *this* module's real code
// path — same characteristic UUIDs, same detection order, same byte parsers
// the live workout connection uses — instead of keeping its own copy that can
// silently drift (the retired manual /ble-debug tool used to be exactly what
// that drift looked like: it reimplemented iFit's frame builder, equipment
// codes and command codes as its own literals, and every protocol fix made
// in ifit.ts since had simply never reached it). Nothing new is defined
// below — every symbol already existed and is already what useFtms itself
// runs on.
export const FTMS_PROBE = {
  service: FTMS_SERVICE,
  characteristics: {
    indoorBikeData: CHAR_INDOOR_BIKE,
    rowerData: CHAR_ROWER,
    treadmillData: CHAR_TREADMILL,
    crossTrainerData: CHAR_CROSS_TRAINER,
    stepClimberData: CHAR_STEP_CLIMBER,
    stairClimberData: CHAR_STAIR_CLIMBER,
    controlPoint: CHAR_CONTROL_POINT,
    fitnessMachineFeature: CHAR_FITNESS_MACHINE_FEATURE,
    supportedSpeedRange: CHAR_SUPPORTED_SPEED_RANGE,
    supportedInclinationRange: CHAR_SUPPORTED_INCLINATION_RANGE,
    supportedResistanceRange: CHAR_SUPPORTED_RESISTANCE_RANGE,
    supportedPowerRange: CHAR_SUPPORTED_POWER_RANGE,
    supportedHeartRateRange: CHAR_SUPPORTED_HEART_RATE_RANGE,
    trainingStatus: CHAR_TRAINING_STATUS,
    machineStatus: CHAR_MACHINE_STATUS,
  },
  // Everything the data characteristics can be, so the probe can report which
  // ones a device exposes rather than only the one it ends up subscribing to
  // — a multi-mode machine exposing several is itself worth recording.
  allDataCharacteristics: [
    { uuid: CHAR_TREADMILL, name: "Treadmill Data" },
    { uuid: CHAR_CROSS_TRAINER, name: "Cross Trainer Data" },
    { uuid: CHAR_STEP_CLIMBER, name: "Step Climber Data" },
    { uuid: CHAR_STAIR_CLIMBER, name: "Stair Climber Data" },
    { uuid: CHAR_ROWER, name: "Rower Data" },
    { uuid: CHAR_INDOOR_BIKE, name: "Indoor Bike Data" },
  ],
  deviceInfoService: DEVICE_INFO_SERVICE,
  deviceInfoCharacteristics: DEVICE_INFO_CHARACTERISTICS,
  genericAccessService: GENERIC_ACCESS_SERVICE,
  appearanceCharacteristic: CHAR_APPEARANCE,
  batteryService: BATTERY_SERVICE,
  batteryLevelCharacteristic: CHAR_BATTERY_LEVEL,
  parseTrainingStatus,
  controlOpCodes: {
    requestControl: OP_REQUEST_CONTROL,
    reset: OP_RESET,
    setTargetSpeed: OP_SET_TARGET_SPEED,
    setTargetIncline: OP_SET_TARGET_INCLINE,
    setTargetResistance: OP_SET_TARGET_RESISTANCE,
    setTargetPower: OP_SET_TARGET_POWER,
    startResume: OP_START_RESUME,
    stopPause: OP_STOP_PAUSE,
  },
  responseOpCode: OP_RESPONSE_CODE,
  resultSuccess: RESULT_SUCCESS,
  stopParam: STOP_PARAM,
  // The probe sends its calibration command at the app's *own* current write
  // scale, so what it measures is what the app would really do to this
  // machine — not what some independent constant would do.
  defaultSpeedWriteScale: DEFAULT_SPEED_WRITE_SCALE,
  defaultInclineWriteScale: DEFAULT_INCLINE_WRITE_SCALE,
  canonicalUuid16,
  detectCardioType,
  parseForCharacteristic,
  parseSupportedSpeedRange,
  parseSupportedInclinationRange,
  parseSupportedResistanceRange,
  parseSupportedPowerRange,
  parseSupportedHeartRateRange,
  decodeMachineFeatures,
  decodeTargetSettingFeatures,
  controlOpCodeLabel,
  controlResultMessage,
  emptyMetrics: EMPTY_METRICS,
} as const;

function int16LEBytes(value: number): number[] {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setInt16(0, value, true);
  return Array.from(new Uint8Array(buf));
}
function uint16LEBytes(value: number): number[] {
  const buf = new ArrayBuffer(2);
  new DataView(buf).setUint16(0, value, true);
  return Array.from(new Uint8Array(buf));
}

interface PendingControl {
  opCode: number;
  resolve: () => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
}

interface QueuedControlCommand {
  opCode: number;
  payload: number[];
  resolve: () => void;
  reject: (err: Error) => void;
}

interface Accumulator {
  cardioType: CardioType;
  deviceName: string;
  speedSum: number;
  speedCount: number;
  maxSpeed: number | null;
  powerSum: number;
  powerCount: number;
  maxPower: number | null;
  cadenceSum: number;
  cadenceCount: number;
  distanceM: number;
  distanceEstimated: boolean;
  distanceKnown: boolean;
  // Many FTMS devices report Total Distance as a lifetime/trip odometer that
  // isn't reset on connect (e.g. a machine already showing 6.7km from a
  // previous session) — this is the device's first reported value, subtracted
  // from every subsequent reading so distanceM always starts this session at
  // 0 rather than wherever the device's own odometer happened to be sitting.
  distanceBaselineM: number | null;
  // Last raw totalDistanceM this accumulator actually logged a change for —
  // separate from distanceBaselineM (which tracks the session-zero offset).
  // Lets updateAccumulator log every real distance change uncapped (unlike
  // the Data characteristic's own notification logging above, throttled to
  // the first few per connection to avoid flooding at several/sec for a
  // whole workout) — a real distance change is infrequent enough at typical
  // cardio speeds that logging every one of them stays cheap, and a full
  // trail of them is exactly what's needed to tell "distance never updates
  // on this device" apart from "this test session was just too short/slow
  // for it to have ticked up yet" (both look identical from only the first
  // few notifications after connecting).
  lastLoggedDistanceM: number | null;
  // Kept running in parallel at all times, even while totalDistanceM is
  // present — a real-device report found one whose Total Distance field
  // simply never updates over BLE at all (pinned at the exact same raw value
  // for a 90-second session with the belt genuinely moving the whole time).
  // distanceRawTrusted only flips true once the raw field actually proves
  // itself by moving at least once since the baseline was captured; until
  // then distanceM is served from this estimate instead of a permanently
  // stuck 0m. Once trusted, stays trusted for the rest of the connection —
  // a device that updates distance at all is assumed to keep doing so.
  distanceEstimateM: number;
  distanceRawTrusted: boolean;
  // Logged once per connection so a device that blanks on every pause
  // doesn't fill the log with the same line (see updateAccumulator).
  blankingReported: boolean;
  // Accumulated distance from *before* a genuine mid-session device-side
  // reset (see updateAccumulator's own comment on distinguishing that from a
  // stale-first-packet recalibration) — added to the new baseline's relative
  // reading so a console-side reset doesn't wipe out everything logged
  // before it.
  bankedDistanceM: number;
  // Total Distance Supported bit (bit 2) from the Fitness Machine Feature
  // characteristic's first uint32 (Fitness Machine Features, bytes 0-3) —
  // read once at attach() (see attach()'s own comment). `null` until read (or
  // if the device has no Control Point / Feature characteristic at all,
  // where the trust dance below is still the only signal available);
  // `false` skips straight to the speed-integrated estimate instead of
  // waiting to see if the raw field ever proves itself, since the device
  // already declared up front that it won't.
  distanceSupportedByDevice: boolean | null;
  heartRateSum: number;
  heartRateCount: number;
  maxHeartRateBpm: number | null;
  latestCaloriesKcal: number | null;
  // Treadmill Data's own elapsed-time field (see FtmsMetrics.elapsedTimeSec)
  // — a real-device report found the speed-integrated estimate above still
  // creeping upward after a stop, from the exact same spurious nonzero speed
  // readings this app has been chasing elsewhere. This device-side counter
  // proved a reliable "did the device actually consider itself moving this
  // tick" signal (see autoDetect's matching use of it in Session.tsx, whose
  // own comment covers a mistake worth repeating here: comparing this against
  // only the *immediately preceding* tick reads as falsely stagnant during
  // completely normal continuous movement, since this field ticks at 1-second
  // resolution but notifications (and this accumulator's own re-evaluations)
  // can arrive faster than that) — {value, at}, so staleness is judged by
  // elapsed wall-clock time actually spent unchanged, not by tick count.
  lastElapsedTimeChange: { value: number; at: number } | null;
  connectedAtMs: number;
  lastTickMs: number | null;
}

function freshAccumulator(
  cardioType: CardioType,
  deviceName: string,
): Accumulator {
  return {
    cardioType,
    deviceName,
    speedSum: 0,
    speedCount: 0,
    maxSpeed: null,
    powerSum: 0,
    powerCount: 0,
    maxPower: null,
    cadenceSum: 0,
    cadenceCount: 0,
    distanceM: 0,
    distanceEstimated: false,
    distanceKnown: false,
    distanceBaselineM: null,
    lastLoggedDistanceM: null,
    distanceEstimateM: 0,
    distanceRawTrusted: false,
    blankingReported: false,
    bankedDistanceM: 0,
    distanceSupportedByDevice: null,
    lastElapsedTimeChange: null,
    heartRateSum: 0,
    heartRateCount: 0,
    maxHeartRateBpm: null,
    latestCaloriesKcal: null,
    connectedAtMs: Date.now(),
    lastTickMs: null,
  };
}

export interface BleDiagnosticCharacteristic {
  uuid: string;
  properties: string[];
  valueHex: string | null;
  readError: string | null;
}

export interface BleDiagnosticService {
  uuid: string;
  characteristics: BleDiagnosticCharacteristic[];
  characteristicsError: string | null;
}

export interface BleDiagnosticReport {
  deviceName: string;
  cardioType: CardioType;
  timestamp: number;
  userAgent: string;
  services: BleDiagnosticService[];
}

// Standard/well-known GATT service UUIDs worth probing during diagnostics.
// This can only ever confirm or rule out *known* services — a proprietary
// protocol (e.g. iFit's) uses a random 128-bit UUID the browser will never
// reveal unless the app already knew to ask for it by name, which is exactly
// the information this diagnostic exists to help discover over time as users
// report devices. When none of these are found, that itself is useful
// evidence ("this device has no standard fitness services at all").
const DIAGNOSTIC_OPTIONAL_SERVICES = [
  FTMS_SERVICE,
  0x1800,
  0x1801,
  0x180a,
  0x180f,
  0x180d,
  0x1816,
  0x1818,
  0x1814,
];

function hexFromDataView(view: DataView): string {
  const bytes: string[] = [];
  for (let i = 0; i < view.byteLength; i++)
    bytes.push(view.getUint8(i).toString(16).padStart(2, "0"));
  return bytes.join(" ");
}

// One-shot device scan for the "help us add support for your device" flow —
// deliberately independent of useFtms's connection state/refs, since this
// isn't a live workout connection: it connects, walks whatever known GATT
// services+characteristics it's allowed to see, reads what it can, and
// disconnects. Callers (e.g. Profile's DeviceDiagnosticsCard) send the
// resulting report to /support as a plain-text ticket for a human to review.
export async function runBleDiagnostic(
  cardioType: CardioType,
): Promise<BleDiagnosticReport> {
  if (!navigator.bluetooth)
    throw new Error(
      draftText("Web Bluetooth is not supported in this browser."),
    );
  // Unlike the live-workout connect() flow, this is a deliberate one-off "find
  // my device" action, so it shows every nearby Bluetooth device rather than
  // guessing name prefixes — proprietary equipment (iFit-branded gear
  // especially) often advertises a name that doesn't start with the brand at
  // all (a model code, a serial-derived string, etc.), which silently hid it
  // from the filtered picker used elsewhere in this file.
  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: DIAGNOSTIC_OPTIONAL_SERVICES,
  });
  // Past this point a device was actually chosen from the picker, so any
  // failure here is real diagnostic information, not a cancelled dialog — it
  // must reach the caller as a plain Error (never one still named
  // "NotFoundError", which every caller in this app treats as "user
  // cancelled the picker" and silently ignores). GATT connect can also hang
  // indefinitely on some devices instead of rejecting, so this is raced
  // against a timeout rather than trusting the browser to always settle.
  try {
    const deviceName = device.name || draftText("Unknown device");
    if (!device.gatt)
      throw new Error(draftText("This device does not support GATT."));
    const server = await withTimeout(
      device.gatt.connect(),
      15000,
      draftText(
        "Timed out connecting to the device (it may be paired elsewhere, e.g. the console's own iFit connection).",
      ),
    );
    const services: BleDiagnosticService[] = [];
    try {
      const gattServices = await withTimeout(
        server.getPrimaryServices(),
        15000,
        draftText("Timed out reading the device's services."),
      );
      for (const service of gattServices) {
        const characteristics: BleDiagnosticCharacteristic[] = [];
        let characteristicsError: string | null = null;
        // A service that's *present* but throws enumerating its
        // characteristics (e.g. it needs OS-level bonding first, which some
        // iFit gear requires before exposing anything) is itself useful
        // diagnostic evidence — record it and keep going, don't let one
        // broken service hide data from every other service on the device.
        try {
          const chars = await service.getCharacteristics();
          for (const ch of chars) {
            const props: string[] = [];
            if (ch.properties.read) props.push("read");
            if (ch.properties.write) props.push("write");
            if (ch.properties.writeWithoutResponse)
              props.push("writeWithoutResponse");
            if (ch.properties.notify) props.push("notify");
            if (ch.properties.indicate) props.push("indicate");
            let valueHex: string | null = null;
            let readError: string | null = null;
            if (ch.properties.read) {
              try {
                valueHex = hexFromDataView(await ch.readValue());
              } catch (err: any) {
                readError = err?.message || "read failed";
              }
            }
            characteristics.push({
              uuid: ch.uuid,
              properties: props,
              valueHex,
              readError,
            });
          }
        } catch (err: any) {
          characteristicsError =
            err?.message || "Could not enumerate characteristics.";
        }
        services.push({
          uuid: service.uuid,
          characteristics,
          characteristicsError,
        });
      }
    } finally {
      try {
        device.gatt?.disconnect();
      } catch {}
    }
    return {
      deviceName,
      cardioType,
      timestamp: Date.now(),
      userAgent: navigator.userAgent,
      services,
    };
  } catch (err: any) {
    throw new Error(adminError(err, "Could not scan this device."));
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function useFtms() {
  const supported = typeof navigator !== "undefined" && !!navigator.bluetooth;
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<FtmsMetrics>(EMPTY_METRICS);
  const [summary, setSummary] = useState<CardioBleSummary | null>(null);
  const [error, setError] = useState("");
  const [controllable, setControllable] = useState(false);
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const [targetFeatures, setTargetFeatures] = useState<TargetFeatures | null>(
    null,
  );
  // Full feature-bit decode (see MachineFeatures/TargetSettingFeatures) —
  // additive alongside targetFeatures above, which Session.tsx/
  // sessionStore.tsx already consume by its narrower shape.
  const [machineFeatures, setMachineFeatures] =
    useState<MachineFeatures | null>(null);
  const [targetSettingFeatures, setTargetSettingFeatures] =
    useState<TargetSettingFeatures | null>(null);
  const [supportedRanges, setSupportedRanges] = useState<SupportedRanges>(
    EMPTY_SUPPORTED_RANGES,
  );
  // Machine Status (0x2ADA) state — see parseMachineStatus's header comment.
  // Each stays `null` for the life of a connection if the device doesn't
  // expose this optional characteristic at all (checked once, on connect —
  // see attach()), so callers can tell "not supported" apart from "no event
  // yet" by whether machineStatusSupported is true.
  const [machineStatusSupported, setMachineStatusSupported] = useState(false);
  const [machineRunning, setMachineRunning] = useState<boolean | null>(null);
  const [consoleTargetSpeedKmh, setConsoleTargetSpeedKmh] = useState<
    number | null
  >(null);
  const [consoleTargetInclinePct, setConsoleTargetInclinePct] = useState<
    number | null
  >(null);
  const [consoleTargetResistanceLevel, setConsoleTargetResistanceLevel] =
    useState<number | null>(null);
  const [consoleTargetPowerW, setConsoleTargetPowerW] = useState<number | null>(
    null,
  );

  const deviceRef = useRef<BluetoothDevice | null>(null);
  // The cardioType the caller asked to connect as — kept only as the
  // Bike-vs-Other tie-break for detectCardioType (see its comment); actual
  // characteristic selection is probed fresh in attach() below, not assumed
  // from this.
  const cardioTypeRef = useRef<CardioType>("Bike");
  const charUuidRef = useRef<number | null>(null);
  // What attach() actually found on the device this connection, set right
  // before characteristicRef — read once by connect() right after a
  // successful attach() to tell the caller when it differs from what was
  // requested (see connect()'s onCardioTypeDetected).
  const detectedCardioTypeRef = useRef<CardioType | null>(null);
  const characteristicRef = useRef<BluetoothRemoteGATTCharacteristic | null>(
    null,
  );
  const handleValueRef = useRef<((event: Event) => void) | null>(null);
  const controlCharRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const controlHandleRef = useRef<((event: Event) => void) | null>(null);
  const machineStatusCharRef = useRef<BluetoothRemoteGATTCharacteristic | null>(
    null,
  );
  const machineStatusHandleRef = useRef<((event: Event) => void) | null>(null);
  // The device this listener is attached to + the listener itself, so it can
  // be torn down precisely — without this, a previous connection's listener
  // stayed attached forever, and a *delayed* disconnect event from that old
  // device could fire after a new device is already connected, forcing that
  // healthy new connection into a spurious "disconnected"/stuck-reconnecting
  // state (e.g. swapping cardio machines: disconnect old device, immediately
  // connect a new one — if the old device's real disconnect event is slow to
  // arrive, it could otherwise land on the new connection instead).
  const disconnectedDeviceRef = useRef<BluetoothDevice | null>(null);
  const disconnectedHandlerRef = useRef<(() => void) | null>(null);
  // Set instead of startNotifications() when a data characteristic doesn't
  // support notify (rare, but not unheard of — a read-only Data
  // characteristic previously made startNotifications() throw and took the
  // whole connection down the "no FTMS" path, same false negative as an
  // unrecognized characteristic). Polled at roughly the same cadence a
  // notifying device would push at.
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Mirrors `metrics` state without the render-cycle lag — read from
  // setTimeout-scheduled write-scale calibration (see setTargetSpeed/
  // setTargetIncline) where a stale closure over the `metrics` state variable
  // would otherwise see whatever it was at the time the command was issued,
  // not what the device has settled to since.
  const metricsRef = useRef<FtmsMetrics>(EMPTY_METRICS);
  // Per-field last-seen timestamp, used to merge notifications rather than
  // replace metrics wholesale — see mergeMetrics's own comment for why.
  const lastFieldSeenAtRef = useRef<Partial<Record<keyof FtmsMetrics, number>>>(
    {},
  );
  // raw = value * scale for the Control Point write. Both default to the one
  // real device family this app has been tested against (see
  // setTargetSpeed/setTargetIncline's own comments) and calibrate to the
  // FTMS spec's own scale (x100 / x10) the first time a settled reading
  // shows the device is actually spec-compliant instead.
  const speedWriteScaleRef = useRef<number>(DEFAULT_SPEED_WRITE_SCALE);
  const inclineWriteScaleRef = useRef<number>(DEFAULT_INCLINE_WRITE_SCALE);
  const speedScaleCalibratedRef = useRef(false);
  const inclineScaleCalibratedRef = useRef(false);
  // Per-device overrides for the currently-connected machine (see
  // deviceRegistry.ts). Empty for anything not in the registry, which means
  // "use the adaptive defaults" — never "these values are zero".
  const quirksRef = useRef<DeviceQuirks>({});
  // Ref mirror of the machineRunning state, so the notification handler can
  // stamp the device's own running state onto each passively-recorded sample
  // without re-subscribing on every state change.
  const machineRunningRef = useRef<boolean | null>(null);
  const hasRequestedControlRef = useRef(false);
  // Separate from hasRequestedControlRef on purpose: Request Control being
  // granted does not mean Start/Resume was ever sent. The eager post-connect
  // probe below only sends Request Control, so if it's the only thing that
  // sets a "preamble done" flag, a programme whose first command is a Set
  // Target Speed/Incline (started without the user ever pressing device
  // Start) sees that flag already true and skips Start/Resume forever —
  // targets get accepted by the device but the belt never actually moves,
  // and Machine Status never reports Started. This flag tracks Start/Resume
  // specifically, independent of Request Control.
  const hasStartedRef = useRef(false);
  const pendingControlRef = useRef<PendingControl | null>(null);
  // Every Control Point write goes through this serialized queue rather than
  // being sent immediately — see sendRawCommand/processCommandQueue below.
  // Without it, two callers that don't await between each other's commands
  // (e.g. the interval-programme engine's un-awaited setTargetSpeed then
  // setTargetIncline calls) race: the single-slot pendingControlRef design
  // this replaced would let the second command's own write silently
  // supersede (reject) the first command while it was still in flight,
  // dropping it with no visible error — confirmed happening on every
  // interval segment transition for Treadmill devices.
  const commandQueueRef = useRef<QueuedControlCommand[]>([]);
  const processingQueueRef = useRef(false);
  const intentionalRef = useRef(false);
  const accRef = useRef<Accumulator | null>(null);
  const reconnectTokenRef = useRef(0); // bumped on every manual disconnect/new connect to invalidate any in-flight reconnect loop

  const updateAccumulator = useCallback((m: FtmsMetrics) => {
    const acc = accRef.current;
    if (!acc) return;
    const now = Date.now();
    if (m.speedKmh != null) {
      acc.speedSum += m.speedKmh;
      acc.speedCount++;
      if (acc.maxSpeed == null || m.speedKmh > acc.maxSpeed)
        acc.maxSpeed = m.speedKmh;
    }
    if (m.powerW != null) {
      acc.powerSum += m.powerW;
      acc.powerCount++;
      if (acc.maxPower == null || m.powerW > acc.maxPower)
        acc.maxPower = m.powerW;
    }
    if (m.cadenceRpm != null) {
      acc.cadenceSum += m.cadenceRpm;
      acc.cadenceCount++;
    }
    if (m.heartRateBpm != null) {
      acc.heartRateSum += m.heartRateBpm;
      acc.heartRateCount++;
      if (acc.maxHeartRateBpm == null || m.heartRateBpm > acc.maxHeartRateBpm)
        acc.maxHeartRateBpm = m.heartRateBpm;
    }
    // Expended Energy is cumulative. Some consoles blank/reset cumulative
    // fields when paused or stopped, so retain the session high-water mark.
    if (m.caloriesKcal != null)
      acc.latestCaloriesKcal = Math.max(
        acc.latestCaloriesKcal ?? 0,
        m.caloriesKcal,
      );
    // A device-reported elapsed-time counter that's held the same value for
    // a real stretch of wall-clock time means the device itself didn't
    // consider itself moving during that stretch — see
    // Accumulator.lastElapsedTimeChange's comment for why this is judged by
    // elapsed time, not just "differs from the last tick" (this field's own
    // 1-second resolution vs. a possibly-faster tick rate made that read as
    // falsely stagnant during completely normal continuous movement).
    const ELAPSED_TIME_STAGNANT_MS = 2500;
    if (m.elapsedTimeSec != null) {
      const last = acc.lastElapsedTimeChange;
      if (!last || last.value !== m.elapsedTimeSec)
        acc.lastElapsedTimeChange = { value: m.elapsedTimeSec, at: now };
    }
    const elapsedTimeStagnant =
      m.elapsedTimeSec != null &&
      acc.lastElapsedTimeChange != null &&
      acc.lastElapsedTimeChange.value === m.elapsedTimeSec &&
      now - acc.lastElapsedTimeChange.at > ELAPSED_TIME_STAGNANT_MS;
    // Kept running regardless of whether totalDistanceM is present this tick
    // — see distanceEstimateM's comment on Accumulator for why (a device
    // whose raw field never actually updates needs this as its only real
    // source of distance, not just devices that never report the field at all).
    if (m.speedKmh != null && acc.lastTickMs != null && !elapsedTimeStagnant) {
      const dtHours = (now - acc.lastTickMs) / 3_600_000;
      acc.distanceEstimateM += m.speedKmh * dtHours * 1000;
    }
    // A cumulative counter reading exactly 0 after it has already read
    // non-zero is not data — it is the device blanking its live values while
    // idle and it will restore them when the user resumes (confirmed on the
    // NordicTrack RW300; see deviceRegistry.ts's blanksValuesWhenIdle). A
    // real odometer does not return to zero mid-session.
    //
    // Believing that 0 is actively destructive here, not merely noisy: the
    // baseline logic below treats a drop below the baseline on a
    // already-trusted field as a genuine odometer reset and *banks* the
    // distance so far before restarting from the new low value. A
    // blank-then-restore therefore banks the pre-pause distance and then
    // counts the very same metres again when the real reading comes back,
    // roughly doubling the session total across every pause.
    const blankedDistance =
      m.totalDistanceM === 0 && acc.distanceRawTrusted && acc.distanceM > 0;
    if (blankedDistance && !acc.blankingReported) {
      acc.blankingReported = true;
      logBleEvent(
        "FTMS distance blanked to 0 while the machine idled — ignoring the zero rather than treating it as an odometer reset (which would double-count this session's distance when the real value returns).",
      );
    }

    if (blankedDistance) {
      // Hold the last good session distance; the estimate keeps ticking
      // underneath if the device is somehow still reporting speed.
      acc.distanceKnown = true;
    } else if (
      m.totalDistanceM != null &&
      acc.distanceSupportedByDevice === false
    ) {
      // The device's own Fitness Machine Feature characteristic already told
      // us up front it doesn't support Total Distance (see
      // distanceSupportedByDevice's comment) — so a value showing up here
      // anyway isn't trustworthy raw odometer data, it's the same kind of
      // sentinel/garbage value the "wait and see if it proves itself" dance
      // below exists to guard against. Skip straight to the estimate rather
      // than re-running that dance on a field that's already known-unreliable.
      acc.distanceM = acc.distanceEstimateM;
      acc.distanceEstimated = true;
      acc.distanceKnown = true;
    } else if (m.totalDistanceM != null) {
      // Device-reported and cumulative — authoritative, but relative to
      // whatever the device's own odometer read at connect time (see
      // distanceBaselineM's comment above), not this session's true zero.
      // Tracked as the *minimum* seen so far, not just the first-ever
      // reading — some devices' very first notification after subscribing
      // carries a stale/sentinel value (larger than the real, still-settling
      // reading a moment later), which would otherwise pin every future
      // distanceM at 0 forever (Math.max(0, ...) floors it, so it never
      // recovers even once real readings start coming in below that wrong
      // baseline). Recalibrating down whenever a lower reading shows up
      // self-corrects from that without needing to guess which reading was
      // the bad one — but only *before* the raw field has proven itself
      // trustworthy. A lower reading arriving *after* distanceRawTrusted
      // flipped true is a different situation entirely: the device's own
      // odometer genuinely restarted mid-session (console-side reset, or a
      // reconnect the device treated as a new ride) — recalibrating the same
      // way here would silently erase every real meter already logged this
      // session. That distance is banked into bankedDistanceM instead, so
      // the new baseline's relative reading resumes on top of it rather than
      // replacing it.
      if (acc.distanceBaselineM == null) {
        logBleEvent(
          `FTMS distance baseline captured: ${m.totalDistanceM}m (device's own odometer at connect time — session distance reported relative to this).`,
        );
        acc.distanceBaselineM = m.totalDistanceM;
      } else if (m.totalDistanceM < acc.distanceBaselineM) {
        if (!acc.distanceRawTrusted) {
          logBleEvent(
            `FTMS distance baseline recalibrated: ${acc.distanceBaselineM}m -> ${m.totalDistanceM}m (a lower reading arrived before the raw field proved itself — the first one was likely stale).`,
          );
          acc.distanceBaselineM = m.totalDistanceM;
        } else {
          acc.bankedDistanceM += acc.distanceM;
          logBleEvent(
            `FTMS distance: device odometer reset mid-session (was tracking from ${acc.distanceBaselineM}m, now restarting from ${m.totalDistanceM}m) — banking ${Math.round(acc.distanceM)}m already logged so it isn't lost.`,
          );
          acc.distanceBaselineM = m.totalDistanceM;
        }
      }
      const relativeM =
        acc.bankedDistanceM +
        Math.max(0, m.totalDistanceM - acc.distanceBaselineM);
      if (relativeM > acc.bankedDistanceM) acc.distanceRawTrusted = true;
      if (acc.distanceRawTrusted) {
        acc.distanceM = relativeM;
        acc.distanceEstimated = false;
      } else {
        // Hasn't proven itself yet — serve the estimate instead of a
        // possibly-permanently-stuck 0m while we wait and see.
        acc.distanceM = acc.distanceEstimateM;
        acc.distanceEstimated = true;
      }
      acc.distanceKnown = true;
      if (
        acc.lastLoggedDistanceM == null ||
        m.totalDistanceM !== acc.lastLoggedDistanceM
      ) {
        logBleEvent(
          `FTMS distance changed: raw=${m.totalDistanceM}m -> session distance=${relativeM}m (trusted=${acc.distanceRawTrusted}, estimateM=${Math.round(acc.distanceEstimateM)}, speedKmh=${m.speedKmh}).`,
        );
        acc.lastLoggedDistanceM = m.totalDistanceM;
      }
    } else if (m.speedKmh != null && acc.lastTickMs != null) {
      acc.distanceM = acc.distanceEstimateM;
      acc.distanceEstimated = true;
      acc.distanceKnown = true;
    }
    acc.lastTickMs = now;

    setSummary({
      deviceName: acc.deviceName,
      cardioType: acc.cardioType,
      avgSpeedKmh: acc.speedCount ? acc.speedSum / acc.speedCount : null,
      maxSpeedKmh: acc.maxSpeed,
      avgPowerW: acc.powerCount ? acc.powerSum / acc.powerCount : null,
      maxPowerW: acc.maxPower,
      avgCadenceRpm: acc.cadenceCount
        ? acc.cadenceSum / acc.cadenceCount
        : null,
      distanceKm: acc.distanceKnown ? acc.distanceM / 1000 : null,
      distanceEstimated: acc.distanceEstimated,
      durationSec: (now - acc.connectedAtMs) / 1000,
      avgHeartRateBpm: acc.heartRateCount
        ? acc.heartRateSum / acc.heartRateCount
        : null,
      maxHeartRateBpm: acc.maxHeartRateBpm,
      caloriesKcal: acc.latestCaloriesKcal,
    });
  }, []);

  // Rejects whatever control command is currently in flight (if any) plus
  // anything still waiting in the queue — used on disconnect, so nothing
  // waiting on a Control Point promise is ever left frozen (the in-flight
  // command's own 5s timeout) or stuck forever (queued commands, which have
  // no timeout of their own since they haven't started yet).
  const rejectPendingControl = useCallback((reason: string) => {
    const pending = pendingControlRef.current;
    if (pending) {
      clearTimeout(pending.timeoutId);
      pendingControlRef.current = null;
      pending.reject(new Error(reason));
    }
    if (commandQueueRef.current.length) {
      const queued = commandQueueRef.current;
      commandQueueRef.current = [];
      queued.forEach((cmd) => cmd.reject(new Error(reason)));
    }
  }, []);

  // Fires on every indicated Control Point response: [0x80, requestOpCode, resultCode].
  const handleControlIndication = useCallback((event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (
      !value ||
      value.byteLength < 3 ||
      value.getUint8(0) !== OP_RESPONSE_CODE
    )
      return;
    const respondedOpCode = value.getUint8(1);
    const resultCode = value.getUint8(2);
    const pending = pendingControlRef.current;
    if (!pending || pending.opCode !== respondedOpCode) return;
    clearTimeout(pending.timeoutId);
    pendingControlRef.current = null;
    if (resultCode === RESULT_SUCCESS) pending.resolve();
    else if (resultCode === RESULT_CONTROL_NOT_PERMITTED)
      pending.reject(
        new ControlNotPermittedError(controlResultMessage(resultCode)),
      );
    else if (resultCode === RESULT_INVALID_PARAMETER)
      pending.reject(
        new InvalidParameterError(controlResultMessage(resultCode)),
      );
    else pending.reject(new Error(controlResultMessage(resultCode)));
  }, []);

  // Drains the queue one command at a time: writes it, waits for its
  // indicated response (via pendingControlRef, resolved/rejected from
  // handleControlIndication above) or a 5s timeout, then moves to the next.
  // Only one command is ever in flight at a time — this is what guarantees a
  // second queued command can no longer supersede/drop a still-in-flight one.
  const processCommandQueue = useCallback(async () => {
    if (processingQueueRef.current) return;
    processingQueueRef.current = true;
    try {
      while (commandQueueRef.current.length > 0) {
        const cmd = commandQueueRef.current.shift()!;
        const controlChar = controlCharRef.current;
        if (!controlChar) {
          cmd.reject(
            new Error(draftText("This device does not support control.")),
          );
          continue;
        }
        await new Promise<void>((settle) => {
          const timeoutId = setTimeout(() => {
            if (pendingControlRef.current?.opCode === cmd.opCode) {
              pendingControlRef.current = null;
              cmd.reject(new Error(draftText("The device did not respond.")));
              settle();
            }
          }, CONTROL_TIMEOUT_MS);
          pendingControlRef.current = {
            opCode: cmd.opCode,
            resolve: () => {
              cmd.resolve();
              settle();
            },
            reject: (err: Error) => {
              cmd.reject(err);
              settle();
            },
            timeoutId,
          };
          controlChar
            .writeValue(new Uint8Array([cmd.opCode, ...cmd.payload]))
            .catch((err: any) => {
              if (pendingControlRef.current?.opCode === cmd.opCode) {
                clearTimeout(timeoutId);
                pendingControlRef.current = null;
                cmd.reject(
                  err instanceof Error
                    ? err
                    : new Error(draftText("Could not send command.")),
                );
                settle();
              }
            });
        });
      }
    } finally {
      processingQueueRef.current = false;
    }
  }, []);

  // Enqueues one Control Point command; resolves/rejects when its indicated
  // response arrives (or times out). Commands from any caller — including
  // ones that don't await between each other's calls — are now strictly
  // serialized by processCommandQueue rather than racing.
  const sendRawCommand = useCallback(
    (opCode: number, payload: number[]): Promise<void> => {
      if (opCode === OP_STOP_PAUSE) {
        const stale = commandQueueRef.current.splice(0);
        stale.forEach((c) => c.reject(new Error("Cancelled by stop")));
      }
      // Every outbound command this app sends, logged with its result — the
      // one thing missing from every real-device report so far. Without this,
      // there's no way to tell "the app never sent a command" apart from "it
      // sent one and the device ignored/rejected it" from the log alone.
      const label = controlOpCodeLabel(opCode);
      const hex = [opCode, ...payload]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join(" ");
      logBleEvent(`FTMS control command: ${label} [${hex}]`);
      return new Promise((resolve, reject) => {
        if (!controlCharRef.current) {
          logBleEvent(
            `FTMS control command ${label} failed: no Control Point on this device.`,
          );
          reject(new Error(draftText("This device does not support control.")));
          return;
        }
        commandQueueRef.current.push({
          opCode,
          payload,
          resolve: () => {
            logBleEvent(`FTMS control command ${label} succeeded.`);
            recordPassiveObservation({
              kind: "control",
              at: Date.now(),
              label,
              opCode,
              requestHex: hex,
              resultCode: RESULT_SUCCESS,
              resultMessage: null,
            });
            resolve();
          },
          reject: (err: Error) => {
            logBleEvent(
              `FTMS control command ${label} failed: ${err?.message || "unknown error"}`,
            );
            recordPassiveObservation({
              kind: "control",
              at: Date.now(),
              label,
              opCode,
              requestHex: hex,
              resultCode: null,
              resultMessage: err?.message ?? null,
            });
            reject(err);
          },
        });
        processCommandQueue();
      });
    },
    [processCommandQueue],
  );

  // Request Control + Start/Resume, once per connection, before the first
  // real Set Target command (required by most devices — a harmless no-op
  // preamble on devices that don't need it).
  //
  // Start/Resume is sent best-effort: some devices reject it with Operation
  // Failed (0x04) when already running (e.g. resuming right after a target
  // change rather than a real stop), and previously that rejection threw out
  // of this whole preamble — hasRequestedControlRef never got set, so the
  // real Set Target command below was never even attempted, and every
  // subsequent call hit the exact same rejection again. Request Control
  // failing is different: that one genuinely gates everything (a device that
  // refuses control can't accept any command), so it's still allowed to
  // throw.
  const sendControlCommand = useCallback(
    async (opCode: number, payload: number[]): Promise<void> => {
      if (!controlCharRef.current)
        throw new Error(draftText("This device does not support control."));
      if (!hasRequestedControlRef.current) {
        await sendRawCommand(OP_REQUEST_CONTROL, []);
        hasRequestedControlRef.current = true;
      }
      try {
        await sendRawCommand(opCode, payload);
      } catch (err) {
        if (err instanceof ControlNotPermittedError) {
          await sendRawCommand(OP_REQUEST_CONTROL, []);

          hasRequestedControlRef.current = true;
          hasStartedRef.current = true;
          await sendRawCommand(opCode, payload);
        } else {
          throw err;
        }
      }
    },
    [sendRawCommand],
  );

  type ControlFailure =
    | "power"
    | "speed"
    | "incline"
    | "stop"
    | "pause"
    | "simulation"
    | "reset"
    | "spin-down";
  const runControlCommand = useCallback(
    async (opCode: number, payload: number[], failure: ControlFailure) => {
      setControlError("");
      setControlBusy(true);
      try {
        await sendControlCommand(opCode, payload);
      } catch (err: any) {
        // Bind every finite fallback explicitly so catalogue coverage can be
        // checked without translating the canonical command identifier.
        switch (failure) {
          case "power":
            setControlError(adminError(err, "Could not set target power."));
            break;
          case "speed":
            setControlError(adminError(err, "Could not set target speed."));
            break;
          case "incline":
            setControlError(adminError(err, "Could not set target incline."));
            break;
          case "stop":
            setControlError(adminError(err, "Could not stop the device."));
            break;
          case "pause":
            setControlError(adminError(err, "Could not pause the device."));
            break;
          case "simulation":
            setControlError(
              adminError(err, "Could not set simulation parameters."),
            );
            break;
          case "reset":
            setControlError(adminError(err, "Could not reset the device."));
            break;
          case "spin-down":
            setControlError(
              adminError(err, "Could not control spin-down calibration."),
            );
            break;
        }
        throw err;
      } finally {
        setControlBusy(false);
      }
    },
    [sendControlCommand],
  );

  const setTargetPower = useCallback(
    (watts: number) => {
      const range = supportedRanges.power || DEFAULT_POWER_RANGE;
      const clamped = snapToRange(watts, range);
      return runControlCommand(
        OP_SET_TARGET_POWER,
        int16LEBytes(Math.round(clamped)),
        "power",
      );
    },
    [runControlCommand, supportedRanges],
  );

  // The Bluetooth FTMS spec defines Target Speed at 0.01 km/h resolution and
  // Target Inclination at 0.1% resolution (×100 / ×10 respectively) — but
  // live testing against a real treadmill showed both landing exactly 10x
  // too high (0.5% requested became 5% actual; 5 km/h requested drove the
  // treadmill to its own max, consistent with the raw value read as ~50
  // km/h). This specific unit evidently uses one decimal place coarser than
  // spec for both fields, so speedWriteScaleRef/inclineWriteScaleRef default
  // to that device family's scale rather than the spec text.
  //
  // A genuinely spec-compliant device sent this same ÷10-scaled raw value
  // ends up driven to a real speed/incline ~10x *lower* than requested (e.g.
  // asking for 10 km/h at scale 10 sends raw 100, which a spec device reads
  // as 100/100 = 1.0 km/h). The scale that a specific machine needs is a
  // per-device fact, so it is looked up from deviceRegistry.ts on connect
  // (see attach()) and reported — never silently inferred — when a command
  // visibly misses; reportWriteScaleMismatch below explains why inferring it
  // automatically turned out to be unsafe.
  //
  // Clamped and snapped to the device's own reported Supported Speed/
  // Inclination Range when available (see attach()), since that's the
  // authoritative bound *and* step for this specific unit; otherwise falls
  // back to this app's own default policy (1–18 km/h, 0–8% incline) rather
  // than the spec's much wider theoretical range, which most consumer
  // treadmills can't actually reach at either end anyway.
  // Watches what a target command actually achieved and *reports* a scale
  // mismatch — it deliberately does not change the scale itself.
  //
  // An earlier version did switch automatically, and that was unsafe in a way
  // worth spelling out: it sampled 2.5s after the write, but a treadmill
  // accelerates at roughly 0.1–0.5 km/h per second, so a machine asked for
  // 10 km/h and genuinely passing through 1.8 km/h on its way up satisfied
  // the "~10x low" test. Switching to the spec scale on that false positive
  // makes the next 10 km/h request go out as raw 1000, which a ÷10 device
  // reads as 100 km/h and clamps to its maximum — a treadmill lurching to
  // full speed with someone on it. It also latched `calibrated = true` even
  // when the reading was a flat 0 (the normal state when a target is set
  // before the belt starts), locking in a conclusion drawn from no evidence.
  //
  // Detection is safe; automatic actuation changes are not. So a mismatch now
  // surfaces in the BLE log and in the device probe's report, and the actual
  // scale for a misbehaving machine is encoded per-device in deviceRegistry.ts
  // by a human looking at a measurement.
  const reportWriteScaleMismatch = useCallback(
    (kind: "speed" | "incline", requested: number) => {
      const reportedRef =
        kind === "speed" ? speedScaleCalibratedRef : inclineScaleCalibratedRef;
      if (reportedRef.current || requested <= 0) return;
      // Sampled late and only once: early samples catch a machine mid-ramp,
      // which is exactly the false positive described above.
      setTimeout(() => {
        const actual =
          kind === "speed"
            ? metricsRef.current.speedKmh
            : metricsRef.current.inclinePct;
        // A flat zero means the machine never moved — that says nothing about
        // scale, so don't conclude anything and stay open to a later sample.
        if (actual == null || actual === 0) return;
        reportedRef.current = true;
        const ratio = actual / requested;
        if (ratio > 0.7 && ratio < 1.4) return; // landed where asked
        const scale =
          kind === "speed"
            ? speedWriteScaleRef.current
            : inclineWriteScaleRef.current;
        const suggested =
          kind === "speed" ? SPEC_SPEED_WRITE_SCALE : SPEC_INCLINE_WRITE_SCALE;
        logBleEvent(
          `FTMS: target ${kind} asked for ${requested} but the device settled at ${actual} (${ratio < 1 ? (1 / ratio).toFixed(1) + "x low" : ratio.toFixed(1) + "x high"}) at write scale x${scale}. ` +
            `This device likely needs a different scale (the FTMS spec's own is x${suggested}) — add a deviceRegistry.ts entry rather than changing the global default. Not auto-corrected: guessing a speed scale wrong can drive a machine to its maximum.`,
        );
      }, 12000);
    },
    [],
  );

  const setTargetSpeed = useCallback(
    (kmh: number) => {
      const range = supportedRanges.speed || DEFAULT_SPEED_RANGE;
      const clamped = snapToRange(kmh, range);
      const result = runControlCommand(
        OP_SET_TARGET_SPEED,
        uint16LEBytes(Math.round(clamped * speedWriteScaleRef.current)),
        "speed",
      );
      reportWriteScaleMismatch("speed", clamped);
      return result;
    },
    [runControlCommand, supportedRanges, reportWriteScaleMismatch],
  );

  const setTargetIncline = useCallback(
    (pct: number) => {
      const range = supportedRanges.incline || DEFAULT_INCLINE_RANGE;
      const clamped = snapToRange(pct, range);
      const result = runControlCommand(
        OP_SET_TARGET_INCLINE,
        int16LEBytes(Math.round(clamped * inclineWriteScaleRef.current)),
        "incline",
      );
      reportWriteScaleMismatch("incline", clamped);
      return result;
    },
    [runControlCommand, supportedRanges, reportWriteScaleMismatch],
  );

  // Sends FTMS's standard Stop command (not Pause) — the "big red button"
  // emergency stop. Best-effort like every other control command: some
  // devices may reject it (rare for Stop specifically, since it's the one
  // control command most fitness machines are required to honor), surfaced
  // via the same controlError state as any other command.
  const emergencyStop = useCallback(async () => {
    await runControlCommand(OP_STOP_PAUSE, [STOP_PARAM], "stop");
    // The device is now sitting in FTMS's Stopped state. sendControlCommand's
    // Start/Resume preamble only ever fires once per connection
    // (hasStartedRef) — without resetting it here, every Set Target command
    // sent after this Stop would go straight through without ever
    // re-issuing Start/Resume, so the device would accept the new target but
    // never actually move again this connection. Request Control itself is
    // still held, so hasRequestedControlRef is left alone.
    hasStartedRef.current = false;
  }, [runControlCommand]);

  // Pause preserves the active FTMS session and its measurements. Adidas'
  // console app uses parameter 0x02 here; parameter 0x01 is a final Stop and
  // some consoles clear their live counters as soon as they receive it.
  const pauseDevice = useCallback(async () => {
    await runControlCommand(OP_STOP_PAUSE, [PAUSE_PARAM], "pause");
  }, [runControlCommand]);

  // Explicit "start moving" action — unlike sendControlCommand's automatic
  // once-per-connection preamble, this always (re)sends Request Control +
  // Start/Resume, so it works no matter why the device is currently stopped
  // (emergencyStop above, the console's own pause/stop, an idle timeout,
  // etc.). Setting a target speed/incline alone is not sufficient to move a
  // stopped device — most treadmills accept and store the new target but
  // won't start the belt until an explicit Start/Resume arrives.
  const startDevice = useCallback(async () => {
    setControlError("");
    setControlBusy(true);
    try {
      await sendRawCommand(OP_REQUEST_CONTROL, []);
      await sendRawCommand(OP_START_RESUME, []);
      hasRequestedControlRef.current = true;
      hasStartedRef.current = true;
    } catch (err: any) {
      setControlError(adminError(err, "Could not start the device."));
      throw err;
    } finally {
      setControlBusy(false);
    }
  }, [sendRawCommand]);

  // The FTMS 1.0 spec table specifies UINT8 for this Control Point
  // parameter, but the SINT16-at-0.1-resolution form used below matches the
  // *Supported Resistance Level Range* characteristic's own encoding (see
  // parseSupportedResistanceRange) and real devices are genuinely split on
  // which one they expect — the spec itself has errata here. A device
  // expecting the plain UINT8 form rejects the two-byte write with Invalid
  // Parameter (0x03); on that specific rejection, retry once as a single
  // unscaled byte rather than surfacing the error immediately.
  const setTargetResistance = useCallback(
    async (level: number) => {
      const range = supportedRanges.resistance || DEFAULT_RESISTANCE_RANGE;
      const clamped = snapToRange(level, range);
      const asUint8 = () => [Math.max(0, Math.min(255, Math.round(clamped)))];
      const asSint16 = () => int16LEBytes(Math.round(clamped * 10));
      setControlError("");
      setControlBusy(true);
      try {
        // A registry entry that already knows which width this machine expects
        // skips straight to it, rather than spending a rejected command to
        // rediscover it on every single connection.
        if (quirksRef.current.resistanceParamWidth === "uint8") {
          await sendControlCommand(OP_SET_TARGET_RESISTANCE, asUint8());
        } else {
          await sendControlCommand(OP_SET_TARGET_RESISTANCE, asSint16());
        }
      } catch (err) {
        if (
          err instanceof InvalidParameterError &&
          quirksRef.current.resistanceParamWidth !== "uint8"
        ) {
          logBleEvent(
            "FTMS: Set Target Resistance rejected as SINT16 — retrying as UINT8. Worth a deviceRegistry.ts entry (resistanceParamWidth: 'uint8') for this device.",
          );
          try {
            await sendControlCommand(OP_SET_TARGET_RESISTANCE, asUint8());
          } catch (fallbackErr: any) {
            setControlError(
              adminError(fallbackErr, "Could not set target resistance."),
            );
          }
        } else {
          setControlError(adminError(err, "Could not set target resistance."));
        }
        throw err;
      } finally {
        setControlBusy(false);
      }
    },
    [sendControlCommand, supportedRanges],
  );

  // Indoor Bike Simulation Parameters (0x11) — the primary control path real
  // smart trainers use for "sim mode" (grade/wind/rolling resistance driving
  // resistance, rather than a flat target power/resistance level), and
  // previously unreachable: this app only ever sent flat Set Target
  // commands. Wind speed/rolling+wind resistance coefficients default to
  // reasonable stationary-ride values (no wind, typical road tire/bike drag)
  // since grade is the one callers actually want to drive.
  const setSimulationGrade = useCallback(
    (
      gradePct: number,
      windSpeedMps = 0,
      rollingResistanceCoeff = 0.004,
      windResistanceCoeff = 0.51,
    ) => {
      const windRaw = Math.round(windSpeedMps * 1000); // 0.001 m/s resolution
      const gradeRaw = Math.round(gradePct * 100); // 0.01% resolution
      const crrRaw = Math.max(
        0,
        Math.min(255, Math.round(rollingResistanceCoeff * 10000)),
      ); // 0.0001 resolution
      const cwRaw = Math.max(
        0,
        Math.min(255, Math.round(windResistanceCoeff * 100)),
      ); // 0.01 kg/m resolution
      const payload = [
        ...int16LEBytes(windRaw),
        ...int16LEBytes(gradeRaw),
        crrRaw,
        cwRaw,
      ];
      return runControlCommand(OP_SET_SIMULATION_PARAMS, payload, "simulation");
    },
    [runControlCommand],
  );

  const resetDevice = useCallback(
    () => runControlCommand(OP_RESET, [], "reset"),
    [runControlCommand],
  );

  // start=true begins spin-down calibration, start=false stops it — devices
  // that support this (mostly smart trainers) use it to periodically
  // recalibrate their resistance unit against a known coast-down curve.
  const spinDownControl = useCallback(
    (start: boolean) =>
      runControlCommand(
        OP_SPIN_DOWN_CONTROL,
        [start ? 0x01 : 0x02],
        "spin-down",
      ),
    [runControlCommand],
  );

  // Removes every listener/notification/poll this hook may have registered
  // on the *previous* characteristic set, without touching device-level
  // state (deviceRef, disconnectedDeviceRef, accRef, etc.) — shared by
  // disconnect() and the top of attach() below. Previously only disconnect()
  // did this, so a reconnect (which calls attach() directly, never
  // disconnect()) could stack a second live listener on top of the first if
  // the browser handed back the same BluetoothRemoteGATTCharacteristic
  // object across the reconnect (observed caching behavior in some Chrome
  // versions) — silently double-counting every accumulator field driven by
  // notifications (distanceEstimateM integrating 2x per tick, powerSum/
  // speedSum summing 2x against a single count increment, etc.).
  const teardownCharacteristicListeners = useCallback(() => {
    const characteristic = characteristicRef.current;
    const handleValue = handleValueRef.current;
    try {
      if (characteristic && handleValue)
        characteristic.removeEventListener(
          "characteristicvaluechanged",
          handleValue,
        );
    } catch {}
    try {
      characteristic?.stopNotifications().catch(() => {});
    } catch {}
    if (pollIntervalRef.current != null) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    const controlChar = controlCharRef.current;
    const controlHandle = controlHandleRef.current;
    try {
      if (controlChar && controlHandle)
        controlChar.removeEventListener(
          "characteristicvaluechanged",
          controlHandle,
        );
    } catch {}
    try {
      controlChar?.stopNotifications().catch(() => {});
    } catch {}
    const statusChar = machineStatusCharRef.current;
    const statusHandle = machineStatusHandleRef.current;
    try {
      if (statusChar && statusHandle)
        statusChar.removeEventListener(
          "characteristicvaluechanged",
          statusHandle,
        );
    } catch {}
    try {
      statusChar?.stopNotifications().catch(() => {});
    } catch {}
  }, []);

  // Merges an incoming notification into the previously-known metrics rather
  // than replacing them wholesale. FTMS doesn't require a device to send the
  // same flag set on every notification — some split fields across
  // alternating packets to stay under the ATT MTU (e.g. speed+cadence in one
  // packet, distance+power in the next) — and replacing metrics outright on
  // every notification made every consumer (the UI tiles, the target-echo
  // effects, and especially Session.tsx's autoDetect movement check) see
  // each such field flicker to null on alternate ticks, which for autoDetect
  // meant a perfectly-moving device could read as "stopped" half the time.
  // A field only actually goes back to null once it hasn't appeared in any
  // notification for FIELD_STALE_MS — as long as the device keeps sending
  // notifications at all (even ones missing this particular field), staleness
  // still gets re-evaluated on every one of them, so a field that's genuinely
  // gone for good (e.g. a power meter disconnects mid-ride) still clears
  // itself out rather than showing a permanently frozen last value.
  const FIELD_STALE_MS = 5000;
  const mergeMetrics = useCallback(
    (incoming: FtmsMetrics, now: number): FtmsMetrics => {
      const prev = metricsRef.current;
      const seen = lastFieldSeenAtRef.current;
      const fields: (keyof FtmsMetrics)[] = [
        "speedKmh",
        "cadenceRpm",
        "powerW",
        "totalDistanceM",
        "inclinePct",
        "elapsedTimeSec",
        "heartRateBpm",
        "caloriesKcal",
        "strokeCount",
      ];
      const merged = {} as FtmsMetrics;
      for (const f of fields) {
        const incomingValue = incoming[f];
        if (incomingValue != null) {
          seen[f] = now;
          (merged as any)[f] = incomingValue;
        } else {
          const lastSeen = seen[f];
          (merged as any)[f] =
            prev[f] != null &&
            lastSeen != null &&
            now - lastSeen < FIELD_STALE_MS
              ? prev[f]
              : null;
        }
      }
      return merged;
    },
    [],
  );

  // (Re)connects GATT + the characteristic for the currently-selected device —
  // shared by the initial connect and every reconnect attempt, since Web
  // Bluetooth invalidates characteristic references on every fresh
  // `device.gatt.connect()` (a stale reference can't just be reused).
  const attach = useCallback(async () => {
    const device = deviceRef.current;
    if (!device) throw new Error(draftText("No device selected."));
    if (!device.gatt)
      throw new Error(draftText("This device does not support GATT."));
    // Tear down any listeners left over from a previous attach() on this same
    // hook instance (a reconnect calls attach() directly, never disconnect())
    // before this one's replacements are registered — see
    // teardownCharacteristicListeners's own comment.
    teardownCharacteristicListeners();
    // GATT connect can hang indefinitely on some devices instead of
    // rejecting — runBleDiagnostic already learned this the hard way (see
    // its own withTimeout wrap on the identical call); this path never got
    // the same fix, so a hung connect left `connecting`/`reconnecting` stuck
    // true forever with no error and no way out.
    const server = await withTimeout(
      device.gatt.connect(),
      15000,
      draftText("Timed out connecting to the device."),
    );
    const service = await server.getPrimaryService(FTMS_SERVICE);
    // Probe for whichever "Data" characteristic this device actually
    // exposes rather than trusting charUuidRef's assumption — see
    // detectCardioType's comment for why (wrong assumption used to fail the
    // connection outright instead of just picking the wrong parser).
    const allChars = await service.getCharacteristics();
    const detected = detectCardioType(allChars, cardioTypeRef.current);
    if (!detected)
      throw new DOMException(
        "No recognized FTMS Data characteristic on this device.",
        "NotFoundError",
      );
    detectedCardioTypeRef.current = detected.type;
    const charUuid = detected.charUuid;
    charUuidRef.current = charUuid;
    const characteristic = detected.characteristic;

    // A fresh device/connection — previous metrics no longer apply. Reset the
    // merge state (see mergeMetrics's comment) and re-apply this device's own
    // quirks, since a reconnect may well be to a different physical machine.
    metricsRef.current = EMPTY_METRICS;
    lastFieldSeenAtRef.current = {};
    speedScaleCalibratedRef.current = false;
    inclineScaleCalibratedRef.current = false;

    // Per-device overrides, keyed on the advertised name — see
    // deviceRegistry.ts for why these live as data rather than as globals
    // that get retuned every time a new machine shows up. An unknown device
    // yields an empty object and keeps the adaptive defaults, so the registry
    // can only ever narrow behaviour for machines someone has actually
    // measured.
    const quirks = lookupQuirks("FTMS", device.name);
    quirksRef.current = quirks;
    speedWriteScaleRef.current =
      quirks.speedWriteScale ?? DEFAULT_SPEED_WRITE_SCALE;
    inclineWriteScaleRef.current =
      quirks.inclineWriteScale ?? DEFAULT_INCLINE_WRITE_SCALE;
    logBleEvent(describeMatch("FTMS", device.name));

    // The first 3 notifications are always logged in full, including the raw
    // flags byte — enough to confirm which optional fields this device
    // actually populates (the flags bitmask this app's own parsers key off
    // of). After that, logging switches to "only when the decoded values
    // actually change" rather than a hard notification-count cutoff — a
    // fixed cap of 3 meant every report so far only ever showed the first
    // ~1 second of a connection, no matter how long the actual session ran,
    // which repeatedly turned out to be exactly the blind spot hiding the
    // real bug (a value that looked "stuck" was really just never logged
    // again after connecting). Logging on change instead stays cheap for
    // devices that report steady values, while giving full visibility for
    // the whole session on ones that don't.
    let loggedNotifications = 0;
    let lastLoggedValueKey: string | null = null;
    const handleValue = (event: Event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
      if (!value) return;
      let m = parseForCharacteristic(charUuid, value);
      const deviceQuirks = lookupQuirks("FTMS", accRef.current?.deviceName);
      if (deviceQuirks.caloriesFieldIsDistanceM && m.caloriesKcal != null) {
        // ADIDAS 1819 uses the FTMS Expended Energy bytes for its correct
        // cumulative distance-in-metres counter. Route the value to distance
        // before either the live cards or accumulator see it.
        m = { ...m, totalDistanceM: m.caloriesKcal, caloriesKcal: null };
      } else if (
        deviceQuirks.caloriesTrustworthy === false &&
        m.caloriesKcal != null
      ) {
        m = { ...m, caloriesKcal: null };
      }
      const valueKey = `${m.speedKmh}|${m.cadenceRpm}|${m.powerW}|${m.totalDistanceM}|${m.inclinePct}|${m.elapsedTimeSec}|${m.heartRateBpm}|${m.caloriesKcal}|${m.strokeCount}`;
      if (loggedNotifications < 3 || valueKey !== lastLoggedValueKey) {
        loggedNotifications++;
        lastLoggedValueKey = valueKey;
        const flags = value.byteLength >= 2 ? value.getUint16(0, true) : null;
        // Raw bytes included, not just the decoded fields — a real-device
        // report showed a speed reading jump discontinuously to exactly
        // 1.00 km/h with no plausible physical cause; the raw bytes are what
        // let that get confirmed as a real value the device actually sent
        // (not a parsing artifact on this app's side) rather than staying a
        // guess either way.
        const hex = Array.from(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        logBleEvent(
          `FTMS notification #${loggedNotifications} [${hex}] (flags=${flags != null ? "0x" + flags.toString(16) : "?"}): speedKmh=${m.speedKmh}, cadenceRpm=${m.cadenceRpm}, powerW=${m.powerW}, totalDistanceM=${m.totalDistanceM}, inclinePct=${m.inclinePct}, elapsedTimeSec=${m.elapsedTimeSec}, heartRateBpm=${m.heartRateBpm}, caloriesKcal=${m.caloriesKcal}`,
        );
      }
      const now = Date.now();
      const merged = mergeMetrics(m, now);
      metricsRef.current = merged;
      setMetrics(merged);
      updateAccumulator(merged);
      // Passive conformance recording — sampled down internally, and a no-op
      // when no session is active. See passiveProbe.ts.
      recordFtmsMetrics(
        merged,
        machineRunningRef.current,
        hexFromDataView(value),
        value.byteLength >= 2 ? value.getUint16(0, true) : null,
      );
    };
    characteristic.addEventListener("characteristicvaluechanged", handleValue);
    // Devices whose Data characteristic doesn't support notify at all (rare,
    // but a read-only characteristic previously made startNotifications()
    // throw and took the whole connection down the same false "no FTMS" path
    // as detectCardioType returning null) fall back to polling readValue()
    // at roughly the cadence a notifying device would push at.
    if (
      characteristic.properties.notify ||
      characteristic.properties.indicate
    ) {
      await characteristic.startNotifications();
    } else if (characteristic.properties.read) {
      logBleEvent(
        "FTMS: Data characteristic does not support notify — falling back to polling readValue() once per second.",
      );
      pollIntervalRef.current = setInterval(async () => {
        try {
          // readValue() updates characteristic.value as a side effect, which
          // handleValue reads back out via event.target — same as a real
          // characteristicvaluechanged event would.
          await characteristic.readValue();
          handleValue({ target: characteristic } as unknown as Event);
        } catch {
          /* transient read failure — try again next tick */
        }
      }, 1000);
    } else {
      throw new DOMException(
        "FTMS Data characteristic supports neither notify nor read.",
        "NotFoundError",
      );
    }
    characteristicRef.current = characteristic;
    handleValueRef.current = handleValue;

    // Control Point + feature negotiation is best-effort — many devices
    // (rowers especially) don't expose a Control Point at all, which is
    // normal, not an error. A fresh GATT connection means control must be
    // re-requested, so always reset before trying again.
    hasRequestedControlRef.current = false;
    hasStartedRef.current = false;
    commandQueueRef.current = [];
    controlCharRef.current = null;
    controlHandleRef.current = null;
    setControllable(false);
    setTargetFeatures(null);
    setMachineFeatures(null);
    setTargetSettingFeatures(null);
    setSupportedRanges(EMPTY_SUPPORTED_RANGES);
    try {
      const controlChar = await service.getCharacteristic(CHAR_CONTROL_POINT);
      controlChar.addEventListener(
        "characteristicvaluechanged",
        handleControlIndication,
      );
      await controlChar.startNotifications();
      controlCharRef.current = controlChar;
      controlHandleRef.current = handleControlIndication;
      setControllable(true);
      // Eagerly probe Request Control right away, rather than waiting for
      // the first real Set Target command to discover it the expensive way.
      // A device whose control is already held by another client (the
      // console's own companion app, very common on iFit-adjacent hardware)
      // rejects this immediately with Control Not Permitted — surfacing that
      // now as controlError means the UI shows a real, actionable message
      // the moment the panel opens instead of only on first use, and lets
      // the very first real command skip straight to its own request
      // (hasRequestedControlRef stays true only on success, so a rejection
      // here doesn't block a later legitimate attempt).
      try {
        await sendRawCommand(OP_REQUEST_CONTROL, []);
        hasRequestedControlRef.current = true;
      } catch (err: any) {
        hasRequestedControlRef.current = false;
        if (err instanceof ControlNotPermittedError) {
          setControlError(
            draftText(
              "Another app currently has control of this device — controls may not work until it releases it.",
            ),
          );
        }
        logBleEvent(
          `FTMS: eager Request Control failed (${err?.message || "unknown reason"}) — will retry on first real command.`,
        );
      }
    } catch {
      /* device has no Control Point — stays read-only */
    }

    if (controlCharRef.current) {
      // Fitness Machine Features (bytes 0-3, LE uint32) — previously only
      // the Target Setting Features word (bytes 4-7) was read. Bit 2 here is
      // Total Distance Supported: knowing upfront that a device doesn't
      // support it lets updateAccumulator skip straight to the
      // speed-integrated estimate instead of running its "wait and see if
      // the raw field ever proves itself" dance on a field the device
      // already told us not to trust.
      try {
        const featureChar = await service.getCharacteristic(
          CHAR_FITNESS_MACHINE_FEATURE,
        );
        const value = await featureChar.readValue();
        if (value.byteLength >= 4 && accRef.current) {
          const dataBits = value.getUint32(0, true);
          accRef.current.distanceSupportedByDevice = !!(dataBits & 0x4);
          // Full 17-bit decode — see MachineFeatures's own comment. Recorded
          // for the probe/registry even though nothing here acts on most of
          // these bits yet.
          setMachineFeatures(decodeMachineFeatures(dataBits));
        }
        if (value.byteLength >= 8) {
          const targetBits = value.getUint32(4, true);
          setTargetFeatures({
            speed: !!(targetBits & 0x1),
            incline: !!(targetBits & 0x2),
            resistance: !!(targetBits & 0x4),
            power: !!(targetBits & 0x8),
          });
          setTargetSettingFeatures(decodeTargetSettingFeatures(targetBits));
        }
      } catch {
        /* feature read failed — leave targetFeatures/machineFeatures null, controls fall back to always-shown */
      }

      // All four optional per spec — most devices (rowers, bikes without
      // incline) simply don't have some of these; a missing characteristic
      // just means the UI falls back to its own default range for that target.
      const ranges: SupportedRanges = { ...EMPTY_SUPPORTED_RANGES };
      try {
        const speedChar = await service.getCharacteristic(
          CHAR_SUPPORTED_SPEED_RANGE,
        );
        ranges.speed = parseSupportedSpeedRange(await speedChar.readValue());
      } catch {
        /* not exposed by this device */
      }
      try {
        const inclineChar = await service.getCharacteristic(
          CHAR_SUPPORTED_INCLINATION_RANGE,
        );
        ranges.incline = parseSupportedInclinationRange(
          await inclineChar.readValue(),
        );
      } catch {
        /* not exposed by this device */
      }
      try {
        const resistanceChar = await service.getCharacteristic(
          CHAR_SUPPORTED_RESISTANCE_RANGE,
        );
        ranges.resistance = parseSupportedResistanceRange(
          await resistanceChar.readValue(),
        );
      } catch {
        /* not exposed by this device */
      }
      try {
        const powerChar = await service.getCharacteristic(
          CHAR_SUPPORTED_POWER_RANGE,
        );
        ranges.power = parseSupportedPowerRange(await powerChar.readValue());
      } catch {
        /* not exposed by this device */
      }
      try {
        const heartRateChar = await service.getCharacteristic(
          CHAR_SUPPORTED_HEART_RATE_RANGE,
        );
        ranges.heartRate = parseSupportedHeartRateRange(
          await heartRateChar.readValue(),
        );
      } catch {
        /* not exposed by this device */
      }
      setSupportedRanges(ranges);
    }

    // Machine Status — see parseMachineStatus's header comment. Independent
    // of whether a Control Point was found above: it's a separate optional
    // characteristic, and even a read-only connection benefits from knowing
    // the console's actual Started/Stopped state accurately instead of this
    // app inferring it from raw metrics (see autoDetect in Session.tsx).
    setMachineStatusSupported(false);
    setMachineRunning(null);
    setConsoleTargetSpeedKmh(null);
    setConsoleTargetInclinePct(null);
    setConsoleTargetResistanceLevel(null);
    setConsoleTargetPowerW(null);
    try {
      const statusChar = await service.getCharacteristic(CHAR_MACHINE_STATUS);
      // GATT characteristics that use "indicate" (which Machine Status does)
      // commonly push their last cached value the instant a client
      // subscribes — before anything has actually changed — as a courtesy
      // "here's where things stand" sync, not a live event. A real-device
      // report caught exactly this: one notification landed ~1s after
      // connecting claiming Stopped, while the device's own Data
      // characteristic was simultaneously reporting a real, nonzero speed —
      // physically inconsistent with a genuine "just stopped". That false
      // Stopped then fed straight into Session.tsx's autoDetect and killed
      // the exercise clock 4 seconds into a workout that was actually still
      // running. The first notification per connection is therefore treated
      // as a stale snapshot, not a real event — still logged, just not
      // applied; every notification after it is a genuine change.
      let firstStatusEvent = true;
      const handleStatus = (event: Event) => {
        const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        // Logged raw and in full, every time — unlike the Data characteristic's
        // logging above (throttled to the first few, since that fires several
        // times a second for the whole workout), Machine Status only fires on
        // an actual change, so this stays cheap while being the only way to
        // confirm a specific device's byte layout actually matches
        // parseMachineStatus's assumptions (a real report found the numeric
        // target fields reading back 0 on one real device despite Started/
        // Stopped decoding correctly, so those op codes' payload layout is
        // evidently wrong for at least that device/firmware).
        const hex = Array.from(
          new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
        )
          .map((b) => b.toString(16).padStart(2, "0"))
          .join(" ");
        const evt = parseMachineStatus(
          value,
          speedWriteScaleRef.current,
          inclineWriteScaleRef.current,
        );
        const isFirst = firstStatusEvent;
        firstStatusEvent = false;
        logBleEvent(
          `FTMS Machine Status raw: [${hex}] -> ${evt ? JSON.stringify(evt) : "(unrecognized op code, ignored)"}${isFirst ? " (first event since connecting — treated as a stale snapshot, not applied)" : ""}`,
        );
        recordPassiveObservation({
          kind: "machineStatus",
          at: Date.now(),
          rawHex: hex,
          opCode: value.getUint8(0),
          decoded: evt as Record<string, unknown> | null,
          isFirstSinceConnect: isFirst,
        });
        if (
          !evt ||
          (isFirst &&
            lookupQuirks("FTMS", device.name).machineStatusFirstEventStale)
        )
          return;
        if (evt.running !== undefined) {
          setMachineRunning(evt.running);
          machineRunningRef.current = evt.running;
        }
        // The device revoked control before this app ever tried a command
        // and got the expected 0x05 rejection — clear the flag proactively
        // so the next command re-requests control up front instead of
        // failing once first (see MachineStatusEvent.controlPermissionLost's
        // own comment).
        if (evt.controlPermissionLost) {
          hasRequestedControlRef.current = false;
          hasStartedRef.current = false;
          logBleEvent(
            "FTMS Machine Status: control permission lost — will re-request on next command.",
          );
        }
        // The device's own odometer/session state was reset (op code 0x01) —
        // distinct from a Stop: this means distance tracking should restart
        // from whatever the device reports next, same as the mid-session
        // reset case updateAccumulator's distance logic already banks
        // accumulated distance for.
        if (evt.reset)
          logBleEvent(
            "FTMS Machine Status: device reset — distance baseline will re-capture from the next reading.",
          );
        // Speed/incline: applied now — a real-device report confirmed the
        // decode against this app's own control writes (see
        // parseMachineStatus's comment: raw bytes sent for a 3.0 km/h / 3%
        // target came back verbatim, and the device's own next reading
        // matched). Exact-0 is filtered out rather than applied, though —
        // every report so far shows a spurious "0" notification immediately
        // following every real value (visible right in the raw bytes: e.g.
        // targetSpeedKmh 3.0 immediately followed by another notification
        // reading exactly 0, with nothing in between that could account for
        // a real change back to a full stop), consistently enough across
        // separate sessions that it reads as a device-side artifact of the
        // write itself rather than a genuine second target change.
        if (evt.targetSpeedKmh !== undefined) {
          if (
            evt.targetSpeedKmh !== 0 ||
            !lookupQuirks("FTMS", device.name).targetEchoZeroArtifact
          )
            setConsoleTargetSpeedKmh(evt.targetSpeedKmh);
          else
            logBleEvent(
              "FTMS Machine Status: target speed changed to 0 km/h — ignored as a known write-echo artifact.",
            );
        }
        if (evt.targetInclinePct !== undefined) {
          if (
            evt.targetInclinePct !== 0 ||
            !lookupQuirks("FTMS", device.name).targetEchoZeroArtifact
          )
            setConsoleTargetInclinePct(evt.targetInclinePct);
          else
            logBleEvent(
              "FTMS Machine Status: target incline changed to 0% — ignored as a known write-echo artifact.",
            );
        }
        // Resistance/power: still logged only, not applied — resistance's
        // decode is now believed correct (UINT8×0.1, matching the spec text
        // and pyftms — see parseMachineStatus's own comment on why the
        // earlier SINT16 guess was wrong), but "believed correct" isn't the
        // same as "confirmed against a real device" the way speed/incline
        // now are, so it stays logged-only until one is.
        if (evt.targetResistanceLevel !== undefined)
          setConsoleTargetResistanceLevel(evt.targetResistanceLevel);
        if (evt.targetResistanceLevel !== undefined)
          logBleEvent(
            `FTMS Machine Status: target resistance changed to ${evt.targetResistanceLevel} (not applied — unconfirmed against real hardware).`,
          );
        if (evt.targetPowerW !== undefined)
          setConsoleTargetPowerW(evt.targetPowerW);
        if (evt.targetPowerW !== undefined)
          logBleEvent(
            `FTMS Machine Status: target power changed to ${evt.targetPowerW}W (not applied — unconfirmed scale).`,
          );
        // Closes the loop on spinDownControl/setSimulationGrade, both of
        // which previously fired with no way to learn the outcome.
        if (evt.spinDownStatus !== undefined)
          logBleEvent(
            `FTMS Machine Status: spin-down status ${evt.spinDownStatus} (1=Requested, 2=Success, 3=Error, 4=StopPedaling).`,
          );
        if (evt.simulationParamsChangedHex !== undefined)
          logBleEvent(
            `FTMS Machine Status: indoor bike simulation parameters changed [${evt.simulationParamsChangedHex}].`,
          );
        if (evt.unhandledOpCode !== undefined)
          logBleEvent(
            `FTMS Machine Status: unhandled op code 0x${evt.unhandledOpCode.toString(16)}.`,
          );
      };
      statusChar.addEventListener("characteristicvaluechanged", handleStatus);
      await statusChar.startNotifications();
      machineStatusCharRef.current = statusChar;
      machineStatusHandleRef.current = handleStatus;
      setMachineStatusSupported(true);
      logBleEvent(
        "FTMS: Machine Status supported — console-side changes will sync live.",
      );
    } catch {
      logBleEvent(
        "FTMS: Machine Status not exposed by this device — falling back to the settle-based sync heuristic.",
      );
    }
  }, [
    updateAccumulator,
    handleControlIndication,
    teardownCharacteristicListeners,
    mergeMetrics,
    sendRawCommand,
  ]);

  const cleanupState = useCallback(() => {
    endPassiveSession();
    machineRunningRef.current = null;
    deviceRef.current = null;
    charUuidRef.current = null;
    detectedCardioTypeRef.current = null;
    characteristicRef.current = null;
    handleValueRef.current = null;
    controlCharRef.current = null;
    controlHandleRef.current = null;
    machineStatusCharRef.current = null;
    machineStatusHandleRef.current = null;
    hasRequestedControlRef.current = false;
    hasStartedRef.current = false;
    accRef.current = null;
    rejectPendingControl(draftText("Device disconnected."));
    setConnected(false);
    setReconnecting(false);
    setReconnectAttempt(0);
    setDeviceName(null);
    setMetrics(EMPTY_METRICS);
    setSummary(null);
    setControllable(false);
    setControlBusy(false);
    setControlError("");
    setTargetFeatures(null);
    setMachineFeatures(null);
    setTargetSettingFeatures(null);
    setSupportedRanges(EMPTY_SUPPORTED_RANGES);
    setMachineStatusSupported(false);
    setMachineRunning(null);
    setConsoleTargetSpeedKmh(null);
    setConsoleTargetInclinePct(null);
    setConsoleTargetResistanceLevel(null);
    setConsoleTargetPowerW(null);
    metricsRef.current = EMPTY_METRICS;
    lastFieldSeenAtRef.current = {};
    speedWriteScaleRef.current = DEFAULT_SPEED_WRITE_SCALE;
    inclineWriteScaleRef.current = DEFAULT_INCLINE_WRITE_SCALE;
    speedScaleCalibratedRef.current = false;
    inclineScaleCalibratedRef.current = false;
  }, [rejectPendingControl]);

  const attemptReconnect = useCallback(
    async (attempt: number, token: number) => {
      if (token !== reconnectTokenRef.current) return; // superseded by a manual disconnect/new connect
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        const name = accRef.current?.deviceName || draftText("the device");
        logBleEvent(
          `Reconnect exhausted (${MAX_RECONNECT_ATTEMPTS} attempts) — giving up on "${name}".`,
        );
        cleanupState();
        setError(
          draftFormat("Lost connection to {device} and could not reconnect.", {
            device: name,
          }),
        );
        return;
      }
      logBleEvent(
        `Reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} starting.`,
      );
      setReconnectAttempt(attempt + 1);
      await sleep(RECONNECT_BACKOFF_MS[attempt]);
      if (token !== reconnectTokenRef.current) return;
      try {
        await attach();
        if (token !== reconnectTokenRef.current) return;
        logBleEvent(`Reconnect attempt ${attempt + 1} succeeded.`);
        setReconnecting(false);
        setReconnectAttempt(0);
        setConnected(true);
        setError("");
      } catch (err: any) {
        logBleEvent(
          `Reconnect attempt ${attempt + 1} failed: ${err?.message || err?.name || "unknown error"}`,
        );
        attemptReconnect(attempt + 1, token);
      }
    },
    [attach, cleanupState],
  );

  const disconnect = useCallback(() => {
    logBleEvent(
      `User-initiated disconnect from "${accRef.current?.deviceName || deviceRef.current?.name || "device"}".`,
    );
    intentionalRef.current = true;
    reconnectTokenRef.current++;
    teardownCharacteristicListeners();
    if (disconnectedDeviceRef.current && disconnectedHandlerRef.current) {
      try {
        disconnectedDeviceRef.current.removeEventListener(
          "gattserverdisconnected",
          disconnectedHandlerRef.current,
        );
      } catch {}
      disconnectedDeviceRef.current = null;
      disconnectedHandlerRef.current = null;
    }
    try {
      deviceRef.current?.gatt?.disconnect();
    } catch {}
    cleanupState();
  }, [cleanupState, teardownCharacteristicListeners]);

  // `onFtmsUnavailable`, when given, is invoked with the already-selected
  // BluetoothDevice the instant we learn it has no FTMS service — letting a
  // caller (see sessionStore.tsx) hand that same device straight to the iFit
  // fallback without a second requestDevice() picker. That's the key trick:
  // requestDevice() itself needs a fresh user gesture and can't be triggered
  // programmatically, but a *new GATT connection on an already-selected
  // device* doesn't — so the fallback can run automatically here even though
  // the original pick happened inside this same click handler's call stack.
  //
  // `onCardioTypeDetected`, when given, fires once right after a successful
  // attach() if what the device actually turned out to be (see
  // detectCardioType) doesn't match the `cardioType` this was called with —
  // e.g. the user was sitting on a "Bike" warmup slot but picked their
  // treadmill. The caller (sessionStore.tsx) uses this to relabel the
  // current exercise to match, without touching the connection it's already
  // made.
  const connect = useCallback(
    async (
      cardioType: CardioType,
      onFtmsUnavailable?: (device: BluetoothDevice) => void,
      onCardioTypeDetected?: (detected: CardioType) => void,
      // Escape hatch for a device the name-prefix/service filters below don't
      // match at all — some FTMS machines (various Domyos/Kettler/Sole/Horizon
      // units observed in the wild) omit the FTMS service UUID from their
      // small advertisement packet *and* aren't iFit-branded, so they never
      // show up in the filtered picker with no indication why. runBleDiagnostic
      // already solved this for the diagnostic flow with acceptAllDevices; this
      // lets the same escape hatch be reached from the normal connect button.
      findAnyDevice = false,
      previouslyGrantedDevice?: BluetoothDevice,
    ) => {
      logBleEvent(
        `FTMS connect() called for ${cardioType}${findAnyDevice ? " (showing all nearby devices)" : ""}`,
      );
      if (!supported) {
        setError(draftText("Web Bluetooth is not supported in this browser."));
        return;
      }
      setError("");
      setConnecting(true);
      intentionalRef.current = false;
      reconnectTokenRef.current++;
      const token = reconnectTokenRef.current;
      let device: BluetoothDevice;
      try {
        // Filters are OR'd — this still matches genuine FTMS devices, but also
        // surfaces equipment (e.g. iFit-branded NordicTrack/ProForm gear) that
        // advertises its name but not the FTMS service UUID in its small
        // advertisement packet, so the picker isn't empty for those either.
        // iFit's own naming convention is "I_" + a short equipment code (a real
        // NordicTrack RW300 rower advertises as "I_RW" — presumably "I_TM" for
        // treadmills, "I_BK" for bikes, etc.) — matching just "I_IT" (a guess)
        // missed it entirely, so this matches the whole "I_" family instead.
        device =
          previouslyGrantedDevice ??
          (findAnyDevice
            ? await navigator.bluetooth!.requestDevice({
                acceptAllDevices: true,
                optionalServices: [FTMS_SERVICE, IFIT_SERVICE_UUID],
              })
            : await navigator.bluetooth!.requestDevice({
                filters: [
                  { services: [FTMS_SERVICE] },
                  { namePrefix: "NordicTrack" },
                  { namePrefix: "ProForm" },
                  { namePrefix: "iFit" },
                  { namePrefix: "I_" },
                ],
                optionalServices: [FTMS_SERVICE, IFIT_SERVICE_UUID],
              }));
      } catch (err: any) {
        // A user-cancelled chooser dialog (or no matching device found at all)
        // also throws NotFoundError here — that's not a real error, stay silent.
        if (err?.name !== "NotFoundError") {
          logBleEvent(
            `Device picker failed: ${err?.message || err?.name || "unknown error"}`,
          );
          setError(adminError(err, "Could not connect to device."));
        } else {
          logBleEvent("Device picker cancelled by user.");
        }
        setConnecting(false);
        return;
      }
      logBleEvent(
        `Device picker: selected "${device.name || "unnamed device"}"`,
      );
      try {
        // Tear down any previous connection's disconnect listener before
        // attaching this one — see disconnectedDeviceRef's comment above.
        if (disconnectedDeviceRef.current && disconnectedHandlerRef.current) {
          try {
            disconnectedDeviceRef.current.removeEventListener(
              "gattserverdisconnected",
              disconnectedHandlerRef.current,
            );
          } catch {}
        }
        deviceRef.current = device;
        cardioTypeRef.current = cardioType;
        const name = device.name || "Fitness Device";
        accRef.current = freshAccumulator(cardioType, name);
        // A registry entry that already knows this machine's Total Distance
        // field is unreliable saves the accumulator the opening stretch of
        // every session spent discovering it the slow way (see
        // distanceSupportedByDevice / distanceRawTrusted).
        const knownQuirks = lookupQuirks("FTMS", device.name);
        if (knownQuirks.distanceTrustworthy === false) {
          accRef.current.distanceSupportedByDevice = false;
          logBleEvent(
            "FTMS: registry marks this device's Total Distance as unreliable — using the speed-integrated estimate from the first reading.",
          );
        }

        const onGattDisconnected = () => {
          if (intentionalRef.current) return; // handled by disconnect() itself
          logBleEvent(
            `Unexpected GATT disconnect from "${name}" — starting reconnect.`,
          );
          rejectPendingControl(draftText("Device disconnected."));
          setConnected(false);
          setReconnecting(true);
          attemptReconnect(0, token);
        };
        device.addEventListener("gattserverdisconnected", onGattDisconnected);
        disconnectedDeviceRef.current = device;
        disconnectedHandlerRef.current = onGattDisconnected;

        await attach();
        logBleEvent(
          `Connected to "${name}" via FTMS (controllable: ${controlCharRef.current != null}).`,
        );
        setDeviceName(name);
        setConnected(true);
        // Passive conformance recording for the whole workout, so a later
        // "Report a connection issue" ships findings instead of raw log.
        beginPassiveSession(
          "FTMS",
          name,
          cardioType,
          detectedCardioTypeRef.current,
        );
        recordPassiveObservation({
          kind: "discovery",
          at: Date.now(),
          serviceUuids: [],
          dataCharacteristicUuid: characteristicRef.current?.uuid ?? null,
          dataCharacteristicProperties: [],
          detectedCardioType: detectedCardioTypeRef.current,
          requestedCardioType: cardioType,
          hasControlPoint: controlCharRef.current != null,
          hasMachineStatus: machineStatusCharRef.current != null,
        });
        const detected = detectedCardioTypeRef.current;
        if (detected && detected !== cardioType) {
          logBleEvent(
            `Detected "${name}" is actually a ${detected} (was connecting as ${cardioType}) — relabeling.`,
          );
          onCardioTypeDetected?.(detected);
        }
      } catch (err: any) {
        // Past this point a device was already chosen and GATT-connected, so any
        // error — including a "NotFoundError" from getPrimaryService when the
        // device has no FTMS service at all — is real and must be surfaced, not
        // silently swallowed the way a chooser-cancel is above.
        const notFtms = err?.name === "NotFoundError";
        logBleEvent(
          notFtms
            ? `"${device.name || "device"}" has no FTMS service — falling back to iFit.`
            : `FTMS connect failed for "${device.name || "device"}": ${err?.message || err?.name || "unknown error"}`,
        );
        setError(
          notFtms
            ? draftFormat(
                "Connected to {value0}, but it doesn't support the standard Bluetooth fitness protocol (FTMS). This is common on iFit-branded equipment, which typically uses a proprietary connection instead.",
                { value0: device.name || draftText("the device") },
              )
            : adminError(err, "Could not connect to device."),
        );
        // device.gatt.connect() already succeeded by this point (the failure
        // was later, e.g. getPrimaryService not finding FTMS) — cleanupState()
        // below only nulls local refs, leaving the browser's GATT session open
        // with nothing in this hook able to reach it. That leaked session can
        // then interfere with the very next connection attempt to the same
        // physical device (e.g. immediately trying the iFit fallback). Mark
        // this intentional first, same as disconnect() does, so the
        // gattserverdisconnected listener registered above doesn't treat the
        // disconnect this triggers as a dropped connection and kick off a
        // pointless reconnect loop that would overwrite the error just set.
        intentionalRef.current = true;
        reconnectTokenRef.current++;
        try {
          device.gatt?.disconnect();
        } catch {}
        cleanupState();
        if (notFtms) {
          // gatt.disconnect() doesn't return a promise — it tears the session
          // down asynchronously at the OS level, and this device's own
          // 'gattserverdisconnected' listener above is being ignored right now
          // (intentionalRef is true). Handing the device to the iFit fallback
          // before that teardown actually finishes raced its immediate
          // device.gatt.connect() against the still-closing FTMS session and
          // failed with a generic GATT error — wait for the real disconnect
          // event first (bounded by a short timeout in case this platform
          // never fires one for a self-initiated disconnect).
          await new Promise<void>((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              try {
                device.removeEventListener("gattserverdisconnected", finish);
              } catch {}
              resolve();
            };
            device.addEventListener("gattserverdisconnected", finish);
            setTimeout(finish, 800);
          });
          onFtmsUnavailable?.(device);
        }
      } finally {
        setConnecting(false);
      }
    },
    [supported, attach, attemptReconnect, cleanupState, rejectPendingControl],
  );

  // Disconnect on unmount (e.g. the whole app tearing down) — flag intentional
  // first so an in-flight reconnect loop doesn't fire after unmount. Also
  // tears down the characteristic listeners themselves (unlike disconnect(),
  // this previously only called gatt.disconnect()) — gatt.disconnect() tears
  // the connection down asynchronously, so a characteristicvaluechanged event
  // already in flight at unmount time could still land and call setMetrics/
  // setControllable/etc. on a component that's gone.
  useEffect(
    () => () => {
      intentionalRef.current = true;
      reconnectTokenRef.current++;
      teardownCharacteristicListeners();
      try {
        deviceRef.current?.gatt?.disconnect();
      } catch {}
    },
    [teardownCharacteristicListeners],
  );

  return {
    supported,
    connecting,
    connected,
    reconnecting,
    reconnectAttempt,
    deviceName,
    getDevice: () => deviceRef.current,
    metrics,
    summary,
    error,
    connect,
    disconnect,
    controllable,
    controlBusy,
    controlError,
    targetFeatures,
    machineFeatures,
    targetSettingFeatures,
    supportedRanges,
    setTargetPower,
    setTargetSpeed,
    setTargetIncline,
    setTargetResistance,
    emergencyStop,
    pauseDevice,
    startDevice,
    // New Control Point ops (see this file's OP_SET_SIMULATION_PARAMS/OP_RESET/
    // OP_SPIN_DOWN_CONTROL) — not yet wired into any UI control, but exposed
    // here the same way every other command is, for a future sim-mode/reset/
    // spin-down control surface.
    setSimulationGrade,
    resetDevice,
    spinDownControl,
    machineStatusSupported,
    machineRunning,
    consoleTargetSpeedKmh,
    consoleTargetInclinePct,
    consoleTargetResistanceLevel,
    consoleTargetPowerW,
  };
}
