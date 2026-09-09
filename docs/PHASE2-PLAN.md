# Phase 2 — Frontend Re-development: Build Plan

> Working plan for the Phase 2 implementation. Source spec: docs/FRONTEND-REQUIREMENTS.md.
> Exit gate (ROADMAP §Phase 2): frame-step, filters, key-light, export flow demonstrable; no fabricated UI data; svelte-check green.

## Current state (audited 2026-09-09)

What exists and works (~3.9k LOC):
- Layout: 3-entry rail (Library/Queue/Settings), no Review rail entry. Spec wants 6 (Library/Review/Processing/Compose/Export/Settings).
- Library (+page.svelte): dropzone + URL + path import, stream rows. No channel grouping, no clip counts, no review-progress badge (P0-1 partial).
- Review (stream/[id]): audit loop core (A/D/J/K/U keys, axis filters 1-6, undo toast), VideoPlayer (frame-step via 1/30s tolerance — the H7 dead-zone fix is in), Timeline (waveform SSE + chat density + clip marks, zoom/pan, endpoint drag), RightPanel (clips list + chat). Missing: markers layer, I/O endpoint keys, crop overlay, S snooze, Q queue filter, in/out in detail panel (P0-4, P0-5 partial, P0-6, P0-9 missing).
- ChatView: follow mode, search, drag-scrub, 500-msg window (P0 pagination OK).
- ExportSheet: modal with format/aspect/crop/captions. Spec violation: it's a MODAL hiding video (§5 no-gating rule) — must become inline panel. Missing: presets, naming template, SRT toggle, metadata draft (P0-7, P1-2, P1-3).
- Processing: phase list + live findings + cancel (P0-13 mostly done; candidates list shape differs from Review queue rows).
- Settings: engine/export/captions. Missing: proxy default, naming template, keyboard remap, updates section (P4).
- Types: AXES has 7 entries (reaction added in Phase 1); KeyboardHelp still says 1–6.
- ws.ts: reconnect w/ backoff works.
- app.html loads fonts from Google CDN — spec §7 wants fonts bundled locally (P0 offline).

## Gap list vs spec (by ROADMAP order)

1. Seek model rewrite (ROADMAP 2.1): mostly done in Phase 0 (1/30s tolerance). Remaining: verify frame-step at 60fps sources (1/60), HH:MM:SS:FF readout at max zoom (P0-5).
2. Chat: server ?around= pagination exists; ChatView still loads [0,500) — switch to around-window loading (ROADMAP 2.2).
3. Axis filters: keys 1-6 exist; add `reaction` to filter set + KeyboardHelp update (ROADMAP 2.3).
4. Key-light on rebuilt timeline: keyLight action exists; Timeline doesn't use it. Add to queue rows.
5. Export sheet completion (ROADMAP 2.4): presets (P0-7), naming template w/ tokens (P1-2), crop preview (P0-9), SRT toggle, inline-not-modal redesign (P0-8 partial).
6. Processing screen (ROADMAP 2.5): live findings → same row shape as Review queue; job_status/download_progress consumers (P0-3).
7. God-component split (ROADMAP 2.6): stream/[id]/+page.svelte is 456 lines — split into ClipDetail, CandidateQueue, CropOverlay components. Esc → SPA nav done.
8. Fonts bundled (ROADMAP 2.7): download woff2 → static/fonts, drop Google CDN links.

## Implementation order (dependency-driven)

Batch A — no-backend-needed UI work:
- A1: fonts bundled locally (app.html + static/fonts)
- A2: KeyboardHelp refresh (7 axes incl reaction, I/O, S, Q)
- A3: Reaction axis in filters + RightPanel
- A4: Review detail panel gains In/Out rows + I/O key handling (P0-5 keys exist for frame-step; add endpoint setting)
- A5: key-light on candidate queue rows

Batch B — backend endpoints needed:
- B1: GET /api/streams/:id/markers + marker ingestion (P0-6/P1-8 v1: Twitch markers via GQL, no auth) ✅ 397f9b4 — chapters via persisted query VideoPlayer_ChapterSelectButtonVideo (21 live markers verified); user `/marker` STREAM_MARKERs need OAuth, deferred
- B2: GET /api/streams/:id/transcript (serve transcript.srt parsed) for caption edit (P0-8) ✅ fc5f41e — + PATCH applies edits to disk
- B3: PATCH /api/clips/:id (persist endpoint adjustments + review state — P0-11) ✅ 45fd019
- B4: GET /api/streams/:id/proxy + proxy generation during job (P0-10) ✅ bc8bae0 — proxy generated post-detection; video route prefers proxy.mp4, ?src=full override

Batch C — export rebuild (P0-7/8/9, P1-2/3):
- C1: presets table in DB + preset CRUD endpoints + PresetPicker ✅ a919be8
- C2: ExportSheet → inline panel w/ crop preview + naming template + live filename preview ✅ 8890fae — became a first-class /export screen (modals are banned by §5); naming template feeds the export filename (b6a941f)
- C3: caption editor (line-level text edit, word timings kept, P0-8) ✅ fc5f41e + 40c990a

Batch D — structure:
- D1: split Review page into components
- D2: Compose screen shell (rail entry + empty state; real editor is P1-1, Phase 5)
- D3: Library channel grouping + clip counts + review-progress badge (P0-1, needs B3)

## Verification per batch
- A: svelte-check + build + manual: fonts load offline (grep app.html for no googleapis), keyboard map correct
- B: curl each endpoint live; unit test markers parse
- C: export a real clip with preset + burned captions via API on the ironmouse slice
- D: svelte-check green; each screen reachable; Esc flow works

## Honest scope notes
- P1-4/5/6/7 (thumbnails, memes, SFX, tracking) are Phase 2+ — build the rail slots but not the features.
- P2 all deferred per spec.
- The Review page split (D1) is refactor-only; behavior must not change (test: same keys work after).