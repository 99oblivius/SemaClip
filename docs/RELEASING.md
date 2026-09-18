# Releasing SemaClip

What the version means, where the update manifest lives, how CI cuts a release, and
what is deliberately broken. Written against the shipped pipeline: releases are cut
by CI on every code push to `main`.

Everything here was measured against Deno 2.9.6. `deno desktop` is
**experimental** and prints a warning saying so.

## Version scheme

`scripts/version.sh` is the single source of truth.

| | | |
|---|---|---|
| `v26.196` | `26` = year − 2000, `196` = commits authored this year up to HEAD | The only scheme |

There is **one continuous line of releases** and no channel of any kind. A version
suffix (`-nightly`, `-beta`) fails the build: CI asserts the version has no suffix.

**`yy` is not a stylistic choice — it is what makes the Windows installer build at
all.** Windows Installer packs `ProductVersion` as
`major(0-255).minor(0-255).build(0-65535)`, so the original full-year scheme was
rejected outright by `deno desktop`:

```
error: deno.json `version` "2026.141" cannot be used as an MSI ProductVersion:
the major field 2026 exceeds the maximum of 255.
```

`26.196` fits (and keeps fitting until 2255). The commit count fits the minor
field while it is ≤255; past that `version.sh` moves the count into the build
field (`26.255.<patch>`), which stays encodable. One version serves the app, the
updater and the installer — there is no separate MSI version to keep in sync. Do
not "restore" the full year.

The script writes the version into **both** `frontend/package.json` (the UI
banner, via `vite.config.ts`) and `server/deno.json` (baked into the binary as
`Deno.desktopVersion`). A drift between them means the updater compares the wrong
current version and re-applies patches forever, which is why CI asserts both.

```sh
./scripts/version.sh           # write the version
./scripts/version.sh --check   # print only, write nothing
```

## Where the manifest lives

GitHub Pages, served from a `releases` branch (no build step — Pages publishes
the branch content as-is). One manifest, at the ROOT:

```
https://99oblivius.github.io/SemaClip/latest.json
```

The base URL is baked into the binary via `desktop.release.baseUrl` in
`server/deno.json` and must match what CI publishes. The app polls it every 6
hours (`INTERVAL_MS` in
`server/adapters/outbound/platform/auto-update.ts`).

Artifacts (zips, the AppImage, runtime dylibs, patches) live on the **GitHub
Release** for the tag. Only the manifest and the `.bin` patch files live on
Pages, and they are committed **together in one commit** so a manifest can never
name a patch that 404s.

### Manifest shape

```json
{
  "version": "26.196",
  "patches": {
    "26.194": {
      "name": "patch-26.194-to-26.196.bin",
      "sha256": "64 lowercase hex characters"
    }
  },
  "artifacts": {
    "win-x64": { "name": "SemaClip-26.196-win-x64-portable.zip", "sha256": "..." }
  }
}
```

Four facts that shape everything:

1. **`patches` is keyed by the version the user is *currently on*.** Supporting an
   upgrade from three old versions means three entries. Only versions listed there
   can update; everyone else stays where they are, gracefully, with "no patch
   available". Nobody is forced onto a new build.
2. **`sha256` is mandatory.** The runtime refuses a patch whose hash does not
   match. A wrong hash is not a warning — it is a silent, permanent non-update for
   every user on that version.
3. **The `artifacts` entry is the Windows channel.** The runtime applies a *patch*
   to its own dylib; it cannot replace a whole directory, so the Windows sidecar
   reads this entry to know which zip to fetch. Two disjoint payloads in one file.
4. **`{"patches": {}}` is a correct manifest**, not a placeholder. It is what a
   first release produces. But a "nothing to do" branch must PROVE it is allowed
   to be empty — a released client with no patch for its version can never update,
   so an accidentally-empty `patches` is indistinguishable from a broken pipeline.

## How a release is cut

CI does it. `.github/workflows/release.yml` runs on every push to `main` that
touches code (markdown-only pushes are ignored via `paths-ignore`, because the
version is commit-derived and a typo fix would otherwise cut a release and move
every user's version).

Six jobs:

| Job | Does |
|---|---|
| `version` | writes the version, asserts tag/version agreement and that both version files carry it, rejects any suffix |
| `build (linux-x64)` | frontend build, native fetch, `build-desktop.ts` → AppImage + runtime dylib, `sha256` sidecars |
| `build (win-x64)` | same for Windows → `.msi` + portable `.zip` + runtime dll, with the sidecar updater and launcher asserted present in the zip |
| `publish` | verifies hashes, creates the release (serially, one asset at a time), writes `latest.json`, pushes Pages |
| `patch` | qbsdiff delta from the previous release, merges the entry, republishes manifest + patch in one commit |
| `verify` | downloads the assets back over the PUBLIC urls, hashes them, polls the live manifest, applies every listed patch and compares the result to the target dylib byte-for-byte |

**One push cuts one release, and the concurrency group serialises runs.** Two runs
racing would both try to create the same tag and both push a manifest; the second
push wins and the loser's patch entry is dropped. Do not push to "retry" while a
release is in flight — `cancel-in-progress` kills the running one mid-upload and
leaves a partial release.

**Publish serially.** `gh release create <tag> <files...>` uploads every asset
CONCURRENTLY, the asset endpoint rejects concurrent uploads to one release, and the
call is all-or-nothing — one rejected asset rolls back the entire release. That is
why publishing goes through `scripts/ci/publish-release.sh`, which creates the
release empty and uploads one asset at a time with retries. Never call
`gh release create` with a file list.

### Cutting by hand (avoid)

CI owns this now. Doing it manually means reproducing `release.yml`'s steps, and the
traps below are the ones that have already cost a release:

- `build-desktop.ts` **REMOVES its `OUT` path first**, so the Windows build
  replaces the Linux app directory — copy the Linux `.so` out before building
  Windows.
- **Only commit one `latest.json`.** `manifest.py merge` fetches nothing and merges
  into the file you give it, so download the LIVE manifest first or you drop the
  existing entries.
- Pushing the manifest and the patch in **separate** commits creates a window where
  the manifest names a file that 404s.

### Adding a patch afterwards

```sh
V="26.196"; PREV="26.194"
gh release download "v$PREV" --pattern '*-linux-x64-runtime.so' --dir work/old
gh release download "v$V"    --pattern '*-linux-x64-runtime.so' --dir work/new
# qbsdiff, NOT classic bsdiff: same bsdiff4 format (it is the crate the Deno
# runtime itself uses to APPLY patches), and memory-saving. Measured peaks on a
# 560MB dylib pair: 3.29GB typical / 3.84GB worst case, against classic bsdiff's
# ~9.8GB. -P disables the parallel search so memory stays predictable.
qbsdiff -P "work/old/SemaClip-$PREV-linux-x64-runtime.so" \
           "work/new/SemaClip-$V-linux-x64-runtime.so" "work/patch-$PREV-to-$V.bin"

# prove it before publishing: a patch can apply cleanly and still be wrong
qbspatch "work/old/SemaClip-$PREV-linux-x64-runtime.so" /tmp/patched.so "work/patch-$PREV-to-$V.bin"
sha256sum /tmp/patched.so "work/new/SemaClip-$V-linux-x64-runtime.so"   # must match

# merge into the LIVE manifest, not a stale local copy
curl -sSfL https://99oblivius.github.io/SemaClip/latest.json -o dist/latest.json
python3 scripts/ci/manifest.py merge dist/latest.json "$V" "$PREV" \
  "patch-$PREV-to-$V.bin" "$(sha256sum "work/patch-$PREV-to-$V.bin" | awk '{print $1}')"

gh release upload "v$V" --clobber "work/patch-$PREV-to-$V.bin"
bash scripts/ci/push-pages.sh 99oblivius/SemaClip "$GH_TOKEN" \
  dist/latest.json latest.json "work/patch-$PREV-to-$V.bin" "patch-$PREV-to-$V.bin"
```

**Only needed for this step.** Install the generator with:

```sh
cargo install qbsdiff --features cmd
```

The `--features cmd` is required — the binaries sit behind a non-default feature,
so a plain `cargo install qbsdiff` succeeds and produces **no binaries at all**,
which looks like it worked until the patch step fails.

## What is deliberately not working

Stated plainly, because each one is a real user-visible limitation and not a
pending detail.

- **Windows auto-update does not work in-process.** Applying an update works on
  Linux only. On Windows the patch downloads and stages, and the runtime never
  swaps the DLL in (a loaded DLL cannot be replaced in place); Deno's docs say to
  treat Windows auto-update as unsupported. The in-app status reports
  `canApply: false` rather than showing "update ready" forever. The accepted
  workaround is a **Go sidecar updater** (`tools/updater/`), shipped inside the
  portable payload and written out beside the app at launch
  (`adapters/outbound/platform/sidecar.ts`), which performs the swap on a fresh
  process and relaunches. The portable zip therefore updates itself when started
  through the bundled `Update and launch SemaClip.cmd`.
- **There is no installer offered for Windows, and that is deliberate.** `deno
  desktop` authors a per-machine `.msi` under `%ProgramFiles%`, where the WebView2
  runtime cannot write its profile, so the window comes up blank
  (upstream `denoland/deno#36768`, still open). No in-app fix is possible: the
  runtime initialises WebView2 before the entrypoint runs and there is no config
  option for that folder. The `.msi` is still BUILT and published so the per-user
  install work has an artifact to test, but it is not offered on the landing page.
  The portable zip is unaffected because it unpacks somewhere writable. The `yy`
  version scheme above still holds, since the MSI is still built.
- **`deno desktop` is experimental.** That is why release jobs pin Deno exactly
  (`v2.9.6`) while `check.yml` deliberately floats on `v2.9.x` as early warning.
- **The payload is huge.** ~277MB `.AppImage` and a ~577MB runtime dylib. That is
  the bundled whisper models and whisper binaries, not the app. ffmpeg is NOT
  bundled (it resolves PATH → managed dir → offered download), which is why the
  payload is ~550MB smaller than it once was. Patches exist precisely because
  re-downloading that per release is unacceptable.
- **An update that applies is not an update that boots.** A patch can apply
  cleanly and yield a binary that dies on launch, which a user only discovers via
  the failed launch and the automatic rollback. The `verify` job proves a patch
  applies and reproduces the target byte-for-byte, but CI has no display and no
  `webkit2gtk`, so it does not boot the app.
- **Unsigned releases.** Manifests are unsigned (no key exists) and binaries are
  unsigned, so Windows shows a SmartScreen warning and macOS would refuse the app
  outright (there is no notarization for this app yet).

## Signing the manifest (designed, not enabled)

`Deno.autoUpdate` accepts an optional `publicKey`; when present the manifest must
be a signed envelope:

```json
{"signed": "<the manifest json as a string>", "signature": "<base64 ed25519 sig over the signed string>"}
```

`server/adapters/outbound/platform/auto-update.ts` reads the key from a
**compile-time constant** (`UPDATE_PUBLIC_KEY`), not from the environment — a
`getenv()` there would read undefined in production and silently disable
verification. Today that constant is empty, so unsigned manifests are what the app
accepts.

Consequences worth knowing before switching it on:

- The key is **baked into the install**. Setting it later does not make existing
  installs verify anything — only builds made with it set will check signatures, so
  a signing rollout is a rebuild, and until everyone has rebuilt the manifests must
  stay readable by old clients.
- **Both** the `publish` and `patch` jobs must sign. `patch` rewrites the manifest,
  so signing only in `publish` leaves the final published manifest unsigned and
  every client that trusts the key would refuse it.
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

## Checklist before calling a release good

1. `check.yml` and `check-engine.yml` green on the commit being released.
2. `release.yml`'s six jobs green.
3. `verify` green — and read it, since a green unit suite while the artifact is
   broken means the check was not exercising the claim.
4. Run the `.AppImage` on a real desktop and take a patch. Confirm the version
   changed and the window still opens. This is the step CI cannot do — booting the
   patched app.
5. Confirm the rollback path by staging a deliberately broken patch on a test
   install, or at minimum confirm `<dylib>.backup` appears and is replaced.
6. On Windows, run the portable zip and update through `Update and launch
   SemaClip.cmd`. Report what happened rather than assuming: the sidecar path is
   verified on Linux against the real helpers but has never run on Windows
   hardware.
