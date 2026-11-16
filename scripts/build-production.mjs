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
    contents: `export {WorkoutAdjustments} from './src/WorkoutAdjustments'; export {ControlMode} from './src/ControlMode'; export {WorkoutReadings,hasMetricValue} from './src/WorkoutReadings'; export {manualFields,applyManualTarget,knownWorkoutDistance} from './src/manualWorkoutControl'; export {AccountBootstrap} from './src/Accounts'; export {wrapAccountDatabase,accountState} from './src/accountClient'; export {WeightLossBuilder} from './src/WeightLossBuilder'; export {IPhoneLanding} from './src/IPhoneLanding'; export {needsIPhoneLanding} from './src/browserSupport'; export {SettingsLayout} from './src/SettingsLayout'; export {EquipmentConnection} from './src/EquipmentConnection'; export {WorkoutRecap,WeeklyProgress,IntervalCue} from './src/WorkoutFeedback'; export {intervalCue} from './src/feedbackStats';`,
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
          contents:
            "export const useState=(...args)=>m.useState(...args); export const useEffect=(...args)=>m.useEffect(...args);",
        }));
      },
    },
  ],
});
code = built.outputFiles[0].text + "\n" + code;
once(
  "function Xv() {",
  "function Xv() {\n const [__recap,__setRecap] = m.useState(null); const __manualLock=m.useRef(false),__manualMotion=m.useRef(null);",
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
const replacement = `c.jsx(__feedback.SettingsLayout,{busy:!!v,units:${raw(controls[0])},connection:${raw(controls[2])},backup:c.jsxs(c.Fragment,{children:[${raw(actions[0])},${raw(actions[1])}]}),refresh:${raw(maintenance[2])},install:${raw(actions[3])},erase:${raw(data[3])}})`;
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
        "Upload indoor workouts to your Strava account. Your local history stays on this device.",
        "Upload indoor workouts to your Strava account.",
      )
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
  "__feedback.needsIPhoneLanding() ? c.jsx(__feedback.IPhoneLanding,{}) : c.jsx(__feedback.AccountBootstrap,{children:c.jsx(oh, { children: c.jsx(Xv, {}) })})",
);
once(
  'c.jsx("div", {\n                  className: "programme-filters",',
  'c.jsx(__feedback.WeightLossBuilder,{initialKind:H,onCreate:Ie,disabled:!!v||Ce}), c.jsx("div", {\n                  className: "programme-filters",',
);
once('["All", "15", "30", "45"]', '["All", "15", "20", "30", "45"]');
once(
  "  }),\n  nr = async (a, i) =>",
  "  }).then(__feedback.wrapAccountDatabase),\n  nr = async (a, i) =>",
);
once(
  'new URL(location.href).searchParams.has("strava")',
  '(new URL(location.href).searchParams.has("strava") || new URL(location.href).searchParams.has("account"))',
);
once("Delete local workout history?", "Delete workout history?");
once(
  'children: "Private by design. Stored on your device.",',
  'children: __feedback.accountState().user ? "Private account storage. Available offline." : "Private by design. Stored on your device.",',
);
// Add the shared manual-control engine to the current production variable contract.
const sourceApp = ts.createSourceFile(
  "main.tsx",
  await fs.readFile("src/main.tsx", "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
let adjustmentInit, adjustmentFunction;
function locateSource(n) {
  if (
    ts.isVariableDeclaration(n) &&
    n.name.getText(sourceApp) === "adjustmentFields"
  )
    adjustmentInit = n.initializer.getText(sourceApp);
  if (ts.isFunctionDeclaration(n) && n.name?.text === "adjustWorkout")
    adjustmentFunction = n.getText(sourceApp);
  ts.forEachChild(n, locateSource);
}
locateSource(sourceApp);
if (!adjustmentInit || !adjustmentFunction)
  throw Error("Manual source integration missing");
const manualSource = ts.createSourceFile(
  "manual.ts",
  "const adjustmentFields=" + adjustmentInit + ";\n" + adjustmentFunction,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);
const names = {
  adjustmentFields: "__adjustmentFields",
  adjustWorkout: "__adjustWorkout",
  manualLock: "__manualLock",
  machineMotion: "__manualMotion",
  epoch: "ct",
  state: "pt",
  busy: "Ce",
  setBusy: "Ft",
  setError: "tt",
  canControl: "Mt",
  fresh: "xn",
  setHold: "Ge",
  sent: "Ut",
  setSession: "Se",
  takeLock: "M",
  lastCommand: "ln",
  expected: "En",
  device: "jt",
  ft: "K",
  it: "J",
  event: "gn",
  setRunning: "qe",
  session: "v",
  kind: "H",
  observed: "we",
  metrics: "Xe",
};
const shared = {
  manualFields: "manualFields",
  applyManualTarget: "applyManualTarget",
};
const transformed = ts.transform(manualSource, [
  (context) => (root) =>
    ts.visitNode(root, function visit(node) {
      if (
        ts.isIdentifier(node) &&
        !(
          ts.isPropertyAccessExpression(node.parent) &&
          node.parent.name === node
        ) &&
        !(ts.isPropertyAssignment(node.parent) && node.parent.name === node)
      ) {
        if (shared[node.text])
          return ts.factory.createPropertyAccessExpression(
            ts.factory.createIdentifier("__feedback"),
            shared[node.text],
          );
        if (names[node.text])
          return ts.factory.createIdentifier(names[node.text]);
      }
      return ts.visitEachChild(node, visit, context);
    }),
]);
const manualJs = ts.transpileModule(
  ts.createPrinter().printFile(transformed.transformed[0]),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
    },
  },
).outputText;
transformed.dispose();
once(
  "  async function Ke(y = !1) {",
  manualJs +
    "\n const __adjustmentControls=c.jsx(__feedback.WorkoutAdjustments,{fields:__adjustmentFields,disabled:!xe||!Ne||Ce||Ue===false,onApply:__adjustWorkout});\n  async function Ke(y = !1) {",
);
once(
  "    if (X) return;\n    ((ln.current",
  "    if (X || pt.current.hold || !pt.current.running || !pt.current.connected) return;\n    ((ln.current",
);
once(
  "if (!v || !xe || Ce) return;",
  "if (!v || !xe || Ce || __manualLock.current) return;",
);
once(
  "const Ue = J.connected ? J.metrics.running : K.machineRunning;",
  "const Ue = J.connected ? J.metrics.running : K.machineRunning; __manualMotion.current=Ue ?? null;",
);
once(
  'Ge(!(v != null && v.automatic) || v?.controlMode === "follow")',
  'Ge(!(v != null && v.automatic) || v?.controlMode === "follow" || v?.controlMode === "manual")',
);
once(
  "Ee =\n      v != null",
  'Ee = v?.controlMode === "manual" ? "manual" :\n      v != null',
);
once('(y === "automatic" && (Ce || Qe))', '(y !== "follow" && (Ce || Qe))');
once('Ge(y === "follow")', 'Ge(y !== "automatic")');
once(
  '"Automatic programme targets selected",',
  'y === "manual" ? "Manual equipment controls selected" : "Automatic programme targets selected",',
);
once(
  'c.jsx("div", {\n                  className: "view-tabs",',
  '__adjustmentControls, c.jsx("div", {\n                  className: "view-tabs",',
);
once(
  "initialRouteId: v.sceneryId,",
  "initialRouteId: v.sceneryId, manualControls:__adjustmentControls,",
);
once(
  "initialRouteId: O,",
  "initialRouteId: O, manualControls:__manualControls,",
);
once(
  'button:not(:disabled),[tabindex="0"]',
  'button:not(:disabled),input:not(:disabled),summary,[tabindex="0"]',
);
// Place controls inside the existing fullscreen top grid; Stop remains in the bottom overlay.
const overlayAst = ts.createSourceFile(
  "overlay.js",
  code,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
let topChildren;
function findTop(n) {
  if (
    ts.isCallExpression(n) &&
    n.arguments[0]?.text === "div" &&
    n.arguments[1]?.properties?.some(
      (p) =>
        p.name?.getText(overlayAst) === "className" &&
        p.initializer?.text === "immersion-top",
    )
  )
    topChildren = n.arguments[1].properties.find(
      (p) => p.name?.getText(overlayAst) === "children",
    ).initializer;
  ts.forEachChild(n, findTop);
}
findTop(overlayAst);
if (!topChildren || !ts.isArrayLiteralExpression(topChildren))
  throw Error("Immersive control grid changed");
code =
  code.slice(0, topChildren.end - 1) +
  'c.jsx("div",{className:"immersion-adjustments",children:__manualControls}),' +
  code.slice(topChildren.end - 1);
const modeCount = code.split("c.jsx(xf,").length - 1;
if (modeCount !== 2) throw Error("Control-mode contract changed");
code = code.split("c.jsx(xf,").join("c.jsx(__feedback.ControlMode,");
once(
  "c.jsx(__workoutPatch.WorkoutReadings, {",
  "c.jsx(__feedback.WorkoutReadings, {",
);
once(
  "function Ri({ label: a, value: i, unit: s }) {",
  "function Ri({ label: a, value: i, unit: s }) { if(!__feedback.hasMetricValue(i))return null;",
);
once(
  "distance: v.distance ?? 0,",
  "distance: __feedback.knownWorkoutDistance(v.distance,Xe.speedKmh,Xe.totalDistanceM),",
);
once(
  '? "Following machine"\n                          : "Automatic"',
  '? "Following machine"\n                          : Ee === "manual" ? "Manual" : "Automatic"',
);
const readingsAst = ts.createSourceFile(
  "readings.js",
  code,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
let targetHeading;
function findHeading(n) {
  if (
    ts.isCallExpression(n) &&
    n.arguments[0]?.text === "h3" &&
    n.getText(readingsAst).includes("q.block.speed")
  )
    targetHeading = n;
  ts.forEachChild(n, findHeading);
}
findHeading(readingsAst);
if (!targetHeading) throw Error("Session target heading changed");
code =
  code.slice(0, targetHeading.getStart(readingsAst)) +
  'Ee === "automatic" && ' +
  code.slice(targetHeading.getStart(readingsAst));
once(
  '"Following machine \\xB7 use physical controls"',
  'Ee === "manual" ? "Manual targets · use Adjust equipment" : "Following machine \\xB7 use physical controls"',
);
once(
  '"Programme targets are applied automatically. Physical changes take priority."',
  'Ee === "manual" ? "Manual targets selected. Automatic programme changes are held." : "Programme targets are applied automatically. Physical changes take priority."',
);
const historyCaps = code.split(".slice(0, 200)").length - 1;
if (historyCaps !== 3)
  throw Error("Production history retention contract changed");
code = code
  .split(".slice(0, 200)")
  .join(".slice(0, __feedback.accountState().user ? undefined : 200)");
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
  (await fs.readFile("src/iphone-landing.css", "utf8")) +
  "\n" +
  (await fs.readFile("src/weight-loss.css", "utf8")) +
  "\n" +
  (await fs.readFile("src/accounts.css", "utf8")) +
  "\n" +
  (await fs.readFile("src/workout-controls.css", "utf8"));
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
