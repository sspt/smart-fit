// Passive mode for the conformance engine.
//
// The active probe (screens/DeviceProbe.tsx) needs a user to walk through a
// scripted session. That is the right tool for a device nobody here owns, but
// it only ever runs when someone deliberately runs it — meanwhile every
// ordinary workout is generating exactly the same observation stream and
// throwing it away.
//
// This module records that stream during normal use so "Report a connection
// issue" can ship *conclusions* rather than 2000 lines of prose log. The
// checks are unchanged: deviceProbe.ts's runChecks is a pure function of the
// observations, and knows nothing about where they came from.
//
// Design constraints that matter here and not in the active probe:
//
//   - It runs for the whole workout, not 90 seconds, so the buffer is capped
//     and drops the *middle* rather than either end. The start explains how
//     the connection was established and the end is whatever the user was
//     looking at when they hit report; the middle of a steady session is the
//     least informative part.
//   - It must cost nothing when nothing is wrong. Recording is a push onto an
//     array; no checks run until a report is actually requested.
//   - Stage-boundary notes don't exist here (nobody told the user to stand
//     still), so checks that key off those simply skip — which is correct,
//     not a gap.
import {
  buildReport,
  formatReportForFiling,
  probeMetricsFromFtms,
  probeMetricsFromIfit,
  type ProbeObservation,
  type ProbeProtocol,
  type ProbeReport,
} from "./deviceProbe";
import type { CardioType } from "./types";
import type { FtmsMetrics } from "./ble";
import type { IfitMetrics } from "./ifit";

// A long workout at ~2 notifications/second would be ~14k observations an
// hour. This keeps the memory cost bounded and the filed report parseable.
const MAX_OBSERVATIONS = 4000;
// Metrics are recorded at most this often. The live connection notifies far
// faster than any check needs; every check here reasons over seconds, so
// sampling down keeps the buffer meaningful for much longer without changing
// a single verdict.
const METRICS_SAMPLE_INTERVAL_MS = 1000;

interface PassiveSession {
  protocol: ProbeProtocol;
  deviceName: string;
  requestedCardioType: CardioType;
  detectedCardioType: CardioType | null;
  startedAt: number;
  observations: ProbeObservation[];
  lastMetricsAt: number;
  droppedFromMiddle: number;
}

let session: PassiveSession | null = null;

/** Starts (or restarts) passive recording. Called when a device connects. */
export function beginPassiveSession(
  protocol: ProbeProtocol,
  deviceName: string,
  requestedCardioType: CardioType,
  detectedCardioType: CardioType | null,
): void {
  session = {
    protocol,
    deviceName,
    requestedCardioType,
    detectedCardioType,
    startedAt: Date.now(),
    observations: [],
    lastMetricsAt: 0,
    droppedFromMiddle: 0,
  };
  record({
    kind: "note",
    at: Date.now(),
    message: `Passive recording started for "${deviceName}" (${protocol}, connected as ${requestedCardioType}${detectedCardioType && detectedCardioType !== requestedCardioType ? `, detected as ${detectedCardioType}` : ""}).`,
  });
}

export function endPassiveSession(): void {
  session = null;
}

export function isPassiveSessionActive(): boolean {
  return session !== null;
}

function record(o: ProbeObservation): void {
  if (!session) return;
  session.observations.push(o);
  if (session.observations.length > MAX_OBSERVATIONS) {
    // Drop from the middle: keep the first quarter (how the connection was
    // set up, capability reads, early behaviour) and the most recent
    // three-quarters (whatever the user is actually reporting about).
    const keepHead = Math.floor(MAX_OBSERVATIONS / 4);
    const keepTail = MAX_OBSERVATIONS - keepHead;
    const removed = session.observations.length - MAX_OBSERVATIONS;
    session.observations = [
      ...session.observations.slice(0, keepHead),
      ...session.observations.slice(session.observations.length - keepTail),
    ];
    session.droppedFromMiddle += removed;
  }
}

/** Live metrics from an FTMS connection, sampled down. */
export function recordFtmsMetrics(
  m: FtmsMetrics,
  running: boolean | null,
  rawHex: string,
  flags: number | null,
): void {
  if (!session) return;
  const now = Date.now();
  if (now - session.lastMetricsAt < METRICS_SAMPLE_INTERVAL_MS) return;
  session.lastMetricsAt = now;
  record({
    kind: "metrics",
    at: now,
    rawHex,
    flags,
    metrics: probeMetricsFromFtms(m, running),
  });
}

/** Live metrics from an iFit connection, sampled down. */
export function recordIfitMetrics(m: IfitMetrics, rawHex: string): void {
  if (!session) return;
  const now = Date.now();
  if (now - session.lastMetricsAt < METRICS_SAMPLE_INTERVAL_MS) return;
  session.lastMetricsAt = now;
  record({
    kind: "metrics",
    at: now,
    rawHex,
    flags: null,
    metrics: probeMetricsFromIfit(m),
  });
}

/**
 * Everything else is recorded in full — these are all rare compared to the
 * metrics stream, and each one is exactly the kind of event a check keys off.
 */
export function recordPassiveObservation(o: ProbeObservation): void {
  record(o);
}

export function recordPassiveNote(message: string): void {
  record({ kind: "note", at: Date.now(), message });
}

/**
 * Builds a report from whatever has been recorded so far. Returns null when
 * nothing has been captured, so callers can fall back to the plain
 * connection log rather than filing an empty conformance report.
 */
export function buildPassiveReport(): ProbeReport | null {
  if (!session || session.observations.length === 0) return null;
  if (session.droppedFromMiddle > 0) {
    record({
      kind: "note",
      at: Date.now(),
      message: `Note: ${session.droppedFromMiddle} observations were dropped from the middle of this session to bound the buffer. The connection setup and the most recent activity are both intact.`,
    });
  }
  return buildReport(session.observations, {
    protocol: session.protocol,
    deviceName: session.deviceName,
    requestedCardioType: session.requestedCardioType,
    detectedCardioType: session.detectedCardioType,
    startedAt: session.startedAt,
  });
}

/**
 * The filed text for a passive report, or null when there is nothing to file.
 * Leads with a short explanation of what this is, because a reader who is
 * used to the active probe's reports needs to know the stages were never run
 * — several checks legitimately skip for that reason alone.
 */
export function formatPassiveReport(maxChars = 200000): string | null {
  const report = buildPassiveReport();
  if (!report) return null;
  const header =
    "PASSIVE CONFORMANCE REPORT\n" +
    "Recorded during an ordinary workout rather than a guided probe run, so\n" +
    "no baseline/movement/console stages exist and checks that depend on them\n" +
    'report "N/A" rather than a verdict. Run /device-probe for the full set.\n\n';
  return header + formatReportForFiling(report, maxChars - header.length);
}
