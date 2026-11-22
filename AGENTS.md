# Publishing changes

The project owner has requested that every completed change be committed, pushed to `origin/main`, and published to [kwest.fit](https://kwest.fit) as part of the same task.

- Run the relevant checks and build with `npm run build:production`.
- Commit the task changes and push a fast-forward update to `origin/main`.
- Publish using the repository's release workflow. For frontend-only releases, run `python scripts/deploy-visual-release.py`. For releases that change the Worker, use the account-enabled release workflow documented in the README.
- Verify the live release. Commit and push any deployment record updated by the release script.
