import { wrapAccountDatabase } from "./accountClient";
import { openDB } from "idb";
import { defaultProgrammes, installDefaults } from "./defaultProgrammes";
export type Kind = "Treadmill" | "Bike" | "Rower";
export type Segment = {
  name: string;
  duration: number;
  speed: number;
  incline: number;
  resistance: number;
  power: number;
  distance?: number;
  ramp?: boolean;
  endSpeed?: number;
  endIncline?: number;
  endResistance?: number;
  endPower?: number;
};
export type Programme = {
  id: string;
  name: string;
  kind: Kind;
  repeat: number;
  blocks: Segment[];
};
export type Sample = {
  at: number;
  speed: number | null;
  power: number | null;
  distance: number | null;
  resistance: number | null;
};
export type Session = {
  sceneryId?: string;
  controlMode?: "follow" | "automatic";
  id: string;
  programme: Programme;
  started: number;
  elapsed: number;
  status: string;
  demo: boolean;
  samples: Sample[];
  events: string[];
  automatic?: boolean;
  phase?: number;
  cycle?: number;
  phaseElapsed?: number;
  phaseDistance?: number;
  distance?: number;
};
export const db = openDB("smart-fit", 1, {
  upgrade(d) {
    if (!d.objectStoreNames.contains("data")) d.createObjectStore("data");
  },
}).then(wrapAccountDatabase);
export const load = async <T>(key: string, fallback: T): Promise<T> =>
  (await (await db).get("data", key)) ?? fallback;
export const save = async (key: string, value: unknown) =>
  (await db).put("data", value, key);
export const block = (name = "Steady", duration = 180): Segment => ({
  name,
  duration,
  speed: 5,
  incline: 0,
  resistance: 3,
  power: 100,
});
export const templates: Programme[] = defaultProgrammes;
export async function loadProgrammes(): Promise<Programme[]> {
  const database = await db;
  const transaction = database.transaction("data", "readwrite");
  const saved = (await transaction.store.get("programmes")) as
    Programme[] | undefined;
  const version = await transaction.store.get("programme-catalogue-version");
  if (version === 1) {
    await transaction.done;
    return saved ?? [];
  }
  const updated = installDefaults(saved ?? []);
  await transaction.store.put(updated, "programmes");
  await transaction.store.put(1, "programme-catalogue-version");
  await transaction.done;
  return updated;
}
export function segmentAt(p: Programme, elapsed: number) {
  const length = p.blocks.reduce((n, b) => n + b.duration, 0);
  if (length <= 0 || elapsed >= length * p.repeat) return null;
  let t = elapsed % length;
  for (let i = 0; i < p.blocks.length; i++) {
    if (t < p.blocks[i].duration)
      return {
        block: p.blocks[i],
        index: i,
        cycle: Math.floor(elapsed / length),
        remaining: p.blocks[i].duration - t,
      };
    t -= p.blocks[i].duration;
  }
  return null;
}
export { validProgramme } from "./programmeValidation";

export const download = (
  name: string,
  data: string,
  type = "application/json",
) => {
  const u = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement("a");
  a.href = u;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
};
