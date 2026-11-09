import { fitnessPickerOptions } from "./bluetoothPicker";
// Monitor + best-effort control client for the iFit proprietary BLE protocol
// (used by NordicTrack/ProForm treadmills and rowers, which don't implement
// standard FTMS — see ble.ts's header). Implements the protocol exactly as
// documented in the repo's IFIT_PROTOCOL.md — that doc was rewritten from
// decompiled source (a real Shire.Core.dll / Sindarin.FitPro1.Core.dll, see
// its own header for provenance), not inferred from packet captures, so it's
// the more authoritative source wherever this file's older empirically-
// derived comments disagree with it: three-layer framing (BLE chunking,
// command signature + checksum, characteristic bitmaps/values). Monitoring
// uses the doc's "monitor-only mode" — WRITE_AND_READ (0x02) with an empty
// write bitmap — which needs no ENABLE/activation-code handshake.
//
// Control (setTargetSpeed/setTargetIncline, Treadmill only — Kph/Incline are
// the only writable characteristics this protocol documents) sends a real
// write bitmap+values the same way, preceded once per connection by ENABLE
// (0x90) with a computed activation payload, fetched from the API rather
// than computed here — see fetchActivationPayload below and
// src/src/routes/ifit.ts, whose comments carry the exact derivation
// (CalculateSecurityHash, straight from the decompiled source) and
// IFIT_PROTOCOL.md's "ENABLE / Activation-Code Handshake" section. This
// replaced an earlier per-model hardcoded lookup table (now also moved
// server-side, see ifit.ts's API-route comment) — the computed payload
// works for any device, not just the ones someone happened to capture a
// code for.
// UNVERIFIED against real hardware beyond the RW300 capture that confirmed
// the checksum/framing/RX-TX direction — if a real device rejects or
// ignores writes, controlError will surface whatever the device actually
// does (or doesn't) send back.
//
// One caveat: IFIT_PROTOCOL.md's own history — earlier drafts labeled the
// two characteristics "RX (client writes)" = ...1535... and "TX (client
// receives)" = ...1534..., which was backwards; both a real NordicTrack
// RW300 capture and the decompiled connection code (which writes to
// "DeviceRx" = ...1534... and subscribes to "DeviceTx" = ...1535...) agree
// on the mapping this module already uses.
import { useCallback, useRef, useState } from "react";
import type { CardioType, CardioBleSummary } from "./types";
import { logBleEvent } from "./bleLog";
import { api } from "./api";
import { lookupQuirks, describeMatch } from "./deviceRegistry";
import {
  beginPassiveSession,
  endPassiveSession,
  recordIfitMetrics,
} from "./passiveProbe";
import { adminError, draftFormat, draftText } from "./i18n/adminDraft";

export const IFIT_SERVICE_UUID = "00001533-1412-efde-1523-785feabcd123";
const IFIT_WRITE_UUID = "00001534-1412-efde-1523-785feabcd123";
const IFIT_NOTIFY_UUID = "00001535-1412-efde-1523-785feabcd123";

// The full Device (bus address) enum, transcribed from the decompiled
// Sindarin.FitPro1.DataObjects.Device enum — not just the 3 values this app
// used to know about. MAIN (2) is the address DeviceInfo is always sent to;
// every other value here is what the device's *own response* echoes back
// (response byte 0, full-frame offset 4), which is how the app learns what
// equipment it's actually talking to (see attachDevice). GENERAL is kept as
// an alias of MAIN for anything still referring to the old name.
const EQUIPMENT = {
  MAIN: 0x02,
  GENERAL: 0x02,
  PORTAL: 0x03,
  TREADMILL: 0x04,
  INCLINE_TRAINER: 0x05,
  ELLIPTICAL: 0x06,
  FITNESS_BIKE: 0x07,
  SPIN_BIKE: 0x08,
  VERTICAL_ELLIPTICAL: 0x09,
  VIBRATION: 0x0a,
  STAIR_CLIMBER: 0x0b,
  SKIER: 0x0c,
  FITNESS_WEIGHT_MACHINE: 0x0d,
  FREE_STRIDER: 0x13,
  ROWER: 0x14,
} as const;

// What CardioType a given Device address maps to, for classifying whatever
// equipment DeviceInfo's response says this console actually is. Deliberately
// partial — sub-device ids and anything not in this app's 4-way CardioType
// model fall back to whatever the caller originally requested (see
// attachDevice), the same way FTMS's detectCardioType degrades for Cross
// Trainer/Step Climber/Stair Climber.
const DEVICE_TO_CARDIO_TYPE: Partial<Record<number, CardioType>> = {
  [EQUIPMENT.TREADMILL]: "Treadmill",
  [EQUIPMENT.INCLINE_TRAINER]: "Treadmill",
  [EQUIPMENT.ROWER]: "Rower",
  [EQUIPMENT.FITNESS_BIKE]: "Bike",
  [EQUIPMENT.SPIN_BIKE]: "Bike",
  [EQUIPMENT.ELLIPTICAL]: "Other",
  [EQUIPMENT.VERTICAL_ELLIPTICAL]: "Other",
  [EQUIPMENT.STAIR_CLIMBER]: "Other",
  [EQUIPMENT.SKIER]: "Other",
  [EQUIPMENT.FITNESS_WEIGHT_MACHINE]: "Other",
  [EQUIPMENT.FREE_STRIDER]: "Other",
};

const COMMAND_WRITE_AND_READ = 0x02;
const COMMAND_ENABLE = 0x90;
const COMMAND_DEVICE_INFO = 0x81;
const COMMAND_SYSTEM_INFO = 0x82;
const COMMAND_VERSION_INFO = 0x84;
const COMMAND_EQUIPMENT_SERIAL = 0x95;
// Two more the official app issues during its own startup handshake (see the
// real capture in ifitCapture.fixture.ts) but which nothing in the monitor/
// control path has needed so far. The device probe
// queries them because they are precisely the "what can this machine do"
// questions a registry wants answered, and they cost one round trip each.
const COMMAND_SUPPORTED_CAPABILITIES = 0x80;
const COMMAND_SUPPORTED_COMMANDS = 0x88;

// Sindarin.FitPro1.DataObjects.WorkoutMode, the enum BitField 12 carries —
// transcribed from the decompile. BitField 12 is *writable*
// (`[BitFieldInfo(typeof(ModeConverter), readOnly: false)]`), which is what
// makes start/stop possible on this protocol at all: it has no dedicated
// Start or Stop command the way FTMS does, so driving the console's mode is
// the mechanism. Corroborated by the official app's own captured startup
// sequence, which ends by writing BitField 12 = 2.
export const WORKOUT_MODE = {
  UNKNOWN: 0,
  IDLE: 1,
  RUNNING: 2,
  PAUSE: 3,
  RESULTS: 4,
  DEBUG: 5,
  LOG: 6,
  MAINTENANCE: 7,
  DMK: 8,
  DEMO: 9,
  WARM_UP: 10,
  COOL_DOWN: 11,
  SLEEP: 12,
  RESUME: 13,
  LOCKED: 14,
  PAUSE_OVERRIDE: 20,
} as const;
export const CHAR_ID_WORKOUT_MODE = 12;
export const CHAR_ID_KPH = 0;

// --- FitPro2: the other protocol generation on the same BLE service --------
//
// iFit's equipment library ("Sindarin") has two protocol generations, and the
// decompiled Sindarin.Core.Ble.KnownTypes registry contains exactly ONE
// "Fit Pro" service and ONE DeviceTx/DeviceRx pair for both of them — so BLE
// discovery cannot tell a FitPro1 console from a FitPro2 one. Everything in
// this file speaks FitPro1. A FitPro2 console therefore connects fine, gets
// FitPro1 frames it does not understand, answers nothing, and looks exactly
// like a broken or unresponsive device.
//
// FitPro2 framing is much simpler and, crucially, has NO checksum:
//   request:  [CommunicationType(=2), Device|Command, PayloadLength, ...payload]
//   response: [reserved,              Device|Response, PayloadLength, ...payload]
// Device is the top nibble (App=0, Console=0x10, Controller1=0x20,
// Controller2=0x30 — bus addressing, not the equipment type FitPro1 packs
// here), Command the bottom nibble.
//
// Note the first byte is 0x02 in *both* generations (FitPro1's frame opens
// 0x02 0x04 0x02, and CommunicationType.FitPro2 is literally 2), so the
// leading byte is not a discriminator — only sending a FitPro2 command and
// getting a well-formed FitPro2 response is.
//
// This app does not implement FitPro2. These constants exist purely so the
// device probe can *identify* such a console and say so, instead of
// reporting a working machine as dead.
export const FITPRO2_COMMUNICATION_TYPE = 0x02;
export const FITPRO2_DEVICE = {
  APP: 0x00,
  CONSOLE: 0x10,
  CONTROLLER1: 0x20,
  CONTROLLER2: 0x30,
} as const;
export const FITPRO2_COMMAND = {
  SUBSCRIBE: 1,
  WRITE: 2,
  SUPPORTED_FEATURES: 6,
  UNSUBSCRIBE: 7,
  BOOTLOADER: 9,
  EXTENDED: 0xe,
} as const;
export const FITPRO2_RESPONSE = {
  FEATURES: 1,
  ACKNOWLEDGE: 3,
  ERROR: 4,
  EVENT: 5,
  EXTENDED: 0xe,
} as const;

/**
 * A FitPro2 request frame. Used by the probe for a single read-only
 * SupportedFeatures query — the cheapest possible "are you a FitPro2
 * console?" test, with an empty payload and no side effects.
 */
export function buildFitPro2Frame(
  device: number,
  command: number,
  payload: number[] = [],
): number[] {
  return [
    FITPRO2_COMMUNICATION_TYPE,
    (device | command) & 0xff,
    payload.length,
    ...payload,
  ];
}

/**
 * Recognizes a well-formed FitPro2 response. Deliberately strict: the point
 * is to distinguish a real FitPro2 answer from FitPro1 chunk noise, so the
 * declared payload length must actually match the bytes present and the
 * response nibble must be one the protocol defines.
 */
export function parseFitPro2Response(
  bytes: number[],
): { device: number; response: number; payload: number[] } | null {
  if (bytes.length < 3) return null;
  const device = bytes[1] & 0xf0;
  const response = bytes[1] & 0x0f;
  const payloadLength = bytes[2];
  if (!Object.values(FITPRO2_RESPONSE).includes(response as any)) return null;
  if (bytes.length < 3 + payloadLength) return null;
  return { device, response, payload: bytes.slice(3, 3 + payloadLength) };
}

// 'grade' is identical to 'double' (scaled uint16, ×100) except it decodes
// as SIGNED — IFIT_PROTOCOL.md's decompiled GradeConverter casts to a signed
// 16-bit value before dividing, unlike SpeedConverter, so incline/grade
// fields support negative (decline) values that speed fields never need to.
// 'raw16' is a plain unscaled uint16 — used for Resistance, whose formula
// (see resistanceLevelToRaw) already produces the final wire value itself,
// unlike every other numeric field here which needs encodeValue's own ×100
// or similar scaling applied on top of a "natural" value.
// 'burnRate' is the same shape as 'grade' (signed scaled uint16) but scaled
// ×1000 instead of ×100 — the decompiled BurnRateConverter's own formula.
// 'string45' is a fixed 45-byte UTF-8 field (StringConverter's own size — it
// is not variable-length, despite the name), and 'blob' covers the
// structured converters whose internal layout this app has no use for
// (KeyObject 14B, Gear 8B, AudioSource 3B, the Interval* pair 4B). Both exist
// so the *width* is right: decodeReadValues walks the response at fixed
// offsets, so a field with the wrong size silently shifts every value after
// it. Neither emits a decoded value — a width is all that is needed to stay
// aligned, and inventing a number for bytes whose meaning is unknown is
// exactly the "fabricated zero" problem in a different costume.
// 'verticalMeter' is VerticalMeterConverter's own encoding: unsigned uint32,
// ÷10000 — a distinct format from 'scaled32' (Calories' own ×1e8/÷1024
// formula), previously mistyped as plain 'uint32' for ids 75/76 (nothing read
// those two yet, so this was latent rather than live).
type CharType =
  | "uint8"
  | "uint16"
  | "uint32"
  | "bool"
  | "double"
  | "grade"
  | "raw16"
  | "scaled32"
  | "burnRate"
  | "verticalMeter"
  | "pulse"
  | "string45"
  | "blob";
interface CharDef {
  id: number;
  name: string;
  type: CharType;
  size: number;
  // From the decompiled BitFieldInfo attribute's own `readOnly` flag. Writing
  // a read-only field is pointless, and knowing which fields are writable is
  // what lets the probe choose a control test that can actually do something.
  readOnly: boolean;
}

// The COMPLETE BitField table, transcribed from the decompiled
// Sindarin.FitPro1.Bits.BitField enum in ifit-old2 (99 entries) rather than
// from the handful this app happened to need — ids, widths and read-only
// flags all come straight from the [BitFieldInfo(typeof(XConverter), ro)]
// attribute on each member, so nothing here is inferred.
//
// Every one of the 30 entries this table previously held was verified against
// that ground truth and none had the wrong width; the other 69 were simply
// absent, which meant the probe's capability sweep had to skip them and a
// real rower reported "70 fields declared, 12 readable". Widths matter even
// for fields nothing reads: decodeReadValues walks a response at fixed
// offsets, so a gap in this table is a value that cannot be requested at all
// without shifting everything after it.
//
// READ_IDS_BY_CARDIO_TYPE is deliberately unchanged — the live monitor path
// still asks for the same small set. This table is what makes the *probe*
// able to ask for everything.
const CHAR_TABLE: CharDef[] = [
  { id: 0, name: "Kph", type: "double", size: 2, readOnly: false },
  { id: 1, name: "Incline", type: "grade", size: 2, readOnly: false },
  { id: 2, name: "Resistance", type: "raw16", size: 2, readOnly: false },
  { id: 3, name: "Watts", type: "uint16", size: 2, readOnly: true },
  { id: 4, name: "CurrentDistance", type: "uint32", size: 4, readOnly: true },
  { id: 5, name: "Rpm", type: "uint16", size: 2, readOnly: true },
  { id: 6, name: "Distance", type: "uint32", size: 4, readOnly: true },
  { id: 7, name: "KeyObject", type: "blob", size: 14, readOnly: true },
  { id: 8, name: "FanSpeed", type: "uint8", size: 1, readOnly: false },
  { id: 9, name: "Volume", type: "uint8", size: 1, readOnly: false },
  { id: 10, name: "Pulse", type: "pulse", size: 4, readOnly: false },
  { id: 11, name: "UpTime", type: "uint32", size: 4, readOnly: true },
  { id: 12, name: "Mode", type: "uint8", size: 1, readOnly: false },
  { id: 13, name: "Calories", type: "scaled32", size: 4, readOnly: true },
  { id: 14, name: "AudioSource", type: "blob", size: 3, readOnly: false },
  { id: 15, name: "LapTime", type: "uint16", size: 2, readOnly: true },
  { id: 16, name: "CurrentKph", type: "double", size: 2, readOnly: true },
  { id: 17, name: "CurrentIncline", type: "grade", size: 2, readOnly: true },
  { id: 18, name: "ActualResistance", type: "raw16", size: 2, readOnly: true },
  { id: 19, name: "ActualDistance", type: "uint32", size: 4, readOnly: true },
  { id: 20, name: "CurrentTime", type: "uint32", size: 4, readOnly: true },
  {
    id: 21,
    name: "CurrentCalories",
    type: "scaled32",
    size: 4,
    readOnly: true,
  },
  { id: 22, name: "GoalTime", type: "uint32", size: 4, readOnly: false },
  { id: 23, name: "IntervalKph", type: "blob", size: 4, readOnly: true },
  { id: 24, name: "Age", type: "uint8", size: 1, readOnly: false },
  { id: 25, name: "Weight", type: "double", size: 2, readOnly: false },
  { id: 26, name: "Gear", type: "blob", size: 8, readOnly: false },
  { id: 27, name: "MaxIncline", type: "grade", size: 2, readOnly: true },
  { id: 28, name: "MinIncline", type: "grade", size: 2, readOnly: true },
  { id: 29, name: "TransMax", type: "uint16", size: 2, readOnly: false },
  { id: 30, name: "MaxKph", type: "double", size: 2, readOnly: true },
  { id: 31, name: "MinKph", type: "double", size: 2, readOnly: true },
  { id: 34, name: "IdleTimeout", type: "uint16", size: 2, readOnly: false },
  { id: 35, name: "PauseTimeout", type: "uint16", size: 2, readOnly: false },
  { id: 36, name: "Metric", type: "bool", size: 1, readOnly: false },
  { id: 37, name: "Gender", type: "bool", size: 1, readOnly: false },
  { id: 38, name: "FirstName", type: "string45", size: 45, readOnly: false },
  { id: 39, name: "LastName", type: "string45", size: 45, readOnly: false },
  { id: 40, name: "UserName", type: "string45", size: 45, readOnly: false },
  { id: 41, name: "Height", type: "uint16", size: 2, readOnly: false },
  {
    id: 42,
    name: "MaxResistanceLevel",
    type: "uint8",
    size: 1,
    readOnly: true,
  },
  { id: 43, name: "MaxWeight", type: "double", size: 2, readOnly: true },
  { id: 44, name: "WarmupDistance", type: "uint32", size: 4, readOnly: true },
  { id: 45, name: "WarmupTime", type: "uint16", size: 2, readOnly: true },
  { id: 46, name: "WarmupTimeout", type: "uint16", size: 2, readOnly: false },
  { id: 47, name: "WarmupCalories", type: "scaled32", size: 4, readOnly: true },
  { id: 48, name: "IntervalGrade", type: "double", size: 2, readOnly: true },
  { id: 49, name: "MaxPulse", type: "uint8", size: 1, readOnly: true },
  { id: 51, name: "WtMaxKph", type: "double", size: 2, readOnly: true },
  { id: 52, name: "AverageIncline", type: "grade", size: 2, readOnly: true },
  { id: 53, name: "WtMaxGrade", type: "grade", size: 2, readOnly: true },
  { id: 54, name: "AverageWatts", type: "uint16", size: 2, readOnly: true },
  { id: 55, name: "MaxWatts", type: "uint16", size: 2, readOnly: true },
  { id: 56, name: "AverageRpm", type: "uint16", size: 2, readOnly: true },
  { id: 57, name: "MaxRpm", type: "uint16", size: 2, readOnly: true },
  { id: 58, name: "KphGoal", type: "double", size: 2, readOnly: false },
  { id: 59, name: "GradeGoal", type: "grade", size: 2, readOnly: false },
  { id: 60, name: "ResistanceGoal", type: "raw16", size: 2, readOnly: false },
  { id: 61, name: "WattGoal", type: "uint16", size: 2, readOnly: false },
  { id: 63, name: "RpmGoal", type: "uint16", size: 2, readOnly: false },
  { id: 64, name: "DistanceGoal", type: "uint32", size: 4, readOnly: false },
  { id: 65, name: "PulseGoal", type: "uint8", size: 1, readOnly: false },
  { id: 66, name: "StartUpTime", type: "uint32", size: 4, readOnly: true },
  { id: 67, name: "BeltTotalTime", type: "uint32", size: 4, readOnly: true },
  { id: 68, name: "BeltTotalMeters", type: "uint32", size: 4, readOnly: true },
  {
    id: 69,
    name: "MotorTotalDistance",
    type: "uint32",
    size: 4,
    readOnly: true,
  },
  { id: 70, name: "TotalTime", type: "uint32", size: 4, readOnly: true },
  { id: 71, name: "CoolDownTimeout", type: "uint16", size: 2, readOnly: false },
  { id: 72, name: "CoolDownTime", type: "uint16", size: 2, readOnly: true },
  { id: 73, name: "CoolDownDistance", type: "uint32", size: 4, readOnly: true },
  {
    id: 74,
    name: "CoolDownCalories",
    type: "scaled32",
    size: 4,
    readOnly: true,
  },
  {
    id: 75,
    name: "VerticalMeterNet",
    type: "verticalMeter",
    size: 4,
    readOnly: true,
  },
  {
    id: 76,
    name: "VerticalMeterGain",
    type: "verticalMeter",
    size: 4,
    readOnly: true,
  },
  { id: 77, name: "Reps", type: "uint16", size: 2, readOnly: true },
  { id: 78, name: "LeftReps", type: "uint16", size: 2, readOnly: true },
  { id: 79, name: "RightReps", type: "uint16", size: 2, readOnly: true },
  { id: 80, name: "RepLength", type: "uint16", size: 2, readOnly: true },
  { id: 81, name: "RepLeftLength", type: "uint16", size: 2, readOnly: true },
  { id: 82, name: "RepRightLength", type: "uint16", size: 2, readOnly: true },
  { id: 83, name: "BurnRate", type: "burnRate", size: 2, readOnly: false },
  { id: 84, name: "AvgBurnRate", type: "burnRate", size: 2, readOnly: true },
  { id: 85, name: "MaxBurnRate", type: "burnRate", size: 2, readOnly: true },
  { id: 86, name: "IntervalRpm", type: "blob", size: 4, readOnly: true },
  { id: 87, name: "IntervalResistance", type: "blob", size: 4, readOnly: true },
  { id: 94, name: "GoalCalories", type: "scaled32", size: 4, readOnly: false },
  { id: 95, name: "IdleModeLockout", type: "bool", size: 1, readOnly: false },
  { id: 96, name: "StartRequested", type: "bool", size: 1, readOnly: true },
  { id: 98, name: "FanState", type: "uint8", size: 1, readOnly: false },
  { id: 100, name: "ActivationLock", type: "uint8", size: 1, readOnly: false },
  { id: 103, name: "PausedTime", type: "uint32", size: 4, readOnly: true },
  { id: 107, name: "SleepTimerState", type: "bool", size: 1, readOnly: false },
  {
    id: 108,
    name: "RequireStartRequested",
    type: "bool",
    size: 1,
    readOnly: false,
  },
  { id: 109, name: "Strokes", type: "uint16", size: 2, readOnly: true },
  { id: 110, name: "StrokesPerMin", type: "uint8", size: 1, readOnly: true },
  {
    id: 111,
    name: "FiveHundredSplit",
    type: "uint16",
    size: 2,
    readOnly: true,
  },
  {
    id: 112,
    name: "AvgFiveHundredSplit",
    type: "uint16",
    size: 2,
    readOnly: true,
  },
  { id: 115, name: "IsClubUnit", type: "bool", size: 1, readOnly: true },
  {
    id: 116,
    name: "IsReadyToDisconnect",
    type: "bool",
    size: 1,
    readOnly: true,
  },
  {
    id: 119,
    name: "IsConstantWattsMode",
    type: "bool",
    size: 1,
    readOnly: false,
  },
];
const CHAR_BY_ID = new Map(CHAR_TABLE.map((c) => [c.id, c]));

// Which read-only characteristics we monitor per equipment type. Kph/Incline
// only mean anything on a treadmill; every other type gets the equipment-
// agnostic status IDs (distance, elapsed time, pulse, calories, burn rate —
// BurnRate(83) applies universally, unlike Watts/Rpm which need pedaling/
// rowing to mean anything). Rower also reads back ID 2 (resistance — see
// resistanceLevelToRaw/setTargetResistance) plus Watts/Rpm/stroke-rate/
// split-pace; Bike/Other get Watts/Rpm but not the rower-specific ones.
// UNVERIFIED whether reading any of these back actually reflects a live
// console change — only Kph/Incline/Resistance's write side (app → device)
// has been confirmed against real hardware so far; every field added since
// (Watts/Rpm/BurnRate/Strokes/StrokesPerMin/FiveHundredSplit) is a real,
// documented characteristic ID (see IFIT_PROTOCOL.md) but has never
// actually been read from a live device by this app.
// IDs 0/1 (Kph/Incline) and 12 (Mode) appended below, at the end of each
// existing list — not interleaved among the already-tested ids above, to
// avoid disturbing whatever positional alignment those already work
// correctly at (see the "CurrentDistance is the very first requested field"
// comment on decodeDeviceInfoSupportedIds for why field *order* here has
// mattered before).
// Ids appended below, at the very end of each list — added from the real
// client's `Defaults.PeriodicFields` set (which reads ~31 fields; this app
// still only reads a curated subset, not the full list, to keep every
// request comfortably under QueueManager's 58-byte packet budget — see
// splitReadIdsIntoBatches for that budget's real formula):
//   96 StartRequested — the console's own "the user pressed Start" flag, a
//      real signal where this app previously only had movement inference.
//   100 ActivationLock — the device's own live statement of whether it's
//      still unlocked for control. A session where ENABLE silently failed,
//      or the device re-locked itself mid-session, previously looked
//      identical to one where writes were working the whole time.
//   18 ActualResistance (Rower only) — the dedicated read-back register,
//      separate from register 2 (the write target this app also reads back
//      today). Prefer this when the device reports it (see
//      metricsFromDecoded).
//   26 Gear (Bike only) — bike gear position; not writable via anything this
//      app drives yet, but worth surfacing since Bike previously had zero
//      controllable/observable characteristics beyond Watts/Rpm.
const READ_IDS_BY_CARDIO_TYPE: Record<CardioType, number[]> = {
  // Kph/Incline (0/1) are also the exact ids setTargetSpeed/setTargetIncline
  // write to — this protocol's console-side "what's it set to right now"
  // (IFIT_PROTOCOL.md calls these TargetKph/TargetIncline) is the same field
  // as "what should I set it to", read back instead of written. Reading them
  // is what lets the target steppers below stay in sync with a change made
  // on the console's own buttons instead of only reflecting this app's own
  // writes — same problem ble.ts's Machine Status subscription solves for
  // FTMS, just via a read instead of a push notification (this protocol has
  // no equivalent unsolicited "something changed" event, only request/poll).
  Treadmill: [16, 17, 4, 20, 10, 21, 83, 0, 1, 12, 96, 100],
  Rower: [4, 20, 10, 21, 2, 3, 5, 83, 109, 110, 111, 12, 96, 100, 18],
  Bike: [4, 20, 10, 21, 3, 5, 83, 12, 96, 100, 26],
  Other: [4, 20, 10, 21, 3, 5, 83, 12, 96, 100],
};
// Last-resort fallback only, used when DeviceInfo(Main) itself gets no
// response at all (see attachDevice) — the real client never guesses this:
// it addresses DeviceInfo to Main unconditionally and reads the equipment's
// actual bus address back out of byte 0 of the response (see
// DEVICE_TO_CARDIO_TYPE), which is what every subsequent command then
// addresses. This table only exists for the case where that first read
// itself fails and there is nothing to go on but what the caller assumed.
const EQUIPMENT_BY_CARDIO_TYPE: Record<CardioType, number> = {
  Treadmill: EQUIPMENT.TREADMILL,
  Rower: EQUIPMENT.ROWER,
  Bike: EQUIPMENT.FITNESS_BIKE,
  Other: EQUIPMENT.GENERAL,
};

export interface IfitMetrics {
  speedKmh: number | null;
  inclinePct: number | null;
  distanceM: number | null;
  elapsedSec: number | null;
  pulseBpm: number | null;
  caloriesKcal: number | null;
  // Rower only — read back from characteristic ID 2 and converted via
  // rawToResistanceLevel to the nearest real level. UNVERIFIED whether
  // this actually reflects a console-side change; only writing this
  // characteristic is confirmed against real hardware so far.
  resistanceLevel: number | null;
  // Bike/Rower/Other only (not Treadmill — see READ_IDS_BY_CARDIO_TYPE).
  powerW: number | null;
  cadenceRpm: number | null;
  // All equipment types — live kcal/hr, distinct from the cumulative
  // caloriesKcal above.
  burnRateKcalPerHr: number | null;
  // Rower only.
  totalStrokes: number | null;
  strokeRatePerMin: number | null;
  // Seconds per 500m, the pace unit rowers actually watch — Session.tsx
  // formats this as mm:ss, same as elapsedSec.
  splitPaceSecPer500m: number | null;
  // Treadmill only — read back from ids 0/1 (Kph/Incline), the same ids
  // setTargetSpeed/setTargetIncline write to. Distinct from speedKmh/
  // inclinePct above (CurrentKph/CurrentIncline — the *actual*, live
  // reading): this is what the console's target is set to right now,
  // whether this app or the console's own buttons set it last. See
  // READ_IDS_BY_CARDIO_TYPE's comment.
  targetSpeedKmh: number | null;
  targetInclinePct: number | null;
  // All equipment types — BitField 12, decoded against the decompiled
  // Sindarin.FitPro1.DataObjects.WorkoutMode enum (see WORKOUT_MODE below).
  // Note this is WorkoutMode, *not* the similarly-shaped ConsoleState enum an
  // earlier comment here named: the two disagree on several values (ConsoleState
  // has Resume=8 and Error=13, WorkoutMode has Sleep=12 and Resume=13), and
  // the values used here were always the WorkoutMode ones — verified against
  // the decompiled ModeConverter, which is typed ConverterBase<WorkoutMode>.
  // `true` for Running(2)/Resume(13), `false` for Idle(1)/Pause(3), `null`
  // for every other state or if the device didn't answer this read at all —
  // deliberately not treated as "false" in that case, since Session.tsx's
  // autoDetect already has its own movement-based inference to fall back on.
  running: boolean | null;
  // The console's own "the user pressed Start" flag (BitField 96) — a real
  // device-side signal, distinct from `running` (WorkoutMode) above.
  startRequested: boolean | null;
  // ActivationLock (BitField 100) — the device's own live statement of
  // whether it is still unlocked for control. `true` means locked (writes
  // will be accepted at the transport level and silently discarded); `null`
  // when the device doesn't report this field. 0 = unlocked, matching the
  // convention the device probe's checkIfitControl already uses.
  activationLocked: boolean | null;
}
const EMPTY_IFIT_METRICS: IfitMetrics = {
  speedKmh: null,
  inclinePct: null,
  distanceM: null,
  elapsedSec: null,
  pulseBpm: null,
  caloriesKcal: null,
  resistanceLevel: null,
  powerW: null,
  cadenceRpm: null,
  burnRateKcalPerHr: null,
  totalStrokes: null,
  strokeRatePerMin: null,
  splitPaceSecPer500m: null,
  targetSpeedKmh: null,
  targetInclinePct: null,
  running: null,
  startRequested: null,
  activationLocked: null,
};

// Same shape as ble.ts's SupportedRange/SupportedRanges, duplicated locally
// rather than imported — ble.ts already imports IFIT_SERVICE_UUID from this
// module, so importing back from ble.ts would create a cycle.
export interface IfitSupportedRange {
  min: number;
  max: number;
  increment: number;
}
export interface IfitSupportedRanges {
  speed: IfitSupportedRange | null;
  incline: IfitSupportedRange | null;
}
const EMPTY_IFIT_SUPPORTED_RANGES: IfitSupportedRanges = {
  speed: null,
  incline: null,
};
// This protocol has no documented "step" field for Min/MaxKph or
// Min/MaxIncline, so the increment here is this app's own default policy —
// same values as ble.ts's DEFAULT_SPEED_RANGE/DEFAULT_INCLINE_RANGE — not
// anything read from the device.
export const DEFAULT_IFIT_SPEED_RANGE: IfitSupportedRange = {
  min: 1,
  max: 18,
  increment: 0.5,
};
export const DEFAULT_IFIT_INCLINE_RANGE: IfitSupportedRange = {
  min: 0,
  max: 8,
  increment: 1,
};

// Resistance formula, straight from the decompiled ResistanceConverter (see
// IFIT_PROTOCOL.md's Data Type Converters section) — this used to be a
// 26-entry table hand-calibrated by sweeping one specific real rower, which
// only worked correctly for that exact model. It's actually a clean linear
// formula parameterized by the device's own reported MaxResistanceLevel
// (characteristic ID 42, read once per Rower connection in attachDevice),
// so this now works on any device instead of just the one that was tested.
// DEFAULT_MAX_RESISTANCE_LEVEL is the fallback when that read hasn't
// happened yet (or failed) — 26 matches the level count of the real rower
// this app was originally calibrated against, so it's a reasonable guess
// even when the real value isn't known yet.
export const DEFAULT_MAX_RESISTANCE_LEVEL = 26;

function resistanceStepSize(maxLevel: number): number {
  return 10000.0 / maxLevel;
}
// The literal 2-byte wire value for a target level — NOT a "pre-×100"
// value like every other numeric characteristic here (see CHAR_TABLE's
// 'raw16' comment), so this is sent via `{ 2: resistanceLevelToRaw(...) }`
// with Resistance's CHAR_TABLE type set to 'raw16', not 'double'.
export function resistanceLevelToRaw(
  level: number,
  maxLevel: number = DEFAULT_MAX_RESISTANCE_LEVEL,
): number {
  const stepSize = resistanceStepSize(maxLevel);
  return Math.trunc(Math.max(0, Math.trunc(level * stepSize) - stepSize * 0.1));
}
// Inverse — turns a raw read-back value into a displayable level.
export function rawToResistanceLevel(
  raw: number,
  maxLevel: number = DEFAULT_MAX_RESISTANCE_LEVEL,
): number {
  return Math.round(raw / resistanceStepSize(maxLevel));
}
// The real levels the WRITE side can target, ascending 1..maxLevel — for
// UI steppers (see screens/Session.tsx's `ifit.resistanceLevels`).
export function resistanceLevelsForMax(maxLevel: number): number[] {
  return Array.from({ length: maxLevel }, (_, i) => i + 1);
}
export const DEFAULT_RESISTANCE_LEVELS: number[] = resistanceLevelsForMax(
  DEFAULT_MAX_RESISTANCE_LEVEL,
);

function decodeValue(type: CharType, bytes: number[]): number {
  const u16 = (bytes[0] ?? 0) | ((bytes[1] ?? 0) << 8);
  const u32 =
    (bytes[0] ?? 0) |
    ((bytes[1] ?? 0) << 8) |
    ((bytes[2] ?? 0) << 16) |
    ((bytes[3] ?? 0) << 24);
  switch (type) {
    case "uint8":
      return bytes[0] ?? 0;
    case "bool":
      return bytes[0] ? 1 : 0;
    case "uint16":
      return u16;
    case "double":
      return u16 / 100; // scaled uint16, ×100, unsigned (speed/etc. never go negative)
    // Same scaled-uint16 encoding as 'double', but SIGNED — the decompiled
    // GradeConverter casts to a signed 16-bit value before dividing, so
    // incline/grade fields decode negative (decline) correctly instead of
    // wrapping to a huge bogus positive number.
    case "grade":
      return (u16 > 0x7fff ? u16 - 0x10000 : u16) / 100;
    case "raw16":
      return u16; // literal wire value, no scaling — see CHAR_TABLE's comment
    case "burnRate":
      return (u16 > 0x7fff ? u16 - 0x10000 : u16) / 1000; // signed, scaled ×1000
    case "uint32":
      return u32 >>> 0;
    // Confirmed against the decompiled CaloriesConverter (see
    // IFIT_PROTOCOL.md) — value = raw × 1024 / 100000000. An earlier version
    // of this used a live-tuned raw/1024/100, which was close but not exact
    // (divisor 102400 vs. the real 97656.25, ~4.6% off).
    case "scaled32":
      return ((u32 >>> 0) * 1024) / 100000000;
    // VerticalMeterConverter — unsigned uint32, ÷10000. A distinct formula
    // from 'scaled32'; ids 75/76 were previously typed plain 'uint32' (see
    // CHAR_TABLE's comment), which would have under-scaled by 4 orders of
    // magnitude the moment anything started reading them.
    case "verticalMeter":
      return (u32 >>> 0) / 10000;
    case "pulse":
      return bytes[0] ?? 0; // byte 0 = current BPM
    default:
      return 0;
  }
}

// Inverse of decodeValue, for the characteristics this module actually
// writes (Kph/Incline/Resistance). uint8/uint16/uint32/bool included for
// completeness/symmetry, not because anything here writes them yet.
function encodeValue(type: CharType, value: number): number[] {
  switch (type) {
    case "uint8":
    case "bool":
      return [Math.max(0, Math.min(0xff, Math.round(value)))];
    case "uint16":
    case "raw16": {
      const v = Math.max(0, Math.min(0xffff, Math.round(value)));
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case "double": {
      // Truncated toward zero, not rounded — SpeedConverter/DoubleConverter
      // both do `(int)(data * 100.0)`, a C# int cast, which truncates rather
      // than rounds. Math.trunc matches that; Math.round previously didn't,
      // so a value landing exactly on a .xx5 boundary encoded one raw unit
      // higher than the real client would send.
      const v = Math.max(0, Math.min(0xffff, Math.trunc(value * 100))); // scaled uint16, ×100
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case "grade": {
      // Same ×100 scaling as 'double', truncated the same way, but allows
      // negative (decline) — clamped to the signed 16-bit range, then masked
      // to the raw uint16 wire representation (two's complement).
      const v =
        Math.max(-0x8000, Math.min(0x7fff, Math.trunc(value * 100))) & 0xffff;
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case "burnRate": {
      const v =
        Math.max(-0x8000, Math.min(0x7fff, Math.trunc(value * 1000))) & 0xffff;
      return [v & 0xff, (v >> 8) & 0xff];
    }
    case "uint32": {
      const v = Math.max(0, Math.round(value)) >>> 0;
      return [v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff];
    }
    default:
      return [0, 0];
  }
}

function buildFrame(
  equipment: number,
  command: number,
  payload: number[],
): number[] {
  const length = payload.length + 4;
  const frame = [
    0x02,
    0x04,
    0x02,
    length,
    equipment,
    length,
    command,
    ...payload,
  ];
  const checksum =
    (equipment + length + command + payload.reduce((a, b) => a + b, 0)) & 0xff;
  frame.push(checksum);
  return frame;
}

// Inverse of buildFrame's checksum, for frames received *from* the device.
// Until now the checksum was only ever computed for outbound frames and never
// verified on the inbound side, so a corrupted or misaligned response decoded
// exactly like a good one — the root failure mode behind the whole class of
// "some fields read back as garbage" bugs that decodeDeviceInfoSupportedIds
// was written to chase from the other end.
//
// An inbound frame is the reassembled inner frame (see handleNotify): the
// same [0x02,0x04,0x02,LEN,EQUIPMENT,LEN,COMMAND,...payload,CHECKSUM] shape.
// Returns null (not false) when the frame is too short to have a checksum at
// all — callers treat "can't tell" differently from "definitely wrong".
//
// Bounded by the frame's own declared length (frame[5], = EquipmentUtil's
// `bytes[1]`), not by the array's actual length — the real checksum
// (`GetCheckSum`) sums exactly `bytes[0] .. bytes[bytes[1]-2]` and the
// checksum byte itself sits at `bytes[bytes[1]-1]`, i.e. full-frame offset
// `4 + length - 1`, not necessarily the frame's last byte. An earlier version
// of this always used `frame.length - 1` for both, which only happened to
// work because reassembly trims to each packet's own declared length — any
// trailing byte (padding, a coalesced second frame) would have made this
// report a false failure.
export function verifyFrameChecksum(frame: number[]): boolean | null {
  if (frame.length < 8) return null;
  const length = frame[5];
  const checksumOffset = 4 + length - 1;
  if (length < 4 || checksumOffset >= frame.length) return null;
  let sum = 0;
  for (let i = 4; i < checksumOffset; i++) sum += frame[i];
  return (sum & 0xff) === frame[checksumOffset];
}

// The command byte a response frame is answering, so a reply can be matched
// back to the request that's waiting on it. sendRaw's correlation is purely
// positional (whatever frame arrives next belongs to whoever is waiting), so
// a response that arrives after its own 1500ms timeout otherwise lands in the
// *next* command's window — e.g. a late DeviceInfo reply getting decoded as a
// WRITE_AND_READ value set.
export function frameCommandByte(frame: number[]): number | null {
  return frame.length >= 7 ? frame[6] : null;
}

// CmdStatus, transcribed from the decompiled Sindarin.FitPro1.Commands.CmdStatus
// enum. Every response's inner frame carries this at byte 3 (full-frame
// offset 7) — documented correctly in IFIT_PROTOCOL.md but, until now, never
// actually read by this file. Three real behaviours hang off it in the
// reference client: a response with a non-Done status has its read values
// discarded entirely (ReadWriteDataCmd.SetResponseBytes returns false rather
// than decoding anything); VerifySecurityCmd's own IsUnlocked is literally
// `Status == Done`, i.e. ENABLE's success/failure is directly observable,
// not "unknowable" as earlier comments in this file claimed; and a write that
// comes back SecurityBlock is the trigger for re-running Unlock() before
// retrying — the actual recovery path for "my writes are being silently
// ignored" that this file previously had no answer for.
export const CMD_STATUS = {
  DEV_NOT_SUPPORTED: 0,
  CMD_NOT_SUPPORTED: 1,
  DONE: 2,
  IN_PROGRESS: 3,
  FAILED: 4,
  TIME_LEFT: 5,
  UNKNOWN_FAILURE: 7,
  SECURITY_BLOCK: 8,
  COMM_FAILED: 9,
} as const;
export function frameStatus(frame: number[]): number | null {
  return frame.length >= 8 ? frame[7] : null;
}

// Multi-packet reassembly, factored out of the notification handler so the
// active debugger runs this exact logic rather than keeping its own copy
// that could drift.
//
// A response arrives as a 0xFE header packet (which carries no data of its
// own and resets the accumulator), then data packets each prefixed with
// [marker, length]; marker 0xFF marks the last one. Returns the accumulated
// chunks plus the completed inner frame once the terminator arrives.
export function feedNotifyPacket(
  chunks: number[][],
  bytes: number[],
): { chunks: number[][]; frame: number[] | null } {
  const marker = bytes[0];
  if (marker === 0xfe) return { chunks: [], frame: null };
  const len = bytes[1];
  const next = [...chunks, bytes.slice(2, 2 + len)];
  if (marker === 0xff) return { chunks: [], frame: next.flat() };
  return { chunks: next, frame: null };
}

// Total payload size decodeReadValues will consume for a given id set — lets
// a caller check a response is actually long enough *before* decoding it.
// decodeReadValues itself slices at fixed offsets with no bounds check, and
// decodeValue's `?? 0` fallbacks turn every past-the-end read into a
// fabricated 0 rather than a null, which is indistinguishable downstream from
// a genuine "speed is zero" — see decodeReadValues' own comment.
export function expectedReadPayloadBytes(readIds: number[]): number {
  return readIds.reduce((sum, id) => sum + (CHAR_BY_ID.get(id)?.size ?? 0), 0);
}

function chunkFrame(frame: number[]): number[][] {
  const CHUNK_SIZE = 18;
  const dataChunks: number[][] = [];
  for (let i = 0; i < frame.length; i += CHUNK_SIZE)
    dataChunks.push(frame.slice(i, i + CHUNK_SIZE));
  const packets: number[][] = [
    [0xfe, 0x02, frame.length, dataChunks.length + 1],
  ];
  dataChunks.forEach((chunk, i) => {
    const marker = i === dataChunks.length - 1 ? 0xff : i;
    const packet = [marker, chunk.length, ...chunk];
    while (packet.length < 20) packet.push(0);
    packets.push(packet);
  });
  return packets;
}

function buildBitmap(ids: number[]): number[] {
  if (ids.length === 0) return [0x00];
  const numBytes = (Math.max(...ids) >> 3) + 1;
  const bytes = new Array(numBytes).fill(0);
  for (const id of ids) bytes[id >> 3] |= 1 << (id & 7);
  return [bytes.length, ...bytes];
}

// Monitor-only WRITE_AND_READ request: empty write bitmap, read bitmap for
// the given characteristic IDs, no write values — per IFIT_PROTOCOL.md's
// "Monitor-Only Mode" section, this needs no activation/ENABLE at all.
function buildMonitorRequest(equipment: number, readIds: number[]): number[][] {
  const payload = [0x00, ...buildBitmap(readIds)];
  return chunkFrame(buildFrame(equipment, COMMAND_WRITE_AND_READ, payload));
}

// Write+read WRITE_AND_READ request — writeValues keyed by characteristic
// ID, encoded in ascending ID order. IFIT_PROTOCOL.md's Example 1 documents
// payload order as [write bitmap][read bitmap][write values], but a real
// btsnoop capture of the official app controlling a real device (see
// logs/rw-analysis.txt) shows the actual wire order is [write bitmap][write
// values][read bitmap] — confirmed against two independent real writes (a
// 1-byte Metric/bool write and a 2-byte write to characteristic ID 2) that
// only decode sensibly in that order; the doc's stated order leaves an
// impossible bitmap-length byte partway through the remaining bytes. ENABLE
// (see buildEnableRequest) is sent once per connection, separately, before
// the first call to this — not part of this frame.
function buildControlRequest(
  equipment: number,
  writeValues: Partial<Record<number, number>>,
  readIds: number[],
): number[][] {
  const writeIds = Object.keys(writeValues)
    .map(Number)
    .sort((a, b) => a - b);
  const values: number[] = [];
  for (const id of writeIds) {
    const def = CHAR_BY_ID.get(id);
    if (!def) continue;
    values.push(...encodeValue(def.type, writeValues[id]!));
  }
  const payload = [
    ...buildBitmap(writeIds),
    ...values,
    ...buildBitmap(readIds),
  ];
  return chunkFrame(buildFrame(equipment, COMMAND_WRITE_AND_READ, payload));
}

// ENABLE (0x90) — authenticates/unlocks the equipment for control, per
// IFIT_PROTOCOL.md's Commands section. Payload is the raw 36-byte activation
// payload (no bitmap framing, unlike WRITE_AND_READ) — see
// buildActivationPayload for how it's computed.
function buildEnableRequest(equipment: number, payload: number[]): number[][] {
  return chunkFrame(buildFrame(equipment, COMMAND_ENABLE, payload));
}

// Per-command request content for the metadata commands, transcribed from
// each decompiled command class's own RequestContentBytes(). Confirmed
// against the real RW300 capture too: its DeviceInfo request is the bare
// 4-byte inner frame `02 04 81 87` — no payload at all — while its SystemInfo
// request does carry two payload bytes (`02 07 82 00 00 8b`). A previous
// version of this sent every metadata command with a fixed `00 00` payload,
// which is right for SystemInfo/VersionInfo (both take a real 2-byte
// `[fetchMcuName, fetchConsoleName]` parameter, defaulting to `[0,0]`) but
// wrong for the other four — DeviceInfoCmd/SerialNumberCmd/
// SupportedDevicesCmd/SupportedCommandsCmd all declare `ContentLength => 0`
// and take no payload whatsoever. Two extra, unexplained bytes make the
// frame's own length byte lie about what follows it — at best ignored, and
// exactly the kind of malformed request EquipmentUtil.IsValidCommandResponse
// exists to catch on the real client's receiving end.
// SystemInfo's real content is 3 bytes ([fetchMcuName, 0, 0]), confirmed
// against the real RW300 capture's checksum (0x8b — matches device(Main=2) +
// length(7) + command(0x82) + 3 content bytes; a 2-byte content, as the
// decompiled SystemInfoCmd.RequestContentBytes/ContentLength=>2 both claim,
// would give length 6 and a different checksum that doesn't match what the
// real device accepted). Trusting the capture here over the decompile — it's
// checksum-verified ground truth from an actual working session, and the
// decompile may simply be from an app build with a slightly different
// SystemInfoCmd revision than whatever the RW300's firmware/app pairing used.
const METADATA_REQUEST_CONTENT: Partial<Record<number, number[]>> = {
  [COMMAND_DEVICE_INFO]: [],
  [COMMAND_EQUIPMENT_SERIAL]: [],
  [COMMAND_SUPPORTED_CAPABILITIES]: [],
  [COMMAND_SUPPORTED_COMMANDS]: [],
  [COMMAND_SYSTEM_INFO]: [0x00, 0x00, 0x00],
  [COMMAND_VERSION_INFO]: [0x00, 0x00],
};
function buildMetadataRequest(equipment: number, command: number): number[][] {
  return chunkFrame(
    buildFrame(equipment, command, METADATA_REQUEST_CONTENT[command] ?? []),
  );
}

function readUint32LE(frame: number[], offset: number): number {
  return (
    ((frame[offset] ?? 0) |
      ((frame[offset + 1] ?? 0) << 8) |
      ((frame[offset + 2] ?? 0) << 16) |
      ((frame[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

// EQUIPMENT_SERIAL (0x95) response per IFIT_PROTOCOL.md: a length-prefixed
// ASCII string starting at byte 9 (byte 8 = length), in the doc's own
// example format "######-MODEL###" — a different layout from WRITE_AND_READ
// responses (which start their payload at byte 8, not byte 9, and hold
// fixed-width typed values, not a length-prefixed string). Defensively
// filtered to printable ASCII and bounds-checked since this framing is
// unverified against real hardware, same as everything else control-related
// in this file.
// SerialNumberCmd itself returns null when every byte of the payload is
// 0x00 or every byte is 0xFF — the decompiled source's own sentinel for "no
// real serial programmed" — rather than the ASCII/hex string those bytes
// would otherwise decode to. Previously unhandled here, so a device in that
// state would have decoded a string of literal zero/0xFF characters instead.
function decodeSerialResponse(frame: number[]): string | null {
  if (frame.length < 10) return null;
  const len = frame[8];
  if (!len || frame.length < 9 + len) return null;
  const raw = frame.slice(9, 9 + len);
  if (raw.every((b) => b === raw[0]) && (raw[0] === 0x00 || raw[0] === 0xff))
    return null;
  const str = raw
    .map((b) => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : ""))
    .join("")
    .trim();
  return str || null;
}

// DeviceInfo (0x81) response layout per IFIT_PROTOCOL.md's Commands section:
// content starts at frame byte 8 (the standard 4-byte outer envelope + the
// inner frame's own 4-byte device/length/command/status header). Only the
// serial number is needed here (for the activation-payload derivation
// below) — software/hardware version and the supported-BitFields bitmap
// that follow aren't used by this app.
function decodeDeviceInfoSerialNumber(frame: number[]): number | null {
  if (frame.length < 14) return null;
  return readUint32LE(frame, 10);
}

// DeviceInfo also carries the set of BitField ids this specific console
// actually implements: content offset 8 (= full-frame offset 16, content
// starting at 8 same as decodeDeviceInfoSerialNumber above) is a section
// count, followed by that many bitmap bytes (bit `n` of section `i` =
// BitField `i*8+n`) — same encoding as the read/write bitmaps in Layer 3.
// This is the root fix for "some fields read back as garbage": a
// ReadWriteData response only ever contains values for BitFields the device
// actually supports, so requesting (and then decoding, at a fixed size, at a
// fixed position) an id the device doesn't implement silently shifts every
// value requested after it — e.g. a treadmill with no heart-rate grip
// dropping Pulse(10) from its response shifts Kph/Incline/Calories/BurnRate,
// which all come after it in READ_IDS_BY_CARDIO_TYPE's sorted order, into
// garbage. Returns null if the frame is too short to contain this section
// (fails open — callers fall back to requesting everything, the old
// behavior).
function decodeDeviceInfoSupportedIds(frame: number[]): Set<number> | null {
  const sectionCountOffset = 16; // full-frame offset: 8 (header) + 8 (software/hw/serial/manufacturer)
  if (frame.length <= sectionCountOffset) return null;
  const sectionCount = frame[sectionCountOffset] ?? 0;
  if (sectionCount <= 0 || frame.length < sectionCountOffset + 1 + sectionCount)
    return null;
  const ids = new Set<number>();
  for (let section = 0; section < sectionCount; section++) {
    const byte = frame[sectionCountOffset + 1 + section] ?? 0;
    for (let bit = 0; bit < 8; bit++) {
      if (byte & (1 << bit)) ids.add(section * 8 + bit);
    }
  }
  return ids;
}

// SystemInfo (0x82) response, same header convention. Only Model and
// PartNumber are needed. Preserves a real device quirk found in the
// decompiled source: one specific unit reports PartNumber 370357 alongside
// Model 39915, which is wrong — the real part number is 374677.
function decodeSystemInfoModelAndPart(
  frame: number[],
): { model: number; partNumber: number } | null {
  if (frame.length < 19) return null;
  const model = readUint32LE(frame, 11);
  let partNumber = readUint32LE(frame, 15);
  if (partNumber === 370357 && model === 39915) partNumber = 374677;
  return { model, partNumber };
}

// VersionInfo (0x84) response, same header convention. Only
// MasterLibraryVersion (a single byte right after the header) is needed.
function decodeVersionInfoMasterLibraryVersion(frame: number[]): number | null {
  if (frame.length < 9) return null;
  return frame[8] ?? null;
}

// The equipment/bus address a response frame is FROM — full-frame offset 4,
// same position `equipment` occupies in a request. CommandBase.SetResponseBytes
// sets `Device = (Device)bytes[0]` from every response, and DeviceInfoCmd
// copies that into its own `DeviceInfo.Device` — i.e. sending DeviceInfo to
// Main (0x02) and reading this back is how the real client learns what
// equipment it's actually connected to, rather than assuming. See
// attachDevice: this replaces the previous Treadmill-then-Rower guess-and-retry,
// which was solving a problem the protocol already answers directly.
export function decodeResponseDeviceAddress(frame: number[]): number | null {
  return frame.length >= 5 ? frame[4] : null;
}

// DeviceInfo content offset 0 (full-frame offset 8) — SoftwareVersion.
// FitPro1Console only calls Unlock() (ENABLE) `if (PrimaryDevice.SoftwareVersion
// > 75)`; previously this app sent ENABLE unconditionally to every
// controllable device.
export function decodeDeviceInfoSoftwareVersion(
  frame: number[],
): number | null {
  return frame.length >= 9 ? frame[8] : null;
}

// SupportedDevices (0x80) response: skip the 4-byte header, one count byte,
// then that many Device-address bytes — the machine's sub-device tree.
// Decoded now (the probe previously recorded this command's response only as
// "0x80, undecoded").
export function decodeSupportedDevices(frame: number[]): number[] | null {
  if (frame.length < 9) return null;
  const count = frame[8] ?? 0;
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const b = frame[9 + i];
    if (b == null) break;
    out.push(b);
  }
  return out;
}

// SupportedCommands (0x88) response: skip the 4-byte header, then one
// Command byte per entry, for `responseLength - 4 - 1` entries (the real
// client's own `base.ResponseLength - 4 - 1`, ResponseLength being the inner
// frame's declared length at full-frame offset 5). QueueManager gates every
// queued command against this set (plus a small always-approved list) before
// ever sending it — this app doesn't gate on it yet (see attachDevice), but
// decoding it is what makes that possible and is itself useful probe evidence.
export function decodeSupportedCommands(frame: number[]): number[] | null {
  if (frame.length < 9) return null;
  const length = frame[5] ?? 0;
  const count = Math.max(0, length - 5);
  const out: number[] = [];
  for (let i = 0; i < count; i++) {
    const b = frame[8 + i];
    if (b == null) break;
    out.push(b);
  }
  return out;
}

// The real per-packet budget (QueueManager.MaxPacketResponseSize = 58) a
// ReadWriteData response must fit inside, and the real packing rule
// (SelectAndRemoveCommsThatFitPacketSize): `sectionCount = maxId/8 + 1` bitmap
// section bytes are reserved, and fields are packed until the remaining
// budget (58 - sectionCount) would be exceeded. Ids are batched into however
// many separate requests are needed — previously only the device probe's
// capability sweep did any batching at all, and used a hand-picked 24-byte
// budget instead of this real formula (see its own comment).
export function splitReadIdsIntoBatches(ids: number[]): number[][] {
  const sorted = [...ids].sort((a, b) => a - b);
  const batches: number[][] = [];
  let i = 0;
  while (i < sorted.length) {
    const maxId = Math.max(...sorted.slice(i));
    const sectionCount = (maxId >> 3) + 1;
    const budget = 58 - sectionCount;
    const batch: number[] = [];
    let sum = 0;
    let j = i;
    for (; j < sorted.length; j++) {
      const size = CHAR_BY_ID.get(sorted[j])?.size ?? 0;
      if (batch.length > 0 && sum + size >= budget) break;
      sum += size;
      batch.push(sorted[j]);
    }
    if (batch.length === 0) {
      batch.push(sorted[j]);
      j++;
    } // force progress even if one field alone exceeds budget
    batches.push(batch);
    i = j;
  }
  return batches;
}

// The real ENABLE payload derivation (EquipmentUtil.CalculateSecurityHash +
// VerifySecurityCmd, straight from the decompiled source — see
// IFIT_PROTOCOL.md's "ENABLE / Activation-Code Handshake" section) now runs
// server-side (src/src/routes/ifit.ts), not in this bundle — the
// algorithm and the generic fallback code are exactly the parts of the
// protocol that don't need to ship to the browser to work, so keeping them
// server-side means a client-JS dump doesn't reveal them. The client only
// ever gets back the resulting per-device payload, computed fresh per
// connection from device info it already reads for no other purpose.
async function fetchActivationPayload(
  serialNumber: number,
  partNumber: number,
  model: number,
  masterLibraryVersion: number,
): Promise<number[]> {
  const { payloadHex } = await api.post<{ payloadHex: string }>(
    "/ifit/activation",
    { serialNumber, partNumber, model, masterLibraryVersion },
  );
  return hexToBytes(payloadHex);
}

function hexToBytes(hex: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < hex.length; i += 2)
    bytes.push(parseInt(hex.slice(i, i + 2), 16));
  return bytes;
}

// Last-resort fallback if the device-info reads the real derivation needs
// (DeviceInfo/SystemInfo/VersionInfo) fail — e.g. a comms hiccup mid-
// connection, or the activation API call itself fails. A real-but-generic
// code still has a better chance of unlocking control than sending no
// ENABLE at all. Fetched from the API rather than hardcoded here, same
// reasoning as fetchActivationPayload above.
async function fetchGenericActivationPayload(): Promise<number[]> {
  const { payloadHex } = await api.get<{ payloadHex: string }>(
    "/ifit/activation/generic",
  );
  return hexToBytes(payloadHex);
}

// Read values in a WRITE_AND_READ response start at byte 8 (per doc), in
// ascending characteristic-ID order matching what was requested.
//
// Every field is bounds-checked against the frame before decoding, and a
// field that runs past the end is simply left absent from the result rather
// than decoded from a short slice. Without this, decodeValue's `?? 0`
// fallbacks silently produced a **fabricated 0** for every truncated field —
// and since metricsFromDecoded uses `?? null`, which doesn't catch 0, that 0
// flowed straight through to IfitMetrics as if the device had genuinely
// reported "speed 0 / distance 0". A short response therefore read as a
// perfectly stopped machine instead of as a comms problem, which is strictly
// worse than the RangeError ble.ts's parsers used to throw in the same
// situation: at least a throw was visible. Leaving the key absent restores
// the null-vs-value distinction the rest of this module (and Session.tsx's
// autoDetect) depends on.
function decodeReadValues(
  frame: number[],
  readIds: number[],
): Partial<Record<string, number>> {
  const sortedIds = [...readIds].sort((a, b) => a - b);
  const out: Partial<Record<string, number>> = {};
  let offset = 8;
  for (const id of sortedIds) {
    const def = CHAR_BY_ID.get(id);
    if (!def) continue;
    if (offset + def.size > frame.length) break; // truncated — everything from here on is unknown, not zero
    // 'blob'/'string45' fields are walked over but never decoded into a
    // number: their width keeps everything after them aligned, while
    // emitting a made-up numeric value for a 14-byte key object or a 45-byte
    // name string would be the fabricated-zero problem all over again.
    if (def.type !== "blob" && def.type !== "string45") {
      out[def.name] = decodeValue(
        def.type,
        frame.slice(offset, offset + def.size),
      );
    }
    offset += def.size;
  }
  return out;
}

// distanceScale converts the device's reported CurrentDistance into metres.
// Defaults to 1 (the documented unit) and is overridden per-device from
// deviceRegistry.ts — this used to be a global ÷10 added for one machine and
// then removed when a second machine showed the exact opposite error, which
// is precisely the pattern the registry exists to stop.
function metricsFromDecoded(
  values: Partial<Record<string, number>>,
  maxResistanceLevel: number,
  distanceScale = 1,
): IfitMetrics {
  // CurrentKph (16) is Treadmill-only in READ_IDS_BY_CARDIO_TYPE — this
  // protocol has no speed characteristic a rower answers to. FiveHundredSplit
  // (111) is what a rower does report, and it converts directly (1800 =
  // seconds per 500m folded together with the m/s→km/h factor), exactly the
  // way ble.ts's parseRowerData derives speed from FTMS's own Instantaneous
  // Pace field. Without this a real rower produced no speed at all, which
  // left Session.tsx's autoDetect with only cadence/power to work from and
  // the speed-integrated distance fallback with nothing to integrate.
  const paceDerivedSpeed =
    values.FiveHundredSplit != null && values.FiveHundredSplit > 0
      ? 1800 / values.FiveHundredSplit
      : null;
  return {
    speedKmh: values.CurrentKph ?? paceDerivedSpeed,
    inclinePct: values.CurrentIncline ?? null,
    // IFIT_PROTOCOL.md documents CurrentDistance as a plain UInt32 in
    // meters. An earlier version of this divided by 10 based on one
    // real-device report (500m reading back as 5km) — but a later report
    // showed the opposite error (900m reading back as 90m) on a device where
    // CurrentDistance is the very first requested field, so it can't have
    // been a read-misalignment artifact (see decodeDeviceInfoSupportedIds's
    // comment for what that looks like) — the /10 was itself wrong, at
    // least for that device. Trusting the doc's plain-meters unit here
    // instead; if a specific device still reads back scaled, that's a
    // device-specific quirk to special-case by model, not a blanket divide.
    distanceM:
      values.CurrentDistance != null
        ? values.CurrentDistance * distanceScale
        : null,
    elapsedSec: values.CurrentTime ?? null,
    pulseBpm: values.Pulse ? values.Pulse : null,
    caloriesKcal: values.CurrentCalories ?? null,
    // Resistance (2, the write target this app also reads back) is primary —
    // it's the field setTargetResistance actually writes and the one that's
    // been validated against real hardware throughout this app's history.
    // ActualResistance (18) was briefly promoted to primary on the theory
    // (straight from the decompiled BitField.cs) that both characteristics
    // share the same ResistanceConverter/step-size formula — a real device
    // probe (I_RW, 2026-07-27) disproved that: writing level 3 to Resistance
    // read back correctly from Resistance itself, but ActualResistance
    // decoded to level 6 under the identical formula (almost exactly 2x),
    // while the console's own display genuinely showed 3 (user-confirmed).
    // So the two registers are not interchangeably-scaled on every device —
    // ActualResistance is now only a fallback for devices that don't report
    // Resistance's own read-back at all.
    resistanceLevel:
      values.Resistance != null
        ? rawToResistanceLevel(values.Resistance, maxResistanceLevel)
        : values.ActualResistance != null
          ? rawToResistanceLevel(values.ActualResistance, maxResistanceLevel)
          : null,
    powerW: values.Watts ?? null,
    cadenceRpm: values.Rpm ?? null,
    burnRateKcalPerHr: values.BurnRate ?? null,
    totalStrokes: values.Strokes ?? null,
    strokeRatePerMin: values.StrokesPerMin ?? null,
    // FiveHundredSplit's units aren't documented — assumed seconds (the
    // natural unit for a "time per 500m" pace figure, and what every rowing
    // display already shows), not yet confirmed against a real device.
    splitPaceSecPer500m: values.FiveHundredSplit ?? null,
    targetSpeedKmh: values.Kph ?? null,
    targetInclinePct: values.Incline ?? null,
    running:
      values.Mode === 2 || values.Mode === 13
        ? true
        : values.Mode === 1 || values.Mode === 3
          ? false
          : null,
    startRequested:
      values.StartRequested != null ? values.StartRequested === 1 : null,
    // 0 = unlocked, matching the convention the device probe's
    // checkIfitControl already uses for this same field.
    activationLocked:
      values.ActivationLock != null ? values.ActivationLock !== 0 : null,
  };
}

// --- Protocol surface consumed by the active debugger (deviceProbe.ts and
// the /device-probe screen) ---
//
// Same contract as ble.ts's FTMS_PROBE: the probe drives *this* module's real
// framing, checksum, bitmap and decoder code, never its own copy — the
// retired manual /ble-debug tool was the cautionary example of what
// hardcoding a second copy of `buildCommand`/`EQUIPMENT`/`COMMAND` literals
// leads to (it silently missed every protocol correction made here since:
// the write-order fix, the supported-ids filter, the resistance formula
// replacing the calibration table, the CurrentDistance unit fix). Nothing
// below is redefined for the probe's benefit.
export const IFIT_PROBE = {
  serviceUuid: IFIT_SERVICE_UUID,
  writeUuid: IFIT_WRITE_UUID,
  notifyUuid: IFIT_NOTIFY_UUID,
  equipment: EQUIPMENT,
  equipmentByCardioType: EQUIPMENT_BY_CARDIO_TYPE,
  deviceToCardioType: DEVICE_TO_CARDIO_TYPE,
  readIdsByCardioType: READ_IDS_BY_CARDIO_TYPE,
  commands: {
    writeAndRead: COMMAND_WRITE_AND_READ,
    enable: COMMAND_ENABLE,
    deviceInfo: COMMAND_DEVICE_INFO,
    systemInfo: COMMAND_SYSTEM_INFO,
    versionInfo: COMMAND_VERSION_INFO,
    equipmentSerial: COMMAND_EQUIPMENT_SERIAL,
    supportedCapabilities: COMMAND_SUPPORTED_CAPABILITIES,
    supportedCommands: COMMAND_SUPPORTED_COMMANDS,
  },
  charTable: CHAR_TABLE,
  charById: CHAR_BY_ID,
  buildFrame,
  chunkFrame,
  buildBitmap,
  buildMonitorRequest,
  buildMetadataRequest,
  buildControlRequest,
  // Control-path pieces, so the probe can run the *same* ENABLE handshake the
  // live connection does rather than an approximation of it: this protocol
  // has no per-command ack, so "does control work" can only be answered by
  // doing exactly what a real session does and watching the read-back.
  buildEnableRequest,
  decodeSystemInfoModelAndPart,
  decodeVersionInfoMasterLibraryVersion,
  fetchActivationPayload,
  fetchGenericActivationPayload,
  resistanceLevelToRaw,
  decodeValue,
  decodeReadValues,
  metricsFromDecoded,
  decodeDeviceInfoSupportedIds,
  decodeDeviceInfoSerialNumber,
  decodeDeviceInfoSoftwareVersion,
  decodeResponseDeviceAddress,
  decodeSupportedDevices,
  decodeSupportedCommands,
  decodeSerialResponse,
  verifyFrameChecksum,
  frameCommandByte,
  frameStatus,
  cmdStatus: CMD_STATUS,
  expectedReadPayloadBytes,
  splitReadIdsIntoBatches,
  feedNotifyPacket,
  // FitPro2 identification — see the constants' own comment. The probe uses
  // these to tell a newer-generation console apart from a broken one.
  buildFitPro2Frame,
  parseFitPro2Response,
  fitPro2Device: FITPRO2_DEVICE,
  fitPro2Command: FITPRO2_COMMAND,
  fitPro2Response: FITPRO2_RESPONSE,
  emptyMetrics: EMPTY_IFIT_METRICS,
  pollIntervalMs: 1000,
  responseTimeoutMs: 1500,
} as const;

const POLL_INTERVAL_MS = IFIT_PROBE.pollIntervalMs;
const RESPONSE_TIMEOUT_MS = IFIT_PROBE.responseTimeoutMs;

// Per-command response timeout, transcribed from each decompiled command
// class's own ResponseTimeoutMs override (CommandBase's own default is
// 2500ms when a class doesn't override it). Previously every command shared
// one flat 1500ms wait — shorter than the real client's 2500ms default for
// uncommon commands (VersionInfo/SerialNumber/VerifySecurity all use it) and
// longer than the 1000ms it actually gives ReadWriteData/DeviceInfo/
// SystemInfo/the two SupportedX commands.
const COMMAND_TIMEOUT_MS: Partial<Record<number, number>> = {
  [COMMAND_WRITE_AND_READ]: 1000,
  [COMMAND_DEVICE_INFO]: 1000,
  [COMMAND_SYSTEM_INFO]: 1000,
  [COMMAND_SUPPORTED_CAPABILITIES]: 1000,
  [COMMAND_SUPPORTED_COMMANDS]: 1000,
  // VersionInfo, SerialNumber and ENABLE (VerifySecurity) don't override
  // CommandBase's default — 2500ms.
  [COMMAND_VERSION_INFO]: 2500,
  [COMMAND_ENABLE]: 2500,
};
function timeoutForCommand(command: number | null): number {
  if (command == null) return RESPONSE_TIMEOUT_MS;
  return COMMAND_TIMEOUT_MS[command] ?? 2500;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The five checks QueueManager.HandleBatchResponse + EquipmentUtil.
// IsValidCommandResponse run on every inbound frame, wired onto the live
// path for the first time — previously only the device probe ran any of
// this (checksumValid/responseCommand/expectedPayloadBytes were computed
// only for probe observations, never enforced on the connection real
// workouts use). On a validation failure the real client retries the exact
// same command (up to 4 times, extending its timeout each round) rather than
// treating one bad frame as fatal — approximated here with a fixed small
// number of retries and a short backoff, since this app's timeout is already
// sized per-command (see COMMAND_TIMEOUT_MS) rather than needing to grow.
export interface ValidatedIfitFrame {
  frame: number[] | null;
  status: number | null;
  ok: boolean;
}
async function sendAndValidate(
  sendAndWait: (
    packets: number[][],
    command?: number | null,
  ) => Promise<number[] | null>,
  packets: number[][],
  expectedCommand: number,
  expectedReadIds: number[] = [],
  maxAttempts = 3,
): Promise<ValidatedIfitFrame> {
  let lastFrame: number[] | null = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const frame = await sendAndWait(packets, expectedCommand);
    lastFrame = frame;
    const isLastAttempt = attempt === maxAttempts - 1;
    if (!frame) {
      if (!isLastAttempt) {
        await sleep(150 * (attempt + 1));
        continue;
      }
      return { frame: null, status: null, ok: false };
    }
    const checksumOk = verifyFrameChecksum(frame);
    const commandOk = frameCommandByte(frame) === expectedCommand;
    const expectedBytes = expectedReadIds.length
      ? expectedReadPayloadBytes(expectedReadIds)
      : 0;
    const actualBytes = Math.max(0, frame.length - 8);
    const lengthOk = expectedBytes === 0 || actualBytes >= expectedBytes;
    if (checksumOk === false || !commandOk || !lengthOk) {
      logBleEvent(
        `iFit: response failed validation (checksum=${checksumOk}, commandMatch=${commandOk}, lengthOk=${lengthOk}) — ${isLastAttempt ? "giving up" : "retrying"}.`,
      );
      if (!isLastAttempt) {
        await sleep(150 * (attempt + 1));
        continue;
      }
      return { frame: null, status: null, ok: false };
    }
    return { frame, status: frameStatus(frame), ok: true };
  }
  return { frame: null, status: null, ok: false };
}

// A GATT connect can fail transiently right after pairing (e.g. "GATT
// operation already in progress", or the Android BLE stack not being ready
// yet) — a few quick retries clear most of these without the user having to
// notice or re-pick the device. Same shape as MAX_RECONNECT_ATTEMPTS/
// RECONNECT_BACKOFF_MS below, just shorter — this is the initial handshake,
// not recovering a connection that was already live.
const MAX_GATT_CONNECT_ATTEMPTS = 3;
const GATT_CONNECT_BACKOFF_MS = [300, 800, 1500];

// Mirrors ble.ts's own reconnect loop — an unexpected mid-workout GATT
// disconnect (out of range, device sleep, etc.) gets a few backed-off
// attempts to silently resume before giving up and surfacing an error.
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 16000];

// Same shape/purpose as ble.ts's FTMS accumulator — rolled up into a
// CardioBleSummary so a workout finished on an iFit-only connection (e.g.
// the RW300, which has no FTMS at all) still gets its device readings saved
// to history, not just shown live and then discarded on exit.
interface IfitAccumulator {
  cardioType: CardioType;
  deviceName: string;
  speedSum: number;
  speedCount: number;
  maxSpeed: number | null;
  distanceM: number | null;
  // Same fix as ble.ts's Accumulator.distanceBaselineM — CurrentDistance is a
  // device-side cumulative odometer that isn't reset on connect, so this
  // session's distance is reported relative to whatever it first read here,
  // not from the device's own absolute zero.
  distanceBaselineM: number | null;
  // Same fix as ble.ts's Accumulator.distanceEstimateM/distanceRawTrusted —
  // a real device report found an FTMS treadmill whose Total Distance field
  // never updated live at all despite genuine movement the whole session;
  // this protocol's CurrentDistance is different hardware but the same
  // BLE-reporting-is-best-effort risk applies, so the same "prove it before
  // trusting it, fall back to a speed-integrated estimate otherwise" guard
  // is worth having here too. Treadmill only (CurrentKph — this protocol's
  // only readable live speed — is Treadmill-specific; see
  // READ_IDS_BY_CARDIO_TYPE), so Bike/Rower/Other still have no fallback to
  // estimate from, same limitation as before this fix.
  distanceEstimateM: number;
  distanceRawTrusted: boolean;
  heartRateSum: number;
  heartRateCount: number;
  maxHeartRateBpm: number | null;
  latestCaloriesKcal: number | null;
  // Logged once per connection — a device that blanks on every pause would
  // otherwise repeat the same line all session (see updateAccumulator).
  blankingReported: boolean;
  connectedAtMs: number;
  lastTickMs: number | null;
}

function freshIfitAccumulator(
  cardioType: CardioType,
  deviceName: string,
): IfitAccumulator {
  return {
    cardioType,
    deviceName,
    speedSum: 0,
    speedCount: 0,
    maxSpeed: null,
    distanceM: null,
    distanceBaselineM: null,
    distanceEstimateM: 0,
    distanceRawTrusted: false,
    heartRateSum: 0,
    heartRateCount: 0,
    maxHeartRateBpm: null,
    latestCaloriesKcal: null,
    blankingReported: false,
    connectedAtMs: Date.now(),
    lastTickMs: null,
  };
}

export function useIfitMonitor() {
  const supported = typeof navigator !== "undefined" && !!navigator.bluetooth;
  const [connecting, setConnecting] = useState(false);
  const [connected, setConnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const [metrics, setMetrics] = useState<IfitMetrics>(EMPTY_IFIT_METRICS);
  const [summary, setSummary] = useState<CardioBleSummary | null>(null);
  const [error, setError] = useState("");
  // Control surface — Treadmill only, since Kph (0) / Incline (1) are the
  // only writable characteristics this protocol documents (see this file's
  // header for the ENABLE handshake this drives).
  const [controllable, setControllable] = useState(false);
  // Per-field capability, derived from the device's own supported-BitFields
  // bitmap (see attachDevice) rather than assumed from cardio type — a bike
  // that declares BitField 2 (Resistance) now gets a resistance control it
  // never had before, and a device that declares Kph but also Rpm+Gear (i.e.
  // is actually some kind of bike/rower where Kph is a live *reading*, not a
  // target) is correctly excluded from speed control, matching the
  // decompiled ConsoleInfo.CanSetKph's own exclusion. Additive — `controllable`
  // above stays the single boolean the UI already keys off of.
  const [controllableFields, setControllableFields] = useState({
    speed: false,
    incline: false,
    resistance: false,
  });
  const [controlBusy, setControlBusy] = useState(false);
  const [controlError, setControlError] = useState("");
  const [supportedRanges, setSupportedRanges] = useState<IfitSupportedRanges>(
    EMPTY_IFIT_SUPPORTED_RANGES,
  );
  // EQUIPMENT_SERIAL's decoded string, once fetched — exposed mainly for
  // diagnostics (surfaced in the UI disclaimer) so a real-device report can
  // tell us whether it decoded to something sane and whether it actually
  // matched an activation-code entry, both currently unverified.
  const [deviceSerial, setDeviceSerial] = useState<string | null>(null);
  // Rower only — the device's own reported max resistance level (BitField
  // 42), read once per connection (see attachDevice) and fed into
  // resistanceLevelToRaw/rawToResistanceLevel so the encoding is correct for
  // whatever device is actually connected, not just the one this was
  // originally calibrated against. `resistanceLevels` is the reactive
  // (state) form for UI steppers; the ref is what setTargetResistance and
  // the poll loop read synchronously without waiting for a re-render.
  const [resistanceLevels, setResistanceLevels] = useState<number[]>(
    DEFAULT_RESISTANCE_LEVELS,
  );
  const maxResistanceLevelRef = useRef<number>(DEFAULT_MAX_RESISTANCE_LEVEL);
  const accRef = useRef<IfitAccumulator | null>(null);
  const equipmentRef = useRef<number | null>(null);
  // The activation payload actually sent with the last successful ENABLE —
  // kept so a write rejected with SecurityBlock mid-session (see CMD_STATUS
  // and sendControlWrite) can re-run ENABLE without re-deriving it from
  // scratch. `null` until the first ENABLE succeeds, or if the device never
  // needed one (e.g. a plain monitor-only connection).
  const lastEnablePayloadRef = useRef<number[] | null>(null);
  // Resolves once attachDevice's own post-connect handshake (DeviceInfo →
  // GetDeviceTree → EquipmentSerial → SystemInfo/VersionInfo → ENABLE) has
  // settled for the current connection — regardless of whether ENABLE
  // actually succeeded, was skipped (old software version), or wasn't
  // attempted at all (non-controllable device). `connected` flips true right
  // after the GATT/notify setup, several round trips (and, when the
  // activation payload isn't cached, a `fetch()` to this app's own backend)
  // *before* this does — see sendControlWrite's use of this below for why
  // that gap matters. Starts pre-resolved so a stray call before any
  // connection exists doesn't hang (sendControlWrite's own `equipment == null`
  // check catches that case anyway).
  const controlReadyRef = useRef<Promise<void>>(Promise.resolve());
  // Whether the app currently believes this device should be Running — set
  // by startDevice/resumeDevice, cleared by pauseDevice/emergencyStop/a new
  // connection. Read by the poll loop's autonomous-warm-up watch below: it's
  // what tells "the console is legitimately mid-warm-up because nobody has
  // asked it to run yet" apart from "the app asked for Running and the
  // console silently substituted its own countdown instead" — only the
  // latter should trigger a recovery attempt.
  const intendedRunningRef = useRef(false);
  // Guards the recovery attempt below so a still-in-flight resetToIdle()+
  // startDevice() (which itself takes up to MODE_CONFIRM_TIMEOUT_MS) isn't
  // re-triggered by the next 1s poll tick before it's had a chance to work.
  const recoveringFromWarmupRef = useRef(false);
  // Set once recoverFromStaleWarmup (defined later, after startDevice/
  // resetToIdle exist) is created — the poll loop inside attachDevice
  // (defined earlier in this hook) reads it through this ref rather than
  // closing over the function directly, the same forward-reference pattern
  // attemptReconnectRef uses below, so attachDevice's already-large
  // dependency list doesn't need to grow for it.
  const recoverFromStaleWarmupRef = useRef<(() => Promise<void>) | null>(null);

  const updateAccumulator = useCallback((m: IfitMetrics) => {
    const acc = accRef.current;
    if (!acc) return;
    if (m.speedKmh != null) {
      acc.speedSum += m.speedKmh;
      acc.speedCount++;
      if (acc.maxSpeed == null || m.speedKmh > acc.maxSpeed)
        acc.maxSpeed = m.speedKmh;
    }
    if (m.pulseBpm != null && m.pulseBpm > 0) {
      acc.heartRateSum += m.pulseBpm;
      acc.heartRateCount++;
      if (acc.maxHeartRateBpm == null || m.pulseBpm > acc.maxHeartRateBpm)
        acc.maxHeartRateBpm = m.pulseBpm;
    }
    // CurrentCalories is cumulative. Preserve it across console-side
    // pause/stop resets instead of replacing captured data with zero.
    if (m.caloriesKcal != null)
      acc.latestCaloriesKcal = Math.max(
        acc.latestCaloriesKcal ?? 0,
        m.caloriesKcal,
      );
    const now = Date.now();
    if (m.speedKmh != null && acc.lastTickMs != null) {
      const dtHours = (now - acc.lastTickMs) / 3_600_000;
      acc.distanceEstimateM += m.speedKmh * dtHours * 1000;
    }
    // A distance of exactly 0 after we have already seen real distance is the
    // device blanking its live values while idle, not a reading — the RW300
    // does this after a few seconds without rowing and restores the true
    // values when the user resumes (see deviceRegistry.ts's
    // blanksValuesWhenIdle). Believing it is worse than ignoring it: the
    // baseline below tracks the *minimum* distance ever seen, so a single
    // blanked 0 re-baselines the session to zero and every subsequent reading
    // is over-counted by the entire pre-pause distance.
    const blanked =
      m.distanceM === 0 && acc.distanceRawTrusted && (acc.distanceM ?? 0) > 0;
    if (blanked && !acc.blankingReported) {
      acc.blankingReported = true;
      logBleEvent(
        "iFit: live values blanked to 0 while idle — holding the last real distance rather than re-baselining the session to zero.",
      );
    }
    if (blanked) {
      // Hold the last good value; the device will restore the real one.
    } else if (m.distanceM != null) {
      // Tracked as the minimum seen so far, not just the first-ever reading
      // — see ble.ts's identical fix for why (a stale first notification
      // would otherwise pin distanceM at 0 forever).
      if (acc.distanceBaselineM == null || m.distanceM < acc.distanceBaselineM)
        acc.distanceBaselineM = m.distanceM;
      const relativeM = Math.max(0, m.distanceM - acc.distanceBaselineM);
      if (relativeM > 0) acc.distanceRawTrusted = true;
      acc.distanceM = acc.distanceRawTrusted
        ? relativeM
        : acc.distanceEstimateM;
    } else if (m.speedKmh != null) {
      acc.distanceM = acc.distanceEstimateM;
    }
    acc.lastTickMs = now;
    setSummary({
      deviceName: acc.deviceName,
      cardioType: acc.cardioType,
      avgSpeedKmh: acc.speedCount ? acc.speedSum / acc.speedCount : null,
      maxSpeedKmh: acc.maxSpeed,
      avgPowerW: null,
      maxPowerW: null,
      avgCadenceRpm: null,
      distanceKm: acc.distanceM != null ? acc.distanceM / 1000 : null,
      distanceEstimated: acc.distanceM != null && !acc.distanceRawTrusted,
      durationSec: (Date.now() - acc.connectedAtMs) / 1000,
      avgHeartRateBpm: acc.heartRateCount
        ? acc.heartRateSum / acc.heartRateCount
        : null,
      maxHeartRateBpm: acc.maxHeartRateBpm,
      caloriesKcal: acc.latestCaloriesKcal,
    });
  }, []);

  const deviceRef = useRef<BluetoothDevice | null>(null);
  const writeCharRef = useRef<BluetoothRemoteGATTCharacteristic | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reassemblyRef = useRef<number[][]>([]);
  const pendingResolveRef = useRef<(() => void) | null>(null);
  const lastFrameRef = useRef<number[] | null>(null);
  const runningRef = useRef(false);
  // The device this listener is attached to + the listener itself, kept
  // separate from deviceRef (which cleanup() below nulls) so it can still be
  // precisely removed later — without this, a previous connection's listener
  // stayed attached forever, and a delayed disconnect event from an old
  // device could fire after a new device is already connected.
  const disconnectedDeviceRef = useRef<BluetoothDevice | null>(null);
  const disconnectedHandlerRef = useRef<(() => void) | null>(null);
  // Set right before a user-initiated disconnect() so the gattserverdisconnected
  // listener it also fires can tell "I meant to do that" apart from a real
  // drop — same distinction ble.ts's intentionalRef makes. Bumping the token
  // additionally invalidates any reconnect loop already in flight (e.g. the
  // user disconnects manually mid-backoff-wait).
  const intentionalRef = useRef(false);
  const reconnectTokenRef = useRef(0);
  // Indirection so attachDevice's onGattDisconnected can call attemptReconnect
  // without attachDevice's own useCallback depending on it — attemptReconnect
  // itself depends on attachDevice, and a direct reference either way would
  // be a textual forward-reference in one of the two useCallback bodies.
  // Reassigned (see below, right after attemptReconnect's own declaration)
  // every render, so this ref is always the latest closure.
  const attemptReconnectRef = useRef<
    (
      device: BluetoothDevice,
      cardioType: CardioType,
      attempt: number,
      token: number,
    ) => void
  >(() => {});

  // `preserveAccumulator`: true for a mid-session drop that's about to retry
  // (onGattDisconnected, or a failed reconnect attempt inside attachDevice's
  // catch) — the accumulated distance/speed/etc so far is real and must
  // survive the reconnect, exactly like ble.ts's cleanupState() only wiping
  // accRef on final give-up/manual disconnect, never on a retry in between.
  const cleanup = useCallback((preserveAccumulator = false) => {
    endPassiveSession();
    runningRef.current = false;
    if (pollTimerRef.current) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    if (pendingResolveRef.current) {
      pendingResolveRef.current();
      pendingResolveRef.current = null;
    }
    reassemblyRef.current = [];
    writeCharRef.current = null;
    deviceRef.current = null;
    if (!preserveAccumulator) {
      accRef.current = null;
      setSummary(null);
    }
    equipmentRef.current = null;
    lastEnablePayloadRef.current = null;
    controlReadyRef.current = Promise.resolve();
    setConnected(false);
    setDeviceName(null);
    setControllable(false);
    setControllableFields({ speed: false, incline: false, resistance: false });
    setControlBusy(false);
    setControlError("");
    setSupportedRanges(EMPTY_IFIT_SUPPORTED_RANGES);
    setDeviceSerial(null);
    maxResistanceLevelRef.current = DEFAULT_MAX_RESISTANCE_LEVEL;
    setResistanceLevels(DEFAULT_RESISTANCE_LEVELS);
    intendedRunningRef.current = false;
    recoveringFromWarmupRef.current = false;
  }, []);

  const handleNotify = useCallback((event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const bytes: number[] = [];
    for (let i = 0; i < value.byteLength; i++) bytes.push(value.getUint8(i));
    const { chunks, frame } = feedNotifyPacket(reassemblyRef.current, bytes);
    reassemblyRef.current = chunks;
    if (frame) {
      lastFrameRef.current = frame;
      if (pendingResolveRef.current) {
        const resolve = pendingResolveRef.current;
        pendingResolveRef.current = null;
        resolve();
      }
    }
  }, []);

  // Web Bluetooth allows only one outstanding GATT operation per device at a
  // time — any writeValue()/readValue() started while another is still in
  // flight throws "GATT operation already in progress", not a queued/retried
  // one. This protocol has no per-command ack of its own to tell two
  // concurrent commands apart anyway (that's what the pendingResolveRef/
  // lastFrameRef dance below is doing — matching a response back to the
  // request that's waiting on it), so overlap here isn't just noisy, it's
  // actually unsafe: a second request's write can land while the first is
  // still awaiting its response, corrupting which reply goes with which call.
  // The poll loop (below) fires once a second for as long as the connection
  // is open, completely independently of whatever the UI/interval-programme
  // engine is doing — so a setTargetSpeed/Incline/Resistance call (typically
  // several in a row on an Assisted Programme's segment transitions) racing
  // against that tick was exactly this collision. sendRaw does the actual
  // write+wait; sendAndWait is what every caller (poll loop included) uses,
  // queuing so only one sendRaw is ever in flight.
  const sendRaw = useCallback(
    async (
      packets: number[][],
      timeoutMs: number,
    ): Promise<number[] | null> => {
      const writeChar = writeCharRef.current;
      if (!writeChar) return null;
      lastFrameRef.current = null;
      for (const bytes of packets)
        await writeChar.writeValue(new Uint8Array(bytes));
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          pendingResolveRef.current = null;
          resolve();
        };
        pendingResolveRef.current = finish;
        setTimeout(finish, timeoutMs);
      });
      return lastFrameRef.current;
    },
    [],
  );

  const sendQueueRef = useRef<
    {
      packets: number[][];
      timeoutMs: number;
      resolve: (v: number[] | null) => void;
      reject: (err: any) => void;
    }[]
  >([]);
  const drainingQueueRef = useRef(false);

  const drainSendQueue = useCallback(async () => {
    if (drainingQueueRef.current) return;
    drainingQueueRef.current = true;
    while (sendQueueRef.current.length) {
      const job = sendQueueRef.current.shift()!;
      // A couple of quick retries specifically for "GATT operation already in
      // progress" (thrown as an InvalidStateError) — belt-and-suspenders for
      // any GATT traffic outside this queue's control (e.g. the browser's own
      // internal bookkeeping right after connect), since the queue above
      // already serializes every command this module itself issues.
      let lastErr: any = null;
      let result: number[] | null = null;
      let ok = false;
      for (let attempt = 0; attempt < 3 && !ok; attempt++) {
        if (attempt > 0) {
          logBleEvent(
            `iFit sendAndWait retry ${attempt} after: ${lastErr?.message || lastErr?.name || "unknown error"}`,
          );
          await sleep(150 * attempt);
        }
        try {
          result = await sendRaw(job.packets, job.timeoutMs);
          ok = true;
        } catch (err: any) {
          lastErr = err;
          const busy =
            err?.name === "InvalidStateError" ||
            /already in progress/i.test(err?.message || "");
          if (!busy) break; // a real failure, not a busy-retry candidate — stop early
        }
      }
      if (ok) job.resolve(result);
      else
        job.reject(
          lastErr ??
            new Error(draftText("Could not communicate with the device.")),
        );
    }
    drainingQueueRef.current = false;
  }, [sendRaw]);

  // `command`, when given, looks up this command's own real response timeout
  // (see COMMAND_TIMEOUT_MS/timeoutForCommand) instead of the flat default —
  // every caller below now passes the command byte it's sending.
  const sendAndWait = useCallback(
    (
      packets: number[][],
      command: number | null = null,
    ): Promise<number[] | null> => {
      return new Promise((resolve, reject) => {
        sendQueueRef.current.push({
          packets,
          timeoutMs: timeoutForCommand(command),
          resolve,
          reject,
        });
        drainSendQueue();
      });
    },
    [drainSendQueue],
  );

  // The GATT connect + service/characteristic discovery is the step most
  // prone to a transient failure right after pairing (e.g. "GATT operation
  // already in progress", or the adapter not being fully ready yet) — a
  // failure here doesn't mean the device is unreachable, just that this
  // particular attempt needs a moment before trying again. Isolated from the
  // rest of attachDevice's setup (which only makes sense once this succeeds)
  // so a retry here doesn't re-run notification/handshake side effects.
  const connectGattWithRetry = useCallback(async (device: BluetoothDevice) => {
    if (!device.gatt)
      throw new Error(draftText("This device does not support GATT."));
    let lastErr: any = null;
    for (let attempt = 0; attempt < MAX_GATT_CONNECT_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        logBleEvent(
          `iFit GATT connect attempt ${attempt + 1}/${MAX_GATT_CONNECT_ATTEMPTS} for "${device.name || "device"}" (previous: ${lastErr?.message || lastErr?.name || "unknown error"}).`,
        );
        await sleep(GATT_CONNECT_BACKOFF_MS[attempt - 1]);
      }
      try {
        const server = await device.gatt.connect();
        const service = await server.getPrimaryService(IFIT_SERVICE_UUID);
        const writeChar = await service.getCharacteristic(IFIT_WRITE_UUID);
        const notifyChar = await service.getCharacteristic(IFIT_NOTIFY_UUID);
        return { server, writeChar, notifyChar };
      } catch (err: any) {
        lastErr = err;
        // A half-open GATT session from the failed attempt above can block
        // the next one from ever completing — disconnect before retrying.
        try {
          device.gatt.disconnect();
        } catch {}
      }
    }
    throw lastErr;
  }, []);

  // Core attach logic, given an already-selected BluetoothDevice — shared by
  // connect() (which picks the device itself via requestDevice()) and
  // connectWithDevice() (which reuses a device someone else already picked,
  // e.g. ble.ts's FTMS attempt handing off a device that turned out to have
  // no FTMS service — see that module's onFtmsUnavailable). Only
  // requestDevice() itself needs a fresh user gesture; a new GATT connection
  // on a device the browser already granted access to doesn't, which is
  // exactly what makes that automatic handoff possible.
  const attachDevice = useCallback(
    async (
      device: BluetoothDevice,
      cardioType: CardioType,
      onDetected?: (detected: CardioType) => void,
      isReconnectAttempt = false,
    ) => {
      logBleEvent(
        `iFit attachDevice() called for "${device.name || "unnamed device"}" (${cardioType}).`,
      );
      setError("");
      setConnecting(true);
      // May be corrected below once DeviceInfo actually responds — declared
      // with `let` (not const) up front so onGattDisconnected's closure, and
      // everything after the detection block, both see the corrected value.
      let effectiveCardioType = cardioType;
      // See controlReadyRef's own comment above. Resolved once the ENABLE
      // handshake below settles one way or another (success/skip/failure), or
      // immediately if this whole connection attempt fails outright.
      let markControlReady: () => void = () => {};
      controlReadyRef.current = new Promise<void>((resolve) => {
        markControlReady = resolve;
      });
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
        const { writeChar, notifyChar } = await connectGattWithRetry(device);
        writeCharRef.current = writeChar;
        notifyChar.addEventListener("characteristicvaluechanged", handleNotify);
        await notifyChar.startNotifications();

        const onGattDisconnected = () => {
          if (intentionalRef.current) return; // handled by disconnect() itself
          logBleEvent(
            `Unexpected GATT disconnect from "${device.name || "device"}" (iFit) — starting reconnect.`,
          );
          reconnectTokenRef.current++;
          const token = reconnectTokenRef.current;
          cleanup(true);
          setReconnecting(true);
          attemptReconnectRef.current(device, effectiveCardioType, 0, token);
        };
        device.addEventListener("gattserverdisconnected", onGattDisconnected);
        disconnectedDeviceRef.current = device;
        disconnectedHandlerRef.current = onGattDisconnected;

        runningRef.current = true;
        const resolvedName = device.name || "iFit device";
        // Per-device overrides (see deviceRegistry.ts). maxResistanceLevel here
        // is a *fallback* only — the live BitField 42 read below still wins
        // where the device answers it, since a real reading always beats a
        // recorded one.
        const quirks = lookupQuirks("iFit", device.name);
        logBleEvent(describeMatch("iFit", device.name));
        if (quirks.maxResistanceLevel) {
          maxResistanceLevelRef.current = quirks.maxResistanceLevel;
          setResistanceLevels(
            resistanceLevelsForMax(quirks.maxResistanceLevel),
          );
        }
        logBleEvent(`Connected to "${resolvedName}" via iFit GATT service.`);
        setDeviceName(resolvedName);
        setConnected(true);
        // Passive conformance recording for the whole workout, so a later
        // "Report a connection issue" ships findings instead of raw log.
        beginPassiveSession("iFit", resolvedName, cardioType, null);

        // Last-resort fallback only, if DeviceInfo(Main) below gets no answer
        // at all — see EQUIPMENT_BY_CARDIO_TYPE's own comment.
        let equipment = EQUIPMENT_BY_CARDIO_TYPE[cardioType];

        // DeviceInfo is always addressed to Main (0x02) — this is what the
        // real client does (`new DeviceInfoCmd(Device.Main)`), and it's what
        // makes the rest of this unconditional rather than a guess: the
        // response's own device byte (full-frame offset 4, see
        // decodeResponseDeviceAddress) tells us exactly what equipment this
        // console is, because CommandBase.SetResponseBytes echoes the real bus
        // address there. This replaces an earlier Treadmill-then-Rower
        // guess-and-retry that was solving a problem the protocol already
        // answers directly — and it widens equipment detection to bikes and
        // everything else in the full Device enum, which that guess never
        // could (it only ever tried the two addresses matching the *requested*
        // cardio type).
        //
        // The response also doubles as the activation-code derivation's
        // serial-number source (below) and the supported-BitFields bitmap
        // READ_IDS_BY_CARDIO_TYPE gets filtered against right after. See
        // decodeDeviceInfoSupportedIds's comment for why that filtering
        // matters: without it, a device that doesn't implement one of the
        // requested ids (e.g. Pulse on a treadmill with no heart-rate grip)
        // silently corrupts every metric requested after it.
        let deviceInfoFrame: number[] | null = null;
        try {
          const result = await sendAndValidate(
            sendAndWait,
            buildMetadataRequest(EQUIPMENT.MAIN, COMMAND_DEVICE_INFO),
            COMMAND_DEVICE_INFO,
          );
          deviceInfoFrame = result.frame;
        } catch {}

        if (deviceInfoFrame) {
          const realAddress = decodeResponseDeviceAddress(deviceInfoFrame);
          if (realAddress != null) {
            equipment = realAddress;
            const mapped = DEVICE_TO_CARDIO_TYPE[realAddress];
            if (mapped && mapped !== cardioType) {
              logBleEvent(
                `iFit: DeviceInfo reports this console is a ${mapped} (address 0x${realAddress.toString(16)}, was connecting as ${cardioType}) — relabeling.`,
              );
              effectiveCardioType = mapped;
              onDetected?.(mapped);
            }
          }
        } else {
          logBleEvent(
            `iFit: DeviceInfo(Main) got no response — falling back to the assumed "${cardioType}" address.`,
          );
        }
        equipmentRef.current = equipment;
        // A reconnect attempt reattaches to the same in-progress session — the
        // accumulator already tracks real distance/speed from before the drop,
        // and cleanup(true) above deliberately left it in place. Only a brand
        // new connect()/connectWithDevice() (isReconnectAttempt === false)
        // should start counting from zero.
        if (!isReconnectAttempt || !accRef.current) {
          accRef.current = freshIfitAccumulator(
            effectiveCardioType,
            resolvedName,
          );
        }

        // GetDeviceTree, unconditionally, right after DeviceInfo — matches the
        // real client. SupportedCommands in particular gates which metadata
        // commands are worth even trying below (a device that doesn't declare
        // SystemInfo has no PartNumber/Model to give the activation-code
        // derivation anyway).
        let supportedCommands: number[] | null = null;
        try {
          const devicesResult = await sendAndValidate(
            sendAndWait,
            buildMetadataRequest(equipment, COMMAND_SUPPORTED_CAPABILITIES),
            COMMAND_SUPPORTED_CAPABILITIES,
          );
          const commandsResult = await sendAndValidate(
            sendAndWait,
            buildMetadataRequest(equipment, COMMAND_SUPPORTED_COMMANDS),
            COMMAND_SUPPORTED_COMMANDS,
          );
          const supportedDevices = devicesResult.frame
            ? decodeSupportedDevices(devicesResult.frame)
            : null;
          supportedCommands = commandsResult.frame
            ? decodeSupportedCommands(commandsResult.frame)
            : null;
          if (supportedDevices)
            logBleEvent(
              `iFit: device declares sub-devices [${supportedDevices.join(", ")}].`,
            );
          if (supportedCommands)
            logBleEvent(
              `iFit: device declares supported commands [${supportedCommands.map((c) => "0x" + c.toString(16)).join(", ")}].`,
            );
        } catch {}
        // Fails open (treats as supported) when the bitmap itself is unknown —
        // matches this app's existing permissive posture everywhere else a
        // device's own declaration is missing rather than negative.
        const commandSupported = (cmd: number) =>
          supportedCommands ? supportedCommands.includes(cmd) : true;

        const supportedIds = deviceInfoFrame
          ? decodeDeviceInfoSupportedIds(deviceInfoFrame)
          : null;
        const requestedReadIds = READ_IDS_BY_CARDIO_TYPE[effectiveCardioType];
        const readIds = supportedIds
          ? requestedReadIds.filter((id) => supportedIds.has(id))
          : requestedReadIds;
        if (supportedIds) {
          const dropped = requestedReadIds.filter(
            (id) => !supportedIds.has(id),
          );
          if (dropped.length)
            logBleEvent(
              `iFit: device doesn't support BitFields [${dropped.join(", ")}] — dropped from monitor reads to keep the rest aligned.`,
            );
        } else {
          logBleEvent(
            "iFit: DeviceInfo unavailable — requesting all fields unfiltered (risk of read misalignment if any are unsupported).",
          );
        }
        const monitorRequest = buildMonitorRequest(equipment, readIds);

        // Controllability is derived from the device's own supported-BitFields
        // bitmap (per-field, matching the decompiled ConsoleInfo.CanSetKph/
        // CanSetIncline/CanSetResistance) rather than assumed from cardio
        // type — a bike or "Other" device that genuinely declares Kph, Grade
        // or Resistance now gets a control surface it never had before, where
        // previously only Treadmill/Rower were considered controllable at all
        // regardless of what the device actually supports. Falls back to the
        // old type-based guess only when the bitmap itself is unknown (e.g.
        // DeviceInfo failed to answer), since there's nothing else to go on.
        const supportsKphField = supportedIds?.has(0) ?? null;
        const supportsGradeField = supportedIds?.has(1) ?? null;
        const supportsResistanceField = supportedIds?.has(2) ?? null;
        const isControllable = supportedIds
          ? (supportsKphField ||
              supportsGradeField ||
              supportsResistanceField) === true
          : effectiveCardioType === "Treadmill" ||
            effectiveCardioType === "Rower";
        setControllable(isControllable);
        if (isControllable) {
          // Fetch EQUIPMENT_SERIAL for diagnostics (surfaced in the UI
          // disclaimer) — no longer needed for activation-code matching (see
          // below), but still useful to confirm what the device reports.
          // Gated on SupportedCommands when it's known, same as SystemInfo/
          // VersionInfo below — no point spending a round trip and a 2.5s
          // timeout on a command the device already told us it doesn't have.
          let serial: string | null = null;
          if (commandSupported(COMMAND_EQUIPMENT_SERIAL)) {
            try {
              // SerialNumberCmd, like SystemInfoCmd/VersionInfoCmd below,
              // defaults to Device.Main in the real client and is never
              // constructed with the learned equipment address anywhere in
              // FitPro1Console — confirmed against the real RW300 capture,
              // whose EQUIPMENT_SERIAL request is addressed to Main (0x02) even
              // though this same session's SupportedDevices/SupportedCommands
              // requests are addressed to the console's real learned address
              // (Rower, 0x14). Only GetDeviceTree (SupportedDevices/
              // SupportedCommands) and ReadWriteData/VerifySecurity use the
              // learned address.
              const result = await sendAndValidate(
                sendAndWait,
                buildMetadataRequest(EQUIPMENT.MAIN, COMMAND_EQUIPMENT_SERIAL),
                COMMAND_EQUIPMENT_SERIAL,
              );
              if (result.frame) serial = decodeSerialResponse(result.frame);
            } catch {}
          }
          logBleEvent(
            `EQUIPMENT_SERIAL: ${serial || "(no response / not decoded / not supported)"}`,
          );
          setDeviceSerial(serial);

          // Compute the real ENABLE payload from the device's own reported
          // serial/part/model numbers + master library version — see
          // buildActivationPayload and IFIT_PROTOCOL.md's "ENABLE /
          // Activation-Code Handshake" section. Falls back to the generic
          // hardcoded code (see GENERIC_ACTIVATION_PAYLOAD) only if any of
          // these three reads fail — e.g. a comms hiccup mid-connection.
          let activationPayload: number[] | null = null;
          let softwareVersion: number | null = null;
          try {
            // sendAndWait shares single module-level refs (lastFrameRef,
            // pendingResolveRef) across calls, so these reads must run
            // sequentially, not via Promise.all — concurrent calls would let
            // one command's response get attributed to a different command,
            // or their chunked packets interleave on the wire mid-write.
            // deviceInfoFrame was already fetched above (for the supported-ids
            // filter) — reused here instead of fetching it a second time.
            softwareVersion = decodeDeviceInfoSoftwareVersion(
              deviceInfoFrame ?? [],
            );
            // SystemInfoCmd/VersionInfoCmd also default to Device.Main and are
            // never constructed with the learned equipment address anywhere in
            // the real client — see EQUIPMENT_SERIAL's own comment just above
            // for the capture evidence.
            const systemInfoFrame = commandSupported(COMMAND_SYSTEM_INFO)
              ? (
                  await sendAndValidate(
                    sendAndWait,
                    buildMetadataRequest(EQUIPMENT.MAIN, COMMAND_SYSTEM_INFO),
                    COMMAND_SYSTEM_INFO,
                  )
                ).frame
              : null;
            const versionInfoFrame = commandSupported(COMMAND_VERSION_INFO)
              ? (
                  await sendAndValidate(
                    sendAndWait,
                    buildMetadataRequest(EQUIPMENT.MAIN, COMMAND_VERSION_INFO),
                    COMMAND_VERSION_INFO,
                  )
                ).frame
              : null;
            const serialNumber = deviceInfoFrame
              ? decodeDeviceInfoSerialNumber(deviceInfoFrame)
              : null;
            const modelAndPart = systemInfoFrame
              ? decodeSystemInfoModelAndPart(systemInfoFrame)
              : null;
            const masterLibraryVersion = versionInfoFrame
              ? decodeVersionInfoMasterLibraryVersion(versionInfoFrame)
              : null;
            if (
              serialNumber != null &&
              modelAndPart != null &&
              masterLibraryVersion != null
            ) {
              activationPayload = await fetchActivationPayload(
                serialNumber,
                modelAndPart.partNumber,
                modelAndPart.model,
                masterLibraryVersion,
              );
            }
          } catch {}

          // FitPro1Console only calls Unlock() `if (PrimaryDevice.SoftwareVersion
          // > 75)` — this app previously sent ENABLE unconditionally. Fails
          // open (still sends it) when the software version itself couldn't be
          // read, since attempting an unneeded ENABLE is harmless while
          // skipping a needed one leaves every write silently discarded.
          const shouldSendEnable =
            softwareVersion == null || softwareVersion > 75;
          if (shouldSendEnable) {
            logBleEvent(
              activationPayload
                ? "Sending ENABLE — computed activation payload from device info."
                : "Sending ENABLE — falling back to generic activation code (device info unavailable).",
            );
            // Unlock control once per connection before anything else.
            // ENABLE's own response status (see CMD_STATUS/frameStatus) now
            // settles success/failure directly — VerifySecurityCmd's real
            // IsUnlocked is literally `Status == Done` — rather than the
            // "unknowable" this file's comments previously claimed. Still
            // best-effort: a bad ENABLE doesn't block the connection, since
            // setTargetSpeed/Incline/Resistance's own SecurityBlock handling
            // (see sendControlWrite) is the second line of defence.
            try {
              const enablePayload =
                activationPayload ??
                (await fetchGenericActivationPayload().catch(() => null));
              if (enablePayload) {
                lastEnablePayloadRef.current = enablePayload;
                const result = await sendAndValidate(
                  sendAndWait,
                  buildEnableRequest(equipment, enablePayload),
                  COMMAND_ENABLE,
                );
                if (
                  result.status != null &&
                  result.status !== CMD_STATUS.DONE
                ) {
                  logBleEvent(
                    `iFit: ENABLE responded with status ${result.status} (not Done) — control may not actually be unlocked.`,
                  );
                }
              }
            } catch {}
          } else {
            logBleEvent(
              `iFit: device software version (${softwareVersion}) is 75 or below — the real client skips ENABLE for these, so this connection does too.`,
            );
          }

          // ENABLE has now been sent (or deliberately skipped) — this is the
          // earliest point a WorkoutMode/speed/incline/resistance write is
          // actually safe to send. Resolving here, rather than after the
          // capability reads below, keeps the wait as short as possible: those
          // reads are read-only queries with nothing to do with the unlock
          // state a control write depends on.
          markControlReady();

          // Best-effort, one-shot capability reads — same spirit as ble.ts's
          // Supported Speed/Inclination Range read, but nothing here is
          // confirmed against a real device, so a failure or missing value
          // just falls back to the defaults rather than blocking the
          // connection. Gated on the device's own declared support for each
          // field (falling back to the old cardio-type guess when that's
          // unknown) rather than the requested cardio type alone — a
          // multi-mode machine could plausibly declare both.
          const wantSpeedOrIncline = supportedIds
            ? supportsKphField || supportsGradeField
            : effectiveCardioType === "Treadmill";
          const wantResistance = supportedIds
            ? supportsResistanceField
            : effectiveCardioType === "Rower";
          let speedRange: IfitSupportedRange | null = null;
          let inclineRange: IfitSupportedRange | null = null;
          if (wantSpeedOrIncline) {
            try {
              const rangeIds = [27, 28, 30, 31].filter((id) =>
                supportedIds ? supportedIds.has(id) : true,
              );
              const result = rangeIds.length
                ? await sendAndValidate(
                    sendAndWait,
                    buildControlRequest(equipment, {}, rangeIds),
                    COMMAND_WRITE_AND_READ,
                    rangeIds,
                  )
                : null;
              if (result?.frame) {
                const decoded = decodeReadValues(result.frame, rangeIds);
                speedRange =
                  decoded.MinKph != null && decoded.MaxKph != null
                    ? {
                        min: decoded.MinKph,
                        max: decoded.MaxKph,
                        increment: DEFAULT_IFIT_SPEED_RANGE.increment,
                      }
                    : null;
                inclineRange =
                  decoded.MinIncline != null && decoded.MaxIncline != null
                    ? {
                        min: decoded.MinIncline,
                        max: decoded.MaxIncline,
                        increment: DEFAULT_IFIT_INCLINE_RANGE.increment,
                      }
                    : null;
                setSupportedRanges({
                  speed: speedRange,
                  incline: inclineRange,
                });
              }
            } catch {
              /* not exposed / no response — falls back to the defaults */
            }
          }
          if (wantResistance) {
            try {
              const result = await sendAndValidate(
                sendAndWait,
                buildControlRequest(equipment, {}, [42]),
                COMMAND_WRITE_AND_READ,
                [42],
              );
              if (result.frame) {
                const decoded = decodeReadValues(result.frame, [42]);
                if (
                  decoded.MaxResistanceLevel != null &&
                  decoded.MaxResistanceLevel > 0
                ) {
                  maxResistanceLevelRef.current = decoded.MaxResistanceLevel;
                  setResistanceLevels(
                    resistanceLevelsForMax(decoded.MaxResistanceLevel),
                  );
                }
              }
            } catch {
              /* not exposed / no response — falls back to DEFAULT_MAX_RESISTANCE_LEVEL */
            }
          }

          // Final per-field capability, matching the decompiled ConsoleInfo:
          // Kph excludes a device that also reports Rpm+Gear (that combination
          // means Kph is a live *reading* on this device — a bike/rower — not
          // a target), and both Kph/Incline additionally require a real
          // min<max range once one was read.
          setControllableFields({
            speed:
              !!supportsKphField &&
              !(
                (supportedIds?.has(5) ?? false) &&
                (supportedIds?.has(26) ?? false)
              ) &&
              (speedRange ? speedRange.max > speedRange.min : true),
            incline:
              !!supportsGradeField &&
              (inclineRange ? inclineRange.max > inclineRange.min : true),
            resistance:
              !!supportsResistanceField && maxResistanceLevelRef.current >= 2,
          });
        } else {
          // Non-controllable device (monitor-only) — no ENABLE is ever sent
          // for this connection, so there's nothing to wait for.
          markControlReady();
        }

        const pollLoop = async () => {
          if (!runningRef.current) return;
          try {
            const result = await sendAndValidate(
              sendAndWait,
              monitorRequest,
              COMMAND_WRITE_AND_READ,
              readIds,
            );
            if (
              result.ok &&
              result.frame &&
              (result.status == null || result.status === CMD_STATUS.DONE)
            ) {
              const rawValues = decodeReadValues(result.frame, readIds);
              const decoded = metricsFromDecoded(
                rawValues,
                maxResistanceLevelRef.current,
                quirks.distanceScale ?? 1,
              );
              setMetrics(decoded);
              updateAccumulator(decoded);
              if (decoded.activationLocked === true) {
                logBleEvent(
                  "iFit: device reports itself as activation-locked mid-session — writes may be silently discarded until re-unlocked.",
                );
              }
              // See recoverFromStaleWarmup's own comment — the console can
              // enter an autonomous warm-up countdown on its own, mid-workout,
              // well after the app's own Idle->Running edge already succeeded.
              // Fire-and-forget: recoveringFromWarmupRef stops this from being
              // re-triggered every tick while a recovery attempt is in flight.
              if (
                rawValues.Mode === WORKOUT_MODE.WARM_UP &&
                intendedRunningRef.current &&
                !recoveringFromWarmupRef.current
              ) {
                /* Recovery requires an explicit user resume. */
              }
              // Passive conformance recording — sampled down internally and a
              // no-op outside a session. See passiveProbe.ts.
              recordIfitMetrics(
                decoded,
                result.frame
                  .map((b) => b.toString(16).padStart(2, "0"))
                  .join(" "),
              );
            } else if (result.frame && result.status != null) {
              logBleEvent(
                `iFit: monitor read rejected with status ${result.status} — skipping this tick.`,
              );
            }
          } catch {
            /* a single failed poll isn't fatal — try again next cycle */
          }
          if (runningRef.current)
            pollTimerRef.current = setTimeout(pollLoop, POLL_INTERVAL_MS);
        };
        pollLoop();
      } catch (err: any) {
        logBleEvent(
          `iFit connect failed for "${device.name || "device"}": ${err?.message || err?.name || "unknown error"}`,
        );
        setError(
          adminError(
            err,
            "Could not connect to this device as an iFit monitor.",
          ),
        );
        // device.gatt.connect() (or a getCharacteristic call) may have already
        // succeeded before this failed — leaving the browser's GATT session
        // open with nothing here able to reach it once cleanup() nulls the
        // refs. Disconnect explicitly so a retry starts clean. Safe to do
        // unconditionally here (unlike ble.ts's equivalent fix): the
        // gattserverdisconnected listener above is only registered after full
        // success, so it can't still be armed at this point.
        try {
          device.gatt?.disconnect();
        } catch {}
        cleanup(isReconnectAttempt);
      } finally {
        setConnecting(false);
      }
    },
    [
      handleNotify,
      sendAndWait,
      cleanup,
      updateAccumulator,
      connectGattWithRetry,
    ],
  );

  // Backed-off retries for a mid-workout drop — mirrors ble.ts's own
  // attemptReconnect. attachDevice swallows its own errors internally
  // (cleanup() + setError, no rethrow — see its catch block) rather than
  // rejecting, so success is read back via deviceRef.current instead of a
  // try/catch: attachDevice sets it to `device` on entry and cleanup() (its
  // own failure path) nulls it back out, so it's still `device` afterward
  // only if this attempt actually completed.
  const attemptReconnect = useCallback(
    async (
      device: BluetoothDevice,
      cardioType: CardioType,
      attempt: number,
      token: number,
    ) => {
      if (token !== reconnectTokenRef.current) return; // superseded by a manual disconnect/new connect
      if (attempt >= MAX_RECONNECT_ATTEMPTS) {
        const name = device.name || draftText("the device");
        logBleEvent(
          `iFit reconnect exhausted (${MAX_RECONNECT_ATTEMPTS} attempts) — giving up on "${name}".`,
        );
        cleanup();
        setReconnecting(false);
        setReconnectAttempt(0);
        setError(
          draftFormat("Lost connection to {device} and could not reconnect.", {
            device: name,
          }),
        );
        return;
      }
      logBleEvent(
        `iFit reconnect attempt ${attempt + 1}/${MAX_RECONNECT_ATTEMPTS} starting.`,
      );
      setReconnectAttempt(attempt + 1);
      await sleep(RECONNECT_BACKOFF_MS[attempt]);
      if (token !== reconnectTokenRef.current) return;
      await attachDevice(device, cardioType, undefined, true);
      if (token !== reconnectTokenRef.current) return;
      if (deviceRef.current === device) {
        logBleEvent(`iFit reconnect attempt ${attempt + 1} succeeded.`);
        setReconnecting(false);
        setReconnectAttempt(0);
      } else {
        logBleEvent(`iFit reconnect attempt ${attempt + 1} failed.`);
        attemptReconnect(device, cardioType, attempt + 1, token);
      }
    },
    [attachDevice, cleanup],
  );
  attemptReconnectRef.current = attemptReconnect;

  const connect = useCallback(
    async (
      cardioType: CardioType,
      onDetected?: (detected: CardioType) => void,
    ) => {
      logBleEvent(`iFit connect() called directly for ${cardioType}.`);
      if (!navigator.bluetooth) {
        setError(draftText("Web Bluetooth is not supported in this browser."));
        return;
      }
      setError("");
      setConnecting(true);
      intentionalRef.current = false;
      reconnectTokenRef.current++;
      setReconnecting(false);
      setReconnectAttempt(0);
      let device: BluetoothDevice;
      try {
        // Known iFIT names cover models that omit their service from advertising.
        device = await navigator.bluetooth.requestDevice(
          fitnessPickerOptions("iFIT"),
        );
      } catch (err: any) {
        if (err?.name !== "NotFoundError") {
          logBleEvent(
            `iFit device picker failed: ${err?.message || err?.name || "unknown error"}`,
          );
          setError(adminError(err, "Could not connect."));
        } else {
          logBleEvent("iFit device picker cancelled by user.");
        }
        setConnecting(false);
        return;
      }
      await attachDevice(device, cardioType, onDetected);
    },
    [attachDevice],
  );

  // No requestDevice() call — see attachDevice's comment above.
  const connectWithDevice = useCallback(
    (
      device: BluetoothDevice,
      cardioType: CardioType,
      onDetected?: (detected: CardioType) => void,
    ) => {
      intentionalRef.current = false;
      reconnectTokenRef.current++;
      setReconnecting(false);
      setReconnectAttempt(0);
      return attachDevice(device, cardioType, onDetected);
    },
    [attachDevice],
  );

  // Every control write goes through this, rather than a bare sendAndWait —
  // it's what makes CMD_STATUS.SECURITY_BLOCK (see this file's header on
  // CMD_STATUS) actually actionable: a write rejected because the device
  // re-locked itself (or ENABLE never really took) now gets ENABLE re-sent
  // once, using the same payload the connection originally computed (see
  // lastEnablePayloadRef), before retrying the write itself. Previously a
  // SecurityBlock response looked identical to success — no response byte
  // was checked at all — so this is the actual recovery path for "my writes
  // are being silently ignored" that this file had no answer for before.
  //
  // Awaiting controlReadyRef first closes a real race: `equipmentRef` (the
  // "not connected" check just below) is set as soon as DeviceInfo answers,
  // which is *before* attachDevice has even sent ENABLE — several round
  // trips, plus a possible network fetch for the activation payload, still
  // stand between "not connected" being false and the device actually being
  // unlocked. A call landing in that gap (e.g. starting an Assisted
  // Programme immediately after the BLE picker closes) used to reach the
  // device before ENABLE, get rejected with SecurityBlock, and have no
  // retry available yet either (`lastEnablePayloadRef` is only populated
  // once ENABLE itself has been sent) — so the write was silently dropped
  // and the console kept running whatever stale workout/countdown it was
  // already in. A manual stop+restart "fixed" it only because attachDevice's
  // handshake had finished unlocking the device in the background by then.
  // See sessionStore.tsx's setIntervalProgramme for the call site this was
  // originally reported against.
  const sendControlWrite = useCallback(
    async (writeValues: Partial<Record<number, number>>): Promise<void> => {
      const equipment = equipmentRef.current;
      if (equipment == null) throw new Error(draftText("Not connected."));
      await controlReadyRef.current;
      let result = await sendAndValidate(
        sendAndWait,
        buildControlRequest(equipment, writeValues, []),
        COMMAND_WRITE_AND_READ,
      );
      if (
        result.status === CMD_STATUS.SECURITY_BLOCK &&
        lastEnablePayloadRef.current
      ) {
        logBleEvent(
          "iFit: write rejected (SecurityBlock) — re-sending ENABLE and retrying once.",
        );
        await sendAndValidate(
          sendAndWait,
          buildEnableRequest(equipment, lastEnablePayloadRef.current),
          COMMAND_ENABLE,
        );
        result = await sendAndValidate(
          sendAndWait,
          buildControlRequest(equipment, writeValues, []),
          COMMAND_WRITE_AND_READ,
        );
      }
      if (!result.ok || !result.frame)
        throw new Error(draftText("The device did not respond."));
      if (result.status != null && result.status !== CMD_STATUS.DONE) {
        throw new Error(
          draftFormat("The device rejected the command (status {status}).", {
            status: result.status,
          }),
        );
      }
    },
    [sendAndWait],
  );

  // Fire-and-forget target writes, same shape as ble.ts's setTargetSpeed/
  // setTargetIncline — clamp to the device's own reported range when known,
  // otherwise this app's own default policy, then send via sendControlWrite,
  // whose own SecurityBlock recovery and status check are what actually
  // distinguish "the device rejected this" from "it worked" now (see that
  // helper's comment) — previously "the device sent back a response frame at
  // all" was the only signal available.
  const setTargetSpeed = useCallback(
    async (kmh: number) => {
      const range = supportedRanges.speed || DEFAULT_IFIT_SPEED_RANGE;
      const clamped = Math.max(range.min, Math.min(range.max, kmh));
      setControlError("");
      setControlBusy(true);
      try {
        await sendControlWrite({ 0: clamped });
      } catch (err: any) {
        setControlError(adminError(err, "Could not set target speed."));
        throw err;
      } finally {
        setControlBusy(false);
      }
    },
    [sendControlWrite, supportedRanges],
  );

  const setTargetIncline = useCallback(
    async (pct: number) => {
      const range = supportedRanges.incline || DEFAULT_IFIT_INCLINE_RANGE;
      const clamped = Math.max(range.min, Math.min(range.max, pct));
      setControlError("");
      setControlBusy(true);
      try {
        await sendControlWrite({ 1: clamped });
      } catch (err: any) {
        setControlError(adminError(err, "Could not set target incline."));
        throw err;
      } finally {
        setControlBusy(false);
      }
    },
    [sendControlWrite, supportedRanges],
  );

  // Rower only. Writes characteristic ID 2 — confirmed to actually move the
  // device's real resistance by a full 26-level sweep against real hardware.
  // Uses resistanceLevelToRaw's formula (parameterized by whatever
  // MaxResistanceLevel this specific device reported during connection —
  // see attachDevice) instead of a fixed calibration table. An interim
  // attempt switched this to characteristic ID 12 based on an independent
  // write-up's claim, but that produced no resistance change at all on real
  // hardware; reverted back to ID 2.
  const setTargetResistance = useCallback(
    async (level: number) => {
      const raw = resistanceLevelToRaw(level, maxResistanceLevelRef.current);
      setControlError("");
      setControlBusy(true);
      try {
        await sendControlWrite({ 2: raw });
      } catch (err: any) {
        setControlError(adminError(err, "Could not set target resistance."));
        throw err;
      } finally {
        setControlBusy(false);
      }
    },
    [sendControlWrite],
  );

  // Start/stop, by writing the console's WorkoutMode (BitField 12).
  //
  // This protocol has no dedicated Start or Stop command the way FTMS does —
  // driving the mode field *is* the mechanism. BitField 12 is writable per the
  // decompiled BitFieldInfo attribute, and the official app's own captured
  // startup sequence ends by writing 12 = 2 (Running), which is the
  // corroboration that this is how it is meant to be used.
  //
  // The response status (see sendControlWrite) is now real confirmation, not
  // just "a frame came back" — but the read-back of BitField 12 in the poll
  // loop (`metrics.running`) is still worth watching too, since Status=Done
  // only means the write was accepted, not that the console's own physical
  // state actually changed.
  const setWorkoutMode = useCallback(
    async (mode: number, label: string) => {
      setControlError("");
      setControlBusy(true);
      // Tracks what the app is actually asking the console to do, independent
      // of whether the write is later confirmed — see intendedRunningRef's own
      // comment for what this gates.
      intendedRunningRef.current =
        mode === WORKOUT_MODE.RUNNING || mode === WORKOUT_MODE.RESUME;
      try {
        await sendControlWrite({ [CHAR_ID_WORKOUT_MODE]: mode });
        logBleEvent(`iFit ${label}: wrote WorkoutMode=${mode}`);
      } catch (err: any) {
        logBleEvent(
          `iFit ${label}: wrote WorkoutMode=${mode} — ${err?.message || "failed"}`,
        );
        switch (label) {
          case "start":
            setControlError(adminError(err, "Could not start the device."));
            break;
          case "resume":
            setControlError(adminError(err, "Could not resume the device."));
            break;
          case "pause":
            setControlError(adminError(err, "Could not pause the device."));
            break;
          case "reset":
            setControlError(adminError(err, "Could not reset the device."));
            break;
          default:
            setControlError(adminError(err));
        }
        throw err;
      } finally {
        setControlBusy(false);
      }
    },
    [sendControlWrite],
  );

  const startDevice = useCallback(
    () => setWorkoutMode(WORKOUT_MODE.RUNNING, "start"),
    [setWorkoutMode],
  );
  const resumeDevice = useCallback(
    () => setWorkoutMode(WORKOUT_MODE.RESUME, "resume"),
    [setWorkoutMode],
  );
  const pauseDevice = useCallback(
    () => setWorkoutMode(WORKOUT_MODE.PAUSE, "pause"),
    [setWorkoutMode],
  );

  // A second report of the same "stale countdown on first start" symptom
  // (this time on a rower) came in after the ENABLE-race fix above was
  // already shipped, which meant a second race — this file had no hardware
  // to reproduce it against, so it was reproduced and fixed against a
  // software mimic instead (ifitMimic.ts, driven from the /device-probe
  // screen's "start sequence" test). The mechanism: sendControlWrite's
  // Done status only proves the *write* was accepted (see its own comment),
  // never that the console's *physical* mode actually moved — a real
  // console's Mode transition lags its own protocol ack by some margin,
  // and only honours a Running write as a genuine Idle->Running edge if the
  // physical mode has already settled into Idle by the time Running
  // arrives. resetToIdle().then(startDevice()) fires both writes close
  // enough together that the second one routinely lands inside that lag —
  // ack'd, but silently discarded, so the console never leaves whatever
  // mode it was already in. The manual "stop, then start again" workaround
  // in the field reports only worked by accident: enough wall-clock time
  // passed between the two taps for the Idle transition to actually finish.
  //
  // The fix is to stop assuming the write landed and read the mode back
  // until it genuinely has, bounded so a device that never confirms (or
  // doesn't support the read) doesn't hang the start sequence forever —
  // exactly the same shape as sendControlWrite's own SecurityBlock retry,
  // just confirming the *physical* effect instead of the *protocol*
  // acceptance of a write.
  const MODE_CONFIRM_TIMEOUT_MS = 1500;
  const MODE_CONFIRM_POLL_MS = 120;
  const waitForConfirmedMode = useCallback(
    async (targetMode: number): Promise<boolean> => {
      const equipment = equipmentRef.current;
      if (equipment == null) return false;
      const deadline = Date.now() + MODE_CONFIRM_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await controlReadyRef.current;
        const result = await sendAndValidate(
          sendAndWait,
          buildControlRequest(equipment, {}, [CHAR_ID_WORKOUT_MODE]),
          COMMAND_WRITE_AND_READ,
          [CHAR_ID_WORKOUT_MODE],
        );
        if (result.frame) {
          const mode = decodeReadValues(result.frame, [
            CHAR_ID_WORKOUT_MODE,
          ]).Mode;
          if (mode === targetMode) return true;
        }
        await sleep(MODE_CONFIRM_POLL_MS);
      }
      return false;
    },
    [sendAndWait],
  );

  // Drives the console to Idle without touching target speed — unlike
  // emergencyStop, this is meant to run immediately *before* startDevice on
  // a fresh "Start Programme", not as a user-facing stop. A console left in
  // its own power-on default mode (observed: a ~5 minute warm-up countdown)
  // only honors WorkoutMode=Running as "skip the warm-up" when it arrives as
  // a genuine Idle->Running edge; writing Idle first forces that edge on
  // every start instead of only after a manual stop+start. Now waits for
  // that Idle to be confirmed (see waitForConfirmedMode above) before
  // resolving, so the startDevice() call chained onto this one lands after
  // the edge has genuinely happened rather than while it's still in flight.
  const resetToIdle = useCallback(async () => {
    await setWorkoutMode(WORKOUT_MODE.IDLE, "reset");
    const confirmed = await waitForConfirmedMode(WORKOUT_MODE.IDLE);
    if (!confirmed)
      throw new Error("Console did not confirm Idle; start cancelled.");
  }, [setWorkoutMode, waitForConfirmedMode]);

  // A real production probe report against an I_RW rower (2026-07-31) showed
  // a *third* variant of the same underlying symptom class: the console
  // entered its own WARM_UP countdown the instant it sensed rowing motion
  // while Idle — with no WorkoutMode write from the app anywhere in the log.
  // That's console-native (a motion sensor reacting on its own), not
  // anything the write-settle race above touches, so resetToIdle() being
  // called once at the start of a session can't prevent it: the countdown
  // can start well after that, mid-workout, the moment the device notices
  // real movement.
  //
  // The poll loop below (see its own comment) watches for exactly that: Mode
  // reading WARM_UP while the app believes it already asked for Running.
  // Recovery uses the identical confirmed Idle-then-Running sequence — this
  // protocol treats WARM_UP the same as any other non-Idle mode for edge
  // purposes, so forcing a genuine Idle->Running edge clears it the same way
  // it clears a stale mode found at connect. Reproduced and verified against
  // ifitMimic.ts's simulateMovementStart() before shipping here — see
  // ifitMimic.test.ts's "autonomous warm-up-on-movement" suite.
  const recoverFromStaleWarmup = useCallback(async () => {
    if (recoveringFromWarmupRef.current) return; // already mid-recovery from a previous tick
    recoveringFromWarmupRef.current = true;
    logBleEvent(
      "iFit: device shows an autonomous warm-up countdown while a workout was expected to be running — recovering (Idle, confirmed, then Running).",
    );
    try {
      await resetToIdle();
      await startDevice();
    } finally {
      recoveringFromWarmupRef.current = false;
    }
  }, [resetToIdle, startDevice]);
  recoverFromStaleWarmupRef.current = recoverFromStaleWarmup;

  // The "big red button" analogue. Belt and braces on purpose: the speed
  // target is zeroed *first* so a treadmill starts winding down even if the
  // mode write is the part this device ignores, and only then is the console
  // driven to Idle. FTMS gets a real Stop op code; this is the closest this
  // protocol offers.
  const emergencyStop = useCallback(async () => {
    setControlError("");
    setControlBusy(true);
    intendedRunningRef.current = false;
    try {
      // accRef carries the *effective* cardio type — the one attachDevice
      // settled on after its address probe, not the one the caller assumed.
      if (accRef.current?.cardioType === "Treadmill") {
        try {
          await sendControlWrite({ [CHAR_ID_KPH]: 0 });
          logBleEvent("iFit emergency stop: target speed set to 0.");
        } catch {
          /* the mode write below is the second line of defence */
        }
      }
      await sendControlWrite({ [CHAR_ID_WORKOUT_MODE]: WORKOUT_MODE.IDLE });
      logBleEvent("iFit emergency stop: wrote WorkoutMode=Idle");
    } catch (err: any) {
      logBleEvent(
        `iFit emergency stop failed: ${err?.message || "unknown error"}`,
      );
      setControlError(adminError(err, "Could not stop the device."));
      throw err;
    } finally {
      setControlBusy(false);
    }
  }, [sendControlWrite]);

  const disconnect = useCallback(() => {
    logBleEvent(
      `User-initiated disconnect from "${deviceRef.current?.name || "device"}" (iFit).`,
    );
    intentionalRef.current = true;
    reconnectTokenRef.current++;
    setReconnecting(false);
    setReconnectAttempt(0);
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
    cleanup();
    setMetrics(EMPTY_IFIT_METRICS);
  }, [cleanup]);

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
    connectWithDevice,
    disconnect,
    controllable,
    controllableFields,
    controlBusy,
    controlError,
    supportedRanges,
    setTargetSpeed,
    setTargetIncline,
    setTargetResistance,
    startDevice,
    resumeDevice,
    pauseDevice,
    resetToIdle,
    emergencyStop,
    deviceSerial,
    resistanceLevels,
  };
}
