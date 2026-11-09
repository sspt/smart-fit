export function activation(
  serial: number,
  part: number,
  model: number,
  version: number,
): string {
  const bytes = new Uint8Array(36);
  for (let bit = 0; bit < 32; bit++) {
    let value = bit + 1;
    if (((serial >> bit) & 1) === 1) {
      value ^=
        bit < 16
          ? (((part << 16) | (part >> 16)) >> bit) & 255
          : (part >> bit) & 255;
    } else {
      value ^= Math.imul(value, (bit + model) | 0) & 255;
    }
    bytes[bit] = value & 255;
  }
  new DataView(bytes.buffer).setUint32(32, version * 8, true);
  return [...bytes].map((x) => x.toString(16).padStart(2, "0")).join("");
}
