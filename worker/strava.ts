export type StravaEnv = {
  STRAVA_CLIENT_ID?: string;
  STRAVA_CLIENT_SECRET?: string;
  STRAVA_SESSIONS?: any;
};
const origin = "https://kwest.fit",
  cookie = "__Host-fit-strava",
  api = "https://www.strava.com/api/v3";
const json = (v: unknown, status = 200) =>
  Response.json(v, { status, headers: { "Cache-Control": "no-store" } });
const random = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) =>
    v.toString(16).padStart(2, "0"),
  ).join("");
const cookieValue = (r: Request) =>
  r.headers
    .get("Cookie")
    ?.split(";")
    .map((v) => v.trim())
    .find((v) => v.startsWith(cookie + "="))
    ?.slice(cookie.length + 1);
const configured = (e: StravaEnv) =>
  !!(e.STRAVA_CLIENT_ID && e.STRAVA_CLIENT_SECRET && e.STRAVA_SESSIONS);
export async function stravaHandler(
  r: Request,
  env: StravaEnv,
): Promise<Response> {
  const path = new URL(r.url).pathname;
  if (
    ![
      "/api/strava/status",
      "/api/strava/connect",
      "/api/strava/callback",
      "/api/strava/disconnect",
      "/api/strava/upload",
      "/api/strava/poll",
    ].includes(path)
  )
    return json({ error: "Not found" }, 404);
  if (path === "/api/strava/callback" && r.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  if (!["/api/strava/callback", "/api/strava/status"].includes(path)) {
    if (r.method !== "POST") return json({ error: "Method not allowed" }, 405);
    if (r.headers.get("Origin") !== origin)
      return json({ error: "Invalid request origin" }, 403);
    if (!r.headers.get("Content-Type")?.startsWith("application/json"))
      return json({ error: "JSON required" }, 415);
  } else if (path.endsWith("/status") && r.method !== "GET")
    return json({ error: "Method not allowed" }, 405);
  if (!configured(env))
    return path.endsWith("/status")
      ? json({ configured: false, connected: false })
      : json({ error: "Strava is not configured yet." }, 503);
  let id = cookieValue(r),
    fresh = false;
  if (!id || !/^[a-f0-9]{64}$/.test(id)) {
    if (path.endsWith("/connect")) {
      id = random();
      fresh = true;
    } else if (path.endsWith("/status"))
      return json({ configured: true, connected: false });
    else return json({ error: "Connect Strava first." }, 401);
  }
  const stub = env.STRAVA_SESSIONS.get(env.STRAVA_SESSIONS.idFromName(id));
  const headers = new Headers(r.headers);
  headers.delete("Cookie");
  const response = await stub.fetch(
    new Request(
      "https://session.internal" +
        new URL(r.url).pathname +
        new URL(r.url).search,
      {
        method: r.method,
        headers,
        body: r.method === "POST" ? r.body : undefined,
        duplex: "half",
      } as RequestInit,
    ),
  );
  const out = new Headers(response.headers);
  if (fresh)
    out.set(
      "Set-Cookie",
      `${cookie}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`,
    );
  if (path.endsWith("/disconnect"))
    out.set(
      "Set-Cookie",
      `${cookie}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
    );
  out.set("Referrer-Policy", "no-referrer");
  out.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers: out });
}
type Token = {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete?: { id: number; firstname?: string };
};
type Job = {
  state:
    "uploading" | "processing" | "synced" | "error" | "uncertain" | "retry";
  uploadId?: number;
  activityId?: number;
  message?: string;
  retryAfter?: number;
};
class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
async function remote(url: string, init: RequestInit) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(20000),
    redirect: "manual",
  });
}
async function boundedJson(r: Request) {
  if (Number(r.headers.get("Content-Length")) > 8 * 1024 * 1024)
    throw new ApiError(413, "Workout too large.");
  const reader = r.body?.getReader();
  if (!reader) throw new ApiError(400, "Missing workout.");
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 8 * 1024 * 1024) {
      await reader.cancel();
      throw new ApiError(413, "Workout too large.");
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "Invalid JSON.");
  }
}
export class StravaSession {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    private ctx: any,
    private env: StravaEnv,
  ) {}
  fetch(r: Request): Promise<Response> {
    const task = this.tail.then(() => this.handle(r));
    this.tail = task.catch(() => {});
    return task;
  }
  private async token(): Promise<Token> {
    const t = (await this.ctx.storage.get("token")) as Token | undefined;
    if (!t) throw new ApiError(401, "Connect Strava first.");
    if (t.expires_at > Date.now() / 1000 + 90) return t;
    const res = await remote("https://www.strava.com/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.env.STRAVA_CLIENT_ID!,
        client_secret: this.env.STRAVA_CLIENT_SECRET!,
        grant_type: "refresh_token",
        refresh_token: t.refresh_token,
      }),
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        await this.ctx.storage.delete("token");
        throw new ApiError(
          401,
          "Strava access expired. Reconnect your account.",
        );
      }
      throw new ApiError(
        res.status === 429 ? 429 : 502,
        "Strava token refresh is temporarily unavailable.",
      );
    }
    const refreshed = (await res.json()) as Token;
    if (
      !refreshed.access_token ||
      !refreshed.refresh_token ||
      !Number.isFinite(refreshed.expires_at)
    )
      throw new ApiError(502, "Invalid Strava token response.");
    const next = { ...refreshed, athlete: t.athlete };
    await this.ctx.storage.put("token", next);
    return next;
  }
  private async handle(r: Request): Promise<Response> {
    try {
      const url = new URL(r.url),
        path = url.pathname;
      if (path.endsWith("/status")) {
        const t = (await this.ctx.storage.get("token")) as Token | undefined;
        return json({
          configured: true,
          connected: !!t,
          athlete: t?.athlete
            ? {
                id: t.athlete.id,
                name: t.athlete.firstname ?? "Strava athlete",
              }
            : undefined,
        });
      }
      if (path.endsWith("/connect")) {
        const state = random();
        await this.ctx.storage.put("oauth", {
          state,
          expires: Date.now() + 10 * 60 * 1000,
        });
        const auth = new URL("https://www.strava.com/oauth/authorize");
        auth.search = new URLSearchParams({
          client_id: this.env.STRAVA_CLIENT_ID!,
          redirect_uri: origin + "/api/strava/callback",
          response_type: "code",
          approval_prompt: "auto",
          scope: "read,activity:write",
          state,
        }).toString();
        return json({ url: auth.href });
      }
      if (path.endsWith("/callback")) {
        const state = (await this.ctx.storage.get("oauth")) as
          { state: string; expires: number } | undefined;
        if (
          !state ||
          state.state !== url.searchParams.get("state") ||
          state.expires < Date.now()
        )
          return new Response(
            "Strava authorisation expired. Return to kwest.fit and connect again.",
            { status: 400 },
          );
        await this.ctx.storage.delete("oauth");
        const scopes = (url.searchParams.get("scope") ?? "").split(",");
        if (
          url.searchParams.get("error") ||
          !url.searchParams.get("code") ||
          !scopes.includes("activity:write")
        )
          return Response.redirect(origin + "/?strava=denied", 303);
        const res = await remote("https://www.strava.com/oauth/token", {
          method: "POST",
          body: new URLSearchParams({
            client_id: this.env.STRAVA_CLIENT_ID!,
            client_secret: this.env.STRAVA_CLIENT_SECRET!,
            code: url.searchParams.get("code")!,
            grant_type: "authorization_code",
          }),
        });
        if (!res.ok) return Response.redirect(origin + "/?strava=failed", 303);
        const token = (await res.json()) as Token;
        if (
          !token.access_token ||
          !token.refresh_token ||
          !Number.isFinite(token.expires_at) ||
          !token.athlete?.id
        )
          throw new ApiError(502, "Invalid Strava authorisation response.");
        await this.ctx.storage.put("token", token);
        return Response.redirect(origin + "/?strava=connected", 303);
      }
      if (path.endsWith("/disconnect")) {
        let revoked = false;
        try {
          const t = await this.token();
          const res = await remote("https://www.strava.com/oauth/deauthorize", {
            method: "POST",
            headers: { Authorization: `Bearer ${t.access_token}` },
          });
          revoked = res.ok;
        } catch {
          // Clear this browser connection even if Strava cannot confirm revocation.
        } finally {
          await this.ctx.storage.deleteAll();
        }
        return json({ connected: false, revoked });
      }
      const input = await boundedJson(r);
      if (
        typeof input.id !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id)
      )
        throw new ApiError(400, "Invalid workout ID.");
      const t = await this.token(),
        key = `job:${t.athlete!.id}:${input.id}`;
      let job = (await this.ctx.storage.get(key)) as Job | undefined;
      if (path.endsWith("/poll")) {
        if (!job) throw new ApiError(404, "Upload not found.");
        if (job.state !== "processing" || !job.uploadId) return json(job);
        const res = await remote(`${api}/uploads/${job.uploadId}`, {
          headers: { Authorization: `Bearer ${t.access_token}` },
        });
        if (res.status === 401) {
          await this.ctx.storage.delete("token");
          throw new ApiError(401, "Reconnect Strava to check this upload.");
        }
        if (res.status === 429)
          return json({
            ...job,
            message: "Strava rate limit. Checking again later.",
            retryAfter: Date.now() + 15 * 60 * 1000,
          });
        if (!res.ok)
          throw new ApiError(
            res.status === 401 ? 401 : 502,
            "Could not check Strava processing. Try again later.",
          );
        const data = (await res.json()) as any;
        job = data.activity_id
          ? {
              ...job,
              state: "synced",
              activityId: data.activity_id,
              message: undefined,
            }
          : data.error
            ? {
                ...job,
                state: "error",
                message:
                  "Strava rejected this file: " +
                  String(data.error).slice(0, 250),
              }
            : job;
        await this.ctx.storage.put(key, job);
        return json(job);
      }
      if (
        job &&
        !(job.state === "retry" && (job.retryAfter ?? 0) <= Date.now())
      )
        return json(
          job.state === "uploading"
            ? {
                state: "uncertain",
                message:
                  "Upload confirmation was interrupted. Check Strava before uploading again.",
              }
            : job,
        );
      if (
        input.demo ||
        typeof input.tcx !== "string" ||
        !input.tcx.startsWith("<?xml") ||
        !input.tcx.includes("<TrainingCenterDatabase") ||
        typeof input.name !== "string" ||
        input.name.length > 160 ||
        !["Run", "Ride", "Rowing"].includes(input.sport)
      )
        throw new ApiError(400, "Invalid workout. Demo sessions cannot sync.");
      await this.ctx.storage.put(key, { state: "uploading" });
      const form = new FormData();
      form.set(
        "file",
        new Blob([input.tcx], { type: "application/vnd.garmin.tcx+xml" }),
        `smart-fit-${input.id}.tcx`,
      );
      form.set("data_type", "tcx");
      form.set("sport_type", input.sport);
      form.set("trainer", "1");
      form.set("external_id", `smart-fit-${input.id}.tcx`);
      form.set("name", input.name);
      form.set("description", "Indoor workout recorded with kwest.fit.");
      try {
        const res = await remote(`${api}/uploads`, {
          method: "POST",
          headers: { Authorization: `Bearer ${t.access_token}` },
          body: form,
        });
        if (res.status === 401) {
          await this.ctx.storage.delete("token");
          await this.ctx.storage.put(key, {
            state: "retry",
            retryAfter: Date.now(),
            message: "Reconnect Strava to retry this rejected request.",
          });
          throw new ApiError(401, "Reconnect Strava to continue syncing.");
        }
        if (res.status === 429)
          job = {
            state: "retry",
            message: "Strava rate limit. Retry after 15 minutes.",
            retryAfter: Date.now() + 15 * 60 * 1000,
          };
        else if (!res.ok)
          job = {
            state: res.status >= 500 ? "uncertain" : "error",
            message:
              res.status === 401
                ? "Strava access rejected. Reconnect your account."
                : res.status >= 500
                  ? "Upload confirmation failed. Check Strava before retrying."
                  : "Strava rejected this upload. It may already exist on Strava.",
          };
        else {
          const data = (await res.json()) as any;
          job = data.id
            ? { state: "processing", uploadId: data.id }
            : {
                state: "uncertain",
                message: "Upload response was incomplete. Check Strava.",
              };
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        job = {
          state: "uncertain",
          message:
            "Upload confirmation was interrupted. Check Strava before uploading again.",
        };
      }
      await this.ctx.storage.put(key, job);
      return json(job);
    } catch (e) {
      return json(
        {
          error:
            e instanceof ApiError
              ? e.message
              : "Strava is temporarily unavailable. Try again later.",
        },
        e instanceof ApiError ? e.status : 502,
      );
    }
  }
}
