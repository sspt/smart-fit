import { serveMedia } from "./media";
import { activation } from "./activation";
export default {
  async fetch(
    r: Request,
    env: {
      SCENERY?: any;
      ASSETS: { fetch: (r: Request) => Promise<Response> };
    },
    context?: { waitUntil: (task: Promise<unknown>) => void },
  ) {
    const path = new URL(r.url).pathname;
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
    // Only the small public catalogue passes through the Worker. Videos remain direct from the NAS.
    if (path === "/api/video-info") {
      if (r.method !== "GET")
        return new Response("Method not allowed", { status: 405 });
      try {
        const upstream = await fetch(
          "https://videos.fit.silvio.cloud/info.json",
          { signal: AbortSignal.timeout(8000), redirect: "manual" },
        );
        if (!upstream.ok) throw Error("Catalogue upstream status " + upstream.status);
        if (Number(upstream.headers.get("Content-Length")) > 262144)
          throw Error("Catalogue too large");
        const reader = upstream.body?.getReader();
        if (!reader) throw Error("Empty catalogue");
        const chunks: Uint8Array[] = [];
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
