const ftms = 0x1826;
const ifit = "00001533-1412-efde-1523-785feabcd123";

/** Service filters are OR'd with known iFIT advertisement names. */
export function fitnessPickerOptions(
  protocol: "FTMS" | "iFIT" = "FTMS",
): RequestDeviceOptions {
  return {
    filters: [
      ...(protocol === "FTMS" ? [{ services: [ftms] }] : []),
      { services: [ifit] },
      ...["NordicTrack", "ProForm", "iFit", "iFIT", "I_"].map((namePrefix) => ({
        namePrefix,
      })),
    ],
    optionalServices: [ftms, ifit],
  };
}
