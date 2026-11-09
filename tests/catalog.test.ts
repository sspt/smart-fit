import { it, expect } from "vitest";
import { parseCatalog, sceneDuration } from "../src/catalog";
const scene = {
  id: "forest-123",
  name: "Quiet forest",
  kind: "Treadmill",
  reference: 5,
  seconds: 3685,
  author: "Creator",
  source: "https://example.com/source",
  poster: "/media/hls/forest-123/poster.jpg",
  src: "/media/hls/forest-123/fallback.mp4",
  hlsSrc: "/media/hls/forest-123/master.m3u8",
  format: "route",
};
it("accepts full length silent-video catalogue entries and strips unknown fields", () => {
  expect(
    parseCatalog({
      version: 1,
      scenes: [{ ...scene, privateToken: "excluded" }],
    }),
  ).toEqual([scene]);
  expect(sceneDuration(scene as any)).toBe("61m 25s");
});
it.each([
  { src: "https://untrusted.example/video.mp4" },
  { hlsSrc: "/media/../secret.m3u8" },
  { poster: "/media/hls/forest-123/poster.svg" },
  { source: "javascript:alert(1)" },
  { kind: "Unknown" },
  { reference: 0 },
  { seconds: Infinity },
  { format: "unknown" },
  { id: "../bad" },
  { name: "" },
])("rejects invalid catalogue fields %j", (patch) =>
  expect(() =>
    parseCatalog({ version: 1, scenes: [{ ...scene, ...patch }] }),
  ).toThrow(),
);
it("rejects duplicate ids and unsupported schemas", () => {
  expect(() => parseCatalog({ version: 1, scenes: [scene, scene] })).toThrow();
  expect(() => parseCatalog({ version: 2, scenes: [] })).toThrow();
  expect(() =>
    parseCatalog({ version: 1, scenes: Array(501).fill(scene) }),
  ).toThrow();
});
