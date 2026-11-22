import { localizeUI } from "./localize-ui.mjs";
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
    contents: `export {ProgrammeChoice} from "./src/ProgrammeChoice"; export {copyProgramme,programmeId} from "./src/programmeDraft"; export {startMobileFullscreen} from "./src/mobileFullscreen"; export {usePageSize,InfiniteScroll} from "./src/Pagination"; export {availableProgrammes} from "./src/programmeValidation"; export {t,uiText,setDocumentLanguage} from "./src/i18n"; export {LanguagePicker} from "./src/i18n/LanguagePicker"; export {routeDetails} from "./src/routePresentation"; export {parseVideoInfo} from "./src/videoInfo"; export {useFtms} from "./src/ble"; export {useRouteSpeed} from "./src/useRouteSpeed";`,
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
          "react/jsx-runtime":
            "export const jsx=(...a)=>c.jsx(...a),jsxs=(...a)=>c.jsxs(...a),Fragment=c.Fragment;",
          react:
            "export const useState=(...a)=>m.useState(...a), useEffect=(...a)=>m.useEffect(...a), useRef=(...a)=>m.useRef(...a), useCallback=(...a)=>m.useCallback(...a);",
          "./bleLog": "export const logBleEvent=(...args)=>re(...args);",
          "./passiveProbe":
            "export const beginPassiveSession=(...args)=>Lf(...args),endPassiveSession=()=>Af(),recordFtmsMetrics=(...args)=>cg(...args),recordPassiveObservation=(...args)=>Ca(...args);",
        };
        b.onResolve(
          { filter: /^(react|react\/jsx-runtime|\.\/(bleLog|passiveProbe))$/ },
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
for (const kind of ["Treadmill", "Bike", "Rower"]) {
  once(
    `m.createElement("option", null, "${kind}")`,
    `m.createElement("option", { value: "${kind}" }, "${kind}")`,
  );
}
once('c.jsx("h1", { children: "Choose your elsewhere." }),', "");
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
once(
  'const uh = ["Connect", "Programme", "Scene", "Start"]',
  'const uh = ["Connect", "Programme", "Scene", "Start"].map(label => __routeRelease.uiText(label))',
);
once(
  'className: "eyebrow", children: [d]',
  'className: "eyebrow", children: [__routeRelease.t(d)]',
);
once(
  'm.createElement("option", { key: g, value: g }, g)',
  'm.createElement("option", { key: g, value: g }, __routeRelease.t(g))',
);
once(
  "`Choose a programme for your ${d.toLowerCase()}.`",
  "`Choose a programme for your ${__routeRelease.t(d)}.`",
);
once(
  '"Connect your ",\n                  a.kind.toLowerCase(),\n                  " to match video playback to your speed.",',
  '"Connect your equipment to match video playback to your speed.",',
);
once(
  "p = uc(),\n    h = window.innerWidth <= 700 ? p + 1 : p,",
  "h = __routeRelease.usePageSize(true),",
);
once(
  "Ht = he.filter(",
  "usableProgrammes = m.useMemo(()=>__routeRelease.availableProgrammes(he),[he]), Ht = usableProgrammes.filter(",
);
once("[A, ce, K, Ae, he.length]", "[A, ce, K, Ae, usableProgrammes.length]");
once("        he,\n        O,", "        usableProgrammes,\n        O,");
once(
  "journeySelection(we, he, O, Z, ut)",
  "journeySelection(we, usableProgrammes, O, Z, ut)",
);
once(
  "\n              programmes: he,",
  "\n              programmes: usableProgrammes,",
);
once(
  "he.find((oe) => oe.id === Z",
  "usableProgrammes.find((oe) => oe.id === Z",
);
once("existing: he.some(", "existing: usableProgrammes.some(");
once(
  "W.findIndex((oe) => oe.id === k.id)",
  "W.findIndex((oe) => oe?.id === k.id)",
);
once(
  "W.map((oe) => (oe.id === k.id ? k : oe))",
  "W.map((oe) => (oe?.id === k.id ? k : oe))",
);
once("k.filter((W) => W.id !== gt.id)", "k.filter((W) => W?.id !== gt.id)");
once(
  "[x, C] = Y(u)",
  '[x, C] = Y(["Treadmill", "Bike", "Rower"].includes(u) ? u : "Treadmill")',
);
once("new Set(i.map((d) => d.id))", "new Set(i.map((d) => d?.id))");
const paginationStart = code.indexOf("function ms({ page:");
const paginationEnd = code.indexOf("function Cf(", paginationStart);
if (
  paginationStart < 0 ||
  paginationEnd <= paginationStart ||
  !code
    .slice(paginationStart, paginationEnd)
    .includes('className: "pagination"')
)
  throw Error("Production list controls changed");
code =
  code.slice(0, paginationStart) +
  "function ms(props){return c.jsx(__routeRelease.InfiniteScroll,props)}\n" +
  code.slice(paginationEnd);
for (const [page, size] of [
  ["Ae", "We"],
  ["y", "h"],
  ["Y", "Ae"],
  ["M", "Ae"],
]) {
  once(
    `.slice(${page} * ${size}, (${page} + 1) * ${size})`,
    `.slice(0, (${page} + 1) * ${size})`,
  );
}
once("M.slice($, $ + 1)", "M.slice(0, $ + 1)");
const discoverHeader = code.indexOf('          className: "screen-heading",');
const discoverFilters = code.indexOf(
  "        c.jsx(Rf, { value: j, onChange: i, includeAll: !1 }),",
  discoverHeader,
);
if (discoverHeader < 0 || discoverFilters < 0)
  throw Error("Production Discover header changed");
const discoverEnd = code.indexOf("\n", discoverFilters);
const discoverStart = code.lastIndexOf(
  '        c.jsxs("div", {',
  discoverHeader,
);
code =
  code.slice(0, discoverStart) +
  '        c.jsx("div",{className:"list-heading discover-toolbar",children:c.jsx(Rf,{value:j,onChange:i,includeAll:!1})}),' +
  code.slice(discoverEnd);
once(
  '                c.jsxs("section", {\n                  className: "section-head",\n                  id: "programmes",',
  '                c.jsxs("div",{className:"list-heading library-toolbar",children:[c.jsxs("section",{className:"section-head",id:"programmes",',
);
const libraryTitle = code.indexOf('children: "MAKE TIME FOR YOURSELF"');
const titleStart = code.lastIndexOf(
  '                    c.jsxs("div", {',
  libraryTitle,
);
const titleEnd = code.indexOf(
  '                    c.jsxs("button", {',
  libraryTitle,
);
if (libraryTitle < 0 || titleStart < 0 || titleEnd < 0)
  throw Error("Production Library title changed");
code = code.slice(0, titleStart) + code.slice(titleEnd);
const builder =
  "                c.jsx(__feedback.WeightLossBuilder, {\n                  initialKind: we,\n                  onCreate: ft,\n                  disabled: !!L || ot,\n                }),\n";
once(builder, "");
once(
  '                c.jsx("div", {\n                  className: "cards",',
  "                ]}),\n" +
    '                c.jsx("div", {\n                  className: "cards",',
);
once('className: "setup-topline"', 'className: "setup-topline list-heading"');
once('m.createElement("h1", null, __routeRelease.t("Settings")),', "");
once(
  'c.jsx("p", {\n                  className: "eyebrow",\n                  children: "SCENES FROM YOUR JOURNEY",\n                }),\n                c.jsx("h1", { children: "Your journey." }),',
  "",
);
for (const [first, last] of [
  [
    '        c.jsx("div", {\n          className: "routes-grid",',
    'label: __routeRelease.t("Scenery pages"),\n          }),',
  ],
  [
    '                c.jsx("div", {\n                  className: "cards",',
    'label: "Programme pages",\n                }),',
  ],
]) {
  once(
    first,
    'c.jsxs("div",{className:"list-scroll",tabIndex:0,children:[\n' + first,
  );
  once(last, last + "\n]}),");
}
once(
  'className: "icon-button",\n              onClick: Te,\n              "aria-label": "Close programme editor",\n              children: c.jsx(Ye, { name: "close" }),',
  'className:"editor-close-button",onClick:Te,"aria-label":"Close programme editor",children:[c.jsx(Ye,{name:"close"}),__routeRelease.t("Close")],',
);
once(
  "children: [c.jsx(Ye, { name: M }), M]",
  "children: [c.jsx(Ye, { name: M }), __routeRelease.t(M)]",
);
once('name: "My programme",', 'name:__routeRelease.t("My programme"),');
once("blocks: [yf()],", 'blocks:[yf(__routeRelease.t("Steady"))],');
once('yf("New segment")', 'yf(__routeRelease.t("New segment"))');
once(
  "label: Oe,\n                                      unit: Me,",
  "label:__routeRelease.t(Oe), unit: Me,",
);
once(
  'label: "End " + Oe.toLowerCase(),',
  'label:__routeRelease.t(Oe)+" · "+__routeRelease.t("End"),',
);
for (const draft of ["M", "h"]) {
  once(
    `name: ${draft}.name + " copy",`,
    `name: ${draft}.name + " · " + __routeRelease.t("copy"),`,
  );
}
once(
  "m.useState(() => structuredClone(a))",
  "m.useState(() => __routeRelease.copyProgramme(a))",
);
once(
  'm.useRef("field-" + crypto.randomUUID())',
  'm.useRef("field-" + __routeRelease.programmeId())',
);
once(
  'id: crypto.randomUUID(),\n                          name:__routeRelease.t("My programme"),',
  'id:__routeRelease.programmeId(), name:__routeRelease.t("My programme"),',
);
once(
  "id: crypto.randomUUID(),\n                      name: h.name +",
  "id:__routeRelease.programmeId(), name: h.name +",
);
once("ft(structuredClone(k))", "ft(__routeRelease.copyProgramme(k))");
once(
  "function xn(u, g = crypto.randomUUID())",
  "function xn(u, g = __routeRelease.programmeId())",
);
once(
  "structuredClone(vf.filter((d) => !o.has(d.id)))",
  "vf.filter((d) => !o.has(d.id)).map(__routeRelease.copyProgramme)",
);
once(
  'q((W) => (W === "All" ? "All" : k.kind))',
  'q((W) => (W === "All" ? "All" : k.kind))',
);
once(
  "[he, ze] = m.useState(Wd),",
  "[he, ze] = m.useState(Wd), [creating,setCreating]=m.useState(false),",
);
once(
  'onClick: () =>\n                        ft({\n                          id:__routeRelease.programmeId(), name:__routeRelease.t("My programme"),\n                          kind: A === "All" ? we : A,\n                          repeat: 1,\n                          blocks:[yf(__routeRelease.t("Steady"))],\n                        }),',
  "onClick:()=>setCreating(true),",
);
once(
  "          gt &&\n            c.jsx(Eh, {",
  '          creating && c.jsx(__routeRelease.ProgrammeChoice,{kind:we,disabled:!!L||ot,onClose:()=>setCreating(false),onManual:()=>{setCreating(false);ft({id:__routeRelease.programmeId(),name:__routeRelease.t("My programme"),kind:A==="All"?we:A,repeat:1,blocks:[yf(__routeRelease.t("Steady"))]})},onAutomatic:p=>{setCreating(false);ft(p)}}), gt &&\n            c.jsx(Eh, {',
);
// Keep the legacy editor and account screen aligned with the source UI.
once(
  '    ce = m.useRef(JSON.stringify(a)),\n    Te = () => {\n      (JSON.stringify(h) !== ce.current &&',
  `    ce = m.useRef(JSON.stringify(a)),
    dirty = JSON.stringify(h) !== ce.current,
    Te = () => {
      (dirty &&`,
);
once(
  '        d();\n    };\n  m.useEffect(() => {\n    var M;\n    const $ = document.activeElement;',
  `        d();
    };
  m.useEffect(() => {
    if (!dirty) return;
    const warnOnLeave = (event) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnOnLeave);
    return () => window.removeEventListener("beforeunload", warnOnLeave);
  }, [dirty]);
  m.useEffect(() => {
    var M;
    const $ = document.activeElement;`,
);
once(
  '                            c.jsx("button", {\n                              onClick: () => {\n                                confirm(\n                                  "Use the physical stop first.',
  `                            c.jsx("p", {
                              children: "Ending the workout recording leaves the equipment running if it is in motion.",
                            }),
                            c.jsx("button", {
                              onClick: () => {
                                confirm(
                                  "Use the physical stop first.`,
);
once(
  '                        : "I already have an account",\n                    ),\n                  ),\n                ),\n              ),',
  `                        : "I already have an account",
                    ),
                  ),
                ),
                x === "login" && m.createElement("details", {className: "account-options"},
                  m.createElement("summary", null, "Forgot your password?"),
                  m.createElement("p", {className: "subtle"},
                    "If you linked Google or Strava to this account, sign in with that provider. Email password reset is currently unavailable."),
                ),
              ),`,
);
const uiMessages = JSON.parse(
  await fs.readFile("src/i18n/uiMessages.json", "utf8"),
);
code = localizeUI(code, "production.js", {
  callee: "__routeRelease.uiText",
  hasMessage: (key) => Object.hasOwn(uiMessages, key),
});
code =
  built.outputFiles[0].text +
  "\n__routeRelease.setDocumentLanguage();\n__routeRelease.startMobileFullscreen();\n" +
  code;
code = (await transform(code, { minify: true, target: "es2022" })).code;
const hash = createHash("sha256").update(code).digest("hex").slice(0, 12),
  path = "/assets/feedback-" + hash + ".js";
await fs.writeFile(root + path, code);
html = html.replace(old, path);
const css = html.match(/href="(\/assets\/[^"\s]+\.css)"/)[1];
const style =
  (await fs.readFile(root + css, "utf8")) +
  "\n" +
  (await fs.readFile("src/infinite-scroll.css", "utf8"));
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
  JSON.stringify([
    ...new Set([...assets, path, cssPath, "/iphone-forest.jpg"]),
  ]),
);
// A CSS-only release also changes the cached app shell.
const shellVersion = createHash("sha256")
  .update(html)
  .digest("hex")
  .slice(0, 12);
let sw = await fs.readFile(root + "/sw.js", "utf8");
sw = sw.replace(
  /(const\s+(?:CACHE|CACHE_NAME|VERSION)\s*=\s*["'])([^"']+)(["'])/,
  (_, a, b, z) => a + "kwest-feedback-" + shellVersion + z,
);
await fs.writeFile(root + "/sw.js", sw);
console.log("Built production release:", hash);
