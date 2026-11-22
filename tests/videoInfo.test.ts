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

it("resolves both files relative to the catalogue folder", () => {
  const { file, ...metadata } = entry;
  const [route] = parseVideoInfo({
    videos: [{ ...metadata, path: "fango-galeria/", durationSeconds: 442 }],
  });
  expect(route.src).toBe("https://media.kwest.fit/fango-galeria/video.mp4");
  expect(route.percursoSrc).toBe(
    "https://media.kwest.fit/fango-galeria/percurso.json",
  );
  expect(route.seconds).toBe(442);
});

it("preserves route metadata and derives localized names without changing the route ID", async () => {
  const { routeName } = await import("../src/routePresentation");
  const [route] = parseVideoInfo({
    videos: [
      {
        path: "cycling/calvi/",
        name: "Short Ride in Calvi",
        originalName: "Fango – Galéria",
        deviceTypes: ["Bike"],
        durationSeconds: 442,
        distanceKm: 3.914,
        lengthCategory: "short",
        activityType: "ride",
        gif: "cycling/calvi/preview.gif",
        location: {
          name: "Calvi",
          countryCode: "fr",
          latitude: 42.4,
          longitude: 8.7,
          source: "nearest_geonames_populated_place",
        },
      },
    ],
  });
  expect(route).toMatchObject({
    id: "nas-info-%2Fcycling%2Fcalvi%2Fvideo.mp4-bike",
    gif: "https://media.kwest.fit/cycling/calvi/preview.gif",
    originalName: "Fango – Galéria",
    distanceKm: 3.914,
    seconds: 442,
    location: {
      name: "Calvi",
      countryCode: "FR",
      latitude: 42.4,
      longitude: 8.7,
    },
  });
  expect(
    ["en", "es", "pt", "fr", "it", "pl", "de", "nl"].map((language) =>
      routeName(route, language as Parameters<typeof routeName>[1]),
    ),
  ).toEqual([
    "Short Ride in Calvi",
    "Paseo en bici corto en Calvi",
    "Passeio de bicicleta curto em Calvi",
    "Sortie à vélo courte à Calvi",
    "Giro in bici breve a Calvi",
    "Krótka trasa rowerowa · Calvi",
    "Kurze Radtour in Calvi",
    "Korte fietsrit in Calvi",
  ]);
});
