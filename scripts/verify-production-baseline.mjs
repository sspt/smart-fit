import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
const baseline = JSON.parse(
  await readFile("production/expected-live.json", "utf8"),
);
const html = execFileSync("curl", [
  "--fail",
  "--silent",
  "--show-error",
  "--proto",
  "=https",
  "--max-time",
  "30",
  "--header",
  "Cache-Control: no-cache",
  baseline.origin,
]);
if (
  createHash("sha256").update(html).digest("hex") !==
  baseline.originalHtmlSha256
)
  throw Error(
    "Frontend changed since baseline capture; reconcile before deploying",
  );
console.log("Verified live frontend baseline");
