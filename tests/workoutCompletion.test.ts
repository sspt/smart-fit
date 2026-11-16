import { it, expect, vi } from "vitest";
import { disconnectWorkoutDevices } from "../src/workoutCompletion";
it("disconnects every protocol even if one disconnect fails", async () => {
  const ft = {
    disconnect: vi.fn(() => {
      throw Error("radio unavailable");
    }),
  };
  const it = { disconnect: vi.fn(async () => {}) };
  const report = vi.fn();
  await disconnectWorkoutDevices([ft, it], report);
  expect(ft.disconnect).toHaveBeenCalledOnce();
  expect(it.disconnect).toHaveBeenCalledOnce();
  expect(report).toHaveBeenCalledWith(
    expect.stringContaining("Workout saved."),
  );
});
it("waits for disconnect completion without warning on success", async () => {
  const report = vi.fn(),
    calls: string[] = [];
  await disconnectWorkoutDevices(
    [
      {
        disconnect: async () => {
          await Promise.resolve();
          calls.push("disconnected");
        },
      },
    ],
    report,
  );
  expect(calls).toEqual(["disconnected"]);
  expect(report).not.toHaveBeenCalled();
});
