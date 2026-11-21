import {
  CONCEPT2_DISCOVERY_SERVICE,
  CONCEPT2_ROWING_SERVICE,
} from "./concept2";

const ftms = 0x1826;
const ifit = "00001533-1412-efde-1523-785feabcd123";

/** Service filters are OR'd with known iFIT advertisement names. */
export function fitnessPickerOptions(
  protocol: "FTMS" | "iFIT" = "FTMS",
): RequestDeviceOptions {
  return {
    filters: [
      ...(protocol === "FTMS"
        ? [
            { services: [ftms] },
            { services: [CONCEPT2_DISCOVERY_SERVICE] },
            { services: [CONCEPT2_ROWING_SERVICE] },
            { namePrefix: "PM5" },
          ]
        : []),
      { services: [ifit] },
      ...["NordicTrack", "ProForm", "iFit", "iFIT", "I_"].map((namePrefix) => ({
        namePrefix,
      })),
    ],
    optionalServices: [
      ftms,
      ifit,
      ...(protocol === "FTMS" ? [CONCEPT2_ROWING_SERVICE] : []),
    ],
  };
}
