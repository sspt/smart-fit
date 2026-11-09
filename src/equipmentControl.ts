import type { Kind } from "./store";

/** The protocol's control handshake and supported targets determine availability. */
export function equipmentControlAvailable(
  kind: Kind,
  controllable: boolean,
  ifit: boolean,
  features: { speed: boolean; power: boolean; resistance: boolean } | null,
) {
  if (!controllable) return false;
  if (ifit) return kind !== "Bike";
  if (!features) return true;
  return kind === "Treadmill"
    ? features.speed
    : kind === "Bike"
      ? features.power
      : features.resistance;
}
