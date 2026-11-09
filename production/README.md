# Production baseline

Captured from https://kwest.fit on 2026-11-09 before adding workout feedback.
`assets` preserves the complete published frontend, including Strava, FIT/TCX
exports, timer tracking, equipment controls and the recent interface releases.
The frontend was published without source maps; it cannot be losslessly converted
back to the older TSX checkout. It is retained here as the reproducible baseline
rather than silently replacing live functionality with that checkout.

Worker TypeScript was recovered from its published source map into `worker/`.
No runtime credentials are stored here. `npm run build:production` compiles the
new source components and applies guarded edits to this frontend baseline.
The older `npm run build` remains useful for development but is not the release
path until the full frontend has been reconstructed. Deployment retains the live
Worker modules and bindings with `scripts/deploy-visual-release.py`.
