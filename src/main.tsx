import {
  grantedRememberedDevice,
  parseRememberedDevice,
  type RememberedDevice,
} from "./rememberedDevice";
import { useImmersiveBackground } from "./useImmersiveBackground";
import { MediaServerSettings } from "./MediaServerSettings";
import { videoRoutes as starterRoutes } from "./videoRoutes";
import { ControlMode, type MachineControlMode } from "./ControlMode";
import { Pagination, usePageSize } from "./Pagination";
import { GuidedSetup } from "./GuidedSetup";
import { refreshApp } from "./refreshApp";
import { CinematicEntrance } from "./CinematicEntrance";
import {
  Explore,
  ActivityChips,
  RoutePreview,
  type ActivityFilter,
} from "./Explore";
import type { VideoRoute } from "./videoRoutes";
import { VideoCatalogProvider, useVideoRoutes } from "./VideoCatalog";
import { VideoScenic as ScenicMode } from "./VideoScenic";
import { ProgrammeEditor } from "./ProgrammeEditor";
import { AppIcon } from "./AppIcon";
import { AppLogo } from "./AppLogo";
import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { useFtms } from "./ble";
import { useIfitMonitor as useIfit } from "./ifit";
import {
  load,
  loadProgrammes,
  save,
  templates,
  block,
  segmentAt,
  validProgramme,
  download,
  type Programme,
  type Session,
  type Kind,
} from "./store";
import { buildPassiveReport } from "./passiveProbe";
import { currentSegment, advance, targetAt } from "./workout";
import "./style.css";
import "./discovery.css";
import "./cinematic.css";
import "./compact.css";
import "./immersive.css";
import "./modern.css";
type LastJourney = { programmeId: string; sceneId: string; kind: Kind };
const clock = (s: number) =>
  `${Math.floor(s / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(s % 60)
    .toString()
    .padStart(2, "0")}`;
function App() {
  const videoRoutes = useVideoRoutes();
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("All"),
    [durationFilter, setDurationFilter] = useState("All"),
    [search, setSearch] = useState(""),
    [previewRoute, setPreviewRoute] = useState<VideoRoute | null>(null);
  const pageSize = usePageSize();
  const [libraryPage, setLibraryPage] = useState(0),
    [historyPage, setHistoryPage] = useState(0),
    [liveTab, setLiveTab] = useState("Scenery");
  const [lastJourney, setLastJourney] = useState<LastJourney | null>(null);
  const [setupStep, setSetupStep] = useState(0),
    [setupProgramme, setSetupProgramme] = useState<string | null>(null),
    [setupScene, setSetupScene] = useState<string | null>(null),
    [immersiveSession, setImmersiveSession] = useState<string | null>(null);
  const ft = useFtms(),
    it = useIfit();
  const [page, setPage] = useState("Train"),
    [programmes, setProgrammes] = useState<Programme[]>(templates),
    [history, setHistory] = useState<Session[]>([]),
    [session, setSession] = useState<Session | null>(null),
    [draft, setDraft] = useState<Programme | null>(null),
    [kind, setKind] = useState<Kind>("Treadmill"),
    [demo, setDemo] = useState(false),
    [running, setRunning] = useState(false),
    [hold, setHold] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [ready, setReady] = useState(false),
    [install, setInstall] = useState<any>(null),
    [units, setUnits] = useState("km"),
    [maxSpeed, setMaxSpeed] = useState(12),
    [certified, setCertified] = useState(false),
    [refreshing, setRefreshing] = useState(false);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [page]);
  const state = useRef({ session, running, hold, connected: false });
  const lastTick = useRef(performance.now()),
    lastSample = useRef(0),
    lastCommand = useRef(0),
    sent = useRef(""),
    epoch = useRef(0),
    wake = useRef<any>(null),
    lockRelease = useRef<(() => void) | null>(null),
    fresh = useRef(0),
    expected = useRef<any>({}),
    previous = useRef<any>({}),
    liveMetrics = useRef<any>({}),
    lastDistance = useRef<number | null>(null);
  const [knownDevice, setKnownDevice] = useState<RememberedDevice | null>(null);
  const [autoConnect, setAutoConnect] = useState(true),
    [knownReady, setKnownReady] = useState(false),
    [connectionHint, setConnectionHint] = useState(""),
    [chooseDifferent, setChooseDifferent] = useState(false);
  const autoAttempted = useRef(false);
  useEffect(() => {
    let disposed = false;
    void Promise.all([
      load<unknown>("knownDevice", null),
      load<boolean>("autoConnect", true),
    ])
      .then(([known, enabled]) => {
        if (disposed) return;
        setKnownDevice(parseRememberedDevice(known));
        setAutoConnect(enabled === true);
        setKnownReady(true);
      })
      .catch(() => {
        if (!disposed) setKnownReady(true);
      });
    return () => {
      disposed = true;
    };
  }, []);
  const connected = demo || ft.connected || it.connected;
  const device = it.connected ? it : ft;
  useEffect(() => {
    if (demo || (!ft.connected && !it.connected)) return;
    autoAttempted.current = true;
    const selected = (it.connected ? it : ft).getDevice();
    if (!selected) return;
    const known: RememberedDevice = {
      id: selected.id,
      name: selected.name || "Fitness device",
      kind,
      protocol: it.connected ? "iFIT" : "FTMS",
    };
    setKnownDevice(known);
    setConnectionHint("");
    setChooseDifferent(false);
    void save("knownDevice", known).catch(() =>
      setConnectionHint(
        "Connected. Device could not be remembered on this phone.",
      ),
    );
  }, [ft.connected, it.connected, kind, demo]);
  useEffect(() => {
    if (
      !ready ||
      !knownReady ||
      autoAttempted.current ||
      !autoConnect ||
      !knownDevice ||
      connected ||
      busy ||
      ft.connecting ||
      it.connecting
    )
      return;
    autoAttempted.current = true;
    if (knownDevice.kind !== kind && session) return;
    if (!navigator.bluetooth?.getDevices) {
      setConnectionHint("Tap Connect to select your remembered equipment.");
      return;
    }
    void action(() => reconnectKnownDevice());
  }, [
    ready,
    knownReady,
    autoConnect,
    knownDevice,
    connected,
    busy,
    ft.connecting,
    it.connecting,
  ]);

  useEffect(() => {
    if (page === "Setup" && !connected && setupStep > 0) setSetupStep(0);
  }, [connected, page, setupStep]);
  const metrics: any = demo
    ? {
        speedKmh: running
          ? (session?.programme.kind ?? kind) === "Bike"
            ? 20
            : (session?.programme.kind ?? kind) === "Rower"
              ? 8
              : (segmentAt(
                  session?.programme ?? templates[0],
                  session?.elapsed ?? 0,
                )?.block.speed ?? 5)
          : 0,
        powerW: running ? 100 : 0,
        totalDistanceM: (session?.elapsed ?? 0) * 1.4,
      }
    : it.connected
      ? { ...it.metrics, totalDistanceM: it.metrics.distanceM }
      : ft.metrics;
  state.current = { session, running, hold, connected };
  liveMetrics.current = {
    ...metrics,
    totalDistanceM: demo
      ? metrics.totalDistanceM
      : (it.connected ? it.summary : ft.summary)?.distanceKm != null
        ? (it.connected ? it.summary : ft.summary)!.distanceKm! * 1000
        : metrics.totalDistanceM,
  };
  useEffect(() => {
    Promise.all([
      loadProgrammes(),
      load<Session[]>("history", []),
      load<Session | null>("active", null),
      load<any>("settings", {}),
      load<LastJourney | null>("lastJourney", null),
    ])
      .then(([p, h, s, c, last]) => {
        setLastJourney(last);
        if (s) setKind(s.programme.kind);
        else if (last && ["Treadmill", "Bike", "Rower"].includes(last.kind))
          setKind(last.kind);
        setProgrammes(p);
        setHistory(h);
        setSession(s);
        setDemo(s?.demo ?? false);
        setUnits(c.units ?? "km");
        setMaxSpeed(c.maxSpeed ?? 12);
        setReady(true);
        if (s)
          setError(
            "Recovered workout. Reconnect equipment and explicitly resume.",
          );
      })
      .catch((e) => setError("Storage unavailable: " + e.message));
    const fn = (e: any) => {
      e.preventDefault();
      setInstall(e);
    };
    window.addEventListener("beforeinstallprompt", fn);
    return () => window.removeEventListener("beforeinstallprompt", fn);
  }, []);
  const persist = (key: string, value: unknown) =>
    save(key, value).catch(() =>
      setError("Local storage failed. Export your session before closing."),
    );
  useEffect(() => {
    if (ready) persist("programmes", programmes);
  }, [programmes, ready]);
  useEffect(() => {
    if (ready) persist("history", history);
  }, [history, ready]);
  useEffect(() => {
    if (ready) persist("settings", { units, maxSpeed });
  }, [units, maxSpeed, ready]);
  useEffect(() => {
    if (ready && session) persist("active", session);
  }, [session, ready]);
  useEffect(() => {
    fresh.current = Date.now();
  }, [ft.metrics, it.metrics]);
  useEffect(() => {
    if (!connected && running) {
      setRunning(false);
      setHold(true);
      epoch.current++;
      setError(
        "Connection lost. Machine state unknown. Reconnect and resume explicitly.",
      );
    }
  }, [connected, running]);
  useEffect(() => {
    const onHidden = () => {
      if (document.hidden && state.current.running) {
        setRunning(false);
        setHold(true);
        epoch.current++;
        setError(
          "Workout interrupted while app was hidden. Verify machine state before resuming.",
        );
      }
    };
    document.addEventListener("visibilitychange", onHidden);
    const guard = (e: BeforeUnloadEvent) => {
      if (state.current.session) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => {
      document.removeEventListener("visibilitychange", onHidden);
      window.removeEventListener("beforeunload", guard);
    };
  }, []);
  useEffect(() => {
    if (running) {
      (navigator as any).wakeLock
        ?.request("screen")
        .then((w: any) => (wake.current = w))
        .catch(() => {});
    } else {
      wake.current?.release();
      wake.current = null;
    }
  }, [running]);
  useEffect(() => {
    const timer = setInterval(() => {
      const now = performance.now(),
        delta = (now - lastTick.current) / 1000;
      lastTick.current = now;
      const s = state.current;
      if (!s.running || !s.session) return;
      if (delta > 3 || (!demo && Date.now() - fresh.current > 8000)) {
        setRunning(false);
        setHold(true);
        epoch.current++;
        setError("Timing gap or stale telemetry. Verify equipment and resume.");
        return;
      }
      const m = liveMetrics.current;
      const counter = m.totalDistanceM;
      let metres = 0;
      if (demo) {
        metres = ((m.speedKmh ?? 0) / 3.6) * delta;
      } else if (counter != null) {
        if (
          lastDistance.current != null &&
          counter >= lastDistance.current &&
          counter - lastDistance.current < 50
        )
          metres = counter - lastDistance.current;
        lastDistance.current = counter;
      } else metres = ((m.speedKmh ?? 0) / 3.6) * delta;
      setSession((v) => (v ? advance(v, delta, metres) : v));
    }, 250);
    return () => clearInterval(timer);
  }, [demo]);
  useEffect(() => {
    if (!session || !running || Date.now() - lastSample.current < 1000) return;
    lastSample.current = Date.now();
    setSession((s) =>
      s
        ? {
            ...s,
            samples: [
              ...s.samples,
              {
                at: s.elapsed,
                speed: metrics.speedKmh ?? null,
                power: metrics.powerW ?? null,
                distance: metrics.totalDistanceM ?? null,
                resistance: metrics.resistanceLevel ?? null,
              },
            ].slice(-21600),
          }
        : s,
    );
  }, [session?.elapsed]);
  const event = (message: string) =>
    setSession((s) =>
      s
        ? {
            ...s,
            events: [...s.events, `${clock(s.elapsed)} ${message}`].slice(
              -1000,
            ),
          }
        : s,
    );
  async function action(fn: () => Promise<any>) {
    setError("");
    setBusy(true);
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
      setHold(true);
      setRunning(false);
    } finally {
      setBusy(false);
    }
  }
  async function takeLock() {
    if (lockRelease.current) return;
    if (!navigator.locks)
      throw Error(
        "This browser cannot guarantee exclusive control. Use current Android Chrome.",
      );
    await new Promise<void>((resolve, reject) => {
      navigator.locks
        .request(
          "smart-fit-controller",
          { ifAvailable: true },
          async (lock) => {
            if (!lock) {
              reject(
                Error(
                  "Another tab owns equipment control. Close that workout first.",
                ),
              );
              return;
            }
            await new Promise<void>((release) => {
              lockRelease.current = release;
              resolve();
            });
          },
        )
        .catch(reject);
    });
  }
  async function start(p: Programme, sceneryId?: string) {
    if (!connected) throw Error("Connect equipment or enable demo first.");
    if (session) throw Error("Finish the current workout first.");
    if (p.kind !== kind)
      throw Error("Select the matching equipment type in Devices.");
    if (
      p.kind === "Treadmill" &&
      p.blocks.some(
        (b) => b.speed > maxSpeed || (b.ramp && (b.endSpeed ?? 0) > maxSpeed),
      )
    )
      throw Error("Programme exceeds your speed limit.");
    if (!demo && device.controllable && certified) {
      if (it.connected && kind === "Bike")
        throw Error(
          "iFIT bike control is not implemented. Uncheck verification to track only.",
        );
      const features = ft.targetFeatures;
      if (
        !it.connected &&
        features &&
        ((kind === "Treadmill" && !features.speed) ||
          (kind === "Bike" && !features.power) ||
          (kind === "Rower" && !features.resistance))
      )
        throw Error(
          "Equipment does not support this programme target. Use tracking only.",
        );
      const ranges: any = device.supportedRanges;
      for (const b of p.blocks) {
        const values =
          kind === "Treadmill"
            ? {
                speed: [b.speed, b.ramp ? b.endSpeed : b.speed],
                incline: [b.incline, b.ramp ? b.endIncline : b.incline],
              }
            : kind === "Bike"
              ? { power: [b.power, b.ramp ? b.endPower : b.power] }
              : {
                  resistance: [
                    b.resistance,
                    b.ramp ? b.endResistance : b.resistance,
                  ],
                };
        for (const [key, targets] of Object.entries(values)) {
          const range = ranges[key];
          if (range && targets.some((v: any) => v < range.min || v > range.max))
            throw Error(
              "Programme exceeds advertised " +
                key +
                " range. Edit it before starting.",
            );
        }
      }
    }
    await takeLock();
    sent.current = "";
    lastDistance.current = null;
    const startToken = ++epoch.current;
    const sessionId = crypto.randomUUID();
    setSession({
      id: sessionId,
      sceneryId,
      programme: structuredClone(p),
      started: Date.now(),
      elapsed: 0,
      status: "active",
      demo,
      samples: [],
      events: ["00:00 Workout started"],
      automatic: demo || (device.controllable && certified),
      controlMode:
        demo || (device.controllable && certified) ? "automatic" : "follow",
      phase: 0,
      cycle: 0,
      phaseElapsed: 0,
      phaseDistance: 0,
      distance: 0,
    });
    setLiveTab(sceneryId ? "Scenery" : "Session");
    setPage("Live");
    setHold(!demo && (!device.controllable || !certified));
    if (!demo && device.controllable && certified) {
      if (it.connected) {
        await it.resetToIdle();
        if (startToken !== epoch.current) return;
        await it.startDevice();
      } else await ft.startDevice();
    }
    if (startToken !== epoch.current) return;
    if (sceneryId) {
      const choice = { programmeId: p.id, sceneId: sceneryId, kind: p.kind };
      setLastJourney(choice);
      persist("lastJourney", choice);
    }
    setImmersiveSession(sceneryId ? sessionId : null);
    lastTick.current = performance.now();
    setRunning(true);
    setPage("Live");
  }
  async function targets(b: any) {
    if (demo) return;
    lastCommand.current = Date.now();
    expected.current = {
      speed: b.speed,
      incline: b.incline,
      resistance: b.resistance,
      power: b.power,
    };
    const token = epoch.current;
    if (kind === "Treadmill") {
      await device.setTargetSpeed(Math.min(maxSpeed, b.speed));
      if (token !== epoch.current) return;
      if (it.connected || ft.targetFeatures?.incline)
        await device.setTargetIncline(b.incline);
    } else if (kind === "Rower") await device.setTargetResistance(b.resistance);
    else if (!it.connected) await ft.setTargetPower(b.power);
    else throw Error("iFIT bike control is not verified. Tracking only.");
  }
  const seg = session ? currentSegment(session) : null;
  useEffect(() => {
    if (!session || !running || busy) return;
    if (!seg) {
      void action(() => finish(true));
      return;
    }
    if (hold || !session.automatic) return;
    const key = `${seg.cycle}:${seg.index}:${seg.block.ramp ? Math.floor((session.phaseElapsed ?? 0) / 5) : 0}`;
    if (sent.current === key) return;
    sent.current = key;
    void action(async () => {
      const controlEpoch = epoch.current;
      await targets(targetAt(seg.block, seg.progress));
      if (controlEpoch === epoch.current) event("Applied " + seg.block.name);
    });
  }, [
    seg?.index,
    seg?.cycle,
    !!seg,
    seg?.block.ramp ? Math.floor((session?.phaseElapsed ?? 0) / 5) : 0,
    running,
    hold,
    busy,
  ]);
  // Console target notifications/read-backs take precedence, without mistaking acceleration for a target change.
  const observed: any = it.connected
    ? {
        speed: it.metrics.targetSpeedKmh,
        incline: it.metrics.targetInclinePct,
        resistance: it.metrics.resistanceLevel,
      }
    : {
        speed: ft.consoleTargetSpeedKmh,
        incline: ft.consoleTargetInclinePct,
        resistance: ft.consoleTargetResistanceLevel,
        power: ft.consoleTargetPowerW,
      };
  useEffect(() => {
    if (running && !demo && Date.now() - lastCommand.current > 6000) {
      for (const k of Object.keys(observed)) {
        const v = observed[k];
        if (
          v != null &&
          previous.current[k] != null &&
          v !== previous.current[k] &&
          Math.abs(v - (expected.current[k] ?? v)) > 0.02
        ) {
          setHold(true);
          epoch.current++;
          setSession((s) => (s ? { ...s, controlMode: "follow" } : s));
          event("Physical target change: automation held");
          break;
        }
      }
    }
    previous.current = observed;
  }, [observed.speed, observed.incline, observed.resistance, observed.power]);
  const machineRunning = it.connected ? it.metrics.running : ft.machineRunning;
  useEffect(() => {
    if (
      machineRunning === false &&
      running &&
      Date.now() - lastCommand.current > 6000
    ) {
      setRunning(false);
      setHold(true);
      epoch.current++;
      event("Machine paused or stopped");
    }
  }, [machineRunning]);
  async function pause() {
    epoch.current++;
    setRunning(false);
    if (
      !demo &&
      connected &&
      session?.automatic &&
      session.controlMode !== "follow"
    )
      await device.pauseDevice();
    event("Paused");
  }
  async function resume() {
    if (!connected) throw Error("Reconnect equipment first.");
    if (
      !demo &&
      session?.automatic &&
      session.controlMode !== "follow" &&
      !certified
    )
      throw Error("Confirm device verification in Devices.");
    if (
      !demo &&
      session?.automatic &&
      session.controlMode !== "follow" &&
      kind !== session.programme.kind
    )
      throw Error("Reconnect the equipment type used by this session.");
    await takeLock();
    const resumeToken = ++epoch.current;
    if (!demo && session?.automatic && session.controlMode !== "follow") {
      if (it.connected) await it.resumeDevice();
      else await ft.startDevice();
    }
    if (resumeToken !== epoch.current) return;
    sent.current = "";
    lastTick.current = performance.now();
    if (session?.sceneryId && immersiveSession !== session.id) {
      setLiveTab("Scenery");
      setImmersiveSession(session.id);
    }
    setRunning(true);
    setHold(!session?.automatic || session?.controlMode === "follow");
    event("Resumed explicitly");
  }
  const automaticUnavailable = !session?.automatic
    ? "Automatic control needs a verified control session."
    : !connected
      ? "Reconnect equipment to use automatic control."
      : kind !== session.programme.kind
        ? "Connect the equipment type used by this session."
        : !demo && (!device.controllable || !certified)
          ? "Verify equipment in connection settings first."
          : "";
  const controlMode: MachineControlMode =
    session?.automatic && !hold && session.controlMode !== "follow"
      ? "automatic"
      : "follow";
  function changeControlMode(mode: MachineControlMode) {
    if (!session || (mode === "automatic" && (busy || automaticUnavailable)))
      return;
    if (mode === controlMode && session.controlMode === mode) return;
    epoch.current++;
    sent.current = "";
    setHold(mode === "follow");
    setSession((s) => (s ? { ...s, controlMode: mode } : s));
    event(
      mode === "follow"
        ? "Following machine: programme targets held"
        : "Automatic programme targets selected",
    );
  }
  async function finish(automaticCompletion = false) {
    epoch.current++;
    setRunning(false);
    setHold(true);
    if (!session) return;
    if (
      !demo &&
      session.automatic &&
      (!automaticCompletion || session.controlMode !== "follow")
    ) {
      if (!connected)
        throw Error(
          "Cannot confirm machine stop while disconnected. Use physical stop, then Finish tracking.",
        );
      await device.emergencyStop();
    }
    await archive("completed");
  }
  async function archive(status: string) {
    if (!session) return;
    const completed = { ...session, status };
    await save("history", [completed, ...history].slice(0, 200));
    await save("active", null);
    setHistory((h) => [completed, ...h].slice(0, 200));
    setSession(null);
    setRunning(false);
    lockRelease.current?.();
    lockRelease.current = null;
    setPage("History");
  }
  const total = (p: Programme) =>
    p.blocks.reduce((n, b) => n + b.duration, 0) * p.repeat;
  const csv = (s: Session) =>
    download(
      "smart-fit-session.csv",
      "seconds,speed_kmh,power_w,device_distance_m,resistance\n" +
        s.samples
          .map((x) =>
            [x.at, x.speed, x.power, x.distance, x.resistance].join(","),
          )
          .join("\n"),
      "text/csv",
    );
  const programmeSummary = (p: Programme) => {
    const time =
      p.blocks.reduce((n, b) => n + (b.distance ? 0 : b.duration), 0) *
      p.repeat;
    const distance =
      p.blocks.reduce((n, b) => n + (b.distance ?? 0), 0) * p.repeat;
    return [
      time ? clock(time) : "",
      distance ? distance.toLocaleString() + " m" : "",
    ]
      .filter(Boolean)
      .join(" + ");
  };
  const filteredProgrammes = programmes.filter(
    (p) =>
      (activityFilter === "All" || p.kind === activityFilter) &&
      (durationFilter === "All" ||
        (p.blocks.every((b) => !b.distance) &&
          total(p) === Number(durationFilter) * 60)) &&
      p.name.toLowerCase().includes(search.toLowerCase()),
  );
  useEffect(
    () => setLibraryPage(0),
    [activityFilter, durationFilter, search, pageSize, programmes.length],
  );
  useEffect(() => setHistoryPage(0), [pageSize, history.length]);
  async function reconnectKnownDevice() {
    if (!knownDevice || state.current.connected) return;
    setCertified(false);
    setConnectionHint(`Reconnecting to ${knownDevice.name}…`);
    try {
      const selected = await grantedRememberedDevice(knownDevice);
      if (!selected) {
        setChooseDifferent(true);
        setConnectionHint(
          "Select your device to grant Bluetooth access again.",
        );
        return;
      }
      const nextKind = session?.programme.kind ?? knownDevice.kind;
      setKind(nextKind);
      const detected = (value: string) => {
        if (["Treadmill", "Bike", "Rower"].includes(value))
          setKind(value as Kind);
      };
      if (knownDevice.protocol === "iFIT")
        await it.connectWithDevice(selected, nextKind, detected);
      else {
        let fallback: Promise<void> | undefined;
        await ft.connect(
          nextKind,
          (selectedDevice) => {
            fallback = it.connectWithDevice(selectedDevice, nextKind, detected);
          },
          detected,
          true,
          selected,
        );
        if (fallback) await fallback;
      }
      setConnectionHint(
        "If the device is unavailable, wake it up and tap Connect to retry.",
      );
    } catch {
      setConnectionHint(
        "Could not reconnect. Wake the equipment and tap Connect, or choose another device.",
      );
    }
  }
  async function connectEquipment() {
    autoAttempted.current = true;
    if (
      knownDevice &&
      knownDevice.kind === kind &&
      !chooseDifferent &&
      navigator.bluetooth?.getDevices
    )
      return reconnectKnownDevice();
    setCertified(false);
    const detected = (value: string) => {
      if (value === "Treadmill" || value === "Bike" || value === "Rower")
        setKind(value);
    };
    let fallback: Promise<void> | undefined;
    await ft.connect(
      kind,
      (selected) => {
        fallback = it.connectWithDevice(selected, kind, detected);
      },
      detected,
      true,
    );
    if (fallback) await fallback;
  }
  function beginJourney(scene?: VideoRoute) {
    if (session) {
      setPage("Live");
      if (connected && !running) void action(resume);
      return;
    }
    if (connected && scene && scene.kind !== kind) {
      setError(
        `Disconnect your ${kind.toLowerCase()} before choosing ${scene.kind.toLowerCase()} scenery.`,
      );
      setPreviewRoute(null);
      setPage("Devices");
      return;
    }
    const nextKind = connected ? kind : (scene?.kind ?? kind);
    const previous = lastJourney?.kind === nextKind ? lastJourney : null;
    const programme = programmes.find(
      (p) => p.id === previous?.programmeId && p.kind === nextKind,
    );
    const route =
      scene ??
      videoRoutes.find(
        (r) => r.id === previous?.sceneId && r.kind === nextKind,
      );
    setKind(nextKind);
    setSetupProgramme(programme?.id ?? null);
    setSetupScene(route?.id ?? null);
    setSetupStep(connected ? (programme && route ? 3 : programme ? 2 : 1) : 0);
    setPreviewRoute(null);
    setPage("Setup");
  }
  function advanceSetup(step: number) {
    if (
      step === 1 &&
      programmes.some((p) => p.id === setupProgramme && p.kind === kind) &&
      videoRoutes.some((r) => r.id === setupScene && r.kind === kind) &&
      setupStep === 0
    )
      setSetupStep(3);
    else setSetupStep(step);
  }
  const sessionActions = (
    <div className="actions session-actions">
      <button
        className="primary"
        disabled={busy}
        aria-label={running ? "Pause" : "Resume programme"}
        onClick={() => void action(() => (running ? pause() : resume()))}
      >
        {running ? "Pause" : "Resume"}
      </button>
      <button
        className="danger"
        aria-label="Stop & finish"
        onClick={() => void action(finish)}
      >
        Stop
      </button>
    </div>
  );
  const ambientRoute =
    videoRoutes.find((r) => r.kind === kind && !r.src.startsWith("blob:")) ??
    starterRoutes[0];
  const ambience = useImmersiveBackground(
    ambientRoute,
    starterRoutes.find((r) => r.kind === kind)!.poster,
    !!session,
  );
  const equipmentPanel = (
    <section
      className={"equipment-screen " + (connected ? "is-connected" : "")}
    >
      <p className="eyebrow">THE CONNECTION</p>
      <h1>Your equipment</h1>
      <p>Android Chrome · Bluetooth · Keep the app visible during workouts.</p>
      <div className="panel">
        <fieldset className="device-picker">
          <legend>Choose your equipment</legend>
          <div>
            {(["Treadmill", "Bike", "Rower"] as Kind[]).map((type) => (
              <button
                disabled={!!session || connected || busy}
                key={type}
                aria-pressed={kind === type}
                onClick={() => {
                  setKind(type);
                  setCertified(false);
                }}
              >
                <AppIcon name={type} size={34} />
                <strong>{type}</strong>
                <small>
                  {type === "Treadmill"
                    ? "Speed & incline"
                    : type === "Bike"
                      ? "Power & resistance"
                      : "Pace & resistance"}
                </small>
              </button>
            ))}
          </div>
        </fieldset>
        <h2>
          {demo
            ? "Demo equipment"
            : it.deviceName || ft.deviceName || "Ready to connect"}
        </h2>
        <p>
          {connected
            ? "Connected · " +
              (demo ? "simulated data" : it.connected ? "iFIT FitPro1" : "FTMS")
            : "Select your machine using the Bluetooth picker."}
        </p>
        {!connected && (
          <button
            className="primary connect-primary"
            disabled={busy || running}
            onClick={() => void action(connectEquipment)}
          >
            <AppIcon name="Devices" size={20} />
            {busy
              ? "Connecting…"
              : knownDevice && knownDevice.kind === kind && !chooseDifferent
                ? `Connect ${knownDevice.name}`
                : "Connect equipment"}
          </button>
        )}
        <p role="status">
          {it.connected
            ? it.error || it.controlError
            : ft.connected
              ? ft.error || ft.controlError
              : it.error || ft.error}
        </p>
        {connectionHint && !connected && <p role="status">{connectionHint}</p>}
        <details className="device-details">
          <summary>More connection options</summary>
          <p>
            Use Android Chrome with Bluetooth. Keep the app visible during
            workouts.
          </p>
          <label className="check">
            <input
              type="checkbox"
              checked={autoConnect}
              disabled={busy}
              onChange={(e) => {
                setAutoConnect(e.target.checked);
                void save("autoConnect", e.target.checked).catch(() => {});
              }}
            />{" "}
            Automatically reconnect to remembered equipment
          </label>
          {knownDevice && (
            <p className="subtle">
              Remembered: {knownDevice.name} · {knownDevice.kind}
            </p>
          )}
          <div className="actions">
            {knownDevice && !connected && (
              <button
                disabled={busy || !!session}
                onClick={() => {
                  autoAttempted.current = true;
                  setChooseDifferent(true);
                  setConnectionHint(
                    "Tap Connect equipment to select another device.",
                  );
                }}
              >
                Choose another device
              </button>
            )}
            {knownDevice && (
              <button
                disabled={busy || !!session}
                onClick={() => {
                  autoAttempted.current = true;
                  setKnownDevice(null);
                  setChooseDifferent(false);
                  setConnectionHint("");
                  void save("knownDevice", null).catch(() => {});
                }}
              >
                Forget remembered device
              </button>
            )}
            {!connected && (
              <>
                <button
                  disabled={busy || !!session}
                  onClick={() => void action(() => ft.connect(kind))}
                >
                  Connect FTMS
                </button>
                <button
                  disabled={busy || !!session}
                  onClick={() => void action(() => it.connect(kind))}
                >
                  Connect iFIT
                </button>
              </>
            )}
            <button
              disabled={busy || !!session}
              onClick={() => {
                autoAttempted.current = true;
                ft.disconnect();
                it.disconnect();
                setDemo(!demo);
                setCertified(false);
              }}
            >
              {demo ? "Exit demo" : "Explore demo"}
            </button>
            {connected && (
              <button
                disabled={busy || !!session}
                onClick={() => {
                  autoAttempted.current = true;
                  ft.disconnect();
                  it.disconnect();
                  setDemo(false);
                  setCertified(false);
                }}
              >
                Disconnect
              </button>
            )}
          </div>
          {!demo && connected && (
            <>
              <p>
                {device.controllable
                  ? "Device offers control. Physical verification is required before automation."
                  : "Telemetry only or control not ready."}
              </p>
              <label className="check">
                <input
                  type="checkbox"
                  checked={certified}
                  onChange={(e) => setCertified(e.target.checked)}
                />
                I have verified this model/firmware’s speed, incline or
                resistance encoding and physical stop operation.
              </label>
            </>
          )}
          <div className="metric-grid">
            <Metric
              label="Speed"
              value={metrics.speedKmh?.toFixed(1) ?? "—"}
              unit="km/h"
            />
            <Metric label="Power" value={metrics.powerW ?? "—"} unit="W" />
            <Metric
              label="Distance counter"
              value={metrics.totalDistanceM?.toFixed(0) ?? "—"}
              unit="m"
            />
          </div>
          <p className="subtle">
            FitPro2 is unsupported. iFIT activation may require internet; cached
            activation reuse is not hardware-certified. Unknown device profiles
            are not certified by this app.
          </p>
          <button
            onClick={() =>
              download(
                "smart-fit-diagnostics.json",
                JSON.stringify(buildPassiveReport(), null, 2),
              )
            }
          >
            Export diagnostics
          </button>
        </details>
      </div>
    </section>
  );
  return (
    <>
      {ambience.background}
      <header>
        <a className="brand" href="#" onClick={() => setPage("Train")}>
          <AppLogo />
        </a>
        <span className="tag">A WINDOW TO ELSEWHERE.</span>
        <div className="header-tools">
          {ambience.control}
          <button
            className="cache-refresh"
            disabled={!ready || refreshing || busy || !!session}
            aria-label="Clear app cache"
            title={
              session
                ? "Finish your session before refreshing the app"
                : "Clear app cache and reload. Keeps programmes, settings and history."
            }
            onClick={async () => {
              setRefreshing(true);
              setBusy(true);
              try {
                await refreshApp();
              } catch {
                setRefreshing(false);
                setBusy(false);
                setError(
                  "Could not refresh the app. Check your internet connection and try again.",
                );
              }
            }}
          >
            <AppIcon name="refresh" size={17} />
            <span>{refreshing ? "Refreshing…" : "Clear cache"}</span>
          </button>
          <button
            onClick={() => setPage("Devices")}
            aria-label="Equipment connection"
            className={"connection " + (connected ? "on" : "")}
          >
            {demo
              ? "● Demo"
              : connected
                ? "● Connected"
                : "○ Offline equipment"}
          </button>
        </div>
      </header>
      <main data-page={page}>
        <nav aria-label="Main navigation">
          {[
            "Train",
            "Explore",
            session ? "Live" : "Programmes",
            "History",
            "Settings",
          ].map((n) => (
            <button
              key={n}
              aria-current={page === n ? "page" : undefined}
              className={page === n ? "active" : ""}
              onClick={() => setPage(n)}
            >
              <AppIcon
                name={n === "Train" ? "Home" : n === "Programmes" ? "Train" : n}
              />
              <span>
                {(
                  {
                    Train: "Home",
                    Explore: "Discover",
                    History: "Journal",
                    Devices: "Equipment",
                    Programmes: "Library",
                  } as Record<string, string>
                )[n] ?? n}
              </span>
            </button>
          ))}
        </nav>
        {error && (
          <div className="notice" role="alert">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {page === "Setup" && (
          <GuidedSetup
            step={setupStep}
            onStep={advanceSetup}
            connected={connected}
            kind={kind}
            programmes={programmes}
            programmeId={setupProgramme}
            onProgramme={setSetupProgramme}
            sceneId={setupScene}
            onScene={setSetupScene}
            devicePanel={equipmentPanel}
            deviceName={
              demo
                ? `Demo ${kind.toLowerCase()}`
                : it.deviceName || ft.deviceName || kind
            }
            automatic={demo || (device.controllable && certified)}
            busy={busy || !ready}
            onCancel={() => setPage("Train")}
            onStart={() => {
              const p = programmes.find(
                (p) => p.id === setupProgramme && p.kind === kind,
              );
              const scene = videoRoutes.find(
                (r) => r.id === setupScene && r.kind === kind,
              );
              if (p && scene && connected)
                void action(() => start(p, scene.id));
            }}
          />
        )}
        {page === "Train" && (
          <>
            <CinematicEntrance
              route={ambientRoute}
              onStart={() => beginJourney()}
              hasSession={!!session}
            />
            <button
              className="home-library-link"
              onClick={() => setPage("Programmes")}
            >
              Programmes & editor <AppIcon name="arrow" size={16} />
            </button>
          </>
        )}
        {page === "Programmes" && (
          <section className="programme-library">
            <section className="section-head" id="programmes">
              <div>
                <p className="eyebrow">MAKE TIME FOR YOURSELF</p>
                <h2>Your programmes</h2>
              </div>
              <button
                onClick={() =>
                  setDraft({
                    id: crypto.randomUUID(),
                    name: "My programme",
                    kind: activityFilter === "All" ? kind : activityFilter,
                    repeat: 1,
                    blocks: [block()],
                  })
                }
              >
                <AppIcon name="plus" size={18} />
                <span>Create programme</span>
              </button>
            </section>
            <div className="programme-filters">
              <label className="programme-search">
                <AppIcon name="search" size={18} />
                <input
                  aria-label="Search programmes"
                  placeholder="Search programmes"
                  type="search"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </label>
            </div>
            <details className="library-filters">
              <summary>Filter programmes</summary>
              <ActivityChips
                value={activityFilter}
                onChange={setActivityFilter}
              />
              <div
                className="duration-chips"
                role="group"
                aria-label="Filter by duration"
              >
                {["All", "15", "30", "45"].map((duration) => (
                  <button
                    key={duration}
                    aria-pressed={durationFilter === duration}
                    onClick={() => setDurationFilter(duration)}
                  >
                    {duration === "All" ? "Any duration" : duration + " min"}
                  </button>
                ))}
              </div>
            </details>
            <div className="cards">
              {filteredProgrammes
                .slice(libraryPage * pageSize, (libraryPage + 1) * pageSize)
                .map((p, i) => (
                  <article key={p.id} className="card">
                    <div
                      className={"equipment e" + (i % 3)}
                      style={{
                        backgroundImage: `url(${videoRoutes.find((r) => r.kind === p.kind)!.poster})`,
                      }}
                    >
                      <AppIcon name={p.kind} size={40} />
                      <span>{p.kind}</span>
                      <strong className="programme-duration">
                        {programmeSummary(p)}
                      </strong>
                    </div>
                    <div className="card-body">
                      <small>
                        {p.kind} · {p.blocks.length} segments ·{" "}
                        {programmeSummary(p)}
                      </small>
                      <h3>{p.name}</h3>
                      <div className="mini-bars">
                        {p.blocks.map((b, j) => (
                          <i
                            key={j}
                            style={
                              {
                                "--bar-height": Math.min(
                                  48,
                                  12 +
                                    (p.kind === "Treadmill"
                                      ? b.speed * 4
                                      : p.kind === "Bike"
                                        ? b.power / 5
                                        : b.resistance * 5),
                                ),
                              } as React.CSSProperties
                            }
                          />
                        ))}
                      </div>
                      <div className="card-actions">
                        <button onClick={() => setDraft(structuredClone(p))}>
                          Edit programme
                        </button>
                        <button
                          className="round"
                          aria-label={"Start " + p.name}
                          disabled={busy || !!session}
                          onClick={() => void action(() => start(p))}
                        >
                          ›
                        </button>
                      </div>
                    </div>
                  </article>
                ))}
            </div>
            {filteredProgrammes.length === 0 && (
              <div className="empty filter-empty">
                <h3>No matching programmes</h3>
                <p>Try a different activity, duration or search.</p>
                <button
                  onClick={() => {
                    setActivityFilter("All");
                    setDurationFilter("All");
                    setSearch("");
                  }}
                >
                  Clear filters
                </button>
              </div>
            )}
            <Pagination
              page={libraryPage}
              size={pageSize}
              count={filteredProgrammes.length}
              onChange={setLibraryPage}
              label="Programme pages"
            />
          </section>
        )}
        {page === "Explore" && (
          <Explore
            filter={activityFilter}
            onFilter={setActivityFilter}
            onPreview={(route) =>
              session ? setPage("Live") : setPreviewRoute(route)
            }
          />
        )}
        {previewRoute && (
          <RoutePreview
            route={previewRoute}
            onClose={() => setPreviewRoute(null)}
            onTrain={() => beginJourney(previewRoute)}
          />
        )}
        {page === "Devices" && equipmentPanel}
        {page === "Live" && session && (
          <section className="live-screen">
            <div className="section-head live-heading">
              <div>
                <p className="eyebrow">
                  {session.demo ? "SIMULATED SESSION" : "YOUR SESSION"} ·{" "}
                  {session.programme.kind}
                </p>
                <h1>{session.programme.name}</h1>
              </div>
              <span className="pill">
                {running
                  ? controlMode === "follow"
                    ? "Following machine"
                    : "Automatic"
                  : "Paused"}
              </span>
            </div>
            <div className="live-tools">
              <ControlMode
                value={controlMode}
                onChange={changeControlMode}
                busy={busy}
                automaticUnavailable={automaticUnavailable}
              />
              {sessionActions}
            </div>
            <div className="view-tabs" role="group" aria-label="Session view">
              {["Scenery", "Session"].map((tab) => (
                <button
                  key={tab}
                  aria-pressed={liveTab === tab}
                  onClick={() => setLiveTab(tab)}
                >
                  {tab}
                </button>
              ))}
            </div>
            <div hidden={liveTab !== "Scenery"}>
              <ScenicMode
                key={session.id}
                initialRouteId={session.sceneryId}
                autoImmerse={immersiveSession === session.id}
                controlMode={controlMode}
                onControlMode={changeControlMode}
                automaticUnavailable={automaticUnavailable}
                speed={connected ? (metrics.speedKmh ?? null) : null}
                running={running}
                kind={session.programme.kind}
                time={clock(session.elapsed)}
                busy={busy}
                onPause={() =>
                  void action(() => (running ? pause() : resume()))
                }
                onStop={() => void action(finish)}
              />
            </div>
            <div hidden={liveTab !== "Session"} className="session-detail-view">
              <details className="panel timer">
                <summary>
                  <strong>{clock(session.elapsed)}</strong>
                  <span>{seg?.block.name ?? "Programme complete"}</span>
                </summary>
                <progress
                  max={total(session.programme)}
                  value={session.elapsed}
                />
                <p>
                  {seg
                    ? (seg.block.distance
                        ? Math.ceil(seg.remaining) + " m"
                        : clock(seg.remaining)) + " remaining in segment"
                    : "Ready to finish"}{" "}
                  · {programmeSummary(session.programme)} total
                </p>
                <p>
                  {controlMode === "follow"
                    ? "Use the machine’s controls. Programme targets are held."
                    : "Programme targets are applied automatically. Physical changes take priority."}
                </p>
              </details>
              <div className="panel readings-panel">
                <div className="metric-grid">
                  <Metric
                    label="Speed"
                    value={
                      metrics.speedKmh == null
                        ? "—"
                        : (
                            metrics.speedKmh * (units === "mi" ? 0.621371 : 1)
                          ).toFixed(1)
                    }
                    unit={units + "/h"}
                  />
                  <Metric
                    label="Power"
                    value={metrics.powerW ?? "—"}
                    unit="W"
                  />
                  <Metric
                    label="Heart rate"
                    value={metrics.heartRateBpm || metrics.pulseBpm || "—"}
                    unit="bpm"
                  />
                </div>
                <hr />
                <p>
                  {controlMode === "automatic"
                    ? "Programme target"
                    : "Following machine · use physical controls"}
                </p>
                <h3>
                  {seg
                    ? session.programme.kind === "Treadmill"
                      ? `${seg.block.speed} km/h · ${seg.block.incline}%`
                      : session.programme.kind === "Bike"
                        ? `${seg.block.power} W`
                        : `Resistance ${seg.block.resistance}`
                    : "Completed"}
                </h3>
                <details className="quiet-options" open={!connected}>
                  <summary>Tracking & recovery</summary>
                  <p>
                    {connected
                      ? "Equipment connected"
                      : "Connection lost · physical state unknown"}
                    . Physical controls always take precedence.
                  </p>
                  <button
                    onClick={() => {
                      if (
                        confirm(
                          "Use the physical stop first. Finish tracking without confirming remote stop?",
                        )
                      )
                        void action(() => archive("interrupted"));
                    }}
                  >
                    Finish tracking only
                  </button>
                </details>
              </div>
              <details className="panel quiet-options">
                <summary>Session events</summary>
                {session.events.slice(-6).map((e, i) => (
                  <p className="event" key={i}>
                    {e}
                  </p>
                ))}
              </details>
            </div>
          </section>
        )}
        {page === "History" && (
          <section>
            <p className="eyebrow">SCENES FROM YOUR JOURNEY</p>
            <h1>Your journey.</h1>
            <div className="history-overview">
              <div>
                <strong>{history.length}</strong>
                <span>Sessions recorded</span>
              </div>
              <div>
                <strong>
                  {Math.floor(
                    history.reduce(
                      (n, s) =>
                        n +
                        (Number.isFinite(s.elapsed)
                          ? Math.max(0, s.elapsed)
                          : 0),
                      0,
                    ) / 60,
                  )}{" "}
                  min
                </strong>
                <span>Total training time</span>
              </div>
            </div>
            {history.length === 0 ? (
              <div className="empty">
                <h2>Your story starts here.</h2>
                <p>Your completed sessions will find a home here.</p>
                <button onClick={() => setPage("Train")}>
                  Find a programme ›
                </button>
              </div>
            ) : (
              history
                .slice(historyPage * pageSize, (historyPage + 1) * pageSize)
                .map((s) => (
                  <article className="panel history" key={s.id}>
                    <div>
                      <small>
                        {new Date(s.started).toLocaleString()} ·{" "}
                        {s.programme.kind}
                        {s.demo ? " · DEMO" : ""}
                      </small>
                      <h3>{s.programme.name}</h3>
                      <p>
                        {clock(s.elapsed)} · {s.status} · {s.samples.length}{" "}
                        samples
                      </p>
                      <div className="spark">
                        {s.samples
                          .filter(
                            (_, i) =>
                              i %
                                Math.max(
                                  1,
                                  Math.floor(s.samples.length / 80),
                                ) ===
                              0,
                          )
                          .map((x, i) => (
                            <i
                              key={i}
                              style={{
                                height: Math.min(
                                  50,
                                  4 + (x.speed ?? 0) * 4 + (x.power ?? 0) / 10,
                                ),
                              }}
                            />
                          ))}
                      </div>
                    </div>
                    <button onClick={() => csv(s)}>Export CSV</button>
                  </article>
                ))
            )}
            {history.length > 0 && (
              <Pagination
                page={historyPage}
                size={pageSize}
                count={history.length}
                onChange={setHistoryPage}
                label="History pages"
              />
            )}
          </section>
        )}
        {page === "Settings" && (
          <section>
            <p className="eyebrow">MAKE IT YOURS</p>
            <h1>Your preferences</h1>
            <div className="panel settings">
              <label>
                Display units
                <select
                  value={units}
                  onChange={(e) => setUnits(e.target.value)}
                >
                  <option value="km">Kilometres</option>
                  <option value="mi">Miles</option>
                </select>
              </label>
              <label>
                Maximum treadmill speed (km/h)
                <input
                  type="number"
                  min="1"
                  max="25"
                  value={maxSpeed}
                  disabled={!!session}
                  onChange={(e) =>
                    setMaxSpeed(
                      Math.max(1, Math.min(25, Number(e.target.value) || 1)),
                    )
                  }
                />
              </label>
              <MediaServerSettings disabled={!!session} />
              <details className="settings-data">
                <summary>Data, backups & installation</summary>
                <div className="actions">
                  <button
                    onClick={() =>
                      download(
                        "smart-fit-backup.json",
                        JSON.stringify({
                          version: 1,
                          programmes,
                          history,
                          settings: { units, maxSpeed },
                        }),
                      )
                    }
                  >
                    Export backup
                  </button>
                  <label className="button">
                    Restore backup
                    <input
                      hidden
                      type="file"
                      accept="application/json"
                      disabled={!!session}
                      onChange={async (e) => {
                        try {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          if (file.size > 20000000)
                            throw Error("Backup too large");
                          const v = JSON.parse(await file.text());
                          if (
                            v.version !== 1 ||
                            !Array.isArray(v.programmes) ||
                            !v.programmes.every(validProgramme) ||
                            !Array.isArray(v.history)
                          )
                            throw Error("Invalid backup");
                          if (
                            !confirm(
                              "Replace local programmes and history with this backup?",
                            )
                          )
                            return;
                          setProgrammes(v.programmes);
                          setHistory(
                            v.history
                              .filter(
                                (s: any) =>
                                  s &&
                                  validProgramme(s.programme) &&
                                  Array.isArray(s.samples) &&
                                  typeof s.started === "number",
                              )
                              .slice(0, 200),
                          );
                          if (v.settings) {
                            setUnits(v.settings.units === "mi" ? "mi" : "km");
                            setMaxSpeed(
                              Math.max(
                                1,
                                Math.min(25, Number(v.settings.maxSpeed) || 12),
                              ),
                            );
                          }
                        } catch (e: any) {
                          setError(e.message);
                        }
                      }}
                    />
                  </label>
                  <button
                    onClick={() =>
                      void navigator.storage
                        ?.persist()
                        .then((ok) =>
                          setError(
                            ok
                              ? "Persistent storage granted. Keep backups too."
                              : "Storage persistence was not granted. Keep backups.",
                          ),
                        )
                    }
                  >
                    Request persistent storage
                  </button>
                  {install && (
                    <button
                      className="primary"
                      onClick={() => void install.prompt()}
                    >
                      Install Smart Fit ›
                    </button>
                  )}
                </div>
                <p>
                  Install from the Android Chrome menu if no install button
                  appears. Bluetooth and automation require the app in the
                  foreground.
                </p>
                <button
                  className="danger"
                  disabled={!!session}
                  onClick={() => {
                    if (confirm("Delete local workout history?"))
                      setHistory([]);
                  }}
                >
                  Delete history
                </button>
              </details>
            </div>
          </section>
        )}
        {draft && (
          <ProgrammeEditor
            value={draft}
            existing={programmes.some((p) => p.id === draft.id)}
            onClose={() => setDraft(null)}
            onSave={(programme) => {
              setPage("Programmes");
              setDurationFilter("All");
              setSearch("");
              setActivityFilter((v) => (v === "All" ? "All" : programme.kind));
              setProgrammes((p) => {
                const i = p.findIndex((x) => x.id === programme.id);
                if (i < 0) return [programme, ...p];
                return p.map((x) => (x.id === programme.id ? programme : x));
              });
              setDraft(null);
            }}
            onDelete={() => {
              setProgrammes((p) => p.filter((x) => x.id !== draft.id));
              setDraft(null);
            }}
          />
        )}
        {session && page !== "Live" && !draft && (
          <button className="active-session" onClick={() => setPage("Live")}>
            <span className="session-pulse" />
            <span>
              <strong>{session.programme.name}</strong>
              <small>
                {running ? "Workout in progress" : "Workout paused"} ·{" "}
                {clock(session.elapsed)}
              </small>
            </span>
            <AppIcon name="Live" />
          </button>
        )}
        <footer>
          <span>SMART FIT / MOVE WITH INTENTION</span>
          <span>Private by design. Stored on your device.</span>
        </footer>
      </main>
    </>
  );
}
function Metric({
  label,
  value,
  unit,
}: {
  label: string;
  value: any;
  unit: string;
}) {
  return (
    <div className="metric">
      <small>{label}</small>
      <strong>
        {value}
        <span>{unit}</span>
      </strong>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(
  <VideoCatalogProvider>
    <App />
  </VideoCatalogProvider>,
);
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("/sw.js").catch(console.error);
