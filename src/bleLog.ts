// Lightweight, always-on connection-event log shared by ble.ts (FTMS) and
// ifit.ts — captures connection-lifecycle milestones (attempts, GATT/service
// steps, errors, disconnects, reconnects) as plain text, not full data-plane
// byte traffic. A module-level singleton (not React state) so both hooks can
// log to it without needing to be wired together via props/context, and so
// it survives across whatever re-renders happen during a connection attempt.
//
// Powers the "Report Connection Issue" button in Session.tsx's
// BluetoothPanel: by the time something visibly goes wrong, the events
// leading up to it are already captured, not just the final error string.
import { getActiveLocale } from "./i18n";

const MAX_ENTRIES = 2000;

interface BleLogEntry {
  ts: number;
  message: string;
}

let entries: BleLogEntry[] = [];

export function logBleEvent(message: string): void {
  entries.push({ ts: Date.now(), message });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
}

export function getBleLogText(): string {
  if (entries.length === 0)
    return "(no connection events captured this session)";
  return entries
    .map(
      (e) =>
        `${new Date(e.ts).toLocaleTimeString(getActiveLocale())}  ${e.message}`,
    )
    .join("\n");
}

export function clearBleLog(): void {
  entries = [];
}
