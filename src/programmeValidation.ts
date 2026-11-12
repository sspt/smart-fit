import type { Programme } from "./store";
export function validProgramme(p: any): p is Programme {
  return (
    !!p &&
    typeof p.id === "string" &&
    typeof p.name === "string" &&
    p.name.length > 0 &&
    ["Treadmill", "Bike", "Rower"].includes(p.kind) &&
    Number.isInteger(p.repeat) &&
    p.repeat >= 1 &&
    p.repeat <= 100 &&
    Array.isArray(p.blocks) &&
    p.blocks.length > 0 &&
    p.blocks.length <= 100 &&
    p.blocks.every(
      (b: any) =>
        typeof b.name === "string" &&
        Number.isFinite(b.duration) &&
        b.duration >= 5 &&
        b.duration <= 86400 &&
        ["speed", "incline", "resistance", "power"].every((k) =>
          Number.isFinite(b[k]),
        ) &&
        b.speed >= 0 &&
        b.speed <= 25 &&
        b.incline >= -6 &&
        b.incline <= 40 &&
        b.resistance >= 0 &&
        b.resistance <= 100 &&
        b.power >= 0 &&
        b.power <= 2000 &&
        (b.distance === undefined ||
          (Number.isFinite(b.distance) &&
            b.distance >= 10 &&
            b.distance <= 100000)) &&
        (!b.ramp ||
          [b.endSpeed, b.endIncline, b.endResistance, b.endPower].every(
            Number.isFinite,
          )) &&
        (!b.ramp ||
          (b.endSpeed! >= 0 &&
            b.endSpeed! <= 25 &&
            b.endIncline! >= -6 &&
            b.endIncline! <= 40 &&
            b.endResistance! >= 0 &&
            b.endResistance! <= 100 &&
            b.endPower! >= 0 &&
            b.endPower! <= 2000)),
    )
  );
}
