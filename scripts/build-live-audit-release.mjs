import { localizeUI } from "./localize-ui.mjs";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import { transform } from "esbuild";
import prettier from "prettier";

const hash = (content) =>
  createHash("sha256").update(content).digest("hex").slice(0, 12);

async function buildLiveAuditRelease(root, snapshot) {
  await fs.rm(root, { recursive: true, force: true });
  await fs.cp("production/assets", root, { recursive: true });
  await fs.cp(snapshot, root, { recursive: true });
  const htmlFile = root + "/index.html";
  let html = await fs.readFile(htmlFile, "utf8");
  const script = html.match(/src="(\/assets\/feedback-[a-f0-9]+\.js)"/)[1];
  let code = await prettier.format(await fs.readFile(root + script, "utf8"), {
    parser: "babel",
  });

  function replaceOnce(from, to) {
    if (code.split(from).length !== 2)
      throw new Error("Live frontend contract changed: " + from.slice(0, 90));
    code = code.replace(from, () => to);
  }

  replaceOnce(
    "  m.useEffect(() => {\n    var N;\n    const U = document.activeElement;",
    `  m.useEffect(() => {
    if (JSON.stringify(f) === be.current) return;
    const warnOnLeave = (event) => {
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warnOnLeave);
    return () => window.removeEventListener("beforeunload", warnOnLeave);
  }, [f]);
  m.useEffect(() => {
    var N;
    const U = document.activeElement;`,
  );

  const messages = JSON.parse(
    await fs.readFile("src/i18n/uiMessages.json", "utf8"),
  );
  for (const [key, previous] of [
    ["30 min · Ride intervals", "30 min · Intervalos de passeio"],
    ["45 min · Endurance ride", "45 min · Passeio de resistência"],
    ["Finish tracking only", "Concluir apenas o rastreio"],
  ]) {
    const formatted = (value) =>
      JSON.stringify(value).replace(
        /[\u0080-\u00ff]/g,
        (character) =>
          "\\x" + character.codePointAt(0).toString(16).toUpperCase(),
      );
    replaceOnce(formatted(previous), formatted(messages[key][1]));
  }

  const equipment =
    "Ending the workout recording leaves the equipment running if it is in motion.";
  const forgot = "Forgot your password?";
  const recovery =
    "If you linked Google or Strava to this account, sign in with that provider. Email password reset is currently unavailable.";
  const localized = (key) => `__routeRelease.t(${JSON.stringify(key)})`;
  const controlNotices = [
    "Connect the equipment used by this workout.",
    "Manual control is not available for this equipment.",
    "Connect the equipment type used by this session.",
    "This bike uses resistance levels. Adjust them in Manual mode.",
    "Equipment control is not available. Check the Bluetooth connection.",
    "Reconnect equipment to use automatic control.",
    "Start a journey to use automatic control.",
  ];
  const revisedMessages = [
    "Train at your own pace",
    "Choose a programme and train along scenic routes.",
    "Discover routes",
    "Install kwest.fit ›",
    "15 min · Easy ride",
    "30 min · Brisk walk intervals",
    "30 min · Row intervals",
    "45 min · Endurance row",
    "Change scene",
    "Choose a scene",
    "Close",
    "Connect equipment",
    "First, connect the machine you’ll be moving with.",
    "Scene",
    "Select your machine using the Bluetooth picker.",
    "Sessions recorded",
    "Set up your journey",
    "Sign out",
    "Tailor a session",
    "Use this scene",
    "WORKOUT SETUP",
    "Weight change also depends on nutrition and recovery.",
    "Weight-loss programmes",
    "Your completed sessions will find a home here.",
    "Your scene is set.",
    "Your story starts here.",
    "○ Offline equipment",
    "Minimum walking speed (km/h)",
    "Maximum walking speed (km/h)",
    "Maximum incline (%)",
    "Weight-loss walk",
    "Weight-loss ride",
    "Weight-loss row",
    "Intervals",
    "Export backup",
    "Review programme",
    "Starting out",
    "Tailor a steady session or gentle intervals to your comfortable effort.",
    "Keep a conversational effort. Hills use your mid-range speed; warm-up, recovery and cooldown stay flat at your minimum. Use 0% for flat walking.",
    "Connect your equipment to match video playback to your speed.",
    "Tap a segment to change its targets.",
    "Build your session",
    "Resume",
    "Stop",
    "Pause",
    "Dismiss",
    "Manual",
    "Follow machine",
    "Stop & finish",
    "Scenery",
    "Real-world scenery",
    "Open scenery to move through nature at your own pace.",
    "Recovered workout. Reconnect equipment and explicitly resume.",
    "Open scenery",
    "Live",
    "Session",
    ...controlNotices,
  ];
  for (const key of controlNotices) {
    replaceOnce(JSON.stringify(key), localized(key));
  }
  const dictionaryEnd = "  };\n  function le(v, g = X()) {";
  replaceOnce(
    dictionaryEnd,
    [equipment, forgot, recovery, ...revisedMessages]
      .map(
        (key) =>
          `    ${JSON.stringify(key)}: ${JSON.stringify(messages[key])},`,
      )
      .concat(dictionaryEnd)
      .join("\n"),
  );

  const builderStart = code.indexOf("  function pe({\n    initialKind: v,");
  const builderEnd = code.indexOf("  function Q({", builderStart);
  if (builderStart === -1 || builderEnd === -1)
    throw new Error("Automatic programme builder contract changed");
  const builder = code.slice(builderStart, builderEnd);
  code = code.replace(builder, () =>
    localizeUI(builder, "programme-builder.js", {
      callee: "N",
      hasMessage: (key) => Object.hasOwn(messages, key),
    }),
  );
  for (const [key, expression] of [
    ["Equipment", "{ value: _, onChange: (it) => ye(it.target.value) }"],
    [
      "Session length",
      "{ value: se, onChange: (it) => ge(Number(it.target.value)) }",
    ],
    ["Activity level", "{ value: ze, onChange: (it) => fe(it.target.value) }"],
  ]) {
    replaceOnce(
      expression,
      `{ "aria-label": le(${JSON.stringify(key)}), ${expression.slice(2)}`,
    );
  }
  replaceOnce(
    '                    rn,\n                    m.createElement("input", {',
    '                    le(rn),\n                    m.createElement("input", {',
  );
  replaceOnce(
    '                  ct.label,\n                  m.createElement("input", {',
    '                  le(ct.label),\n                  m.createElement("input", {',
  );
  replaceOnce(
    "              na(rn instanceof Error ? rn.message :",
    "              na(rn instanceof Error ? le(rn.message) :",
  );
  replaceOnce(
    "        name: ct,\n        duration: it,",
    "        name: le(ct),\n        duration: it,",
  );
  replaceOnce(
    'name: `${W} min \xB7 Weight-loss ${O === "Treadmill" ? "walk" : O === "Bike" ? "ride" : "row"} \xB7 ${_ === "starting" ? "Steady" : "Intervals"}`,'.replaceAll(
      "\xB7",
      "\\xB7",
    ),
    'name: `${W} min · ${le(O === "Treadmill" ? "Weight-loss walk" : O === "Bike" ? "Weight-loss ride" : "Weight-loss row")} · ${le(_ === "starting" ? "Steady" : "Intervals")}`,',
  );
  replaceOnce(
    'children: [__routeRelease.t("Footage by") + " ", i.author],',
    'children: [__routeRelease.t("Footage by") + " ", i.author === "Video library" ? __routeRelease.t(i.author) : i.author],',
  );

  replaceOnce(
    '                                __routeRelease.uiText(\n                                  ". Physical controls always take precedence.",\n                                ),\n                              ],\n                            }),',
    `                                __routeRelease.uiText(
                                  ". Physical controls always take precedence.",
                                ),
                              ],
                            }),
                            c.jsx("p", {children: ${localized(equipment)}}),`,
  );
  replaceOnce(
    '.replace("{title}", () => i.name),',
    '.replace("{title}", () => __routeRelease.uiText(i.name, [], true)),',
  );
  replaceOnce(
    "onClick: () => Me(w),\n                        children: w,",
    "onClick: () => Me(w),\n                        children: __routeRelease.t(w),",
  );
  replaceOnce(
    'c.jsxs("small", { children: [I, " \\xB7 ", K] })',
    'c.jsxs("small", { children: [__routeRelease.t(I), " · ", K] })',
  );
  const signInEnd =
    '                        : __routeRelease.uiText("I already have an account"),\n                    ),\n                  ),\n                ),';
  replaceOnce(
    signInEnd,
    `${signInEnd}
                k === "login" && m.createElement("details", {className: "account-options"},
                  m.createElement("summary", null, ${localized(forgot)}),
                  m.createElement("p", {className: "subtle"}, ${localized(recovery)}),
                ),`,
  );

  replaceOnce(
    '      { className: "install-suggestion" },',
    '      { className: "home-install" },',
  );
  replaceOnce(
    '          "p",\n          null,\n          le(\n            ye',
    '          "p",\n          { role: "status" },\n          le(\n            ye',
  );
  replaceOnce(
    "                c.jsx(__routeRelease.InstallSuggestion, { prompt: Yt }),\n",
    "",
  );
  replaceOnce(
    `                c.jsxs("button", {
                  className: "home-library-link",
                  onClick: () => K("Programmes"),
                  children: [
                    __routeRelease.uiText("Programmes & editor "),
                    c.jsx(Ye, { name: "arrow", size: 16 }),
                  ],
                }),`,
    "                c.jsx(__routeRelease.InstallSuggestion, { prompt: Yt }),",
  );
  const entranceStart = code.indexOf(
    "  function I({ route: u, onStart: x, hasSession: b, connected: k, ready: j })",
  );
  const entranceEnd = code.indexOf(
    "  function K(u, x, b, k, j)",
    entranceStart,
  );
  if (
    entranceStart < 0 ||
    entranceEnd < 0 ||
    !code.slice(entranceStart, entranceEnd).includes('"cinema-entrance"')
  )
    throw new Error("Home screen contract changed");
  const entrance = (await fs.readFile("src/CinematicEntrance.tsx", "utf8"))
    .replace(/^import .*;\n/gm, "")
    .replace("export function CinematicEntrance", "function CinematicEntrance");
  const { code: entranceCode } = await transform(entrance, {
    loader: "tsx",
    jsxFactory: "m.createElement",
  });
  code =
    code.slice(0, entranceStart) +
    `  function I(props) {
    const AppIcon = T;
    const { t, uiText } = __routeRelease;
    ${entranceCode}
    return CinematicEntrance(props);
  }
` +
    code.slice(entranceEnd);
  replaceOnce(
    "                  route: jr,\n                  onStart: () => Nr(),",
    '                  route: jr,\n                  onStart: () => Nr(),\n                  onDiscover: () => K("Explore"),',
  );

  // Request native fullscreen from the immersive-view button gesture.
  const enterScenery = code.indexOf("  async function vn() {\n    var ie, We;");
  const expandEffect = code.indexOf("  m.useEffect", enterScenery);
  if (
    enterScenery < 0 ||
    expandEffect < 0 ||
    !code.slice(enterScenery, expandEffect).includes("ie.requestFullscreen")
  )
    throw new Error("Scenic expansion contract changed");
  code =
    code.slice(0, enterScenery) +
    `  function vn() {
    tt.current = document.activeElement;
    zt(!0);
    void xt.current?.requestFullscreen?.({navigationUI:"hide"}).catch(() => {});
  }
` +
    code.slice(expandEffect);

  replaceOnce(
    "        document.fullscreenElement || zt(!1);",
    "        document.fullscreenElement !== xt.current && zt(!1);",
  );

  const immersiveSource = (await fs.readFile("src/ImmersiveLayout.tsx", "utf8"))
    .replace(/^import .*;\n/gm, "")
    .replace(/^export /gm, "");
  const { code: immersiveCode } = await transform(immersiveSource, {
    loader: "tsx",
    jsxFactory: "m.createElement",
  });
  code =
    `const immersive = (() => {
    const useState = (...args) => m.useState(...args);
    ${immersiveCode}
    return { ImmersiveLayoutEditor, readImmersiveLayout, immersiveSlot, startWorkoutFullscreen, isWorkoutFullscreen, exitWorkoutFullscreen };
  })();\n` + code;

  replaceOnce(
    '        { className: "panel settings" },',
    '        { className: "panel settings" }, m.createElement(immersive.ImmersiveLayoutEditor),',
  );
  replaceOnce(
    "                w && Y && It && Ge(() => va(w, Y.id));",
    `                if (w && Y && It) {
                  immersive.startWorkoutFullscreen();
                  Ge(() => va(w, Y.id).catch(error => {
                    immersive.exitWorkoutFullscreen();
                    throw error;
                  }));
                }`,
  );
  replaceOnce(
    "    if ((zt(!1), document.fullscreenElement === xt.current))",
    "    immersive.exitWorkoutFullscreen();\n    if ((zt(!1), document.fullscreenElement === xt.current))",
  );
  replaceOnce(
    "        document.fullscreenElement !== xt.current && zt(!1);",
    "        if (!immersive.isWorkoutFullscreen() && document.fullscreenElement !== xt.current) zt(!1);",
  );
  replaceOnce(
    '        (document.body.classList.remove("scenic-expanded"),',
    '        (document.body.classList.remove("scenic-expanded"), immersive.exitWorkoutFullscreen(),',
  );
  replaceOnce(
    '  return c.jsxs("section", {\n    className: "scenic-mode video-mode "',
    '  const layout = Be ? immersive.readImmersiveLayout() : null;\n  return c.jsxs("section", {\n    "data-custom-immersive": layout ? "" : undefined,\n    className: "scenic-mode video-mode "',
  );
  for (const [name, index] of [
    ["immersion-route", 0],
    ["immersion-exit", 2],
    ["immersion-adjustments", 3],
    ["immersion-pause", 6],
    ["danger immersion-stop", 7],
  ]) {
    const anchor = `className: "${name}",`;
    replaceOnce(
      anchor,
      `${anchor} ...immersive.immersiveSlot(layout, ${index}),`,
    );
  }
  for (const [start, end, index] of [
    [
      "                      c.jsx(__feedback.ControlMode, {\n                        value: f,",
      "                        manualUnavailable: T,\n                      }),",
      1,
    ],
    [
      "                      c.jsx(__feedback.WorkoutReadings, {\n                        kind: I,",
      "                        calories: p,\n                      }),",
      5,
    ],
  ]) {
    replaceOnce(
      start,
      `c.jsx("div", {className: "immersive-slot", ...immersive.immersiveSlot(layout, ${index}), children: ${start}`,
    );
    replaceOnce(end, end.slice(0, -1) + "}),");
  }
  replaceOnce(
    "c.jsx(__feedback.IntervalCue, { text: lt }),",
    'c.jsx("div", {className: "immersive-slot", ...immersive.immersiveSlot(layout, 4), children: c.jsx(__feedback.IntervalCue, { text: lt })}),',
  );

  code = (await transform(code, { minify: true, target: "es2022" })).code;
  const path = "/assets/feedback-" + hash(code) + ".js";
  await fs.writeFile(root + path, code);
  const stylesheet = html.match(
    /href="(\/assets\/feedback-[a-f0-9]+\.css)"/,
  )[1];
  const theme = await fs.readFile("src/screen-theme.css", "utf8");
  const css = (await fs.readFile(root + stylesheet, "utf8")) + "\n" + theme;
  const cssPath = "/assets/feedback-" + hash(css) + ".css";
  await fs.writeFile(root + cssPath, css);
  html = html.replace(script, path).replace(stylesheet, cssPath);
  await fs.writeFile(htmlFile, html);
  const manifestFile = root + "/offline-assets.json";
  const assets = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  await fs.writeFile(
    manifestFile,
    JSON.stringify([...new Set([...assets, path, cssPath])]),
  );
  const workerFile = root + "/sw.js";
  const worker = await fs.readFile(workerFile, "utf8");
  await fs.writeFile(
    workerFile,
    worker.replace(/kwest-feedback-[a-f0-9]+/, "kwest-feedback-" + hash(html)),
  );
  console.log("Built production release:", hash(code));
}

await buildLiveAuditRelease(
  "artifacts/visual-release",
  "production/live-frontend",
);
