// Device conformance check engine — the analysis half of the active debugger
// (see screens/DeviceProbe.tsx for the guided UI that drives a real
// connection through it, and docs/SMART_DEVICES_PROBE.md for the rationale).
//
// Every check below encodes one *specific bug this app has actually hit* on
// real hardware. That's the whole design premise: each of those bugs cost
// several round-trips of "send us a connection report" → read 2000 lines of
// prose log → spot the anomaly → guess → ask for another report. The evidence
// needed to spot each one was almost always already in the very first report;
// it was just buried. So rather than shipping a bigger log, this turns each
// past diagnosis into an assertion that runs automatically and reports a
// verdict.
//
// Deliberately protocol-agnostic and free of any I/O: callers feed it
// observations (see ProbeObservation) and it produces findings. That keeps
// every check unit-testable against synthetic observation streams with no
// GATT involved (see deviceProbe.test.ts) — which matters, because the whole
// point is that these run against devices nobody on this project owns.
//
import { getActiveLocale } from "./i18n";

// The same engine is intended to run in two modes:
//   - Active: the guided wizard walks a user through a scripted ~90s session
//     (screens/DeviceProbe.tsx). Produces a full report + a device profile.
//   - Passive (not wired up yet): the same recorder fed from a normal workout
//     connection, so "Report a connection issue" can ship conclusions rather
//     than raw logs.
import type { CardioType } from "./types";
import {
  DEFAULT_SPEED_WRITE_SCALE,
  DEFAULT_INCLINE_WRITE_SCALE,
  type FtmsMetrics,
} from "./ble";
import type { IfitMetrics } from "./ifit";
import {
  formatRegistryEntrySource,
  matchDevice,
  type DeviceQuirks,
  type DeviceIdentity,
  type DeviceRegistryEntry,
} from "./deviceRegistry";

export type ProbeProtocol = "FTMS" | "iFit";

// Bumped whenever the ProbeObservation shape changes in a way that would
// make an older recording decode differently. Replay refuses anything newer
// than it understands, and warns about older ones rather than silently
// re-interpreting them.
//
// Version history:
//   1 — original prose-only reports (observations were never serialized;
//       these cannot be replayed at all)
//   2 — observations serialized as JSON alongside the prose
export const PROBE_REPORT_VERSION = 2;

// --- Observations: the raw material the checks run over -------------------
// A deliberately flat, serializable union — the whole observation stream goes
// into the final report verbatim as evidence, so a human can still re-derive
// any finding by hand (and so a future check can be run retroactively against
// an old report, which is exactly what "we should have caught this earlier"
// looks like in practice).

export interface ProbeObservationBase {
  at: number;
}

export type ProbeObservation =
  // A parsed Data-characteristic notification (FTMS) or poll response (iFit).
  // `flags` is FTMS-only (the raw leading uint16); `rawHex` is the full frame.
  | (ProbeObservationBase & {
      kind: "metrics";
      rawHex: string;
      flags: number | null;
      metrics: ProbeMetrics;
    })
  // FTMS Machine Status (0x2ADA) indication.
  | (ProbeObservationBase & {
      kind: "machineStatus";
      rawHex: string;
      opCode: number;
      decoded: Record<string, unknown> | null;
      isFirstSinceConnect: boolean;
    })
  // A Control Point command this probe sent and the device's response.
  | (ProbeObservationBase & {
      kind: "control";
      label: string;
      opCode: number;
      requestHex: string;
      resultCode: number | null; // null = no response before timeout
      resultMessage: string | null;
      // Set for target commands, so the write-scale check can compare what
      // was asked for against what the device actually did.
      requestedValue?: number;
      // Only 'kmh' and 'pct' carry a scale ambiguity worth measuring (the
      // spec's x100/x10 vs this app's x10/x1). Target Power is plain watts
      // and Target Resistance is a level, so for those the meaningful
      // question is acceptance, not scale — see checkWriteScale and
      // checkControlAccepted.
      requestedUnit?: "kmh" | "pct" | "w" | "level";
    })
  // A one-shot characteristic read (feature bitmaps, supported ranges, ...).
  | (ProbeObservationBase & {
      kind: "read";
      what: string;
      rawHex: string | null;
      decoded: Record<string, unknown> | null;
      error: string | null;
    })
  // GATT/service/characteristic discovery result.
  | (ProbeObservationBase & {
      kind: "discovery";
      serviceUuids: string[];
      dataCharacteristicUuid: string | null;
      dataCharacteristicProperties: string[];
      detectedCardioType: CardioType | null;
      requestedCardioType: CardioType;
      hasControlPoint: boolean;
      hasMachineStatus: boolean;
    })
  // iFit-specific: a raw response frame, for checksum/command-match checks.
  | (ProbeObservationBase & {
      kind: "ifitFrame";
      requestCommand: number;
      responseHex: string | null;
      responseCommand: number | null;
      checksumValid: boolean | null;
      expectedPayloadBytes: number;
      actualPayloadBytes: number | null;
      // CmdStatus (response byte 3) — Done(2) means the device actually
      // processed this request; anything else (most importantly
      // SecurityBlock(8)) means it didn't, even though a well-formed,
      // checksum-valid frame came back. Previously never read at all.
      responseStatus: number | null;
    })
  // Free-form milestone, mirrored into the report's timeline for context.
  | (ProbeObservationBase & { kind: "note"; message: string })
  // The user answering a wizard prompt ("is the belt moving now?", "what does
  // the console show?") — ground truth no amount of byte-watching can supply.
  | (ProbeObservationBase & {
      kind: "userAnswer";
      question: string;
      answer: string;
      // Numeric ground truth where the question asked for one, e.g. the speed
      // actually displayed on the console.
      value?: number;
      // What the app was showing for the same quantity at that moment, so the
      // two can be compared. Byte-level correctness does not prove *unit*
      // correctness — several past bugs decoded cleanly but in the wrong unit
      // and only a human reading the console caught them.
      appValue?: number;
    });

// The subset of metrics both protocols share, so checks don't need to branch.
// Deliberately a fresh shape rather than reusing FtmsMetrics/IfitMetrics —
// those two disagree on field names for the same physical quantity (speedKmh
// vs speedKmh but distanceM vs totalDistanceM, cadenceRpm vs strokeRatePerMin)
// and normalizing once here beats every check handling both.
export interface ProbeMetrics {
  speedKmh: number | null;
  cadenceRpm: number | null;
  powerW: number | null;
  distanceM: number | null;
  inclinePct: number | null;
  elapsedTimeSec: number | null;
  heartRateBpm: number | null;
  caloriesKcal: number | null;
  // Rowers report no speed field at all (both protocols), and a real one was
  // also seen resetting its distance counter to zero mid-session — leaving
  // stroke count as the only monotonic evidence the session happened. Without
  // it the report for that device listed almost nothing.
  strokeCount: number | null;
  // The device's own authoritative running/paused state where it exposes one
  // (FTMS Machine Status, iFit WorkoutMode). Strictly better than inferring
  // movement from metrics — the same rower sat in Pause reporting all-zero
  // frames while the probe's own heuristic still counted an earlier sample as
  // "moving".
  running: boolean | null;
  // What the machine says its *targets* are currently set to, as distinct
  // from the live readings above. iFit reads these back from the same
  // characteristic ids its control path writes (Kph 0 / Incline 1 /
  // Resistance 2), which makes them the only real confirmation that a write
  // landed — this protocol has no per-command acknowledgement, so "a response
  // frame came back" says nothing about whether the value was accepted.
  targetSpeedKmh: number | null;
  targetInclinePct: number | null;
  resistanceLevel: number | null;
}

export const EMPTY_PROBE_METRICS: ProbeMetrics = {
  speedKmh: null,
  cadenceRpm: null,
  powerW: null,
  distanceM: null,
  inclinePct: null,
  elapsedTimeSec: null,
  heartRateBpm: null,
  caloriesKcal: null,
  strokeCount: null,
  running: null,
  targetSpeedKmh: null,
  targetInclinePct: null,
  resistanceLevel: null,
};

export function probeMetricsFromFtms(
  m: FtmsMetrics,
  running: boolean | null = null,
): ProbeMetrics {
  return {
    speedKmh: m.speedKmh,
    cadenceRpm: m.cadenceRpm,
    powerW: m.powerW,
    distanceM: m.totalDistanceM,
    inclinePct: m.inclinePct,
    elapsedTimeSec: m.elapsedTimeSec,
    heartRateBpm: m.heartRateBpm,
    caloriesKcal: m.caloriesKcal,
    strokeCount: m.strokeCount,
    running,
    // FTMS reports console-side targets through Machine Status, not the data
    // characteristic — those arrive as their own observations instead.
    targetSpeedKmh: null,
    targetInclinePct: null,
    resistanceLevel: null,
  };
}

export function probeMetricsFromIfit(m: IfitMetrics): ProbeMetrics {
  return {
    speedKmh: m.speedKmh,
    // This protocol reports stroke rate separately from Rpm; either is the
    // "cadence" a check cares about, whichever the device actually populated.
    cadenceRpm: m.cadenceRpm ?? m.strokeRatePerMin,
    powerW: m.powerW,
    distanceM: m.distanceM,
    inclinePct: m.inclinePct,
    elapsedTimeSec: m.elapsedSec,
    heartRateBpm: m.pulseBpm,
    caloriesKcal: m.caloriesKcal,
    strokeCount: m.totalStrokes,
    running: m.running,
    targetSpeedKmh: m.targetSpeedKmh,
    targetInclinePct: m.targetInclinePct,
    resistanceLevel: m.resistanceLevel,
  };
}

// --- Findings -------------------------------------------------------------

export type ProbeStatus = "pass" | "warn" | "fail" | "skip";

export interface ProbeFinding {
  id: string;
  title: string;
  status: ProbeStatus;
  // What the check concluded, in plain language — this is the line a human
  // reads first, so it states the observed fact, not the rule that was applied.
  detail: string;
  // The specific past bug this check exists because of. Shown in the report
  // so a reader understands why an odd-looking check matters, and so the
  // institutional memory lives next to the assertion rather than only in a
  // code comment nobody reads at triage time.
  because?: string;
  // Machine-readable extras folded into the device profile (see
  // buildDeviceProfile) — e.g. the observed write scale, the flag masks seen.
  data?: Record<string, unknown>;
}

export interface ProbeReport {
  protocol: ProbeProtocol;
  deviceName: string;
  requestedCardioType: CardioType;
  detectedCardioType: CardioType | null;
  startedAt: number;
  endedAt: number;
  findings: ProbeFinding[];
  observations: ProbeObservation[];
  profile: DeviceProfile;
  summary: { pass: number; warn: number; fail: number; skip: number };
}

// The machine-readable half of the output — shaped to drop straight into a
// per-device quirks registry, which is the whole point of running this on a
// device nobody here owns. A human pastes this into a support ticket; the
// values that differ from the defaults are exactly the quirks worth encoding.
export interface DeviceProfile {
  protocol: ProbeProtocol;
  deviceName: string;
  detectedCardioType: CardioType | null;
  fieldsReported: string[];
  flagMasksSeen: string[];
  distanceTrustworthy: boolean | null;
  observedSpeedWriteScale: number | null;
  observedInclineWriteScale: number | null;
  controlSupported: boolean | null;
  machineStatusSupported: boolean | null;
  notes: string[];
}

// --- Small helpers used by several checks --------------------------------

function obsOf<K extends ProbeObservation["kind"]>(
  observations: ProbeObservation[],
  kind: K,
): Extract<ProbeObservation, { kind: K }>[] {
  return observations.filter(
    (o): o is Extract<ProbeObservation, { kind: K }> => o.kind === kind,
  );
}

function span(observations: ProbeObservation[]): number {
  if (observations.length < 2) return 0;
  return observations[observations.length - 1].at - observations[0].at;
}

// "The device was genuinely moving" — used as the precondition for several
// checks that are only meaningful during real movement, so a probe run where
// the user never actually started the machine reports `skip` (honestly "we
// couldn't tell") rather than a misleading pass or fail.
function movingSamples(
  samples: Extract<ProbeObservation, { kind: "metrics" }>[],
) {
  return samples.filter((s) => {
    // The device's own running/paused state wins outright where it exposes
    // one. A real rower sat in Pause emitting all-zero frames while an
    // earlier, pre-movement sample still satisfied the metric heuristic
    // below, which was enough to make several checks believe they had seen
    // sustained movement.
    if (s.metrics.running === false) return false;
    return (
      (s.metrics.speedKmh ?? 0) > 0.5 ||
      (s.metrics.cadenceRpm ?? 0) > 5 ||
      (s.metrics.powerW ?? 0) > 10
    );
  });
}

// --- The checks -----------------------------------------------------------
// Each is a pure function over the observation stream. Order here is the
// order they appear in the report.

type Check = (
  o: ProbeObservation[],
  ctx: { protocol: ProbeProtocol },
) => ProbeFinding | null;

const checkNotificationsArrive: Check = (o) => {
  const samples = obsOf(o, "metrics");
  const seconds = span(samples) / 1000;
  if (samples.length === 0) {
    return {
      id: "notifications-arrive",
      title: "Device sends live data",
      status: "fail",
      detail: "No data notifications were received at all during the probe.",
      because:
        "A device that connects but never notifies looks identical to a working one in the UI — metrics simply stay blank forever with no error.",
    };
  }
  const rate = seconds > 0 ? samples.length / seconds : 0;
  return {
    id: "notifications-arrive",
    title: "Device sends live data",
    status: "pass",
    detail: `${samples.length} notifications over ${seconds.toFixed(0)}s (~${rate.toFixed(1)}/s).`,
    data: {
      notificationCount: samples.length,
      ratePerSec: Number(rate.toFixed(2)),
    },
  };
};

// A drop partway through invalidates every duration- and rate-based
// conclusion after it, so it needs to be stated outright rather than left for
// a reader to infer from a timeline that just stops.
const checkStayedConnected: Check = (o) => {
  const dropped = obsOf(o, "note").find((n) =>
    n.message.startsWith("DEVICE DISCONNECTED"),
  );
  if (!dropped) return null;
  const samples = obsOf(o, "metrics");
  const lastSample = samples.length ? samples[samples.length - 1].at : null;
  const first = o.length ? o[0].at : dropped.at;
  return {
    id: "stayed-connected",
    title: "Connection held for the whole probe",
    status: "fail",
    detail: `The device disconnected ${((dropped.at - first) / 1000).toFixed(0)}s in and the probe ended there${lastSample ? ` (last data ${((dropped.at - lastSample) / 1000).toFixed(0)}s before the drop)` : ""}. Every other finding covers only the time before the drop.`,
    because:
      "A mid-probe drop used to go unnoticed: the stage timers kept running against a dead connection, so the report concluded a healthy notification rate for a device that had been gone for most of the run.",
    data: { disconnectedMidProbe: true },
  };
};

// The baseline stage exists to catch a device that reports motion while
// demonstrably stationary — the same class of fault as the treadmill that
// emitted a spurious 1.0 km/h. Without this check the stage's data was
// collected and then never looked at.
const checkBaselineQuiet: Check = (o) => {
  const start = obsOf(o, "note").find((n) =>
    n.message.startsWith("Baseline stage"),
  );
  const end = obsOf(o, "note").find((n) =>
    n.message.startsWith("Movement stage"),
  );
  if (!start || !end) return null;
  const during = obsOf(o, "metrics").filter(
    (s) => s.at >= start.at && s.at < end.at,
  );
  if (during.length < 3) {
    return {
      id: "baseline-quiet",
      title: "Device reads as stopped when it is stopped",
      status: "skip",
      detail: "Too few samples during the stationary stage to judge.",
    };
  }
  const active = during.filter(
    (s) =>
      (s.metrics.speedKmh ?? 0) > 0.5 ||
      (s.metrics.powerW ?? 0) > 10 ||
      (s.metrics.cadenceRpm ?? 0) > 5,
  );
  if (active.length === 0) {
    return {
      id: "baseline-quiet",
      title: "Device reads as stopped when it is stopped",
      status: "pass",
      detail: `All ${during.length} samples during the stationary stage read as idle.`,
    };
  }
  const peak = Math.max(...active.map((s) => s.metrics.speedKmh ?? 0));
  return {
    id: "baseline-quiet",
    title: "Device reads as stopped when it is stopped",
    status: "warn",
    detail: `${active.length} of ${during.length} samples reported activity while the machine was meant to be stationary${peak > 0 ? ` (speed up to ${peak} km/h)` : ""}. Either it was not actually still, or this device reports a phantom idle reading.`,
    because:
      "A real treadmill emitted a spurious 1.0 km/h with no physical cause, which was enough to start the workout clock on its own.",
    data: { baselineNoise: active.length },
  };
};

// Cumulative counters — the fields that can only ever go up during a real
// session, and whose dropping to exactly 0 is therefore always an artifact
// rather than a reading.
const CUMULATIVE_FIELDS: (keyof ProbeMetrics)[] = [
  "distanceM",
  "elapsedTimeSec",
  "caloriesKcal",
  "strokeCount",
];

// Detects the idle-blanking pattern: two or more cumulative counters
// simultaneously dropping from a real value to exactly 0, and (usually)
// coming back afterwards. Returns the runs so the checks below can talk about
// them concretely.
function blankingRuns(
  samples: Extract<ProbeObservation, { kind: "metrics" }>[],
) {
  const runs: {
    from: number;
    to: number;
    fields: string[];
    restored: boolean;
  }[] = [];
  const lastNonZero: Partial<Record<string, number>> = {};
  let current: { from: number; to: number; fields: Set<string> } | null = null;

  for (const s of samples) {
    const blankedNow = CUMULATIVE_FIELDS.filter((f) => {
      const v = s.metrics[f];
      return v === 0 && (lastNonZero[f] ?? 0) > 0;
    });
    if (blankedNow.length >= 2) {
      if (current) {
        current.to = s.at;
        blankedNow.forEach((f) => current!.fields.add(f as string));
      } else
        current = {
          from: s.at,
          to: s.at,
          fields: new Set(blankedNow as string[]),
        };
    } else {
      if (current) {
        runs.push({
          from: current.from,
          to: current.to,
          fields: [...current.fields],
          restored: true,
        });
        current = null;
      }
      for (const f of CUMULATIVE_FIELDS) {
        const v = s.metrics[f];
        if (typeof v === "number" && v > 0) lastNonZero[f] = v;
      }
    }
  }
  if (current)
    runs.push({
      from: current.from,
      to: current.to,
      fields: [...current.fields],
      restored: false,
    });
  return runs;
}

// Some machines blank most live values to exactly 0 after a few seconds of
// inactivity, then restore them when the user resumes — the counters were
// never lost, they just stop being reported. Confirmed on the NordicTrack
// RW300 (iFit rower family).
//
// This is worth its own finding because a blanked 0 is indistinguishable from
// a real reading at the byte level, and believing it corrupts session totals:
// both accumulators treat a cumulative field falling below its baseline as a
// genuine device-side reset, which either re-baselines the session to zero or
// banks the distance so far and then counts it again when the real value
// returns. Both paths now ignore these zeros; this check makes the behaviour
// visible in the report so an odd-looking timeline has an explanation.
const checkIdleBlanking: Check = (o) => {
  const samples = obsOf(o, "metrics");
  if (samples.length < 10) return null;
  const runs = blankingRuns(samples);
  if (runs.length === 0) return null;
  const longest = runs.reduce((a, b) =>
    b.to - b.from > a.to - a.from ? b : a,
  );
  const restored = runs.filter((r) => r.restored).length;
  return {
    id: "idle-blanking",
    title: "Values blank out while the machine idles",
    status: "warn",
    detail:
      `This device blanked ${longest.fields.join(", ")} to exactly 0 on ${runs.length} occasion(s) ` +
      `(longest ${((longest.to - longest.from) / 1000 || 1).toFixed(0)}s)${restored ? `, restoring the real values afterwards ${restored} time(s)` : ""}. ` +
      "The app now ignores these zeros rather than treating them as counter resets, so session totals survive a pause.",
    because:
      "A blanked zero is byte-identical to a real reading. Trusting it makes the iFit accumulator re-baseline the session to zero, and makes the FTMS accumulator bank the distance so far and then count the same metres again when the value returns — roughly doubling the session total across every pause.",
    data: { blanksValuesWhenIdle: true, blankingRuns: runs.length },
  };
};

// Bug: a device whose Total Distance field never updated over BLE at all —
// pinned at the same raw value for a 90-second session with the belt
// genuinely moving the whole time. ble.ts now runs a speed-integrated
// estimate in parallel and only trusts the raw field once it proves itself;
// this check is that same "did it prove itself" question, reported explicitly.
const checkDistanceAdvances: Check = (o) => {
  const samples = obsOf(o, "metrics");
  const withDistance = samples.filter((s) => s.metrics.distanceM != null);
  const moving = movingSamples(samples);
  const movingSeconds = span(moving) / 1000;
  if (withDistance.length === 0) {
    return {
      id: "distance-advances",
      title: "Total Distance advances while moving",
      status: "skip",
      detail:
        "This device never reported a distance field, so there is nothing to verify. The app will integrate distance from speed instead.",
      because:
        "Distance is optional in FTMS; a device that omits it entirely is normal and handled.",
      data: { distanceReported: false },
    };
  }
  if (moving.length < 3 || movingSeconds < 20) {
    return {
      id: "distance-advances",
      title: "Total Distance advances while moving",
      status: "skip",
      detail: `Not enough sustained movement to judge (only ${movingSeconds.toFixed(0)}s). Re-run and keep the machine moving for at least 30 seconds.`,
    };
  }
  const first = withDistance[0].metrics.distanceM!;
  const last = withDistance[withDistance.length - 1].metrics.distanceM!;
  const peak = Math.max(...withDistance.map((s) => s.metrics.distanceM!));
  if (last === first) {
    return {
      id: "distance-advances",
      title: "Total Distance advances while moving",
      status: "fail",
      detail: `Distance stayed frozen at ${first}m across ${movingSeconds.toFixed(0)}s of real movement. The app will fall back to a speed-integrated estimate for this device.`,
      because:
        "A real device was found whose Total Distance never updates over BLE despite the belt moving — it read the same raw value for an entire 90-second session.",
      data: { distanceTrustworthy: false, firstM: first, lastM: last },
    };
  }
  // A *decrease* is not an advance. This previously fell through to the pass
  // branch on the strength of `last !== first` alone, so a real rower that
  // went 3m → 0m (its console reset to idle mid-probe) was reported as
  // "Distance advanced 3m → 0m" and written into the profile as
  // distanceTrustworthy: true.
  if (last < first) {
    // Distinguish a genuine odometer reset from idle-blanking, which looks
    // identical if you only compare the first and last sample. Blanking is
    // by far the more common explanation, and calling it a reset licences the
    // banking behaviour that double-counts distance across every pause — this
    // check made exactly that misdiagnosis on a real rower.
    if (blankingRuns(withDistance).length > 0) {
      return {
        id: "distance-advances",
        title: "Total Distance advances while moving",
        status: "pass",
        detail: `Distance reached ${peak}m and only read lower at the end because this device blanks its counters while idle (see the blanking finding). The counter itself was never reset.`,
        data: {
          distanceTrustworthy: true,
          firstM: first,
          lastM: last,
          peakM: peak,
        },
      };
    }
    return {
      id: "distance-advances",
      title: "Total Distance advances while moving",
      status: "warn",
      detail: `Distance went backwards (${first}m → ${last}m, peaking at ${peak}m) with no accompanying blanking of the other counters, so this looks like a genuine device-side odometer reset.`,
      because:
        "A device odometer restarting mid-session used to silently erase every metre already logged, because a lower reading was always treated as a stale first sample to recalibrate against.",
      data: {
        distanceTrustworthy: false,
        firstM: first,
        lastM: last,
        peakM: peak,
        distanceResetMidSession: true,
      },
    };
  }
  return {
    id: "distance-advances",
    title: "Total Distance advances while moving",
    status: "pass",
    detail: `Distance advanced ${first}m → ${last}m over ${movingSeconds.toFixed(0)}s of movement.`,
    data: { distanceTrustworthy: true, firstM: first, lastM: last },
  };
};

// Bug: a device reporting distance in units other than the documented metres
// — one report showed 500m reading back as 5km, a later one showed the exact
// opposite (900m as 90m). Comparing the device's own delta against a
// speed-integrated estimate over the same window catches a scale error
// without needing the user to read their console.
const checkDistanceScale: Check = (o) => {
  const samples = obsOf(o, "metrics");
  const withBoth = samples.filter(
    (s) => s.metrics.distanceM != null && s.metrics.speedKmh != null,
  );
  if (withBoth.length < 5) {
    return {
      id: "distance-scale",
      title: "Distance units look like metres",
      status: "skip",
      detail:
        "Not enough samples with both speed and distance to cross-check the unit.",
    };
  }
  let estimateM = 0;
  for (let i = 1; i < withBoth.length; i++) {
    const dtHours = (withBoth[i].at - withBoth[i - 1].at) / 3_600_000;
    estimateM += (withBoth[i].metrics.speedKmh ?? 0) * dtHours * 1000;
  }
  const reportedDelta =
    withBoth[withBoth.length - 1].metrics.distanceM! -
    withBoth[0].metrics.distanceM!;
  // These two used to share one message ("Not enough real movement"), which
  // was actively misleading on a treadmill that moved for 78 seconds while
  // its distance field sat frozen — the reason was the frozen field, already
  // reported by checkDistanceAdvances, not a lack of movement.
  if (estimateM < 20) {
    return {
      id: "distance-scale",
      title: "Distance units look like metres",
      status: "skip",
      detail: "Not enough real movement to cross-check the distance unit.",
    };
  }
  if (reportedDelta <= 0) {
    return {
      id: "distance-scale",
      title: "Distance units look like metres",
      status: "skip",
      detail:
        "The device's distance field did not advance during the probe, so its unit cannot be cross-checked (see the Total Distance finding above).",
    };
  }
  const ratio = reportedDelta / estimateM;
  if (ratio > 5) {
    return {
      id: "distance-scale",
      title: "Distance units look like metres",
      status: "fail",
      detail: `Device reported ${reportedDelta.toFixed(0)} units where speed implies ~${estimateM.toFixed(0)}m (${ratio.toFixed(1)}x high) — this device is probably not reporting plain metres.`,
      because:
        "Two real devices disagreed on this unit: one read 500m back as 5km, another read 900m back as 90m. It is a per-device quirk, not a global constant.",
      data: { distanceScaleRatio: Number(ratio.toFixed(2)) },
    };
  }
  if (ratio < 0.2) {
    return {
      id: "distance-scale",
      title: "Distance units look like metres",
      status: "fail",
      detail: `Device reported ${reportedDelta.toFixed(0)} units where speed implies ~${estimateM.toFixed(0)}m (${(1 / ratio).toFixed(1)}x low) — this device is probably not reporting plain metres.`,
      because:
        "Two real devices disagreed on this unit: one read 500m back as 5km, another read 900m back as 90m. It is a per-device quirk, not a global constant.",
      data: { distanceScaleRatio: Number(ratio.toFixed(2)) },
    };
  }
  return {
    id: "distance-scale",
    title: "Distance units look like metres",
    status: "pass",
    detail: `Device distance and speed-integrated distance agree within ${Math.abs(1 - ratio) * 100 < 1 ? "1" : (Math.abs(1 - ratio) * 100).toFixed(0)}%.`,
    data: { distanceScaleRatio: Number(ratio.toFixed(2)) },
  };
};

// Bug: speed readings that jump discontinuously to a spurious nonzero value
// (0.6 → 0.1 → exactly 1.00 km/h) with no physical cause, while the device's
// own elapsed-time counter stayed frozen — proving the device itself did not
// consider itself moving even as its speed field said otherwise.
const checkSpeedVsElapsedTime: Check = (o) => {
  const all = obsOf(o, "metrics");
  const samples = all.filter(
    (s) => s.metrics.elapsedTimeSec != null && s.metrics.speedKmh != null,
  );
  if (samples.length < 10) {
    // Naming the field that's actually missing, rather than one message
    // covering both — a rower that reports elapsed time but no speed was
    // previously told "does not report an elapsed-time field", which is the
    // opposite of what was happening.
    const hasClock = all.some((s) => s.metrics.elapsedTimeSec != null);
    const hasSpeed = all.some((s) => s.metrics.speedKmh != null);
    const missing =
      !hasClock && !hasSpeed
        ? "neither a speed nor an elapsed-time field"
        : !hasSpeed
          ? "no speed field"
          : !hasClock
            ? "no elapsed-time field"
            : "too few samples carrying both fields";
    return {
      id: "speed-vs-elapsed",
      title: "Speed agrees with the device clock",
      status: "skip",
      detail: `This device reports ${missing}, so the two cannot be cross-checked.`,
    };
  }
  let contradictions = 0;
  for (let i = 1; i < samples.length; i++) {
    const gapMs = samples[i].at - samples[i - 1].at;
    const clockFrozen =
      samples[i].metrics.elapsedTimeSec ===
      samples[i - 1].metrics.elapsedTimeSec;
    // Only meaningful across a gap longer than the field's own 1s resolution
    // — comparing consecutive sub-second ticks reads as falsely frozen during
    // completely normal continuous movement.
    if (gapMs > 2500 && clockFrozen && (samples[i].metrics.speedKmh ?? 0) > 0.5)
      contradictions++;
  }
  if (contradictions > 0) {
    return {
      id: "speed-vs-elapsed",
      title: "Speed agrees with the device clock",
      status: "warn",
      detail: `${contradictions} sample(s) reported a nonzero speed while the device's own elapsed-time counter was frozen — this device's speed field is not trustworthy on its own.`,
      because:
        "A real treadmill reported speed 0.6, then 0.1, then a spurious 1.0 km/h while its elapsed-time counter sat at exactly 7 the whole time — the device did not consider itself moving. The app now prefers this counter over instantaneous speed for start/stop detection.",
      data: { speedClockContradictions: contradictions },
    };
  }
  return {
    id: "speed-vs-elapsed",
    title: "Speed agrees with the device clock",
    status: "pass",
    detail:
      "Speed and the device's own elapsed-time counter stayed consistent.",
  };
};

// Bug: devices that vary which optional fields they send between consecutive
// notifications (to stay under the ATT MTU). ble.ts now merges metrics rather
// than replacing them, but knowing a device does this is worth recording —
// it changes which parser paths matter for that device.
const checkFlagStability: Check = (o, ctx) => {
  if (ctx.protocol !== "FTMS") return null;
  const masks = new Set<number>();
  for (const s of obsOf(o, "metrics")) if (s.flags != null) masks.add(s.flags);
  if (masks.size === 0) return null;
  const list = [...masks].map((m) => `0x${m.toString(16)}`);
  if (masks.size === 1) {
    return {
      id: "flag-stability",
      title: "Field set is stable between notifications",
      status: "pass",
      detail: `Every notification used the same flags mask (${list[0]}).`,
      data: { flagMasks: list },
    };
  }
  return {
    id: "flag-stability",
    title: "Field set is stable between notifications",
    status: "warn",
    detail: `This device alternates between ${masks.size} different field sets (${list.join(", ")}). Individual metrics will appear and disappear between notifications.`,
    because:
      'FTMS does not require a device to send the same fields every time; some split them across packets. Replacing metrics wholesale made fields flicker to null on alternate ticks, which read as "stopped" to the auto-start/stop detection.',
    data: { flagMasks: list },
  };
};

// Bug: the first Machine Status indication after subscribing is commonly a
// cached snapshot, not a live event — one real device pushed "Stopped" ~1s
// after connecting while its Data characteristic simultaneously reported real
// nonzero speed, which killed the exercise clock 4 seconds into a workout.
const checkMachineStatusFirstEvent: Check = (o, ctx) => {
  if (ctx.protocol !== "FTMS") return null;
  const events = obsOf(o, "machineStatus");
  if (events.length === 0) {
    return {
      id: "machine-status-first-event",
      title: "First Machine Status event is not a stale snapshot",
      status: "skip",
      detail:
        "This device does not expose Machine Status (it is optional), so console-side changes are inferred from metrics instead.",
      data: { machineStatusSupported: false },
    };
  }
  const first = events.find((e) => e.isFirstSinceConnect);
  if (!first) return null;
  const samples = obsOf(o, "metrics");
  // Was the device demonstrably moving within a couple of seconds either side
  // of that first "stopped" claim?
  const nearby = samples.filter((s) => Math.abs(s.at - first.at) < 3000);
  const movingNearby = movingSamples(nearby).length > 0;
  const claimedStopped =
    first.decoded && (first.decoded as any).running === false;
  if (claimedStopped && movingNearby) {
    return {
      id: "machine-status-first-event",
      title: "First Machine Status event is not a stale snapshot",
      status: "warn",
      detail:
        "The first Machine Status event claimed the machine was stopped while its own data showed real movement — a stale cached value, not a live event. The app already ignores the first event for this reason.",
      because:
        'On a real device this exact false "Stopped" reached the auto-detect logic and stopped the exercise clock 4 seconds into a workout that was still running.',
      data: { machineStatusSupported: true, firstEventStale: true },
    };
  }
  return {
    id: "machine-status-first-event",
    title: "First Machine Status event is not a stale snapshot",
    status: "pass",
    detail:
      "Machine Status is supported and its first event did not contradict the live data.",
    data: { machineStatusSupported: true, firstEventStale: false },
  };
};

// Bug: every real target-change event was immediately followed by a second
// event reading exactly 0, with nothing in between that could account for a
// genuine change back to a full stop — a device-side artifact of the write.
const checkTargetEchoZeroArtifact: Check = (o, ctx) => {
  if (ctx.protocol !== "FTMS") return null;
  const events = obsOf(o, "machineStatus").filter(
    (e) => !e.isFirstSinceConnect && e.decoded,
  );
  let pairs = 0;
  for (let i = 1; i < events.length; i++) {
    const prev = events[i - 1].decoded as any;
    const cur = events[i].decoded as any;
    for (const key of [
      "targetSpeedKmh",
      "targetInclinePct",
      "targetResistanceLevel",
      "targetPowerW",
    ]) {
      if (
        prev?.[key] != null &&
        prev[key] !== 0 &&
        cur?.[key] === 0 &&
        events[i].at - events[i - 1].at < 3000
      )
        pairs++;
    }
  }
  if (pairs === 0) return null;
  return {
    id: "target-echo-zero",
    title: "Target echo has no spurious zero",
    status: "warn",
    detail: `${pairs} target change(s) were immediately followed by an echo of exactly 0. The app filters these out as a known write artifact.`,
    because:
      "Every report on the original test device showed a spurious 0 notification directly after each real target value, consistently enough across sessions to be a device-side write artifact rather than a genuine second change.",
    data: { targetEchoZeroPairs: pairs },
  };
};

// Bug: the FTMS spec defines Target Speed at 0.01 km/h and Inclination at
// 0.1%, but the one device family this app was built against needed both one
// decimal place coarser. Getting this wrong in either direction is the single
// most consequential quirk there is: too coarse under-drives the machine,
// too fine drives it to maximum. This check *reports* the observed ratio and
// never changes behaviour on its own — see DeviceProbe.tsx's own note on why
// automatic actuation-scale switching was deliberately not built.
const checkWriteScale: Check = (o) => {
  const targets = obsOf(o, "control").filter(
    (c) =>
      c.requestedValue != null &&
      (c.requestedUnit === "kmh" || c.requestedUnit === "pct"),
  );
  if (targets.length === 0) {
    // Distinguish "device has no speed/incline target" from "we never tried",
    // because a bike reporting the former is entirely correct and should not
    // read as an untested gap.
    const feature = obsOf(o, "read").find(
      (r) => r.what === "Fitness Machine Feature",
    );
    const supported = feature?.decoded?.targetsSupported as
      string[] | undefined;
    if (
      supported &&
      !supported.includes("speed") &&
      !supported.includes("incline")
    ) {
      return {
        id: "write-scale",
        title: "Target commands land at the requested value",
        status: "skip",
        detail: `This device does not accept speed or incline targets (it supports ${supported.length ? supported.join(" + ") : "no targets"}), so there is no write scale to verify. That is normal for bikes and rowers.`,
      };
    }
    return {
      id: "write-scale",
      title: "Target commands land at the requested value",
      status: "skip",
      detail:
        "No target speed/incline commands were sent during this probe (device may not support control).",
    };
  }
  const samples = obsOf(o, "metrics");
  const findings: string[] = [];
  let worstRatio: number | null = null;
  let unit: string | null = null;
  for (const t of targets) {
    // Compare against a reading well after the command, so a treadmill still
    // accelerating isn't mistaken for a scale error — the settle window is
    // deliberately generous for exactly that reason.
    const settled = samples.filter(
      (s) => s.at > t.at + 8000 && s.at < t.at + 20000,
    );
    if (settled.length === 0) continue;
    const values = settled
      .map((s) =>
        t.requestedUnit === "kmh" ? s.metrics.speedKmh : s.metrics.inclinePct,
      )
      .filter((v): v is number => v != null);
    if (values.length === 0) continue;
    const achieved = values[values.length - 1];
    if (achieved === 0) continue; // machine never started — tells us nothing about scale
    const ratio = achieved / t.requestedValue!;
    if (
      worstRatio == null ||
      Math.abs(Math.log10(ratio)) > Math.abs(Math.log10(worstRatio))
    ) {
      worstRatio = ratio;
      unit = t.requestedUnit === "kmh" ? "km/h" : "%";
    }
    findings.push(
      `asked ${t.requestedValue}${t.requestedUnit === "kmh" ? "km/h" : "%"} → settled at ${achieved}`,
    );
  }
  if (worstRatio == null) {
    return {
      id: "write-scale",
      title: "Target commands land at the requested value",
      status: "skip",
      detail:
        "Target commands were sent but the machine never moved enough to measure what they actually did.",
    };
  }
  if (worstRatio > 0.7 && worstRatio < 1.4) {
    return {
      id: "write-scale",
      title: "Target commands land at the requested value",
      status: "pass",
      detail: `Targets landed where asked (${findings.join("; ")}).`,
      data: { observedWriteScaleRatio: Number(worstRatio.toFixed(2)) },
    };
  }
  const tooLow = worstRatio < 1;
  return {
    id: "write-scale",
    title: "Target commands land at the requested value",
    status: "fail",
    detail: `Targets landed ~${tooLow ? (1 / worstRatio).toFixed(0) + "x low" : worstRatio.toFixed(0) + "x high"} (${findings.join("; ")}). This device needs a different write scale in ${unit}.`,
    because:
      "The FTMS spec's own resolution (0.01 km/h, 0.1%) drove the original test treadmill 10x too fast — 5 km/h requested sent it to its maximum. The correct scale is a per-device quirk and getting it wrong is a safety issue, so this is reported for a human to encode rather than auto-applied.",
    data: { observedWriteScaleRatio: Number(worstRatio.toFixed(2)), unit },
  };
};

// Power and resistance targets carry no scale ambiguity (plain watts, plain
// level), so the meaningful question for them is simply whether the device
// accepted the command — reported separately from checkWriteScale rather than
// forced through a ratio comparison that would be meaningless.
const checkControlAccepted: Check = (o) => {
  const targets = obsOf(o, "control").filter(
    (c) => c.requestedUnit === "w" || c.requestedUnit === "level",
  );
  if (targets.length === 0) return null;
  const rejected = targets.filter((t) => t.resultCode !== 1);
  const unit = (t: (typeof targets)[number]) =>
    t.requestedUnit === "w"
      ? `${t.requestedValue}W`
      : `resistance level ${t.requestedValue}`;
  if (rejected.length > 0) {
    const r = rejected[0];
    return {
      id: "control-accepted",
      title: "Device accepts the target it advertises",
      status: "fail",
      detail: `The device declares it supports this target but rejected ${unit(r)}: ${r.resultMessage || (r.resultCode == null ? "no response" : `result 0x${r.resultCode.toString(16)}`)}.`,
      because:
        "Set Target Resistance in particular is split across real devices between a UINT8 and a SINT16 parameter — the FTMS 1.0 spec has errata here — so a rejection often means the wrong parameter width rather than an unsupported feature.",
      data: { targetRejected: true },
    };
  }
  return {
    id: "control-accepted",
    title: "Device accepts the target it advertises",
    status: "pass",
    detail: `The device accepted ${targets.map(unit).join(", ")}.`,
    data: { targetRejected: false },
  };
};

// The user's own eyes on the console — the only ground truth for whether a
// value the app displays matches what the machine says.
const checkConsoleAgreement: Check = (o) => {
  const answers = obsOf(o, "userAnswer").filter(
    (a) => a.value != null && a.appValue != null,
  );
  if (answers.length === 0) return null;
  // Tolerance is the looser of an absolute 0.5 unit or 10% — a console
  // rounding 8.4 to 8 is agreement; a 10x unit error is not.
  const mismatches = answers.filter(
    (a) => Math.abs(a.appValue! - a.value!) > Math.max(0.5, a.value! * 0.1),
  );
  if (mismatches.length > 0) {
    return {
      id: "console-agreement",
      title: "App readings match the console",
      status: "fail",
      detail: `${mismatches.length} of ${answers.length} confirmed readings disagreed with what the console displayed.`,
      because:
        "Byte-level correctness does not prove unit correctness — several past bugs decoded cleanly but in the wrong unit, and only a human reading the console caught them.",
      data: { consoleMismatches: mismatches.length },
    };
  }
  return {
    id: "console-agreement",
    title: "App readings match the console",
    status: "pass",
    detail: `All ${answers.length} reading(s) the user confirmed matched the console.`,
  };
};

const checkControlPermission: Check = (o) => {
  const discovery = obsOf(o, "discovery")[0];
  if (discovery && !discovery.hasControlPoint) {
    return {
      id: "control-permission",
      title: "Device accepts app control",
      status: "skip",
      detail:
        "This device exposes no Control Point, so it is monitor-only. That is normal for many rowers and bikes.",
      data: { controlSupported: false },
    };
  }
  const request = obsOf(o, "control").find((c) =>
    /request control/i.test(c.label),
  );
  if (!request) return null;
  if (request.resultCode == null) {
    return {
      id: "control-permission",
      title: "Device accepts app control",
      status: "fail",
      detail:
        "Request Control got no response before timing out — the device exposes a Control Point but is not answering it.",
      data: { controlSupported: false },
    };
  }
  if (request.resultCode !== 1) {
    return {
      id: "control-permission",
      title: "Device accepts app control",
      status: "fail",
      detail: `Request Control was rejected: ${request.resultMessage || `result code 0x${request.resultCode.toString(16)}`}. Another app (often the machine's own companion app) may already hold control.`,
      because:
        "Control held by another client is common on iFit-adjacent hardware and previously only surfaced on first use, long after the UI had already shown working controls.",
      data: { controlSupported: false },
    };
  }
  return {
    id: "control-permission",
    title: "Device accepts app control",
    status: "pass",
    detail: "Request Control was accepted.",
    data: { controlSupported: true },
  };
};

// Bug: devices that reject Start/Resume with Operation Failed when already
// running previously broke the whole preamble, so no target command was ever
// attempted for the rest of the connection.
const checkStartResume: Check = (o) => {
  const start = obsOf(o, "control").find((c) => /start/i.test(c.label));
  if (!start) return null;
  if (start.resultCode === 1)
    return {
      id: "start-resume",
      title: "Start/Resume accepted",
      status: "pass",
      detail: "The device accepted Start/Resume.",
    };
  return {
    id: "start-resume",
    title: "Start/Resume accepted",
    status: "warn",
    detail:
      start.resultCode == null
        ? "Start/Resume got no response. The app now treats this as non-fatal and continues to the real command."
        : `The device rejected Start/Resume (${start.resultMessage || `0x${start.resultCode.toString(16)}`}). The app now treats this as non-fatal and continues.`,
    because:
      "A rejected Start/Resume used to throw out of the once-per-connection preamble, so the actual Set Target command was never sent — and it failed identically on every retry.",
  };
};

// Rowers report no speed field in either protocol, so the generic
// speed-driven checks all skip on them and a genuinely broken rower could
// come back with a clean report saying almost nothing (one real rower
// returned 0 fail / 0 warn while its distance counter reset to zero and no
// stroke data was surfaced at all). Stroke count is the signal that actually
// establishes a rower did something, so it gets checked on its own terms.
const checkRowerEffortSignal: Check = (o) => {
  const d = obsOf(o, "discovery")[0];
  if (d?.detectedCardioType !== "Rower") return null;
  const samples = obsOf(o, "metrics");
  if (samples.length === 0) return null;

  const strokes = samples
    .map((s) => s.metrics.strokeCount)
    .filter((v): v is number => v != null);
  const rates = samples
    .map((s) => s.metrics.cadenceRpm)
    .filter((v): v is number => v != null);
  const distances = samples
    .map((s) => s.metrics.distanceM)
    .filter((v): v is number => v != null);
  const hasSpeed = samples.some((s) => s.metrics.speedKmh != null);

  const strokesAdvanced =
    strokes.length > 1 && Math.max(...strokes) > strokes[0];
  const distanceAdvanced =
    distances.length > 1 && Math.max(...distances) > distances[0];
  const sawStrokeRate = rates.some((r) => r > 0);

  if (strokes.length === 0 && distances.length === 0 && rates.length === 0) {
    return {
      id: "rower-effort-signal",
      title: "Rower reports usable effort data",
      status: "fail",
      detail:
        "This rower reported no stroke count, no stroke rate and no distance — there is nothing to measure a session with.",
      because:
        "Rower Data has no speed field in either protocol, so stroke rate, stroke count and distance are the only signals a rowing session can be built from.",
      data: { rowerEffortSignal: false },
    };
  }
  if (!strokesAdvanced && !distanceAdvanced) {
    return {
      id: "rower-effort-signal",
      title: "Rower reports usable effort data",
      status: "warn",
      detail: `Neither stroke count nor distance advanced during the probe${sawStrokeRate ? " (a stroke rate was seen, but no cumulative total moved)" : ""}. Either the machine was not actually rowed, or it only updates these while its own console is in an active workout.`,
      because:
        "A real rower spent the probe in its paused state emitting all-zero frames, which produced a clean-looking report that said nothing useful.",
      data: {
        rowerEffortSignal: false,
        strokesReported: strokes.length > 0,
        distanceReported: distances.length > 0,
      },
    };
  }
  const parts: string[] = [];
  if (strokesAdvanced)
    parts.push(`stroke count ${strokes[0]} → ${Math.max(...strokes)}`);
  if (distanceAdvanced)
    parts.push(`distance ${distances[0]}m → ${Math.max(...distances)}m`);
  return {
    id: "rower-effort-signal",
    title: "Rower reports usable effort data",
    status: "pass",
    detail: `${parts.join(", ")}${hasSpeed ? "" : " (no speed field, as expected for a rower — pace is converted to speed where the device reports it)"}.`,
    data: { rowerEffortSignal: true },
  };
};

const checkFieldCoverage: Check = (o) => {
  const samples = obsOf(o, "metrics");
  if (samples.length === 0) return null;
  const fields: (keyof ProbeMetrics)[] = [
    "speedKmh",
    "cadenceRpm",
    "powerW",
    "distanceM",
    "inclinePct",
    "elapsedTimeSec",
    "heartRateBpm",
    "caloriesKcal",
    "strokeCount",
    "running",
  ];
  const present = fields.filter((f) =>
    samples.some((s) => s.metrics[f] != null),
  );
  const absent = fields.filter((f) => !present.includes(f));
  return {
    id: "field-coverage",
    title: "Fields this device reports",
    status: "pass",
    detail: present.length
      ? `Reports: ${present.join(", ")}.${absent.length ? ` Not reported: ${absent.join(", ")}.` : ""}`
      : "This device reported no recognized fields at all.",
    data: { fieldsReported: present, fieldsAbsent: absent },
  };
};

const checkCardioTypeDetection: Check = (o) => {
  const d = obsOf(o, "discovery")[0];
  if (!d) return null;
  if (!d.detectedCardioType) {
    return {
      id: "cardio-type",
      title: "Equipment type recognized",
      status: "fail",
      detail:
        "None of the recognized FTMS Data characteristics were found on this device.",
      because:
        'Cross Trainer, Step Climber and Stair Climber were previously unrecognized, so real FTMS ellipticals were reported to users as "does not support FTMS" and pushed down the iFit fallback path.',
    };
  }
  if (d.detectedCardioType !== d.requestedCardioType) {
    return {
      id: "cardio-type",
      title: "Equipment type recognized",
      status: "warn",
      detail: `Connected as "${d.requestedCardioType}" but this device is actually a ${d.detectedCardioType}. The app relabels automatically.`,
    };
  }
  return {
    id: "cardio-type",
    title: "Equipment type recognized",
    status: "pass",
    detail: `Detected as ${d.detectedCardioType}.`,
  };
};

// --- iFit-specific checks -------------------------------------------------

const checkIfitChecksums: Check = (o, ctx) => {
  if (ctx.protocol !== "iFit") return null;
  const frames = obsOf(o, "ifitFrame").filter((f) => f.responseHex != null);
  if (frames.length === 0) {
    return {
      id: "ifit-checksum",
      title: "Response frames pass checksum",
      status: "fail",
      detail: "The device never returned a response frame.",
    };
  }
  const bad = frames.filter((f) => f.checksumValid === false);
  const unknown = frames.filter((f) => f.checksumValid === null);
  if (bad.length > 0) {
    return {
      id: "ifit-checksum",
      title: "Response frames pass checksum",
      status: "fail",
      detail: `${bad.length} of ${frames.length} response frames failed checksum verification — decoded values from this device cannot be trusted.`,
      because:
        "Inbound checksums were previously never verified, so a corrupted or misaligned frame decoded exactly like a good one.",
      data: { badChecksums: bad.length, totalFrames: frames.length },
    };
  }
  return {
    id: "ifit-checksum",
    title: "Response frames pass checksum",
    status: "pass",
    detail: `All ${frames.length} response frames passed checksum verification${unknown.length ? ` (${unknown.length} too short to check)` : ""}.`,
  };
};

const checkIfitCommandMatch: Check = (o, ctx) => {
  if (ctx.protocol !== "iFit") return null;
  const frames = obsOf(o, "ifitFrame").filter((f) => f.responseCommand != null);
  if (frames.length === 0) return null;
  const mismatched = frames.filter(
    (f) => f.responseCommand !== f.requestCommand,
  );
  if (mismatched.length > 0) {
    return {
      id: "ifit-command-match",
      title: "Responses match their request",
      status: "fail",
      detail: `${mismatched.length} of ${frames.length} responses answered a different command than was sent — replies are being misattributed on this device.`,
      because:
        "Response correlation is positional: a reply arriving after its own timeout lands in the next command's window, so a late DeviceInfo reply gets decoded as a metrics value set.",
      data: { mismatchedResponses: mismatched.length },
    };
  }
  return {
    id: "ifit-command-match",
    title: "Responses match their request",
    status: "pass",
    detail: `All ${frames.length} responses answered the command that was sent.`,
  };
};

// Bug: a device that doesn't implement a requested BitField simply omits it
// from the response, silently shifting every value requested after it — e.g.
// a treadmill with no heart-rate grip dropping Pulse and corrupting speed,
// incline, calories and burn rate all at once.
const checkIfitResponseLength: Check = (o, ctx) => {
  if (ctx.protocol !== "iFit") return null;
  const frames = obsOf(o, "ifitFrame").filter(
    (f) => f.actualPayloadBytes != null && f.expectedPayloadBytes > 0,
  );
  if (frames.length === 0) return null;
  const short = frames.filter(
    (f) => (f.actualPayloadBytes ?? 0) < f.expectedPayloadBytes,
  );
  if (short.length > 0) {
    const worst = short[0];
    return {
      id: "ifit-response-length",
      title: "Responses carry every requested field",
      status: "fail",
      detail: `${short.length} of ${frames.length} responses were shorter than the requested fields need (expected ${worst.expectedPayloadBytes} payload bytes, got ${worst.actualPayloadBytes}). Fields after the truncation point are unknown.`,
      because:
        "A device that does not implement a requested BitField omits it from the response, shifting every later value into garbage — a treadmill with no heart-rate grip corrupted speed, incline and calories this way.",
      data: { shortResponses: short.length },
    };
  }
  return {
    id: "ifit-response-length",
    title: "Responses carry every requested field",
    status: "pass",
    detail: `All ${frames.length} responses were long enough for the fields requested.`,
  };
};

// The response status byte (CmdStatus) was previously never read at all on
// either the live connection or the probe — a well-formed, checksum-valid
// frame with Status=SecurityBlock looked identical to one with Status=Done,
// so a device that rejected every write (e.g. because ENABLE never really
// unlocked it) gave no visible sign of that beyond the read-back inference
// checkIfitControl already has to do. This is the more direct signal.
const checkIfitResponseStatus: Check = (o, ctx) => {
  if (ctx.protocol !== "iFit") return null;
  const frames = obsOf(o, "ifitFrame").filter((f) => f.responseStatus != null);
  if (frames.length === 0) return null;
  const CMD_STATUS_DONE = 2;
  const CMD_STATUS_SECURITY_BLOCK = 8;
  const blocked = frames.filter(
    (f) => f.responseStatus === CMD_STATUS_SECURITY_BLOCK,
  );
  const otherBad = frames.filter(
    (f) =>
      f.responseStatus !== CMD_STATUS_DONE &&
      f.responseStatus !== CMD_STATUS_SECURITY_BLOCK,
  );
  if (blocked.length > 0) {
    return {
      id: "ifit-response-status",
      title: "Responses report success (CmdStatus)",
      status: "fail",
      detail: `${blocked.length} of ${frames.length} responses came back with status SecurityBlock — the device is rejecting these commands as still locked, even though a well-formed frame came back.`,
      because:
        'A checksum-valid, correctly-addressed response can still mean "rejected" — CmdStatus is a separate signal this app previously never read at all.',
      data: {
        securityBlockResponses: blocked.length,
        totalFrames: frames.length,
      },
    };
  }
  if (otherBad.length > 0) {
    return {
      id: "ifit-response-status",
      title: "Responses report success (CmdStatus)",
      status: "warn",
      detail: `${otherBad.length} of ${frames.length} responses came back with a non-Done status (codes: ${[...new Set(otherBad.map((f) => f.responseStatus))].join(", ")}).`,
      data: { nonDoneResponses: otherBad.length, totalFrames: frames.length },
    };
  }
  return {
    id: "ifit-response-status",
    title: "Responses report success (CmdStatus)",
    status: "pass",
    detail: `All ${frames.length} responses reported CmdStatus=Done.`,
  };
};

// iFit control, which until now the probe never exercised at all — an iFit
// treadmill or rower came back with no control verdict whatsoever.
//
// This protocol has no per-command acknowledgement: a WRITE_AND_READ carrying
// a target value gets the same response frame shape whether the device
// honoured it or silently discarded it. "A frame came back" is therefore not
// evidence of anything. What *is* evidence is the read-back — the same
// characteristic ids the control path writes (Kph 0, Incline 1, Resistance 2)
// are also read every poll, so a write that landed shows up as the device's
// own reported target changing to match. That is what this checks.
// iFit has two protocol generations sharing one BLE service and one
// characteristic pair, so discovery alone cannot tell them apart. This app
// implements FitPro1 only; a FitPro2 console connects, receives frames it
// does not understand, answers nothing, and is indistinguishable from a dead
// device unless something actually asks it in its own dialect.
const checkIfitGeneration: Check = (o, ctx) => {
  if (ctx.protocol !== "iFit") return null;
  const probeRead = obsOf(o, "read").find(
    (r) => r.what === "FitPro2 protocol probe",
  );
  const gotFitPro1 = obsOf(o, "ifitFrame").some((f) => f.responseHex != null);
  if (gotFitPro1) {
    return {
      id: "ifit-generation",
      title: "Console speaks a protocol this app implements",
      status: "pass",
      detail:
        "This console answers FitPro1, which is the generation this app implements.",
      data: { ifitGeneration: "FitPro1" },
    };
  }
  if (!probeRead) return null;
  if ((probeRead.decoded as any)?.generation === "FitPro2") {
    return {
      id: "ifit-generation",
      title: "Console speaks a protocol this app implements",
      status: "fail",
      detail:
        "This console speaks FitPro2, a newer iFit protocol generation this app does not implement. The machine is not faulty — it answers correctly, just in a dialect nothing here understands. Supporting it means a separate implementation: different framing with no checksum, subscribe-and-push reads instead of polling, and every value as an IEEE-754 float rather than per-field scaling.",
      because:
        'Both generations share exactly one "Fit Pro" BLE service and one DeviceTx/DeviceRx pair, so nothing observable at connect time distinguishes them — a FitPro2 machine previously looked identical to a broken one.',
      data: { ifitGeneration: "FitPro2" },
    };
  }
  return {
    id: "ifit-generation",
    title: "Console speaks a protocol this app implements",
    status: "fail",
    detail:
      "This console answered neither FitPro1 nor FitPro2. It exposes the iFit BLE service but responds to no known command in either generation.",
    data: { ifitGeneration: "unknown" },
  };
};

const checkIfitControl: Check = (o, ctx) => {
  if (ctx.protocol !== "iFit") return null;
  const d = obsOf(o, "discovery")[0];
  if (d && !d.hasControlPoint) {
    return {
      id: "ifit-control",
      title: "Device accepts app control",
      status: "skip",
      detail:
        "This equipment type has no writable characteristic in the iFit protocol, so it is monitor-only.",
      data: { controlSupported: false },
    };
  }

  // ActivationLock (BitField 100) is the device's own statement of whether it
  // is unlocked — the decompiled Sindarin.Core ActivationLockFacade treats
  // this single field as the lock state for both protocol generations. When
  // the device reports it, it settles "did ENABLE work" outright, which is
  // strictly better than inferring it from whether a later write stuck.
  const lock = obsOf(o, "read").find(
    (r) => r.what === "ActivationLock (BitField 100)",
  );
  const lockState = (lock?.decoded as any)?.unlocked as
    boolean | null | undefined;
  if (lockState === false) {
    return {
      id: "ifit-control",
      title: "Device accepts app control",
      status: "fail",
      detail: `The device still reports itself as activation-locked after the ENABLE handshake (ActivationLock = ${(lock?.decoded as any)?.after}). Control writes will be accepted at the transport level and then ignored.`,
      because:
        "ActivationLock is the device's own lock flag. A locked console answers writes normally and discards them, so without reading this field an unlock failure is invisible until a target silently fails to take effect.",
      data: { controlSupported: false, activationLocked: true },
    };
  }

  const enable = obsOf(o, "control").find((c) => /enable/i.test(c.label));
  const writes = obsOf(o, "control").filter(
    (c) => c.requestedValue != null && /set target/i.test(c.label),
  );
  if (!enable && writes.length === 0) {
    return {
      id: "ifit-control",
      title: "Device accepts app control",
      status: "skip",
      detail:
        "The control test was not run on this device, so whether it accepts commands is untested.",
    };
  }
  if (enable && enable.resultCode == null) {
    return {
      id: "ifit-control",
      title: "Device accepts app control",
      status: "fail",
      detail:
        "The ENABLE handshake got no response, so the device never unlocked for control. Target writes after this cannot be expected to work.",
      because:
        "iFit equipment requires an ENABLE command carrying a per-device activation payload before it will honour any write; without it, writes are silently discarded.",
      data: { controlSupported: false },
    };
  }
  if (writes.length === 0) {
    return {
      id: "ifit-control",
      title: "Device accepts app control",
      status: "warn",
      detail:
        "ENABLE was answered but no target write was attempted, so control is only half-verified.",
    };
  }

  // Did the device's own read-back move to what was written? Samples are
  // taken from after the write, since the value is only read once per poll.
  const samples = obsOf(o, "metrics");
  const results = writes.map((w) => {
    const after = samples.filter((s) => s.at > w.at);
    const readBack = after
      .map((s) =>
        w.requestedUnit === "kmh"
          ? s.metrics.targetSpeedKmh
          : w.requestedUnit === "pct"
            ? s.metrics.targetInclinePct
            : s.metrics.resistanceLevel,
      )
      .filter((v): v is number => v != null);
    // Generous tolerance: these round-trip through a scaled uint16 and, for
    // resistance, through a level→raw→level conversion.
    const matched = readBack.some(
      (v) =>
        Math.abs(v - w.requestedValue!) <=
        Math.max(0.6, Math.abs(w.requestedValue!) * 0.15),
    );
    return {
      w,
      matched,
      sawAny: readBack.length > 0,
      last: readBack.length ? readBack[readBack.length - 1] : null,
    };
  });

  const label = (w: (typeof writes)[number]) =>
    `${w.requestedValue}${w.requestedUnit === "kmh" ? " km/h" : w.requestedUnit === "pct" ? "%" : ""}`;
  const confirmed = results.filter((r) => r.matched);
  if (confirmed.length === results.length) {
    return {
      id: "ifit-control",
      title: "Device accepts app control",
      status: "pass",
      detail: `Every target write was confirmed by the device's own read-back (${results.map((r) => `asked ${label(r.w)} → device reported ${r.last}`).join("; ")}).`,
      data: { controlSupported: true, ifitWritesConfirmed: confirmed.length },
    };
  }
  const unread = results.filter((r) => !r.sawAny);
  if (unread.length === results.length) {
    return {
      id: "ifit-control",
      title: "Device accepts app control",
      status: "warn",
      detail:
        "Target writes were sent and answered, but this device never reported its own target back, so there is no way to confirm they were honoured.",
      because:
        "This protocol has no per-command acknowledgement — the read-back of the written characteristic is the only available confirmation.",
      data: { controlSupported: null },
    };
  }
  return {
    id: "ifit-control",
    title: "Device accepts app control",
    status: "fail",
    detail: `The device answered the write but its own reported target did not change to match (${results.map((r) => `asked ${label(r.w)}, device reports ${r.last ?? "nothing"}`).join("; ")}). The command was accepted at the transport level and then ignored.`,
    because:
      "Writes are silently discarded when the ENABLE handshake did not really unlock the device, which looks identical to success at the frame level.",
    data: { controlSupported: false, ifitWritesConfirmed: confirmed.length },
  };
};

const checkIfitSupportedIds: Check = (o, ctx) => {
  if (ctx.protocol !== "iFit") return null;
  const read = obsOf(o, "read").find(
    (r) => r.what === "DeviceInfo supported BitFields",
  );
  if (!read) return null;
  if (read.error || !read.decoded) {
    return {
      id: "ifit-supported-ids",
      title: "Device declares which fields it supports",
      status: "warn",
      detail:
        "DeviceInfo did not return a supported-BitFields bitmap, so the app must request every field unfiltered — which risks read misalignment if any are unsupported.",
      because:
        "Requesting an unsupported BitField shifts every value after it; the bitmap is what lets the app drop them from the request up front.",
    };
  }
  const supported = (read.decoded as any).supportedIds as number[] | undefined;
  const dropped = (read.decoded as any).droppedIds as number[] | undefined;
  return {
    id: "ifit-supported-ids",
    title: "Device declares which fields it supports",
    status: "pass",
    detail: dropped?.length
      ? `Device declared ${supported?.length ?? 0} supported fields; ${dropped.length} requested field(s) were dropped to keep the rest aligned: [${dropped.join(", ")}].`
      : `Device declared ${supported?.length ?? 0} supported fields; every field this app requests is supported.`,
    data: {
      supportedIdCount: supported?.length ?? 0,
      droppedIds: dropped ?? [],
    },
  };
};

const ALL_CHECKS: Check[] = [
  checkStayedConnected,
  checkIdleBlanking,
  checkCardioTypeDetection,
  checkNotificationsArrive,
  checkBaselineQuiet,
  checkFieldCoverage,
  checkFlagStability,
  checkDistanceAdvances,
  checkDistanceScale,
  checkSpeedVsElapsedTime,
  checkMachineStatusFirstEvent,
  checkTargetEchoZeroArtifact,
  checkRowerEffortSignal,
  checkControlPermission,
  checkStartResume,
  checkWriteScale,
  checkControlAccepted,
  checkConsoleAgreement,
  checkIfitChecksums,
  checkIfitCommandMatch,
  checkIfitResponseLength,
  checkIfitResponseStatus,
  checkIfitGeneration,
  checkIfitSupportedIds,
  checkIfitControl,
];

export function runChecks(
  observations: ProbeObservation[],
  protocol: ProbeProtocol,
): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  for (const check of ALL_CHECKS) {
    const result = check(observations, { protocol });
    if (result) findings.push(result);
  }
  return findings;
}

// Rolls the findings' structured `data` up into the paste-into-a-ticket
// profile. Reads only from findings (never re-derives from observations) so
// the profile can never disagree with the report a human is looking at.
export function buildDeviceProfile(
  findings: ProbeFinding[],
  meta: {
    protocol: ProbeProtocol;
    deviceName: string;
    detectedCardioType: CardioType | null;
  },
): DeviceProfile {
  const data = Object.assign(
    {},
    ...findings.map((f) => f.data ?? {}),
  ) as Record<string, unknown>;
  const notes = findings
    .filter((f) => f.status === "fail" || f.status === "warn")
    .map((f) => `${f.status.toUpperCase()}: ${f.title} — ${f.detail}`);
  // Only a *conclusive* write-scale finding contributes a scale to the
  // profile. Previously any recorded ratio did, including the one produced
  // when a bike was wrongly sent a speed target and its rider's own pedalling
  // speed was compared against it — which wrote observedSpeedWriteScale: 42.7
  // into a profile shaped to be pasted straight into a quirks registry.
  const scaleFinding = findings.find(
    (f) => f.id === "write-scale" && f.status === "fail",
  );
  const ratio = scaleFinding?.data?.observedWriteScaleRatio as
    number | undefined;
  return {
    protocol: meta.protocol,
    deviceName: meta.deviceName,
    detectedCardioType: meta.detectedCardioType,
    fieldsReported: (data.fieldsReported as string[]) ?? [],
    flagMasksSeen: (data.flagMasks as string[]) ?? [],
    distanceTrustworthy:
      (data.distanceTrustworthy as boolean | undefined) ?? null,
    // Reported as the multiplier a human would need to apply, not applied
    // anywhere automatically — see checkWriteScale's own comment.
    observedSpeedWriteScale:
      ratio != null && scaleFinding?.data?.unit === "km/h"
        ? Number((DEFAULT_SPEED_WRITE_SCALE * ratio).toFixed(2))
        : null,
    observedInclineWriteScale:
      ratio != null && scaleFinding?.data?.unit === "%"
        ? Number((DEFAULT_INCLINE_WRITE_SCALE * ratio).toFixed(2))
        : null,
    controlSupported: (data.controlSupported as boolean | undefined) ?? null,
    machineStatusSupported:
      (data.machineStatusSupported as boolean | undefined) ?? null,
    notes,
  };
}

export function buildReport(
  observations: ProbeObservation[],
  meta: {
    protocol: ProbeProtocol;
    deviceName: string;
    requestedCardioType: CardioType;
    detectedCardioType: CardioType | null;
    startedAt: number;
  },
): ProbeReport {
  const findings = runChecks(observations, meta.protocol);
  const summary = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const f of findings) summary[f.status]++;
  return {
    protocol: meta.protocol,
    deviceName: meta.deviceName,
    requestedCardioType: meta.requestedCardioType,
    detectedCardioType: meta.detectedCardioType,
    startedAt: meta.startedAt,
    endedAt: Date.now(),
    findings,
    observations,
    profile: buildDeviceProfile(findings, meta),
    summary,
  };
}

// Turns a finished report into a proposed deviceRegistry.ts row: the actual
// deliverable of a probe run. Without this the loop stops at "here is a
// diagnosis" and a human still has to translate findings into quirks by hand;
// with it, supporting a newly-reported machine is a paste.
//
// Only quirks the run actually *measured* are emitted. A check that skipped
// contributes nothing, because a registry entry asserting something nobody
// observed is worse than no entry — it silently overrides the adaptive
// behaviour that would otherwise have worked it out at runtime.
export function proposeRegistryEntry(report: ProbeReport): DeviceRegistryEntry {
  const byId = (id: string) => report.findings.find((f) => f.id === id);
  const quirks: DeviceQuirks = {};

  const distance = byId("distance-advances");
  if (distance?.status === "fail") quirks.distanceTrustworthy = false;
  else if (distance?.status === "pass") quirks.distanceTrustworthy = true;
  if (distance?.data?.distanceResetMidSession)
    quirks.distanceResetsMidSession = true;
  if (byId("idle-blanking")?.data?.blanksValuesWhenIdle)
    quirks.blanksValuesWhenIdle = true;
  const generation = byId("ifit-generation")?.data?.ifitGeneration as
    string | undefined;
  if (generation === "FitPro1" || generation === "FitPro2")
    quirks.ifitGeneration = generation;
  if (byId("ifit-control")?.data?.activationLocked)
    quirks.activationLocked = true;

  const scaleData = byId("distance-scale")?.data?.distanceScaleRatio as
    number | undefined;
  // Only a decisive, near-round-number ratio is worth encoding; anything
  // in between is noise from an imprecise speed integration.
  if (scaleData != null && (scaleData >= 5 || scaleData <= 0.2)) {
    quirks.distanceScale = Number((1 / scaleData).toFixed(3));
  }

  if (report.profile.observedSpeedWriteScale != null)
    quirks.speedWriteScale = report.profile.observedSpeedWriteScale;
  if (report.profile.observedInclineWriteScale != null)
    quirks.inclineWriteScale = report.profile.observedInclineWriteScale;

  if (byId("machine-status-first-event")?.data?.firstEventStale)
    quirks.machineStatusFirstEventStale = true;
  if (byId("target-echo-zero")?.data?.targetEchoZeroPairs as number | undefined)
    quirks.targetEchoZeroArtifact = true;

  const evidence = report.findings
    .filter((f) => f.status === "fail" || f.status === "warn")
    .map((f) => f.detail)
    .join(" ");

  // Identity read from the Device Information Service (FTMS) or the metadata
  // commands (iFit). Carried on the entry as documentation, not as a matcher
  // — matching happens at picker time, before any of this is readable.
  const dis = report.observations.find(
    (o) => o.kind === "read" && o.what === "Device Information",
  ) as Extract<ProbeObservation, { kind: "read" }> | undefined;
  const activation = report.observations.find(
    (o) => o.kind === "read" && o.what === "Activation inputs",
  ) as Extract<ProbeObservation, { kind: "read" }> | undefined;
  const d = (dis?.decoded ?? {}) as Record<string, string | undefined>;
  const a = (activation?.decoded ?? {}) as Record<
    string,
    number | null | undefined
  >;
  const identity: DeviceIdentity = {};
  if (d.manufacturerName) identity.manufacturerName = d.manufacturerName;
  if (d.modelNumber) identity.modelNumber = d.modelNumber;
  if (d.hardwareRevision) identity.hardwareRevision = d.hardwareRevision;
  if (d.firmwareRevision) identity.firmwareRevision = d.firmwareRevision;
  if (d.softwareRevision) identity.softwareRevision = d.softwareRevision;
  if (a.model != null) identity.ifitModel = a.model;
  if (a.partNumber != null) identity.ifitPartNumber = a.partNumber;

  return {
    label: `${report.deviceName}${report.detectedCardioType ? ` (${report.detectedCardioType})` : ""}`,
    protocol: report.protocol,
    name: report.deviceName,
    ...(Object.keys(identity).length ? { identity } : {}),
    confidence: "confirmed",
    source: `Device probe report, ${new Date(report.startedAt).toISOString().slice(0, 10)}`,
    evidence: evidence || "Probe completed with no failures or warnings.",
    quirks,
  };
}

// --- Golden fixtures ------------------------------------------------------
//
// The third leg of the loop. A probe run already produces a diagnosis
// (findings) and a fix (a registry entry); this produces the *regression
// test* — real bytes from a real machine, paired with what the parsers
// decoded them to at the time.
//
// This is the measure that actually stops "we fixed it for device A and broke
// device B", because a parser change that alters how a captured frame decodes
// fails CI instead of shipping. The single most valuable test in ble.test.ts
// has always been the one real captured treadmill frame; this makes producing
// those a paste rather than an archaeology exercise.

export interface GoldenFixture {
  /** Where these bytes came from, for the reader of a failing test. */
  device: string;
  protocol: ProbeProtocol;
  /** FTMS: the numeric data-characteristic UUID. iFit: omitted. */
  charUuid?: number;
  /** iFit: the ids the frame's payload holds, in request order. */
  readIds?: number[];
  rawHex: string;
  /** FTMS only — the flags mask, which is what selects the parser path. */
  flags?: number | null;
  /** What the parsers produced for these bytes when they were captured. */
  expected: ProbeMetrics;
  note: string;
}

function uuidToNumber(uuid: string | null): number | undefined {
  if (!uuid) return undefined;
  const m = /^0000([0-9a-f]{4})-0000-1000-8000-00805f9b34fb$/i.exec(uuid);
  return m ? parseInt(m[1], 16) : undefined;
}

/**
 * Picks the frames worth keeping from a run. Deliberately a handful, not
 * everything: a fixture file has to stay reviewable, and near-identical
 * frames from a steady session test nothing the first one didn't.
 *
 * Selection is by *parser path* — one fixture per distinct FTMS flags mask,
 * since the mask is precisely what decides which fields get walked, and one
 * per distinct decoded-field shape for iFit, which has no flags. Within each
 * group the richest frame wins (most non-null fields), because a frame where
 * everything is zero exercises the offsets without proving them.
 */
export function extractGoldenFixtures(
  report: ProbeReport,
  maxFixtures = 8,
): GoldenFixture[] {
  const samples = report.observations.filter(
    (o): o is Extract<ProbeObservation, { kind: "metrics" }> =>
      o.kind === "metrics",
  );
  if (samples.length === 0) return [];

  const discovery = report.observations.find(
    (o): o is Extract<ProbeObservation, { kind: "discovery" }> =>
      o.kind === "discovery",
  );
  const charUuid = uuidToNumber(discovery?.dataCharacteristicUuid ?? null);
  const monitorIds = report.observations.find(
    (o): o is Extract<ProbeObservation, { kind: "read" }> =>
      o.kind === "read" && o.what === "Monitor read ids",
  );
  const readIds = (monitorIds?.decoded as any)?.readIds as number[] | undefined;

  const richness = (m: ProbeMetrics) =>
    Object.values(m).filter((v) => v != null).length;

  const groups = new Map<
    string,
    Extract<ProbeObservation, { kind: "metrics" }>
  >();
  for (const s of samples) {
    // FTMS groups by flags mask (the parser path); iFit has no flags, so
    // group by which fields came back non-null instead.
    const key =
      report.protocol === "FTMS" && s.flags != null
        ? `flags:${s.flags}`
        : `shape:${Object.entries(s.metrics)
            .filter(([, v]) => v != null)
            .map(([k]) => k)
            .join(",")}`;
    const existing = groups.get(key);
    if (!existing || richness(s.metrics) > richness(existing.metrics))
      groups.set(key, s);
  }

  return [...groups.entries()]
    .sort((a, b) => richness(b[1].metrics) - richness(a[1].metrics))
    .slice(0, maxFixtures)
    .map(([key, s]) => ({
      device: report.deviceName,
      protocol: report.protocol,
      ...(report.protocol === "FTMS"
        ? { charUuid, flags: s.flags }
        : { readIds }),
      rawHex: s.rawHex,
      expected: s.metrics,
      note: `${report.detectedCardioType ?? "unknown type"}, ${key}`,
    }));
}

/** Pasteable source for deviceFixtures.ts, same idea as the registry entry. */
export function formatGoldenFixtureSource(fixtures: GoldenFixture[]): string {
  if (fixtures.length === 0)
    return "// (no frames captured — nothing to turn into fixtures)";
  return fixtures
    .map((f) => {
      const lines = [
        "{",
        `  device: '${f.device.replace(/'/g, "\\'")}',`,
        `  protocol: '${f.protocol}',`,
        f.charUuid != null ? `  charUuid: 0x${f.charUuid.toString(16)},` : null,
        f.readIds ? `  readIds: [${f.readIds.join(", ")}],` : null,
        f.flags != null ? `  flags: 0x${f.flags.toString(16)},` : null,
        `  rawHex: '${f.rawHex}',`,
        `  note: '${f.note.replace(/'/g, "\\'")}',`,
        "  expected: {",
        ...Object.entries(f.expected).map(
          ([k, v]) => `    ${k}: ${v === null ? "null" : v},`,
        ),
        "  },",
        "},",
      ];
      return lines.filter((l) => l !== null).join("\n");
    })
    .join("\n");
}

// --- Report diffing -------------------------------------------------------
//
// Probe the same machine twice — after a firmware update, or just to check
// the results are stable — and compare. A device whose findings move between
// runs is telling you something either about its firmware or about how
// reproducible a given check actually is; both are worth knowing, and neither
// is visible from reading two reports side by side.

export interface ReportDiff {
  before: { device: string; when: number };
  after: { device: string; when: number };
  sameDevice: boolean;
  changedFindings: {
    id: string;
    title: string;
    from: ProbeStatus | "absent";
    to: ProbeStatus | "absent";
    detail: string;
  }[];
  fieldsGained: string[];
  fieldsLost: string[];
  profileChanges: { key: string; from: unknown; to: unknown }[];
}

export function diffReports(
  before: ProbeReport,
  after: ProbeReport,
): ReportDiff {
  const beforeById = new Map(before.findings.map((f) => [f.id, f]));
  const afterById = new Map(after.findings.map((f) => [f.id, f]));

  const changedFindings: ReportDiff["changedFindings"] = [];
  for (const id of new Set([...beforeById.keys(), ...afterById.keys()])) {
    const b = beforeById.get(id);
    const a = afterById.get(id);
    const from = b?.status ?? "absent";
    const to = a?.status ?? "absent";
    if (from !== to)
      changedFindings.push({
        id,
        title: a?.title ?? b!.title,
        from,
        to,
        detail: a?.detail ?? b!.detail,
      });
  }

  const beforeFields = new Set(before.profile.fieldsReported);
  const afterFields = new Set(after.profile.fieldsReported);

  const profileChanges: ReportDiff["profileChanges"] = [];
  const keys: (keyof DeviceProfile)[] = [
    "detectedCardioType",
    "distanceTrustworthy",
    "observedSpeedWriteScale",
    "observedInclineWriteScale",
    "controlSupported",
    "machineStatusSupported",
    "flagMasksSeen",
  ];
  for (const key of keys) {
    const b = JSON.stringify(before.profile[key] ?? null);
    const a = JSON.stringify(after.profile[key] ?? null);
    if (b !== a)
      profileChanges.push({
        key,
        from: before.profile[key] ?? null,
        to: after.profile[key] ?? null,
      });
  }

  return {
    before: { device: before.deviceName, when: before.startedAt },
    after: { device: after.deviceName, when: after.startedAt },
    // Compared case-insensitively: a diff across two genuinely different
    // machines is almost always a mistake worth flagging rather than a result.
    sameDevice:
      before.deviceName.trim().toLowerCase() ===
      after.deviceName.trim().toLowerCase(),
    changedFindings: changedFindings.sort((x, y) => x.id.localeCompare(y.id)),
    fieldsGained: [...afterFields].filter((f) => !beforeFields.has(f)).sort(),
    fieldsLost: [...beforeFields].filter((f) => !afterFields.has(f)).sort(),
    profileChanges,
  };
}

export function formatReportDiff(diff: ReportDiff): string {
  const lines: string[] = [];
  const when = (t: number) => new Date(t).toLocaleString(getActiveLocale());
  lines.push("PROBE COMPARISON");
  lines.push(`Earlier: ${diff.before.device} (${when(diff.before.when)})`);
  lines.push(`Later:   ${diff.after.device} (${when(diff.after.when)})`);
  if (!diff.sameDevice)
    lines.push(
      "WARNING: these two reports are from differently-named devices, so differences below may just be two different machines.",
    );
  lines.push("");

  if (
    !diff.changedFindings.length &&
    !diff.fieldsGained.length &&
    !diff.fieldsLost.length &&
    !diff.profileChanges.length
  ) {
    lines.push(
      "No differences: every check reached the same verdict and the device reported the same fields.",
    );
    return lines.join("\n");
  }

  if (diff.changedFindings.length) {
    lines.push("--- CHANGED VERDICTS ---");
    for (const c of diff.changedFindings) {
      lines.push(
        `${c.from.toUpperCase()} -> ${c.to.toUpperCase()}  ${c.title}`,
      );
      lines.push(`  ${c.detail}`);
    }
    lines.push("");
  }
  if (diff.fieldsGained.length || diff.fieldsLost.length) {
    lines.push("--- REPORTED FIELDS ---");
    if (diff.fieldsGained.length)
      lines.push(`Now reporting: ${diff.fieldsGained.join(", ")}`);
    if (diff.fieldsLost.length)
      lines.push(`No longer reporting: ${diff.fieldsLost.join(", ")}`);
    lines.push("");
  }
  if (diff.profileChanges.length) {
    lines.push("--- DEVICE PROFILE ---");
    for (const p of diff.profileChanges)
      lines.push(
        `${p.key}: ${JSON.stringify(p.from)} -> ${JSON.stringify(p.to)}`,
      );
  }
  return lines.join("\n").trimEnd();
}

// --- Serialization and replay --------------------------------------------
//
// The check engine is a pure function of the observation stream, which means
// a *recorded* stream can be re-run through a newer set of checks. That is
// the whole point of storing observations rather than only the prose
// rendering of them: when a new check lands, every report ever filed becomes
// retroactively analyzable, instead of the check only helping devices probed
// after it shipped.
//
// Concretely: the idle-blanking behaviour was diagnosed by hand-reading hex
// out of a stored report. With this, the same discovery would have been a
// matter of writing the check and replaying the three reports already on
// file.

export interface SerializedProbeReport {
  version: number;
  protocol: ProbeProtocol;
  deviceName: string;
  requestedCardioType: CardioType;
  detectedCardioType: CardioType | null;
  startedAt: number;
  endedAt: number;
  observations: ProbeObservation[];
}

const JSON_SECTION_HEADER =
  "--- MACHINE-READABLE REPORT (JSON, for replay) ---";

export function serializeReport(report: ProbeReport): SerializedProbeReport {
  return {
    version: PROBE_REPORT_VERSION,
    protocol: report.protocol,
    deviceName: report.deviceName,
    requestedCardioType: report.requestedCardioType,
    detectedCardioType: report.detectedCardioType,
    startedAt: report.startedAt,
    endedAt: report.endedAt,
    observations: report.observations,
  };
}

/**
 * Pulls a serialized report back out of the text a probe filed. Returns null
 * for anything it can't use — including version-1 reports, which never
 * carried observations and therefore genuinely cannot be replayed.
 */
export function extractSerializedReport(
  reportText: string,
): SerializedProbeReport | null {
  const at = reportText.indexOf(JSON_SECTION_HEADER);
  if (at < 0) return null;
  const json = reportText.slice(at + JSON_SECTION_HEADER.length).trim();
  try {
    const parsed = JSON.parse(json) as SerializedProbeReport;
    if (
      typeof parsed?.version !== "number" ||
      !Array.isArray(parsed.observations)
    )
      return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Re-runs the *current* checks over a previously recorded observation
 * stream. `staleness` reports how the recording's schema compares to this
 * build, so a caller can flag a replay whose observations predate fields the
 * newer checks rely on rather than treating absence as evidence.
 */
export function replayReport(serialized: SerializedProbeReport): {
  report: ProbeReport;
  staleness: "current" | "older-schema" | "newer-schema";
} {
  const report = buildReport(serialized.observations, {
    protocol: serialized.protocol,
    deviceName: serialized.deviceName,
    requestedCardioType: serialized.requestedCardioType,
    detectedCardioType: serialized.detectedCardioType,
    startedAt: serialized.startedAt,
  });
  // buildReport stamps endedAt with "now"; a replay should preserve when the
  // session actually ended, or every duration in the output is nonsense.
  report.endedAt = serialized.endedAt;
  const staleness =
    serialized.version === PROBE_REPORT_VERSION
      ? "current"
      : serialized.version < PROBE_REPORT_VERSION
        ? "older-schema"
        : "newer-schema";
  return { report, staleness };
}

// Human-readable rendering for the support ticket. Conclusions first, raw
// observation timeline last — the inversion of the old "Report a connection
// issue" flow, which shipped 2000 lines of log and left the reader to find
// the anomaly themselves.
export function formatReportText(
  report: ProbeReport,
  opts: { includeTimeline?: boolean } = {},
): string {
  const { includeTimeline = true } = opts;
  const lines: string[] = [];
  const dur = ((report.endedAt - report.startedAt) / 1000).toFixed(0);
  lines.push(`DEVICE PROBE REPORT (v${PROBE_REPORT_VERSION})`);
  lines.push(`${report.deviceName} — ${report.protocol} — ${dur}s`);
  lines.push(
    `Requested as: ${report.requestedCardioType}; detected as: ${report.detectedCardioType ?? "unrecognized"}`,
  );
  lines.push(
    `Result: ${report.summary.fail} failed, ${report.summary.warn} warnings, ${report.summary.pass} passed, ${report.summary.skip} skipped`,
  );
  lines.push("");
  lines.push("--- FINDINGS ---");
  const order: ProbeStatus[] = ["fail", "warn", "pass", "skip"];
  for (const status of order) {
    for (const f of report.findings.filter((x) => x.status === status)) {
      lines.push(`[${status.toUpperCase()}] ${f.title}`);
      lines.push(`  ${f.detail}`);
      if (f.because && (status === "fail" || status === "warn"))
        lines.push(`  Why this check exists: ${f.because}`);
      lines.push("");
    }
  }
  lines.push("--- DEVICE PROFILE (machine-readable) ---");
  lines.push(JSON.stringify(report.profile, null, 2));
  lines.push("");
  const existing = matchDevice(report.protocol, report.deviceName);
  lines.push("--- PROPOSED deviceRegistry.ts ENTRY ---");
  lines.push(
    existing
      ? `NOTE: this device already has a registry entry ("${existing.label}", ${existing.confidence}). Compare before replacing it.`
      : "No existing registry entry for this device. Paste the following into DEVICE_REGISTRY:",
  );
  lines.push(formatRegistryEntrySource(proposeRegistryEntry(report)));
  lines.push("");
  if (!includeTimeline) return lines.join("\n");
  lines.push("--- OBSERVATION TIMELINE ---");
  for (const o of report.observations) {
    const t = new Date(o.at).toLocaleTimeString(getActiveLocale());
    switch (o.kind) {
      case "metrics":
        lines.push(
          `${t}  DATA [${o.rawHex}] flags=${o.flags != null ? "0x" + o.flags.toString(16) : "?"} ${JSON.stringify(o.metrics)}`,
        );
        break;
      case "machineStatus":
        lines.push(
          `${t}  STATUS [${o.rawHex}] op=0x${o.opCode.toString(16)} ${JSON.stringify(o.decoded)}${o.isFirstSinceConnect ? " (first since connect)" : ""}`,
        );
        break;
      case "control":
        lines.push(
          `${t}  CONTROL ${o.label} [${o.requestHex}] -> ${o.resultCode == null ? "no response" : `0x${o.resultCode.toString(16)} ${o.resultMessage ?? ""}`}`,
        );
        break;
      case "read":
        lines.push(
          `${t}  READ ${o.what} ${o.error ? `ERROR: ${o.error}` : `[${o.rawHex ?? ""}] ${JSON.stringify(o.decoded)}`}`,
        );
        break;
      case "discovery":
        lines.push(
          `${t}  DISCOVERY services=[${o.serviceUuids.join(", ")}] data=${o.dataCharacteristicUuid ?? "none"} props=[${o.dataCharacteristicProperties.join(",")}] control=${o.hasControlPoint} status=${o.hasMachineStatus}`,
        );
        break;
      case "ifitFrame":
        lines.push(
          `${t}  FRAME req=0x${o.requestCommand.toString(16)} resp=${o.responseCommand != null ? "0x" + o.responseCommand.toString(16) : "none"} status=${o.responseStatus ?? "n/a"} checksum=${o.checksumValid} bytes=${o.actualPayloadBytes}/${o.expectedPayloadBytes} [${o.responseHex ?? ""}]`,
        );
        break;
      case "userAnswer":
        lines.push(
          `${t}  USER "${o.question}" -> ${o.answer}${o.value != null ? ` (${o.value})` : ""}`,
        );
        break;
      case "note":
        lines.push(`${t}  ${o.message}`);
        break;
    }
  }
  return lines.join("\n");
}

/**
 * The full text a probe files: findings, profile, proposed registry entry,
 * the human timeline, and finally the machine-readable JSON.
 *
 * The JSON goes last and is never dropped. If the whole thing exceeds the
 * caller's budget, the *prose* timeline is what gets sacrificed — it is a
 * rendering of the same observations the JSON carries losslessly, so cutting
 * it costs nothing that cannot be regenerated by replaying.
 */
export function formatReportForFiling(
  report: ProbeReport,
  maxChars = 200000,
): string {
  const json = JSON.stringify(serializeReport(report));
  const jsonSection = `\n\n${JSON_SECTION_HEADER}\n${json}\n`;

  const withTimeline = formatReportText(report) + jsonSection;
  if (withTimeline.length <= maxChars) return withTimeline;

  const withoutTimeline =
    formatReportText(report, { includeTimeline: false }) +
    `\n(Human-readable timeline omitted for length — the JSON below carries every observation losslessly; replay it to regenerate.)\n` +
    jsonSection;
  if (withoutTimeline.length <= maxChars) return withoutTimeline;

  // Even the JSON alone is too big: keep findings and say plainly what was
  // lost, rather than emitting a truncated JSON that cannot be parsed.
  return (
    formatReportText(report, { includeTimeline: false }) +
    `\n(Report too large to file in full: ${withoutTimeline.length} chars against a ${maxChars} limit. ` +
    `${report.observations.length} observations were recorded but could not be attached.)\n`
  );
}
