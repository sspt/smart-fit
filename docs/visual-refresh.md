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

## Equipment controls and immersive readings

For the equipment-control release, run `node scripts/prepare-visual-release.mjs`
followed by `node scripts/prepare-equipment-release.mjs`. The second step applies
guarded changes to the newer production JavaScript and compiles the checked-in
`WorkoutReadings` and `equipmentControl` helpers into that shell. It retains the
existing Strava integration; any changed production-code contracts stop the
preparation rather than silently creating a partial patch. This bridge is needed
until the newer production frontend has been reconciled with the source checkout.

Validate the prepared directory on port 5174 with
`node scripts/equipment-release-smoke.cjs`, then deploy with
`python scripts/deploy-visual-release.py`. The deploy script retains the Worker
modules, configuration, bindings, and OAuth callback fix. This release changes
application JavaScript; the earlier visual-only byte-identity check does not apply.
Physical Bluetooth control still requires validation on the actual equipment.

## Programme duration tiles

For the programme thumbnail update, run `node scripts/prepare-visual-release.mjs`
and then `node scripts/prepare-programme-release.mjs`. The latter replaces only
the current production programme thumbnail JSX, preserving its duration expression
and all other application functionality, including the equipment-control release.
Validate the prepared directory on port 5174 with
`node scripts/programme-release-smoke.cjs` and
`node scripts/equipment-release-smoke.cjs`, then use
`python scripts/deploy-visual-release.py` to publish the assets while retaining
the live Worker. The programme preparation script stops if the production markup
contract has changed. Do not rerun the older equipment patch against this release.

## Simplified header and settings

Prepare the current production snapshot with `node scripts/prepare-visual-release.mjs`,
then run `node scripts/prepare-settings-release.mjs`. This removes the header
animation toggle, moves the existing cache action to Settings, removes the video
server and user speed cap, and expands the data and Strava sections. Device-reported
range validation and protocol clamping remain in place. Old backup speed caps
are ignored. The source app mirrors these changes in `src/main.tsx`.

Run `node scripts/settings-release-smoke.cjs` against the release on port 5174,
plus the programme and equipment smoke checks. The release remains local until
explicitly deployed with `python scripts/deploy-visual-release.py`.
