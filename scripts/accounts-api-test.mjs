import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import { build } from "esbuild";
import fs from "node:fs/promises";
import assert from "node:assert/strict";
await build({
  entryPoints: ["worker/index.ts"],
  outfile: "artifacts/accounts-worker/index.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  sourcemap: "external",
});
let googleSubject = "google-1",
  googleEmail = "alice@example.com",
  ip = 0,
  checks = 0;
const mf = new Miniflare(
  convertV4MiniflareOptions({
    modules: true,
    scriptPath: "artifacts/accounts-worker/index.js",
    compatibilityDate: "2026-11-07",
    d1Databases: { DB: "accounts-tests" },
    bindings: {
      APP_ORIGIN: "https://kwest.fit",
      GOOGLE_CLIENT_ID: "test-google",
      GOOGLE_CLIENT_SECRET: "test-secret",
      STRAVA_CLIENT_ID: "test-strava",
      STRAVA_CLIENT_SECRET: "test-secret",
    },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/token"))
        return Response.json({ access_token: "provider-test-token" });
      if (url.hostname === "openidconnect.googleapis.com")
        return Response.json({
          sub: googleSubject,
          email: googleEmail,
          email_verified: true,
          name: "Google user",
        });
      if (url.pathname === "/api/v3/athlete")
        return Response.json({ id: 791, firstname: "Strava user" });
      throw Error("Unexpected provider request");
    },
  }),
);
const cookie = (r) => r.headers.get("Set-Cookie")?.split(";")[0] || "";
const call = (
  path,
  {
    method = "GET",
    data,
    cookies = "",
    origin = "https://kwest.fit",
    address = "test-" + ++ip,
    headers = {},
  } = {},
) =>
  mf.dispatchFetch("https://kwest.fit" + path, {
    method,
    redirect: "manual",
    headers: {
      ...(method !== "GET"
        ? { "Content-Type": "application/json", Origin: origin }
        : {}),
      Cookie: cookies,
      "CF-Connecting-IP": address,
      ...headers,
    },
    ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
  });
const programme = (id = "p") => ({
  id,
  name: "Private walk",
  kind: "Treadmill",
  repeat: 1,
  blocks: [
    {
      name: "Walk",
      duration: 900,
      speed: 4,
      incline: 1,
      power: 0,
      resistance: 1,
    },
  ],
});
async function check(name, fn) {
  await fn();
  checks++;
  console.log("PASS", name);
}
try {
  const db = await mf.getD1Database("DB");
  await db.exec(
    (await fs.readFile("worker/migrations/0001_accounts.sql", "utf8")).replace(
      /\n/g,
      " ",
    ),
  );
  let alice, bob, aliceId;
  await check(
    "local accounts hash passwords and issue secure opaque sessions",
    async () => {
      const a = await call("/api/auth/register", {
        method: "POST",
        data: {
          name: "Alice",
          email: "alice@example.com",
          password: "Alice password 123!",
        },
      });
      assert.equal(a.status, 201);
      alice = cookie(a);
      assert.match(
        a.headers.get("Set-Cookie"),
        /HttpOnly; Secure; SameSite=Lax/,
      );
      assert(!alice.includes("Alice"));
      const b = await call("/api/auth/register", {
        method: "POST",
        data: {
          name: "Bob",
          email: "bob@example.com",
          password: "Bob password 123!",
        },
      });
      assert.equal(b.status, 201);
      bob = cookie(b);
      const status = await (
        await call("/api/auth/status", { cookies: alice })
      ).json();
      aliceId = status.user.id;
      assert.equal(status.user.name, "Alice");
      assert.equal(status.local, true);
      const row = await db
        .prepare(
          "SELECT password_hash,salt FROM fit_credentials WHERE user_id=?",
        )
        .bind(aliceId)
        .first();
      assert.notEqual(row.password_hash, "Alice password 123!");
      assert.equal(row.password_hash.length, 64);
      assert.equal(row.salt.length, 64);
    },
  );
  await check(
    "CSRF, unauthenticated access and weak passwords are rejected",
    async () => {
      assert.equal((await call("/api/data")).status, 401);
      assert.equal(
        (
          await call("/api/auth/register", {
            method: "POST",
            origin: "https://evil.example",
            data: {},
          })
        ).status,
        403,
      );
      assert.equal(
        (
          await call("/api/auth/register", {
            method: "POST",
            data: { name: "x", email: "x@example.com", password: "short" },
          })
        ).status,
        400,
      );
      assert.equal((await call("/api/auth/google/start")).status, 405);
    },
  );
  await check(
    "programmes and compressed full history are isolated per user",
    async () => {
      const saved = await call("/api/data/programmes/p", {
        method: "PUT",
        cookies: alice,
        data: { revision: 0, value: programme() },
      });
      assert.equal(saved.status, 200);
      assert.equal((await saved.json()).revision, 1);
      assert.equal(
        (await call("/api/data/programmes/p", { cookies: bob })).status,
        404,
      );
      assert.deepEqual(
        (await (await call("/api/data", { cookies: bob })).json()).records,
        [],
      );
      const history = {
        id: "h",
        programme: programme(),
        started: Date.now(),
        elapsed: 5000,
        status: "completed",
        demo: false,
        samples: Array.from({ length: 5000 }, (_, at) => ({
          at,
          speed: 4,
          power: null,
          distance: at,
          resistance: 1,
        })),
        events: ["Finished"],
      };
      assert.equal(
        (
          await call("/api/data/history/h", {
            method: "PUT",
            cookies: alice,
            data: { revision: 0, value: history },
          })
        ).status,
        200,
      );
      const restored = await (
        await call("/api/data/history/h", { cookies: alice })
      ).json();
      assert.deepEqual(restored.value, history);
      const stored = await db
        .prepare(
          "SELECT hex(payload) AS bytes FROM fit_records WHERE user_id=? AND record_key=?",
        )
        .bind(aliceId, "history:h")
        .first();
      assert(stored.bytes.startsWith("1F8B"));
    },
  );
  await check(
    "optimistic revisions reject stale updates and owner-scoped deletes",
    async () => {
      assert.equal(
        (
          await call("/api/data/programmes/p", {
            method: "PUT",
            cookies: alice,
            data: { revision: 0, value: { ...programme(), name: "Stale" } },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call("/api/data/programmes/p", {
            method: "DELETE",
            cookies: bob,
            data: { revision: 1 },
          })
        ).status,
        409,
      );
      const response = await call("/api/data/programmes/p", {
        method: "PUT",
        cookies: alice,
        data: { revision: 1, value: { ...programme(), name: "Updated" } },
      });
      assert.equal((await response.json()).revision, 2);
      assert.equal(
        (
          await call("/api/data/programmes/p", {
            method: "DELETE",
            cookies: alice,
            data: { revision: 1 },
          })
        ).status,
        409,
      );
      assert.equal(
        (
          await call("/api/data/programmes/p", {
            method: "DELETE",
            cookies: alice,
            data: { revision: 2 },
          })
        ).status,
        200,
      );
      assert.equal(
        (await call("/api/data/programmes/p", { cookies: alice })).status,
        404,
      );
      assert(
        (
          await (await call("/api/data", { cookies: alice })).json()
        ).records.find((x) => x.record_key === "programmes:p").deleted,
      );
    },
  );
  await check(
    "invalid programme/history/settings payloads never reach the database",
    async () => {
      for (const [path, value] of [
        ["programmes/x", { ...programme("x"), blocks: [] }],
        ["history/x", { id: "x", samples: [] }],
        ["settings/preferences", { units: "nonsense" }],
      ])
        assert.equal(
          (
            await call("/api/data/" + path, {
              method: "PUT",
              cookies: alice,
              data: { revision: 0, value },
            })
          ).status,
          400,
        );
    },
  );
  await check(
    "password changes revoke other sessions and logout revokes the current session",
    async () => {
      const login = await call("/api/auth/login", {
          method: "POST",
          data: { email: "alice@example.com", password: "Alice password 123!" },
        }),
        other = cookie(login);
      assert.equal(login.status, 200);
      assert.equal(
        (
          await call("/api/auth/password", {
            method: "POST",
            cookies: alice,
            data: {
              currentPassword: "Alice password 123!",
              password: "New Alice password 456!",
            },
          })
        ).status,
        200,
      );
      assert.equal((await call("/api/data", { cookies: other })).status, 401);
      assert.equal(
        (
          await call("/api/auth/login", {
            method: "POST",
            data: {
              email: "alice@example.com",
              password: "Alice password 123!",
            },
          })
        ).status,
        401,
      );
      const current = await call("/api/auth/login", {
        method: "POST",
        data: {
          email: "alice@example.com",
          password: "New Alice password 456!",
        },
      });
      assert.equal(current.status, 200);
      const c = cookie(current);
      await call("/api/auth/logout", { method: "POST", cookies: c, data: {} });
      assert.equal((await call("/api/data", { cookies: c })).status, 401);
    },
  );
  async function start(provider, cookies = "", link = false) {
    const r = await call(`/api/auth/${provider}/start`, {
      method: "POST",
      cookies,
      data: { link },
    });
    assert.equal(r.status, 200);
    const url = new URL((await r.json()).url);
    return {
      url,
      state: url.searchParams.get("state"),
      cookies: [cookies, cookie(r)].filter(Boolean).join("; "),
    };
  }
  await check(
    "Google uses PKCE and browser-bound single-use OAuth state",
    async () => {
      const flow = await start("google");
      assert.equal(flow.url.searchParams.get("code_challenge_method"), "S256");
      assert.equal(
        flow.url.searchParams.get("redirect_uri"),
        "https://kwest.fit/api/auth/google/callback",
      );
      const wrong = await call(
        "/api/auth/google/callback?code=test&state=" + flow.state,
      );
      assert.equal(
        wrong.headers.get("Location"),
        "https://kwest.fit/?account=1&auth=error",
      );
      const completed = await call(
        "/api/auth/google/callback?code=test&state=" + flow.state,
        { cookies: flow.cookies },
      );
      assert.equal(
        completed.headers.get("Location"),
        "https://kwest.fit/?account=1&auth=ok",
      );
      const oauthCookie = cookie(completed),
        status = await (
          await call("/api/auth/status", { cookies: oauthCookie })
        ).json();
      assert.notEqual(status.user.id, aliceId);
      assert.equal(status.user.email, "alice@example.com");
      assert(status.linked.includes("google"));
      const replay = await call(
        "/api/auth/google/callback?code=test&state=" + flow.state,
        { cookies: flow.cookies },
      );
      assert(replay.headers.get("Location").endsWith("auth=error"));
    },
  );
  await check(
    "linking providers requires the same signed-in account and does not merge by email",
    async () => {
      googleSubject = "google-linked";
      const flow = await start("google", alice, true);
      const missingSession = await call(
        "/api/auth/google/callback?code=test&state=" + flow.state,
        {
          cookies: flow.cookies
            .split("; ")
            .find((x) => x.startsWith("__Host-kwest-oauth=")),
        },
      );
      assert(missingSession.headers.get("Location").endsWith("auth=error"));
      const retry = await start("google", alice, true);
      const linked = await call(
        "/api/auth/google/callback?code=test&state=" + retry.state,
        { cookies: retry.cookies },
      );
      assert(linked.headers.get("Location").endsWith("auth=ok"));
      alice = cookie(linked);
      assert.equal(
        (await (await call("/api/auth/status", { cookies: alice })).json()).user
          .id,
        aliceId,
      );
      const stolen = await start("google", bob, true);
      const rejected = await call(
        "/api/auth/google/callback?code=test&state=" + stolen.state,
        { cookies: stolen.cookies },
      );
      assert(rejected.headers.get("Location").endsWith("auth=error"));
      assert.deepEqual(
        (await (await call("/api/auth/status", { cookies: bob })).json())
          .linked,
        [],
      );
    },
  );
  await check(
    "Strava sign-in uses its own callback and stable provider identity",
    async () => {
      const flow = await start("strava");
      assert.equal(flow.url.searchParams.get("scope"), "read");
      assert.equal(
        flow.url.searchParams.get("redirect_uri"),
        "https://kwest.fit/api/auth/strava/callback",
      );
      const completed = await call(
        "/api/auth/strava/callback?code=test&state=" + flow.state,
        { cookies: flow.cookies },
      );
      assert(completed.headers.get("Location").endsWith("auth=ok"));
      const user = await (
        await call("/api/auth/status", { cookies: cookie(completed) })
      ).json();
      assert(user.linked.includes("strava"));
    },
  );
  await check(
    "expired sessions cannot read data and authentication attempts are rate limited",
    async () => {
      await db
        .prepare("UPDATE fit_sessions SET expires_at=0 WHERE user_id=?")
        .bind(aliceId)
        .run();
      assert.equal((await call("/api/data", { cookies: alice })).status, 401);
      let response;
      for (let i = 0; i < 21; i++)
        response = await call("/api/auth/login", {
          method: "POST",
          address: "rate-test",
          data: {
            email: "missing@example.com",
            password: "Wrong password 123!",
          },
        });
      assert.equal(response.status, 429);
    },
  );
  console.log(
    `Verified ${checks} account/database/security scenarios against real D1.`,
  );
} finally {
  await mf.dispose();
}
