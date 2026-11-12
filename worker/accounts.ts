import { validProgramme } from "../src/programmeValidation";
export type AccountEnv = {
  DB?: any;
  APP_ORIGIN?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
};
const SESSION = "__Host-kwest-session",
  STATE = "__Host-kwest-oauth",
  DAY = 86400000;
const origin = (env: AccountEnv) => env.APP_ORIGIN || "https://kwest.fit";
const enc = new TextEncoder();
export const digest = async (value: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
const readCookie = (r: Request, name: string) =>
  r.headers
    .get("Cookie")
    ?.split(";")
    .map((x) => x.trim())
    .find((x) => x.startsWith(name + "="))
    ?.slice(name.length + 1);
const cookie = (name: string, value: string, seconds: number) =>
  `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${seconds}`;
const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const json = (value: unknown, status = 200, extra?: HeadersInit) =>
  Response.json(value, { status, headers: { ...headers, ...extra } });
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
function fail(status: number, message: string): never {
  throw new HttpError(status, message);
}
async function body(r: Request, limit = 8192): Promise<any> {
  if (!r.headers.get("Content-Type")?.startsWith("application/json"))
    fail(415, "JSON required.");
  if (Number(r.headers.get("Content-Length")) > limit)
    fail(413, "Request too large.");
  const reader = r.body?.getReader();
  if (!reader) fail(400, "Missing request.");
  let length = 0;
  const parts: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > limit) {
      await reader.cancel();
      fail(413, "Request too large.");
    }
    parts.push(value);
  }
  const bytes = new Uint8Array(length);
  let i = 0;
  for (const p of parts) {
    bytes.set(p, i);
    i += p.length;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    fail(400, "Invalid JSON.");
  }
}
async function passwordHash(password: string, salt: string) {
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return Array.from(
    new Uint8Array(
      await crypto.subtle.deriveBits(
        {
          name: "PBKDF2",
          salt: enc.encode(salt),
          iterations: 100000,
          hash: "SHA-256",
        },
        key,
        256,
      ),
    ),
    (v) => v.toString(16).padStart(2, "0"),
  ).join("");
}
function same(a: string, b: string) {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}
function email(value: unknown) {
  if (
    typeof value !== "string" ||
    value.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
  )
    fail(400, "Enter a valid email address.");
  return value.trim().toLowerCase();
}
function password(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length < 12 || value.length > 128)
    fail(400, "Use a password with 12 to 128 characters.");
}
async function rate(r: Request, env: AccountEnv, scope: string) {
  const bucket = await digest(
    scope +
      "|" +
      (r.headers.get("CF-Connecting-IP") || "local") +
      "|" +
      Math.floor(Date.now() / (15 * 60000)),
  );
  const row = await env.DB.prepare(
    "INSERT INTO fit_auth_limits(bucket,attempts,expires_at) VALUES(?,1,?) ON CONFLICT(bucket) DO UPDATE SET attempts=attempts+1 RETURNING attempts",
  )
    .bind(bucket, Date.now() + 15 * 60000)
    .first();
  if (row.attempts > 20)
    fail(429, "Too many attempts. Try again in 15 minutes.");
}
export async function accountUser(
  r: Request,
  env: AccountEnv,
): Promise<{ id: string; name: string; email: string | null } | null> {
  const token = readCookie(r, SESSION);
  if (!env.DB || !token || !/^[a-f0-9]{64}$/.test(token)) return null;
  return env.DB.prepare(
    "SELECT fit_users.id,fit_users.name,fit_users.email FROM fit_sessions JOIN fit_users ON fit_users.id=fit_sessions.user_id WHERE token_hash=? AND expires_at>?",
  )
    .bind(await digest(token), Date.now())
    .first();
}
async function issueSession(env: AccountEnv, userId: string) {
  const token = random();
  await env.DB.prepare(
    "INSERT INTO fit_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)",
  )
    .bind(await digest(token), userId, Date.now() + 30 * DAY)
    .run();
  return cookie(SESSION, token, 30 * 86400);
}
function providers(env: AccountEnv) {
  return {
    google: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET),
    strava: !!(env.STRAVA_CLIENT_ID && env.STRAVA_CLIENT_SECRET),
  };
}
const redirect = (env: AccountEnv, success: boolean, cookies: string[]) => {
  const h = new Headers({
    ...headers,
    Location: origin(env) + "/?account=1&auth=" + (success ? "ok" : "error"),
  });
  for (const c of cookies) h.append("Set-Cookie", c);
  return new Response(null, { status: 303, headers: h });
};
async function remote(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    signal: AbortSignal.timeout(15000),
    redirect: "manual",
  });
  if (!response.ok) fail(502, "Sign-in provider is unavailable.");
  return response.json() as Promise<any>;
}
async function oauth(
  r: Request,
  env: AccountEnv,
  provider: "google" | "strava",
  callback: boolean,
): Promise<Response> {
  if (r.method !== (callback ? "GET" : "POST"))
    fail(405, "Method not allowed.");
  if (!providers(env)[provider])
    fail(503, "This sign-in provider is not configured.");
  const callbackUrl = origin(env) + `/api/auth/${provider}/callback`;
  if (!callback) {
    await rate(r, env, "oauth");
    const input = await body(r),
      user = await accountUser(r, env);
    if (input.link && !user) fail(401, "Sign in first.");
    if (user && !input.link) fail(409, "Sign out before switching accounts.");
    const state = random(),
      browser = random(),
      verifier = random(),
      challenge = btoa(
        String.fromCharCode(
          ...new Uint8Array(
            await crypto.subtle.digest("SHA-256", enc.encode(verifier)),
          ),
        ),
      )
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    await env.DB.prepare(
      "INSERT INTO fit_oauth_transactions(state_hash,browser_hash,provider,verifier,link_user_id,expires_at) VALUES(?,?,?,?,?,?)",
    )
      .bind(
        await digest(state),
        await digest(browser),
        provider,
        verifier,
        input.link ? user!.id : null,
        Date.now() + 600000,
      )
      .run();
    const url = new URL(
      provider === "google"
        ? "https://accounts.google.com/o/oauth2/v2/auth"
        : "https://www.strava.com/oauth/authorize",
    );
    url.search = new URLSearchParams({
      client_id: (provider === "google"
        ? env.GOOGLE_CLIENT_ID
        : env.STRAVA_CLIENT_ID)!,
      redirect_uri: callbackUrl,
      response_type: "code",
      scope: provider === "google" ? "openid email profile" : "read",
      state,
      ...(provider === "google"
        ? { code_challenge: challenge, code_challenge_method: "S256" }
        : { approval_prompt: "auto" }),
    }).toString();
    return json({ url: url.href }, 200, {
      "Set-Cookie": cookie(STATE, browser, 600),
    });
  }
  const url = new URL(r.url),
    state = url.searchParams.get("state"),
    browser = readCookie(r, STATE),
    code = url.searchParams.get("code");
  if (!state || !browser || !code || state.length > 128 || code.length > 4096)
    fail(400, "Invalid sign-in callback.");
  const transaction = await env.DB.prepare(
    "DELETE FROM fit_oauth_transactions WHERE state_hash=? AND browser_hash=? AND provider=? AND expires_at>? RETURNING *",
  )
    .bind(await digest(state), await digest(browser), provider, Date.now())
    .first();
  if (!transaction) fail(400, "Sign-in expired. Try again.");
  const current = await accountUser(r, env);
  if (transaction.link_user_id && current?.id !== transaction.link_user_id)
    fail(401, "Sign in again before linking this provider.");
  const token = await remote(
    provider === "google"
      ? "https://oauth2.googleapis.com/token"
      : "https://www.strava.com/oauth/token",
    {
      method: "POST",
      body: new URLSearchParams({
        client_id: (provider === "google"
          ? env.GOOGLE_CLIENT_ID
          : env.STRAVA_CLIENT_ID)!,
        client_secret: (provider === "google"
          ? env.GOOGLE_CLIENT_SECRET
          : env.STRAVA_CLIENT_SECRET)!,
        grant_type: "authorization_code",
        code,
        redirect_uri: callbackUrl,
        ...(provider === "google"
          ? { code_verifier: transaction.verifier }
          : {}),
      }),
    },
  );
  if (typeof token.access_token !== "string")
    fail(502, "Invalid provider response.");
  const profile = await remote(
    provider === "google"
      ? "https://openidconnect.googleapis.com/v1/userinfo"
      : "https://www.strava.com/api/v3/athlete",
    { headers: { Authorization: "Bearer " + token.access_token } },
  );
  const subject =
    provider === "google"
      ? profile.sub
      : Number.isSafeInteger(profile.id) && profile.id > 0
        ? String(profile.id)
        : null;
  if (typeof subject !== "string" || !subject || subject.length > 256)
    fail(502, "Invalid provider identity.");
  const identity = await env.DB.prepare(
    "SELECT user_id FROM fit_identities WHERE provider=? AND subject=?",
  )
    .bind(provider, subject)
    .first();
  if (
    transaction.link_user_id &&
    identity &&
    identity.user_id !== transaction.link_user_id
  )
    fail(409, "This sign-in belongs to another account.");
  let userId = identity?.user_id || transaction.link_user_id;
  if (!userId) {
    userId = crypto.randomUUID();
    const name = String(
        provider === "google"
          ? profile.name || "Google user"
          : profile.firstname || "Strava athlete",
      ).slice(0, 80),
      address =
        provider === "google" &&
        profile.email_verified === true &&
        typeof profile.email === "string"
          ? profile.email.slice(0, 254)
          : null;
    try {
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO fit_users(id,name,email,created_at) VALUES(?,?,?,?)",
        ).bind(userId, name, address, Date.now()),
        env.DB.prepare(
          "INSERT INTO fit_identities(provider,subject,user_id) VALUES(?,?,?)",
        ).bind(provider, subject, userId),
      ]);
    } catch {
      const raced = await env.DB.prepare(
        "SELECT user_id FROM fit_identities WHERE provider=? AND subject=?",
      )
        .bind(provider, subject)
        .first();
      if (!raced) fail(409, "Unable to connect this sign-in.");
      userId = raced.user_id;
    }
  } else if (!identity) {
    try {
      await env.DB.prepare(
        "INSERT INTO fit_identities(provider,subject,user_id) VALUES(?,?,?)",
      )
        .bind(provider, subject, userId)
        .run();
    } catch {
      fail(409, "This provider is already linked to an account.");
    }
  }
  const oldToken = readCookie(r, SESSION);
  if (oldToken)
    await env.DB.prepare("DELETE FROM fit_sessions WHERE token_hash=?")
      .bind(await digest(oldToken))
      .run();
  return redirect(env, true, [
    await issueSession(env, userId),
    cookie(STATE, "", 0),
  ]);
}
async function auth(
  r: Request,
  env: AccountEnv,
  path: string,
): Promise<Response> {
  if (path === "/api/auth/status") {
    if (r.method !== "GET") fail(405, "Method not allowed.");
    const user = await accountUser(r, env);
    const linked = user
      ? (
          await env.DB.prepare(
            "SELECT provider FROM fit_identities WHERE user_id=?",
          )
            .bind(user.id)
            .all()
        ).results.map((x: any) => x.provider)
      : [];
    const local = user
      ? !!(await env.DB.prepare(
          "SELECT user_id FROM fit_credentials WHERE user_id=?",
        )
          .bind(user.id)
          .first())
      : false;
    return json({
      configured: true,
      user,
      providers: providers(env),
      linked,
      local,
    });
  }
  const match = path.match(/^\/api\/auth\/(google|strava)\/(start|callback)$/);
  if (match) return oauth(r, env, match[1] as any, match[2] === "callback");
  if (r.method !== "POST") fail(405, "Method not allowed.");
  if (path === "/api/auth/register" || path === "/api/auth/login") {
    await rate(r, env, "password");
    const data = await body(r),
      address = email(data.email);
    password(data.password);
    if (path.endsWith("register")) {
      const name = typeof data.name === "string" ? data.name.trim() : "";
      if (!name || name.length > 80)
        fail(400, "Enter a name with up to 80 characters.");
      const id = crypto.randomUUID(),
        salt = random(),
        hash = await passwordHash(data.password, salt);
      try {
        await env.DB.batch([
          env.DB.prepare(
            "INSERT INTO fit_users(id,name,email,created_at) VALUES(?,?,?,?)",
          ).bind(id, name, address, Date.now()),
          env.DB.prepare(
            "INSERT INTO fit_credentials(email,user_id,salt,password_hash) VALUES(?,?,?,?)",
          ).bind(address, id, salt, hash),
        ]);
      } catch {
        fail(409, "Unable to create an account with these details.");
      }
      return json({ ok: true }, 201, {
        "Set-Cookie": await issueSession(env, id),
      });
    }
    const credential = await env.DB.prepare(
      "SELECT * FROM fit_credentials WHERE email=?",
    )
      .bind(address)
      .first();
    const hash = await passwordHash(
      data.password,
      credential?.salt || "kwest-dummy-salt",
    );
    if (!credential || !same(hash, credential.password_hash))
      fail(401, "Email or password is incorrect.");
    return json({ ok: true }, 200, {
      "Set-Cookie": await issueSession(env, credential.user_id),
    });
  }
  const user = await accountUser(r, env);
  if (!user) fail(401, "Sign in first.");
  if (path === "/api/auth/logout") {
    const token = readCookie(r, SESSION);
    await env.DB.prepare("DELETE FROM fit_sessions WHERE token_hash=?")
      .bind(await digest(token!))
      .run();
    return json({ ok: true }, 200, { "Set-Cookie": cookie(SESSION, "", 0) });
  }
  if (path === "/api/auth/profile") {
    const data = await body(r);
    if (
      typeof data.name !== "string" ||
      !data.name.trim() ||
      data.name.trim().length > 80
    )
      fail(400, "Enter a valid name.");
    await env.DB.prepare("UPDATE fit_users SET name=? WHERE id=?")
      .bind(data.name.trim(), user.id)
      .run();
    return json({ ok: true });
  }
  if (path === "/api/auth/password") {
    await rate(r, env, "password-change");
    const data = await body(r);
    password(data.password);
    password(data.currentPassword);
    const current = await env.DB.prepare(
      "SELECT * FROM fit_credentials WHERE user_id=?",
    )
      .bind(user.id)
      .first();
    if (
      !current ||
      !same(
        await passwordHash(data.currentPassword, current.salt),
        current.password_hash,
      )
    )
      fail(401, "Current password is incorrect.");
    const salt = random(),
      hash = await passwordHash(data.password, salt),
      token = readCookie(r, SESSION)!;
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE fit_credentials SET salt=?,password_hash=? WHERE user_id=?",
      ).bind(salt, hash, user.id),
      env.DB.prepare(
        "DELETE FROM fit_sessions WHERE user_id=? AND token_hash<>?",
      ).bind(user.id, await digest(token)),
    ]);
    return json({ ok: true });
  }
  fail(404, "Not found.");
}
function validRecord(kind: string, id: string, value: any) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (kind === "programmes") return value.id === id && validProgramme(value);
  if (kind === "settings")
    return id === "preferences" && ["km", "mi"].includes(value.units);
  if (kind === "history")
    return (
      value.id === id &&
      validProgramme(value.programme) &&
      Number.isFinite(value.started) &&
      value.started >= 0 &&
      Number.isFinite(value.elapsed) &&
      value.elapsed >= 0 &&
      typeof value.status === "string" &&
      value.status.length <= 40 &&
      Array.isArray(value.samples) &&
      value.samples.length <= 21600 &&
      value.samples.every(
        (s: any) =>
          s &&
          Number.isFinite(s.at) &&
          ["speed", "power", "distance", "resistance"].every(
            (key) =>
              s[key] === null ||
              s[key] === undefined ||
              Number.isFinite(s[key]),
          ),
      ) &&
      Array.isArray(value.events) &&
      value.events.length <= 1000 &&
      value.events.every((s: any) => typeof s === "string" && s.length <= 2000)
    );
  return false;
}
async function compress(text: string) {
  return new Uint8Array(
    await new Response(
      new Blob([text]).stream().pipeThrough(new CompressionStream("gzip")),
    ).arrayBuffer(),
  );
}
async function unpack(bytes: any) {
  return JSON.parse(
    await new Response(
      new Blob([new Uint8Array(bytes)])
        .stream()
        .pipeThrough(new DecompressionStream("gzip")),
    ).text(),
  );
}
async function data(
  r: Request,
  env: AccountEnv,
  path: string,
): Promise<Response> {
  const user = await accountUser(r, env);
  if (!user) fail(401, "Sign in to sync your data.");
  if (path === "/api/data" && r.method === "GET") {
    const cursor = new URL(r.url).searchParams.get("cursor") || "";
    if (cursor.length > 300) fail(400, "Invalid cursor.");
    const rows = (
      await env.DB.prepare(
        "SELECT record_key,revision,deleted,updated_at FROM fit_records WHERE user_id=? AND record_key>? ORDER BY record_key LIMIT 50",
      )
        .bind(user.id, cursor)
        .all()
    ).results;
    return json({
      records: rows,
      next: rows.length === 50 ? rows.at(-1).record_key : null,
    });
  }
  const match = path.match(
    /^\/api\/data\/(programmes|history|settings)\/(.+)$/,
  );
  if (!match) fail(404, "Not found.");
  const kind = match[1],
    id = decodeURIComponent(match[2]);
  if (!id || id.length > 256 || /[\u0000-\u001f]/.test(id))
    fail(400, "Invalid record ID.");
  const key = kind + ":" + id;
  if (r.method === "GET") {
    const row = await env.DB.prepare(
      "SELECT revision,payload,deleted FROM fit_records WHERE user_id=? AND record_key=?",
    )
      .bind(user.id, key)
      .first();
    if (!row || row.deleted) fail(404, "Record not found.");
    return json({ revision: row.revision, value: await unpack(row.payload) });
  }
  if (!["PUT", "DELETE"].includes(r.method)) fail(405, "Method not allowed.");
  const input = await body(r, 5 * 1024 * 1024);
  if (!Number.isSafeInteger(input.revision) || input.revision < 0)
    fail(400, "Invalid revision.");
  const deleted = r.method === "DELETE";
  if (!deleted && !validRecord(kind, id, input.value))
    fail(400, "Invalid record.");
  const payload = deleted ? null : await compress(JSON.stringify(input.value));
  if (payload && payload.byteLength > 1500000)
    fail(413, "Record is too large to sync. Export a backup to keep it safe.");
  const row =
    input.revision === 0
      ? await env.DB.prepare(
          "INSERT OR IGNORE INTO fit_records(user_id,record_key,revision,payload,deleted,updated_at) VALUES(?,?,1,?,?,?) RETURNING revision",
        )
          .bind(
            user.id,
            key,
            payload ? Array.from(payload) : null,
            deleted ? 1 : 0,
            Date.now(),
          )
          .first()
      : await env.DB.prepare(
          "UPDATE fit_records SET revision=revision+1,payload=?,deleted=?,updated_at=? WHERE user_id=? AND record_key=? AND revision=? RETURNING revision",
        )
          .bind(
            payload ? Array.from(payload) : null,
            deleted ? 1 : 0,
            Date.now(),
            user.id,
            key,
            input.revision,
          )
          .first();
  if (!row)
    return json(
      {
        error:
          "This record changed on another device. Your local copy is preserved.",
        conflict: true,
      },
      409,
    );
  return json({ revision: row.revision });
}
export async function accountsHandler(
  r: Request,
  env: AccountEnv,
): Promise<Response> {
  const path = new URL(r.url).pathname,
    callback = /^\/api\/auth\/(google|strava)\/callback$/.test(path);
  try {
    if (!env.DB)
      return path === "/api/auth/status"
        ? json({
            configured: false,
            user: null,
            providers: { google: false, strava: false },
            linked: [],
            local: false,
          })
        : json({ error: "Accounts are temporarily unavailable." }, 503);
    if (!["GET", "POST", "PUT", "DELETE"].includes(r.method))
      fail(405, "Method not allowed.");
    if (r.method !== "GET" && r.headers.get("Origin") !== origin(env))
      fail(403, "Invalid request origin.");
    if (
      r.method !== "GET" &&
      !r.headers.get("Content-Type")?.startsWith("application/json")
    )
      fail(415, "JSON required.");
    if (
      r.method === "GET" &&
      path.startsWith("/api/auth/") &&
      !callback &&
      path !== "/api/auth/status"
    )
      fail(405, "Method not allowed.");
    return await (path.startsWith("/api/auth/")
      ? auth(r, env, path)
      : data(r, env, path));
  } catch (error) {
    if (callback) {
      console.warn(
        "OAuth callback failed",
        error instanceof HttpError ? error.message : "Internal error",
      );
      return redirect(env, false, [cookie(STATE, "", 0)]);
    }
    if (error instanceof HttpError)
      return json({ error: error.message }, error.status);
    console.error("Account request failed");
    return json({ error: "Account service is temporarily unavailable." }, 503);
  }
}
