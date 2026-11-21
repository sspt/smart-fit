import type { FtmsMetrics } from "./ble";

const pm5Uuid = (id: string) => `ce0600${id}-43e5-11e4-916c-0800200c9a66`;

export const CONCEPT2_DISCOVERY_SERVICE = pm5Uuid("00");
export const CONCEPT2_ROWING_SERVICE = pm5Uuid("30");
export const CONCEPT2_GENERAL_STATUS = pm5Uuid("31");
export const CONCEPT2_ADDITIONAL_STATUS = pm5Uuid("32");

function uint24(view: DataView, offset: number) {
  return view.getUint16(offset, true) + view.getUint8(offset + 2) * 65536;
}

// PM5 Bluetooth Smart Interface Definition, General Status and
// Additional Status 1. The direct characteristics have no multiplex header.
export function parseConcept2Status(
  uuid: string,
  value: DataView,
): Partial<FtmsMetrics> | null {
  if (uuid === CONCEPT2_GENERAL_STATUS && value.byteLength >= 19) {
    return {
      elapsedTimeSec: uint24(value, 0) / 100,
      totalDistanceM: uint24(value, 3) / 10,
    };
  }
  if (uuid === CONCEPT2_ADDITIONAL_STATUS && value.byteLength >= 16) {
    const heartRate = value.getUint8(6);
    return {
      speedKmh: (value.getUint16(3, true) / 1000) * 3.6,
      cadenceRpm: value.getUint8(5),
      heartRateBpm: heartRate > 0 && heartRate < 255 ? heartRate : null,
    };
  }
  return null;
}
