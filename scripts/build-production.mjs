import fs from "node:fs/promises";
import prettier from "prettier";
import { build, transform } from "esbuild";
import { createHash } from "node:crypto";
const root = "artifacts/visual-release";
await fs.rm(root, { recursive: true, force: true });
await fs.cp("production/assets", root, { recursive: true });
let html = await fs.readFile(root + "/index.html", "utf8");
const old = html.match(/src="(\/assets\/[^"\s]+\.js)"/)[1];
let code = await prettier.format(await fs.readFile(root + old, "utf8"), {
  parser: "babel",
});
function once(from, to) {
  if (code.split(from).length !== 2)
    throw Error("Production contract changed: " + from.slice(0, 90));
  code = code.replace(from, to);
}
const built = await build({
  stdin: {
    contents: `export {WorkoutRecap,WeeklyProgress,IntervalCue} from './src/WorkoutFeedback'; export {intervalCue} from './src/feedbackStats';`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "__feedback",
  jsxFactory: "m.createElement",
  jsxFragment: "m.Fragment",
  tsconfigRaw: { compilerOptions: { jsx: "react" } },
  minify: false,
});
code = built.outputFiles[0].text + "\n" + code;
once(
  "function Xv() {",
  "function Xv() {\n const [__recap,__setRecap] = m.useState(null);",
);
once(
  "x((Le) => [te, ...Le].slice(0, 200)),",
  "x((Le) => [te, ...Le].slice(0, 200)), __setRecap(te),",
);
once(
  'c.jsx("h1", { children: "Your journey." }),',
  'c.jsx("h1", { children: "Your journey." }),\n c.jsx(__feedback.WorkoutRecap,{session:__recap,history:Q,units:Oe,onDismiss:()=>__setRecap(null)}), c.jsx(__feedback.WeeklyProgress,{history:Q}),',
);
once(
  "initialRouteId: v.sceneryId,",
  "initialRouteId: v.sceneryId, nextCue:__feedback.intervalCue(v,xe,Oe),",
);
once("initialRouteId: O,", "initialRouteId: O, nextCue: __nextCue,");
once(
  "c.jsx(__workoutPatch.WorkoutReadings, {",
  "c.jsx(__feedback.IntervalCue,{text:__nextCue}), c.jsx(__workoutPatch.WorkoutReadings, {",
);
code = (await transform(code, { minify: true, target: "es2022" })).code;
const hash = createHash("sha256").update(code).digest("hex").slice(0, 12),
  path = "/assets/feedback-" + hash + ".js";
await fs.writeFile(root + path, code);
html = html.replace(old, path);
const css = html.match(/href="(\/assets\/[^"\s]+\.css)"/)[1];
const style =
  (await fs.readFile(root + css, "utf8")) +
  "\n" +
  (await fs.readFile("src/workout-feedback.css", "utf8"));
const cssPath =
  "/assets/feedback-" +
  createHash("sha256").update(style).digest("hex").slice(0, 12) +
  ".css";
await fs.writeFile(root + cssPath, style);
html = html.replace(css, cssPath);
await fs.writeFile(root + "/index.html", html);
const assets = JSON.parse(
  await fs.readFile(root + "/offline-assets.json", "utf8"),
);
await fs.writeFile(
  root + "/offline-assets.json",
  JSON.stringify([...new Set([...assets, path, cssPath])]),
);
let sw = await fs.readFile(root + "/sw.js", "utf8");
sw = sw.replace(
  /(const\s+(?:CACHE|CACHE_NAME|VERSION)\s*=\s*["'])([^"']+)(["'])/,
  (_, a, b, z) => a + "kwest-feedback-" + hash + z,
);
await fs.writeFile(root + "/sw.js", sw);
console.log("Built production release:", hash);
