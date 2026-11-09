export function needsIPhoneLanding(
  device: {
    userAgent: string;
    platform: string;
    maxTouchPoints: number;
    bluetooth?: { requestDevice?: unknown };
  } = navigator,
) {
  const ios =
    /iPhone|iPad|iPod/i.test(device.userAgent) ||
    (device.platform === "MacIntel" && device.maxTouchPoints > 1);
  return ios && typeof device.bluetooth?.requestDevice !== "function";
}
