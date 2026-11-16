// Disconnect only after stop confirmation and durable local saving have succeeded.
export async function disconnectWorkoutDevices(
  devices: { disconnect: () => unknown }[],
  report: (message: string) => void,
) {
  let failed = false;
  for (const device of devices) {
    try {
      await device.disconnect();
    } catch {
      failed = true;
    }
  }
  if (failed)
    report(
      "Workout saved. Could not disconnect equipment; disconnect it manually.",
    );
}
