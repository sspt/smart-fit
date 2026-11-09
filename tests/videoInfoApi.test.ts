import { it, expect, vi } from "vitest";
import worker from "../worker/index";
it("retrieves only the fixed public metadata endpoint", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(Response.json({ videos: [] }));
  try {
    const res = await worker.fetch(
      new Request("https://fit.silvio.cloud/api/video-info"),
      {} as any,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ videos: [] });
    expect(fetch.mock.calls[0][1]?.redirect).toBe("manual");
    expect(fetch.mock.calls[0][0]).toBe(
      "https://videos.fit.silvio.cloud/info.json",
    );
  } finally {
    fetch.mockRestore();
  }
});
it("returns a non-cacheable error for invalid upstream JSON", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("<html>oops</html>"));
  try {
    const res = await worker.fetch(
      new Request("https://fit.silvio.cloud/api/video-info"),
      {} as any,
    );
    expect(res.status).toBe(502);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  } finally {
    fetch.mockRestore();
  }
});
