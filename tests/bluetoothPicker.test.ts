import { expect, it } from "vitest";
import { fitnessPickerOptions } from "../src/bluetoothPicker";

it("restricts the default picker to FTMS and iFIT advertisements", () => {
  const options = fitnessPickerOptions();
  expect(options.acceptAllDevices).not.toBe(true);
  expect(options.filters).toContainEqual({ services: [0x1826] });
  expect(options.filters).toContainEqual({
    services: ["00001533-1412-efde-1523-785feabcd123"],
  });
  expect(options.filters).toContainEqual({ namePrefix: "I_" });
  expect(options.filters).toContainEqual({ namePrefix: "NordicTrack" });
  expect(
    options.filters!.every(
      (filter) => filter.services?.length || filter.namePrefix,
    ),
  ).toBe(true);
});

it("keeps the direct iFIT picker filtered and permits both GATT services for fallback", () => {
  const options = fitnessPickerOptions("iFIT");
  expect(options.acceptAllDevices).not.toBe(true);
  expect(options.filters).not.toContainEqual({ services: [0x1826] });
  expect(options.filters).toContainEqual({ namePrefix: "ProForm" });
  expect(options.optionalServices).toEqual([
    0x1826,
    "00001533-1412-efde-1523-785feabcd123",
  ]);
});
