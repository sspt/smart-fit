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

/** Manual bike resistance and programme power are distinct capabilities. */
export function manualControlAvailable(
  kind: Kind,
  controllable: boolean,
  ifit: boolean,
  features: { speed?: boolean; power?: boolean; resistance?: boolean } | null,
  ifitFields?: { resistance?: boolean },
) {
  if (!controllable) return false;
  if (kind !== "Bike")
    return (
      ifit ||
      !features ||
      features[kind === "Treadmill" ? "speed" : "resistance"] === true
    );
  return ifit
    ? ifitFields?.resistance === true
    : !features || features.power === true || features.resistance === true;
}
