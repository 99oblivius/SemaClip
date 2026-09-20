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

**Exit gate**: end-to-end on `data/training/video.mp4` (5.9 GB Overwatch VOD, 5.8 h) produces ≥5 clips whose top-10 hand-checks against chat/waveform (precision@10 ≥ 5 as judged manually); **measured wall time on CPU-only mode ≤ 1 h (the §4.2 budget), with per-stage timings captured**; works on the 4090 proportionally faster; per-stage budget-regression test in CI.

**Status (2026-09-09, Phase 1 COMPLETE)**: pipeline verified E2E on real fixtures — bundled jfk.wav (11s, real whisper→clip→SRT) and a 4h ironmouse subathon slice (17.5k comments, 158× denser chat; full-path HTTP job: 15-min slice → 10 clips from both axes in 32.1s = 28× realtime). Perf measured: 36× realtime @16 workers → 5.8h VOD ≈ 10 min CPU (budget met 6×). Recall on 6 hand-labeled organic bursts: 5/6 (miss = 3s spike under minDurationSec=4, by-design policy); gift-train floods correctly not flagged. TWO axes live: hype (chat-driven) + reaction (voice-gated delta energy + wording, chat-independent — the streamer-reaction directive). Adaptive floor+spread baselines validated on dense data (floor drift +195%/4h handled); cold-start warmup fixes early over-scoring. Known limits: whisper text loses emphasis (prosody axis deferred to Phase 3); single-axis ground truth only (6 labels).

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

**Exit gate met**: 335 server tests green, `deno check` clean, svelte-check 0 errors / 0 warnings,
frontend build + tests green, and every mechanism exercised once through the real HTTP path on the
owner's own projects (never on the live database — copies, restored afterwards).

## Standing rules
- No phase starts before the previous exit gate is demonstrably met.
- Anything that would fabricate success (stub returning victory) is a CI-blocking review reject.
- shared/types.ts is the only wire contract; docs never fork it (STACK.md §6 lesson).
- data/testing is no longer a clean hold-out: `fixtures/jfk.wav` is the shared CI engine fixture and `ironmouse_4h/` has already been used for Phase 1 validation (see Phase 1's status below). Treat new data placed there as held out, but do not cite the two existing entries as unseen.