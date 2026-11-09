// Golden fixtures — real bytes captured from real machines, paired with what
// the parsers decoded them to at the time.
//
// This is the regression net that stops "we fixed it for device A and broke
// device B". Every entry here is a frame some specific machine actually sent;
// deviceFixtures.test.ts re-runs the *current* parsers over each one and
// fails if the decode changed. A parser edit that alters how a real device's
// data reads therefore fails CI rather than shipping.
//
// The history that motivates this: the FTMS speed write scale, the iFit
// CurrentDistance unit, and the rower's pace-derived speed were each changed
// on the strength of one device's evidence, and at least twice that broke a
// different device. A fixture per device makes the second device's evidence
// permanent instead of a memory.
//
// **To add one**: run the probe (`/device-probe`), tap "Copy test fixtures",
// paste below. Do not hand-write these — the whole point is that the bytes
// and the expected decode both come from a real capture, not from what
// someone believed the parser should do.
import type { GoldenFixture } from "./deviceProbe";

export const DEVICE_FIXTURES: GoldenFixture[] = [
  {
    device: "ADIDAS 1819",
    protocol: "FTMS",
    charUuid: 0x2acd,
    flags: 0x058c,
    rawHex: "8c 05 64 00 2c 1a 00 00 00 ff 7f 00 00 00 00 00 00 07 00",
    note: "Treadmill, flags:1420 — the device whose Total Distance sits frozen at 6700m. Ramp angle is the 0x7fff not-available sentinel.",
    expected: {
      speedKmh: 1,
      cadenceRpm: null,
      powerW: null,
      distanceM: 6700,
      inclinePct: 0,
      elapsedTimeSec: 7,
      heartRateBpm: 0,
      caloriesKcal: 0,
      strokeCount: null,
      running: null,
      targetSpeedKmh: null,
      targetInclinePct: null,
      resistanceLevel: null,
    },
  },
  {
    device: "I_RW",
    protocol: "iFit",
    readIds: [2, 3, 4, 10, 12, 20, 21, 83, 109, 110, 111],
    rawHex:
      "01 04 02 21 14 21 02 02 00 00 05 00 03 00 00 00 00 00 00 00 02 0c 00 00 00 23 57 00 00 3d 00 01 00 17 98 01 b7",
    note: "Rower, mid-stroke. No speed field in this protocol — speedKmh is derived from FiveHundredSplit (408 s/500m). Mode=2 (Running).",
    expected: {
      speedKmh: 4.411764705882353,
      cadenceRpm: 23,
      powerW: 5,
      distanceM: 3,
      inclinePct: null,
      elapsedTimeSec: 12,
      heartRateBpm: null,
      caloriesKcal: 0.22842368,
      strokeCount: 1,
      running: true,
      targetSpeedKmh: null,
      targetInclinePct: null,
      resistanceLevel: 0,
    },
  },
  {
    device: "I_RW",
    protocol: "iFit",
    readIds: [2, 3, 4, 10, 12, 20, 21, 83, 109, 110, 111],
    rawHex:
      "01 04 02 21 14 21 02 02 00 00 00 00 00 00 00 00 00 00 00 00 03 00 00 00 00 00 00 00 00 00 00 01 00 00 00 00 3d",
    note: "Rower, idle-blanked. Mode=3 (Pause) and every counter reads exactly 0 — this is the frame shape that must NOT be read as an odometer reset (see deviceRegistry blanksValuesWhenIdle).",
    expected: {
      speedKmh: null,
      cadenceRpm: 0,
      powerW: 0,
      distanceM: 0,
      inclinePct: null,
      elapsedTimeSec: 0,
      heartRateBpm: null,
      caloriesKcal: 0,
      strokeCount: 1,
      running: false,
      targetSpeedKmh: null,
      targetInclinePct: null,
      resistanceLevel: 0,
    },
  },
];
