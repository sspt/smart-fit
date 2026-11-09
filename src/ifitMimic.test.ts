// Exercises the mimic through the real wire protocol (same buildControlRequest/
// feedNotifyPacket/decodeReadValues plumbing DeviceProbe.tsx's own exchange()
// and ifit.ts's attachDevice use) to prove two things about the "stale
// countdown on first start" race described in ifit.ts's resetToIdle comment:
//
//   1. The race is real and reproducible without hardware: writing
//      WorkoutMode=Idle immediately followed by WorkoutMode=Running, with no
//      wait between them, does NOT leave the console Running.
//   2. Confirming Idle by reading it back before writing Running — the fix
//      applied in ifit.ts's resetToIdle/waitForConfirmedMode — does.
//
// This is the regression net for a bug that, by nature, only reproduces with
// specific timing — exactly the kind of thing worth locking down once found
// rather than trusting to keep working.
import { describe, it, expect } from "vitest";
import { IFIT_PROBE, WORKOUT_MODE, CHAR_ID_WORKOUT_MODE } from "./ifit";
import { createIfitRowerMimic } from "./ifitMimic";

async function connect(mimic: ReturnType<typeof createIfitRowerMimic>) {
  const server = await mimic.device.gatt!.connect();
  const service = await server.getPrimaryService(IFIT_PROBE.serviceUuid);
  const writeChar = await service.getCharacteristic(IFIT_PROBE.writeUuid);
  const notifyChar = await service.getCharacteristic(IFIT_PROBE.notifyUuid);

  let chunks: number[][] = [];
  let resolveFrame: ((f: number[] | null) => void) | null = null;
  notifyChar.addEventListener("characteristicvaluechanged", (event: Event) => {
    const value = (event.target as BluetoothRemoteGATTCharacteristic).value;
    if (!value) return;
    const bytes: number[] = [];
    for (let i = 0; i < value.byteLength; i++) bytes.push(value.getUint8(i));
    const fed = IFIT_PROBE.feedNotifyPacket(chunks, bytes);
    chunks = fed.chunks;
    if (fed.frame && resolveFrame) {
      const r = resolveFrame;
      resolveFrame = null;
      r(fed.frame);
    }
  });
  await notifyChar.startNotifications();

  const exchange = (packets: number[][]): Promise<number[] | null> => {
    chunks = [];
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        resolveFrame = null;
        resolve(null);
      }, 3000);
      resolveFrame = (f) => {
        clearTimeout(timer);
        resolve(f);
      };
      (async () => {
        for (const p of packets) await writeChar.writeValue(new Uint8Array(p));
      })();
    });
  };

  const equipment = IFIT_PROBE.equipment.ROWER;
  const writeMode = (mode: number) =>
    exchange(
      IFIT_PROBE.buildControlRequest(
        equipment,
        { [CHAR_ID_WORKOUT_MODE]: mode },
        [],
      ),
    );
  const readMode = async (): Promise<number | null> => {
    const frame = await exchange(
      IFIT_PROBE.buildControlRequest(equipment, {}, [CHAR_ID_WORKOUT_MODE]),
    );
    return frame
      ? (IFIT_PROBE.decodeReadValues(frame, [CHAR_ID_WORKOUT_MODE]).Mode ??
          null)
      : null;
  };
  const enable = () =>
    exchange(
      IFIT_PROBE.buildEnableRequest(equipment, new Array(36).fill(0x11)),
    );

  return { writeMode, readMode, enable };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("ifitMimic reproduces the stale-countdown start race and validates the fix", () => {
  it("boots into a stale non-Idle mode, matching the field reports", async () => {
    const mimic = createIfitRowerMimic();
    expect(mimic.getMode()).toBe(WORKOUT_MODE.WARM_UP);
  });

  it("locks control until ENABLE, exactly like a real console (SecurityBlock)", async () => {
    const mimic = createIfitRowerMimic({
      responseLatencyMs: 5,
      modeSettleMs: 60,
    });
    const { writeMode } = await connect(mimic);
    const frame = await writeMode(WORKOUT_MODE.IDLE);
    expect(frame && IFIT_PROBE.frameStatus(frame)).toBe(
      IFIT_PROBE.cmdStatus.SECURITY_BLOCK,
    );
    expect(mimic.getMode()).toBe(WORKOUT_MODE.WARM_UP); // rejected write never applied
  });

  it("BUG: resetToIdle immediately followed by startDevice does not reach Running", async () => {
    const mimic = createIfitRowerMimic({
      responseLatencyMs: 5,
      modeSettleMs: 150,
    });
    const { writeMode, readMode, enable } = await connect(mimic);
    await enable();
    expect(mimic.isUnlocked()).toBe(true);

    await writeMode(WORKOUT_MODE.IDLE);
    await writeMode(WORKOUT_MODE.RUNNING); // fired back-to-back, no wait — the exact shape of resetToIdle().then(startDevice())

    await sleep(300); // well past modeSettleMs — give any pending transition time to land
    expect(await readMode()).not.toBe(WORKOUT_MODE.RUNNING);
  });

  it("FIX: confirming Idle by reading it back before writing Running does reach Running", async () => {
    const mimic = createIfitRowerMimic({
      responseLatencyMs: 5,
      modeSettleMs: 150,
    });
    const { writeMode, readMode, enable } = await connect(mimic);
    await enable();

    await writeMode(WORKOUT_MODE.IDLE);
    const deadline = Date.now() + 1500;
    let confirmedIdle = false;
    while (Date.now() < deadline) {
      if ((await readMode()) === WORKOUT_MODE.IDLE) {
        confirmedIdle = true;
        break;
      }
      await sleep(30);
    }
    expect(confirmedIdle).toBe(true);

    await writeMode(WORKOUT_MODE.RUNNING);
    await sleep(300);
    expect(await readMode()).toBe(WORKOUT_MODE.RUNNING);
  });
});

describe("ifitMimic reproduces the autonomous warm-up-on-movement race (I_RW prod report, 2026-07-31)", () => {
  it("boots Idle, and starting from Idle stays Idle until movement is simulated", () => {
    const mimic = createIfitRowerMimic({ startupMode: WORKOUT_MODE.IDLE });
    expect(mimic.getMode()).toBe(WORKOUT_MODE.IDLE);
    expect(mimic.getWarmupRemainingSec()).toBeNull();
  });

  it("BUG: sensing movement while Idle self-triggers a WARM_UP countdown with no app write involved", () => {
    const mimic = createIfitRowerMimic({
      startupMode: WORKOUT_MODE.IDLE,
      warmupSeconds: 300,
    });
    mimic.simulateMovementStart();
    expect(mimic.getMode()).toBe(WORKOUT_MODE.WARM_UP);
    const remaining = mimic.getWarmupRemainingSec();
    expect(remaining).not.toBeNull();
    expect(remaining as number).toBeLessThanOrEqual(300);
    expect(remaining as number).toBeGreaterThan(295); // just started
  });

  it("does not preempt a mode the app already drove the console to", () => {
    const mimic = createIfitRowerMimic({ startupMode: WORKOUT_MODE.RUNNING });
    mimic.simulateMovementStart();
    expect(mimic.getMode()).toBe(WORKOUT_MODE.RUNNING); // motion never overrides an already-claimed mode
    expect(mimic.getWarmupRemainingSec()).toBeNull();
  });

  it("RECOVERY: the same confirm-Idle-then-Running sequence escapes an autonomous warm-up mid-countdown", async () => {
    const mimic = createIfitRowerMimic({
      startupMode: WORKOUT_MODE.IDLE,
      responseLatencyMs: 5,
      modeSettleMs: 150,
      warmupSeconds: 300,
    });
    const { writeMode, readMode, enable } = await connect(mimic);
    await enable();

    mimic.simulateMovementStart(); // the console goes into its own countdown, unprompted
    expect(mimic.getMode()).toBe(WORKOUT_MODE.WARM_UP);

    // Naively writing Running straight away does nothing — WARM_UP isn't Idle.
    await writeMode(WORKOUT_MODE.RUNNING);
    await sleep(300);
    expect(await readMode()).toBe(WORKOUT_MODE.WARM_UP);

    // The same recovery as the write-race fix: force Idle, confirm it, then Running.
    await writeMode(WORKOUT_MODE.IDLE);
    const deadline = Date.now() + 1500;
    let confirmedIdle = false;
    while (Date.now() < deadline) {
      if ((await readMode()) === WORKOUT_MODE.IDLE) {
        confirmedIdle = true;
        break;
      }
      await sleep(30);
    }
    expect(confirmedIdle).toBe(true);
    expect(mimic.getWarmupRemainingSec()).toBeNull(); // the countdown is cancelled once Idle genuinely lands

    await writeMode(WORKOUT_MODE.RUNNING);
    await sleep(300);
    expect(await readMode()).toBe(WORKOUT_MODE.RUNNING);
  });
});
