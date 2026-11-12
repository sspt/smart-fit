import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
await build({
  entryPoints: ["worker/index.ts"],
  outfile: "artifacts/accounts-worker/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: "external",
});
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "artifacts/accounts-worker/index.js",
    compatibilityDate: "2026-11-07",
    d1Databases: { DB: "accounts-browser-tests" },
    durableObjects: { STRAVA_SESSIONS: "StravaSession" },
    bindings: {
      APP_ORIGIN: "http://localhost:8787",
      GOOGLE_CLIENT_ID: "test-google",
      GOOGLE_CLIENT_SECRET: "test-secret",
      STRAVA_CLIENT_ID: "test-strava",
      STRAVA_CLIENT_SECRET: "test-secret",
    },
    outboundService: async () => Response.json({ videos: [] }),
  }),
);
const db = await mf.getD1Database("DB");
await db.exec(
  (await fs.readFile("worker/migrations/0001_accounts.sql", "utf8")).replace(
    /\n/g,
    " ",
  ),
);
const root = path.resolve("artifacts/visual-release"),
  types = {
    ".js": "application/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".woff2": "font/woff2",
    ".html": "text/html",
    ".webmanifest": "application/manifest+json",
  };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost:8787");
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ifit/")) {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 6 * 1024 * 1024) {
          res.writeHead(413).end();
          return;
        }
        chunks.push(chunk);
      }
      const response = await mf.dispatchFetch(url.href, {
        method: req.method,
        redirect: "manual",
        headers: req.headers,
        ...(!["GET", "HEAD"].includes(req.method)
          ? { body: Buffer.concat(chunks) }
          : {}),
      });
      res.statusCode = response.status;
      for (const [k, v] of response.headers)
        if (k !== "set-cookie") res.setHeader(k, v);
      const cookies = response.headers.getSetCookie();
      if (cookies.length) res.setHeader("set-cookie", cookies);
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    const file = path.resolve(
      root,
      "." + (url.pathname === "/" ? "/index.html" : url.pathname),
    );
    if (!file.startsWith(root + "/")) {
      res.writeHead(403).end();
      return;
    }
    const bytes = await fs.readFile(file);
    res.setHeader(
      "Content-Type",
      types[path.extname(file)] || "application/octet-stream",
    );
    res.end(bytes);
  } catch {
    res.writeHead(404).end();
  }
});
server.listen(8787, "0.0.0.0", () =>
  console.log("Accounts test server: http://localhost:8787"),
);
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    server.close();
    void mf.dispose().then(() => process.exit());
  });
