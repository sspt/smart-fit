// Byte-exact regression tests against a real, checksum-verified capture of
// the official iFit app controlling a NordicTrack RW300 rower (see
// ifitCapture.fixture.ts's own header for provenance). These pin down wire
// behaviour ifit.ts's frame builders must reproduce exactly — the kind of
// test docs/PROTOCOL_AUDIT_PLAN.md's Phase 0 calls for, which would have
// caught the metadata-request-content-length and DeviceInfo-addressing bugs
// on day one instead of needing a full audit to surface them.
import { describe, it, expect } from "vitest";
import { IFIT_PROBE } from "./ifit";
import {
  CAPTURED_DEVICE_INFO,
  CAPTURED_SUPPORTED_DEVICES,
  CAPTURED_SUPPORTED_COMMANDS,
  CAPTURED_SYSTEM_INFO,
  CAPTURED_VERSION_INFO,
  CAPTURED_EQUIPMENT_SERIAL,
} from "./ifitCapture.fixture";

// Rower(0x14) — the address DeviceInfo's own real response taught this
// session (see the fixture file's header), used for SupportedDevices/
// SupportedCommands only.
const ROWER = IFIT_PROBE.equipment.ROWER;
const MAIN = IFIT_PROBE.equipment.MAIN;

describe("buildMetadataRequest reproduces the real RW300 capture byte-for-byte", () => {
  it("DeviceInfo: addressed to Main, zero content bytes", () => {
    expect(
      IFIT_PROBE.buildMetadataRequest(MAIN, IFIT_PROBE.commands.deviceInfo),
    ).toEqual(CAPTURED_DEVICE_INFO);
  });

  it("SupportedDevices: addressed to the learned equipment (Rower), zero content bytes", () => {
    expect(
      IFIT_PROBE.buildMetadataRequest(
        ROWER,
        IFIT_PROBE.commands.supportedCapabilities,
      ),
    ).toEqual(CAPTURED_SUPPORTED_DEVICES);
  });

  it("SupportedCommands: addressed to the learned equipment (Rower), zero content bytes", () => {
    expect(
      IFIT_PROBE.buildMetadataRequest(
        ROWER,
        IFIT_PROBE.commands.supportedCommands,
      ),
    ).toEqual(CAPTURED_SUPPORTED_COMMANDS);
  });

  // The real surprise this fixture caught: SystemInfo/VersionInfo/
  // EQUIPMENT_SERIAL stay addressed to Main even in a session where the real
  // equipment address (Rower) is already known — confirmed by all three
  // captures below, and by SystemInfo's content genuinely being 3 bytes, not
  // the 2 the decompiled SystemInfoCmd source alone would suggest.
  it("SystemInfo: addressed to Main (not the learned equipment), 3 content bytes", () => {
    expect(
      IFIT_PROBE.buildMetadataRequest(MAIN, IFIT_PROBE.commands.systemInfo),
    ).toEqual(CAPTURED_SYSTEM_INFO);
  });

  it("VersionInfo: addressed to Main, 2 content bytes", () => {
    expect(
      IFIT_PROBE.buildMetadataRequest(MAIN, IFIT_PROBE.commands.versionInfo),
    ).toEqual(CAPTURED_VERSION_INFO);
  });

  it("EQUIPMENT_SERIAL: addressed to Main, zero content bytes", () => {
    expect(
      IFIT_PROBE.buildMetadataRequest(
        MAIN,
        IFIT_PROBE.commands.equipmentSerial,
      ),
    ).toEqual(CAPTURED_EQUIPMENT_SERIAL);
  });
});

describe("the captured frames are internally consistent", () => {
  // Reassembles each capture's data packets the same way the live
  // notification handler does, then verifies the checksum — direction
  // (request vs. response) doesn't matter to the formula, so this doubles as
  // a check that feedNotifyPacket/verifyFrameChecksum agree on real bytes,
  // not just synthetic ones built by this file's own buildFrame.
  const reassemble = (packets: number[][]): number[] => {
    let chunks: number[][] = [];
    let frame: number[] | null = null;
    for (const p of packets) {
      const fed = IFIT_PROBE.feedNotifyPacket(chunks, p);
      chunks = fed.chunks;
      if (fed.frame) frame = fed.frame;
    }
    if (!frame)
      throw new Error("capture did not terminate with an 0xFF packet");
    return frame;
  };

  it.each([
    ["DeviceInfo", CAPTURED_DEVICE_INFO],
    ["SupportedDevices", CAPTURED_SUPPORTED_DEVICES],
    ["SupportedCommands", CAPTURED_SUPPORTED_COMMANDS],
    ["SystemInfo", CAPTURED_SYSTEM_INFO],
    ["VersionInfo", CAPTURED_VERSION_INFO],
    ["EQUIPMENT_SERIAL", CAPTURED_EQUIPMENT_SERIAL],
  ])("%s passes checksum verification", (_label, packets) => {
    expect(IFIT_PROBE.verifyFrameChecksum(reassemble(packets))).toBe(true);
  });

  it("DeviceInfo request is addressed to Main and carries the DeviceInfo command byte", () => {
    const frame = reassemble(CAPTURED_DEVICE_INFO);
    expect(frame[4]).toBe(MAIN);
    expect(IFIT_PROBE.frameCommandByte(frame)).toBe(
      IFIT_PROBE.commands.deviceInfo,
    );
  });

  it("SupportedDevices/SupportedCommands requests are addressed to the learned Rower address", () => {
    expect(reassemble(CAPTURED_SUPPORTED_DEVICES)[4]).toBe(ROWER);
    expect(reassemble(CAPTURED_SUPPORTED_COMMANDS)[4]).toBe(ROWER);
  });

  it("SystemInfo/VersionInfo/EQUIPMENT_SERIAL requests are addressed to Main", () => {
    expect(reassemble(CAPTURED_SYSTEM_INFO)[4]).toBe(MAIN);
    expect(reassemble(CAPTURED_VERSION_INFO)[4]).toBe(MAIN);
    expect(reassemble(CAPTURED_EQUIPMENT_SERIAL)[4]).toBe(MAIN);
  });
});

describe("CmdStatus (A3)", () => {
  it("reads the status byte at full-frame offset 7", () => {
    const frame = IFIT_PROBE.buildFrame(
      IFIT_PROBE.equipment.TREADMILL,
      IFIT_PROBE.commands.systemInfo,
      [0, 0, 0],
    );
    // buildFrame produces a *request* frame, which has no status byte — this
    // just pins the offset frameStatus reads from, matching the response
    // shape [device,length,cmd,status,...content,checksum].
    const response = [...frame];
    response[7] = IFIT_PROBE.cmdStatus.DONE;
    expect(IFIT_PROBE.frameStatus(response)).toBe(IFIT_PROBE.cmdStatus.DONE);
  });

  it("returns null for a frame too short to carry a status byte", () => {
    expect(IFIT_PROBE.frameStatus([0x02, 0x04, 0x02, 0x04, 0x02])).toBeNull();
  });
});

describe("verifyFrameChecksum bounds on the declared length, not array length (A5)", () => {
  it("still validates a frame with trailing bytes past the declared length", () => {
    const frame = IFIT_PROBE.buildFrame(
      IFIT_PROBE.equipment.ROWER,
      IFIT_PROBE.commands.deviceInfo,
      [],
    );
    const withTrailingJunk = [...frame, 0xaa, 0xbb];
    expect(IFIT_PROBE.verifyFrameChecksum(withTrailingJunk)).toBe(true);
  });

  it("still rejects a genuinely corrupted frame even with trailing bytes", () => {
    const frame = IFIT_PROBE.buildFrame(
      IFIT_PROBE.equipment.ROWER,
      IFIT_PROBE.commands.writeAndRead,
      [0x01, 0x02, 0x03],
    );
    const corrupted = [...frame, 0xaa];
    corrupted[8] = (corrupted[8] + 1) & 0xff;
    expect(IFIT_PROBE.verifyFrameChecksum(corrupted)).toBe(false);
  });
});

describe("encodeValue truncates toward zero, matching the real C# int cast (A8)", () => {
  it("encodes a fractional speed by truncation, not rounding", () => {
    // 12.347 km/h * 100 = 1234.7 -> truncates to 1234, not rounds to 1235.
    const packets = IFIT_PROBE.buildControlRequest(
      IFIT_PROBE.equipment.TREADMILL,
      { 0: 12.347 },
      [],
    );
    const frame = packets.slice(1).flatMap((p) => p.slice(2, 2 + p[1]));
    // Full frame layout: [sig(3), outerLen, device, innerLen, cmd,
    // writeBitmapLen, writeBitmapByte, value0, value1, readBitmapLen, checksum]
    const valueLo = frame[9];
    const valueHi = frame[10];
    expect(valueLo | (valueHi << 8)).toBe(1234);
  });
});

describe("decodeSerialResponse rejects the null-sentinel payload (A14)", () => {
  // Layout: byte 8 = length, byte 9.. = the string itself.
  it("returns null for an all-zero payload", () => {
    const frame = [0, 0, 0, 0, 0, 0, 0, 0, 4, 0, 0, 0, 0];
    expect(IFIT_PROBE.decodeSerialResponse(frame)).toBeNull();
  });

  it("returns null for an all-0xFF payload", () => {
    const frame = [0, 0, 0, 0, 0, 0, 0, 0, 4, 0xff, 0xff, 0xff, 0xff];
    expect(IFIT_PROBE.decodeSerialResponse(frame)).toBeNull();
  });

  it("still decodes a real serial string", () => {
    const str = "AB12";
    const bytes = Array.from(str).map((c) => c.charCodeAt(0));
    const frame = [0, 0, 0, 0, 0, 0, 0, 0, bytes.length, ...bytes];
    expect(IFIT_PROBE.decodeSerialResponse(frame)).toBe(str);
  });
});

describe("splitReadIdsIntoBatches (A6)", () => {
  it("keeps a small request in one batch", () => {
    expect(
      IFIT_PROBE.splitReadIdsIntoBatches([
        4, 20, 10, 21, 2, 3, 5, 83, 109, 110, 111, 12,
      ]),
    ).toHaveLength(1);
  });

  it("splits a request that would exceed the real 58-byte packet budget", () => {
    // Every 45-byte string field (FirstName=38, LastName=39, UserName=40)
    // together comfortably exceeds any single request's budget.
    const batches = IFIT_PROBE.splitReadIdsIntoBatches([38, 39, 40]);
    expect(batches.length).toBeGreaterThan(1);
    // Every id appears exactly once, across all batches.
    expect(batches.flat().sort((a, b) => a - b)).toEqual([38, 39, 40]);
  });
});

describe("decodeResponseDeviceAddress / decodeDeviceInfoSoftwareVersion (A2/A12)", () => {
  it("reads the device address from full-frame offset 4", () => {
    const frame = IFIT_PROBE.buildFrame(
      IFIT_PROBE.equipment.ROWER,
      IFIT_PROBE.commands.deviceInfo,
      [],
    );
    expect(IFIT_PROBE.decodeResponseDeviceAddress(frame)).toBe(
      IFIT_PROBE.equipment.ROWER,
    );
  });

  it("reads software version from DeviceInfo content offset 0 (full-frame offset 8)", () => {
    const frame = [0, 0, 0, 0, 0, 0, 0, 0, 76, 1, 2, 3, 4, 5]; // softwareVersion=76 at index 8
    expect(IFIT_PROBE.decodeDeviceInfoSoftwareVersion(frame)).toBe(76);
  });
});
