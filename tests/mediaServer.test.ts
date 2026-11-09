import { it, expect } from "vitest";
import { normaliseMediaServer, serverScenes } from "../src/mediaServer";
it("normalises HTTPS media-folder URLs without exposing an administration or storage credential", () => {
  expect(
    normaliseMediaServer({
      baseUrl: " https://media.example.com/fitness/ ",
      credentials: true,
    }),
  ).toEqual({
    baseUrl: "https://media.example.com/fitness",
    credentials: true,
  });
  for (const url of [
    "http://media.example.com",
    "https://user:password@example.com",
    "https://example.com/?token=secret",
    "https://example.com/#secret",
  ])
    expect(() => normaliseMediaServer({ baseUrl: url })).toThrow();
  expect(() =>
    normaliseMediaServer({ baseUrl: "http://localhost:8791" }),
  ).toThrow();
  expect(
    normaliseMediaServer({ baseUrl: "http://localhost:8791" }, true).baseUrl,
  ).toBe("http://localhost:8791");
});
it("resolves the entire catalogue to the NAS folder, so streams never need a Worker proxy", () => {
  const [scene] = serverScenes(
    [
      {
        src: "/media/hls/forest/fallback.mp4",
        hlsSrc: "/media/hls/forest/master.m3u8",
        poster: "/media/hls/forest/poster.jpg",
      } as any,
    ],
    { baseUrl: "https://media.example.com/fitness", credentials: false },
  );
  expect(scene.src).toBe(
    "https://media.example.com/fitness/hls/forest/fallback.mp4",
  );
  expect(scene.hlsSrc).toBe(
    "https://media.example.com/fitness/hls/forest/master.m3u8",
  );
  expect(scene.poster).toBe(
    "https://media.example.com/fitness/hls/forest/poster.jpg",
  );
});
