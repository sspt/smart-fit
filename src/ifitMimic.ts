// A software-only stand-in for a real iFit FitPro1 console — built to
// reproduce, without hardware, the "first start shows a stale countdown" bug
// class documented in IFIT_PROTOCOL.md and ifit.ts (see resetToIdle's
// comment). That bug was previously fixed once for the ENABLE-handshake race
// (controlReadyRef), but a second report described the same symptom on a
// different iFit rower — a real unit, but one nobody on this project has
// physical access to. This mimic exists so that gap doesn't stop the
// investigation: it speaks the *real* wire protocol (via ifit.ts's own
// exported IFIT_PROBE surface — same framing, checksum, bitmap and
// encode/decode code the probe and the live connection use, never a second
// copy) closely enough that DeviceProbe.tsx's real connectIfit()/control-test
// code paths can run against it unmodified, with the picker step swapped for
// this in-memory device.
//
// What it deliberately does NOT try to reproduce: rowing metrics, resistance
// feel, distance/calorie accumulation — none of that is what the reported bug
// is about. What it DOES model, as the actual reproduction target: a console
// that answers a WorkoutMode write immediately (protocol-level ack, matching
// this protocol's real "no per-command ack beyond Done/SecurityBlock"
// behaviour) while its own *physical* mode takes a moment to actually change
// — and only honours a Running/Resume write as genuine if the physical mode
// has already settled into Idle/Pause by the time that write arrives. Two
// writes fired back-to-back (resetToIdle().then(startDevice())) land well
// inside that settle window on a real console, which is exactly the
// mechanism the "stop, then start again" workaround in the field reports
// happens to route around — a manual retry gives the physical transition
// time to finish first.
import {
  IFIT_PROBE,
  WORKOUT_MODE,
  CHAR_ID_WORKOUT_MODE,
  CHAR_ID_KPH,
} from "./ifit";

// How long a MimicDevice takes to reply to a request, and how long a written
// WorkoutMode takes to become the console's *physical* mode. Both are
// configurable so the same mimic can reproduce the race (short round trip,
// slow settle — the real-world shape) or rule it out (settle faster than any
// realistic back-to-back write pair) as a way of confirming the fix actually
// depends on waiting, not on some other side effect of the extra read.
export interface IfitMimicQuirks {
  /** ms before a request gets its response. Default 25 — a local round trip should look nothing like real BLE latency, or this stops being a useful timing testbed. */
  responseLatencyMs?: number;
  /** ms between a WorkoutMode write being ack'd and the console's physical mode actually changing. Default 400 — long enough that two sequential exchanges at the default responseLatencyMs land inside it, matching the field reports' timing. */
  modeSettleMs?: number;
  /** The mode the console is already in when a client connects — the "stale countdown" itself. Defaults to WARM_UP, matching ifit.ts's own comment ("observed: a ~5 minute warm-up countdown"). */
  startupMode?: number;
  /** Seconds the autonomous warm-up countdown (see simulateMovementStart) runs for. Default 300 (5 minutes) — a real production probe report against an I_RW unit (2026-07-31) read WarmupTime/WarmupTimeout as exactly 300 at connect. */
  warmupSeconds?: number;
  /** Advertised BLE name. */
  name?: string;
}

const RESISTANCE_ID = 2;
const CURRENT_TIME_ID = 20;
const ACTIVATION_LOCK_ID = 100;
const MAX_RESISTANCE_LEVEL_ID = 42;
const ACTUAL_RESISTANCE_ID = 18;
const WARMUP_TIME_ID = 45;
const WARMUP_TIMEOUT_ID = 46;

// The BitFields this mimic answers for — the Rower monitor set
// (READ_IDS_BY_CARDIO_TYPE.Rower) plus the control/identity fields the ENABLE
// handshake and control test touch. Anything outside this set reads back as
// zero rather than erroring, same as a real device simply not reporting a
// field it doesn't implement — decodeReadValues already treats an id outside
// what DeviceInfo declared as filtered out before it ever reaches here.
const SUPPORTED_IDS = [
  CHAR_ID_KPH,
  RESISTANCE_ID,
  3,
  4,
  5,
  10,
  12,
  18,
  20,
  21,
  42,
  WARMUP_TIME_ID,
  WARMUP_TIMEOUT_ID,
  83,
  96,
  100,
  109,
  110,
  111,
];

function modeLabel(mode: number): string {
  const entry = Object.entries(WORKOUT_MODE).find(([, v]) => v === mode);
  return entry ? entry[0] : `UNKNOWN(${mode})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function u32le(v: number): number[] {
  const x = v >>> 0;
  return [x & 0xff, (x >> 8) & 0xff, (x >> 16) & 0xff, (x >>> 24) & 0xff];
}
function u16le(v: number): number[] {
  const x = Math.max(0, Math.min(0xffff, Math.round(v))) & 0xffff;
  return [x & 0xff, (x >> 8) & 0xff];
}

// Encodes a single characteristic's current value for a WRITE_AND_READ
// response, sized/typed the same way decodeReadValues expects to read it
// back — a mismatch here would desync every field requested after it, the
// exact class of bug this module exists to help catch, not add another of.
function encodeCharValue(id: number, value: number): number[] {
  const def = IFIT_PROBE.charById.get(id);
  if (!def) return [];
  switch (def.type) {
    case "uint8":
    case "bool":
    case "pulse":
      return [Math.max(0, Math.min(0xff, Math.round(value)))];
    case "uint16":
    case "raw16":
    case "burnRate":
      return u16le(value);
    case "double":
    case "grade":
      return u16le(value * 100);
    case "uint32":
      return u32le(value);
    case "scaled32":
      return u32le(Math.round((value * 100000000) / 1024));
    case "verticalMeter":
      return u32le(Math.round(value * 10000));
    default:
      return new Array(def.size).fill(0);
  }
}

// Parses a bitmap of the shape IFIT_PROBE.buildBitmap produces: [numBytes,
// ...sectionBytes], bit n of section i = id (i*8+n). Returns the ids and how
// many payload bytes the bitmap itself consumed.
function readBitmap(
  payload: number[],
  offset: number,
): { ids: number[]; consumed: number } {
  const numBytes = payload[offset] ?? 0;
  if (numBytes === 0) return { ids: [], consumed: 1 };
  const ids: number[] = [];
  for (let section = 0; section < numBytes; section++) {
    const byte = payload[offset + 1 + section] ?? 0;
    for (let bit = 0; bit < 8; bit++)
      if (byte & (1 << bit)) ids.push(section * 8 + bit);
  }
  return { ids, consumed: 1 + numBytes };
}

class MimicCharacteristic
  extends EventTarget
  implements BluetoothRemoteGATTCharacteristic
{
  readonly uuid: string;
  readonly properties: BluetoothCharacteristicProperties = {
    read: false,
    write: true,
    writeWithoutResponse: false,
    notify: true,
    indicate: false,
    broadcast: false,
    authenticatedSignedWrites: false,
  };
  value: DataView | undefined;
  private onWrite: ((bytes: number[]) => void) | null = null;

  constructor(uuid: string, onWrite?: (bytes: number[]) => void) {
    super();
    this.uuid = uuid;
    this.onWrite = onWrite ?? null;
  }

  async readValue(): Promise<DataView> {
    return this.value ?? new DataView(new ArrayBuffer(0));
  }
  async writeValue(data: BufferSource): Promise<void> {
    const bytes =
      data instanceof Uint8Array
        ? Array.from(data)
        : Array.from(new Uint8Array(data as ArrayBuffer));
    this.onWrite?.(bytes);
  }
  async startNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    return this;
  }
  async stopNotifications(): Promise<BluetoothRemoteGATTCharacteristic> {
    return this;
  }

  // Delivers one BLE packet as a notification, the same shape a real
  // characteristicvaluechanged event carries (event.target.value).
  emit(packet: number[]) {
    this.value = new DataView(new Uint8Array(packet).buffer);
    this.dispatchEvent(new Event("characteristicvaluechanged"));
  }
}

class MimicService implements BluetoothRemoteGATTService {
  readonly uuid = IFIT_PROBE.serviceUuid;
  constructor(
    private writeChar: MimicCharacteristic,
    private notifyChar: MimicCharacteristic,
  ) {}
  async getCharacteristic(
    characteristic: number | string,
  ): Promise<BluetoothRemoteGATTCharacteristic> {
    if (characteristic === IFIT_PROBE.writeUuid) return this.writeChar;
    if (characteristic === IFIT_PROBE.notifyUuid) return this.notifyChar;
    throw new Error(`MimicService: no such characteristic ${characteristic}`);
  }
  async getCharacteristics(): Promise<BluetoothRemoteGATTCharacteristic[]> {
    return [this.writeChar, this.notifyChar];
  }
}

class MimicServer implements BluetoothRemoteGATTServer {
  connected = false;
  constructor(private service: MimicService) {}
  async connect(): Promise<BluetoothRemoteGATTServer> {
    this.connected = true;
    return this;
  }
  disconnect(): void {
    this.connected = false;
  }
  async getPrimaryService(
    service: number | string,
  ): Promise<BluetoothRemoteGATTService> {
    if (service !== IFIT_PROBE.serviceUuid)
      throw new Error("MimicServer: no such service");
    return this.service;
  }
  async getPrimaryServices(): Promise<BluetoothRemoteGATTService[]> {
    return [this.service];
  }
}

class MimicDevice extends EventTarget implements BluetoothDevice {
  readonly id = "ifit-mimic";
  readonly name: string;
  readonly gatt: BluetoothRemoteGATTServer;
  constructor(gatt: BluetoothRemoteGATTServer, name: string) {
    super();
    this.name = name;
    this.gatt = gatt;
  }
}

/**
 * A live, inspectable handle onto the mimic's internal console state — for
 * the probe UI to show the physical mode live (what "monitor the countdown"
 * means here) without that observation itself being another protocol round
 * trip that could perturb the very timing under test.
 */
export interface IfitMimicHandle {
  device: BluetoothDevice;
  /** The console's current *physical* WorkoutMode — settles after modeSettleMs, independent of what was last written. */
  getMode(): number;
  getModeLabel(): string;
  isUnlocked(): boolean;
  /** Seconds left in the autonomous warm-up countdown, or null when not currently in one. */
  getWarmupRemainingSec(): number | null;
  /**
   * Simulates the console sensing physical movement (a user starting to
   * row) — the trigger for the autonomous WARM_UP-on-movement-while-Idle
   * behaviour (see its own comment above). No protocol round trip: a real
   * console's motion sensor isn't something the BLE layer would tell a
   * client about either, it just shows up as Mode/CurrentTime changing on
   * the next read. A no-op unless the console is currently physically Idle.
   */
  simulateMovementStart(): void;
}

export function createIfitRowerMimic(
  quirks: IfitMimicQuirks = {},
): IfitMimicHandle {
  const responseLatencyMs = quirks.responseLatencyMs ?? 25;
  const modeSettleMs = quirks.modeSettleMs ?? 400;
  const startupMode = quirks.startupMode ?? WORKOUT_MODE.WARM_UP;
  const warmupSeconds = quirks.warmupSeconds ?? 300;
  const name = quirks.name ?? `MIMIC iFit Rower (settle ${modeSettleMs}ms)`;

  let unlocked = false;
  let appliedMode = startupMode;
  let pendingModeTimer: ReturnType<typeof setTimeout> | null = null;
  let resistanceRaw = 0;
  const maxResistanceLevel = IFIT_PROBE.charById.get(MAX_RESISTANCE_LEVEL_ID)
    ? 26
    : 26;

  // A second, real production probe report (I_RW, 2026-07-31) showed a
  // distinct mechanism from the write-settle race above: the console entered
  // WARM_UP the instant it sensed rowing motion while it was still Idle, with
  // no WorkoutMode write from the app anywhere in the log — CurrentTime (20)
  // jumped straight to WarmupTime (300, i.e. 5 minutes, matching this file's
  // own startupMode comment) and counted down for the rest of the session.
  // This is console-native — a motion sensor reacting on its own, not
  // anything the BLE layer told it to do — so it's modelled separately from
  // writeMode's settle-race: no request/response round trip is involved at
  // all, and it only preempts from Idle (an app that has already driven the
  // console to Running before movement starts keeps that state; this only
  // models the console racing physical motion against an app that hasn't
  // issued Start yet).
  let warmupStartedAtMs: number | null = null;

  function currentTimeSec(): number {
    if (appliedMode !== WORKOUT_MODE.WARM_UP || warmupStartedAtMs == null)
      return 0;
    return Math.max(
      0,
      Math.round(warmupSeconds - (Date.now() - warmupStartedAtMs) / 1000),
    );
  }

  // The actual reproduction target: a Running/Resume write is only honoured
  // if the console has already, physically, reached the mode it edges from.
  // A write that arrives mid-settle is ack'd (Done) exactly like a genuine
  // one — this protocol has no way to say "accepted but ignored" — so the
  // only observable difference is that the physical mode never moves.
  function writeMode(newMode: number) {
    const needsIdleEdge = newMode === WORKOUT_MODE.RUNNING;
    const needsPauseEdge = newMode === WORKOUT_MODE.RESUME;
    if (needsIdleEdge && appliedMode !== WORKOUT_MODE.IDLE) return;
    if (needsPauseEdge && appliedMode !== WORKOUT_MODE.PAUSE) return;
    if (pendingModeTimer) clearTimeout(pendingModeTimer);
    pendingModeTimer = setTimeout(() => {
      appliedMode = newMode;
      pendingModeTimer = null;
      if (newMode !== WORKOUT_MODE.WARM_UP) warmupStartedAtMs = null; // an app-driven edge always cancels an in-progress countdown
    }, modeSettleMs);
  }

  function readState(id: number): number {
    switch (id) {
      case CHAR_ID_WORKOUT_MODE:
        return appliedMode;
      case ACTIVATION_LOCK_ID:
        return unlocked ? 0 : 1;
      case MAX_RESISTANCE_LEVEL_ID:
        return maxResistanceLevel;
      case RESISTANCE_ID:
      case ACTUAL_RESISTANCE_ID:
        return resistanceRaw;
      case CURRENT_TIME_ID:
        return currentTimeSec();
      case WARMUP_TIME_ID:
      case WARMUP_TIMEOUT_ID:
        return warmupSeconds;
      default:
        return 0;
    }
  }

  function applyWrite(id: number, value: number) {
    if (id === CHAR_ID_WORKOUT_MODE) {
      writeMode(value);
      return;
    }
    if (id === RESISTANCE_ID) {
      resistanceRaw = value;
      return;
    }
    // Everything else is accepted (this is a mimic, not a full field model)
    // but has no state to actually change.
  }

  // --- Request handling ------------------------------------------------
  // Requests arrive pre-chunked, exactly the way the real console's own
  // write characteristic receives them — feedNotifyPacket is the same
  // reassembly code the live connection and the probe use for the
  // *response* direction, and the framing is symmetric, so reusing it here
  // means this module carries no chunking logic of its own to drift.
  let reqChunks: number[][] = [];

  function respond(
    notifyChar: MimicCharacteristic,
    equipmentAddr: number,
    command: number,
    status: number,
    content: number[],
  ) {
    const frame = IFIT_PROBE.buildFrame(equipmentAddr, command, [
      status,
      ...content,
    ]);
    const packets = IFIT_PROBE.chunkFrame(frame);
    setTimeout(async () => {
      for (const p of packets) {
        notifyChar.emit(p);
        // eslint-disable-next-line no-await-in-loop
        await sleep(0);
      }
    }, responseLatencyMs);
  }

  function handleRequest(notifyChar: MimicCharacteristic, frame: number[]) {
    const equipmentAddr = IFIT_PROBE.equipment.ROWER;
    const command = IFIT_PROBE.frameCommandByte(frame);
    if (command == null) return;
    const length = frame[3] ?? 0;
    const payload = frame.slice(7, 7 + Math.max(0, length - 4));

    if (command === IFIT_PROBE.commands.deviceInfo) {
      const bitmap = IFIT_PROBE.buildBitmap(SUPPORTED_IDS);
      const content = [80, 1, ...u32le(778123456), 0, 0, ...bitmap]; // software=80 (>75, so live path sends ENABLE), hw=1, serial, manufacturer, supported-ids bitmap
      respond(
        notifyChar,
        equipmentAddr,
        command,
        IFIT_PROBE.cmdStatus.DONE,
        content,
      );
      return;
    }
    if (command === IFIT_PROBE.commands.systemInfo) {
      const content = [0, 0, 0, ...u32le(39915), ...u32le(374677)]; // model/partNumber — arbitrary but plausible-looking
      respond(
        notifyChar,
        equipmentAddr,
        command,
        IFIT_PROBE.cmdStatus.DONE,
        content,
      );
      return;
    }
    if (command === IFIT_PROBE.commands.versionInfo) {
      respond(
        notifyChar,
        equipmentAddr,
        command,
        IFIT_PROBE.cmdStatus.DONE,
        [3],
      ); // masterLibraryVersion
      return;
    }
    if (command === IFIT_PROBE.commands.equipmentSerial) {
      const serial = "MIMIC-RW1";
      const bytes = Array.from(serial).map((c) => c.charCodeAt(0));
      respond(notifyChar, equipmentAddr, command, IFIT_PROBE.cmdStatus.DONE, [
        bytes.length,
        ...bytes,
      ]);
      return;
    }
    if (command === IFIT_PROBE.commands.supportedCapabilities) {
      respond(notifyChar, equipmentAddr, command, IFIT_PROBE.cmdStatus.DONE, [
        1,
        equipmentAddr,
      ]);
      return;
    }
    if (command === IFIT_PROBE.commands.supportedCommands) {
      const list = [
        IFIT_PROBE.commands.writeAndRead,
        IFIT_PROBE.commands.enable,
        IFIT_PROBE.commands.deviceInfo,
        IFIT_PROBE.commands.systemInfo,
        IFIT_PROBE.commands.versionInfo,
        IFIT_PROBE.commands.equipmentSerial,
        IFIT_PROBE.commands.supportedCapabilities,
        IFIT_PROBE.commands.supportedCommands,
      ];
      respond(
        notifyChar,
        equipmentAddr,
        command,
        IFIT_PROBE.cmdStatus.DONE,
        list,
      );
      return;
    }
    if (command === IFIT_PROBE.commands.enable) {
      // Real ENABLE validates a computed activation payload; this mimic
      // isn't testing that derivation (already covered elsewhere — see
      // fetchActivationPayload/fetchGenericActivationPayload's own tests) so
      // it unlocks on any payload of the right rough shape, keeping the
      // reproduction focused on the mode-settle race.
      unlocked = payload.length > 0;
      respond(
        notifyChar,
        equipmentAddr,
        command,
        IFIT_PROBE.cmdStatus.DONE,
        [],
      );
      return;
    }
    if (command === IFIT_PROBE.commands.writeAndRead) {
      let offset = 0;
      const write = readBitmap(payload, offset);
      offset += write.consumed;
      const writeMap: Record<number, number> = {};
      for (const id of write.ids) {
        const def = IFIT_PROBE.charById.get(id);
        if (!def) continue;
        writeMap[id] = IFIT_PROBE.decodeValue(
          def.type,
          payload.slice(offset, offset + def.size),
        );
        offset += def.size;
      }
      const read = readBitmap(payload, offset);

      let status: number = IFIT_PROBE.cmdStatus.DONE;
      if (write.ids.length > 0 && !unlocked) {
        status = IFIT_PROBE.cmdStatus.SECURITY_BLOCK;
      } else {
        for (const id of write.ids) applyWrite(id, writeMap[id]);
      }
      const content: number[] = [];
      for (const id of read.ids)
        content.push(...encodeCharValue(id, readState(id)));
      respond(notifyChar, equipmentAddr, command, status, content);
      return;
    }
  }

  const writeChar = new MimicCharacteristic(IFIT_PROBE.writeUuid, (bytes) => {
    const fed = IFIT_PROBE.feedNotifyPacket(reqChunks, bytes);
    reqChunks = fed.chunks;
    if (fed.frame) handleRequest(notifyChar, fed.frame);
  });
  const notifyChar = new MimicCharacteristic(IFIT_PROBE.notifyUuid);
  const service = new MimicService(writeChar, notifyChar);
  const server = new MimicServer(service);
  const device = new MimicDevice(server, name);

  return {
    device,
    getMode: () => appliedMode,
    getModeLabel: () => modeLabel(appliedMode),
    isUnlocked: () => unlocked,
    getWarmupRemainingSec: () =>
      appliedMode === WORKOUT_MODE.WARM_UP && warmupStartedAtMs != null
        ? currentTimeSec()
        : null,
    simulateMovementStart: () => {
      if (appliedMode !== WORKOUT_MODE.IDLE) return; // already claimed by something else — motion doesn't override it
      if (pendingModeTimer) clearTimeout(pendingModeTimer);
      pendingModeTimer = null;
      appliedMode = WORKOUT_MODE.WARM_UP;
      warmupStartedAtMs = Date.now();
    },
  };
}
