# Releasing SemaClip

How a nightly gets cut, what the version means, where the update manifest lives,
and what is deliberately broken. Written for the manual path first, because the
owner is publishing by hand until the pipeline has proven itself.

Everything here was measured against Deno 2.9.6. `deno desktop` is
**experimental** and prints a warning saying so.

## Version scheme

`scripts/version.sh` is the single source of truth.

| | | |
|---|---|---|
| Stable | `v2026.141` | `2026` = UTC year, `141` = commits authored this year up to HEAD |
| Nightly | `v2026.141-nightly.42` | `42` = `GITHUB_RUN_NUMBER`, so two runs of the same commit stay distinct |

The script writes the version into **both** `frontend/package.json` (the UI
banner, via `vite.config.ts`) and `server/deno.json` (baked into the binary as
`Deno.desktopVersion`). A drift between them means the updater compares the wrong
current version and re-applies patches forever, which is why CI asserts both.

```sh
./scripts/version.sh              # write a stable version
./scripts/version.sh --nightly    # write a nightly version
./scripts/version.sh --check      # print only, write nothing
```

The `-nightly` suffix is **load-bearing, not cosmetic**. `Deno.autoUpdate` looks
up a patch under `manifest.patches[Deno.desktopVersion]`, so if a nightly and a
stable build both reported `2026.141` the updater would treat them as the same
version and a nightly would never see the next nightly.

## Where the manifest lives

GitHub Pages, served from a `releases` branch (no build step — Pages publishes
the branch content as-is).

```
https://99oblivius.github.io/SemaClip/nightly/latest.json     <- the nightly channel
https://99oblivius.github.io/SemaClip/stable/latest.json      <- planned, not live
```

The base URL is baked into the binary via `desktop.release.baseUrl` in
`server/deno.json` and must match what CI publishes. The app polls it every 6
hours (`INTERVAL_MS` in
`server/adapters/outbound/platform/auto-update.ts`).

Artifacts (installers, zips, runtime dylibs, patches) live on the **GitHub
Release** for the tag. Only the manifest and the `.bin` patch files live on
Pages, and they are committed **together in one commit** so a manifest can never
name a patch that 404s.

### Manifest shape

```json
{
  "version": "2026.142-nightly.43",
  "patches": {
    "2026.141-nightly.42": {
      "name": "patch-2026.141-nightly.42-to-2026.142-nightly.43.bin",
      "sha256": "64 lowercase hex characters"
    }
  }
}
```

Three facts that shape everything:

1. **It is patches-only.** There is no full-artifact download entry. A manifest
   that lists no patch for your version means you simply stay where you are —
   gracefully, with "no patch available". Nobody is forced onto a new build.
2. **`patches` is keyed by the version the user is *currently on*.** Supporting
   an upgrade from three old versions means three entries. Only versions listed
   there can update; everyone else waits.
3. **`sha256` is mandatory.** The runtime refuses a patch whose hash does not
   match. A wrong hash is not a warning — it is a silent, permanent
   non-update for every user on that version.

On the **first** nightly there is no previous version, so `{"patches": {}}` is
the correct manifest, not a placeholder.

## Cutting a nightly by hand (the current path)

One Linux machine can produce both platforms: `deno desktop` cross-compiles, and
`scripts/fetch-native.sh` can populate a Windows payload from a Linux host.

```sh
# 0. clean tree on main; the version counts commits, so uncommitted work is invisible
cd ~/Projects/SemaClip
git switch main && git pull

# 1. version it. GITHUB_RUN_NUMBER is unset locally, so the suffix is nightly.0
export GITHUB_RUN_NUMBER=0
./scripts/version.sh --nightly
V="$(./scripts/version.sh --check --nightly | sed -n 's/^version=//p')"
echo "building $V"

# 2. frontend (the backend serves frontend/build/ — an unbuilt change is invisible)
( cd frontend && npm ci && npm run check && npm run build )

# 3. native tree for the TARGET, not the host
SEMACLIP_NATIVE_PLATFORM=linux-x64 ./scripts/fetch-native.sh

# 4. package. The wrapper owns the target->triple mapping and excludes the other
#    platform's native subtrees; it emits dist/SemaClip.AppImage AND the unpacked
#    dist/SemaClip/ directory (which holds the runtime dylib) in one run.
SEMACLIP_TARGET=linux-x64 OUT="$PWD/dist/SemaClip" SEMACLIP_APPIMAGE=1 \
  deno run --allow-all scripts/build-desktop.ts

# 5. checksums
( cd dist && sha256sum SemaClip.AppImage > SemaClip.AppImage.sha256 )

# 6. the runtime dylib the next patch will diff from — must be published
cp dist/SemaClip/SemaClip.so "dist/SemaClip-$V-linux-x64-runtime.so"
( cd dist && sha256sum "SemaClip-$V-linux-x64-runtime.so" > "SemaClip-$V-linux-x64-runtime.so.sha256" )

# 7. Windows. build-desktop.ts REMOVES its OUT path first, so this replaces the
#    Linux app directory from step 4 — which is why step 6 copies the .so out
#    before getting here.
SEMACLIP_NATIVE_PLATFORM=win-x64 ./scripts/fetch-native.sh
SEMACLIP_TARGET=win-x64 OUT="$PWD/dist/SemaClip" deno run --allow-all scripts/build-desktop.ts
( cd dist && zip -qr "SemaClip-$V-win-x64.zip" SemaClip && sha256sum "SemaClip-$V-win-x64.zip" > "SemaClip-$V-win-x64.zip.sha256" )
cp dist/SemaClip/SemaClip.dll "dist/SemaClip-$V-win-x64-runtime.dll"
( cd dist && sha256sum "SemaClip-$V-win-x64-runtime.dll" > "SemaClip-$V-win-x64-runtime.dll.sha256" )

# 8. release
gh release create "v$V" --prerelease --target "$(git rev-parse HEAD)" \
  --title "SemaClip $V (nightly)" dist/SemaClip.AppImage dist/SemaClip.AppImage.sha256 \
  "dist/SemaClip-$V-win-x64.zip" "dist/SemaClip-$V-win-x64.zip.sha256" \
  "dist/SemaClip-$V-linux-x64-runtime.so" "dist/SemaClip-$V-linux-x64-runtime.so.sha256" \
  "dist/SemaClip-$V-win-x64-runtime.dll" "dist/SemaClip-$V-win-x64-runtime.dll.sha256"

# 9. manifest (empty patches on a first release)
python3 scripts/ci/manifest.py init dist/latest.json "$V"
bash scripts/ci/push-pages.sh 99oblivius/SemaClip "$GH_TOKEN" \
  dist/latest.json nightly/latest.json
```

`GITHUB_RUN_NUMBER=0` is safe locally but two machine-cuts of one commit collide on
one version. Bump the number by hand, or use the date, when cutting twice.

### Getting signatures right on the manual path

Only commit **one** `latest.json`. `scripts/ci/manifest.py merge` fetches nothing
and merges into the file you give it, so `gh release download` the live manifest
first if a release already published one, or you will drop the existing entries.

Never re-serialize a signed manifest after signing it. `sign-manifest.py`
serializes once and emits the exact string it signed. Regenerating the JSON and
patching `signed` produces a signature no client accepts.

### Adding a bsdiff patch afterwards

```sh
V="2026.142-nightly.43"; PREV="2026.141-nightly.42"
gh release download "v$PREV" --pattern '*-linux-x64-runtime.so' --dir work/old
gh release download "v$V"    --pattern '*-linux-x64-runtime.so' --dir work/new
bsdiff "work/old/SemaClip-$PREV-linux-x64-runtime.so" \
       "work/new/SemaClip-$V-linux-x64-runtime.so" "work/patch-$PREV-to-$V.bin"

# prove it before publishing: a patch can apply cleanly and still be wrong
bspatch "work/old/SemaClip-$PREV-linux-x64-runtime.so" /tmp/patched.so "work/patch-$PREV-to-$V.bin"
sha256sum /tmp/patched.so "work/new/SemaClip-$V-linux-x64-runtime.so"   # must match

# merge into the LIVE manifest, not a stale local copy
curl -sSfL https://99oblivius.github.io/SemaClip/nightly/latest.json -o dist/latest.json
python3 scripts/ci/manifest.py merge dist/latest.json "$V" "$PREV" \
  "patch-$PREV-to-$V.bin" "$(sha256sum "work/patch-$PREV-to-$V.bin" | awk '{print $1}')"

gh release upload "v$V" --clobber "work/patch-$PREV-to-$V.bin"
bash scripts/ci/push-pages.sh 99oblivius/SemaClip "$GH_TOKEN" \
  dist/latest.json nightly/latest.json "work/patch-$PREV-to-$V.bin" "nightly/patch-$PREV-to-$V.bin"
```

**`bsdiff` is not installed on this machine and is not in the Arch repos.** It is
only needed for this step; CI installs it, or use the `bsdiff4` Python package.

## What is deliberately not working

Stated plainly, because each one is a real user-visible limitation and not a
pending detail.

- **Windows auto-update does not work.** Applying an update works on macOS and
  Linux only. On Windows the patch downloads and stages, and the launcher never
  swaps the DLL in (a loaded DLL cannot be replaced in place). Deno's docs say to
  treat Windows auto-update as unsupported. The in-app status reports
  `canApply: false` rather than showing "update ready" forever. An external
  updater over the staged path is the accepted workaround
  (`server/adapters/updater/windows-update.ts`) and is not built yet.
- **Windows ships as a zip, not an installer.** `deno desktop` refuses to build a
  `.msi` from this version scheme:
  > `deno.json version "2026.141" cannot be used as an MSI ProductVersion: the major field 2026 exceeds the maximum of 255`
  Windows Installer packs `ProductVersion` as `major(0-255).minor(0-255).build(0-65535)`,
  so CalVer has no valid encoding. Verified on Deno 2.9.6, with and without the
  `-nightly` suffix. Options, none free: (a) map the version to an MSI-legal
  encoding at package time, keeping CalVer everywhere else; (b) ship Inno Setup —
  build the app **directory** and feed it to Inno on a Windows runner, which is
  the old plan's approach and adds a Windows job plus an installer script to
  maintain; (c) stay on the zip. The zip is unsigned either way, so SmartScreen
  warns.
- **bsdiff memory.** bsdiff's footprint is roughly **17x the input size**. The
  runtime dylib is ~577MB after the per-platform exclusions, so one `bsdiff` needs
  ~9.8GB+. `ubuntu-latest` has 7GB, where the failure is an OOM kill deep into the
  run rather than a clean error. Consequently the workflow's `patch` job is **off
  by default**; enabling it needs a runner with ≥16GB via the
  `SEMACLIP_PATCH_RUNNER` repository variable, and the job fails fast with the
  arithmetic if the RAM is not there. Until then, patches are a manual step.
- **The payload is huge.** ~277MB `.AppImage`, ~577MB runtime dylib, and the
  Windows zip carries its own ~800MB dylib. That is the bundled whisper models,
  whisper binaries and static ffmpeg/ffprobe, not the app. Patches exist precisely
  because re-downloading that per release is unacceptable.
- **An update that applies is not an update that boots.** A patch can apply
  cleanly and yield a binary that dies on launch, which a user only discovers via
  the failed launch and the automatic rollback. The `verify` job proves a patch
  applies and reproduces the target byte-for-byte, but CI has no display and no
  `webkit2gtk`, so it does not boot the app.
- **`deno desktop` is experimental.** That is why release jobs pin Deno exactly
  (`v2.9.6`) while `check.yml` deliberately floats on `v2.9.x` as early warning.
- **Unsigned releases.** Manifests are unsigned (no key exists) and binaries are
  unsigned, so Windows shows a SmartScreen warning and macOS would refuse the app
  outright (there is no notarization for this app yet).

## Signing the manifest (designed, not enabled)

`Deno.autoUpdate` accepts an optional `publicKey`; when present the manifest must
be a signed envelope:

```json
{"signed": "<the manifest json as a string>", "signature": "<base64 ed25519 sig over the signed string>"}
```

`server/adapters/outbound/platform/auto-update.ts` reads the key from
`SEMACLIP_UPDATE_PUBKEY` and passes it through. Today that variable is unset, so
unsigned manifests are what the app accepts.

Consequences worth knowing before switching it on:

- The key is read from the **baked-in environment of the install**. Setting it
  later does not make existing installs verify anything — only builds made with
  it set will check signatures. So a signing rollout is a rebuild, and until
  everyone has rebuilt, the manifests must stay readable by old clients.
- **Both** the `publish` and `patch` jobs must sign. `patch` rewrites the
  manifest, so signing only in `publish` leaves the final published manifest
  unsigned and every client that trusts the key would refuse it.
- `scripts/ci/sign-manifest.py` compiles and is self-checking on argument shape,
  but **has never been run against a real key**. Treat its output as unverified
  until a round trip against a real client is done.

## Rollback

Handled by the Deno launcher, not by us. Three sentinels sit next to the runtime
dylib: `<dylib>.update`, `<dylib>.backup`, `<dylib>.update-ok`. An update that
crashes on launch is rolled back automatically on the next start, and
`onRollback` fires so the app can show it happened. A rolled-back install is back
on its previous version and will be offered the same patch again — which is why a
broken patch must be fixed at the source (delete it from the release and the
manifest) rather than left in place.

## CI overview

`.github/workflows/release.yml`, triggered by `workflow_dispatch` and by pushes to
`main` that are not docs-only.

| Job | Does |
|---|---|
| `version` | runs `version.sh --nightly`, asserts tag/version agreement and that both version files carry it |
| `build` | matrix `linux-x64` + `win-x64` on `ubuntu-latest`: frontend build, native fetch, `build-desktop.ts`, sidecars, runtime dylib |
| `publish` | verifies hashes, creates the prerelease, writes `latest.json` (empty `patches`), pushes Pages |
| `patch` | **disabled by default** — bsdiff from the previous nightly, merges the entry, republishes manifest + patch in one commit |
| `verify` | downloads the release assets back and hashes them; polls the live manifest; runs `bspatch` for every listed patch and compares to the target dylib |

`verify` is a real check, not a smoke test: it fetches over the same public URLs a
client uses, and it fails when the manifest is unreachable rather than reporting
success.

## Checklist before calling a release good

1. `check.yml` and `check-engine.yml` green on the commit being released.
2. `verify` green.
3. Install the `.AppImage` on a real desktop, let it update nightly→nightly+1, and
   confirm the version changed and the window still opens. This is the step CI
   cannot do — booting the patched app.
4. Confirm the rollback path by staging a deliberately broken patch on a test
   install, or at minimum confirm `<dylib>.backup` appears and is replaced.
5. On Windows, confirm the zip runs. Update behaviour there is expected to be
   nothing, and saying otherwise in release notes would be false.
