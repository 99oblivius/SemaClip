# Distribution & release engineering plan (SemaClip)

Status: **proposal, not yet implemented.** All facts below were verified on the
dev machine against Deno 2.9.6 — see the `semaclip-dev` skill's
`references/distribution.md` for the measured evidence.

## What you asked for

1. The desktop app as a standalone binary, installable on Linux and Windows
   (Inno Setup is the preference for Windows).
2. CI/CD on GitHub: every commit to `main` with a versioned tag builds and
   publishes artifacts **plus checksum verification** for the updater to find by
   the next open.

## Correction to the record (read this first)

`ARCHITECTURE.md` §8.2 and `ROADMAP.md` Phase 4 were written against
`deno desktop --backend cef --all-targets` and assume **Inno Setup or NSIS** for
Windows and `appimagetool` for Linux. Neither is needed any more:

- `deno desktop` (Deno 2.9, **experimental**) authors a **`.msi` in pure Rust**,
  cross-compiled from Linux, registering a per-machine install and an
  uninstaller — no Windows host, no Inno Setup.
- It also emits `.AppImage`, `.deb` and `.rpm` directly — no `appimagetool`.

I verified this on your machine: hello-world `.msi` = 32 MB, `.AppImage` = 34 MB,
app dir = 78 MB, all built from Arch Linux.

**If you specifically want Inno Setup**, that is still reachable: build the
plain app **directory** (`-o MyApp/`) and feed it to Inno Setup in CI. That adds
a Windows-runner job plus an installer-script maintenance burden for a nicer
install wizard. My recommendation is to start with the native `.msi` (free,
cross-compiled, no extra job) and add Inno later only if the `.msi` UX
disappoints.

## Two blockers found before any of this works

1. **ffmpeg/ffprobe are bare PATH lookups.** `FFmpegAdapter` and the detection
   adapter take `ffmpegPath: "ffmpeg"` / `"ffprobe"`. A compiled binary does not
   embed them, so on a machine without ffmpeg the app can't download, probe,
   transcode or export. whisper.cpp is already handled (bundled per-OS tree).
   This is the single thing standing between "standalone binary" and "binary
   that only works on your machine".
2. **Wayland: the window does not open.** Default backend under Hyprland died
   with `Gdk-Message: Error 71 (Protocol error) dispatching to Wayland display.`
   while the HTTP server kept running, so it looks half-alive rather than
   obviously broken. `GDK_BACKEND=x11` (XWayland) opens a real window fine. The
   launcher/wrapper must set this.

## Proposed steps

### Step 1 — the app becomes standalone

- Bundle ffmpeg + ffprobe per-OS under `native/ffmpeg/{linux-x64,win-x64}/`,
  fetched and checksum-pinned by the existing `scripts/fetch-native.sh`
  pattern. Add ONE resolver (mirroring the whisper selection in `main.ts`:
  per-OS subdir, `.exe` on Windows, `LD_LIBRARY_PATH` on Linux) and route every
  ffmpeg/ffprobe call site through it — the bare `"ffmpeg"` default must remain
  as the fallback for dev runs.
- Move `main.ts`'s module-top-level `PORT`/`DATA_DIR` env reads into a function
  so a GUI launch doesn't depend on env. (Behaviour otherwise works unchanged:
  `Deno.serve()` reads `DENO_SERVE_ADDRESS` in desktop builds and ignores the
  port passed, so loopback binding is preserved automatically.)
- Add the Linux launch wrapper that sets `GDK_BACKEND=x11` when on Wayland.

### Step 2 — deno.json desktop config + versioning

- `deno.json` (root or `server/`) gains `version`, `desktop.app.{name,identifier,icons}`,
  `desktop.release.baseUrl`, and per-platform `desktop.output`.
- `scripts/version.sh` already exists and emits `v{year}.{patch}` where patch =
  commits since Jan 1 (`v2026.138` today) — verified that `deno desktop` accepts
  a two-component version and `Deno.desktopVersion` reports it.
- App icon assets (`.ico` for Windows, `.png` for Linux) must be produced; none
  exist in the repo yet.

### Step 3 — wire `Deno.autoUpdate` into the entrypoint

- In `main.ts`: `Deno.autoUpdate({ url: <channel baseUrl>, interval, onUpdateReady,
  onRollback, publicKey })`. It is a **no-op under `deno run`** (no baked-in
  version) and does not throw, so the same entrypoint serves dev and release.
- Settings gains the update surface (channel, current version via
  `Deno.desktopVersion`, check-now, "restart to apply", rollback notice).
- Per-arch manifests: build `latest.json` per target under an arch-specific
  path and pick on the client with `Deno.build.os + "-" + Deno.build.arch`,
  since one manifest cannot describe both platforms' dylibs.

### Step 4 — GitHub repo + CI/CD

Repo is currently **local-only**: `git remote -v` is empty and
`99oblivius/SemaClip` does not exist on GitHub. This step needs your go-ahead —
it publishes the project.

**CI hygiene constraints (measured from the build output — each one silently
costs time or reproducibility if ignored):**

- Every `deno desktop` build downloads its own toolchain over the network:
  `libdenort-x86_64-unknown-linux-gnu.zip` from `dl.deno.land` and the
  `laufey-webview` backend archive (v0.7.0 at time of measurement). **Cache the
  Deno dir in Actions** (keyed on the pinned Deno version + target) or every job
  re-downloads tens of MB and inherits upstream flakiness.
- `deno desktop` prints **`⚠ deno desktop is experimental and subject to
  change`**. Pin the **exact patch version** (e.g. `v2.9.6`, not `v2.9.x`) for
  release jobs so an upstream Deno release cannot change packaging behaviour
  under a tag mid-flight. Both existing workflows currently pin `v2.9.x`, which
  floats — that is fine for `check.yml` (it should track the newest 2.9) but
  must not be used for a release job.
- The build **downloads** its webview backend, so the CI runner does not need
  the Linux webview libraries installed — but **users do** (the default
  `webview` backend requires `webkit2gtk` at runtime on Linux). That belongs in
  the README/install notes next to the AppImage, not just in CI.
- The build is slow (~90–110 s for a hello-world, first run) — batch steps and
  run them as tracked background jobs; a chained foreground shell call gets
  promoted and cut at 600 s.

Proposed workflows (replacing the placeholder `nightly.yml`/`release.yml`
described in `ARCHITECTURE.md`, which assume tooling that no longer applies):

- **`check.yml`** — already exists and is correct (deno check/test,
  svelte-check, vite build). Keep as the gate.
- **`check-engine.yml`** — exists; keep.
- **`release.yml`** — trigger: **tag push `v*`** (your "versioned tag"). Jobs:
  1. `version` — run `scripts/version.sh`, assert the tag matches the computed
     version, fail the build on mismatch (guarantees tag ↔ binary ↔ banner agree).
  2. `build` — matrix `ubuntu-latest` (linux-x64) and `windows-latest`
     (windows-x64); `deno desktop` per target after `npm run build` and
     `fetch-native.sh`.
  3. `publish` — upload `.msi` + `.AppImage` to the GitHub Release, write
     `.sha256` sidecars, generate bsdiff patches from the previous release's
     dylib, then compose and commit `latest.json` (+ patch files) to a
     `releases` branch served by GitHub Pages.
  4. `verify` — download the published artifacts back and check them against
     the sidecars, and **boot the patched binary** in CI (the docs warn a patch
     can apply cleanly yet produce a non-bootable binary, which users only
     discover via a failed launch + rollback).
- **`nightly.yml`** — same build, no tag, version `<year>.<n>-nightly`, published
  to a separate manifest path; optional, can come later.

**Critical constraint found:** the updater manifest is **patches-only** — there
is no full-artifact download entry in `latest.json`, and the runtime fetches
`<baseUrl>/latest.json`. Therefore the manifest must carry bsdiff entries for
every supported prior version, or users on an unlisted version stay put
(gracefully: "no patch available"). Patch generation needs the classic `bsdiff`
CLI (`qbsdiff` reads the bsdiff 4.x format) — **not installed on your machine**,
and not in the official Arch repos; CI installs it (`apt install bsdiff`) or
uses the `bsdiff4` Python package. Patches are per-architecture and are made
from the **runtime dylib** inside the app dir (`libdenort.so` / `denout.so` on
Linux, `denort.dll` on Windows) — the 78 MB `.so`, so each patch is large but
still far smaller than the full artifact.

### Step 5 — Windows auto-update gap (unchanged, now confirmed)

Applying updates works on **Linux only**. On Windows the patch downloads and
stages but the launcher never swaps it in — the docs explicitly say to treat
Windows auto-update as unsupported. `DECISIONS.md` already accepted an external
updater for this; it remains required and I'd keep it behind
`server/adapters/updater/windows-update.ts` as decided.

### Step 6 — exit gate

Per `ROADMAP.md` Phase 4 (still the right bar, tooling corrected):

- Install the `.AppImage` on this machine, update nightly→nightly+1 through the
  built-in updater, exercising the patch **and** the rollback path.
- Verify the same staged flow on a Windows machine or VM.
- Confirm a fresh clone reaches green CI reproducibly.

## Open questions for you

1. **`.msi` (native, free, cross-compiled) or Inno Setup (Windows runner +
   installer script)?** Recommendation: `.msi` first.
2. **Manifest hosting:** GitHub Pages from a `releases` branch (zero infra,
   what `ARCHITECTURE.md` §8.4 assumed) — OK?
3. **Nightly channel now, or stable-only until the app has users?**
4. **Signing:** Ed25519-signed manifests and/or Windows code signing — needed
   for a personal tool, or defer? (Unsigned Windows binaries trigger SmartScreen,
   which is a real friction for anyone but you.)
5. **`check.yml` has no gate on `main` that blocks a tag-less merge** — do you
   want the tag created manually by you, or auto-tagged by CI on merge to `main`
   (your "any commits to main with a versioned tag" reads like the latter)?
