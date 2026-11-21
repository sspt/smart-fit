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
    contents: `export {useFtms} from "./src/ble"; export {useRouteSpeed} from "./src/useRouteSpeed";`,
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
code = built.outputFiles[0].text + "\n" + code;
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
once(
  "return i.flatMap((d) => {",
  `return i.flatMap((d) => {
  if (d?.path !== undefined) {
    if (typeof d.path !== "string" || !/^(?:[a-zA-Z0-9_-]+\\/)*[a-zA-Z0-9_-]+\\/?$/.test(d.path)) throw Error("Invalid video folder.");
    d = {...d, file:d.path.replace(/\\/?$/, "/video.mp4")};
  }`,
);
once(
  "skipSeconds: N,\n      seconds: 0,",
  "skipSeconds:N, seconds:Number.isFinite(d.durationSeconds)?d.durationSeconds:0,",
);
once(
  "src: p.href,\n      poster: h,",
  'src:p.href, ...(d.path ? {percursoSrc:new URL("percurso.json",p).href} : {}), poster:h,',
);
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
