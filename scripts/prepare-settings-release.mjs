/** Prepare settings/header changes against the current production app, retaining newer integrations. */
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import prettier from "prettier";
import ts from "typescript";
import { transform } from "esbuild";
const root = "artifacts/visual-release";
let html = await fs.readFile(root + "/index.html", "utf8");
const oldPath = html.match(/src="(\/assets\/[^"\s]+\.js)"/)[1];
const original = await fs.readFile(root + oldPath, "utf8");
let code = await prettier.format(original, { parser: "babel" });
const ast = ts.createSourceFile(
  "production.js",
  code,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.JS,
);
const prop = (object, key) =>
  object.properties.find((p) => p.name?.getText(ast) === key)?.initializer;
const calls = [];
function collect(n) {
  if (
    ts.isCallExpression(n) &&
    n.arguments[1] &&
    ts.isObjectLiteralExpression(n.arguments[1])
  )
    calls.push(n);
  ts.forEachChild(n, collect);
}
collect(ast);
const props = (n) => n.arguments[1];
const byClass = (cls) =>
  calls.filter((n) => prop(props(n), "className")?.text === cls);
const cache = byClass("cache-refresh");
const header = byClass("header-tools");
if (cache.length !== 1 || header.length !== 1)
  throw Error("Header or cache contract changed");
const cacheText = cache[0].getText(ast);
const runtime = cache[0].expression.expression.getText(ast);
const edits = [];
const replace = (n, value) => edits.push([n.getStart(ast), n.end, value]);
const headerChildren = prop(props(header[0]), "children");
if (
  !ts.isArrayLiteralExpression(headerChildren) ||
  headerChildren.elements.length !== 3 ||
  !headerChildren.elements[0].getText(ast).endsWith(".control")
)
  throw Error("Header children changed");
replace(headerChildren, "[" + headerChildren.elements[2].getText(ast) + "]");
const maxLabel = calls.filter(
  (n) =>
    n.arguments[0]?.text === "label" &&
    prop(props(n), "children")
      ?.getText(ast)
      .includes('"Maximum treadmill speed (km/h)"'),
);
if (maxLabel.length !== 1) throw Error("Manual speed field changed");
const maintenance = `${runtime}.jsxs("section",{className:"settings-maintenance","aria-labelledby":"maintenance-title",children:[${runtime}.jsx("h2",{id:"maintenance-title",children:"App maintenance"}),${runtime}.jsx("p",{children:"Refresh the app while keeping programmes, settings and history."}),${cacheText}]})`;
replace(maxLabel[0], maintenance);
const media = calls.filter(
  (n) =>
    n.expression.getText(ast) === runtime + ".jsx" &&
    n.arguments[0]?.getText(ast) === "lh" &&
    prop(props(n), "disabled")?.getText(ast) === "!!y",
);
if (media.length !== 1) throw Error("Video server settings call changed");
replace(media[0], "null");
const sections = [...byClass("settings-data"), ...byClass("strava-settings")];
if (sections.length < 2) throw Error("Remaining settings sections missing");
for (const n of sections) {
  if (prop(props(n), "open")) throw Error("Settings already changed");
  edits.push([
    props(n).getStart(ast) + 1,
    props(n).getStart(ast) + 1,
    "open:true,",
  ]);
}
// Remove the saved user cap, leaving the protocol's reported range validation/clamping intact.
let caps = 0,
  restores = 0,
  guards = 0,
  clamps = 0;
function visit(n) {
  if (
    ts.isObjectLiteralExpression(n) &&
    prop(n, "maxSpeed")?.getText(ast) === "jt" &&
    prop(n, "units")
  ) {
    replace(n, "{units:" + prop(n, "units").getText(ast) + "}");
    caps++;
    return;
  }
  if (
    ts.isCallExpression(n) &&
    n.expression.getText(ast) === "on" &&
    n.arguments[0]?.getText(ast).includes(".maxSpeed")
  ) {
    replace(n, "void 0");
    restores++;
    return;
  }
  if (
    ts.isCallExpression(n) &&
    n.expression.getText(ast) === "Math.min" &&
    n.arguments.length === 2 &&
    n.arguments[0].getText(ast) === "jt" &&
    n.arguments[1].getText(ast) === "v.speed"
  ) {
    replace(n, "v.speed");
    clamps++;
    return;
  }
  if (
    ts.isIfStatement(n) &&
    n.thenStatement
      .getText(ast)
      .includes('"Programme exceeds your speed limit."')
  ) {
    replace(n, "");
    guards++;
    return;
  }
  ts.forEachChild(n, visit);
}
visit(ast);
if (caps !== 2 || restores !== 2 || guards !== 1 || clamps !== 1)
  throw Error(
    "Speed settings contract changed: " +
      JSON.stringify({ caps, restores, guards, clamps }),
  );
for (const [a, b, value] of edits.sort((a, b) => b[0] - a[0]))
  code = code.slice(0, a) + value + code.slice(b);
const built = (
  await transform(code, { loader: "js", target: "es2022", minify: true })
).code;
const hash = createHash("sha256").update(built).digest("hex").slice(0, 12);
const next = "/assets/settings-" + hash + ".js";
await fs.writeFile(root + next, built);
await fs.writeFile(root + "/index.html", html.replace(oldPath, next));
const assets = JSON.parse(
  await fs.readFile(root + "/offline-assets.json", "utf8"),
);
await fs.writeFile(
  root + "/offline-assets.json",
  JSON.stringify([...new Set([...assets, next])]),
);
const sw = await fs.readFile(root + "/sw.js", "utf8");
const updated = sw.replace(
  /(const\s+CACHE\s*=\s*")(.*?)(")/,
  (_m, a, v, z) => a + v + "-settings-" + hash + z,
);
if (sw === updated) throw Error("Service-worker cache contract changed");
await fs.writeFile(root + "/sw.js", updated);
await fs.writeFile(
  "artifacts/settings-release-baseline.json",
  JSON.stringify(
    {
      originalScript: oldPath,
      originalSha256: createHash("sha256").update(original).digest("hex"),
      publishedScript: next,
      note: "Guarded settings/header patch retains equipment metrics, programme duration tiles, Strava and live Worker.",
    },
    null,
    2,
  ),
);
console.log("Prepared settings release:", next);
