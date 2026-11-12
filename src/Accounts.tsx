import { useEffect, useState } from "react";
import type { ReactNode, FormEvent } from "react";
import {
  accountState,
  subscribeAccount,
  initialiseAccount,
  accountAction,
  syncAndReload,
  importDeviceData,
  resolveAccountConflicts,
} from "./accountClient";
export function AccountBootstrap({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    void initialiseAccount().finally(() => setReady(true));
  }, []);
  return ready ? (
    <>{children}</>
  ) : (
    <main className="account-loading">
      <img src="/logo.svg" width="44" height="44" alt="" />
      <p>Opening kwest.fit…</p>
    </main>
  );
}
export function AccountPanel({ disabled = false }: { disabled?: boolean }) {
  const [account, setAccount] = useState(accountState),
    [mode, setMode] = useState<"login" | "register">("login"),
    [working, setWorking] = useState(false),
    [error, setError] = useState(
      new URL(location.href).searchParams.get("auth") === "error"
        ? "Sign-in could not be completed. Please try again."
        : "",
    );
  useEffect(() => subscribeAccount(() => setAccount(accountState())), []);
  async function action(fn: () => Promise<any>) {
    setError("");
    setWorking(true);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Try again.");
    } finally {
      setWorking(false);
    }
  }
  const locked = disabled || working;
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    await action(async () => {
      await accountAction(mode, Object.fromEntries(data));
      location.reload();
    });
  }
  async function oauth(provider: "google" | "strava", link = false) {
    await action(async () => {
      const result = await accountAction(provider + "/start", { link });
      const url = new URL(result.url);
      if (
        url.origin !==
        (provider === "google"
          ? "https://accounts.google.com"
          : "https://www.strava.com")
      )
        throw Error("Invalid sign-in link.");
      location.assign(url.href);
    });
  }
  const user = account.user;
  return (
    <section className="settings-group account-panel">
      <h2>Account</h2>
      {disabled && (
        <p className="subtle">Finish your workout before changing accounts.</p>
      )}
      {!account.configured ? (
        <p className="subtle">
          Accounts are temporarily unavailable. You can keep using data on this
          device.
        </p>
      ) : user ? (
        <>
          <p>
            <strong>{user.name}</strong>
            {user.email && (
              <>
                <br />
                <span className="subtle">{user.email}</span>
              </>
            )}
          </p>
          <p role="status" className="subtle">
            {account.syncing
              ? "Saving changes…"
              : account.message ||
                "Your programmes and history sync across devices."}
          </p>
          <div className="actions">
            <button
              disabled={locked || account.syncing}
              onClick={() => void action(syncAndReload)}
            >
              Sync now
            </button>
            <button
              disabled={locked}
              onClick={() =>
                void action(async () => {
                  await accountAction("logout");
                  localStorage.removeItem("kwest-account-cache");
                  location.reload();
                })
              }
            >
              Sign out
            </button>
          </div>
          {account.conflicts.length > 0 && (
            <div className="account-conflicts">
              <p>
                Export a backup before choosing which version of these items to
                keep.
              </p>
              <ul>
                {account.conflicts.map((key) => (
                  <li key={key}>
                    {key.split(":")[0]} · {key.slice(key.indexOf(":") + 1)}
                  </li>
                ))}
              </ul>
              <div className="actions">
                <button
                  disabled={locked}
                  onClick={() => {
                    if (
                      confirm(
                        "Replace conflicting items on this device with the cloud versions?",
                      )
                    )
                      void action(() => resolveAccountConflicts(false));
                  }}
                >
                  Use cloud version
                </button>
                <button
                  disabled={locked}
                  onClick={() => {
                    if (
                      confirm(
                        "Replace conflicting cloud items with the versions on this device?",
                      )
                    )
                      void action(() => resolveAccountConflicts(true));
                  }}
                >
                  Keep this device’s version
                </button>
              </div>
            </div>
          )}
          <details className="account-options">
            <summary>Account options</summary>
            <button
              disabled={locked}
              onClick={() => {
                if (
                  confirm(
                    "Copy programmes and history from this device’s browser-only profile into this account? The originals will be kept.",
                  )
                )
                  void action(async () => {
                    const count = await importDeviceData();
                    if (count === 0) {
                      setError("No new device data to import.");
                      return;
                    }
                    location.reload();
                  });
              }}
            >
              Import device data
            </button>
            <p className="subtle">
              Import your existing programmes and history. Device originals are
              kept.
            </p>
            {(["google", "strava"] as const)
              .filter(
                (provider) =>
                  account.providers[provider] &&
                  !account.linked.includes(provider),
              )
              .map((provider) => (
                <button
                  key={provider}
                  disabled={locked}
                  onClick={() => void oauth(provider, true)}
                >
                  Link {provider === "google" ? "Google" : "Strava"} sign-in
                </button>
              ))}
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const data = new FormData(e.currentTarget);
                void action(async () => {
                  await accountAction("profile", { name: data.get("name") });
                  location.reload();
                });
              }}
            >
              <fieldset disabled={locked}>
                <label>
                  Your name
                  <input
                    name="name"
                    defaultValue={user.name}
                    required
                    maxLength={80}
                  />
                </label>
                <button type="submit">Save name</button>
              </fieldset>
            </form>
            {account.local && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget,
                    data = new FormData(form);
                  void action(async () => {
                    await accountAction("password", Object.fromEntries(data));
                    form.reset();
                    setError(
                      "Password updated. Other devices have been signed out.",
                    );
                  });
                }}
              >
                <fieldset disabled={locked}>
                  <label>
                    Current password
                    <input
                      name="currentPassword"
                      type="password"
                      autoComplete="current-password"
                      required
                      minLength={12}
                      maxLength={128}
                    />
                  </label>
                  <label>
                    New password
                    <input
                      name="password"
                      type="password"
                      autoComplete="new-password"
                      required
                      minLength={12}
                      maxLength={128}
                    />
                  </label>
                  <button type="submit">Change password</button>
                </fieldset>
              </form>
            )}
          </details>
        </>
      ) : (
        <>
          <p className="subtle">
            Save your programmes and history across devices, or continue using
            this device without an account.
          </p>
          <div className="actions">
            {account.providers.google && (
              <button disabled={locked} onClick={() => void oauth("google")}>
                Sign in with Google
              </button>
            )}
            {account.providers.strava && (
              <button disabled={locked} onClick={() => void oauth("strava")}>
                Sign in with Strava
              </button>
            )}
          </div>
          <details className="account-options">
            <summary>
              {mode === "register" ? "Create an account" : "Sign in with email"}
            </summary>
            <form onSubmit={submit}>
              <fieldset disabled={locked}>
                {mode === "register" && (
                  <label>
                    Your name
                    <input
                      name="name"
                      required
                      maxLength={80}
                      autoComplete="name"
                    />
                  </label>
                )}
                <label>
                  Email
                  <input
                    name="email"
                    type="email"
                    required
                    maxLength={254}
                    autoComplete="email"
                  />
                </label>
                <label>
                  Password
                  <input
                    name="password"
                    type="password"
                    required
                    minLength={12}
                    maxLength={128}
                    autoComplete={
                      mode === "register" ? "new-password" : "current-password"
                    }
                  />
                </label>
                {mode === "register" && (
                  <p className="subtle">
                    Use at least 12 characters. Link Google or Strava after
                    signing in for another way to access your account.
                  </p>
                )}
                <button className="primary" type="submit">
                  {mode === "register" ? "Create account" : "Sign in"}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMode(mode === "login" ? "register" : "login");
                    setError("");
                  }}
                >
                  {mode === "login"
                    ? "Create an account"
                    : "I already have an account"}
                </button>
              </fieldset>
            </form>
          </details>
        </>
      )}
      {error && <p role="status">{error}</p>}
    </section>
  );
}
