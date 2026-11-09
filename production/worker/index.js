var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker/strava.ts
var origin = "https://kwest.fit";
var cookie = "__Host-fit-strava";
var api = "https://www.strava.com/api/v3";
var json = /* @__PURE__ */ __name((v, status = 200) => Response.json(v, { status, headers: { "Cache-Control": "no-store" } }), "json");
var random = /* @__PURE__ */ __name(() => Array.from(
  crypto.getRandomValues(new Uint8Array(32)),
  (v) => v.toString(16).padStart(2, "0")
).join(""), "random");
var cookieValue = /* @__PURE__ */ __name((r) => r.headers.get("Cookie")?.split(";").map((v) => v.trim()).find((v) => v.startsWith(cookie + "="))?.slice(cookie.length + 1), "cookieValue");
var configured = /* @__PURE__ */ __name((e) => !!(e.STRAVA_CLIENT_ID && e.STRAVA_CLIENT_SECRET && e.STRAVA_SESSIONS), "configured");
async function stravaHandler(r, env) {
  const path = new URL(r.url).pathname;
  if (![
    "/api/strava/status",
    "/api/strava/connect",
    "/api/strava/callback",
    "/api/strava/disconnect",
    "/api/strava/upload",
    "/api/strava/poll"
  ].includes(path))
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
    return path.endsWith("/status") ? json({ configured: false, connected: false }) : json({ error: "Strava is not configured yet." }, 503);
  let id = cookieValue(r), fresh = false;
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
      "https://session.internal" + new URL(r.url).pathname + new URL(r.url).search,
      {
        method: r.method,
        redirect: "manual",
        headers,
        body: r.method === "POST" ? r.body : void 0,
        duplex: "half"
      }
    )
  );
  const out = new Headers(response.headers);
  if (fresh)
    out.set(
      "Set-Cookie",
      `${cookie}=${id}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=31536000`
    );
  if (path.endsWith("/disconnect"))
    out.set(
      "Set-Cookie",
      `${cookie}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`
    );
  out.set("Referrer-Policy", "no-referrer");
  out.set("Cache-Control", "no-store");
  return new Response(response.body, { status: response.status, headers: out });
}
__name(stravaHandler, "stravaHandler");
var ApiError = class extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
  status;
  static {
    __name(this, "ApiError");
  }
};
async function remote(url, init) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(2e4),
    redirect: "manual"
  });
}
__name(remote, "remote");
async function boundedJson(r) {
  if (Number(r.headers.get("Content-Length")) > 8 * 1024 * 1024)
    throw new ApiError(413, "Workout too large.");
  const reader = r.body?.getReader();
  if (!reader) throw new ApiError(400, "Missing workout.");
  let text = "", size = 0;
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
__name(boundedJson, "boundedJson");
var StravaSession = class {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }
  ctx;
  env;
  static {
    __name(this, "StravaSession");
  }
  tail = Promise.resolve();
  fetch(r) {
    const task = this.tail.then(() => this.handle(r));
    this.tail = task.catch(() => {
    });
    return task;
  }
  async token() {
    const t = await this.ctx.storage.get("token");
    if (!t) throw new ApiError(401, "Connect Strava first.");
    if (t.expires_at > Date.now() / 1e3 + 90) return t;
    const res = await remote("https://www.strava.com/oauth/token", {
      method: "POST",
      body: new URLSearchParams({
        client_id: this.env.STRAVA_CLIENT_ID,
        client_secret: this.env.STRAVA_CLIENT_SECRET,
        grant_type: "refresh_token",
        refresh_token: t.refresh_token
      })
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        await this.ctx.storage.delete("token");
        throw new ApiError(
          401,
          "Strava access expired. Reconnect your account."
        );
      }
      throw new ApiError(
        res.status === 429 ? 429 : 502,
        "Strava token refresh is temporarily unavailable."
      );
    }
    const refreshed = await res.json();
    if (!refreshed.access_token || !refreshed.refresh_token || !Number.isFinite(refreshed.expires_at))
      throw new ApiError(502, "Invalid Strava token response.");
    const next = { ...refreshed, athlete: t.athlete };
    await this.ctx.storage.put("token", next);
    return next;
  }
  async handle(r) {
    try {
      const url = new URL(r.url), path = url.pathname;
      if (path.endsWith("/status")) {
        const t2 = await this.ctx.storage.get("token");
        return json({
          configured: true,
          connected: !!t2,
          athlete: t2?.athlete ? {
            id: t2.athlete.id,
            name: t2.athlete.firstname ?? "Strava athlete"
          } : void 0
        });
      }
      if (path.endsWith("/connect")) {
        const state = random();
        await this.ctx.storage.put("oauth", {
          state,
          expires: Date.now() + 10 * 60 * 1e3
        });
        const auth = new URL("https://www.strava.com/oauth/authorize");
        auth.search = new URLSearchParams({
          client_id: this.env.STRAVA_CLIENT_ID,
          redirect_uri: origin + "/api/strava/callback",
          response_type: "code",
          approval_prompt: "auto",
          scope: "read,activity:write",
          state
        }).toString();
        return json({ url: auth.href });
      }
      if (path.endsWith("/callback")) {
        const state = await this.ctx.storage.get("oauth");
        if (!state || state.state !== url.searchParams.get("state") || state.expires < Date.now())
          return new Response(
            "Strava authorisation expired. Return to kwest.fit and connect again.",
            { status: 400 }
          );
        await this.ctx.storage.delete("oauth");
        const scopes = (url.searchParams.get("scope") ?? "").split(",");
        if (url.searchParams.get("error") || !url.searchParams.get("code") || !scopes.includes("activity:write"))
          return Response.redirect(origin + "/?strava=denied", 303);
        const res = await remote("https://www.strava.com/oauth/token", {
          method: "POST",
          body: new URLSearchParams({
            client_id: this.env.STRAVA_CLIENT_ID,
            client_secret: this.env.STRAVA_CLIENT_SECRET,
            code: url.searchParams.get("code"),
            grant_type: "authorization_code"
          })
        });
        if (!res.ok) return Response.redirect(origin + "/?strava=failed", 303);
        const token = await res.json();
        if (!token.access_token || !token.refresh_token || !Number.isFinite(token.expires_at) || !token.athlete?.id)
          throw new ApiError(502, "Invalid Strava authorisation response.");
        await this.ctx.storage.put("token", token);
        return Response.redirect(origin + "/?strava=connected", 303);
      }
      if (path.endsWith("/disconnect")) {
        let revoked = false;
        try {
          const t2 = await this.token();
          const res = await remote("https://www.strava.com/oauth/deauthorize", {
            method: "POST",
            headers: { Authorization: `Bearer ${t2.access_token}` }
          });
          revoked = res.ok;
        } catch {
        } finally {
          await this.ctx.storage.deleteAll();
        }
        return json({ connected: false, revoked });
      }
      const input = await boundedJson(r);
      if (typeof input.id !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(input.id))
        throw new ApiError(400, "Invalid workout ID.");
      const t = await this.token(), key = `job:${t.athlete.id}:${input.id}`;
      let job = await this.ctx.storage.get(key);
      if (path.endsWith("/poll")) {
        if (!job) throw new ApiError(404, "Upload not found.");
        if (job.state !== "processing" || !job.uploadId) return json(job);
        const res = await remote(`${api}/uploads/${job.uploadId}`, {
          headers: { Authorization: `Bearer ${t.access_token}` }
        });
        if (res.status === 401) {
          await this.ctx.storage.delete("token");
          throw new ApiError(401, "Reconnect Strava to check this upload.");
        }
        if (res.status === 429)
          return json({
            ...job,
            message: "Strava rate limit. Checking again later.",
            retryAfter: Date.now() + 15 * 60 * 1e3
          });
        if (!res.ok)
          throw new ApiError(
            res.status === 401 ? 401 : 502,
            "Could not check Strava processing. Try again later."
          );
        const data = await res.json();
        job = data.activity_id ? {
          ...job,
          state: "synced",
          activityId: data.activity_id,
          message: void 0
        } : data.error ? {
          ...job,
          state: "error",
          message: "Strava rejected this file: " + String(data.error).slice(0, 250)
        } : job;
        await this.ctx.storage.put(key, job);
        return json(job);
      }
      if (job && !(job.state === "retry" && (job.retryAfter ?? 0) <= Date.now()))
        return json(
          job.state === "uploading" ? {
            state: "uncertain",
            message: "Upload confirmation was interrupted. Check Strava before uploading again."
          } : job
        );
      if (input.demo || typeof input.tcx !== "string" || !input.tcx.startsWith("<?xml") || !input.tcx.includes("<TrainingCenterDatabase") || typeof input.name !== "string" || input.name.length > 160 || !["Run", "Ride", "Rowing"].includes(input.sport))
        throw new ApiError(400, "Invalid workout. Demo sessions cannot sync.");
      await this.ctx.storage.put(key, { state: "uploading" });
      const form = new FormData();
      form.set(
        "file",
        new Blob([input.tcx], { type: "application/vnd.garmin.tcx+xml" }),
        `smart-fit-${input.id}.tcx`
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
          body: form
        });
        if (res.status === 401) {
          await this.ctx.storage.delete("token");
          await this.ctx.storage.put(key, {
            state: "retry",
            retryAfter: Date.now(),
            message: "Reconnect Strava to retry this rejected request."
          });
          throw new ApiError(401, "Reconnect Strava to continue syncing.");
        }
        if (res.status === 429)
          job = {
            state: "retry",
            message: "Strava rate limit. Retry after 15 minutes.",
            retryAfter: Date.now() + 15 * 60 * 1e3
          };
        else if (!res.ok)
          job = {
            state: res.status >= 500 ? "uncertain" : "error",
            message: res.status === 401 ? "Strava access rejected. Reconnect your account." : res.status >= 500 ? "Upload confirmation failed. Check Strava before retrying." : "Strava rejected this upload. It may already exist on Strava."
          };
        else {
          const data = await res.json();
          job = data.id ? { state: "processing", uploadId: data.id } : {
            state: "uncertain",
            message: "Upload response was incomplete. Check Strava."
          };
        }
      } catch (error) {
        if (error instanceof ApiError) throw error;
        job = {
          state: "uncertain",
          message: "Upload confirmation was interrupted. Check Strava before uploading again."
        };
      }
      await this.ctx.storage.put(key, job);
      return json(job);
    } catch (e) {
      return json(
        {
          error: e instanceof ApiError ? e.message : "Strava is temporarily unavailable. Try again later."
        },
        e instanceof ApiError ? e.status : 502
      );
    }
  }
};

// worker/media.ts
function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || !match[1] && !match[2]) throw Error("Invalid range");
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw Error("Invalid range");
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]), last = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(last) || offset < 0 || offset >= size || last < offset)
    throw Error("Invalid range");
  return { offset, length: last - offset + 1 };
}
__name(parseRange, "parseRange");
async function serveMedia(request, bucket) {
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-None-Match, If-Range",
        "Access-Control-Max-Age": "86400"
      }
    });
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" }
    });
  const name = new URL(request.url).pathname.slice("/media/".length);
  if (!/^(?:[a-z0-9-]+\/){0,5}[a-z0-9-]+\.(?:mp4|m3u8|m4s|jpg|webp|json)$/.test(
    name
  ))
    return new Response("Not found", { status: 404 });
  if (name.endsWith(".json") && name !== "catalog.json")
    return new Response("Not found", { status: 404 });
  const meta = await bucket.head(name);
  if (!meta) return new Response("Not found", { status: 404 });
  const mime = {
    mp4: "video/mp4",
    m3u8: "application/vnd.apple.mpegurl",
    m4s: "video/iso.segment",
    jpg: "image/jpeg",
    webp: "image/webp",
    json: "application/json"
  };
  const headers = new Headers({
    "Content-Type": mime[name.split(".").pop()],
    "Content-Length": String(meta.size),
    "Accept-Ranges": "bytes",
    "Cache-Control": name === "catalog.json" ? "public, max-age=60, stale-while-revalidate=300" : "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
    ETag: meta.httpEtag,
    "X-Content-Type-Options": "nosniff"
  });
  if (request.headers.get("If-None-Match") === meta.httpEtag)
    return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  let range;
  try {
    const ifRange = request.headers.get("If-Range");
    range = parseRange(
      ifRange && ifRange !== meta.httpEtag ? null : request.headers.get("Range"),
      meta.size
    );
  } catch {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${meta.size}`,
        "Accept-Ranges": "bytes"
      }
    });
  }
  const object = await bucket.get(name, range ? { range } : void 0);
  if (!object) return new Response("Not found", { status: 404 });
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`
    );
    headers.set("Content-Length", String(range.length));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
__name(serveMedia, "serveMedia");

// worker/activation.ts
function activation(serial, part, model, version) {
  const bytes = new Uint8Array(36);
  for (let bit = 0; bit < 32; bit++) {
    let value = bit + 1;
    if ((serial >> bit & 1) === 1) {
      value ^= bit < 16 ? (part << 16 | part >> 16) >> bit & 255 : part >> bit & 255;
    } else {
      value ^= Math.imul(value, bit + model | 0) & 255;
    }
    bytes[bit] = value & 255;
  }
  new DataView(bytes.buffer).setUint32(32, version * 8, true);
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}
__name(activation, "activation");

// worker/index.ts
var index_default = {
  async fetch(r, env, context) {
    const path = new URL(r.url).pathname;
    if (path.startsWith("/api/strava/")) return stravaHandler(r, env);
    if (path.startsWith("/media/")) {
      if (!env.SCENERY)
        return new Response("Media unavailable", { status: 503 });
      const edge = globalThis.caches?.default;
      const cacheable = r.method === "GET" && !r.headers.has("Range") && !r.headers.has("If-None-Match") && !r.headers.has("If-Range") && /\.(?:m3u8|m4s|jpg|webp|json)$/.test(path);
      if (edge && cacheable) {
        const hit = await edge.match(r);
        if (hit) return hit;
      }
      const response2 = await serveMedia(r, env.SCENERY);
      if (edge && cacheable && response2.status === 200 && context)
        context.waitUntil(edge.put(r, response2.clone()).catch(() => {
        }));
      return response2;
    }
    if (path === "/api/video-info") {
      if (r.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      try {
        const upstream = await fetch("https://media.kwest.fit/info.json", {
          signal: AbortSignal.timeout(8e3),
          redirect: "manual"
        });
        if (!upstream.ok)
          throw Error("Catalogue upstream status " + upstream.status);
        if (Number(upstream.headers.get("Content-Length")) > 262144)
          throw Error("Catalogue too large");
        const reader = upstream.body?.getReader();
        if (!reader) throw Error("Empty catalogue");
        const chunks = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 262144) {
            await reader.cancel();
            throw Error("Catalogue too large");
          }
          chunks.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.length;
        }
        const data = JSON.parse(new TextDecoder().decode(bytes));
        return Response.json(data, {
          headers: { "Cache-Control": "public, max-age=60" }
        });
      } catch (error) {
        console.error("Video catalogue fetch failed", String(error));
        return Response.json(
          { error: "Video catalogue unavailable" },
          { status: 502, headers: { "Cache-Control": "no-store" } }
        );
      }
    }
    if (path === "/api/health")
      return Response.json({ status: "ok", version: "0.1.0" });
    if (path.startsWith("/ifit/")) {
      if (r.method === "GET" && path === "/ifit/activation/generic")
        return Response.json(
          {
            error: "Generic activation is not enabled; use device-specific activation."
          },
          { status: 422 }
        );
      if (r.method !== "POST" || path !== "/ifit/activation")
        return new Response("Not found", { status: 404 });
      if (Number(r.headers.get("content-length")) > 2048)
        return new Response("Too large", { status: 413 });
      try {
        const raw = await r.text();
        if (raw.length > 2048)
          return new Response("Too large", { status: 413 });
        const p = JSON.parse(raw);
        const keys = [
          "serialNumber",
          "partNumber",
          "model",
          "masterLibraryVersion"
        ];
        if (keys.some(
          (k, i) => !Number.isInteger(p[k]) || p[k] < (i === 3 ? 0 : -2147483648) || p[k] > (i === 3 ? 255 : 2147483647)
        ))
          throw Error();
        return Response.json(
          {
            payloadHex: activation(
              p.serialNumber,
              p.partNumber,
              p.model,
              p.masterLibraryVersion
            )
          },
          { headers: { "Cache-Control": "no-store" } }
        );
      } catch {
        return Response.json({ error: "Invalid device info" }, { status: 400 });
      }
    }
    const response = await env.ASSETS.fetch(r);
    const headers = new Headers(response.headers);
    headers.set("X-Content-Type-Options", "nosniff");
    headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
    headers.set("Permissions-Policy", "bluetooth=(self)");
    return new Response(response.body, { status: response.status, headers });
  }
};
export {
  StravaSession,
  index_default as default
};
//# sourceMappingURL=index.js.map
