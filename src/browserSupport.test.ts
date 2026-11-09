import { it, expect } from "vitest";
import { needsIPhoneLanding } from "./browserSupport";
it.each([
  ["iPhone", "iPhone", 1, false, true],
  ["iPad", "iPad", 5, false, true],
  ["Macintosh", "MacIntel", 5, false, true],
  ["iPhone", "iPhone", 1, true, false],
  ["Android", "Linux", 5, true, false],
  ["Macintosh", "MacIntel", 0, false, false],
])(
  "detects browser support for %s/%s",
  (userAgent, platform, maxTouchPoints, available, expected) => {
    expect(
      needsIPhoneLanding({
        userAgent: String(userAgent),
        platform: String(platform),
        maxTouchPoints: Number(maxTouchPoints),
        bluetooth: available ? { requestDevice: () => {} } : undefined,
      }),
    ).toBe(expected);
  },
);
