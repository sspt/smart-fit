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
    contents: `export {t,setDocumentLanguage} from "./src/i18n"; export {LanguagePicker} from "./src/i18n/LanguagePicker"; export {routeDetails} from "./src/routePresentation"; export {parseVideoInfo} from "./src/videoInfo"; export {useFtms} from "./src/ble"; export {useRouteSpeed} from "./src/useRouteSpeed";`,
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "iife",
  globalName: "__routeRelease",
  jsxFactory: "m.createElement",
  jsxFragment: "m.Fragment",
  tsconfigRaw: { compilerOptions: { jsx: "react" } },
  minify: false,
  plugins: [
    {
      name: "production-react",
      setup(b) {
        const adapters = {
          react:
            "export const useState=(...a)=>m.useState(...a), useEffect=(...a)=>m.useEffect(...a), useRef=(...a)=>m.useRef(...a), useCallback=(...a)=>m.useCallback(...a);",
          "./bleLog": "export const logBleEvent=(...args)=>re(...args);",
          "./passiveProbe":
            "export const beginPassiveSession=(...args)=>Lf(...args),endPassiveSession=()=>Af(),recordFtmsMetrics=(...args)=>cg(...args),recordPassiveObservation=(...args)=>Ca(...args);",
        };
        b.onResolve(
          { filter: /^(react|\.\/(bleLog|passiveProbe))$/ },
          ({ path }) => ({ path, namespace: "production-runtime" }),
        );
        b.onLoad(
          { filter: /.*/, namespace: "production-runtime" },
          ({ path }) => ({ contents: adapters[path] }),
        );
      },
    },
  ],
});
// The released UI passes a legacy picker flag before its remembered device.
const hookStart = code.indexOf("function Gv() {");
const hookEnd = code.indexOf("function Gf(", hookStart);
if (
  hookStart < 0 ||
  hookEnd <= hookStart ||
  !code
    .slice(hookStart, hookEnd)
    .includes("No recognized FTMS Data characteristic")
)
  throw Error("Production FTMS hook changed");
code =
  code.slice(0, hookStart) +
  "function Gv(){return __routeRelease.useFtms()}\n" +
  code.slice(hookEnd);
once("oe,\n            !0,\n            k,", "oe, k,");
once("W,\n      !0,\n    ),\n      oe &&", "W,\n    ),\n      oe &&");
const parserStart = code.indexOf("function ih(a) {");
const parserEnd = code.indexOf("const Ll =", parserStart);
if (
  parserStart < 0 ||
  parserEnd <= parserStart ||
  !code.slice(parserStart, parserEnd).includes("Invalid info.json")
)
  throw Error("Production catalogue parser changed");
code =
  code.slice(0, parserStart) +
  "function ih(data){return __routeRelease.parseVideoInfo(data, Sa)}\n" +
  code.slice(parserEnd);

once(
  'm.createElement("div", { className: "settings-units" }, u.units)',
  'm.createElement("div", { className: "settings-units" }, u.units, m.createElement(__routeRelease.LanguagePicker,{disabled:u.busy}))',
);
once(
  'm.createElement("h1", null, "Settings")',
  'm.createElement("h1", null, __routeRelease.t("Settings"))',
);
once(
  'children:\n                        {\n                          Train: "Home",',
  'children:__routeRelease.t({\n                          Train: "Home",',
);
once("}[k] ?? k,", "}[k] ?? k),");
once(
  "c.jsx(ch, { src: a.src, poster: a.poster }, a.src + a.poster)",
  'c.jsx(ch, {src:a.src, poster:a.poster || (!matchMedia("(prefers-reduced-motion: reduce)").matches && a.gif) || ""}, a.src + a.poster)',
);
once(
  "children: [c.jsx(Ye, { name: a.kind, size: 17 }), a.kind]",
  "children: [c.jsx(Ye, { name: a.kind, size: 17 }), __routeRelease.t(a.kind)]",
);
once('children: d === "All" ? "All" : d', "children: __routeRelease.t(d)");
once(
  '"aria-label": "Preview " + a.name',
  '"aria-label": __routeRelease.t("Preview")+" "+a.name',
);
once(
  '              " \\xB7 moves at your pace",',
  '              __routeRelease.routeDetails(a) ? " · "+__routeRelease.routeDetails(a) : "",',
);
once(
  'children: ["Footage by ", a.author]',
  'children: [__routeRelease.t("Footage by")+" ",__routeRelease.t(a.author)]',
);
once(
  'children: a.name.replace(" \\xB7 scenic loop", ""),\n              }),\n              c.jsxs("p", {',
  'children:a.name.replace(" · scenic loop",""),}), __routeRelease.routeDetails(a) && c.jsx("p",{children:__routeRelease.routeDetails(a)}), a.originalName && a.originalName !== a.name && c.jsxs("p",{children:[__routeRelease.t("Original title"),": ",a.originalName]}),c.jsxs("p",{',
);
for (const label of [
  "Display units",
  "Kilometres",
  "Miles",
  "Set up workout",
  "Review workout",
  "Open workout",
  "THE SCENERY COLLECTION",
  "Choose your elsewhere.",
  "A woodland path. An autumn ride. A river with no hurry.",
  "Filter by equipment",
  "Scenery preview",
  "Close scenery preview",
  "Use this scene",
  "Scenery pages",
  "Nature route",
  "Scenic loop",
  "Continuous footage",
  "Your data",
  "App & data tools",
]) {
  const literal = JSON.stringify(label);
  if (!code.includes(literal)) continue;
  code = code.split(literal).join(`__routeRelease.t(${literal})`);
}
once(
  "[tt, ae] = m.useState(M[0].reference)",
  "[fallbackReference,ae]=m.useState(M[0].reference)",
);
once(
  "    Ot = Sh(",
  '    {reference:tt,profileActive,setVideoTime}=__routeRelease.useRouteSpeed(le && $ !== "local" ? xt?.percursoSrc : undefined,fallbackReference), Ot=Sh(',
);
once(
  'onLoadedMetadata: () => {\n                  (be(!0), _(""));',
  'onTimeUpdate:profileActive?e=>setVideoTime(e.currentTarget.currentTime):undefined,onSeeked:profileActive?e=>setVideoTime(e.currentTarget.currentTime):undefined,onLoadedMetadata:e=>{setVideoTime(e.currentTarget.currentTime);(be(!0),_(""));',
);
once(
  "value: tt,\n                          onChange:",
  "value:fallbackReference,\n                          onChange:",
);
code =
  built.outputFiles[0].text +
  "\n__routeRelease.setDocumentLanguage();\n" +
  code;
code = (await transform(code, { minify: true, target: "es2022" })).code;
const hash = createHash("sha256").update(code).digest("hex").slice(0, 12),
  path = "/assets/feedback-" + hash + ".js";
await fs.writeFile(root + path, code);
html = html.replace(old, path);
const css = html.match(/href="(\/assets\/[^"\s]+\.css)"/)[1];
const cssPath = css;
await fs.writeFile(root + "/index.html", html);

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
