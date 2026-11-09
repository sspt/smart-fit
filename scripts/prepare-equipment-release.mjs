/** Apply reviewed equipment changes to the newer production shell, retaining Strava.
 * Run prepare-visual-release first. All replacements are guarded and local only.
 */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import prettier from "prettier";
import { transform } from "esbuild";
import ts from "typescript";
const root = "artifacts/visual-release";
let html = await fs.readFile(root + "/index.html", "utf8");
const oldPath = html.match(/src="(\/assets\/[^"\s]+\.js)"/)[1];
const original = await fs.readFile(root + oldPath, "utf8");
let code = await prettier.format(original, { parser: "babel" });
function once(from, to) {
  if (code.split(from).length !== 2)
    throw Error("Production code changed: " + from.slice(0, 90));
  code = code.replace(from, to);
}
function replaceAllChecked(from, to, count) {
  if (code.split(from).length !== count + 1)
    throw Error("Production control contract changed: " + from);
  code = code.split(from).join(to);
}
// Production variable contract: j=kind, kt=selected device, b=iFIT, Q=FTMS.
once(
  "kt = b.connected ? b : Q;",
  "kt = b.connected ? b : Q;\n const __canControl = __workoutPatch.equipmentControlAvailable(j, kt.controllable, b.connected, Q.targetFeatures);",
);
const gates = code.split("kt.controllable && Ue").length - 1;
if (gates < 3) throw Error("Certification gates not found");
replaceAllChecked("kt.controllable && Ue", "__canControl", gates);
replaceAllChecked("!kt.controllable || !Ue", "!__canControl", 2);
once(
  'w.controlMode !== "follow" && !Ue',
  'w.controlMode !== "follow" && !__canControl',
);
once(
  "Confirm device verification in Devices.",
  "Equipment control is not available. Reconnect the equipment first.",
);
once(
  'if (b.connected && j === "Bike")\n        throw Error(\n          "iFIT bike control is not implemented. Uncheck verification to track only.",\n        );',
  "",
);
const start = code.indexOf("  const ie =\n", code.indexOf("function Xv(")),
  end = code.indexOf("    ke =\n", start);
if (start < 0 || end < 0) throw Error("Control mode contract changed");
code =
  code.slice(0, start) +
  `  const ie = !w ? "Start a journey to use automatic control."
 : !$e ? "Reconnect equipment to use automatic control."
 : j !== w.programme.kind ? "Connect the equipment type used by this session."
 : !Y && !__canControl ? "Equipment control is not available. Check the Bluetooth connection." : "",\n` +
  code.slice(end);
once(
  "oe((D) => D && { ...D, controlMode: v })",
  'oe((D) => D && { ...D, controlMode: v, automatic: D.automatic || v === "automatic" })',
);
once(
  'children: kt.controllable\n                          ? "Device offers control. Physical verification is required before automation."\n                          : "Telemetry only or control not ready."',
  'children: __canControl ? "Equipment control is available. Select Automatic to follow programme targets." : "Tracking only: this equipment does not currently offer the required controls."',
);
// Replace JSX calls using parser boundaries rather than matching nested braces.
let ast = ts.createSourceFile(
  "live.js",
  code,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const edits = [];
function visit(n) {
  if (ts.isCallExpression(n)) {
    const text = n.getText(ast);
    if (
      text.startsWith('c.jsxs("label",') &&
      text.includes("checked: Ue") &&
      text.includes("I have verified this model/firmware")
    )
      edits.push([n.getStart(ast), n.end, "null"]);
    if (
      text.startsWith('c.jsxs("div",') &&
      ts.isObjectLiteralExpression(n.arguments[1]) &&
      n.arguments[1].properties.some(
        (p) =>
          p.name?.getText(ast) === "className" &&
          p.initializer?.text === "immersion-readings",
      )
    )
      edits.push([
        n.getStart(ast),
        n.end,
        "c.jsx(__workoutPatch.WorkoutReadings, {kind:p, speed:u, time:g, incline:__incline, power:__power, resistance:__resistance, distance:__distance, calories:__calories})",
      ]);
  }
  ts.forEachChild(n, visit);
}
visit(ast);
if (edits.length !== 2)
  throw Error("Unexpected metric or certification JSX structure");
for (const [a, b, value] of edits.sort((a, b) => b[0] - a[0]))
  code = code.slice(0, a) + value + code.slice(b);
once(
  "function kh({\n",
  "function kh({\n incline:__incline, power:__power, resistance:__resistance, distance:__distance, calories:__calories,\n",
);
once(
  "speed: $e ? (pt.speedKmh ?? null) : null,",
  "speed: $e ? (pt.speedKmh ?? null) : null,\n incline:$e ? (pt.inclinePct ?? null) : null, power:$e ? (pt.powerW ?? null) : null, resistance:$e ? (pt.resistanceLevel ?? null) : null, distance:w.distance ?? 0, calories:$e ? (pt.caloriesKcal ?? null) : null,",
);
code = code.replace(
  "FitPro2 is unsupported. iFIT activation may require internet; cached activation reuse is not hardware-certified. Unknown device profiles are not certified by this app.",
  "FitPro2 is unsupported. iFIT activation may require internet; control availability depends on the capabilities reported by your equipment and the Bluetooth control connection.",
);
const helpers = [];
for (const file of ["src/WorkoutReadings.tsx", "src/equipmentControl.ts"]) {
  let text = (
    await transform(await fs.readFile(file, "utf8"), {
      loader: "tsx",
      jsxFactory: "m.createElement",
      jsxFragment: "m.Fragment",
      format: "esm",
    })
  ).code;
  text = text.replace(/export\s*\{[^}]*\};?\s*$/, "");
  helpers.push(text);
}
code =
  "const __workoutPatch=(()=>{" +
  helpers.join("\n") +
  ";return {WorkoutReadings,equipmentControlAvailable};})();\n" +
  code;
const built = (
  await transform(code, { loader: "js", minify: true, target: "es2022" })
).code;
if (
  built.includes("VIDEO SPEED") ||
  built.includes("Physical verification is required")
)
  throw Error("Obsolete UI remains");
const newPath =
  "/assets/equipment-" +
  createHash("sha256").update(built).digest("hex").slice(0, 12) +
  ".js";
await fs.writeFile(root + newPath, built);
html = html.replace(oldPath, newPath);
await fs.writeFile(root + "/index.html", html);
const assets = JSON.parse(
  await fs.readFile(root + "/offline-assets.json", "utf8"),
);
await fs.writeFile(
  root + "/offline-assets.json",
  JSON.stringify([...new Set([...assets, newPath])]),
);
let sw = await fs.readFile(root + "/sw.js", "utf8");
sw = sw.replace(
  /(const\s+CACHE\s*=\s*")(.*?)(")/,
  (_m, a, v, z) =>
    a +
    v +
    "-equipment-" +
    createHash("sha256").update(built).digest("hex").slice(0, 12) +
    z,
);
await fs.writeFile(root + "/sw.js", sw);
await fs.writeFile(
  "artifacts/equipment-release-baseline.json",
  JSON.stringify(
    {
      originalScript: oldPath,
      originalSha256: createHash("sha256").update(original).digest("hex"),
      publishedScript: newPath,
      sourceFiles: ["src/WorkoutReadings.tsx", "src/equipmentControl.ts"],
      note: "Guarded production-shell patch; existing Strava functions and worker are retained.",
    },
    null,
    2,
  ),
);
console.log("Prepared equipment release:", newPath);
