# Smart Fit

Android Chrome installable PWA for FTMS and iFIT FitPro1 training. Cloudflare Worker serves the application and device-specific iFIT activation. Scenery can stream directly from a configured HTTPS NAS endpoint, with starter videos available from R2. Programmes, settings, history and checkpoints stay on the device.

## Development

Use Node 24. `npm ci`, then `npm run dev`. Run `npm test` and `npm run build` before release. Existing checkouts are sufficient; no extra worktree is needed.

`npm run deploy` builds and deploys Worker `smart-fit` to `fit.silvio.cloud`. Cloudflare API access must be injected securely; never commit credentials. For restricted writable cloud environments use `XDG_CONFIG_HOME=/workspace/smart-fit/.wrangler-config WRANGLER_SEND_METRICS=false npx wrangler deploy` after building.

## Direct video scenery

YouTube embeds have been replaced by native HTML video. Three explicitly labelled short loops cover forest walking, autumn cycling and river canoe scenery. They repeat during the workout; these are **not the original 45-minute YouTube films**. Credits, source URLs, licences, transformations, durations and SHA-256 hashes are in `docs/scenery-sources.json` and creator credits are visible in the player. Footage is used as part of the fitness experience under the Pexels licence. No YouTube media was downloaded or rehosted.

Video files are kept outside Git in `/workspace/scenery-downloads` and stored in R2 bucket `smart-fit-scenery`. `node scripts/prepare-scenery.mjs` downloads the documented licensed sources with curl and converts them using FFmpeg. Override `SCENERY_DIR` to choose another local directory. Re-encoding can produce a different hash with a different FFmpeg version; update the provenance receipt and use a new versioned filename when changing media.

Upload each prepared MP4 with `npx wrangler r2 object put smart-fit-scenery/<filename>.mp4 --file /workspace/scenery-downloads/<filename>.mp4 --content-type video/mp4 --remote`. `--local` instead seeds the local development bucket. Use the documented IDs in the provenance JSON. R2 remains private; the Worker exposes read-only `/media/*.mp4` responses with GET, HEAD, cache validators, streaming and HTTP byte ranges for seeking. Media is excluded from automatic service-worker caching.

In a live workout, opening or selecting a video automatically follows the device while the workout is running. Video options retain independent sync pause/resume, reference-speed adjustment, local files and reload. Native Play also enables following while the machine is moving. Playback rate is measured speed divided by the editable reference speed, continuously clamped to the portable 0.1×–4× range. Reference speeds are estimates, not measured recording speeds. Zero/unknown speed, workout pause and disconnect pause video. Manual video pause holds following until resumed. Native rate-menu changes are reconciled to device speed. Scenery never writes equipment targets.

Choose local video supports longer files already on the phone without uploading them; the file must be selected again in a new session. Browser video codec support applies. Hosted scenery requires a connection; local files can play offline. Immersive view preserves app pause/resume and Stop controls; browser-native video fullscreen/PiP are disabled where supported. Close all app windows and reopen after an update; no forced reload interrupts a workout.

## Validation

- `npm test`: protocol packets, captured fixtures, simulator behaviour, default programmes, workout engine, native playback-ratio calculation, activation and byte-range handling.
- After a build, `npx vite preview --host 0.0.0.0` plus `PLAYWRIGHT_BROWSERS_PATH=/tmp/smart-fit-browsers npm run test:browser` checks mobile layout, editor, demo workout, recovery, persisted history and offline shell.
- `npm run test:mobile` uses the same browser path and preview to check 320px/412px and desktop programme editors.
- Seed all three MP4s into local R2 using the upload command with `--local`, then run `npx wrangler dev --local --port 8787`. `PLAYWRIGHT_BROWSERS_PATH=/tmp/smart-fit-browsers node scripts/video-smoke.mjs` exercises **actual H.264 decoding**, continuous 1.4× playback, seeking, native-rate reconciliation, pause/resume, landscape Stop, all three files and real Worker/R2 byte ranges. Set `FIT_TEST_URL` to another origin for testing; tests create only disposable browser-local demo data.

Browser installation: `PLAYWRIGHT_BROWSERS_PATH=/tmp/smart-fit-browsers npx playwright install chromium`. Automated browser checks do not establish Android hardware performance or real Bluetooth compatibility.

## Equipment and local data

Select equipment type before pairing. Physical verification of the model/firmware's encoding and stop operation is required before automatic control; the UI confirmation records user attestation, not certification by this app. Tracking-only mode is supported. Keep the app visible during workouts: Android suspension and Bluetooth loss cannot guarantee a physical stop. Reconnect and resume explicitly; use the equipment's physical stop for any unconfirmed remote command.

Nine editable defaults provide exact 15-, 30- and 45-minute sessions for treadmill, bike and rower, including warm-up/cooldown. A one-time IndexedDB transaction preserves custom programmes and edited examples when installing the catalogue. Deleted defaults stay deleted. Back up local data through JSON export/restore or export history as CSV. Browser storage persistence is best effort.

Protocol code, fixtures, diagnostics and recorded model quirks were adapted from the user-supplied Kwest archive. These observations are not newly certified hardware results. FitPro2 is unsupported. iFIT activation is a signed-int32-compatible TypeScript port of the supplied Go algorithm; offline cached payload reuse needs hardware validation. The generic activation fallback is intentionally disabled. Inactive procedural scenery sources remain for reference but are not shipped in the active application.

For every supported model/firmware, hardware testing must cover initial start, target encoding, physical overrides, pause/stop/resume, control denial, activation, silent telemetry, reconnects, power loss, counters, app switching/screen lock and offline fresh connection.

## Edge-to-edge immersion

Immersive view requests fullscreen on the entire scenery container (not the video element), preserving the app's controls as overlays. If the browser declines fullscreen, a viewport-filling layout provides the same overlay experience within the app. Video uses `object-fit: cover` and may crop portrait/landscape footage to eliminate black bars. Native video controls and setup forms are hidden only in immersive view. Speed, workout time, playback rate/status, Pause/Resume, Stop and Exit float above the footage, with safe-area padding and readable gradients. Background controls are inert and focus stays inside the immersive view; exiting restores normal navigation and focus. Stop remains available without auto-hiding.

The video smoke test verifies full-viewport video bounds, cover rendering, overlay visibility, pause/resume, fullscreen exit/navigation restoration and the no-Fullscreen-API fallback at small portrait and landscape dimensions.

## Training and discovery interface

The cinematic home screen presents one Start action. Setup uses a single Connect equipment picker, with the existing FTMS-to-iFIT handoff reusing the selected device. Manual FTMS/iFIT connection, demo mode, certification, diagnostics and disconnect remain under More connection options. Connection completion advances automatically; tapping a programme or scene advances immediately, with one explicit final Start journey action. Last successfully started programme and scene are remembered locally. A connected repeat visit opens the review directly; after a reload it still requires a connection and explicit Start. Review rows allow changing equipment, programme and scenery. Recovered workouts remain paused until explicitly resumed.

Scenery previews enter setup with the chosen scene. The Home programme library, editor, filters, history, settings and exports remain available. Video tuning and local files sit under Video options; duplicate video-panel workout buttons have been consolidated into the session's pause/stop controls. Full-screen overlays retain Pause/Resume, Stop and Exit. Automation controls, tracking recovery and session logs use disclosures, with automation takeover and disconnected recovery exposed when needed. The interface uses charcoal, warm ivory and champagne accents, with bottom navigation on phones and a sidebar on desktop.

`npm run test:guided` checks tap-to-advance, all three equipment types in demo mode, real full-screen video playback, session controls, repeat shortcuts, changing selections, persisted choices and explicit recovery.

`PLAYWRIGHT_BROWSERS_PATH=/tmp/smart-fit-browsers node scripts/discovery-smoke.mjs` checks the dashboard, filters, actual video previews, matching programme flow, equipment selection and viewport fit at 320px, 412px and 1280px against local Wrangler on port 8787.


## Compact views and equipment control mode

Home contains the scenic entrance. Library contains the complete programme collection with responsive pagination, search, collapsed filters and editing. History is also paginated without changing totals, exports or storage. Scenery uses compact preview rows. Preferences keep essential settings visible and group backup/storage/install tools in a disclosure. Normal screens and setup steps are browser-checked to fit 320×640, 412×844 and 1280×800 viewports. Expanded options, the editor, long user content and large accessibility text may still scroll; content is not clipped to force a fit.

The live screen separates Scenery and Session readings. The same equipment-control selector is available in the live toolbar and the immersive overlay. Follow machine holds automatic programme targets and invalidates pending target follow-ups. Automatic reapplies the current segment only when the session has control entitlement and the current equipment is connected and verified. Switching modes while paused never starts the machine or resumes the timer. Video playback always follows measured speed in either mode. Explicit Stop remains available in the immersive overlay.

The selected mode is stored in the active session, survives pause/resume and recovery, and follows physical target overrides. A recovered session still requires explicit resume; it never restarts equipment on load. In Follow mode, pause/resume operate tracking without sending equipment pause/start, and programme completion archives tracking without automatically stopping the machine. Explicit Stop still stops a verified control session. Tracking-only sessions cannot acquire automatic control using this selector.

`npm run test:compact` checks default-screen viewport fit, access to all paginated programmes, mode switching, switching while paused, real video playback in both modes, portrait/landscape overlay access, mode persistence after reload and tracking-only guards. These interaction checks use demo equipment; supported physical models still require hardware verification.


## Direct NAS media

Settings → Video server connects to a static HTTPS catalogue and streams directly from the NAS, including optional existing-session cookies. HLS quality selection, silent 4K-ready preparation and MP4 fallback are supported. See [Synology setup and publishing](docs/synology-streaming.md). The actual NAS hostname and access policy must be supplied/configured by the owner; no NAS password is embedded or required in this repository.

### Video from a phone

In guided setup, choose **Choose video from phone**, set **Video reference speed (km/h)** (default **5**), then start. Files are played through browser object URLs without uploading. Playback follows measured equipment speed relative to the reference speed. MP4/H.264 is the most widely supported format; other formats depend on the phone's decoder. The file remains available in memory while the app is open; select it again after reloading. The video view also offers the phone picker and reference-speed adjustment under Video options.

Browser check: `PLAYWRIGHT_BROWSERS_PATH=/tmp/smart-fit-browsers node scripts/phone-video-smoke.mjs` (uses a local sample fixture; override app URL with `FIT_TEST_URL`).

NAS scenery skips the first 30 seconds on initial playback and every loop, and fades the picture over the first/last two seconds of the remaining footage. Clips of 31 seconds or less start at zero. The source files are unchanged, and machine-speed synchronisation and pause/stop controls remain active. Phone-selected videos are excluded from this trimming/fade behaviour. `scripts/scenery-loop-smoke.mjs` checks seeking and looping using a locally generated 36-second WebM fixture via `FIT_VIDEO_FIXTURE`.

The app shares one full-viewport decorative video across Home, Discover, Library, setup, Journal and Settings, using the current equipment's first non-local catalogue scene. Transparent surfaces keep controls readable. The header's background-scene button pauses/resumes motion. Reduced-motion and data-saving preferences start with a still image; background video unloads while hidden or during workouts to avoid competing with workout playback. `scripts/immersive-ui-smoke.mjs` verifies continuous navigation, the motion toggle and single-player workout handoff with a local synthetic fixture.

### Remembered Bluetooth equipment

After a successful FTMS/iFIT connection, the app stores the device ID, name, equipment type and protocol on that phone. On a later launch it makes one reconnect attempt using `navigator.bluetooth.getDevices()` if supported, selecting only that exact authorised ID. It does not open a chooser automatically. If enumeration is unsupported or permission is missing, the main Connect button offers the user-initiated picker; a missing grant requires a further explicit Connect tap. Unavailable devices can be retried with Connect or replaced using More connection options. That section also has an automatic-reconnect preference and Forget remembered device. Manual Disconnect suppresses automatic connection for the rest of that app instance. Existing mid-session GATT retry logic remains in the protocol hooks.

A reconnect never calls Start/Resume or applies workout targets. Recovered workouts stay paused and machine-control verification resets. Browser simulation: `PLAYWRIGHT_BROWSERS_PATH=/tmp/smart-fit-browsers node scripts/auto-connect-smoke.mjs`. Physical-device and Android-browser compatibility still require testing on the actual hardware.

## Production reconciliation and workout feedback (2026-11-09)

The live Worker TypeScript has been recovered from its published source map,
including Strava and the current media endpoint. The complete live frontend is
versioned under `production/assets`; it was published without source maps.
See `production/README.md` for the temporary frontend source boundary.

`npm run build:production` compiles `WorkoutFeedback.tsx` and `feedbackStats.ts`
and applies guarded changes to that baseline. This is the current release path.
Serve `artifacts/visual-release` on port 5174, run
`node scripts/feedback-smoke.mjs` and the existing release smoke checks, then use
`python scripts/deploy-visual-release.py`. Deployment refuses a changed baseline
and preserves the live Worker and bindings. Do not deploy the older Vite shell.

Completion now shows a dismissible recap with duration, distance and available
average speed/power; the previous completed attempt is shown only for the same
programme revision and demo category. Journal shows Monday-to-now local weekly
session count and minutes, excluding demos. Immersive scenery briefly shows the
next interval within ten seconds (or twenty metres), with target values and a
finish cue at the end. Paused sessions and Follow machine mode suppress cues.

Validation: 202 unit tests, both builds, three demo equipment types, Strava
settings, programme/settings/Bluetooth release checks, and feedback browser
checks at 320, 412 and 1280 pixels. These do not replace physical device testing.

## Simplified equipment screen

The equipment screen and its shared setup panel expose only Connect equipment
and Export diagnostics. Equipment type uses a compact dropdown, locked while
connected or in a session. The unified picker retains protocol detection and
remembered-device reconnection. Connected equipment displays a disabled Connected
button. Protocol-specific connection buttons, demo actions, extra connection
options and the secondary readings have been removed from this panel.

`node scripts/equipment-simple-smoke.mjs` checks both entry points at 320, 412
and 1280 pixels, the filtered Bluetooth picker and an actual diagnostics download.
This replaces the old manual FTMS/iFIT and demo-button UI assertions.

## Clean Settings

Settings groups Preferences (display units), Strava and Your data (export/restore).
App & data tools is collapsed by default and contains cache refresh, installation
when available, and the confirmed history-delete action. The manual storage
permission button and repeated platform/installation instructions were removed.
Strava connection, automatic sync, backup validation and active-session guards
retain their existing handlers. `node scripts/settings-clean-smoke.mjs` checks
320/412/1280px layouts, persisted units, actual backup export/restore, connected
and disconnected Strava states, and disclosure/confirmation behavior.

## iPhone compatibility landing and retired demo UI

Unsupported iPhone/iPad browsers now receive a branded landing page before the
app or video-catalogue provider mounts. Detection includes iPadOS desktop mode
and checks for the actual Web Bluetooth requestDevice API, allowing compatible
browsers through. The page explains the limitation, recommends Android Chrome
or a compatible desktop browser, and offers a copy-link button with a readable
fallback when clipboard access is unavailable. Its still image is cached with
the application shell.

Demo labels and connection instructions have been removed from the interface.
Saved simulated sessions are no longer recovered and do not appear in Journal
or its totals. The original history remains in storage and JSON backups;
protocol markers and historical export metadata retain their meaning.
`node scripts/iphone-landing-smoke.mjs` covers three iPhone viewport sizes,
copying the link, absence of app API calls, normal app access, hidden simulated
records and preservation of backup history. The previous feedback demo-recovery
smoke fixture is no longer a supported entry path; feedback calculation tests
remain in the unit suite.

## Tailored weight-loss sessions

Library → Weight-loss programmes opens a small optional builder. Choose a
machine, 15/20/30/45 minutes, activity level and your own comfortable walking
speed, cycling power or rowing resistance. Starting out generates a steady
session; Already active alternates comfortable effort with easier recovery.
Every session includes warm-up and cooldown and stays at or below the supplied
comfortable target. Longer durations add time rather than intensity; treadmill
sessions stay flat. No body measurements, calorie targets or weight-loss
promises are used.

Review programme opens the existing editor. Nothing is saved or started until
the user takes the usual explicit actions. Saved programmes use existing local
storage, backup/restore, equipment-range checks and start controls. The library
now also includes a 20-minute duration filter.

Validation: 30 generation tests cover all machine/duration/level combinations,
exact duration, effort ceilings and invalid inputs.
`node scripts/weight-loss-smoke.mjs` checks tailoring, editor review, saving,
actual persisted targets, reload and re-editing at 320/412/1280 pixels.
