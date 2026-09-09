# SemaClip — Architecture v2

> /ˈsɛməklɪp/ — Greek σῆμα (sign, signal) + clip. A clip found by reading the signals.
>
> Supersedes `docs/archive/v1/`. The v1 docs described a system that was never built (the engine was a ~250-line mock) and a stack that does not meet the v2 hardware constraints. This document is the functional target the implementation is built against. Status of every component is tracked in ROADMAP.md, never asserted here.

## 1. Product requirements (v2, fixed)

1. **Desktop app, Windows + Linux, cross-compiled from CI.** One codebase, per-OS installers, identical feature surface. macOS is a free follow-on (Deno Desktop supports it) but is not a v2 gate.
2. **Auto-updating client** with a **stable / nightly channel selector** in Settings. Verified platform facts (Deno Desktop docs, 2.9):
   - Built-in: `Deno.autoUpdate()` polls `latest.json`, downloads bsdiff patches, verifies SHA-256, stages, applies on next launch, rolls back on failed launch. Manifest signing via Ed25519.
   - **Windows gap: patches download and stage but never swap in (loaded DLL cannot be replaced). Windows auto-update is officially "not yet supported."**
   - Therefore: the update *check*, download, and channel selection are in-app on all platforms; *application* of updates is native on Linux, and on Windows is a staged-download + "restart to apply via external updater" path (§9.4) until Deno ships the launcher swap. No third-party updater dependency in v2.
3. **Local inference on consumer hardware as the floor**: ~16 GB RAM, ~6 GB VRAM, AMD and NVIDIA, Windows and Linux. Scaling up (more VRAM/RAM) must be automatic — never worse, never manual tuning.
4. **UI-first priority**: clip review, trimming, composing (multi-clip), and export are the product. Signal detection is the second pillar and must be fully implemented — but never at the cost of the edit/export loop.
5. **Honesty invariant** (learned from the v1 audit): no UI element may display data the pipeline did not produce. Features report failure loudly. Every contract boundary is runtime-validated.

## 2. Stack (decided)

| Layer | Choice | Why (v2 constraints) |
|---|---|---|
| Shell | **Deno Desktop + CEF** | Verified: cross-compiles Win x64 + Linux x64 from any host; produces `.msi`, `.AppImage`, `.deb/.rpm` directly; built-in updater on Linux/macOS. Same language both sides = shared types with no codegen. |
| Backend | **Deno (TypeScript)** | Unchanged verdict from v1: I/O orchestration, negligible perf cost vs ML. The Python engine layer is **deleted** (§4). |
| Frontend | **Svelte 5 + SvelteKit SPA + Tailwind v4** | Already proven in the existing codebase; keep the investment. |
| Transcription | **whisper.cpp** (GGUF models, Vulkan + CPU) | Runs identically on NVIDIA/AMD/Intel/CPU. Vulkan works on Windows and Linux with one binary. Quantized models fit 6 GB VRAM floors (§4.1). |
| LLM triage/labels | **llama.cpp server** (GGUF, Vulkan + CPU) | Same reasoning. Qwen-class 4-7B at Q4 fits the floor. Optional: if the user has a tabbyAPI/ollama endpoint configured, use it via OpenAI-compatible API. |
| Video | **FFmpeg** (bundled, per-OS binaries from BtbN builds pinned in CI) | The one universally correct choice; already a working dependency. |
| GPU detection | `nvidia-smi` (NVIDIA), Vulkan enumeration via `vulkaninfo`-equivalent probe (AMD/other), CPU fallback | Drives the device picker and per-tier model manifest (§4.1). |
| DB | **node:sqlite + Drizzle sqlite-proxy** (keep v1's actual choice) | Works, WAL, synchronous fine for desktop scale. Add FK constraints this time. |

Explicitly rejected for v2:
- **Python engine + PyInstaller**: CUDA-only GPU story fails AMD; 200-400 MB binary fails consumer distribution; the IPC layer was the weakest audited surface. All detection logic moves to TypeScript, calling native runtimes as subprocesses.
- **PyTorch / faster-whisper / sentence-transformers**: same GPU-ecosystem objection; superseded by GGUF/ONNX runtimes.
- **Universal Stream Encoder (custom contrastive multimodal model)**: a research project, not a component. Cut from the roadmap entirely (§7.3). The v1 architecture's stages that depended on it (embedding-space anomaly detection, embedding Kalman) are cut with it.

## 3. System layout

```
SemaClip/
├── frontend/                      # SvelteKit SPA (existing, kept + finished)
├── server/                        # Deno backend (existing, kept + slimmed)
│   ├── main.ts                    # desktop entry: window, tray, updater hook
│   ├── adapters/
│   │   ├── inbound/               # http routes, ws handler (existing)
│   │   └── outbound/
│   │       ├── engine/            # DetectionEngineAdapter — spawns ONE engine process
│   │       ├── ffmpeg/            # FFmpegAdapter (export, probes, waveform)
│   │       ├── transcribe/        # WhisperCppAdapter
│   │       ├── llm/               # LlmAdapter (llama.cpp server | OpenAI-compat endpoint)
│   │       ├── twitch/            # TwitchDlAdapter (URL import, chat fetch)
│   │       ├── persistence/       # node:sqlite repos (existing, + FKs + transactions)
│   │       ├── eventbus/          # InProcessEventBus (existing)
│   │       └── vod/               # storage layout
│   ├── application/               # use-cases (existing; pass-throughs deleted)
│   ├── composition/               # container
│   └── domain/                    # entities
├── detection/                     # NEW — the ML-free detection logic, pure TS, unit-testable
│   ├── signals/                   # per-second feature extraction from chat + audio arrays
│   │   ├── chat.ts                # velocity, emote density, caps ratio, sentiment-lite
│   │   ├── audio.ts               # RMS energy, speech ratio (from ffmpeg-probed arrays)
│   │   └── transcript.ts          # sentence embeddings-lite (see §5.3)
│   ├── axes/                      # one detector per axis, same interface
│   ├── segmentation.ts            # change-point detection on joint features
│   ├── baselines.ts               # multi-timescale percentiles (local 30min / global VOD)
│   ├── ranking.ts                 # axis-relative percentile + diversity constraint
│   ├── endpoints.ts               # recovery/topic-boundary/axis-max resolution
│   └── pipeline.ts                # orchestrates stages, yields EngineEvents
├── native/                        # bundled external binaries (versioned, per-OS)
│   ├── ffmpeg/, whisper.cpp/, llama.cpp/  (downloaded by release CI, not committed)
├── shared/                        # single source of truth for all wire types
├── docs/                          # this file, ROADMAP.md, DECISIONS.md
└── .github/workflows/             # CI: check + build + release + update manifest
```

The `detection/` package is the core v2 change: detection is **pure TypeScript operating on pre-extracted numeric arrays** (chat events, audio RMS/speech-ratio per second, transcript segments with timestamps). All heavy lifting (decode, transcribe, embed) is native binaries; all judgment logic (segmentation, baselines, scoring, endpoints, ranking) is testable TS with no ML runtime in CI.

## 4. Data flow (one job, v2)

```
VOD + chat.json
  → ffmpeg: audio → 16kHz mono WAV; per-second RMS + speech-probability arrays
  → whisper.cpp: transcription with word timestamps → segments
  → chat parser: TwitchDownloader JSON → per-second chat features
  → detection/signals: joint per-second feature table
  → detection/segmentation: change points → variable-length regimes
  → detection/axes: candidates per axis with per-signal scores (ClipSignals)
  → LLM triage (llama.cpp): classify + justify candidates above threshold
  → detection/ranking: axis-relative percentile + diversity → final clips
  → detection/endpoints: recovery/topic/max per axis, snapped to sentence boundary
  → persist (clips + signals + persona updates) → WS stream to UI
```

Cancellation is cooperative: the pipeline checks a cancel flag between stages and inside per-second loops; the engine process is killed at stage boundaries, never mid-model-load.

### 4.2 Performance budget (hard requirement)

**A 6-hour VOD processes in under 1 hour on the consumer floor (CPU-only, ~16 GB RAM); under ~15 min with a mid-tier GPU.** The budget is validated in Phase 1's exit gate — the measured per-phase timings are displayed in the UI, not just logged.

Where the time budget goes (6 h = 21,600 s of audio):

| Stage | Strategy | CPU-only target | Mid-GPU |
|---|---|---|---|
| Decode + feature arrays | ffmpeg to 16 kHz mono WAV; RMS/speech-ratio arrays computed in a streaming pass | ~2–5 min | same |
| **Transcription** | **Parallel chunked whisper.cpp**: split on silence into 30–120 s chunks, N worker processes (N = min(cores÷2, 8)), each pinned `small`/`base` int8 on CPU — near-linear scaling. GPU tiers: single `large-v3-turbo` Q5 via Vulkan, chunks pipelined | ~20–35 min (8 workers × ~3–5× realtime) | ~3–6 min |
| Chat + detection arrays | Pure TS, per-second math | seconds | seconds |
| Segmentation/axes/ranking/endpoints | Array math, O(n) | seconds | seconds |
| LLM triage | Batched parallel calls to llama.cpp server; skipped on CPU-only tier unless time budget remains | 0–10 min | ~5 min |
| Export | On-demand, not in the pipeline | — | — |

Rules:
- Transcription parallelism is the only stage where multi-processing pays; it is built in from Phase 1, not retrofitted. Worker count, model per tier, and chunk overlap are manifest-driven; workers are plain OS processes (whisper.cpp CLI), so Windows/Linux behave identically.
- Every stage reports measured seconds in `progress` events (`message` includes elapsed + estimated remaining); the Processing screen shows actuals. A phase exceeding its budget share logs a warning (visible in job diagnostics) — budgets are asserted in an integration test with a mock decoder so regressions are caught in CI.
- CPU tiers skip LLM triage by default (keep detection honest: clips are marked `triage: 'skipped'`, not silently absent).
- These figures are engineering targets validated on the Phase 1 exit gate run; the manifest tier table is adjusted to *measured* hardware, not optimistic paper numbers.

### 4.1 Model tiers (the 16 GB / 6 GB floor)

Model selection is a **manifest lookup by detected hardware tier**, not a config file the user must understand:

| Tier | Detected | Transcription | LLM triage | Notes |
|---|---|---|---|---|
| CPU-only | no GPU, ≥8 GB RAM | whisper.cpp `small` (int8, CPU, parallel workers §4.2) | skipped by default | Slow but complete; UI shows measured time. |
| Low VRAM | <6 GB VRAM | `base` or `small` on GPU + CPU offload | 1.5-3B Q4 | 6 GB floor target. |
| Mid | 6–12 GB VRAM | `large-v3-turbo` Q5 | 7B Q4 | Default target tier. |
| High | >12 GB VRAM | `large-v3` | 7B-14B Q4/Q5 | Automatic scale-up. |

- Detection: NVIDIA via `nvidia-smi`, AMD/others via Vulkan device enumeration; VRAM queried where possible, else conservative default.
- Manifest (`shared/model-manifest.ts`) maps tier → model file + quantization + context size; llama.cpp server is spawned once per job with the tier's model and killed after.
- All models download on first use to the platform cache dir (Windows: `%LOCALAPPDATA%\SemaClip\models`; Linux: `~/.local/share/SemaClip/models`) with SHA-256 verification, resumable download, and a Settings UI showing what is present.
- **No RAM/VRAM probing failure may crash the app**: probe failure → CPU tier + visible warning.

### 4.2 Performance budget (hard requirement)

**A 6-hour VOD processes in under 1 hour on the consumer floor (CPU-only, ~16 GB RAM); under ~15 min with a mid-tier GPU.** The budget is validated in Phase 1's exit gate — the measured per-phase timings are displayed in the UI, not just logged.

Where the time budget goes (6 h = 21,600 s of audio):

| Stage | Strategy | CPU-only target | Mid-GPU |
|---|---|---|---|
| Decode + feature arrays | ffmpeg to 16 kHz mono WAV; RMS/speech-ratio arrays computed in a streaming pass | ~2–5 min | same |
| **Transcription** | **Parallel chunked whisper.cpp**: split on silence into 30–120 s chunks, N worker processes (N = min(cores÷2, 8)), each pinned `small`/`base` int8 on CPU — near-linear scaling. GPU tiers: single `large-v3-turbo` Q5 via Vulkan, chunks pipelined | ~20–35 min (8 workers × ~3–5× realtime) | ~3–6 min |
| Chat + detection arrays | Pure TS, per-second math | seconds | seconds |
| Segmentation/axes/ranking/endpoints | Array math, O(n) | seconds | seconds |
| LLM triage | Batched parallel calls to llama.cpp server; skipped on CPU-only tier unless time budget remains | 0–10 min | ~5 min |
| Export | On-demand, not in the pipeline | — | — |

Rules:
- Transcription parallelism is the only stage where multi-processing pays; it is built in from Phase 1, not retrofitted. Worker count, model per tier, and chunk overlap are manifest-driven; workers are plain OS processes (whisper.cpp CLI), so Windows/Linux behave identically.
- Every stage reports measured seconds in `progress` events (`message` includes elapsed + estimated remaining); the Processing screen shows actuals. A phase exceeding its budget share logs a warning (visible in job diagnostics) — budgets are asserted in an integration test with a mock decoder so regressions are caught in CI.
- CPU tiers skip LLM triage by default (keep detection honest: clips are marked `triage: 'skipped'`, not silently absent).
- These figures are engineering targets validated on the Phase 1 exit gate run; the manifest tier table is adjusted to *measured* hardware, not optimistic paper numbers.

## 5. The five subsystems in functional detail

### 5.1 Ingest
- **File import** (existing, works): local VOD + optional chat JSON.
- **URL import**: fixed TwitchDlAdapter; `twitch-dl` pinned and bundled per-OS by release CI (binary dependency, not a runtime assumption); chat auto-fetch after VOD download; progress via WS `download_progress` (the event already exists, unused in the UI).
- Input validation: container/duration/codec probe before acceptance; chat JSON schema check (TwitchDownloader format) with a clear error if mismatched.

### 5.2 Detection engine (see data flow above)
- **Signals** (per-second, from §3): chat velocity, emote density (weighted POGGERS > LUL > ResidentSleeper), caps ratio, message length; RMS energy; speech ratio; transcription-derived word rate.
- **Chat sentiment**: local 3-class classifier (positive/negative/other). v2 uses a distilled ONNX model (~50 MB, onnxruntime CPU) — the only ONNX dependency; it replaces the v1 DistilBERT plan within the same hardware floor. If it proves unnecessary after calibration, it is cut; the interface (`score(msg) → valence`) stays.
- **Segmentation**: Bayesian change-point detection on the joint feature table with hazard 1/300 s, min segment 10 s — the v1 design was sound and is kept; implementation is ~150 lines of TS on arrays.
- **Baselines**: max(local 30-min rolling median, global VOD median × 0.5) — the v1 §7.5 design, kept verbatim. **No Kalman filter** (v1 critique stands).
- **Axes**: six detectors behind one interface `detect(features, regime, baseline) → Candidate[]`. v2 ships **hype** first (chat velocity + emote density + RMS + word-rate corroboration), then humor (laughter markers + emote-structure), tension (plateau + release), then skill/awkward/emotional (LLM-heavy). Each candidate carries real `ClipSignals` (the v1 UI fabricated these; v2 persists and renders them).
- **LLM triage**: every candidate above threshold gets one structured call (local llama.cpp per §4.1): axis classification, keep/drop, one-sentence justification, optional endpoint hint. JSON-schema-constrained output, validated at runtime; fallback to un-triaged candidates with `triage: 'unavailable'` so detection never hard-fails when no model is present.
- **Ranking**: axis-relative percentile + outlier boost + diversity constraint (v1 §9 design, kept).
- **Endpoints**: `min(recovery, topic_boundary, axis_max)`, snapped to sentence boundaries (v1 §8 design, kept — it was the best-specified part of the old doc).

### 5.3 Embeddings — the one scoped-down ML piece
v1's universal encoder is cut. What detection still needs is topic-boundary similarity for endpoint resolution. v2 solution: **MiniLM-L6 ONNX (23 MB, CPU, onnxruntime)** for sentence embeddings → adjacent-window cosine similarity → topic boundaries. This is 80 MB of model, no training, runs everywhere the floor runs. If even this is too slow on CPU tiers, the topic boundary falls back to whisper segment gaps + LLM triage endpoint hints. Both paths are behind one `TopicBoundaryDetector` interface.

### 5.4 Job lifecycle (the audited weak spot, redesigned)
- Explicit state machine: `queued → running → {completed | failed | cancelled}`, single writer, transitions persisted.
- **Watchdog**: engine process must emit any event within N seconds or the job fails loudly. Engine exit 0 without `complete` → `failed("no completion event")`. No silent wedging.
- **Cancel**: cooperative flag in the pipeline + stdin cancel line + SIGTERM→SIGKILL escalation ladder; engine reaped on server shutdown; cancelled job resets stream status (v1 leaked it).
- **stderr**: piped, drained continuously into a ring buffer; last 50 lines attached to job failure for diagnostics.
- **Concurrency**: exactly one running job (GPU constraint); queue is persisted, reorder is transactional.
- The engine runs as **one long-lived process per job batch** with the IPC protocol below; no PyInstaller, no per-job model reload.

### 5.5 Export & composing (first-priority product surface)
- **Export**: FFmpegAdapter actually spawns ffmpeg (v1 shipped a stub that reported success — the cardinal audit finding). Real args builder: codec (H.264/H.265/VP9), aspect crop (16:9/9:16/1:1 with live preview), caption burn-in from real whisper SRT (generated, not renamed chat JSON), output path + filename, progress parsing (`-progress pipe:1`), cancel support.
- **Compose**: multi-clip timeline — select clips, order, per-clip trim, optional crossfade/text cards between, single FFmpeg filtergraph render. The composition is persisted as an entity (`compositions` table) so a half-built reel survives restarts.
- **Editor affordances** (H7 finished properly): frame-accurate trim with the fixed seek model (§6.2), zoom to frame, keyboard-first review loop (J/K, 1–6 axis filters, E/Shift+E, D/U) per the v1 DESIGN.md — that document's UI spec was good and is the reference for the UI track.

## 6. IPC protocol (single canonical contract)

**One protocol, defined in `shared/types.ts`, runtime-validated at every boundary.** The v1 docs' snake_case fork is dead; the actual built system's camelCase shapes are canonical.

Commands (Deno → engine process stdin, NDJSON):
```typescript
type EngineCommand =
  | { type: "start"; jobId: string; vodPath: string; chatPath?: string; config?: JobConfig }
  | { type: "cancel" };
```

Events (engine stdout → Deno, NDJSON; every event carries `jobId`):
```typescript
type EngineEvent =
  | { type: "progress"; jobId; phase: EnginePhase; percent: number; message?: string }
  | { type: "segment"; jobId; start; end; regime }
  | { type: "candidate"; jobId; axis; start; end; peak; score; signals: ClipSignals }
  | { type: "clip"; jobId; axis; start; end; peak; score; justification?; signals: ClipSignals }
  | { type: "complete"; jobId; clipsFound: number }
  | { type: "error"; jobId; phase: EnginePhase; message };
```
- `PipelineConfig` keys are camelCase end-to-end (`axisThresholds`, `maxClips`) — the v1 `**job_config` snake_case crash class is structurally impossible.
- The engine adapter validates every inbound line against the union (discriminator + field presence + numeric ranges) and logs+drops unknown shapes with a counter; malformed JSON increments a protocol-error metric rather than killing the loop (v1 crashed).
- WS: same events forwarded with a topic envelope; frontend validates on receipt the same way.

## 7. Cross-platform requirements

- **All paths via adapter**: every filesystem touch goes through `StreamStorage`/`FileSystemPort` using path semantics per OS; no string concatenation with `/`.
- **Process spawning**: `Deno.Command` with absolute binary paths resolved from the `native/` dir per-OS (`.exe` suffix on Windows); no reliance on PATH.
- **Fonts**: Google Fonts CDN (v1 choice) is rejected — offline-first requirement. Fonts are bundled as woff2 in the app (both OSes).
- **Keyboard/UX parity**: the keymap avoids OS-reserved combos; shortcuts overlay lists per-OS differences (e.g., Cmd vs Ctrl is moot for v2 but the structure exists).
- **File dialogs**: Deno Desktop native dialogs via bindings; drag-drop paths normalized per-OS.
- **Tray + window**: implemented via Deno Desktop APIs on both platforms; verified in the Windows test matrix (§10).
- **Loopback bind**: server binds `127.0.0.1` on both OSes (v1 bound 0.0.0.0 with arbitrary-path routes — LAN file-read vulnerability).
- **CPU parallelism as a first-class resource**: worker pools (transcription chunks, LLM batches) size themselves from hardware concurrency and re-probe on job start; nothing in the pipeline is single-threaded by accident. See §4.2.

## 8. Update & release engineering

### 8.1 Channels
- `nightly`: built on every merge to `main` (or `develop`), version `0.0.0-nightly.<run>`, published to the nightly manifest, retained for 30 days.
- `stable`: built on version tags (`v*`), full changelog, permanent retention.
- Both channels' manifests live side by side: `releases/stable/latest.json`, `releases/nightly/latest.json`. The client's channel setting selects which manifest it polls.

### 8.2 CI/CD (GitHub Actions)
- **check.yml** (PR + push): `deno check`, `deno test` (detection/ is pure TS — real unit tests run here, fast, no models), frontend `svelte-check` + `vite build`, `deno publish --dry-run` style lint of deno.json. This is the gate; nightly releases depend on green.
- **nightly.yml** (merge to main): frontend build → `deno desktop --target x86_64-pc-windows-msvc` + `--target x86_64-unknown-linux-gnu` (single ubuntu host cross-compiles both; `.msi` + `.AppImage` outputs) → SHA-256 per artifact → upload to releases (GH Releases for artifacts; Pages/R2 for manifests — §8.4) → generate bsdiff patches from previous nightly per platform → publish `latest.json` (patch entries carry mandatory sha256) → optionally Ed25519-sign the manifest (key in GH secret).
- **release.yml** (tag `v*`): same matrix, versioned artifacts + changelog from commits, stable manifest update.
- Engine/native binaries (ffmpeg, whisper.cpp, llama.cpp, onnxruntime, twitch-dl): pinned versions fetched by CI from upstream releases with checksum verification; bundled into the app payload (or downloaded on first run for the large model files — binaries bundle, models download).
- Artifacts: `SemaClip-<ver>-windows-x64.msi`, `SemaClip-<ver>-linux-x64.AppImage`, each with `.sha256` sidecar; manifest lists patch SHAs (auto-update contract).

### 8.3 Update flow in-app
- Settings → Updates: channel selector (stable/nightly), current version (`Deno.desktopVersion`), "check now" button, last-check timestamp, pending-update indicator with "restart to apply".
- `Deno.autoUpdate({url: channelBaseUrl, interval: 6h, onUpdateReady, onRollback})` — wired in main.ts; channel switch re-invokes with the other manifest URL.
- Linux: native staging applies on next launch with rollback.
- Windows (Deno gap): patches download + stage; the app shows "update ready — restart to install" and a tiny external updater exe (written to app data, itself replaceable) performs the swap on a fresh process, then relaunches. **Accepted decision (2026-09-09, Livia): functional Windows auto-update regardless of method.** This updater is a *workaround for Deno's missing Windows launcher swap* — it lives behind `server/adapters/updater/windows-update.ts`, its contract (stage dir layout, swap protocol, readiness check) is documented in that module's header comment, and it is flagged for replacement the moment Deno ships native Windows apply. Cleanup = delete the adapter and the staged path; everything else (manifests, channel logic, UI) is untouched by the workaround.

### 8.4 Manifest hosting
- GitHub Releases for full artifacts; **GitHub Pages** for `latest.json` + patch files (both channels), from a `releases` branch pushed by CI. Zero paid infra; SHA-256 is mandatory in the manifest per Deno's contract; Ed25519 signing adds tamper protection beyond TLS.
- Rollback is native (launcher) on Linux; on Windows the updater keeps the previous version directory and restores it if the new launch fails to report ready within 30 s.

## 9. Persistence schema (v2 deltas)

Keep v1's actual schema (streams, jobs, clips, stream_metadata, personas, settings) with these changes:
- **FK constraints** on jobs.streamId, clips.jobId/streamId (v1 declared none while PRAGMA-ing foreign_keys=ON).
- `clips.signals_json` (v1 dropped ClipSignals at persistence), `clips.rank` actually populated, `clips.composition_id` nullable.
- **New** `compositions` table (id, streamId, clipIds ordered, transitions, title, updatedAt).
- `settings` finally wired: SettingsRepository port + persistence + runtime application (gpuDevice → engine spawn env; channel → updater; engineBinaryPath → resolved binary).
- `personas` kept but honest: either the implicit-feedback loop ships (Phase 5) or the table is dropped. No third dead-schema state.

## 10. Quality gates (enforced by CI, not aspiration)

1. `deno check` + `deno test` green (detection/ fully unit-tested: signals, segmentation, baselines, ranking, endpoints are array math — no mocks needed).
2. `svelte-check` green; no `as any` in server/adapters boundary code; engine adapter validates payloads at runtime.
3. Frontend builds via `vite build` in CI on every PR.
4. Job lifecycle integration test: fake engine process scripted to emit each failure mode (exit 0 without complete, exit 1, stdout garbage, cancel mid-run, stderr flood) — each must produce the specified terminal state. These five tests are the regression suite for the v1 audit findings.
5. E2E smoke (manual or playwright-CEF later): import → process (mock engine in CI) → review → export produces a real file.
6. Security: loopback bind asserted in a startup test; no route accepts arbitrary filesystem paths without allowlist checking (vodPath validated against the storage root).

## 11. What is deliberately NOT in v2
- Real-time live processing (unchanged from v1 anti-goals).
- Social auto-publishing.
- Game-specific visual detectors.
- macOS as a gate (builds exist, but Win+Linux is the bar).
- Universal stream encoder, Kalman persona, embedding-space anomaly detection (cut; see §2).
- Multi-streamer per instance.