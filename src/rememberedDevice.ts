import type { Kind } from "./store";
export type RememberedDevice = {
  id: string;
  name: string;
  kind: Kind;
  protocol: "FTMS" | "iFIT";
};
export function parseRememberedDevice(value: unknown): RememberedDevice | null {
  const v = value as RememberedDevice | null;
  return v &&
    typeof v.id === "string" &&
    !!v.id &&
    typeof v.name === "string" &&
    ["Treadmill", "Bike", "Rower"].includes(v.kind) &&
    ["FTMS", "iFIT"].includes(v.protocol)
    ? v
    : null;
}
export async function grantedRememberedDevice(
  known: RememberedDevice,
  bluetooth = navigator.bluetooth,
): Promise<BluetoothDevice | null> {
  if (!bluetooth?.getDevices) return null;
  const devices = await bluetooth.getDevices();
  return devices.find((d) => d.id === known.id) ?? null;
}
