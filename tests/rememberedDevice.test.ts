import { it, expect, vi } from "vitest";
import {
  parseRememberedDevice,
  grantedRememberedDevice,
  type RememberedDevice,
} from "../src/rememberedDevice";
const known: RememberedDevice = {
  id: "saved-id",
  name: "My treadmill",
  kind: "Treadmill",
  protocol: "FTMS",
};
it("validates saved device records", () => {
  expect(parseRememberedDevice(known)).toEqual(known);
  for (const value of [
    null,
    {},
    { ...known, id: 1 },
    { ...known, kind: "Boat" },
    { ...known, protocol: "Unknown" },
  ])
    expect(parseRememberedDevice(value)).toBeNull();
});
it("selects only the authorised device with the saved ID, never a matching name", async () => {
  const right = { id: "saved-id", name: "Renamed" },
    wrong = { id: "different-id", name: known.name };
  const picker = vi.fn();
  const bt = {
    getDevices: vi.fn().mockResolvedValue([wrong, right]),
    requestDevice: picker,
  } as any;
  expect(await grantedRememberedDevice(known, bt)).toBe(right);
  expect(picker).not.toHaveBeenCalled();
});
it("returns no device when permission is missing or the API is unsupported", async () => {
  expect(await grantedRememberedDevice(known, {} as any)).toBeNull();
  expect(
    await grantedRememberedDevice(known, { getDevices: async () => [] } as any),
  ).toBeNull();
});
it("surfaces enumeration failures without opening a picker", async () => {
  const picker = vi.fn();
  await expect(
    grantedRememberedDevice(known, {
      getDevices: async () => {
        throw Error("Denied");
      },
      requestDevice: picker,
    } as any),
  ).rejects.toThrow("Denied");
  expect(picker).not.toHaveBeenCalled();
});
