import { describe, it, expect } from "vitest";
import { activation } from "../worker/activation";
import worker from "../worker/index";
// Independent integer reference uses BigInt to preserve Go signed int32 shifts and overflow.
function reference(s: number, p: number, m: number, v: number) {
  const signed = (n: bigint) => BigInt.asIntN(32, n);
  const serial = BigInt(s),
    part = BigInt(p),
    model = BigInt(m);
  const out = [];
  for (let i = 0n; i < 32n; i++) {
    let n = i + 1n;
    if ((serial >> i) & 1n)
      n ^=
        (i < 16n
          ? signed(signed(part << 16n) | (part >> 16n)) >> i
          : part >> i) & 255n;
    else n ^= ((i + 1n) * signed(i + model)) & 255n;
    out.push(Number(n & 255n));
  }
  const k = v * 8;
  out.push(k & 255, (k >>> 8) & 255, 0, 0);
  return out.map((x) => x.toString(16).padStart(2, "0")).join("");
}
describe("activation parity and validation", () => {
  for (const s of [0, 1, -1, 2147483647, -2147483648, 65536, 32768])
    for (const p of [0, -1, 123456, 2147483647, -2147483648])
      it(`signed vector ${s}/${p}`, () => {
        for (const m of [0, -1, 2147483647, -2147483648])
          for (const v of [0, 255])
            expect(activation(s, p, m, v)).toBe(reference(s, p, m, v));
      });
  it("rejects malformed device info", async () => {
    for (const x of [
      null,
      {},
      { serialNumber: 1.5, partNumber: 1, model: 1, masterLibraryVersion: 0 },
    ]) {
      const r = await worker.fetch(
        new Request("https://fit.silvio.cloud/ifit/activation", {
          method: "POST",
          body: JSON.stringify(x),
        }),
        {} as any,
      );
      expect(r.status).toBe(400);
    }
  });
  it("returns 36 bytes and keeps response uncacheable", async () => {
    const r = await worker.fetch(
      new Request("https://fit.silvio.cloud/ifit/activation", {
        method: "POST",
        body: JSON.stringify({
          serialNumber: 0,
          partNumber: 0,
          model: 0,
          masterLibraryVersion: 255,
        }),
      }),
      {} as any,
    );
    expect(r.status).toBe(200);
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(((await r.json()) as any).payloadHex).toHaveLength(72);
  });
});
