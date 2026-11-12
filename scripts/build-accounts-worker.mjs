import { build } from "esbuild";
await build({
  entryPoints: ["worker/index.ts"],
  outfile: "artifacts/accounts-worker/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: "external",
});
console.log("Built account-enabled Worker.");
