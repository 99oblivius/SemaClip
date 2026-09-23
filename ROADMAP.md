# SemaClip — Roadmap v2

> Companion to ARCHITECTURE.md. Each phase has an explicit exit gate — no phase is "done" by declaration. Phase order encodes the v1 lesson: honesty before capability, capability before intelligence.

## Phase 0 — Foundations (trust restoration, no new features)
Goal: every existing checkmark tells the truth; the audited failure classes are structurally fixed.

1. Job lifecycle state machine (single terminal-state writer, watchdog, exit-0-without-complete → failed, cancel ladder SIGTERM→SIGKILL, stderr ring buffer, stream-status reset on cancel, reaped children).
2. IPC runtime validation at the engine adapter boundary; malformed input → error events, not crashes. JobConfig casing unification.
3. Settings persistence (settings table wired; gpuDevice/engineBinaryPath actually applied at spawn; channel setting added).
4. Export actually spawns ffmpeg with progress + cancel; remove the fake-success path. Generate real SRT from transcript data.
5. Loopback bind + vodPath allowlist validation.
6. Dead-code purge: Clock port, inbound port interfaces, `clip:new` topic, one-line pass-through use-cases, unused adapter methods.
7. CI: check.yml (deno check/test, svelte-check, vite build) + the five-job-lifecycle integration tests.

**Exit gate**: all seven merged, CI green, the five lifecycle tests pass, export of a real clip produces a real playable file on this machine.

## Phase 1 — Real engine v0.1: one axis, real data
Goal: replace 100% fabricated output with defensible output on the training VOD; validate the performance budget.

1. `detection/` package: chat.ts, audio.ts, signals; hype detector; multi-timescale baselines; fixed-width endpoints with recovery heuristic.
2. whisper.cpp integration (TranscribeAdapter): audio extraction via ffmpeg, GGUF model manifest, tier detection (nvidia-smi / Vulkan / CPU), model download to platform cache with SHA-256. **Parallel chunked transcription** per ARCHITECTURE.md §4.2 (silence-split chunks, worker pool sized from cores, per-chunk progress aggregation).
3. Wire through the (now honest) job lifecycle with real progress events incl. measured per-stage timings; persist ClipSignals; populate rank.
4. Chat parser for TwitchDownloader format (schema-validated; the 586 KB sample in data/training/ is the fixture).

**Exit gate**: end-to-end on `data/training/video.mp4` (a 5.9 GB, 5.8 h VOD) produces ≥5 clips whose top-10 hand-checks against chat/waveform (precision@10 ≥ 5 as judged manually); **measured wall time on CPU-only mode ≤ 1 h (the §4.2 budget), with per-stage timings captured**; works on the 4090 proportionally faster; per-stage budget-regression test in CI.

**Status (2026-09-09, Phase 1 COMPLETE)**: pipeline verified E2E on real fixtures — bundled jfk.wav (11s, real whisper→clip→SRT) and a 4h subathon slice (17.5k comments, 158× denser chat; full-path HTTP job: 15-min slice → 10 clips from both axes in 32.1s = 28× realtime). Perf measured: 36× realtime @16 workers → 5.8h VOD ≈ 10 min CPU (budget met 6×). Recall on 6 hand-labeled organic bursts: 5/6 (miss = 3s spike under minDurationSec=4, by-design policy); gift-train floods correctly not flagged. TWO axes live: hype (chat-driven) + reaction (voice-gated delta energy + wording, chat-independent — the streamer-reaction directive). Adaptive floor+spread baselines validated on dense data (floor drift +195%/4h handled); cold-start warmup fixes early over-scoring. Known limits: whisper text loses emphasis (prosody axis deferred to Phase 3); single-axis ground truth only (6 labels).

## Phase 2 — Frontend re-development (COMPLETE)
Goal: re-develop the frontend to the full professional clipper's toolkit per the Phase 2 feature inventory (docs/FRONTEND-REQUIREMENTS.md), on a rewritten interaction core. Simplicity rule: **no UI gating** — every tool visible and reachable; power lives in keyboard and defaults, not in hidden menus.

**Status (2026-09-19): shipped.** All seven items are in the tree: frame-step, axis filters 1–7 (reaction added), the regime-banded timeline, an inline export screen at `/export` with presets + naming template + live filename preview, the processing screen, the god-component split (ClipDetail / CandidateQueue), and locally bundled fonts. Chat windowing is DONE too: `ChatView` fetches a window around the playhead (`loadWindow(aroundSec)`) instead of offset 0, so opening a project at 1h30m shows chat from 1h30m rather than the first 100 seconds, and a search hit refetches around the hit.

Reference: docs/FRONTEND-REQUIREMENTS.md (professional-VOD-clipper expectations, feature inventory, UX spec) — written from research into what avid clippers expect; the v1 DESIGN.md palette/typography/instrument principles carry over as the visual foundation.

1. Seek model rewrite (single source of truth; no sub-0.5s dead zone; frame-step works — the H7 core interaction).
2. Chat: use server `?around=` pagination; follow-mode correctness beyond 500 messages.
3. Axis filters 1–6; key-light on the rebuilt timeline (SVG/HTML layers; rAF dirty-flag + ResizeObserver); reduced-motion support; regime boundaries rendered.
4. Export sheet completion: crop preview, output path UI, Enter-to-export, export progress + error toasts; exportResult surfaced.
5. Processing screen: reachable, non-destructive cancel, live findings; `download_progress`/`job_status` consumers (Library progress bars).
6. God-component split (Review page), focus traps, Esc → SPA nav, ws reconnect with backoff.
7. Fonts bundled locally; accent-discipline sweep.

**Exit gate**: frame-step, filters, key-light, export flow all demonstrable; no fabricated UI data anywhere (signals come from persisted ClipSignals); svelte-check green.

## Phase 3 — Full detection (all six axes + triage)
1. LLM triage via llama.cpp (tiered models per §4.1) with schema-constrained JSON output; justification text real.
2. Humor axis (laughter/emote structure), tension axis (plateau+release).
3. Adaptive segmentation (Bayesian change-points) replacing fixed windows.
4. Skill, awkward, emotional axes (LLM-assisted).
5. Topic boundaries via MiniLM-L6 ONNX; endpoint resolution to the full v1 §8 design.
6. Chat sentiment ONNX classifier (or cut after calibration — interface stays either way).

**Exit gate**: all six axes produce candidates on the training VOD with distinct, correct examples; triage demonstrably kills false positives; CPU-tier run completes < 2× VOD duration.

## Phase 4 — Release engineering (SHIPPED)
1. main.ts gains the real Deno Desktop shell (window, dialogs, loopback server); the window adopts the runtime's implicit window exactly once, and closing it exits the process.
2. `release.yml`: cross-compiled `.AppImage` + portable Windows `.zip`, SHA-256 sidecars, qbsdiff patches, `latest.json` at the Pages ROOT. One continuous release line — no channels, and a version suffix fails the build.
3. Settings → Updates reads the real runtime state; `Deno.autoUpdate` is wired; the Windows gap is covered by a bundled Go sidecar updater the app writes out beside itself, run through the shipped launcher.
4. Repository public on Livia's GitHub; every code push to main cuts a release; PRs gated by check.yml + check-engine.yml.
5. URL import goes through Twitch GQL + usher; the twitch-dl path is gone.
6. **Deliberate divergences from the original plan**, each measured: ffmpeg is NOT bundled (PATH → managed dir → offered download; bundling cost ~550MB per artifact and needed ~9.8GB of bsdiff memory against a 7GB runner); the Wayland fix is `WEBKIT_DISABLE_DMABUF_RENDERER=1`, not `GDK_BACKEND=x11`; and the `.msi` is built but NOT offered, because its per-machine install leaves WebView2 unable to write its profile (blank window, upstream denoland/deno#36768) while the portable build is unaffected.

**Tooling correction**: `deno desktop` (Deno 2.9, experimental) supersedes the v1-era plan. It authors the `.msi` and `.AppImage` itself in pure Rust, cross-compiled from any host — there is **no Inno Setup and no appimagetool step**, and no Windows build host. Verified on this machine (hello-world `.msi` 32 MB, `.AppImage` 34 MB from Arch Linux). Inno Setup remains an option only by feeding it the plain app directory.

**Exit gate**: run the `.AppImage` and take an update through the built-in updater (verifies the download, the swap and the rollback path); the same on Windows (the app starts the sidecar itself). **Windows sidecar MET and now verified end to end on a real Windows guest** — measured: the updater waited 7349ms for a live process, installed the payload the app had already downloaded, recorded the version inside the bundle, and relaunched the NEW build, exit 0. Both of the previously-open items are closed: the **on-device relaunch** is observed on Windows (Linux's swap helper is written and staged, its relaunch not yet watched), and **the AppImage stages by REPLACING THE FILE** — it no longer uses the runtime's `<dylib>.update` path, which is an EROFS mount inside an AppImage. Still unverified: the AppImage's own relaunch after a swap, and the rollback path.

## Phase 5 — Personalization & polish
1. Implicit feedback loop (discard/export/self-label → axis weight adaptation via rolling stats) — personas table earns its existence or is dropped.
2. Compose/multi-clip reel editor (compositions table, render pipeline).
3. Windows UX parity audit; model manager UI; performance dashboards.

**Exit gate**: preference adaptation demonstrable across ≥2 labeled streams; reel export produces a real composed file.


## Phase 6 — Owner-requested workflow fixes (SHIPPED 2026-09-20)

Four changes requested together, each shipped with its own test and a live check:

1. **Full VOD downloads queue** — one transfer at a time, in the order added, for imports and resumes.
   Manual per-artifact downloads stay immediate (owner's choice). New phase `queued`, active in the
   UI, with the position shown ("waiting — 1 of 2 in queue"). Verified live: two imports queued at
   positions 1 and 2, `running=1 queued=1` held across polls.
2. **Recent lists newest first** — `desc(created_at)`, tested against a real in-memory database and
   falsified against the old ordering.
3. **A project's folder is recorded and named** `{streamer}-{game}-{date}` (migration 0.5.0), with
   unreachable projects striped in the Library, blocked in Review (settings still reachable), and
   repairable from a new **Change Location** using the OS folder chooser. Verified live on a copy of
   the real database: rename a folder → `reachable: false` with no restart; relocate → the artifacts
   come back (`video: true`, `renderPath` set). Empty projects are correctly NOT flagged.
4. **VOD directory setting**, above Export Defaults, with `~` expansion and relative paths refused.

**Follow-up fix (26.253)**: change 4's own save path was broken from the owner's side — pressing Save
on the VOD directory saved correctly but the page never accepted it (Save stayed armed, no saved mark,
the unsaved footer stayed). The form compared the typed `~/VODs` against the stored `/home/livia/VODs`,
two spellings of one value, so it was dirty for ever; refetching could not help because the refetched
value lands in the query cache, not the form. The save response is now adopted into the form, the dirty
rule is a pure tested module, and the unsaved footer gained a **Revert** that discards edits back to the
last saved settings. Verified by driving the real page in headless Chromium and asserting control state,
then falsified by removing the single adopt statement (which reproduces the reported symptom exactly).

**Exit gate met**: 335 server tests green, `deno check` clean, svelte-check 0 errors / 0 warnings,
frontend build + tests green, and every mechanism exercised once through the real HTTP path on the
owner's own projects (never on the live database — copies, restored afterwards).

## Version scheme corrected (26.255)

Before the next feature: the versioning was producing a three-part version (`26.255.256`), which the
owner rejected. `yy` was a leftover Windows-Installer bound and **no `.msi` is built**, so the
overflow branch was dead code; it is removed and the version is `v{yy}.{patch}` with `patch`
(commits since Jan 1) unbounded. A CI gate in `check.yml` now asserts the two-part shape, checking
executable lines only (the first gate version matched its own explanatory prose). Proved on a
throwaway 256-commit repo: `26.256` new, `26.255.256` old, three parts refused.

## Cancel fixed — stop, don't destroy (26.255)

Reported by the owner while reviewing the browser build. Three defects, all confirmed by
measurement (`tests/cancel-stops-run.test.ts`, plus a live HTTP check):

1. **Cancel was wired to `DELETE /download`**, which sweeps the artifact directory — so pressing
   Cancel destroyed the partial download it was cancelling ("deletes the proxy and chat as well").
   Cancel now has its own verb (`POST /streams/:id/download/cancel`): stops both abort registers,
   keeps every file. The DELETE remains the discard verb.
2. **A cancelled run resurrected its own state** after the reset — `finalize()` wrote the run's
   state over the reset, and `markRunLive(id, false)` then made the next read come off disk, so the
   UI saw progress that "never stops". One choke point now suppresses every write from an
   externally-aborted run (`runAborted` guards `persist` and `finalize`).
3. **Deleting a project did not stop its download** — the record and directory went while the run
   kept writing into them, and nothing was left to cancel it with. The route stops the download
   first.

Root cause of why it survived: `run()` called `downloadFmp4`/`resolveQualities` directly, bypassing
the `net` seam, so the whole-download path had no test that could abort and re-read. The seam now
covers both, and the test falsifies in both directions.

## Phase 1 — manual clip creation (26.255)

A clip that no engine found: drawn by hand at the playhead.

1. **Migration 0.6.0** rebuilds `clips` so `job_id`, `axis` and `score` are nullable, re-creating
   both indexes. Safe: no `FOREIGN KEY` is declared anywhere. **0.7.0** then adds `clips.title` for
   the clip's NAME (an ALTER) — never `axis`, which is an engine enum that validation, filtering and
   feedback all depend on.
2. **Create route** `POST /api/streams/:id/clips` taking `{startTime, endTime?}`, resolving the end
   server-side (next clip's start, else the VOD duration) and returning the created clip, which the
   page then SELECTS.
3. **Five icon buttons** in a frameless vertical rail on the clip-detail container's **left edge**
   (the timeline keeps its full width): create (`N`), set start (`[`), set end (`]`), previous
   (`J`), next (`K`). Bracket glyphs for in/out, since that is what the keys are. No Delete button —
   Discard is the reject verb and having both said the same thing twice. Icon-only with hover names,
   and every action also has a keybinding per the no-gating rule.
4. **Null-safe everywhere** a clip is rendered or ranked: a dash instead of `0.00`, no fabricated
   peak row, no SIGNALS column at all when there is no signal data, and a manual clip survives an
   axis filter (it is not an axis result). The name field shows `title`, falling back to the axis,
   falling back to `MANUAL` — with nothing prefilled from the axis.
5. **Timeline draws TWO timestamps per clip, never three.** Every clip's range is filled and bounded
   whether or not it is selected (the fill IS the duration; a bare tick makes a clip look lengthless),
   the start line is the start, and the end line is drawn thicker so a glance separates them. Nothing
   is derived from `peakTime`, which is a recorded fact that goes stale on trim — that stale field is
   what read as a second, independent start line. Selection seeks to the clip's START for the same
   reason, and the hover hit-test uses the range rather than the peak.
6. **Thumbnails** (`GET /api/clips/:id/thumbnail`): extracted on demand from the proxy-first source,
   cached as `{clipId}@{start}.jpg`, replaced rather than accumulated when the start moves, and
   deleted when the clip is rejected.
7. The playable-source ordering moved into `resolveMediaSource` so the player and the thumbnail route
   cannot disagree — and so a folder-imported project (no download state at all) resolves its media.

**Exit gate met**: **356 server tests** green, `deno check` clean, svelte-check 0 errors / 0
warnings, frontend build + **12** frontend tests green, and the whole path driven live through real
HTTP on an isolated data dir with a real video: create → computed end → null round-trip → JPEG
thumbnail served then cached → trim produces a different frame leaving exactly one file → nine drag
PATCHes still one file → reject removes that clip's frames only. Each new rule falsified by
reverting it.

**Not claimed**: the rail's appearance, icon sizing, hover titles, the bracket glyphs, the timeline
fill and the rendered thumbnails are the owner's to GUI-verify — control state and HTTP behaviour are
asserted, pixels are not. The rename path is asserted at the DB level only; it has not been driven
end-to-end over HTTP.

## Phase 2 — export page + profiles (IMPLEMENTED, uncommitted)

The export feature the owner specified: the export list is DURABLE (references, never copies), the
batch over it is DURABLE and RESUMABLE, and progress is reported per item AND across the whole batch.

**Implemented and verified.** `v0.8.0` migration (`export_list` + `export_jobs`), repositories,
`ExportQueue` use case, batch + list routes, WS topics, and the export page's progress panel. The
encoder work: a pure `domain/export-profile.ts` (profile → ffmpeg args, 13 unit tests), `-progress
pipe:1` parsing with a real abort seam, and a hardware-gated encoder that reports the backend that
ACTUALLY produced the file.

**Exit gate met**: **391 server tests** green (10 new in `migrations.test.ts`, 10 in
`export-queue.test.ts`), `deno check` clean, svelte-check 0/0, frontend build + npm test green, and
the whole path driven live over real HTTP with real ffmpeg and real restarts: list → enqueue →
observed progress → cancel (partial deleted, completed kept, nothing still writing) → kill mid-batch
→ resumed to 3 real files. **Migration verified against a WAL-safe copy of the owner's real
database**: only `0.8.0` applied, 2 streams / 4 clips and the clip name preserved byte-identically,
both tables usable, second open applied nothing, and the live DB left untouched at `0.7.0`.

### Encoder settings (per codec, measured)

Quality AND bitrate are part of the encoder options and are **manually editable per codec**, with the
profile-tier defaults coming from measurement rather than taste. Every number below was taken on the
reference host (RTX 4090, 1080p60, VMAF against a lossless reference); the full table is in the
`semaclip-dev` skill's `references/codec-quality-profiles.md`.

- **Encoder choice is per codec, defaulting on measurement.** H.264 defaults to the CPU (parity at
  matched quality, universally decodable); **AV1 defaults to the GPU** (smaller at comparable quality
  and ~3x the software encoder's speed). The user can override either way.
- **The quality mapping is a BAND, not an offset.** Mapping AV1 via a constant `+16` was derived by
  comparing AV1 against *libx264's* crf 23 — a cross-codec comparison, and wrong. Within each codec's
  own scale, x264's band (crf 18–30) maps to `h264_nvenc` cq 26–38 (slope 1.0) while SVT-AV1's
  (crf 28–45) maps to `av1_nvenc` cq 32–41 (**slope 0.53**), so a constant cannot work for AV1.
- **Quality correlates with encode time and that is now data.** Measured x-realtime at 1080p60:
  h264 5.2x, h265 2.2x, **vp9 0.8x** (slower than playback), svt-av1 2.0x, nvenc 6.2x. Each codec's
  band carries a speed and the export UI states the cost of the current choice.
- **Each band's `best` edge is where the curve flattens**, measured by marginal utility (VMAF per
  1000kbps): h264 gains 5.70 going 30→26 but only **0.35** going 18→16. Above `best` a codec is
  effectively lossless and more quality buys only bytes and seconds.
- **The bitrate ceiling is per codec and opt-in**, with a measured suggestion per codec/resolution.
  The automatic height-keyed ceiling was codec-blind and was compensating for the quality-scale bug.

Two defects this work found and fixed, both of which produced a *valid-looking* wrong output:

1. **AV1 hardware could never have worked.** `av1_nvenc` was missing from the upload-filter map, so
   the lookup fell through to bare `hwupload`, which fails with "A hardware device reference is
   required" — the export then fell back to the CPU while reporting success. Measured: `hwupload`
   fails for BOTH nvenc encoders, `hwupload_cuda` works for both. The GPU probe was also single-codec
   (`h264_nvenc` regardless of what was asked), which caused the same silent fallback.
2. **The quality mapping was cross-scale** (above). At matched quality `h264_nvenc` is now **1.03x**
   the CPU's file size, against 2.9x with the number forwarded.

### What remains

1. **The hardware-encode crossover (~10s) is an internal default**, not a visible setting. Measured:
   nvenc is slower than the CPU below ~10s and faster above it. Open question whether to expose it.
2. **Visual verification of the encoder settings, progress bar and stat line** is the owner's, per the
   standing rule — control state, HTTP and the produced files are asserted; the pixels are not.
3. **Cancel does not clear the downloaded CHAT.** Deliberate: chat is GPU-cost work and reusable
   after a cancel, so clearing it would discard real compute. A one-line change if the owner wants it.
4. **Phase 3 candidates** (not started, in the earlier plan): per-axis export naming from the
   `nameTemplate` tokens, batch-level output-directory choice in the UI, and re-running a failed item.

Highest risk remains hardware filter-graph compatibility, now MEASURED rather than assumed:
`format=nv12,hwupload_cuda` is the working upload path, while the
`hwdownload`→filter→`hwupload` round-trip fails with exit 218.

**Honest limits.** The bands and speeds were measured on ONE host with one GPU; a machine with
different hardware would probe to different encoders, and the `best`/`worst` edges are a 1080p60
measurement applied at every resolution. The speeds for H.265 and VP9 hardware are `null` because no
such encoder exists on the reference host — nothing was timed, so nothing is claimed. `h264_vaapi`'s
speed is also `null`: it EXISTS here, but nothing was timed for it, and the earlier per-backend keying
reported it at NVENC's 6.2x, which was a borrowed number presented as measured.

**Live-verified encoder arms (this host, real exports through the HTTP API).** Named `h264_nvenc` →
`backend: "h264_nvenc"`; named `h264_vaapi` → `backend: "h264_vaapi"` (no fallback in the log, so the
iGPU genuinely encoded); named `libx264` → `backend: "cpu"`. The output file ffprobes as
`h264 1280x720` + `aac`. P7's `/api/streams/:id/source-media` returned
`h264, 3044 kbps, 1280x720, 60fps` matching ffprobe's own reading, and `null` for a missing file with a
404 for an unknown stream.

**Export page revamp — the owner's nine points (P1-P9).** P1 (real thumbnail in the preview), P6 (one
filename renderer, filename centred in the row with the duration beside the name), P7 (Force Bitrate
with real source-media semantics), P8 (tier is explicit state; a manual edit never re-matches a tier),
P9 (the encoder picker lists the machine's own verified encoders per codec) and P2/P3/P4/P5 (a preset
is always selected, presets are a managed list with save/duplicate/delete, controls no longer wait for
a clip, Filename first with Encoder inside a collapsed Advanced, Export-all at the bottom of the list
it acts on) are IMPLEMENTED. Server-side: `listEncodersFor`, `/api/system/encoders`,
`/api/streams/:id/source-media`, `export_presets.origin` (migration 0.9.0) with a by-name delete
refusal.

**Owner's nine export-page corrections — IMPLEMENTED and live-verified.** Encoder explanatory text
removed; the quality input moved in-line with its bar (the old separate row is what overflowed the
container); presets now load (the legacy-blob read defect above) and a preset application drives EVERY
control including the filename; the fabricated `{platform}` token and the hardcoded `-tiktok`/`-shorts`
literals removed, with migration 0.10.0 fixing existing databases; Revert covers every section via a
single shared writer; a format change overrides the bitrate and restores the user's own state on return;
tiers are one-shot setters that carry measured per-tier bitrates and never stay selected; Export this
clip moved to the top right; crop alignments removed as a concept.

**Migrations 0.6.0-0.10.0 flattened into ONE migration (0.6.0).** Nothing after schema 0.5.0 has ever
been published — `v26.252`/`v26.253` are the highest tags, and both carry the 0.5.0 migration set — so
the five version numbers described working history rather than any user-reachable state. Statements kept
in their original order and unedited; the end state is identical by construction. Verified by
`0.5.0 → latest` end-to-end with the real rows a published seeder wrote (three presets with the legacy
flat blob and the `-tiktok`/`-shorts` literals), the 0.6.0 REBUILD preserving every clip and stream row,
and a read-back through the repository the export page uses. Both text guards falsified independently.

**Not verified by the assistant:** every visual outcome of the export page — the encoder picker's
rendered layout, the Force Bitrate toggle's hidden/enabled states, the quality tier highlight, the
preview thumbnail's pixels. Control state and HTTP responses were asserted; the rendering is the
user's to confirm.

## Phase 7 — owner-reported workflow fixes (26.258)

Four reports from the owner, one commit. Implementation and unit tests are complete; the GESTURES and
the rendered outcomes are the owner's to GUI-verify.

**1. Middle-drag pans the timeline; only left moves the playhead.** `e.button === 1` starts a pan and
returns before any seek; right-click starts nothing. The pan moves the SAME view window zoom already
owns (`viewStart`/`viewEnd` in the player store) rather than a second parallel scroll offset.

**2. One history entry per gesture, and the drag survives leaving the element.** The per-frame history
was ENDPOINT dragging, not the playhead: `adjustEndpoints` pushed an undo entry plus a PUT on every
mousemove, so reversing one drag took ~60 presses of Ctrl+Z. Live frames now update the query cache
only, and `onCommitEndpoints` fires once on release with the range captured at press — the live frames
overwrite the current range, so the component pins it in `mousedown`. Window-level listeners (armed
only while a gesture is active) keep a drag alive outside the timeline, and `handleMouseLeave` no
longer cancels one.

**3. A manual clip's end is capped at 60s.** `clipEndFrom` takes the MINIMUM of the cap, the next
clip's start (when at least 0.5s away), and the end of the video; an explicit `endTime` is clamped to
the same ceiling. Written as a minimum over candidates rather than an if/else chain, because the chain
let a neighbour's start beat the cap depending on branch order. Two boundaries worth naming: the cap is
a CEILING and not a source of video, so with under 0.5s of stream left the fallback length is used
(`min` there produced a 60s clip running past the end of the video); and an UNKNOWN duration has no
video end to honour, so the cap is the only bound and the clip gets the full 60s where the pre-cap rule
returned 30s.

**4. Export all re-exported finished clips, and a batch got the wrong file names.** Two separate
faults. The batch travelled with ONE `filename` — the SELECTED clip's already-rendered name — and the
server treats an incoming `filename` as a TEMPLATE, so a name with no tokens left rendered verbatim
across the whole run; `filename: null` lets `profile.nameTemplate` render per clip. And the implicit
selection was every listed clip, marked or not, while the route clears the mark of everything it
accepts — so export all wasted the encode and destroyed the record of existing files. Now
`selectImplicitBatch` (pure, tested) excludes already-exported clips, passes the ids EXPLICITLY (or
`enqueueAll` re-reads the list and puts them back), and reports the skip count in the UI. An explicit
`clipIds` list stays unfiltered: there the user named the clips.

Exit gate: **487 server tests** green in both UTC and CEST, detection 20/0, svelte-check 0/0, frontend
`npm test` all pass, `deno check` clean. The export-all rule has its own test file, including the
all-exported and dangling-reference cases.

## Phase 8 — the patch job's asset fetch, and six review-UI fixes (26.259, 26.260)

Two commits: the CI fix first, then the UI wave. Both are in the tree; the RENDERED outcomes are the
owner's to GUI-verify, and nothing here claims a screen was seen.

### The release patch job fetched assets by a path that returns nothing (26.259)

The `patch` job failed at `Download both runtime dylibs` on EVERY release from v26.257 on, and took
the manifest republish and all of `verify` with it.

Root cause, measured with a bare `curl` rather than through `gh`: the `assets[]` array EMBEDDED in
`releases/tags/<tag>` comes back EMPTY for these releases while `/releases/<id>/assets` returns all
eight and `releases/download/<tag>/<name>` serves them with a 200.

| endpoint | v26.256 | v26.257 | v26.258 |
|---|---|---|---|
| `releases/tags/<tag>` embedded `assets[]` | 10 | **0** | **0** |
| `releases/<id>/assets` | 10 | **8** | **8** |

`gh release download --pattern` and `gh release view --json assets` both read that embedded array, so
the download step died with `no assets to download` — and the step before it, scanning for the
previous release with the same call, had been silently WALKING PAST the real previous release: for
v26.258 it chose v26.256 as the diff base, skipping v26.257. A wrong diff base is a patch that
reproduces nothing, which is worse than the visible failure.

The fix is `scripts/ci/releases.py`: every asset is resolved through `/releases/<id>/assets`, with the
name selector EXPLICIT (`+name` for an exact filename, `+suffix` for a suffix) because inferring the
mode from the string mis-classified `-linux-x64-runtime.so` as an exact name and broke the fetch. The
workflow calls it for both steps and self-tests it before the job needs it, and the fetch now has a
size floor so a truncated download fails at the fetch instead of producing an empty patch.

**No fallback**: the pattern path is gone from both steps rather than kept beside the new one, so the
failure cannot silently return.

Verified against the real releases: `previous v26.258` returns **v26.257** (the one the old loop
skipped), and both dylibs fetch and size-check through the asset API (190,933,944 and 190,945,248
bytes).

## Standing rules
- No phase starts before the previous exit gate is demonstrably met.
- Anything that would fabricate success (stub returning victory) is a CI-blocking review reject.
- shared/types.ts is the only wire contract; docs never fork it (STACK.md §6 lesson).
- data/testing is no longer a clean hold-out: `fixtures/jfk.wav` is the shared CI engine fixture and the dense-chat slice has already been used for Phase 1 validation (see Phase 1's status below). Treat new data placed there as held out, but do not cite the two existing entries as unseen.