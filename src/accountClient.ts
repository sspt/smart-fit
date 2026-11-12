import { openDB } from "idb";
export type AccountUser = { id: string; name: string; email: string | null };
export type AccountState = {
  configured: boolean;
  user: AccountUser | null;
  providers: { google: boolean; strava: boolean };
  linked: string[];
  local: boolean;
  message: string;
  syncing: boolean;
  conflicts: string[];
};
let state: AccountState = {
  configured: false,
  user: null,
  providers: { google: false, strava: false },
  linked: [],
  local: false,
  message: "",
  syncing: false,
  conflicts: [],
};
const listeners = new Set<() => void>();
export const accountState = () => state;
export const subscribeAccount = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
function update(patch: Partial<AccountState>) {
  state = { ...state, ...patch };
  listeners.forEach((fn) => fn());
}
let localDatabase: ReturnType<typeof openDB> | undefined;
const database = () =>
  (localDatabase ||= openDB("smart-fit", 1, {
    upgrade(db) {
      if (!db.objectStoreNames.contains("data")) db.createObjectStore("data");
    },
  }));
const prefix = (key: unknown) =>
  state.user ? `account:${state.user.id}:${String(key)}` : String(key);
const metadataKey = () => prefix("cloud-state");
let retryDelay = 2000;
let metadataTail: Promise<unknown> = Promise.resolve(),
  stageTail: Promise<unknown> = Promise.resolve(),
  flushing: Promise<void> | null = null,
  timer: ReturnType<typeof setTimeout> | undefined;
const nativeFetch = globalThis.fetch.bind(globalThis);
export async function accountRequest(path: string, init: RequestInit = {}) {
  const response = await nativeFetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...init.headers,
    },
    signal: init.signal || AbortSignal.timeout(20000),
  });
  let data: any;
  try {
    data = await response.json();
  } catch {
    throw Error("Account service is unavailable. Your device data is safe.");
  }
  if (!response.ok)
    throw Object.assign(Error(data.error || "Account request failed."), {
      status: response.status,
      conflict: data.conflict,
    });
  return data;
}
type Entry = { revision: number; hash: string; deleted: boolean };
type Pending = {
  revision: number;
  hash: string;
  deleted: boolean;
  value?: any;
  generation: string;
  conflict?: boolean;
};
type Metadata = {
  index: Record<string, Entry>;
  outbox: Record<string, Pending>;
};
async function metaChange<T>(fn: (meta: Metadata) => T): Promise<T> {
  const result = metadataTail.then(async () => {
    const db = await database(),
      key = metadataKey(),
      tx = db.transaction("data", "readwrite"),
      meta: Metadata = (await tx.store.get(key)) || { index: {}, outbox: {} };
    const output = fn(meta);
    await tx.store.put(meta, key);
    await tx.done;
    return output;
  });
  metadataTail = result.catch(() => {});
  return result;
}
const hash = async (value: unknown) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(value)),
      ),
    ),
    (x) => x.toString(16).padStart(2, "0"),
  ).join("");
async function stageAll() {
  if (!state.user) return;
  const db = await database(),
    collections: Record<string, Map<string, any>> = {};
  for (const key of ["programmes", "history", "settings"]) {
    const value = await db.get("data", prefix(key));
    if (key === "settings") {
      if (value && ["km", "mi"].includes(value.units))
        collections.settings = new Map([["preferences", value]]);
    } else if (Array.isArray(value))
      collections[key] = new Map(value.map((x) => [x.id, x]));
  }
  const values: Record<string, { value: any; hash: string }> = {};
  for (const [kind, records] of Object.entries(collections))
    for (const [id, value] of records)
      values[kind + ":" + id] = { value, hash: await hash(value) };
  await metaChange((meta) => {
    for (const [key, { value, hash }] of Object.entries(values)) {
      if (meta.index[key]?.hash === hash && !meta.index[key].deleted) {
        if (!meta.outbox[key]?.conflict) delete meta.outbox[key];
        continue;
      }
      if (meta.outbox[key]?.hash !== hash || meta.outbox[key].deleted)
        meta.outbox[key] = {
          revision: meta.index[key]?.revision || 0,
          hash,
          value,
          deleted: false,
          generation: crypto.randomUUID(),
          conflict: meta.outbox[key]?.conflict,
        };
    }
    for (const key of Object.keys(meta.outbox)) {
      const kind = key.slice(0, key.indexOf(":"));
      if (
        collections[kind] &&
        !values[key] &&
        (!meta.index[key] || meta.index[key].deleted)
      )
        delete meta.outbox[key];
    }
    for (const [key, index] of Object.entries(meta.index)) {
      const kind = key.slice(0, key.indexOf(":"));
      if (
        collections[kind] &&
        !values[key] &&
        !index.deleted &&
        !meta.outbox[key]?.deleted
      )
        meta.outbox[key] = {
          revision: index.revision,
          hash: "",
          deleted: true,
          generation: crypto.randomUUID(),
        };
    }
  });
}
function scheduleStage() {
  if (!state.user) return;
  stageTail = stageTail
    .then(stageAll)
    .then(() => {
      clearTimeout(timer);
      timer = setTimeout(() => void flushAccount(), 750);
    })
    .catch(() =>
      update({ message: "Saved on this device. Cloud sync needs attention." }),
    );
}
export function wrapAccountDatabase<T>(db: T): T {
  const raw: any = db;
  const store = (target: any, done?: Promise<any>) =>
    new Proxy(target, {
      get(t, key) {
        const value = t[key];
        if (["get", "put", "delete"].includes(String(key)))
          return (...args: any[]) => {
            const isGet = key === "get",
              isDelete = key === "delete",
              index = isGet || isDelete ? 0 : 1,
              logical = args[index];
            args[index] = prefix(logical);
            const result = t[key](...args);
            if (
              !isGet &&
              ["programmes", "history", "settings"].includes(String(logical))
            )
              Promise.resolve(done || result)
                .then(scheduleStage)
                .catch(() => {});
            return result;
          };
        return typeof value === "function" ? value.bind(t) : value;
      },
    });
  return new Proxy(raw, {
    get(t, key) {
      const value = t[key];
      if (["get", "put", "delete"].includes(String(key)))
        return (...args: any[]) => {
          const storeName = args[0];
          if (storeName !== "data") return t[key](...args);
          const index = key === "put" ? 2 : 1,
            logical = args[index];
          args[index] = prefix(logical);
          const result = t[key](...args);
          if (
            key !== "get" &&
            ["programmes", "history", "settings"].includes(String(logical))
          )
            Promise.resolve(result)
              .then(scheduleStage)
              .catch(() => {});
          return result;
        };
      if (key === "transaction")
        return (...args: any[]) => {
          const tx = t.transaction(...args);
          return new Proxy(tx, {
            get(tr, k) {
              if (k === "store") return store(tr.store, tr.done);
              if (k === "objectStore")
                return (name: string) =>
                  name === "data"
                    ? store(tr.objectStore(name), tr.done)
                    : tr.objectStore(name);
              const v = tr[k];
              return typeof v === "function" ? v.bind(tr) : v;
            },
          });
        };
      return typeof value === "function" ? value.bind(t) : value;
    },
  }) as T;
}
async function listCloud() {
  let cursor: string | null = "",
    records: any[] = [];
  do {
    const page = await accountRequest(
      "/api/data" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : ""),
    );
    records.push(...page.records);
    cursor = page.next;
    if (records.length > 20000)
      throw Error("Account has too many records to load on this device.");
  } while (cursor);
  return records;
}
function recordPath(key: string) {
  const split = key.indexOf(":");
  return (
    "/api/data/" +
    key.slice(0, split) +
    "/" +
    encodeURIComponent(key.slice(split + 1))
  );
}
async function pullCloud() {
  const rows = await listCloud(),
    db = await database(),
    meta = await metaChange((m) => structuredClone(m)),
    values = new Map<string, any>();
  for (const kind of ["programmes", "history"]) {
    const records = await db.get("data", prefix(kind));
    values.set(
      kind,
      new Map(
        (Array.isArray(records) ? records : []).map((v: any) => [v.id, v]),
      ),
    );
  }
  let settings = await db.get("data", prefix("settings")),
    hasProgrammes = false;
  for (const row of rows) {
    const key = row.record_key;
    if (meta.outbox[key]) continue;
    const split = key.indexOf(":"),
      kind = key.slice(0, split),
      id = key.slice(split + 1);
    if (kind === "programmes") hasProgrammes = true;
    if (row.deleted) {
      values.get(kind)?.delete(id);
      if (kind === "settings") settings = { units: "km" };
      meta.index[key] = { revision: row.revision, hash: "", deleted: true };
      continue;
    }
    if (
      meta.index[key]?.revision === row.revision &&
      ((kind === "settings" && settings) || values.get(kind)?.has(id))
    )
      continue;
    const record = await accountRequest(recordPath(key));
    if (kind === "settings") settings = record.value;
    else values.get(kind)?.set(id, record.value);
    meta.index[key] = {
      revision: record.revision,
      hash: await hash(record.value),
      deleted: false,
    };
  }
  const tx = db.transaction("data", "readwrite");
  for (const [kind, records] of values) {
    if (records.size || rows.some((r) => r.record_key.startsWith(kind + ":")))
      await tx.store.put([...records.values()], prefix(kind));
  }
  if (settings) await tx.store.put(settings, prefix("settings"));
  if (hasProgrammes)
    await tx.store.put(1, prefix("programme-catalogue-version"));
  await tx.done;
  await metaChange((current) => {
    current.index = meta.index;
  });
}
export function flushAccount(): Promise<void> {
  if (!state.user) return Promise.resolve();
  if (flushing) return flushing;
  flushing = (async () => {
    update({ syncing: true });
    try {
      await stageTail;
      await stageAll();
      for (let pass = 0; pass < 5; pass++) {
        const pending = await metaChange((meta) =>
          Object.entries(structuredClone(meta.outbox)).filter(
            ([, item]) => !item.conflict,
          ),
        );
        if (!pending.length) break;
        for (const [key, item] of pending) {
          try {
            const result = await accountRequest(recordPath(key), {
              method: item.deleted ? "DELETE" : "PUT",
              body: JSON.stringify({
                revision: item.revision,
                ...(!item.deleted ? { value: item.value } : {}),
              }),
            });
            await metaChange((meta) => {
              meta.index[key] = {
                revision: result.revision,
                hash: item.hash,
                deleted: item.deleted,
              };
              if (meta.outbox[key]?.generation === item.generation)
                delete meta.outbox[key];
              else if (meta.outbox[key])
                meta.outbox[key].revision = result.revision;
            });
          } catch (error: any) {
            if (error.conflict) {
              await metaChange((meta) => {
                if (meta.outbox[key]) meta.outbox[key].conflict = true;
              });
              continue;
            }
            throw error;
          }
        }
        await stageAll();
      }
      retryDelay = 2000;
      const remaining = await metaChange((meta) => Object.entries(meta.outbox));
      const conflicts = remaining
        .filter(([, item]) => item.conflict)
        .map(([key]) => key);
      update({
        conflicts,
        message: conflicts.length
          ? "Changes on another device need review."
          : remaining.length
            ? "Changes are waiting to sync."
            : "All changes saved to your account.",
      });
    } catch (error: any) {
      const transient =
        !error.status || error.status >= 500 || error.status === 429;
      update({
        message:
          error.status === 401
            ? "Sign in again to sync. Your device data is safe."
            : transient
              ? "Saved on this device. Sync will retry when available."
              : error.message || "Cloud sync needs attention.",
      });
      if (transient && navigator.onLine) {
        clearTimeout(timer);
        timer = setTimeout(() => void flushAccount(), retryDelay);
        retryDelay = Math.min(60000, retryDelay * 2);
      }
    } finally {
      update({ syncing: false });
      flushing = null;
    }
  })();
  return flushing;
}
export async function syncAndReload() {
  await flushAccount();
  if (state.conflicts.length)
    throw Error("Resolve the conflicting changes first.");
  location.reload();
}
export async function resolveAccountConflicts(keepLocal: boolean) {
  const rows = await listCloud();
  await metaChange((meta) => {
    for (const [key, item] of Object.entries(meta.outbox)) {
      if (!item.conflict) continue;
      if (keepLocal) {
        item.revision = rows.find((x) => x.record_key === key)?.revision || 0;
        item.conflict = false;
      } else delete meta.outbox[key];
    }
  });
  if (keepLocal) {
    await flushAccount();
    if (state.conflicts.length)
      throw Error("The cloud changed again. Please review the conflict again.");
  } else await pullCloud();
  location.reload();
}
export async function importDeviceData() {
  if (!state.user) throw Error("Sign in first.");
  const db = await database();
  let count = 0;
  const imported = (await db.get("data", prefix("device-imports"))) || {};
  for (const kind of ["programmes", "history"]) {
    const guest = await db.get("data", kind),
      current = await db.get("data", prefix(kind));
    const records = new Map(
      (Array.isArray(current) ? current : []).map((v: any) => [v.id, v]),
    );
    for (const original of Array.isArray(guest) ? guest : []) {
      if (original.demo) continue;
      const provenance =
        kind + ":" + original.id + ":" + (await hash(original));
      if (imported[provenance]) continue;
      const existing = records.get(original.id);
      if (existing && JSON.stringify(existing) === JSON.stringify(original))
        continue;
      const value = structuredClone(original);
      if (existing) {
        value.id = crypto.randomUUID();
        if (kind === "programmes") value.name += " (imported)";
      }
      records.set(value.id, value);
      imported[provenance] = value.id;
      count++;
    }
    await db.put("data", [...records.values()], prefix(kind));
  }
  await db.put("data", imported, prefix("device-imports"));
  await stageAll();
  await flushAccount();
  return count;
}
export async function initialiseAccount() {
  try {
    const result = await accountRequest("/api/auth/status", {
      signal: AbortSignal.timeout(5000),
    });
    update({ ...result, message: "", syncing: false, conflicts: [] });
    if (state.user)
      localStorage.setItem("kwest-account-cache", JSON.stringify(result));
    else localStorage.removeItem("kwest-account-cache");
    if (state.user) {
      await stageAll();
      await flushAccount();
      await pullCloud();
    }
  } catch (error: any) {
    try {
      const cached = JSON.parse(
        localStorage.getItem("kwest-account-cache") || "null",
      );
      if (cached?.user)
        update({
          ...cached,
          message:
            "Using saved data on this device. Cloud sync will resume when available.",
        });
      else
        update({
          message:
            "Using data on this device. Accounts are unavailable right now.",
        });
    } catch {
      update({ message: "Accounts are unavailable right now." });
    }
  }
  window.addEventListener("online", () => void flushAccount());
  // Existing Strava uploads must never fall back to a guest connection after an account expires.
  globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (
      state.user &&
      new URL(request.url).origin === location.origin &&
      new URL(request.url).pathname.startsWith("/api/strava/")
    ) {
      const headers = new Headers(request.headers);
      headers.set("X-Kwest-Account", state.user.id);
      return nativeFetch(new Request(request, { headers }));
    }
    return nativeFetch(request);
  };
}
export async function accountAction(path: string, input: any = {}) {
  return accountRequest("/api/auth/" + path, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
