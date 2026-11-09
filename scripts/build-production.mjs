import ts from "typescript";
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
    contents: `export {IPhoneLanding} from './src/IPhoneLanding'; export {needsIPhoneLanding} from './src/browserSupport'; export {SettingsLayout} from './src/SettingsLayout'; export {EquipmentConnection} from './src/EquipmentConnection'; export {WorkoutRecap,WeeklyProgress,IntervalCue} from './src/WorkoutFeedback'; export {intervalCue} from './src/feedbackStats';`,
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
  plugins: [
    {
      name: "production-react",
      setup(b) {
        b.onResolve({ filter: /^react$/ }, () => ({
          path: "react",
          namespace: "production-react",
        }));
        b.onLoad({ filter: /.*/, namespace: "production-react" }, () => ({
          contents: "export const useState=(...args)=>m.useState(...args);",
        }));
      },
    },
  ],
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
// Replace the equipment panel as one parsed expression, leaving Bluetooth logic intact.
const ast = ts.createSourceFile(
  "production.js",
  code,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const panels = [];
function visit(node) {
  if (
    ts.isVariableDeclaration(node) &&
    node.name.getText(ast) === "Pr" &&
    node.initializer?.getText(ast).includes("equipment-screen ")
  )
    panels.push(node.initializer);
  ts.forEachChild(node, visit);
}
visit(ast);
if (panels.length !== 1)
  throw Error("Production equipment panel contract changed");
const panel = panels[0];
code =
  code.slice(0, panel.getStart(ast)) +
  `c.jsx(__feedback.EquipmentConnection,{
 kind:H,connected:Ne,busy:Ce,running:xe,hasSession:!!v,
 deviceName:J.deviceName||K.deviceName,hint:Cn,
 error:J.connected?J.error||J.controlError:K.connected?K.error||K.controlError:J.error||K.error,
 onKind:(kind)=>{Me(kind);$t(false)},onConnect:()=>void mt(fr),
 onExport:()=>Il("kwest-fit-diagnostics.json",JSON.stringify(dg(),null,2))
})` +
  code.slice(panel.end);
// Reuse existing action handlers while giving Settings a smaller, shared layout.
const settingsAst = ts.createSourceFile(
  "settings.js",
  code,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
function prop(node, key) {
  return node?.properties?.find((p) => p.name?.getText(settingsAst) === key)
    ?.initializer;
}
function jsxChildren(call) {
  return prop(call.arguments?.[1], "children")?.elements;
}
const settingsPanels = [];
function findSettings(node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(settingsAst) === "c.jsxs" &&
    node.arguments[0]?.text === "section" &&
    node.getText(settingsAst).includes('className: "panel settings"')
  )
    settingsPanels.push(node);
  ts.forEachChild(node, findSettings);
}
findSettings(settingsAst);
if (settingsPanels.length !== 1)
  throw Error("Production Settings contract changed");
const settingsPanel = settingsPanels[0],
  outer = jsxChildren(settingsPanel),
  controls = jsxChildren(outer[2]);
if (controls.length !== 5) throw Error("Unexpected Settings controls");
const data = jsxChildren(controls[4]),
  actions = jsxChildren(data[1]),
  maintenance = jsxChildren(controls[1]);
if (actions.length !== 4 || data.length !== 4 || maintenance.length !== 3)
  throw Error("Unexpected Settings actions");
const raw = (n) => n.getText(settingsAst);
const replacement = `c.jsx(__feedback.SettingsLayout,{units:${raw(controls[0])},connection:${raw(controls[2])},backup:c.jsxs(c.Fragment,{children:[${raw(actions[0])},${raw(actions[1])}]}),refresh:${raw(maintenance[2])},install:${raw(actions[3])},erase:${raw(data[3])}})`;
code =
  code.slice(0, settingsPanel.getStart(settingsAst)) +
  replacement +
  code.slice(settingsPanel.end);
// Strava keeps its existing status/actions, presented as a regular section.
const connectionAst = ts.createSourceFile(
    "connections.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ),
  connectionEdits = [];
function cleanConnection(node) {
  if (
    ts.isCallExpression(node) &&
    node.arguments[0]?.text === "details" &&
    node.arguments[1]
      ?.getText(connectionAst)
      .includes('className: "strava-settings"')
  ) {
    const body = node
      .getText(connectionAst)
      .replace('"details"', '"section"')
      .replace("open: !0,", "")
      .replace('"summary"', '"h2"')
      .replaceAll("Connections \\xB7 Strava", "Strava")
      .replace("Data, backups & installation", "Your data")
      .replace(
        "Older workouts can be synced individually from your Journal. Offline uploads wait on this device and resume when the app is open and online. Demo sessions are excluded.",
        "Workouts sync when the app is open and online.",
      );
    connectionEdits.push([node.getStart(connectionAst), node.end, body]);
  }
  ts.forEachChild(node, cleanConnection);
}
cleanConnection(connectionAst);
if (connectionEdits.length !== 2)
  throw Error("Strava section contract changed");
for (const [start, end, value] of connectionEdits.sort((a, b) => b[0] - a[0]))
  code = code.slice(0, start) + value + code.slice(end);
once(
  ".then(([L, te, Le, st, _t]) => {",
  ".then(([L, te, Le, st, _t]) => { if(Le?.demo)Le=null;",
);
once("$e(Le?.demo ?? !1)", "$e(!1)");
once("Connect equipment or enable demo first.", "Connect equipment first.");
once('X\n                  ? "\\u25CF Demo"\n                  : Ne', "Ne");
once(
  "deviceName: X\n                ? `Demo ${H.toLowerCase()}`\n                : J.deviceName || K.deviceName || H,",
  "deviceName: J.deviceName || K.deviceName || H,",
);
once('v.demo ? "SIMULATED SESSION" : "YOUR SESSION"', '"YOUR SESSION"');
// Hide old simulated records without rewriting or deleting the saved history.
const journalAst = ts.createSourceFile(
    "journal.js",
    code,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  ),
  journals = [];
function findJournal(n) {
  if (
    ts.isCallExpression(n) &&
    n.expression.getText(journalAst) === "c.jsxs" &&
    n.arguments[0]?.text === "section" &&
    n.getText(journalAst).includes('children: "Your journey."')
  )
    journals.push(n);
  ts.forEachChild(n, findJournal);
}
findJournal(journalAst);
if (journals.length !== 1) throw Error("Journal contract changed");
const journal = journals[0],
  journalText = journal
    .getText(journalAst)
    .replace(/\bQ\b/g, "Q.filter(session=>!session.demo)");
code =
  code.slice(0, journal.getStart(journalAst)) +
  journalText +
  code.slice(journal.end);
once(
  "c.jsx(oh, { children: c.jsx(Xv, {}) })",
  "__feedback.needsIPhoneLanding() ? c.jsx(__feedback.IPhoneLanding,{}) : c.jsx(oh, { children: c.jsx(Xv, {}) })",
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
  (await fs.readFile("src/workout-feedback.css", "utf8")) +
  "\n" +
  (await fs.readFile("src/settings-clean.css", "utf8")) +
  "\n" +
  (await fs.readFile("src/iphone-landing.css", "utf8"));
const cssPath =
  "/assets/feedback-" +
  createHash("sha256").update(style).digest("hex").slice(0, 12) +
  ".css";
await fs.writeFile(root + cssPath, style);
html = html.replace(css, cssPath);
await fs.writeFile(root + "/index.html", html);
await fs.copyFile("public/iphone-forest.jpg", root + "/iphone-forest.jpg");
const assets = JSON.parse(
  await fs.readFile(root + "/offline-assets.json", "utf8"),
);
await fs.writeFile(
  root + "/offline-assets.json",
  JSON.stringify([
    ...new Set([...assets, path, cssPath, "/iphone-forest.jpg"]),
  ]),
);
let sw = await fs.readFile(root + "/sw.js", "utf8");
sw = sw.replace(
  /(const\s+(?:CACHE|CACHE_NAME|VERSION)\s*=\s*["'])([^"']+)(["'])/,
  (_, a, b, z) => a + "kwest-feedback-" + hash + z,
);
await fs.writeFile(root + "/sw.js", sw);
console.log("Built production release:", hash);
