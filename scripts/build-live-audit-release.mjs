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
