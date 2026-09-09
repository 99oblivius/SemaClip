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
Goal: replace 100% fabricated output with defensible output on the training VOD.

1. `detection/` package: chat.ts, audio.ts, signals; hype detector; multi-timescale baselines; fixed-width endpoints with recovery heuristic.
2. whisper.cpp integration (TranscribeAdapter): audio extraction via ffmpeg, GGUF model manifest, tier detection (nvidia-smi / Vulkan / CPU), model download to platform cache with SHA-256.
3. Wire through the (now honest) job lifecycle with real progress events; persist ClipSignals; populate rank.
4. Chat parser for TwitchDownloader format (schema-validated; the 586 KB sample in data/training/ is the fixture).

**Exit gate**: end-to-end on `data/training/video.mp4` (5.9 GB Overwatch VOD) produces ≥5 clips whose top-10 hand-checks against chat/waveform (precision@10 ≥ 5 as judged manually); runtime measured and displayed; works on the CPU tier (slow but complete) and on the 4090.

## Phase 2 — UI: finish the instrument (first-priority product surface)
Goal: the DESIGN.md (v1) instrument becomes real — that spec's UI intent is kept; this phase finishes it.

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

## Phase 4 — Release engineering (desktop app + updates + CI/CD)
1. main.ts gains the real Deno Desktop shell (window, tray, dialogs, bindings); loopback server; frontend served/embedded.
2. nightly.yml + release.yml per ARCHITECTURE.md §8.2: cross-compiled `.msi` + `.AppImage`, SHA-256 sidecars, bsdiff patches, signed `latest.json` on GH Pages.
3. Settings → Updates: channel selector, check-now, pending-update UI; `Deno.autoUpdate` wired; Windows staged-update external-updater path.
4. Repository public on Livia's GitHub; tags drive stable; PRs gated by check.yml.
5. twitch-dl pinned/bundled for URL import; import validation.

**Exit gate**: on this machine, install the `.AppImage`, update from nightly→nightly+1 via the built-in updater (verifies the patch + rollback path); the same flow verified on a Windows machine or VM (staged path); a fresh clone to green CI is reproducible.

## Phase 5 — Personalization & polish
1. Implicit feedback loop (discard/export/self-label → axis weight adaptation via rolling stats) — personas table earns its existence or is dropped.
2. Compose/multi-clip reel editor (compositions table, render pipeline).
3. Windows UX parity audit; model manager UI; performance dashboards.

**Exit gate**: preference adaptation demonstrable across ≥2 labeled streams; reel export produces a real composed file.

## Standing rules
- No phase starts before the previous exit gate is demonstrably met.
- Anything that would fabricate success (stub returning victory) is a CI-blocking review reject.
- shared/types.ts is the only wire contract; docs never fork it (STACK.md §6 lesson).
- data/testing is held out until Phase 3 exit.