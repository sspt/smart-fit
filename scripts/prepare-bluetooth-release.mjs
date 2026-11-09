/** Restrict workout pickers in the current production shell; retain all other app features. */
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
const edits = [];
function visit(n) {
  if (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    n.expression.name.text === "requestDevice" &&
    n.arguments[0] &&
    ts.isObjectLiteralExpression(n.arguments[0])
  ) {
    const options = n.arguments[0];
    const services = options.properties.find(
      (p) => p.name?.getText(ast) === "optionalServices",
    )?.initializer;
    // Live FTMS and iFIT pickers request one or two services. The separate diagnostic
    // scanner requests a named service collection and deliberately retains its behavior.
    if (
      services &&
      ts.isArrayLiteralExpression(services) &&
      [1, 2].includes(services.elements.length)
    )
      edits.push([
        options.getStart(ast),
        options.end,
        services.elements.length === 1
          ? '__fitnessPickerOptions("iFIT")'
          : "__fitnessPickerOptions()",
      ]);
  }
  ts.forEachChild(n, visit);
}
visit(ast);
if (edits.length !== 3)
  throw Error("Production workout picker contract changed: " + edits.length);
for (const [a, b, text] of edits.sort((a, b) => b[0] - a[0]))
  code = code.slice(0, a) + text + code.slice(b);
let helper = (
  await transform(await fs.readFile("src/bluetoothPicker.ts", "utf8"), {
    loader: "ts",
    format: "esm",
  })
).code.replace(/export\s*\{[^}]*\};?\s*$/, "");
code =
  "const __fitnessPickerOptions=(()=>{" +
  helper +
  ";return fitnessPickerOptions;})();\n" +
  code;
const built = (
  await transform(code, { loader: "js", target: "es2022", minify: true })
).code;
const version = createHash("sha256").update(built).digest("hex").slice(0, 12);
const next = "/assets/bluetooth-" + version + ".js";
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
  (_m, a, v, z) => a + v + "-bluetooth-" + version + z,
);
if (sw === updated) throw Error("Service-worker cache contract changed");
await fs.writeFile(root + "/sw.js", updated);
await fs.writeFile(
  "artifacts/bluetooth-release-baseline.json",
  JSON.stringify(
    {
      originalScript: oldPath,
      originalSha256: createHash("sha256").update(original).digest("hex"),
      publishedScript: next,
      workoutPickersUpdated: edits.length,
    },
    null,
    2,
  ),
);
console.log("Prepared Bluetooth release:", next);
