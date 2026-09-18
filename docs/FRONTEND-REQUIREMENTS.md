# SemaClip — Frontend Requirements (Phase 2)

> What an avid, professional VOD clipper — someone who turns Twitch streams into YouTube Shorts, TikToks, and highlight compilations every day, often for several channels — needs from SemaClip's review and editing UI. This document is the feature and workflow basis for the Phase 2 frontend re-development (ROADMAP.md). It is self-contained: an implementer who has never read this conversation can build from it.
>
> **Carry-over from v1:** the visual foundation is fixed by `docs/archive/v1/DESIGN.md` — "Carbon & Blood" palette (foundation `#0B0B10`, accent `#CC0000` used only for playhead / selected clip / primary CTA / active filter), Space Grotesk / Inter / JetBrains Mono typography, custom SVG iconography, GSAP-driven motion with `prefers-reduced-motion` support, and the *signal terrain* timeline (canvas waveform + chat-density area + SVG clip marks + HTML playhead). This document specifies **features, screens, and interaction** — not visual style. Where a screen spec below references tokens (`--color-surface`, `--color-accent`, etc.), they are the v1 tokens, restated in §7.
>
> **Hard rule (from the product owner):** **NO UI GATING.** Every tool visible and reachable. Power lives in keyboard shortcuts and good defaults, not hidden menus. §8 is a per-feature compliance audit.

---

## 1. Research method and source register

Research performed 2026-09-09 by direct page extraction (search backends were unavailable in the research environment; sources were located via a search-engine snapshot and then fetched in full). Claims below are attributed to the source they came from. Statements marked **[Inference]** are SemaClip's conclusions from that evidence, not claims the source makes. No user quotes are invented; quotes are verbatim from cited pages.

**Access limitation, stated honestly:** Reddit thread bodies (r/Twitch, r/NewTubers, r/youtubers, r/LivestreamFail) could not be retrieved — reddit.com returns HTTP 403 to unauthenticated fetches from this environment and all public mirrors are bot-walled. Reddit thread *titles* surfaced via search are listed in §9 as community-signal pointers only; no claim in this document rests on an unread thread body. Vendor pages (tool marketing) are used for feature inventories and pricing/gating facts, and read critically: what a vendor builds reveals what users asked for; what their review pages admit as "cons" is complaint evidence.

| ID | Source | Used for |
|---|---|---|
| S1 | Eklipse.gg — "How do livestream editors edit so fast? The real workflow behind viral clips" — https://blog.eklipse.gg/streaming-tips/how-livestream-editors-edit-so-fast.html | Per-stage editing time costs, 5-step professional workflow, markers, AI recall vs editorial judgment, batch-by-stage, template presets |
| S2 | Eklipse.gg — "Video repurposing: how gaming streamers turn one stream into 10+ videos" — https://blog.eklipse.gg/streaming-tips/video-repurposing.html | VOD retention deadlines (Twitch 7/14/60 days; Kick 7–30), repurpose-vs-repost, 9:16 framing rationale |
| S3 | Eklipse.gg — "How to become a clipper in 2026" — https://blog.eklipse.gg/streaming-tips/beginner-guide/how-to-become-a-clipper.html | Clipper economics, volume-first posting, reframing+captions drive reach |
| S4 | Eklipse.gg — "Eklipse.gg Review Compilation (2026): What Do Streamers Actually Say?" — https://blog.eklipse.gg/featured/eklipse-gg-review.html | Verified-review pros/cons: praise (voice command, detection accuracy in FPS/BR, time savings, usable free tier) and complaints (support, peak-hour queues on free tier, watermark at 720p, weak on non-action genres) |
| S5 | Recapo.ai — "How to Clip a Twitch VOD Into Highlights and Shorts" — https://recapo.ai/blog/how-to-clip-a-twitch-vod/ | Two-stage native workflow (Clips vs Highlights vs Shorts), native Highlighter's limits, trim-tight guidance |
| S6 | ClipFinder — "How to Clip Twitch VODs Without Editing Software (5 Free Methods)" — https://clipfinder.org/blog/clip-twitch-vods-without-editing-software | Traditional manual workflow cost, Twitch clip limits (60 s, Alt+X), yt-dlp section download |
| S7 | FragCut — "How to Turn Twitch VODs Into Clips" — https://fragcut.io/blog/how-to-turn-twitch-vods-into-clips | Shortlist-first workflow, review checklist, file-naming convention, platform-specific pacing |
| S8 | Boltis — "Clip Twitch Highlights Without Scrubbing VODs" — https://boltis.app/blog/how-to-clip-twitch-highlights-without-scrubbing-vods/ | Finding-is-the-bottleneck thesis, hotkey capture, minimal edit recipe (trim, hook, captions, export) |
| S9 | AutoClip — "Twitch Clip Maker" + Research hub — https://autoclip.dev/tools/twitch-clip-maker , https://autoclip.dev/research | Multi-channel monitoring tiers (1/3/10 channels), burned-in captions by default, ~5-min turnaround, credit billing, viral-signal study (scene cuts + energy peaks = 86% of signal) |
| S10 | StreamLadder — "Clip Editor" — https://streamladder.com/clip-editor | Browser clip editor feature set: auto-captions 90+ languages, auto-censor, silence removal, stickers/GIF/emote overlays, facecam+gameplay smart layouts, saveable templates |
| S11 | OpusClip — https://www.opus.pro/ | Feature surface: AI Reframe, animated captions, brand templates, AI B-roll, social scheduler, thumbnail generator, **Export to XML (Premiere/DaVinci handoff)**, team workspace |
| S12 | Medal — https://medal.tv/ | Local recorder feature set: hotkey capture, custom clip length, multi-track audio (game/mic/Discord), per-game event detection, free core |
| S13 | Eklipse — homepage — https://eklipse.gg/ | Full product surface incl. Studio, AI-Edit (memes), Content Publisher, Voice Command, Ultra 1440p, free-tier watermark |
| S14 | GitHub topic `twitch-clipper` — https://github.com/topics/twitch-clipper | DIY/local-first tools exist for exactly this job (e.g. `pl12133/node-twitch-clipper`, `wAIfu-DEV/VodAutoClipper`, `bendawg2010/Auto-clipper` with YOLO + voice triggers, `JonasBuffington/auto-clipper-ML` chat-behavior detection) |
| S15 | Eklipse — homepage marketing copy, product naming | "AI-Edit — instantly adds memes to gaming clips" (meme/overlay cards are an expected feature class) |
| S16 | Wisecut — https://www.wisecut.video/ | Autopilot/scheduler positioning; storyboard-only editing as the *absence* pros complain about (see §3.4) |
| S17 | AssistantGG — "VOD from URL" — https://www.assistant.gg/en/create-clips-from-any-twitch-or-youtube-vod-with-vod-from-url/ | VOD-URL import + gallery review flow, FFmpeg+AI local pipeline, pause/cancel |
| S18 | Reddit community threads (titles via search index; bodies not retrievable — see access limitation above): r/Twitch "Is there any better option? -> eklipse.gg" (id `180im4g`), r/Twitch "Creating Highlights — Best way for someone working full time" (id `1ayhuu6`), r/Twitch "Questions about highlighting / clipping streams" (id `171lv74`), r/Eklipsegg "Eklipse.GG is ABSOLUTE TRASH and they are THEIVES" (id `15kzx5o`) | Community-signal pointers only; no claims sourced to thread bodies |
| S19 | Twitch mechanics as reported by S1/S5/S6 (Clips API retroactive capture ≈ 85 s before / 5 s after; Alt+X = previous 30 s; clips 5–60 s; VOD retention by account type; `/marker` chat command with 140-char description; markers don't work on Premieres/Reruns) | Ingestion and marker-design constraints |

---

## 2. Workflow analysis: how a professional clipper actually works

### 2.1 Who this document is for

Two personas appear consistently across the sources; SemaClip's Phase 2 frontend must serve both:

1. **The streamer-editor.** Reviews and cuts their own VODs, daily. Time budget: hours, not days. Sources describe people working full-time who must squeeze clipping into the evening (S18 thread titles are evidence of the question recurring; S1's whole premise is that streamers lose entire afternoons to scrubbing).
2. **The professional clip channel operator.** Clips other people's streams, possibly many channels at once, posting daily across TikTok / Shorts / Reels / X (S3, S9). AutoClip sells multi-channel monitoring in tiers of 1/3/10 channels (S9) — evidence that operating across a *roster of channels* is a real, priced job. **[Inference]** A tool for this persona is judged on throughput per hour and consistency across channels, not on any single clip's polish.

Both personas share the same core loop: **shortlist → judge → trim → format → export → post**, repeated many times per VOD.

### 2.2 The end-to-end workflow (as described by the sources)

**Stage 0 — Capture/ingest.** Sources converge on three ingest paths: (a) native Twitch clips (max ~60 s; Alt+X captures the previous 30 s; the Clips API retroactively grabs ≈ 85 s before / 5 s after the call — S19), (b) stream markers (`/marker` with up to 140 characters of description; editors and mods can place them; Stream Deck hotkeys are the low-friction version — S1), (c) full VOD by URL or file, downloaded because retention is short — Twitch 7 days (most channels) / 14 (Affiliates) / 60 (Partners, Turbo, Prime), Kick 7–30 days (S2). "Do not wait until the deletion date to start clipping" (S7). SemaClip's URL-import design (paste VOD URL → auto-download video + chat) matches the expectation set by AssistantGG's "VOD from URL" (S17) and OpusClip's link-input flow (S11).

**Stage 1 — Shortlist, not a viewing session.** The single most repeated finding in the research: **finding the moment is the bottleneck, not editing.** "You go live for 4–8 hours, something funny or crazy happens, and you think: 'I'll clip that later.' You never do." and "Scrubbing through 4–8 hour VODs kills consistency" (S8). Eklipse's editorial guide is explicit about the economics:

| Stage | Cost | Scales with stream length? |
|---|---|---|
| Reviewing footage | 1–2× runtime at real attention | Yes |
| Trimming and pacing a clip | 5–15 min per clip | No |
| Captions + vertical reframe | 2–10 min per clip | No |
| Uploading and writing copy | 2–5 min per clip | No |

(S1.) Four of five stages are priced *per clip*; only review is priced *per stream-hour*. Hence the design rule SemaClip's Review screen already encodes: the tool's job is to compress review into a ranked shortlist so that "forty candidates at roughly eight seconds each is under six minutes of decision-making, against four hours of scrubbing for the same coverage" (S1). The same guide stresses the AI is a **recall** tool: "a detection pass surfaces more than you'll use, and some of what it surfaces is noise. That's the correct behaviour for a recall tool." **[Inference]** SemaClip's six-axis detector should over-generate candidates and make rejection nearly free — precision comes from the human, not the model.

**Stage 2 — Judge like an editor.** The FragCut review checklist for a publishable clip: "clear setup, quick payoff, readable gameplay, and no dead air" (S7). Boltis: the clip that hit 1M+ views was "a funny moment clipped live, trimmed down to ~10–20 seconds, basic captions, clear hook in the first 1–2 seconds… No over-editing. The moment carries the content" (S8). **[Inference]** The Review screen must make the *hook* — the first 1–2 seconds — trivially inspectable: play-from-start is the default audition, not play-from-peak.

**Stage 3 — Format: vertical is mandatory, and a center crop is a failure.** "A straight centre crop on gameplay throws away the killfeed, the minimap and usually the crosshair, which are the elements that make a clip legible to somebody who wasn't there" (S1). Recapo: "a raw 16:9 gameplay clip almost never lands on a vertical feed without reframing and captions… Trying to skip the second stage — posting a landscape gameplay clip straight to a vertical feed — is the single most common reason Twitch-to-TikTok attempts flop" (S5). Captions are "non-negotiable on short-form, since a large share of viewers watch muted" (S1); AutoClip ships "9:16 with word-synced captions already rendered into the file, so a gaming clip reads fine with the sound off" as the *default* output (S9). Facecam handling is a solved-pattern expectation: StreamLadder sells "smart layouts — facecam and gameplay layout templates designed for vertical content" (S10); Twitch's own clip editor offers a split view keeping gameplay and camera in one vertical frame (S1). **[Inference]** SemaClip's crop step needs named layout presets (gameplay-only, cam-top, cam-bottom, cam-picture-in-frame) plus draggable crop, not a single smart-crop toggle.

**Stage 4 — Batch and schedule.** "Batch it. Finish four to six clips in one session, queue them, and let them go out across the week" (S1). FragCut's checklist demands "a naming system: save files with date, game, moment, and destination, such as `2026-07-09-valorant-1v3-clutch-shorts.mp4`" (S7). Eklipse's recommended discipline: "Batch by stage, not by clip. Trim four clips, then caption four clips, then queue four clips. Switching tools per clip is where the minutes disappear" and "Build your caption and template preset once. Rebuilding text styles per clip is unpaid work you've already done" (S1). **[Inference]** SemaClip needs per-platform export presets and a filename template with tokens (date, channel, axis, timestamp, slug) as P0, and batch export as one action.

**Stage 5 — Publish.** Posting is "a separate chore" that breaks otherwise-fast pipelines (S1). Vendors sell schedulers for exactly this (Eklipse Content Publisher to TikTok/Shorts/Reels/Facebook — S13; OpusClip social scheduler — S11; Wisecut Autopilot — S16). **[Inference]** SemaClip stays export-local per the existing architecture decision (social auto-publishing is out of scope); the frontend must still *prepare* for publishing — correct filename, platform-targeted metadata, copy-to-clipboard of title/description — without becoming a scheduler.

### 2.3 Per-VOD time expectations (synthesis)

For one 4–6 hour VOD producing 6–12 published clips:

- **Manual baseline** (download several GB → scrub in Premiere/Resolve → crop → caption → export): "a full afternoon gone for maybe 3–5 clips" (S6).
- **Shortlist-first workflow**: ~6 minutes to reject a 40-candidate list; 5–15 min trim + 2–10 min caption/reframe + 2–5 min copy per kept clip (S1). **[Inference]** ≈ 45–90 min per VOD for 6–10 clips, of which the tool controls the first stage entirely and compresses the rest with presets.
- **Auto-clipper turnaround** for the machine pass: "a typical video comes back in about 5 minutes" for AutoClip (S9); SemaClip's own budget is CPU ≤ 1 h for a 5.8 h VOD (ROADMAP Phase 1 gate) — the Processing screen must be designed around *minutes-to-hours* of waiting and must let work start before the pipeline finishes (live findings, v1 DESIGN §8).

### 2.4 Friction points in existing tools (complaint evidence)

| Complaint | Evidence |
|---|---|
| Watermarks on free exports, resolution caps (720p), paid queues during peak hours | Eklipse's own review compilation lists "Free-tier processing queues during peak hours" and "Free plan exports carry a watermark at 720p" among top criticisms (S4, S13) |
| Detection misses: strong on FPS/battle-royale, weak on non-action genres; speech-transcription-based editors are effectively blind to silent gameplay ("A silent 1v3 with no commentary produces no transcript to score, so it's effectively invisible to them") | S4 (accuracy drops for non-action genres), S1 (transcription blind spot) |
| False positives / noise from auto-clippers — expected and resented when the tool *doesn't* let you reject fast: "an AI first pass exists to raise recall, not to hand you finished videos" | S1; AutoClip admits weakness: "It is weakest on quiet, low-variance stretches" (S9) |
| Center-crop framing failures: killfeed/minimap/crosshair lost; character out of frame | S1, S2 |
| Caption errors and per-clip style rebuilding; captions are mandatory ("non-negotiable… a large share of viewers watch muted") | S1; caption automation is the core pitch of StreamLadder (90+ languages) and OpusClip (S10, S11) |
| Export friction: raw clips "need editing elsewhere" (Twitch native: 60 s cap, no captions, no vertical) | S6, S5 |
| Cloud-only processing, no local/offline path | **[Inference from evidence]** the existence of multiple DIY local tools (GitHub `twitch-clipper` topic: "processamento 100% na máquina do usuário" — S14) and Medal's local-first recording pitch (S12) shows demand for on-device processing; cloud tools don't offer it. SemaClip is local by design — surface it as a feature. |
| Posting friction: clips made but never posted; posting is a separate chore | S1, S8 |
| Subscription/watermark gates as a category of resentment | S4 (watermark complaint), S18 thread title "Eklipse.GG is ABSOLUTE TRASH and they are THEIVES" (title-level signal only) |

### 2.5 What professional clippers do **not** want

Grounded in the sources; where a source only implies, it is marked.

- **No subscription nags or watermarks.** The free-tier watermark and peak-hour queue are among the most-cited Eklipse complaints (S4). **[Inference]** A local tool with no per-clip costs has a structural advantage here — never imitate the nag pattern.
- **No cloud requirement.** **[Inference from S14 + S12]** Local processing (Medal's "runs in the background… zero lag" recorder, OSS VOD clippers) is prized; SemaClip must keep all processing on-device and say so in the UI.
- **No forced workflow.** Wisecut's "storyboard editing, no timeline required" (S16) is positioned as a feature for non-editors; professional editors still open Premiere/Resolve for polish (S1). **[Inference]** A professional wants the timeline *always present*; assistive storyboards are acceptable only as an additional view, never a replacement.
- **No AI gimmicks in the editing path.** OpusClip's AI B-roll and voice-over (S11) target talking-head/marketing video; gaming clippers' complaints center on detection accuracy and framing, not on wanting more generated content. **[Inference]** AI is welcome where it is mechanical labor (captions, reframe tracking, candidate ranking) and unwelcome where it makes creative decisions ("AI decides where to look, the editor decides what to keep" — S1).
- **No hidden power.** Streamers praise tools they can operate without digging: voice command, Stream Deck hotkeys, `Alt+X`, `/marker` (S1, S19). The product owner's no-gating rule is the formalization of this.

---

## 3. Prioritized feature inventory

P0 = must-have for a professional to switch to SemaClip. P1 = strong differentiators (build after P0; several are already planned in ROADMAP Phases 2–5). P2 = nice-to-have, deferred. Every feature is mapped to its screen(s) and component(s). "Screen" names below are specified in §4.

### P0 — must-have

| ID | Feature | Why (source) | Screen / Component |
|---|---|---|---|
| P0-1 | **Multi-VOD, multi-channel Library.** All imported VODs as a sortable list grouped/filterable by channel; channel name is a first-class column; per-VOD status (queued/processing/done) and per-axis clip counts at a glance. | Clip-channel operators run rosters of channels (S9: 1/3/10-channel tiers); v1 DESIGN §6 already has the list — extend with channel grouping. | Library · `StreamCard`, `ChannelFilter` |
| P0-2 | **URL import + local file import + auto chat fetch.** Paste Twitch VOD URL → metadata fetch → video download → chat download, all cancellable with progress; or drop a local VOD (and optionally a chat JSON). | Standard expectation (S17 "VOD from URL", S11 link input); retention deadline makes immediate import urgent (S2). | Library · `ImportBar` |
| P0-3 | **Processing queue** with reorder, cancel, and per-stage honest progress; multiple VODs process sequentially while you review an earlier one. | "Batch it" (S1); queue/cancel honesty is ROADMAP Phase 0/2 scope. | Library + Processing · `JobQueue` |
| P0-4 | **Ranked candidate audit loop.** Open VOD → top candidate loaded, paused at peak; one key to play-from-start; J/K next/prev; D discard (recoverable); A accept. Rejection costs ~2 seconds per candidate (S1). | Review · `ClipQueue`, `ClipRow`, `ClipDetail` |
| P0-5 | **Frame-accurate trimming.** Zoom to frame level, `,`/`.` frame-step, draggable in/out handles snapping to frames, `HH:MM:SS:FF` readout at max zoom. | Trim is 5–15 min/clip — the largest per-clip cost; frame precision is the editor's baseline (S1; H7 carry-over). | Review · `Timeline`, `VideoPlayer` |
| P0-6 | **Signal terrain timeline with markers layer.** Waveform + chat density + clip marks (v1 signature) **plus an external-markers layer**: stream markers, mod timestamps, and viewer clip hotspots rendered as hairline flags you can click to jump. | Markers are "the backbone" of pro workflows (S1); a marker visible in the timeline is free shortlist evidence (S19). | Review · `Timeline` (new layer) |
| P0-7 | **Export presets per platform.** Named presets (e.g. `TikTok 9:16 H.264 1080p`, `Shorts 9:16 VP9`, `16:9 compilación`, `1:1`) covering aspect, codec (H.264/H.265/VP9), resolution, fps, and caption on/off; user-creatable; one applied by default. | "Build your caption and template preset once" (S1); platform-specific pacing/aspect is standard guidance (S7). | Export · `PresetPicker` |
| P0-8 | **Caption burn-in with editable text.** Burned-in captions from the pipeline transcript, **word-synced**, with per-preset style (font/size/color/position/background), and an editable caption track — the reviewer can fix a mis-transcribed word before export. | Default-output expectation (S9); caption fixes without round-tripping to another editor is the differentiator (S10). | Review + Export · `CaptionTrack`, `CaptionStyleEditor` |
| P0-9 | **Crop modes with live preview + manual facecam handling.** 16:9 / 9:16 / 1:1 with live crop preview; draggable crop window; named vertical layout presets (gameplay-only, cam-top, cam-bottom, cam-in-frame PiP) — the machine may propose a crop, the human always sees and can drag it. | Center-crop failure is a top complaint (S1); facecam+gameplay layouts are table stakes in vertical editors (S10, S1 Twitch split view). | Review + Export · `CropPreview` |
| P0-10 | **Proxy editing for huge VODs.** Local proxies (e.g. 960×540 H.264, generated during processing) are the default scrub/edit media; full-res is used only at export. Proxy status visible; toggle per session. | A 5.9 GB / 5.8 h VOD is SemaClip's own training fixture (ROADMAP Phase 1); scrubbing several GB files in-browser tools is a known pain (S6 "download the entire VOD (several GB)… scrub through hours"). | Processing + Review · proxy flag in `JobConfig`, `VideoPlayer` |
| P0-11 | **Project persistence.** Every decision (accepted, rejected, adjusted endpoints, caption edits, applied preset) persists to the local DB and survives restart; reopening a VOD restores exact review state including scroll position in the queue. | The audit loop spans sessions for multi-hour VODs; losing review state is losing paid time. **[Inference — no single source, but implied by every "review over days" workflow]** | All screens · `reviewStore` |
| P0-12 | **Undo/redo** for destructive edits (endpoint changes, caption edits, discards, crop moves) with a visible history stack in Review. | Editors treat undo as a physical safety net (baseline NLE expectation — S1 "Professional stream editors still open Premiere Pro, DaVinci Resolve or CapCut"). | Review · `historyStore` |
| P0-13 | **Honest job lifecycle.** Real processing/export progress, cancellable at any stage, errors shown with message + stderr detail, no fake success — plus **live findings** so candidates appear while processing continues. | ROADMAP Phase 0/2 exit gates; live findings keep the 6-minute reject pass possible during processing (S1, v1 §8). | Processing + toasts · `ProcessingPipeline` |

### P1 — strong differentiators

| ID | Feature | Why (source) | Screen / Component |
|---|---|---|---|
| P1-1 | **Compose/Reel editor.** Multi-clip stitched timeline (reorder, per-clip trim, hard cuts + a small transition set), one render pass, per-segment layout override. | "Multi-segment stitching for 'best of stream' compilations" is native-Twitch behavior clippers rely on (S5); highlight compilations are a core deliverable. | Compose/Reel · `ReelTimeline`, `ReelPlayer` |
| P1-2 | **Batch export with naming convention.** Export N clips in one pass; filename template with tokens `{date} {channel} {game} {axis} {timestamp} {platform}`; default template matches the community convention `2026-07-09-valorant-1v3-clutch-shorts.mp4` (S7); post-export manifest (paths + metadata). | S1 (batch by stage), S7 (naming system as checklist item). | Export · `BatchExportPanel` |
| P1-3 | **Title/description/tag generation — editable, per clip.** Draft generated from the clip's justification + transcript; always editable inline; copy-to-clipboard; per-platform character counters. | "Uploading and writing copy 2–5 min per clip" is a priced stage (S1); OpusClip ships it (S11). Generation must be a draft, never auto-posted. | Review + Export · `MetadataDraft` |
| P1-4 | **Thumbnail / cover-frame generation.** Frame scrubber on the clip to pick a cover; optional 2–3 generated candidates (peak frames); exports as image with the clip. | Recapo lists "no cover frame" among what native tools lack (S5); OpusClip sells a thumbnail generator (S11). | Review + Export · `CoverPicker` |
| P1-5 | **Meme/overlay text cards.** Draggable full-frame or lower-third text cards with a small preset set (reaction lines, "WAIT FOR IT"-class stingers), keyframable opacity/scale, Twitch-emote image support. | "AI-Edit — instantly adds memes to gaming clips" is Eklipse's headline premium feature (S13, S15); StreamLadder ships stickers/GIFs/emote overlays (S10). | Review (Compose-lite) + Compose/Reel · `OverlayCard` |
| P1-6 | **Sound effects + music with ducking.** Small bundled SFX library (airhorn-class meme sounds, whoosh/pop transition stingers) and an optional music bed with automatic dialogue ducking; audio stays multi-track until export. | StreamLadder: "stickers, GIFs and sound effects" + music sync (S10); Medal treats game/mic/Discord as separate tracks (S12). | Review + Compose/Reel · `AudioBed`, `SFXLibrary` |
| P1-7 | **Facecam crop tracking with manual override.** Auto-tracks the facecam region in 9:16 crops; manual override by nudging the crop window at any time (keyframe when the cam moves). Tracking is a *proposal* — one keystroke to detach and hand-position. | "Vertical reframing at volume… is mechanical work" suited to AI, but "the editor decides what to keep" (S1); AI Reframe is OpusClip's updated flagship (S11). | Review + Export · `CropPreview` (tracking mode) |
| P1-8 | **Marker ingestion.** Import Twitch stream markers + mod/viewer timestamp lists (and Boltis-style hotkey clip lists) as a timeline layer and queue candidates at those times; `/marker` 140-char descriptions shown as tooltips. | Markers + mod timestamps are the low-cost pro shortlist (S1, S19). | Library + Review · `Timeline` markers layer |
| P1-9 | **NLE handoff export.** EDL / FCPXML / Premiere-compatible XML + SRT sidecar per clip, so a pro can finish in Resolve/Premiere without re-transcribing. | OpusClip's "Export to XML — edit in Adobe Premiere Pro or DaVinci Resolve" is a shipped, marketed feature (S11); pros keep an NLE in the loop (S1). | Export · `NleExportPanel` |
| P1-10 | **Silence / dead-air tightening.** One-key "tighten" that cuts silent gaps inside a clip, with a visible before/after duration and full undo. | "Remove silences — AI detects silences and slow moments and cuts them with one click" (S10); "cut the dead seconds before the action" (S1). | Review · `TightenAction` |
| P1-11 | **Auto-censor bleeping.** Optional profanity bleep (mute or duck + optional caption masking) using the transcript, with a reviewable list of flagged words per clip. | StreamLadder: "Automatically detects and bleeps swear words so your clips stay TikTok-safe" (S10). | Review + Export · `CensorList` |
| P1-12 | **Channel-tuned ranking (implicit feedback).** Discards/accepts/exports adapt per-channel axis weights (existing persona/implicit-feedback architecture, ROADMAP Phase 5); a visible "tuned for this channel" note on the queue header. | "AI decides where to look, the editor decides what to keep" (S1) — feedback turns rejections into better recall next VOD; AutoClip's per-channel monitoring is the same idea sold as pricing tiers (S9). | Review (passive) + Settings (visible weights) · `feedbackStore` |

### P2 — nice-to-have (deferred; listed so Phase 2 doesn't paint into a corner)

| ID | Feature | Note |
|---|---|---|
| P2-1 | Social scheduling / auto-publish | Out of scope per existing decision; keep export metadata copy-ready so a scheduler can be added later (S11, S13, S16). |
| P2-2 | Live companion (hotkey "clip that" while streaming, retroactive buffer capture like Medal/Alt+X) | Different latency class; the marker-ingestion layer (P1-8) already gives its data a home (S12, S19). |
| P2-3 | Voice-command clipping | Eklipse's most-praised feature (S4); map to the marker layer later. |
| P2-4 | Game-specific visual detectors (killfeed/scoreboard OCR plugins) | Plugin architecture exists (ARCHITECTURE.md); AutoClip's signal study (scene cuts + energy peaks = 86% of signal, S9) suggests chat+audio covers most value first. |
| P2-5 | Branding kit (persistent watermark/lower-third) | v1 explicitly deferred (v1 §16); part of preset system when built. |
| P2-6 | Multi-account team/workspace | OpusClip team workspace is enterprise-facing (S11); single-operator is the SemaClip user. |
| P2-7 | Discord/webhook export targets | FragCut lists Discord as a destination with different pacing (S7); cheap to add as an export "platform" that just copies a file path. |
| P2-8 | Mobile companion (review/approve on phone) | Eklipse/StreamLadder both pitch mobile (S13, S10); out of scope for desktop Phase 2. |

**Counts: P0 = 13, P1 = 12, P2 = 8.**

---

## 4. UX specification per screen

The app remains a single window: 44px top bar, 56px icon rail (now six entries), main stage. Rail order = workflow order: Library, Review, Processing, Compose, Export, Settings. The v1 anti-patterns hold (§14 of v1 DESIGN.md): no card grids for clips, no modals for preview, no AI visual language, no onboarding flow.

### 4.0 Navigation frame

```
┌──────────────────────────────────────────────────────────────┐
│  [wordmark] SemaClip              [channel: All ▾] [⚙]        │ top bar (44px)
├──────────┬───────────────────────────────────────────────────┤
│ [Library]│                                                    │
│ [Review] │                MAIN STAGE                          │
│ [Proc.]  │                                                    │
│ [Compose]│                                                    │
│ [Export] │                                                    │
│ [Settings]                                                    │
│ (56px rail, icon-only, active = 2px #CC0000 left border)     │
└──────────────────────────────────────────────────────────────┘
```

- Review/Compose/Export are contextual: the rail highlights them when the active context is a loaded VOD/composition/export batch. `1`–`7`-style global keys: `G` then `L/R/P/C/E/X` is unnecessary — screens are reached by workflow keys (`O` opens Library, `Esc` backs out one level) so the keyboard never leaves the Review surface for long.
- The top-bar **channel selector** (`All ▾`) is global: it filters Library, and in Review/Export it scopes default presets and naming templates to that channel. Keyboard: `Shift+C` opens the selector inline.

### 4.1 Screen — Library

**Job:** show what exists, what's processing, what's queued — across channels — and get the user into a VOD in one click.

```
┌──────────────────────────────────────────────────────────────┐
│  IMPORT                                                       │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  [drop VOD file / chat JSON]  or paste VOD URL:          │ │
│  │  [https://www.twitch.tv/videos/...              ] [→]    │ │
│  │  [proxy quality: ● Medium (960×540) ○ High ○ Full]       │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  CHANNELS  [All] [livia] [co-stream A] [clip-channel B] [+]   │
│                                                                │
│  RECENT                            [filter ▾] [sort ▾]        │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ ▸ Stream Title · livia · 4h12m · 2026-09-08   [12 clips] │ │
│  │   ▓▓▓▓▒▒▒░░░ hype 5 humor 3 skill 4   ◉ reviewed 6/12    │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ ▸ Stream Title · co-stream A · 3h45m · 2026-09-07  [8]   │ │
│  │   ⚑ 3 markers (mod: "1v3 clutch @2:14")                  │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ ⟳ Processing · clip-channel B · 7m elapsed · 41%         │ │
│  │   ████████░░░░░░░░░  Transcription phase   [Cancel]      │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  QUEUE (2)                          [▲▼ reorder] [✕ cancel]   │
│  │ 1. Queued VOD · waiting — proxy: Medium                   │ │
│  │ 2. Queued VOD URL pasted · waiting                        │ │
└──────────────────────────────────────────────────────────────┘
```

**Gaze order:**
1. **Import bar (top)** — drop zone + URL input; focus ring `#CC0000`; the proxy-quality control sits *in the import bar* (not settings) because it is per-VOD and per-session meaningful (P0-10, surfaced at the point of action).
2. **Channel strip** — horizontal chips; `All` active by default; `[+]` opens the inline "add channel" popover (name + default preset). No modal.
3. **Recent streams** — rows, most recent first; processing rows pinned with live progress + inline Cancel; review-progress badge `◉ reviewed 6/12` shows where the user left off (P0-11 made visible).
4. **Queue (bottom)** — reorder/cancel inline; collapsed when empty.

**Interaction notes:** pasting a URL shows the v1 §6.4 metadata-then-download flow (title/streamer/duration first, video + chat after, both cancellable). Row badge `⚑ N markers` appears when marker ingestion (P1-8) found external markers — clicking jumps into Review with the markers layer focused. Streamer opens a VOD with `Enter` on the row or click; `Space` on a row opens Review directly at the first unreviewed candidate.

### 4.2 Screen — Review (the core screen)

**Job:** audit, judge, trim, and prepare clips at maximum speed. 90% of tool time lives here.

```
┌──────────────────────────────────────────────────────────────┐
│  ← Library  Stream Title · livia · 4h12m    [Export ▾] [⚙clp]│
├──────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────┐  ┌──────────────────┐  │
│  │        VIDEO PLAYER              │  │   CANDIDATE      │  │
│  │  (crop overlay active in 9:16)   │  │   QUEUE          │  │
│  │                                  │  │   (ranked list)  │  │
│  │  [02:14:42 / 04:12:00] ⏯ ◀▶ [1x]│  │ ▌1 HYPE  0.94 ✓ │  │
│  │  speed: [1·2·4·8·16]             │  │  2 SKILL 0.88    │  │
│  └──────────────────────────────────┘  │  3 HUMOR 0.81 ⚑ │  │
│                                         │  ...             │  │
│  ┌──────────────────────────────────┐  │ [axis filter]    │  │
│  │  SIGNAL TERRAIN TIMELINE         │  │ [markers]        │  │
│  │  waveform + chat + clip marks    │  │ hype humor skill │  │
│  │  ⚑ flags = external markers      │  │ awkwd emot tens  │  │
│  │  zoom: [─────●─────] frame-level │  └──────────────────┘  │
│  └──────────────────────────────────┘                          │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  CLIP 01 · HYPE  0.94        [A Accept] [D Discard]      │ │
│  │  justification text (pipeline rationale)                 │ │
│  │  IN  02:14:18 ▸ OUT 02:14:58  (drag handles / I O keys)  │ │
│  │  [▶ From start]  [T Tighten silences]  [C Captions ✎]    │ │
│  │  [X Crop: 9:16 cam-top]  [M Metadata draft]  [E Export]  │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

**Gaze order (carries over v1 §7.2, extended):**
1. **Video player** — top-left, largest; opens paused at the current candidate's peak; the machine's best guess is on screen immediately. A **crop guide overlay** (9:16/1:1 safe window) is on by default at 20% opacity — framing is always inspectable, not an export-time surprise.
2. **Candidate queue (right)** — rank, axis label, score, state glyph (`✓` accepted, `–` rejected, `⚑` has-marker, `✎` edited). Accepted clip gets the 2px `#CC0000` left border. Review progress `n/m` pinned at the queue top.
3. **Timeline** — full-VOD terrain; clip marks (score-height ticks) + **marker flags** (P1-8); selected bracket in `#CC0000`; key-light effect retained.
4. **Detail panel (bottom)** — justification, signal bars, in/out points, and the full action row (accept/discard/tighten/captions/crop/metadata/export). Every action visible; nothing behind right-click or "…" menus.

**Order of operations (the audit loop):**
1. Open stream → candidate #1 loaded paused at peak. **Space** plays from clip **start** (hook check first — §2.4 "clear hook in the first 1–2 seconds", S8), stops at clip end.
2. **A** accept (queue state `✓`, next candidate loads) · **D** discard (recoverable via `U`; feeds implicit feedback P1-12) · **S** snooze/defer to end of queue.
3. **J/K** prev/next candidate; `,`/`.` frame-step; `I`/`O` set in/out at playhead; drag handles snap to frames at max zoom (`+`/`-` zoom).
4. **T** tighten silences (P1-10): shows seconds removed, one more `T` reverts.
5. **C** caption edit (P0-8): inline transcript editor with word timings; edits persist to project.
6. **X** cycles crop mode (16:9 → 9:16 gameplay → 9:16 cam-top → 9:16 cam-bottom → 9:16 PiP → 1:1); arrow keys nudge crop window; **G** toggles facecam tracking (P1-7) — tracking proposal vs manual always visible in the overlay.
7. **M** opens the metadata draft inline (P1-3) — editable, `Ctrl+Shift+C` copies title to clipboard.
8. **E** opens Export (§4.5) pre-filled with this clip's preset; **Shift+E** batch-exports all accepted clips (P1-2).
9. **R** sends clip to current composition (P1-1); if none exists, one is created silently and the Compose rail icon gains a count badge.
10. **Q** toggles the review-progress filter (unreviewed only / all) — the fastest way to resume a half-reviewed VOD.

**Keyboard map (Review):**

| Key | Action |
|---|---|
| `Space` | Play/pause (plays from clip start) |
| `J` / `K` | Previous / next candidate |
| `←` / `→` | Seek ±5s · `Shift+←/→` ±1s |
| `,` / `.` | Frame step ±1 · `Shift+,`/`Shift+.` ±1s |
| `I` / `O` | Set in / out point at playhead |
| `+` / `-` | Timeline zoom (frame level at max) |
| `A` | Accept candidate |
| `D` | Discard candidate (`U` undo) |
| `S` | Snooze to queue end |
| `T` | Tighten silences (toggle) |
| `C` | Caption editor focus |
| `X` | Cycle crop mode |
| `G` | Toggle facecam tracking (P1-7) |
| `M` | Metadata draft focus |
| `R` | Send to composition |
| `1`–`7` | Axis filters (hype/humor/skill/awkward/emotional/tension/reaction) |
| `Shift+C` | Channel selector (top bar) |
| `Q` | Queue filter: unreviewed only / all |
| `E` / `Shift+E` | Export clip / batch export accepted |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / redo (P0-12) |
| `F` | Fullscreen video · `M` mute |
| `?` | Keyboard overlay · `Esc` back out |

### 4.3 Screen — Processing

**Job:** make minutes-to-hours of pipeline time legible and non-blocking; start review before it finishes.

Carries over v1 §8 (pipeline phase list with per-stage durations, live findings, queue preview, non-destructive cancel) and adds:

- **Proxy status line:** "Proxies: 960×540 — 100% (scrubbing is full-speed)" or "generating… 40%" (P0-10 visible).
- **Markers fetched** line when external markers were found for the VOD ("⚑ 5 markers imported").
- **Live findings** rows identical in shape to Review's queue so candidates are auditionable mid-process; clicking one jumps into Review (v1 already streams `candidate` events).
- Keyboard: `Esc` to Library; `Enter` opens the most recent finding in Review; `X` cancels current job (with the Phase-0 cancel ladder); everything reachable without the mouse.

### 4.4 Screen — Compose/Reel (P1-1)

**Job:** assemble accepted clips into one reel (compilation / "best of stream"), trim segments, order, single render.

```
┌──────────────────────────────────────────────────────────────┐
│  COMPOSE · "Best of 2026-09-08"   [+ Add clips]  [▶ Preview] │
├──────────────────────────────────────────────────────────────┤
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  REEL TIMELINE (horizontal segment strip)                │ │
│  │  ┌──────┐ ┌────────┐ ┌────┐ ┌──────┐                     │ │
│  │  │CLIP 1│ │CLIP 4  │ │CLIP│ │CLIP 2│   ⟵ drag to reorder │ │
│  │  │ 12s  │ │ 21s    │ │ 9s │ │ 15s  │                     │ │
│  │  └──────┘ └────────┘ └────┘ └──────┘                     │ │
│  │  transition chips between segments: [cut] [cross 0.3s]   │ │
│  └──────────────────────────────────────────────────────────┘ │
│  ┌───────────────────────┐  ┌───────────────────────────────┐│
│  │  SEGMENT DETAIL       │  │  REEL SETTINGS                ││
│  │  in/out, crop, SFX,   │  │  global layout, caption style ││
│  │  overlay card         │  │  music bed + ducking, target  ││
│  │  [▲ prev][▼ next]     │  │  preset, output name          ││
│  └───────────────────────┘  └───────────────────────────────┘│
│  [ Render reel → ]   total 1:14 · 4 segments · 9:16           │
└──────────────────────────────────────────────────────────────┘
```

**Gaze order:** 1) segment strip (the reel's shape) → 2) selected segment detail → 3) reel settings (right, quiet). **Keyboard:** `J/K` prev/next segment; `Space` plays the reel; `R` from Review inserts; `Ctrl+←/→` reorder segment; `Del` removes; `Enter` opens render confirm; render progress is the standard honest toast/panel (P0-13). Overlay cards (P1-5) and SFX (P1-6) attach per segment in the detail panel — the same components Review uses, so nothing exists only here.

### 4.5 Screen — Export

**Job:** go from decided clips to files on disk with correct names, fast, per platform.

```
┌──────────────────────────────────────────────────────────────┐
│  EXPORT — CLIP 01 · HYPE (from Review `E`)     or BATCH (7)  │
├──────────────────────────────────────────────────────────────┤
│  PRESETS   [● TikTok 9:16 H.264] [○ Shorts 9:16 VP9]         │
│            [○ 16:9 Archive H.264] [○ 1:1]  [+ New preset]    │
│                                                                │
│  ASPECT & CROP        CROP PREVIEW                            │
│  [16:9] [●9:16] [1:1]  ┌────────┐   layout: [●cam-top]        │
│  tracking: [●on][off]  │ ▓▓▓▓▓▓ │   (drag window to reframe)   │
│                        │ ▓▓▓▓▓▓ │                              │
│  CAPTIONS [☑ burn-in]  └────────┘   style: [● Bold white]     │
│  [✎ Edit text]  censor: [☑ bleep]  SRT sidecar: [☑]           │
│                                                                │
│  METADATA (draft)  title/description/tags  [copy] [edit]      │
│  COVER FRAME  [scrub ▸]  [● frame 12:41] [○ gen.1] [○ gen.2]  │
│                                                                │
│  OUTPUT   path: [~/Videos/SemaClip/2026-09-09/]               │
│  NAME     [{date}-{channel}-{axis}-{ts}-{platform}.mp4]       │
│           → 2026-09-09-livia-hype-0214-42-tiktok.mp4          │
│                                                                │
│  [ Cancel ]                        [ Export → ] (Enter)       │
└──────────────────────────────────────────────────────────────┘
```

Everything on this sheet maps to a P0/P1 feature and **nothing is behind an accordion** (compliance §8): presets (P0-7), crop + layout + tracking (P0-9, P1-7), captions + censor + SRT (P0-8, P1-11), metadata (P1-3), cover frame (P1-4), naming tokens (P1-2). Batch mode lists the queue of clips with per-clip preset override and a manifest preview (exported as `manifest.json` next to the files). Export runs as an honest background job: progress toast, per-file errors with stderr, cancel per file or per batch. Keyboard: `↑/↓` move between control groups, `Space` toggles focused checkbox, `Enter` export, `Esc` cancel, `Ctrl+Shift+N` cycle naming tokens.

### 4.6 Screen — Settings

**Job:** set it once; everything here is also reachable contextually at point of use. Sections in one scrollable page, all visible (no tab hiding): **Channels** (roster, default preset per channel), **Processing** (GPU device dropdown, proxy default, concurrency), **Export defaults** (default preset, output root, naming template with live preview), **Captions** (default style, censor on/off), **Audio** (music bed defaults, ducking threshold), **Keyboard** (full map + remap), **Updates** (channel, check-now — Phase 4). Every setting states its effect in one line; nothing exists only in Settings that affects a workflow screen without also being surfaced at point of use (e.g., proxy quality is in the import bar; naming template is in Export).

### 4.7 Consolidated keyboard philosophy

- Single-letter, two-hand, no-chord actions for the audit loop (`A/D/J/K/I/O/T/X/E`); chords only for destructive/undo (`Ctrl+Z`) and batch (`Shift+E`).
- Every screen shows `?` overlay listing its live map; the Review map is the superset.
- All keyboard maps are remappable in Settings → Keyboard; defaults match the v1 map plus the new actions above so v1 muscle memory survives.

---

## 5. No-gating compliance note

**Rule (product owner, restated):** no UI gating — every tool visible and reachable; power lives in keyboard shortcuts and good defaults, not hidden menus. Concretely, SemaClip must not use: `…` overflow menus, right-click-only actions, accordion-collapsed tool groups, "Pro" badges on features the user owns, mode switches that remove panels, or modals that hide the video. The audit below states, for every P0/P1 feature, exactly where it lives on the visible surface and which key reaches it. **No feature may ship behind a hidden menu; any future feature must add a row here.**

| Feature | Visible surface | Keyboard | Why it's not hidden |
|---|---|---|---|
| P0-1 Multi-channel library | Channel chips + channel column on every stream row (Library top) | `Shift+C` channel selector | Filtering is a control, not a view mode |
| P0-2 Import (URL/file/proxy) | Import bar always at Library top; proxy quality inline | `O`, `Ctrl+V` into URL field | First thing on screen |
| P0-3 Queue | Library bottom panel + Processing next-job row; reorder/cancel buttons inline | `X` cancel in Processing | Status and control in the same panel |
| P0-4 Audit loop | Candidate queue always visible in Review; accept/discard as buttons in detail row | `A` / `D` / `S` | One keystroke, button visible for mouse users |
| P0-5 Frame trim | In/out always in detail row; drag handles appear on selection | `I` / `O` / `,` / `.` / `+/-` | No "advanced trim" submode |
| P0-6 Terrain + markers | Timeline always rendered in Review; markers layer toggle is a labeled chip on the timeline header | `Enter` on marker flag | Same layer for machine and human signals |
| P0-7 Presets | Preset row pinned at Export top; `+ New preset` inline popover | `↑/↓` within preset group | First control on the screen |
| P0-8 Captions | Caption group always expanded in Export; `[✎ Edit text]` inline in Review detail | `C` | No collapsed "more options" |
| P0-9 Crop + layouts | Crop preview always visible when aspect ≠ source; layout chips inline | `X` cycle, arrows nudge | Framing is inspectable during review, not just export |
| P0-10 Proxy | Status line in Processing + per-VOD quality selector in import bar | — | Status, not a setting to hunt for |
| P0-11 Persistence | Review-progress badges on Library rows; reopening restores state silently | — | Persistence is visible as progress, invisible as friction |
| P0-12 Undo | History count in Review header; `Ctrl+Z` | `Ctrl+Z` / `Ctrl+Shift+Z` | Safety net without a dialog |
| P0-13 Honest lifecycle | Per-stage progress + cancel + error detail inline everywhere jobs run | `X` cancel | The ROADMAP honesty rule, enforced in UI |
| P1-1 Compose | Rail icon with count badge; `R` from Review; segment strip always shows all segments | `R` | Second citizen of the rail, never a modal editor |
| P1-2 Batch naming | Naming template with live preview always shown in Export | `Ctrl+Shift+N` | Template editing is an inline field |
| P1-3 Metadata | Inline draft block in Export (and `M` in Review) | `M` | Draft is on the sheet, not a separate dialog |
| P1-4 Cover frame | Scrubber + 3 candidates inline in Export | arrows in cover group | Visible alongside crop preview |
| P1-5 Overlay cards | Card library in Review detail + Compose segment panel (same component) | `V` inserts card at playhead | One component, two anchors |
| P1-6 SFX/music | SFX rail in Review detail; music bed block in Compose settings | `V` then `↑/↓`, `B` toggle bed | Listed, not searched |
| P1-7 Crop tracking | Toggle chip on crop preview; detaching is one keystroke | `G` | Proposal-with-override, never locked auto |
| P1-8 Markers | Timeline flags + Library row badge; ingestion runs automatically at import | `Enter` on flag | Data shown where the eye already is |
| P1-9 NLE handoff | Export sheet third group: EDL/FCPXML/XML + SRT checkboxes | `N` cycles format | Same sheet as video export |
| P1-10 Tighten | Button in Review detail row with live before/after duration | `T` (toggle) | Reversible in one key |
| P1-11 Censor | Checkbox + flagged-word list inline in Export | list navigable by arrows | Reviewable, not a black box |
| P1-12 Feedback | "Tuned for this channel" note in queue header; weights visible in Settings → Channels | — | Adaptation is disclosed, not occult |

**Regression rule:** any PR adding a feature must add a row to this table. A feature with no visible surface and no keybinding is a review reject — same bar as the standing "no fabricated success" rule in ROADMAP.md.

---

## 6. Explicit non-goals for Phase 2 (from research + standing decisions)

- No social auto-publishing or scheduling UI (export-local; keep metadata copy-ready) — §2.4.
- No cloud processing, no account system, no telemetry upsell surface — §2.5.
- No storyboard-only or AI-autopilot mode that removes the timeline — §2.5.
- No watermarking of user output, ever — §2.5.
- No per-axis color coding, no AI visual language, no card grids (v1 anti-patterns carry over).
- No onboarding flow, welcome tour, or feature-discovery popups — the `?` overlay and visible controls are the discoverability model.

---

## 7. Visual foundation (restated for self-containment)

- **Palette:** foundation `#0B0B10`, surfaces `#16161F/#24242F/#2E2E3A`, borders `#2E2E3A/#3D3D4A`, text `#FFFFFF/#A1A1AA/#71717A`, accent `#CC0000` (hover `#E60000`, deep `#8B0000`, glow `rgba(204,0,0,0.20)`), semantic `#22C55E / #EAB308 / #EF4444`. Accent appears only on: playhead, selected clip mark/bracket, active queue row border, primary CTA, active filter chip, glow.
- **Type:** Space Grotesk 500–700 display; Inter 400–600 UI; JetBrains Mono 400–500 data (timestamps, scores, filenames). Scale 12/13/14/15/18/24/32.
- **Icons:** custom SVG set (~20 icons in v1; Phase 2 adds: layers/markers, crop-frame, film/compose, music note, caption bubble, image/cover, download-cloud-off for "local" badge).
- **Motion:** GSAP, 150–300ms, `power2` family, reduced-motion → instant. No new motion classes; reuse v1 catalogue (§11 v1 DESIGN.md).

## 8. Open questions for Phase 2 implementers

1. Proxy codec default: H.264 960×540 CRF 23 is the working assumption (P0-10); confirm decode performance on the 4090+3090 workstation and on CPU-only tier before freezing.
2. Caption edit UX: word-level click-to-edit vs line-level text editing with word timings re-synced by alignment — start with line-level (cheaper, robust); word-level is P2 territory.
3. Compose render pipeline: reuse per-clip FFmpeg graph chains vs single filtergraph concat — measure at first reel >8 segments.
4. Marker ingestion scope for v1 of the feature: Twitch `/marker` via VOD metadata + a generic JSON markers file; Boltis-style API lists later (P1-8).
5. Whether the metadata draft generator (P1-3) runs locally (llama.cpp, consistent with ARCHITECTURE.md tiering) or is deferred until Phase 3 triage models exist — draft-only UI can ship first with template-based fallback.

## 9. Community-signal pointers (titles only; bodies not verified — see §1 access limitation)

- r/Twitch — "Is there any better option? -> eklipse.gg" (reddit.com/r/Twitch/comments/180im4g)
- r/Twitch — "Creating Highlights — Best way for someone working full time" (reddit.com/r/Twitch/comments/1ayhuu6)
- r/Twitch — "Questions about highlighting / clipping streams" (reddit.com/r/Twitch/comments/171lv74)
- r/Eklipsegg — "Eklipse.GG is ABSOLUTE TRASH and they are THEIVES." (reddit.com/r/Eklipsegg/comments/15kzx5o)

These titles corroborate (a) the recurring search for alternatives to cloud auto-clippers and (b) strong negative sentiment around gating practices — both already grounded in the fetched sources above — but no quote or claim from their comment bodies appears in this document.

## 10. Source register (full URLs)

1. https://blog.eklipse.gg/streaming-tips/how-livestream-editors-edit-so-fast.html
2. https://blog.eklipse.gg/streaming-tips/video-repurposing.html
3. https://blog.eklipse.gg/streaming-tips/beginner-guide/how-to-become-a-clipper.html
4. https://blog.eklipse.gg/featured/eklipse-gg-review.html
5. https://recapo.ai/blog/how-to-clip-a-twitch-vod/
6. https://clipfinder.org/blog/clip-twitch-vods-without-editing-software
7. https://fragcut.io/blog/how-to-turn-twitch-vods-into-clips
8. https://boltis.app/blog/how-to-clip-twitch-highlights-without-scrubbing-vods/
9. https://autoclip.dev/tools/twitch-clip-maker · https://autoclip.dev/research
10. https://streamladder.com/clip-editor
11. https://www.opus.pro/
12. https://medal.tv/
13. https://eklipse.gg/
14. https://github.com/topics/twitch-clipper
15. https://eklipse.gg/ (AI-Edit product listing)
16. https://www.wisecut.video/
17. https://www.assistant.gg/en/create-clips-from-any-twitch-or-youtube-vod-with-vod-from-url/
18. Reddit threads listed in §9 (titles only)
19. Twitch Clips/Highlights mechanics as reported by sources 1, 5, 6

*Internal references: docs/archive/v1/DESIGN.md (visual system, anti-patterns, motion catalogue); ARCHITECTURE.md (pipeline phases, plugin architecture, model tiering); ROADMAP.md (Phase 0–5 scope and exit gates); DECISIONS.md.*