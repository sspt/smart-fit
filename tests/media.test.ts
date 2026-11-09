import { it, expect } from "vitest";
import { parseRange, serveMedia } from "../worker/media";
it("supports bounded, open and suffix video ranges", () => {
  expect(parseRange("bytes=2-5", 10)).toEqual({ offset: 2, length: 4 });
  expect(parseRange("bytes=2-", 10)).toEqual({ offset: 2, length: 8 });
  expect(parseRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
  expect(parseRange("bytes=0-100", 10)).toEqual({ offset: 0, length: 10 });
  for (const r of ["bytes=10-", "bytes=5-3", "bytes=0-1,3-4", "bytes=-0"])
    expect(() => parseRange(r, 10)).toThrow();
});
it("streams requested bytes with correct headers and rejects unsatisfiable seeks", async () => {
  const data = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const bucket = {
    head: async () => ({ size: 6, httpEtag: '"test"' }),
    get: async (_key: string, opts: any) => ({
      body: opts
        ? data.slice(opts.range.offset, opts.range.offset + opts.range.length)
        : data,
    }),
  };
  const r = await serveMedia(
    new Request("https://fit.silvio.cloud/media/test.mp4", {
      headers: { Range: "bytes=2-4" },
    }),
    bucket,
  );
  expect(r.status).toBe(206);
  expect(r.headers.get("Content-Range")).toBe("bytes 2-4/6");
  expect(r.headers.get("Content-Length")).toBe("3");
  expect([...new Uint8Array(await r.arrayBuffer())]).toEqual([2, 3, 4]);
  expect(
    (
      await serveMedia(
        new Request("https://fit.silvio.cloud/media/test.mp4", {
          headers: { Range: "bytes=90-" },
        }),
        bucket,
      )
    ).status,
  ).toBe(416);
  expect(
    (
      await serveMedia(
        new Request("https://fit.silvio.cloud/media/test.mp4", {
          method: "HEAD",
        }),
        bucket,
      )
    ).status,
  ).toBe(200);
});

it.each([
  ["hls/walk-v2/master.m3u8", "application/vnd.apple.mpegurl"],
  ["hls/walk-v2/2160p/segment-00001.m4s", "video/iso.segment"],
  ["hls/walk-v2/2160p/init.mp4", "video/mp4"],
  ["hls/walk-v2/poster.jpg", "image/jpeg"],
  ["catalog.json", "application/json"],
])(
  "serves %s with media headers and no buffering requirement",
  async (path, mime) => {
    let gets = 0;
    const bucket = {
      head: async () => ({ size: 4, httpEtag: '"v2"' }),
      get: async () => {
        gets++;
        return { body: new Uint8Array([1, 2, 3, 4]) };
      },
    };
    const response = await serveMedia(
      new Request("https://fit.silvio.cloud/media/" + path),
      bucket,
    );
    expect(response.headers.get("Content-Type")).toBe(mime);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(response.headers.get("Cache-Control")).toBe(
      path === "catalog.json"
        ? "public, max-age=60, stale-while-revalidate=300"
        : "public, max-age=31536000, immutable",
    );
    expect((await response.arrayBuffer()).byteLength).toBe(4);
    const head = await serveMedia(
      new Request("https://fit.silvio.cloud/media/" + path, { method: "HEAD" }),
      bucket,
    );
    expect(head.body).toBeNull();
    expect(gets).toBe(1);
    const unchanged = await serveMedia(
      new Request("https://fit.silvio.cloud/media/" + path, {
        headers: { "If-None-Match": '"v2"' },
      }),
      bucket,
    );
    expect(unchanged.status).toBe(304);
    expect(gets).toBe(1);
  },
);
it.each([
  "hls//master.m3u8",
  "hls/test/key.exe",
  "hls/test/private.json",
  "hls/test/%2fprivate.mp4",
  "test.txt",
])("rejects non-media object paths %s before accessing R2", async (path) => {
  const response = await serveMedia(
    new Request("https://fit.silvio.cloud/media/" + path),
    {
      head: () => {
        throw Error("must not access bucket");
      },
    },
  );
  expect(response.status).toBe(404);
});
it("only allows public read operations", async () => {
  const request = new Request(
    "https://fit.silvio.cloud/media/hls/test/master.m3u8",
    { method: "POST" },
  );
  expect((await serveMedia(request, {})).status).toBe(405);
  expect(
    (await serveMedia(new Request(request.url, { method: "OPTIONS" }), {}))
      .status,
  ).toBe(204);
});
