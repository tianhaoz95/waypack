# Waypack

## Releases

Cut every release with `scripts/cut_release.sh`. Don't improvise: no hand-made tags, no
`gh release create`, no running `tool/release_ios.sh` / `tool/release_mac.sh` in place of it.
The script keeps every surface on the same version and refuses to ship from a dirty, unpushed
or CI-red `main`.

```sh
scripts/cut_release.sh --dry-run        # always look first
scripts/cut_release.sh                  # next patch; or: minor | major | 1.4.0
scripts/cut_release.sh minor --notes "…" --watch
```

It bumps `apps/mobile/pubspec.yaml`, pushes (Cloudflare deploys the Worker + site), and publishes
GitHub Release `v<version>`, which runs `testflight.yml` (iOS → TestFlight) and `mac-release.yml`
(notarized `Waypack.dmg` attached to the release, served at `/download/mac`). CI assigns build
numbers. Setup, secrets and recovery: `docs/DEPLOY.md` §4b.
