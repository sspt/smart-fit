import {
  accountsHandler,
  accountUser,
  digest,
  type AccountEnv,
} from "./accounts";
import { stravaHandler, type StravaEnv } from "./strava";
export { StravaSession } from "./strava";
import { serveMedia } from "./media";
import { activation } from "./activation";
export default {
  async fetch(
    r: Request,
    env: StravaEnv &
      AccountEnv & {
        SCENERY?: any;
        ASSETS: { fetch: (r: Request) => Promise<Response> };
      },
    context?: { waitUntil: (task: Promise<unknown>) => void },
  ) {
    const path = new URL(r.url).pathname;
    if (path === "/api/auth/status" && env.DB && context)
      context.waitUntil(
        env.DB.batch([
          env.DB.prepare("DELETE FROM fit_sessions WHERE expires_at<?").bind(
            Date.now(),
          ),
          env.DB.prepare(
            "DELETE FROM fit_oauth_transactions WHERE expires_at<?",
          ).bind(Date.now()),
          env.DB.prepare("DELETE FROM fit_auth_limits WHERE expires_at<?").bind(
            Date.now(),
          ),
        ]).catch(() => {}),
      );
    if (
      path.startsWith("/api/auth/") ||
      path === "/api/data" ||
      path.startsWith("/api/data/")
    )
      return accountsHandler(r, env);
    if (path.startsWith("/api/strava/")) {
      const user = await accountUser(r, env);
      if (
        r.headers.has("X-Kwest-Account") &&
        r.headers.get("X-Kwest-Account") !== user?.id
      )
        return Response.json(
          { error: "Sign in again before syncing Strava." },
          { status: 401, headers: { "Cache-Control": "no-store" } },
        );
      return stravaHandler(r, {
        ...env,
        ACCOUNT_SESSION_ID: user ? await digest("user:" + user.id) : undefined,
      });
    }
    if (path.startsWith("/media/")) {
      if (!env.SCENERY)
        return new Response("Media unavailable", { status: 503 });
      const edge = (globalThis.caches as CacheStorage & { default?: Cache })
        ?.default;
      const cacheable =
        r.method === "GET" &&
        !r.headers.has("Range") &&
        !r.headers.has("If-None-Match") &&
        !r.headers.has("If-Range") &&
        /\.(?:m3u8|m4s|jpg|webp|json)$/.test(path);
      if (edge && cacheable) {
        const hit = await edge.match(r);
        if (hit) return hit;
      }
      const response = await serveMedia(r, env.SCENERY);
      if (edge && cacheable && response.status === 200 && context)
        context.waitUntil(edge.put(r, response.clone()).catch(() => {}));
      return response;
    }
    // Serve public route metadata on the app origin. Videos stream from the NAS.
    const routeProfile = path.match(
      /^\/api\/video-profile\/((?:[a-zA-Z0-9_-]+\/)+)percurso\.json$/,
    );
    if (path === "/api/video-info" || routeProfile) {
      if (r.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      const metadataLimit = routeProfile ? 2 * 1024 * 1024 : 262144;
      try {
        const upstream = await fetch(
          "https://media.kwest.fit/" +
            (routeProfile ? routeProfile[1] + "percurso.json" : "info.json"),
          {
            signal: AbortSignal.timeout(8000),
            redirect: "manual",
          },
        );
        if (!upstream.ok)
          throw Error("Catalogue upstream status " + upstream.status);
        if (Number(upstream.headers.get("Content-Length")) > metadataLimit)
          throw Error("Catalogue too large");
        const reader = upstream.body?.getReader();
        if (!reader) throw Error("Empty catalogue");
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > metadataLimit) {
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
          headers: { "Cache-Control": "public, max-age=60" },
        });
      } catch (error) {
        console.error("Video catalogue fetch failed", String(error));
        return Response.json(
          { error: "Video catalogue unavailable" },
          { status: 502, headers: { "Cache-Control": "no-store" } },
        );
      }
    }
    if (path === "/api/health")
      return Response.json({ status: "ok", version: "0.1.0" });
    if (path.startsWith("/ifit/")) {
      if (r.method === "GET" && path === "/ifit/activation/generic")
        return Response.json(
          {
            error:
              "Generic activation is not enabled; use device-specific activation.",
          },
          { status: 422 },
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
          "masterLibraryVersion",
        ];
        if (
          keys.some(
            (k, i) =>
              !Number.isInteger(p[k]) ||
              p[k] < (i === 3 ? 0 : -2147483648) ||
              p[k] > (i === 3 ? 255 : 2147483647),
          )
        )
          throw Error();
        return Response.json(
          {
            payloadHex: activation(
              p.serialNumber,
              p.partNumber,
              p.model,
              p.masterLibraryVersion,
            ),
          },
          { headers: { "Cache-Control": "no-store" } },
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
  },
};
