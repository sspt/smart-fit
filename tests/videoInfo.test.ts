import { it, expect } from "vitest";
import { parseVideoInfo } from "../src/videoInfo";
const entry = {
  file: "forest.webm",
  name: "Forest walk",
  referenceSpeed: 7,
  skipSeconds: 8,
  deviceTypes: ["Treadmill", "Bike"],
};
it("expands a video into its supported equipment types with relative URLs and custom playback settings", () => {
  const scenes = parseVideoInfo({ videos: [entry] });
  expect(scenes).toHaveLength(2);
  expect(scenes[0]).toMatchObject({
    src: "https://videos.fit.silvio.cloud/forest.webm",
    name: "Forest walk",
    reference: 7,
    skipSeconds: 8,
    kind: "Treadmill",
  });
  expect(scenes[1].kind).toBe("Bike");
});
it("uses defaults, supports zero skip and empty catalogues, and keeps IDs stable on reorder", () => {
  const { referenceSpeed, skipSeconds, ...minimal } = entry;
  expect(parseVideoInfo({ videos: [minimal] })[0]).toMatchObject({
    reference: 5,
    skipSeconds: 30,
  });
  expect(
    parseVideoInfo({ videos: [{ ...entry, skipSeconds: 0 }] })[0].skipSeconds,
  ).toBe(0);
  expect(parseVideoInfo({ videos: [] })).toEqual([]);
  const a = parseVideoInfo({
      videos: [entry, { ...entry, file: "other.mp4" }],
    }),
    b = parseVideoInfo({ videos: [{ ...entry, file: "other.mp4" }, entry] });
  expect(a[0].id).toBe(b[2].id);
});
it.each([
  { file: "https://other.example/a.webm" },
  { file: "javascript:evil" },
  { referenceSpeed: 0 },
  { skipSeconds: -1 },
  { skipSeconds: "30" },
  { deviceTypes: ["Boat"] },
  { name: "" },
])("rejects invalid metadata %j", (patch) =>
  expect(() => parseVideoInfo({ videos: [{ ...entry, ...patch }] })).toThrow(),
);
it("rejects invalid envelopes and duplicate files", () => {
  expect(() => parseVideoInfo({})).toThrow();
  expect(() => parseVideoInfo({ videos: [entry, entry] })).toThrow();
});
