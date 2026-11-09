// Real, checksum-verified request bytes captured from the official iFit app
// controlling a real NordicTrack RW300 rower. Originally embedded (as
// INIT_QUERIES/INIT_SETUP_WRITES) in a manual, expert, dev-only debugging
// screen that has since been retired for keeping its own drifted copy of the
// iFit protocol (see IFIT_PROTOCOL.md's "2026-07-27 Audit" section and
// docs/PROTOCOL_AUDIT_PLAN.md's Phase 0/C6) — this capture was its one
// irreplaceable asset, so it survives here as byte-exact regression
// fixtures instead. A test asserting ifit.ts's frame builders reproduce
// these bytes exactly would have caught, on the day they were written, both
// the wrong metadata-request content length (a fixed [0,0] payload sent to
// commands that take none) and the wrong addressing (DeviceInfo not
// addressed to Main) bugs this audit fixed.
//
// Each entry is one command's full packet sequence — a 4-byte [0xFE, 0x02,
// totalFrameLength, packetCount] header, then one or more 20-byte data
// packets ([marker, length, ...payload, ...zero padding]). Decoding these
// (see ifit.test.ts) recovered a real subtlety not visible from the
// decompiled source alone: SystemInfo/VersionInfo/EQUIPMENT_SERIAL are
// addressed to Main (0x02) even after the console's real equipment address
// (Rower, 0x14) has already been learned from DeviceInfo's own response —
// only SupportedDevices/SupportedCommands (and, elsewhere in this same real
// session, ReadWriteData/ENABLE) use that learned address.
export const CAPTURED_DEVICE_INFO: number[][] = [
  [0xfe, 0x02, 0x08, 0x02],
  [
    0xff, 0x08, 0x02, 0x04, 0x02, 0x04, 0x02, 0x04, 0x81, 0x87, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ],
];
export const CAPTURED_SUPPORTED_DEVICES: number[][] = [
  [0xfe, 0x02, 0x08, 0x02],
  [
    0xff, 0x08, 0x02, 0x04, 0x02, 0x04, 0x14, 0x04, 0x80, 0x98, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ],
];
export const CAPTURED_SUPPORTED_COMMANDS: number[][] = [
  [0xfe, 0x02, 0x08, 0x02],
  [
    0xff, 0x08, 0x02, 0x04, 0x02, 0x04, 0x14, 0x04, 0x88, 0xa0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ],
];
export const CAPTURED_SYSTEM_INFO: number[][] = [
  [0xfe, 0x02, 0x0b, 0x02],
  [
    0xff, 0x0b, 0x02, 0x04, 0x02, 0x07, 0x02, 0x07, 0x82, 0, 0, 0, 0x8b, 0, 0,
    0, 0, 0, 0, 0,
  ],
];
export const CAPTURED_VERSION_INFO: number[][] = [
  [0xfe, 0x02, 0x0a, 0x02],
  [
    0xff, 0x0a, 0x02, 0x04, 0x02, 0x06, 0x02, 0x06, 0x84, 0, 0, 0x8c, 0, 0, 0,
    0, 0, 0, 0, 0,
  ],
];
export const CAPTURED_EQUIPMENT_SERIAL: number[][] = [
  [0xfe, 0x02, 0x08, 0x02],
  [
    0xff, 0x08, 0x02, 0x04, 0x02, 0x04, 0x02, 0x04, 0x95, 0x9b, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0,
  ],
];
