# SemaClip documentation audit (read-only, evidence from code + live state)

Repo: /home/livia/Projects/SemaClip @ 150226a (2026-09-18). Ground truth: 4 live releases/tags (v26.186, v26.192, v26.194, v26.196; `git ls-remote --tags`, GitHub API), 10 CI jobs across 3 workflows (`check` 2, `check-engine` 2, `release` 6), manifest at Pages ROOT (`curl .../latest.json` -> 200 version 26.196; `stable/latest.json` and `nightly/latest.json` -> 404), `releases` branch holds `latest.json`, `index.html`, 3 patch `.bin` files only.

### README.md (49, tracked)
- STATUS: PARTLY STALE
- STALE CLAIMS:
  - "the packaged app bundles its own [ffmpeg]" (README.md:15) -> ffmpeg is NOT bundled: `server/adapters/outbound/ffmpeg/tool-paths.ts:4-40` (RESOLUTION ORDER: env override, managed dir, PATH, then offer a download) and `scripts/fetch-native.sh:89` prints "ffmpeg is NOT bundled — resolved from PATH or downloaded on demand"; `scripts/build-desktop.ts:12-13` repeats it.
  - "bundled static FFmpeg" in the Stack line (README.md:42) -> same; the only bundled native tree is `native/whisper/` (`find native -maxdepth 2` -> whisper only).
  - "To build the desktop app ... (cross-compiles, so a Linux host can produce the Windows `.msi`)" (README.md:25-26) -> the `.msi` is still built but DELISTED from the landing page: `scripts/ci/landing.py:59-69` has no `.msi` branch in the live spec path and `.github/workflows/release.yml:531-543` says "The .msi is deliberately NOT listed"; the Windows download is `SemaClip-<v>-win-x64-portable.zip` (`release.yml:544-547`, live index.html contains only the zip + AppImage).
  - Example version `v26.148` (README.md:11) -> live version is 26.196 (`frontend/package.json:3`, live manifest).
- RECOMMENDATION: keep as-is structurally; trim to fix 4 sentences — drop "the packaged app bundles its own", drop "bundled static FFmpeg", replace the `.msi` build example with the portable/AppImage story, bump the example version.

### ARCHITECTURE.md (282, tracked)
- STATUS: PARTLY STALE (largest single source of wrong claims; it is the doc README points at as "functional design")
- STALE CLAIMS:
  - "Auto-updating client with a **stable / nightly channel selector** in Settings" (ARCHITECTURE.md:10) -> no channels exist: `.github/workflows/release.yml:3-10` "ONE CONTINUOUS LINE OF RELEASES. There is no stable/beta/nightly split"; `scripts/version.sh:5`; `release.yml:103-106` fails the build on any version suffix; live `stable/latest.json` and `nightly/latest.json` are 404.
  - "Both channels' manifests live side by side: `releases/stable/latest.json`, `releases/nightly/latest.json`" (ARCHITECTURE.md:227) -> manifest is `latest.json` at the Pages branch ROOT (`release.yml:563-568` pushes `dist/latest.json` -> `latest.json`; live clone of the `releases` branch has no subdirectories).
  - "`nightly`: built on every merge to `main` ... version `0.0.0-nightly.<run>`" (ARCHITECTURE.md:225) -> version is `v{yy}.{patch}` with no suffix (`scripts/version.sh:56-70`); no `nightly.yml` exists (`.github/workflows/` = check.yml, check-engine.yml, release.yml).
  - §8.2 "**nightly.yml** (merge to main) ... generate bsdiff patches from previous nightly per platform" (ARCHITECTURE.md:244) -> only `release.yml`, triggered by push to main + workflow_dispatch (`release.yml:26-41`).
  - "| Video | **FFmpeg** (bundled, per-OS binaries from BtbN builds pinned in CI) |" (ARCHITECTURE.md:27) -> not bundled; BtbN archives are the on-demand managed download only (`tool-paths.ts:56-79` ARCHIVES, `provision.ts:1-12` "the acquisition half of the 'don't bundle it' decision").
  - "| Shell | **Deno Desktop + CEF** |" (ARCHITECTURE.md:22) -> CEF was never adopted; `server/deno.json` desktop block has keys `app, release, output` and NO `backend` key, so the default OS webview is in use; `TODO.md:130-166` records CEF as an open decision and `webview-fix.ts:31-46` documents the WebKitGTK/WebView2 runtime dependencies actually in play.
  - Windows updater "lives behind `server/adapters/updater/windows-update.ts`" (ARCHITECTURE.md:253) -> that file does not exist (`find . -name "windows-update*"` -> nothing). The shipped updater is `tools/updater/{main.go,update.go,launch_windows.go}` (706+86 lines) plus `server/adapters/outbound/platform/sidecar.ts` (SIDECAR_NAME = "SemaClipUpdater.exe").
  - "`twitch-dl` pinned and bundled per-OS by release CI (binary dependency, not a runtime assumption)" (ARCHITECTURE.md:157) -> "The twitch-dl legacy path is gone: it was a /tmp venv dependency" (`server/application/use-cases/ImportStream.ts:106`); URL metadata comes from GQL (`server/adapters/outbound/vod/hls.ts:81`); `TwitchDlAdapter` survives but its only entry point `downloadInBackground` (`ImportStream.ts:308`) has no callers.
  - §3 tree names files that do not exist: `detection/signals/transcript.ts`, `detection/ranking.ts`, `detection/endpoints.ts`, `server/adapters/outbound/llm/`, `server/adapters/outbound/twitch/`, `shared/model-manifest.ts` (ARCHITECTURE.md:57-69,128) -> `find detection -name '*.ts'` returns axes/{hype,reaction}.ts, baselines.ts, chat.ts, pipeline.ts, segmentation.ts, signals/{audio,chat}.ts, types.ts, tests/*; `shared/` contains only `types.ts` (317 lines).
  - "one long-lived process per job batch with the IPC protocol below" / EngineCommand-EngineEvent over stdin (ARCHITECTURE.md:179,190-209) -> the real engine is IN-PROCESS: `server/adapters/outbound/engine/DetectionEngineAdapter.ts:1-12` ("there is no engine subprocess: stages run in-process"); the actual shapes differ — `shared/types.ts:103-125` (`start` carries `artifactDir`/`workers`; `candidate` has no `peak`; `clip` carries `id`+`justification`).
  - "Segmentation: Bayesian change-point detection on the joint feature table with hazard 1/300 s" (ARCHITECTURE.md:163) -> `detection/segmentation.ts:2-4` "mechanical regime boundaries from the composite excitement signal; Bayesian change-points stay Phase 3".
  - Chat-sentiment ONNX classifier and MiniLM-L6 embeddings (ARCHITECTURE.md:162,171) -> absent from the code; ranking lives in `detection/pipeline.ts:36` (`rank()`), not `detection/ranking.ts`.
  - §4.2 appears TWICE, nearly verbatim (ARCHITECTURE.md:95-114 and 132-151) -> pure duplication, and both copies still target "CPU-only ≤1h" which ROADMAP.md:28 records as met 6×.
  - Persistence deltas: "**New** `compositions` table", `clips.composition_id` nullable, "**FK constraints** on jobs.streamId, clips.jobId/streamId" (ARCHITECTURE.md:262-264) -> `schema.ts:28-44` clips has no `composition_id`; no `compositions` table in `schema.ts` or `migrations.ts` (tables: streams, jobs, clips, personas, settings, stream_metadata, export_presets, schema_versions); `migrations.ts` declares no FOREIGN KEY (only `db.ts:42 PRAGMA foreign_keys = ON`).
  - "no route accepts arbitrary filesystem paths without allowlist checking (vodPath validated against the storage root)" (ARCHITECTURE.md:275) -> no allowlist exists: `grep -rni allowlist server scripts detection` -> nothing; `UpdateStreamUseCase.execute` copies any `vodPath` straight into the row (`server/application/use-cases/StreamQueries.ts:155-166`).
  - "Process spawning: ... no reliance on PATH" (ARCHITECTURE.md:214) -> false for ffmpeg by design: `tool-paths.ts:21-24` puts PATH ahead of offering a download.
  - §8.2 body still says the manifest is patches-only and that ffmpeg/ffprobe are "not standalone" as current blockers (ARCHITECTURE.md:238-241) -> the manifest now also carries a `artifacts.win-x64` entry (live latest.json; `scripts/ci/manifest.py` subcommand `artifact`, `release.yml:495-512`), and the msi/blank-window resolution is delisting, not bundling.
- RECOMMENDATION: rewrite in place (not delete — README, ROADMAP, FRONTEND-REQUIREMENTS and release.yml all point at it): delete the duplicate §4.2, replace §1.2/§8.1-8.4 with the one-line release model, fix the §2 ffmpeg/CEF rows, fix §3 to the real tree, drop §6's subprocess IPC in favour of the in-process engine, and trim §9 to the real schema.

### ROADMAP.md (77, tracked)
- STATUS: PARTLY STALE
- STALE CLAIMS:
  - "nightly.yml + release.yml ... signed `latest.json`" (ROADMAP.md:57) -> one workflow (`release.yml`), no nightly.yml, manifest unsigned (`server/adapters/outbound/platform/auto-update.ts:34` `UPDATE_PUBLIC_KEY = ""`).
  - Exit gate "update from nightly→nightly+1" (ROADMAP.md:65) -> no nightly channel exists (release.yml:3-10).
  - Phase 4.6 "bundle ffmpeg/ffprobe per-OS into `native/` ... they are bare PATH lookups today" and "set `GDK_BACKEND=x11` in the Linux launcher" (ROADMAP.md:61) -> neither prescribed change is what shipped: ffmpeg resolution is PATH-first + managed download (`tool-paths.ts:18-29`) and the Linux launch env is `WEBKIT_DISABLE_DMABUF_RENDERER=1` (`scripts/build-desktop.ts:117-123`, rationale in `webview-fix.ts:31-46`).
  - Phase 4.5 "twitch-dl pinned/bundled for URL import" (ROADMAP.md:60) -> legacy path removed (`ImportStream.ts:106`).
  - Standing rule "data/testing is held out until Phase 3 exit" (ROADMAP.md:78) -> violated by the repo's own Phase 1 evidence and scripts: ROADMAP.md:28 itself cites the ironmouse slice, and `detection/scripts/ironmouse-run.ts:7` and `detection/scripts/iron-slices.ts:11` read `/home/livia/Projects/SemaClip/data/testing/ironmouse_4h/{chat.json,video.mp4}` (fixture present: 17,473 comments, 4.01 h).
  - Phase 2 items 2/3/4/7 are shipped but still listed as work: axis filters are 1–7 (`frontend/src/lib/components/KeyboardHelp.svelte:38`, axes array of 7 at `frontend/src/routes/stream/[id]/+page.svelte:339`), fonts are local (`frontend/src/app.html:6` -> `/fonts/fonts.css`, `frontend/static/fonts/`), the export sheet became the `/export` screen (`frontend/src/routes/export/+page.svelte`, 376 lines), and `?around=` pagination exists server-side (`server/adapters/inbound/http/routes.ts:540-547`) with the client plumbing at `frontend/src/lib/api/client.ts:197-203` (though `ChatView.loadAll` still requests offset 0/limit 500 — that half is genuinely open).
  - Phase 0 and Phase 1 item lists are unmarked while every item is in the tree (settings repo `server/adapters/outbound/persistence/settings-repository.ts` wired at `container.ts:155`; 5 lifecycle tests at `server/tests/job-lifecycle.test.ts:92,116,138,161,182`; real export at `server/application/use-cases/ExportClip.ts:98`).
- RECOMMENDATION: trim to the gate table + status lines: mark Phases 0/1 complete, restate Phase 2/4 as shipped-vs-open, delete the ffmpeg/GDK/twitch-dl/nightly specifics, and fix or drop the `data/testing` standing rule.

### DECISIONS.md (17, tracked)
- STATUS: PARTLY STALE (2 of 17 lines)
- STALE CLAIMS:
  - "**Python engine deleted.**" (DECISIONS.md:7) -> the Python engine still exists and is still selectable: `engine/engine.py` + `engine/semaclip/engine.py` (105 lines, header "stub implementation ... produces mock clips") are tracked, and `server/composition/container.ts:112-119` falls back to `new PythonEngineAdapter(...)` when the bundled whisper tree is missing (`server/main.ts:66-68`).
  - "external updater exe performing swap + relaunch, same pattern as Squirrel" (DECISIONS.md:13) -> the workaround shipped, but not at the path the sibling docs name; see ARCHITECTURE.md finding above (`tools/updater/`).
  - Minor: "routes.ts smuggled logic (ffmpeg waveform, chat cache) moves to services" (DECISIONS.md:16) -> the waveform route is still in routes.ts (1223 lines, `/api/streams/:id/waveform` at routes.ts:663).
- RECOMMENDATION: keep the append-only log; patch line 7 (Python engine is a fallback stub, not deleted) and line 16 (waveform still in routes.ts). No structural change.

### docs/FRONTEND-REQUIREMENTS.md (480, tracked)
- STATUS: PARTLY STALE (still the right spec; a handful of now-false current-state statements)
- STALE CLAIMS:
  - Keyboard maps list `1`–`6` axis filters (FRONTEND-REQUIREMENTS.md:185,298) -> the app ships 7 (`KeyboardHelp.svelte:38` "1–7 ... reaction"; `stream/[id]/+page.svelte:339` includes 'reaction').
  - §5 no-gating rule "must not use ... modals" / "no modals for preview" (FRONTEND-REQUIREMENTS.md:390,167) -> modals are in the shipped tree: `frontend/src/lib/components/ConfirmModal.svelte` and `DeleteConfirmModal.svelte` used by `ProjectSettings.svelte:522,530`, plus app-wide `ToolProvisionModal` (`+layout.svelte:243`). (The no-gating rule as the parent states it bans modals and overflow menus — these confirm dialogs are live code.)
  - "$7.1" cross-reference (FRONTEND-REQUIREMENTS.md:5) -> §7 has no subsections; it is §7 "Visual foundation".
  - "the app is large and self-contained" style claims are not here; but the doc's implied CEF/visual carry-over is fine — the palette it restates matches `frontend/src/app.css:5-19` exactly (#0b0b10 / #16161f / #24242f / #2e2e3a / #cc0000), so §7 is CURRENT.
  - "**Counts: P0 = 13, P1 = 12, P2 = 8**" (FRONTEND-REQUIREMENTS.md:161) -> verified: 13 distinct P0 IDs, 12 P1, 8 P2 (`grep -o "^| P[012]-[0-9]*" | sort -u`; the doubled raw row count is the §5 compliance table reusing the same IDs).
  - P1-9 NLE handoff (EDL/FCPXML/XML + SRT) and the components it names (`NleExportPanel`, `CensorList`, `TightenAction`, `feedbackStore`) do not exist (`find frontend/src -name` -> only ClipDetail, CandidateQueue) -> unbuilt spec items, correctly presented as P1, not stale claims.
- RECOMMENDATION: keep as-is; patch the two keyboard tables to 1–7, soften the absolute "must not use modals" sentence to match the confirm-dialog reality, fix the §7.1 pointer. Delete nothing.

### docs/RELEASING.md (319, tracked)
- STATUS: SUPERSEDED (nightly-centric; live CI references it 5× so it must be rewritten, not deleted)
- STALE CLAIMS:
  - "How a nightly gets cut" (RELEASING.md:3) and the whole manual-cut section -> no nightly; `./scripts/version.sh --nightly` exits 2 "unknown argument" (`scripts/version.sh:26-35`); `version.sh` also carries a dead `mode="stable"` leftover at line 36.
  - Version table "| Nightly | `v26.149-nightly.42` |" (RELEASING.md:17) and the "-nightly suffix is load-bearing" argument (RELEASING.md:46-49) -> the suffix is now forbidden by CI (`release.yml:103-106`).
  - "https://99oblivius.github.io/SemaClip/nightly/latest.json <- the nightly channel" and "stable/latest.json <- planned, not live" (RELEASING.md:57-58) -> inverted: root `latest.json` is live (200, version 26.196), both `nightly/` and `stable/` are 404.
  - Manifest example with nightly keys (RELEASING.md:75-83) and "On the first nightly there is no previous version" (RELEASING.md:97) -> live manifest is `{"version":"26.196","patches":{"26.194":{...}},"artifacts":{"win-x64":{...}}}`.
  - "`server/adapters/updater/windows-update.ts` ... is not built yet" (RELEASING.md:223) -> file does not exist; the updater IS built (`tools/updater/update.go`, 706 lines) and shipped in the portable zip, asserted by CI at `release.yml:290-293`.
  - "the Windows zip carries its own ~800MB dylib. That is the bundled whisper models, whisper binaries and static ffmpeg/ffprobe" (RELEASING.md:243-246) -> no static ffmpeg/ffprobe is bundled (`fetch-native.sh:89`, `tool-paths.ts:4-14`).
  - "`gh release create ... --prerelease`" in the manual path (RELEASING.md:149) and "the prerelease" in the CI table (RELEASING.md:301) -> `scripts/ci/publish-release.sh:50-54` creates a normal release with no `--prerelease`, and `release.yml:671-678` documents at length why the prerelease filter was a bug.
  - "runs `bspatch` for every listed patch" (RELEASING.md:303) -> `qbspatch` (`release.yml:1022-1062`).
  - "read from `SEMACLIP_UPDATE_PUBKEY`" in the Signing section (RELEASING.md:265-266) -> no such read exists; the key is the compile-time constant `UPDATE_PUBLIC_KEY` at `auto-update.ts:34`.
  - ACCURATE and worth preserving: the `yy` MSI ProductVersion bound (matches `scripts/version.sh:11-15`), the qbsdiff-vs-bsdiff memory numbers (matches `release.yml:603-649`), the rollback sentinels, and the "what is deliberately not working" section (except the ffmpeg and windows-update lines above).
- RECOMMENDATION: rewrite (trim to the version scheme + patch mechanics + rollback + CI overview + checklist, ~120 lines); remove the nightly channel, the nightly manifest path, `--nightly`, the ffmpeg-bundling sentence, and the windows-update.ts path; keep the file because `.github/workflows/release.yml:481,584,590,1045,1080` tells users to read it.

### docs/DISTRIBUTION-PLAN.md (179, tracked)
- STATUS: SUPERSEDED
- STALE CLAIMS:
  - "Status: **proposal, not yet implemented.**" (DISTRIBUTION-PLAN.md:3) -> shipped: 4 releases, live manifest and landing page, six release jobs green (GitHub API runs for 150226a).
  - "Repo is currently **local-only**: `git remote -v` is empty and `99oblivius/SemaClip` does not exist on GitHub" (DISTRIBUTION-PLAN.md:89-91) -> `git remote -v` -> https://github.com/99oblivius/SemaClip.git; public with 4 releases and 125 workflow runs.
  - Blocker 1 "ffmpeg/ffprobe are bare PATH lookups ... whisper.cpp is already handled" (DISTRIBUTION-PLAN.md:38-43) -> the resolution in code is PATH-first then managed download (`tool-paths.ts:18-29`, `provision.ts:1-20`), i.e. deliberately not the prescribed bundling.
  - Blocker 2 "Wayland: the window does not open ... `GDK_BACKEND=x11` (XWayland) opens a real window fine. The launcher/wrapper must set this." (DISTRIBUTION-PLAN.md:44-48) -> what shipped is `WEBKIT_DISABLE_DMABUF_RENDERER=1` (`build-desktop.ts:120-123`), described in `webview-fix.ts:38-46`.
  - Step 1 "Bundle ffmpeg + ffprobe per-OS under `native/ffmpeg/{linux-x64,win-x64}/`" (DISTRIBUTION-PLAN.md:54-59) -> never done and explicitly rejected (`tool-paths.ts:4-14` "WHY NOT BUNDLE").
  - Step 2 "`scripts/version.sh` ... emits `v{year}.{patch}` ... (`v2026.138` today)" (DISTRIBUTION-PLAN.md:70-72) -> `v{yy}.{patch}` (26.196), because the full year is rejected by MSI ProductVersion (`version.sh:11-25`).
  - Step 2 "App icon assets ... none exist in the repo yet" (DISTRIBUTION-PLAN.md:73-74) -> `assets/icon.ico`, `icon.png`, `icon-*.png`, `icon.svg` are all tracked.
  - Step 3 "Per-arch manifests: build `latest.json` per target under an arch-specific path" (DISTRIBUTION-PLAN.md:83-85) -> still ONE manifest describing one platform's dylib; `release.yml:801-805` still cites this step as pending (so the reference is current even though the plan text is stale).
  - "nightly.yml — same build, no tag, version `<year>.<n>-nightly`, published to a separate manifest path" (DISTRIBUTION-PLAN.md:135-136) -> no nightly.yml, no nightly manifest.
  - "Patch generation needs the classic `bsdiff` CLI ... **not installed on your machine** ... CI installs it (`apt install bsdiff`)" (DISTRIBUTION-PLAN.md:142-144) -> qbsdiff installed from crates.io with `--features cmd` (`release.yml:649`), and the verify job uses `qbspatch` (`release.yml:1022`).
  - Patches are diffed from "`libdenort.so` / `denout.so` on Linux, `denort.dll` on Windows" (DISTRIBUTION-PLAN.md:146-148) -> real asset names are `SemaClip-<v>-linux-x64-runtime.so` / `-win-x64-runtime.dll` (`release.yml:862,889`; `docs/RELEASING.md:132`).
  - "verify — ... **boot the patched binary** in CI" (DISTRIBUTION-PLAN.md:131-134) -> deliberately NOT done; `release.yml:1044-1045` and the Summary at 1078 say CI has no display and does not claim it.
  - Step 6 exit gate "update nightly→nightly+1" (DISTRIBUTION-PLAN.md:162) -> no nightly channel.
- RECOMMENDATION: merge the still-useful parts (CI cache/Deno-pin hygiene — now implemented at `release.yml:161-170`; the patches-only manifest constraint; the per-arch manifest open item) into docs/RELEASING.md, then delete this file after fixing its four inbound references (`README.md:9`, `ARCHITECTURE.md:241`, `docs/CODE-SIGNING.md:197,439`, `release.yml:805`).

### docs/CODE-SIGNING.md (496, tracked)
- STATUS: PARTLY STALE (research is sound; its "current code" statements are now wrong)
- STALE CLAIMS:
  - "the current adapter will not work as written. `server/adapters/outbound/platform/auto-update.ts:92` reads the public key from `Deno.env.get("SEMACLIP_UPDATE_PUBKEY")`" (CODE-SIGNING.md:109-111, restated at 122 and 432-433) -> the code was fixed exactly as recommended: `auto-update.ts:28-34` reads a compile-time constant `const UPDATE_PUBLIC_KEY = ""` with the comment "This MUST be a literal in the source ... a getenv() here would read undefined in production". No `SEMACLIP_UPDATE_PUBKEY` reference exists in code (`grep -rn` -> docs + release.yml comments only).
  - "`scripts/sign-manifest.ts` — signs the manifest file's verbatim bytes" (CODE-SIGNING.md:131-184) -> the shipped script is Python: `scripts/ci/sign-manifest.py` (present, self-documenting header "NOT YET EXERCISED").
  - "Add `scripts/verify-manifest.ts` (verify-only ...)" (CODE-SIGNING.md:190-195, 434) -> absent (`ls scripts/ci/` -> landing.py, manifest.py, publish-release.sh, push-pages.sh, sign-manifest.py).
  - "Windows users must therefore download a **fresh installer for every single release**" (CODE-SIGNING.md:227-233) and "Windows users re-download a full installer every release" (CODE-SIGNING.md:430-433) -> no longer true: Windows ships a self-updating portable zip with an extracted updater and launcher (`sidecar.ts` SIDECAR_NAME/LAUNCHER_NAME, `build-desktop.ts:186-204`, CI assertions `release.yml:288-293`), and the .msi is delisted (`release.yml:531-543`).
  - "the repo has no remote (`git remote -v` is empty) and no users" (CODE-SIGNING.md:300-303) -> remote exists and the repo is public with releases.
  - "**Deno's docs state Windows auto-update is not supported**" framing for the SmartScreen argument (CODE-SIGNING.md:227-233) -> still true upstream, but the delivered mitigation is not "download the installer" — it is the Go sidecar (tools/updater, Wine-verified per TODO.md:338).
- RECOMMENDATION: trim §1.3, §1.4, §1.5 and the §2/§3 statements that assert the old code/paths; keep the SmartScreen/EV/Artifact-Signing research and the "do now / defer" recommendation verbatim (it is the only place those facts are recorded). ~496 -> ~350 lines.

### docs/DOWNLOAD-PIPELINE.md (75, tracked)
- STATUS: SUPERSEDED
- STALE CLAIMS:
  - Title and premise "proxy-first progressive **HLS**" (DOWNLOAD-PIPELINE.md:1) and "New module `server/adapters/outbound/vod/hls.ts`" as the transport (DOWNLOAD-PIPELINE.md:22-24) -> the transport is a single growing fragmented MP4: `server/adapters/outbound/vod/fmp4-download.ts:1-13` (long-lived ffmpeg writing one file + `Fmp4BoxParser` index), `download-orchestrator.ts:816` "Proxy pass: ONE growing fragmented MP4 (no .ts, no twin, no remux)", `download-orchestrator.ts:760`.
  - "append `.ts` chunks to a growing file ... `.ts` streams in <video> via mime sniffing" (DOWNLOAD-PIPELINE.md:32-37) -> retired: `server/adapters/inbound/http/routes.ts:1057-1058` "Chromium can't demux raw MPEG-TS, so a .ts path is unplayable"; `.ts`/`.chunks`/.fragments twins survive only as legacy sweep targets (`download-orchestrator.ts:908-926`).
  - `downloadProgressive` (DOWNLOAD-PIPELINE.md:31) as the downloader -> imported at `download-orchestrator.ts:25` but never called; the live call sites are `downloadFmp4` (download-orchestrator.ts:478,773,827,873).
  - "no external downloader dependency for the progressive path (twitch-dl stays for metadata + simple full-file fallback)" (DOWNLOAD-PIPELINE.md:23-24) -> twitch-dl is gone from the import path (`ImportStream.ts:106`); metadata comes from GQL (`hls.ts:81`).
  - Wire shape `{"phase":"idle|proxy|hq|done|failed","parts":[{"kind":"chat|markers|proxy|hq"...}]}` (DOWNLOAD-PIPELINE.md:42-54) -> the live contract is `DownloadView` with `phase: "starting"|"idle"|"running"|"done"|"failed"` and `artifacts[]` of `ArtifactKind = "chat"|"proxy"|"video"` with `percent/etaSec/bytes/frontierSec/onDisk/path/sharedWith/error/downloadable/removable` (`server/application/view/download-view.ts:25-83`); markers are metadata, not a download row (`download-view.ts:20-22,76-79`).
  - "Import modal (advanced, opt-in) ... `Progressive download (proxy-first)` checkbox (default off)" (DOWNLOAD-PIPELINE.md:61-63) -> the Library import bar has no such checkbox; it carries `includeProxy`/`proxyHeightCap` and the comment "URL imports always use the chunked/live HLS orchestrator ... regardless of the proxy-first toggle" (`ImportStream.ts:100-104`, `frontend/src/routes/+page.svelte:31,119`).
  - "`Delete proxy` (frees the proxy; review falls back to full-res proxybing)" (DOWNLOAD-PIPELINE.md:70) -> `DELETE /api/streams/:id/proxy` exists (`routes.ts:264`) but the UI action is a trash control in ProjectSettings (`deleteProxyMutation`, ProjectSettings.svelte:207-262), and playback falls back to the VIDEO, not to proxybing.
  - "player clamps seek to the frontier while proxybing" (DOWNLOAD-PIPELINE.md:58-59) -> still accurate in spirit but the mechanism is the growing-file frontier + Range clamp (`server/adapters/inbound/http/range.ts:1-17`, `Timeline.svelte:61-88`).
- RECOMMENDATION: rewrite to "one growing fMP4 over HTTP Range" in ~40 lines, or fold it into ARCHITECTURE §5/§8 and delete. It cannot simply be deleted today because five live code comments cite it by name: `shared/types.ts:171`, `server/adapters/outbound/vod/hls.ts:4`, `download-orchestrator.ts:7`, `routes.ts:187`, `frontend/src/lib/api/client.ts:61`.

### docs/PHASE2-PLAN.md (64, tracked)
- STATUS: SUPERSEDED
- STALE CLAIMS:
  - "Current state (audited 2026-09-09)" (PHASE2-PLAN.md:6-8) -> every line is out of date: "3-entry rail (Library/Queue/Settings), no Review rail entry" (line 9) vs `+layout.svelte:100-107` (Library, Review, Processing, Compose, Export, Settings = 6); "app.html loads fonts from Google CDN" (line 18) vs `app.html:6` `/fonts/fonts.css` and `frontend/static/fonts/*`; "ExportSheet: modal" and "Missing: presets, naming template" (line 13) vs `frontend/src/routes/export/+page.svelte` with presets (line 21), crop preview (line 272), naming template + live preview (lines 72,98,338) and no ExportSheet.svelte (`find frontend/src -iname '*export*'` -> the route dir only).
  - "Types: AXES has 7 entries (reaction added in Phase 1); KeyboardHelp still says 1–6." (PHASE2-PLAN.md:16) -> KeyboardHelp now says `1–7` incl. reaction (`KeyboardHelp.svelte:38`).
  - "stream/[id]/+page.svelte is 456 lines — split into ClipDetail, CandidateQueue, CropOverlay components" (PHASE2-PLAN.md:28) -> the file is 547 lines; ClipDetail.svelte and CandidateQueue.svelte exist; CropOverlay.svelte does not.
  - Gap list items 1-8 (PHASE2-PLAN.md:22-29) are largely closed (frame-step, filters 1-7, key-light on queue rows per `CandidateQueue.svelte:15-16`, fonts, export flow, processing screen at `frontend/src/routes/stream/[id]/processing/+page.svelte`).
  - Batch C/D checkmarks (PHASE2-PLAN.md:47-54) are self-marked done with commit hashes, so the doc is a closed work log rather than a plan.
- RECOMMENDATION: delete (nothing references it: `grep -rn PHASE2-PLAN` -> no hits outside the file). If the owner wants the history, move to docs/archive/.

### docs/archive/v1/DESIGN.md (689, tracked)
- STATUS: HISTORICAL-ARCHIVE
- STALE CLAIMS: none to fix — it is explicitly archived (`git log -1 -- docs/archive/` -> 63815f7 "Archive v1 docs to docs/archive/v1: superseded by v2 architecture"). It remains factually load-bearing for the palette: its tokens (#0B0B10, #16161F, #24242F, #2E2E3A, #CC0000 at DESIGN.md:30-43) match the SHIPPED `frontend/src/app.css:5-19`; §14 anti-patterns and §11 motion catalogue are still the cited reference for the UI track (`ARCHITECTURE.md:184`, `FRONTEND-REQUIREMENTS.md:5,167,481`).
- RECOMMENDATION: keep as-is. Do NOT delete: live docs reference it — README.md:9, ARCHITECTURE.md:5, docs/FRONTEND-REQUIREMENTS.md:5 and :481 (the last names §14 of v1 DESIGN.md specifically).

### docs/archive/v1/ARCHITECTURE.md (670, tracked)
- STATUS: HISTORICAL-ARCHIVE
- STALE CLAIMS: describes the never-built system (Python/PyTorch engine, universal stream encoder, Kalman persona) — expected for an archive. Two parts are still cited as canonical: §7.5 multi-timescale baselines (`ARCHITECTURE.md:164` "the v1 §7.5 design, kept verbatim") and §8/§9 endpoints/ranking (`ARCHITECTURE.md:167-168`), which do match `detection/pipeline.ts:33-40`.
- RECOMMENDATION: keep as-is; if disk is ever a concern, the three v1 files are one deletion unit (referenced as a directory, `docs/archive/v1/`).

### docs/archive/v1/STACK.md (559, tracked)
- STATUS: HISTORICAL-ARCHIVE
- STALE CLAIMS: superseded stack (Deno Desktop + CEF, PyInstaller engine, better-sqlite3). DECISIONS.md:17 explicitly says this doc's §6/§7 protocol fork "is recognized as the cause of the v1 protocol drift and archived, not corrected" — so its being wrong is intentional. Note its "better-sqlite3 + Drizzle" (STACK.md:24) is not what shipped: `server/adapters/outbound/persistence/db.ts:1-2` uses `node:sqlite`.
- RECOMMENDATION: keep as-is (archive). Nothing live references STACK.md outside the archive note in DECISIONS.md:17.

### data/README.md (54, tracked)
- STATUS: PARTLY STALE
- STALE CLAIMS:
  - Structure block omits what is actually in `testing/` (DATA/README.md:11-14) -> `data/testing/` contains `fixtures/jfk.wav` (352 KB) and `ironmouse_4h/{chat.json,video.mp4}` (17,473 comments, 4.01 h), and `fixtures/jfk.wav` is the CI engine-E2E fixture (`server/tests/engine-e2e.test.ts:18`).
  - Chat JSON key table lists `comments, video, streamer, embeddedData` (DATA/README.md:43-48) -> the actual fixture also carries `FileInfo` and `clipper` (verified by loading `data/training/chat.json`). Comment field list is accurate (`content_offset_seconds`, `commenter`, `message`, `created_at` all present).
  - Verification: the training table's numbers check out — 110 comments, 5.8 h video (ffprobe), "~19 msg/h" (`110/(20852/3600) = 19.0`), streamer SoulCamera / Overwatch — so those are CURRENT.
  - The "Download a VOD"/"Download chat" recipes name external tools (yt-dlp, TwitchDownloaderCLI) that no longer appear anywhere in the code (`grep -rn 'yt-dlp'` only hits docs; chat now comes from the GQL fetcher `server/adapters/outbound/vod/chat-fetch.ts:1-9`) -> misleading as "how this repo gets data".
- RECOMMENDATION: trim to ~25 lines: state that fixtures are hand-placed, add `fixtures/` and `ironmouse_4h/` to the tree, note the GQL fetcher, keep the chat-JSON schema table (add FileInfo/clipper).

### data/testing/README.md (7, tracked)
- STATUS: PARTLY STALE
- STALE CLAIMS:
  - "Currently empty — add streams here after the initial training pipeline is built." (data/testing/README.md:7) -> the directory holds `fixtures/jfk.wav` and `ironmouse_4h/{chat.json,video.mp4}`, and the detection scripts read them by absolute path (`detection/scripts/ironmouse-run.ts:7`, `iron-slices.ts:11`).
  - "held-out ... must never be used during model development, calibration, or parameter tuning" (lines 3-5) -> contradicted by ROADMAP.md:28 (Phase 1 status cites the ironmouse slice) and by the scripts above; the fixtures dir is also the CI E2E input (`server/tests/engine-e2e.test.ts:18`).
- RECOMMENDATION: keep the held-out rule but fix it to match reality: state that `fixtures/jfk.wav` is a shared CI fixture and `ironmouse_4h/` has already been used for validation, so the directory is no longer a clean hold-out. Otherwise delete (7 lines, no inbound references).

### data/training/README.md (8, tracked)
- STATUS: CURRENT
- STALE CLAIMS: none found — "SoulCamera — Overwatch, 5.8h, 110 chat messages" (data/training/README.md:7) matches the real fixture (110 comments, 5.82 h via ffprobe, game Overwatch) and `data/training/chat.json`/`video.mp4` exist. It calls the data "training" for persona tuning while DECISIONS.md:9 replaced the Kalman persona with percentiles and no persona training exists in code — a wording nit, not a factual error about the data.
- RECOMMENDATION: keep as-is (optionally one line noting the data is calibration/validation input, not model training).

### frontend/README.md (42, tracked)
- STATUS: OBSOLETE
- STALE CLAIMS:
  - It is the unmodified `sv create` boilerplate: heading "# sv" (frontend/README.md:1), "If you're seeing this, you've probably already done this step. Congrats!" (:7), `npx sv create my-app` (:11) and "To recreate this project ... `npx sv@0.16.6 create --template minimal --types ts --no-install frontend`" (:18) -> the project was not built from that command and it says nothing about SemaClip; it also implies a fresh `sv` scaffold while the app is Svelte 5.56 + SvelteKit 2.63 + Tailwind 4 + adapter-static (`frontend/package.json:8-25`), and the instructions ("start a development server: npm run dev") do not describe how this app is run (the Deno server serves `frontend/build/` — `server/main.ts:89-119`).
- RECOMMENDATION: delete (or replace with 10 lines: `npm ci && npm run build`, then `cd ../server && deno task start`). Nothing references it (`grep -rn "frontend/README"` -> no hits).

### TODO.md (338, UNTRACKED — confirmed)
- STATUS: PARTLY STALE (items 1-8 done in code; 9/10 partly)
- STALE CLAIMS (each item, with what the code shows):
  - "## 1. Landing page: collapsible 'other operating systems' section" -> done: `scripts/ci/landing.py:120-125` emits `<details class="others" id="other-oss"><summary>Other operating systems</summary>` around the non-primary cards (grid + JS swap at lines 205,268).
  - "## 2. Landing page copy: plain, accurate, no feature selling" -> done: the three feature columns are gone (no `feature` block in landing.py), the meta description is the plain one-liner (landing.py:134), em-dashes are forbidden at generation (`landing.py:40-41,299-300`) and asserted in CI (`release.yml:947-950`), pre-alpha asserted (`release.yml:951-952`).
  - "## 3. Remove 'nightly' entirely; single continuous pre-alpha line" -> done: `scripts/version.sh` has no mode/suffix logic (`--nightly` exits 2); `release.yml:3-10` and `:103-106` enforce it; manifest moved to the Pages root (live 200; `nightly/latest.json` 404); releases publish without `--prerelease` (`publish-release.sh:50-54`).
  - "## 4. Windows MSI: white window and the `%LOCALAPPDATA%` path bug" -> the prescribed fix landed (runtime resolution in `server/adapters/outbound/platform/webview-fix.ts:53-80`; `scripts/build-desktop.ts:111-119` no longer writes `WEBVIEW2_USER_DATA_FOLDER`) but the fix could not work — the runtime initialises WebView2 first — and the resolution is delisting the .msi (commit 150226a, `release.yml:531-543`). Item 4's "Produce a corrected MSI and a checklist" is superseded, not pending.
  - "## 4b. Dependency question: CEF vs the OS webview" -> answered and settled: no `backend` key in `server/deno.json` desktop block, so the OS webview stays.
  - "## 5. AppImage crashes instantly: `.catch` on a non-promise" -> done: `auto-update.ts:151` calls `autoUpdate({...})` with no `.catch`, and the header at `:146-150` documents the measurement; `server/tests/auto-update.test.ts` covers the call.
  - "## 6. Remove the browser context menu, and give the window real chrome" -> done: `frontend/src/routes/+layout.svelte:68-78` suppresses contextmenu except in editable fields; title is `SemaClip {__APP_VERSION__}` (`+layout.svelte:152`, `server/main.ts:164`); frameless is an explicit opt-in (`server/main.ts:160-169`, `SEMACLIP_FRAMELESS=1`).
  - "## 7. Review preview streams from Twitch instead of local media" -> done: `resolvePlayback` now returns a playable path for a RUNNING artifact (`server/application/view/download-view.ts:141-166`) and the player never receives the VOD url (`frontend/src/lib/components/VideoPlayer.svelte:96-105` "always a LOCAL file served by the media route, never the VOD URL"); pinned by `server/tests/playback-during-download.test.ts:34-59`.
  - "## 8. Repository cleanup and single release (DONE)" -> marked done, but its numbers are stale (1 release/tag v26.186 vs 4 live releases/tags; "15 releases, 15 tags ... deleted" is history). It is a closed log entry.
  - "## 9. Patch staging end to end (open)" -> partly resolved: Linux patch generation, application and byte-identical round-trip are asserted in CI (`release.yml:730-758` generator check, `:973-1062` verify over the public URL), the manifest key model matches the live file, and the Windows half is now implemented in Go (`tools/updater/update.go` staging + `.backup` swap) and Wine-verified per item 10. What remains genuinely unverified is the on-device relaunch (`release.yml:1044-1045,1078`).
  - "## 10. Later — Windows sidecar updater: built and Wine-verified, needs a real Windows run." -> still ACCURATE as written (the updater exists); the "Code signing" bullet is still open (`UPDATE_PUBLIC_KEY = ""` at `auto-update.ts:34`).
- RECOMMENDATION: trim to items 9, 9b, 10 plus a short "done" appendix: delete headings 1, 2, 3, 4, 4b, 5, 6, 7 (and the two "Also still to do" bullets in 8 that are done — Pages single deployment and tag re-verify both hold: one deployment source `releases`, 4 tags on origin). Keep 9b, the diagnosis-trap notes, which is the only place that knowledge lives. As an untracked file it must not be relied on as a deliverable; if it should survive, track it.

### TODO:md (5, TRACKED — note the inversion)
- STATUS: OBSOLETE
- STALE CLAIMS:
  - "1. waveform generating as fragments are downloaded is poorly aligned ..." -> addressed in a different shape than described: the waveform now stops at the downloaded extent instead of stretching (`server/adapters/inbound/http/routes.ts:763-771` sends `extentSec`; `Timeline.svelte:341-360` "While a download is running, the waveform only covers the downloaded extent — drawing past it would stretch partial data across the whole timeline (the reported bug)"), and the timeline keeps absolute duration with a void past the frontier (`Timeline.svelte:61-88`). The bullet's expectation (right side growing proportionally) is not implemented.
  - "2. Pressing delete on chat doesn't work after the improvement in file naming scheme." -> fixed: `MediaActions.deleteChat` now sweeps project-named + recorded paths (`server/application/use-cases/MediaActions.ts:238-276`) with a regression test (`server/tests/delete-chat.test.ts:1-12`, added in 13ac1b4).
  - "3. Deleting a video is not causing the playback to lose the video." -> fixed: `Cache-Control: no-store` on `/api/video` (`routes.ts:1080`, commit 286c125), `deleteVideo` sweeping media+index (`MediaActions.ts:84-129`), stale-path stat checking in the media route, and the stream row's paths cleared on delete (`ImportStream.ts:300-304`).
  - "4. Downloading a file like chat doesn't cause the chat panel to be populated again." -> fixed: the panel now keys off the server view's chat artifact (`ChatView.svelte:39-59` chatSig effect, commit 286c125 "THE CHAT PANEL reacts to a chat file appearing or disappearing").
- RECOMMENDATION: delete. It is 5 lines of scratch that its own sibling TODO.md supersedes, all four bullets are resolved or superseded, and only one tracked file references anything like it (a stale path-free reference in `server/adapters/outbound/platform/webview-fix.ts:69` pointing at "TODO.md", not "TODO:md"). Being tracked while TODO.md is ignored is backwards and invites reading the wrong file.

## Cross-cutting flags
- Retired .ts/twin/hls.js transport described as current: docs/DOWNLOAD-PIPELINE.md only (plus stale comments inside the code it describes). hls.js is still a dependency in `frontend/package.json:24` and a dead client helper `apiClient.hlsPlaylistUrl` exists (`frontend/src/lib/api/client.ts:190-191`, no callers) though the server still serves `/api/streams/:id/hls.m3u8` and `/hls-chunk/:track/:index` (`routes.ts:1132,1162`) — a code-cleanup item, not a doc one.
- Nightly channels / nightly manifest path: docs/RELEASING.md (worst, 23 hits incl. the manifest URL), ARCHITECTURE.md §8.1/§8.2/§8.3, ROADMAP.md Phase 4, docs/DISTRIBUTION-PLAN.md, TODO.md item 3 (describing its own removal).
- ffmpeg bundled: README.md:15 and :42, ARCHITECTURE.md:27, docs/RELEASING.md:243-246. Code says the opposite in three places.
- .msi as the primary Windows download: README.md:25-26, docs/RELEASING.md:224-232, docs/DISTRIBUTION-PLAN.md:169-170. Live landing page offers only the portable zip + AppImage.
- docs/archive/v1: still referenced by three live docs (README.md:9, ARCHITECTURE.md:5, docs/FRONTEND-REQUIREMENTS.md:5,481), so deleting the directory would create dangling references.
