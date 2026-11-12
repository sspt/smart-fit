# Accounts and cloud data

Settings → Account supports local email/password accounts, Google sign-in and
Strava sign-in. Browser-only use remains available. After sign-in, **Import device
data** explicitly copies existing programmes and history into that account;
original device data is retained. Repeating the import does not duplicate items.

Programmes, completed/interrupted workout history and unit preferences sync to
Cloudflare D1. Profile names, local credentials, external identities and opaque
session hashes also live in D1. Bluetooth grants, remembered devices, active
workouts and pending Strava upload jobs stay local to each account on each device.
Account switching is disabled during an active or recovered workout.

## Deploy configuration

1. The dedicated `kwest-fit-users` database is provisioned; its non-secret binding
   descriptor is `production/accounts-database.json`. The four retired kwest
   databases were removed at the owner's request to free database capacity.
   `python scripts/provision-accounts-db.py` applies the idempotent account schema.
   All tables/indexes use the `fit_*` namespace. An occupied namespace without our
   schema marker is rejected.
2. Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` securely in the environment
   (never in source or chat). The deployment script installs supplied values as
   Worker secrets. Existing production secrets are preserved when these are not
   supplied. Google OAuth must allow the exact redirect URI:
   `https://kwest.fit/api/auth/google/callback`.
3. Strava sign-in reuses `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`. The Strava
   application callback domain must include `kwest.fit`. Login uses scope `read`
   and callback `https://kwest.fit/api/auth/strava/callback`; the separate workout
   upload connection keeps its existing `/api/strava/callback` and upload scope.
4. Run `npm test`, `npm run test:accounts`, `npm run build`, and
   `npm run build:production`. For real local D1 browser tests, start
   `node scripts/accounts-dev-server.mjs`, then run
   `npm run test:accounts:browser`. The local server uses disposable D1 data and
   placeholder OAuth credentials; it sends no real OAuth requests.
5. `npm run deploy` builds the production frontend and publishes the new Worker
   with `python scripts/deploy-visual-release.py --accounts`. This preserves
   existing secrets, routes, assets configuration and the Strava Durable Object
   binding; adds only the explicitly selected D1 binding; retains a rollback
   copy; and checks for concurrent production changes. The new Worker hash is
   recorded in `production/expected-worker.sha256` after verification.

An unconfigured OAuth provider is hidden from the sign-in choices. The account
panel degrades to browser-only use if the account service is unavailable.
`APP_ORIGIN` defaults to `https://kwest.fit`; the local test server overrides it.

## Data safety and authentication

- Every database query scopes records by the authenticated session's user ID.
  IDs in requests cannot select another owner. Session tokens use 256 bits of
  randomness; only SHA-256 token hashes are stored. Cookies are Secure, HttpOnly,
  host-only and SameSite=Lax, expire after 30 days and are revoked on logout.
- Passwords require 12–128 characters, use independent 256-bit random salts and
  native PBKDF2-SHA256 with 100,000 iterations (the Workers WebCrypto limit).
  Authentication attempts are limited per source address and 15-minute window.
  Password changes revoke other sessions. No password or session token is stored
  in localStorage. Local email addresses are login identifiers, not verified
  ownership claims. Email verification and emailed password resets need an email
  delivery service and are not included. Users can explicitly link another
  sign-in provider as an alternative way to access their existing account.
- OAuth state is random, browser-bound, short-lived and consumed atomically.
  Google uses PKCE; identities come from authenticated provider userinfo APIs.
  Provider access tokens are used only on the server and discarded after login.
  Identities never merge just because email addresses match. Linking requires
  a live account session and rejects an identity belonging to another account.
- All mutations require the canonical Origin and JSON. Auth/account responses
  are non-cacheable and excluded from the service worker. Database values use
  bound parameters. Programme/history payloads are validated, bounded and gzip
  compressed per record so full workout samples fit D1's row-size limit.
- Browser caches and offline outboxes use separate per-account key spaces. Login
  never silently uploads guest data. Cloud bootstrap runs before the workout
  app mounts and never restores remote active sessions or equipment commands.
- Sync uses per-record revisions and tombstones. A stale write produces a
  conflict; local changes remain available. The user can export a backup and
  explicitly choose cloud or device versions. Network failures retain queued
  writes. Offline use can read a previously signed-in account's device cache.
  Cloud restores happen on startup or explicit Sync now/reload, never in the
  middle of an active workout. Signed-in history is not pruned by the legacy
  200-session device-only retention limit.
- Strava upload connections are scoped to account IDs. An expired authenticated
  connection cannot silently fall back to a browser-only Strava cookie.

## Checks

`accounts-api-test.mjs` exercises real D1, password hashing, sessions, CSRF,
owner isolation, history compression, optimistic revisions, provider identity
linking, OAuth state replay, PKCE, session expiry and rate limits. Provider
responses in that test are mocked; a real Google/Strava consent flow still needs
the configured provider application and a human choosing to sign in.

`accounts-browser-test.mjs` checks signup, explicit import, a second device,
account isolation, offline edits, cross-device conflicts, explicit resolution,
import idempotence, account controls during active workouts and Strava scoping.
