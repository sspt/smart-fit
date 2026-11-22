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

  const messages = JSON.parse(await fs.readFile("src/i18n/uiMessages.json", "utf8"));
  for (const [key, previous] of [
    ["30 min · Ride intervals", "30 min · Intervalos de passeio"],
    ["45 min · Endurance ride", "45 min · Passeio de resistência"],
    ["Finish tracking only", "Concluir apenas o rastreio"],
  ]) {
    const formatted = (value) => JSON.stringify(value).replace(/[\u0080-\u00ff]/g, (character) => "\\x" + character.codePointAt(0).toString(16).toUpperCase());
    replaceOnce(formatted(previous), formatted(messages[key][1]));
  }

  const equipment = "Ending the workout recording leaves the equipment running if it is in motion.";
  const forgot = "Forgot your password?";
  const recovery = "If you linked Google or Strava to this account, sign in with that provider. Email password reset is currently unavailable.";
  const localized = (key) => `__routeRelease.t(${JSON.stringify(key)})`;
  const dictionaryAnchor = '      "I already have an account": [';
  replaceOnce(
    dictionaryAnchor,
    [equipment, forgot, recovery]
      .map((key) => `      ${JSON.stringify(key)}: ${JSON.stringify(messages[key])},`)
      .concat(dictionaryAnchor)
      .join("\n"),
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
  const signInEnd = '                        : __routeRelease.uiText("I already have an account"),\n                    ),\n                  ),\n                ),';
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
  html = html.replace(script, path);
  await fs.writeFile(htmlFile, html);
  const manifestFile = root + "/offline-assets.json";
  const assets = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  await fs.writeFile(manifestFile, JSON.stringify([...new Set([...assets, path])]));
  const workerFile = root + "/sw.js";
  const worker = await fs.readFile(workerFile, "utf8");
  await fs.writeFile(workerFile, worker.replace(/kwest-feedback-[a-f0-9]+/, "kwest-feedback-" + hash(html)));
  console.log("Built production release:", hash(code));
}

await buildLiveAuditRelease("artifacts/visual-release", "production/live-frontend");
