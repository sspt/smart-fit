/** Run after prepare-visual-release. Retain the live app and replace its programme thumbnails. */
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
const property = (object, key) =>
  object.properties.find((p) => p.name?.getText(ast) === key)?.initializer;
const matches = [];
function visit(node) {
  if (
    ts.isCallExpression(node) &&
    node.arguments[1] &&
    ts.isObjectLiteralExpression(node.arguments[1])
  ) {
    const props = node.arguments[1],
      cls = property(props, "className");
    if (cls?.getText(ast).startsWith('"equipment e" +')) matches.push(node);
  }
  ts.forEachChild(node, visit);
}
visit(ast);
if (matches.length !== 1)
  throw Error("Production programme thumbnail contract changed");
const tile = matches[0];
const children = property(tile.arguments[1], "children");
if (!children || !ts.isArrayLiteralExpression(children))
  throw Error("Thumbnail children changed");
const strong = children.elements.find(
  (n) =>
    ts.isCallExpression(n) &&
    n.arguments[1] &&
    ts.isObjectLiteralExpression(n.arguments[1]) &&
    property(n.arguments[1], "className")?.text === "programme-duration",
);
const summary =
  strong && property(strong.arguments[1], "children")?.getText(ast);
if (!summary) throw Error("Programme duration expression missing");
const runtime = tile.expression.expression?.getText(ast);
if (!runtime || !ts.isIdentifier(tile.expression.expression))
  throw Error("JSX runtime changed");
const iconSource = await fs.readFile("src/AppIcon.tsx", "utf8");
const clock = iconSource.match(/clock:\s*"([^"]+)"/)?.[1];
if (!clock) throw Error("Source clock icon missing");
const replacement = `${runtime}.jsxs("div",{className:"programme-duration-tile",children:[${runtime}.jsx("svg",{width:28,height:28,viewBox:"0 0 24 24",fill:"none",stroke:"currentColor",strokeWidth:1.7,strokeLinecap:"round",strokeLinejoin:"round","aria-hidden":true,children:${runtime}.jsx("path",{d:${JSON.stringify(clock)}})}),${runtime}.jsx("strong",{children:${summary}})]})`;
code = code.slice(0, tile.getStart(ast)) + replacement + code.slice(tile.end);
const built = (
  await transform(code, { loader: "js", target: "es2022", minify: true })
).code;
const version = createHash("sha256").update(built).digest("hex").slice(0, 12);
const next = "/assets/programmes-" + version + ".js";
await fs.writeFile(root + next, built);
html = html.replace(oldPath, next);
await fs.writeFile(root + "/index.html", html);
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
  (_m, a, v, z) => a + v + "-programmes-" + version + z,
);
if (sw === updated) throw Error("Service worker cache contract changed");
await fs.writeFile(root + "/sw.js", updated);
await fs.writeFile(
  "artifacts/programme-release-baseline.json",
  JSON.stringify(
    {
      originalScript: oldPath,
      originalSha256: createHash("sha256").update(original).digest("hex"),
      publishedScript: next,
      note: "Only the programme thumbnail JSX is replaced. Other application functionality and Worker modules are retained.",
    },
    null,
    2,
  ),
);
console.log("Prepared programme release:", next);
