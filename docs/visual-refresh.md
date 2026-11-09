# kwest.fit visual refresh

The refresh keeps the full-screen nature film and existing journey flow, with a
branching K trail mark, self-hosted Manrope typography, mint accents, rounded
controls, and translucent forest-green surfaces. `public/logo.svg` is the master
mark; the two PNG app icons use the same artwork. The font license is included
in `public/fonts/OFL-Manrope.txt`.

## Preview

The source app runs with `npm run dev`. The current production app contains newer
Strava functionality than the GitHub checkout. **Do not deploy `dist` from this
checkout over production.** The worker callback fix is already live and must be
preserved along with its existing bindings, secrets, assets configuration, and
Durable Object migration.

`node scripts/prepare-visual-release.mjs` captures the currently published app
into `artifacts/visual-release` and adds the new stylesheet, logo, fonts, manifest,
and app icons. Its application JavaScript is kept byte-for-byte identical to
production. The script changes the service-worker cache namespace and includes
the new brand assets in the offline list. It performs no upload or deployment.
The captured baseline is recorded outside the public assets in
`artifacts/visual-release-baseline.json`.

Serve that release with:

```sh
python -m http.server 5174 --directory artifacts/visual-release
```

Desktop and mobile previews are in `artifacts/previews`. The prepared release is
local until explicitly deployed. Before deployment, check for newer production assets and
regenerate the release if production has changed. Upload the prepared static
assets while preserving the deployed Worker and its configuration; do not use
this older checkout's `npm run deploy`. After preparing and reviewing the release,
`python scripts/deploy-visual-release.py` uploads it, keeps the live Worker modules
and bindings, and records rollback details in `artifacts/visual-deploy`.

## Validation

- Production build and TypeScript check pass.
- Home, Discover, Library, Journal, Settings, and setup checked at 320px, 390px,
  and 1440px, without horizontal overflow or JavaScript runtime errors.
- Prepared release checked on desktop and mobile, with the Strava settings
  retained and its application JavaScript compared against production.
- New font and logo included in offline caching; reduced-motion preferences
  continue to disable decorative motion.

An initial full workout smoke run could not load the starter media through the
local Vite server. Physical equipment, Strava OAuth, and workout playback were
not validated as part of this visual refresh.
