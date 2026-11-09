export function parseRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw Error("Invalid range");
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0)
      throw Error("Invalid range");
    const length = Math.min(suffix, size);
    return { offset: size - length, length };
  }
  const offset = Number(match[1]),
    last = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(last) ||
    offset < 0 ||
    offset >= size ||
    last < offset
  )
    throw Error("Invalid range");
  return { offset, length: last - offset + 1 };
}
export async function serveMedia(request: Request, bucket: any) {
  if (request.method === "OPTIONS")
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
        "Access-Control-Allow-Headers": "Range, If-None-Match, If-Range",
        "Access-Control-Max-Age": "86400",
      },
    });
  if (!["GET", "HEAD"].includes(request.method))
    return new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "GET, HEAD, OPTIONS" },
    });
  const name = new URL(request.url).pathname.slice("/media/".length);
  if (
    !/^(?:[a-z0-9-]+\/){0,5}[a-z0-9-]+\.(?:mp4|m3u8|m4s|jpg|webp|json)$/.test(
      name,
    )
  )
    return new Response("Not found", { status: 404 });
  if (name.endsWith(".json") && name !== "catalog.json")
    return new Response("Not found", { status: 404 });
  const meta = await bucket.head(name);
  if (!meta) return new Response("Not found", { status: 404 });
  const mime: Record<string, string> = {
    mp4: "video/mp4",
    m3u8: "application/vnd.apple.mpegurl",
    m4s: "video/iso.segment",
    jpg: "image/jpeg",
    webp: "image/webp",
    json: "application/json",
  };
  const headers = new Headers({
    "Content-Type": mime[name.split(".").pop()!]!,
    "Content-Length": String(meta.size),
    "Accept-Ranges": "bytes",
    "Cache-Control":
      name === "catalog.json"
        ? "public, max-age=60, stale-while-revalidate=300"
        : "public, max-age=31536000, immutable",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers":
      "Content-Length, Content-Range, Accept-Ranges, ETag",
    ETag: meta.httpEtag,
    "X-Content-Type-Options": "nosniff",
  });
  if (request.headers.get("If-None-Match") === meta.httpEtag)
    return new Response(null, { status: 304, headers });
  if (request.method === "HEAD") return new Response(null, { headers });
  let range;
  try {
    const ifRange = request.headers.get("If-Range");
    range = parseRange(
      ifRange && ifRange !== meta.httpEtag
        ? null
        : request.headers.get("Range"),
      meta.size,
    );
  } catch {
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${meta.size}`,
        "Accept-Ranges": "bytes",
      },
    });
  }
  const object = await bucket.get(name, range ? { range } : undefined);
  if (!object) return new Response("Not found", { status: 404 });
  if (range) {
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${meta.size}`,
    );
    headers.set("Content-Length", String(range.length));
  }
  return new Response(object.body, { status: range ? 206 : 200, headers });
}
