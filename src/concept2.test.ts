import { expect, it } from "vitest";
import { fitnessPickerOptions } from "./bluetoothPicker";
import {
  CONCEPT2_ADDITIONAL_STATUS,
  CONCEPT2_GENERAL_STATUS,
  CONCEPT2_ROWING_SERVICE,
  parseConcept2Status,
} from "./concept2";

it("offers PM5 monitors through the standard equipment picker", () => {
  const options = fitnessPickerOptions();
  expect(options.filters).toContainEqual({ namePrefix: "PM5" });
  expect(options.optionalServices).toContain(CONCEPT2_ROWING_SERVICE);
});

it("reads elapsed time and distance from PM5 general status", () => {
  const frame = new DataView(new ArrayBuffer(19));
  frame.setUint16(0, 9050, true);
  frame.setUint16(3, 341, true);
  frame.setUint8(5, 1);
  expect(parseConcept2Status(CONCEPT2_GENERAL_STATUS, frame)).toEqual({
    elapsedTimeSec: 90.5,
    totalDistanceM: 6587.7,
  });
});

it("reads PM5 stroke rate and speed and omits unavailable heart rate", () => {
  const frame = new DataView(new ArrayBuffer(16));
  frame.setUint16(3, 2500, true);
  frame.setUint8(5, 28);
  frame.setUint8(6, 255);
  expect(parseConcept2Status(CONCEPT2_ADDITIONAL_STATUS, frame)).toEqual({
    speedKmh: 9,
    cadenceRpm: 28,
    heartRateBpm: null,
  });
  expect(
    parseConcept2Status(
      CONCEPT2_ADDITIONAL_STATUS,
      new DataView(new ArrayBuffer(5)),
    ),
  ).toBeNull();
});
