# SemaClip — Frontend Design Specification v1

> The complete UI/UX architecture for SemaClip. Every element is intentional, grounded in the streamer's actual workflow, and technologically aligned with the stack (Svelte 5 + SvelteKit + Tailwind + GSAP, rendered in CEF via Deno Desktop).

---

## 1. Design Thesis

**SemaClip is a signal instrument, not a dashboard.**

A streamer opens SemaClip to audit the machine's judgment — to see what the pipeline found, understand why, and act on it fast. The UI's single job: make the machine's reasoning legible and actionable in the shortest possible time, without ever competing with the video for the eye.

The design follows three principles:

1. **The video is the only warm thing on screen.** The UI chrome is cool, dark, and quiet. The video player carries all the color; the interface frames it.
2. **One color means "look here."** A single deep blood red is used exclusively for the playhead, the selected clip, and the primary action. Its scarcity makes it an event, not decoration.
3. **Structure encodes meaning.** The signal terrain timeline is the signature — it makes the ML pipeline's output (waveforms, chat density, axis markers) spatially legible. Everything else is disciplined chrome around it.

---

## 2. Final Palette — "Carbon & Blood"

Reconciled from Direction 3 (Crimson Console foundation) + Deep Blood accent. The foundation is Skeleton.dev's charcoal-blue; the accent is YouTube's darker red at full saturation.

### Color tokens

```css
:root {
  /* ── Foundation ramp (cool charcoal-blue, Skeleton-aligned) ── */
  --color-foundation:   #0B0B10;  /* App canvas — near-black, blue undertone */
  --color-surface:      #16161F;  /* Panels, cards, timeline bed */
  --color-surface-2:    #24242F;  /* Hover, raised controls */
  --color-surface-3:    #2E2E3A;  /* Active, pressed */
  --color-border:       #2E2E3A;  /* Hairline borders (same as surface-3) */
  --color-border-strong: #3D3D4A; /* Emphasized borders */

  /* ── Text ── */
  --color-text:         #FFFFFF;  /* Primary — pure white, Skeleton's headline color */
  --color-text-2:       #A1A1AA;  /* Secondary — zinc-400, labels and metadata */
  --color-text-3:       #71717A;  /* Tertiary — zinc-500, disabled, hints */

  /* ── The accent (used sparingly — see §2.2) ── */
  --color-accent:       #CC0000;  /* Blood red — YouTube dark red, full sat */
  --color-accent-hover: #E60000;  /* Lifted for hover/active */
  --color-accent-deep:  #8B0000;  /* Dark variant for backgrounds/badges */
  --color-accent-glow:  rgba(204, 0, 0, 0.20); /* Radial glow behind active elements */

  /* ── Semantic (used only for state, never decoration) ── */
  --color-success:      #22C55E;  /* Export complete, job done */
  --color-warning:      #EAB308;  /* Disk space low, model download needed */
  --color-error:        #EF4444;  /* Pipeline failure, CUDA OOM */
}
```

### 2.1 Why this palette is not the default

| Common AI-generated default | What we do instead |
|---|---|
| Pure black `#000000` background | `#0B0B10` — a *decided* charcoal with blue undertone. Not vague black. |
| Acid green or vermilion accent | Deep blood `#CC0000` — serious, not gamer-neon |
| Purple gradients (Twitch-adjacent) | No gradients in the chrome. The only gradient is the accent glow. |
| 6-color axis coding | All clips are the same red. Axes are differentiated by label and score, not color. |
| Warm cream paper alternative | Rejected — fights video player and streamer cultural expectations |

### 2.2 Accent usage rules (enforced)

The blood red `#CC0000` appears in **exactly these contexts and nowhere else**:

| Context | Element | Treatment |
|---|---|---|
| Playhead | 1px vertical line + triangle cap | Solid `#CC0000` |
| Selected clip mark (timeline) | Vertical tick | Solid `#CC0000`, height = score |
| Selected clip bracket (timeline) | Start/end hairlines | `#CC0000`, 1px |
| Active clip left border (queue) | 2px left border on selected row | `#CC0000` |
| Primary CTA button | "Export", "Start processing" | bg `#CC0000`, text `#FFFFFF` |
| Active filter chip | Axis filter when toggled on | border `#CC0000`, text `#CC0000` |
| Glow behind active elements | Radial gradient | `rgba(204,0,0,0.20)`, 80px radius |

**Everything else is grayscale.** Non-selected clip marks are `--color-text-2` (zinc-400). The waveform is `--color-text-3` (zinc-500). Chat density is `--color-surface-3`. This creates the "key light" effect naturally: the selected clip is the only colored thing on the timeline.

### 2.3 Platform color harmony

The palette is designed to sit alongside streaming-platform colors without clashing:

| Platform | Color | Hex | Relationship to our palette |
|---|---|---|---|
| Twitch dark mode | Background | `#0E0E10` | Our `#0B0B10` is 4 shades darker — feels related but distinct |
| Twitch purple | Brand | `#9146FF` | Complementary to our red on the color wheel — they coexist |
| Twitch live red | Live indicator | `#EB0400` | Same hue family as our accent, brighter — ours reads as "found signal," theirs as "live" |
| Kick green | Brand | `#53FC18` | Opposite our red — high contrast, no clash |
| YouTube red | Brand | `#FF0000` | Our `#CC0000` is the darker, more serious sibling |

---

## 3. Typography

Three roles. Each chosen for a specific job.

| Role | Face | Weight | Size | Usage |
|---|---|---|---|---|
| **Display** | Space Grotesk | 500–700 | 18–32px | Wordmark, section headers, clip justifications. Distinctive slightly-condensed grotesque with quirky terminals — not the default Inter. |
| **Body / UI** | Inter | 400–600 | 13–15px | All UI text, labels, buttons, body copy. Legible at small sizes, neutral, doesn't fight the display face. |
| **Data / Mono** | JetBrains Mono | 400–500 | 12–14px | Timestamps (`02:14:42`), scores (`0.94`), axis tags, file sizes. Mono signals "this is measured data." |

**Type scale (modular, 1.125 ratio):**

```
12px  →  mono labels, timestamps, metadata
13px  →  body text, UI labels, button text
14px  →  clip justification, detail panel body
15px  →  section subheaders
18px  →  section headers, clip axis labels
24px  →  screen titles, wordmark
32px  →  (reserved for empty-state headlines only)
```

**Letter-spacing:** Display -0.01em (tightened). Mono 0.02em (loosened for readability). Body 0.

---

## 4. Iconography

**No shadcn/Lucide icon set.** The user explicitly rejected the "popular look" of shadcn icons and Builder.io.

**Approach:** Custom SVG icons for the ~20 icons the app needs. They're few enough that custom is feasible, and it maximizes distinctiveness.

**Icon character:**
- 1.5px stroke weight (consistent with Skeleton's Lucide usage, but our shapes are custom)
- 20px viewport, rounded line caps
- Geometric, not playful — no smiley faces, no hand-drawn feel
- Filled variants for active states (e.g., filled play triangle when playing, outline when paused)

**Icon inventory (complete — the app needs no others):**

| Icon | Used for |
|---|---|
| Play / Pause | Video controls |
| Skip-back / Skip-forward | Prev/next clip (J/K) |
| Step-back / Step-forward | Frame step (,/.) |
| Scissors | Export |
| Trash | Discard clip |
| Filter | Axis filter toggle |
| Settings (gear) | Settings screen |
| Plus | Add VOD |
| Link | URL import |
| Download | VOD download progress |
| Queue (list) | Job queue |
| Check | Completed state |
| Alert (triangle) | Error/warning |
| Chevron-right | Navigation, disclosure |
| Close (X) | Dismiss, cancel |
| Search | Search/filter clips |
| Grid (4 squares) | Library view |
| Waveform | Signal terrain label |
| Clock | Duration, timestamps |
| Cpu | Processing/GPU indicator |

---

## 5. Information Architecture

Three screens + one sheet. The app is a single window with a persistent left rail and a main stage.

```
┌──────────────────────────────────────────────────────────────┐
│  [wordmark] SemaClip                    [streamer] [⚙]         │  top bar (44px)
├──────────┬───────────────────────────────────────────────────┤
│          │                                                    │
│  LEFT    │              MAIN STAGE                            │
│  RAIL    │                                                    │
│ (56px)   │  Screen 1: Library                                 │
│          │  Screen 2: Review (stream detail + clip audit)    │
│ [Library]│  Screen 3: Processing                              │
│ [Queue]  │                                                    │
│ [Settings]│  + Export sheet (bottom, slides up)               │
│          │                                                    │
└──────────┴───────────────────────────────────────────────────┘
```

**Left rail:** Icon-only navigation (56px wide). Three entries: Library (grid icon), Queue (list icon), Settings (gear). Active entry gets a 2px `#CC0000` left border. Hover lifts the icon to `--color-text` from `--color-text-2`.

**Top bar:** Wordmark left, streamer name + settings right. 44px tall, `--color-surface` background, 1px `--color-border` bottom border.

---

## 6. Screen 1 — Library

**Job:** Show what streams exist, what's processing, what's queued. Get the streamer into a VOD in one click.

### 6.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  IMPORT                                                       │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  [📎 icon]  Drop VOD + chat files here                   │ │
│  │              or paste Twitch VOD URL:                   │ │
│  │  [https://www.twitch.tv/videos/...              ] [→]    │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  RECENT                              [filter ▾] [sort ▾]     │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ ▸ Stream Title · Streamer · 4h12m · 2026-07-22    [12 clips] │
│  │   axis distribution: ▓▓▓▓▒▒▒░░░  hype 5  humor 3  skill 4 │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ ▸ Another Stream · Streamer · 3h45m · 2026-07-21  [8 clips] │
│  │   axis distribution: ▓▓▒▒▒▒░░░  hype 2  humor 4  skill 2  │ │
│  ├──────────────────────────────────────────────────────────┤ │
│  │ ⟳ Processing Stream · 7m elapsed · 41%                   │ │
│  │   ████████░░░░░░░░░░  Transcription phase                │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  QUEUE (2 pending)                                            │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │ 1. Queued Stream · waiting                    [▲ ▼] [✕]  │ │
│  │ 2. Another Queued Stream · waiting             [▲ ▼] [✕]  │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 6.2 Gaze order

1. **Import bar (top).** The primary action. Drop zone + URL input. The URL input has a 1px `--color-border` that becomes `#CC0000` on focus.
2. **Recent streams (center).** Vertical list, most recent first. Processing streams pinned to top with live progress bar.
3. **Queue (bottom).** Collapsed by default if empty. Expands when jobs are queued. Reorder with ▲▼, cancel with ✕.

### 6.3 Stream card anatomy

Each card is a single row (not a grid — grids encourage thumbnail scanning, but *status* is what matters):

```
▸ Stream Title · Streamer · 4h12m · 2026-07-22    [12 clips]
  axis distribution: ▓▓▓▓▒▒▒░░░  hype 5  humor 3  skill 4
```

- **Disclosure arrow** (`▸`): click to open Review screen
- **Title** in `--color-text`, Inter 15px, weight 500
- **Metadata** (streamer, duration, date) in `--color-text-2`, Inter 13px
- **Clip count** badge in `--color-surface-2`, mono 12px
- **Axis distribution bar**: 6-segment stacked bar showing clip counts per axis. Each segment width proportional to count. All segments in `--color-text-3` (grayscale) — no per-axis color. The bar is the *preview of the machine's judgment* before you open the stream.

### 6.4 URL import flow (H1 + H2)

When a Twitch VOD URL is pasted:

```
┌──────────────────────────────────────────────────────────────┐
│  ✓ Found: "Insane Valorant Stream" · StreamerName · 4h12m    │
│  Downloading video... ████████░░░░ 67%  (3.2 GB / 4.8 GB)    │
│  Chat will be fetched automatically after video download.    │
│  [ Cancel ]                                                  │
└──────────────────────────────────────────────────────────────┘
```

- Metadata fetched immediately (title, streamer, duration, game) via Twitch API
- Video downloaded via streamlink/twitch-dl to `~/.semaclip/cache/vods/`
- Chat fetched automatically after video download completes
- Download progress bar in `--color-text-3` fill on `--color-surface` track
- On completion, stream appears in Recent list and auto-starts processing

### 6.5 Empty state

```
┌──────────────────────────────────────────────────────────────┐
│                                                                │
│                    [large drop zone icon]                     │
│                                                                │
│              Drop a Twitch VOD to begin                       │
│              or paste a VOD URL above                         │
│                                                                │
└──────────────────────────────────────────────────────────────┘
```

One sentence. No feature list. No "welcome to SemaClip." The empty state is an invitation to act, not a marketing pitch.

---

## 7. Screen 2 — Review (the core screen)

**Job:** Let the streamer audit, preview, adjust, and export clips as fast as possible. This is where 90% of time is spent.

### 7.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  ← Library   Stream Title · 4h12m · 2026-07-22    [Export All]│
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────┐  ┌──────────────────┐  │
│  │                                  │  │   CLIP QUEUE     │  │
│  │         VIDEO PLAYER             │  │   (ranked list)  │  │
│  │         (16:9, centered)         │  │                  │  │
│  │                                  │  │ ▌1  HYPE   0.94  │  │
│  │  [02:14:42 / 04:12:00]  ⏯ ◀▶    │  │  2  SKILL  0.88  │  │
│  └──────────────────────────────────┘  │  3  HUMOR  0.81  │  │
│                                         │  4  HYPE   0.76  │  │
│  ┌──────────────────────────────────┐  │  5  TENS   0.72  │  │
│  │  SIGNAL TERRAIN TIMELINE        │  │  6  SKILL  0.69  │  │
│  │  (canvas + SVG overlay)          │  │  7  HUMOR  0.64  │  │
│  │  ▁▂▃▅▇▇▅▃▂▁▁▂▃▅▇█▇▅▃▂▁▁▁▂▃▅  │  │  ...             │  │
│  │  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔  │  │                  │  │
│  │  clip marks: │   │ │  │ │ │     │  │  [axis filter]   │  │
│  │  playhead:      ▼               │  │  hype humor skill │  │
│  │  zoom: [─────●─────] frame-level │  │  awkwd emot tens  │  │
│  └──────────────────────────────────┘  └──────────────────┘  │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  CLIP 01 · HYPE                                  0.94    │ │
│  │  ─────────────────────────────────────────────────────── │ │
│  │  "Chat erupts as the streamer hits the final boss's     │ │
│  │  last phase. Sustained emote spike for 18s, peaking     │ │
│  │  at the hit. Voice pitch rises in the 4s before."       │ │
│  │                                                          │ │
│  │  SIGNALS              ENDPOINTS            [▶ Play]     │ │
│  │  Chat    ▮▮▮▮▮        Start  02:14:18      [✎ Adjust]  │ │
│  │  Voice   ▮▮▮          Peak   02:14:42      [Export →]  │ │
│  │  Emote   ▮▮▮▮         End    02:14:58      [✕ Discard] │ │
│  │  Lurker  ▮▮           Dur    40s                        │ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 7.2 Gaze order (critical)

When the streamer opens a processed stream, the eye travels in this exact order. Every layout decision enforces it:

1. **Video player (top-left, largest).** The eye lands on the largest, brightest element. The video shows clip #1's peak frame, paused. *The machine's best guess is already on screen before they do anything.*
2. **Clip queue (right).** The ranked list. Rank number (mono, large), axis tag (text label, no color), score (mono), peak timestamp. The #1 row has a 2px `#CC0000` left border. *The eye scans down and sees the full ranking.*
3. **Timeline (below video).** The terrain shows the whole VOD compressed. Clip marks as vertical ticks. Playhead in `#CC0000`. Selected clip's window bracketed in `#CC0000`. *The eye drops to understand where this moment lives in the stream.*
4. **Active clip detail (bottom).** Justification text, signal bars, endpoints. *Last, because it's the "why" — only relevant once curious about a specific clip.*

**Principle:** largest/brightest → ranked list → spatial context → reasoning.

### 7.3 Order of operations

1. Streamer opens stream → video loads at clip #1 peak, paused. Queue shows full ranking. Timeline shows all clips.
2. **Space** → plays from clip #1 start (not peak). Plays to clip end, pauses at next clip's peak. *Seamless audit loop.*
3. **J / K** → prev/next clip. Video jumps to that clip's peak, paused. Queue selection moves. Timeline bracket moves. Detail panel updates.
4. **Click timeline clip mark** → same as J/K but spatial.
5. **Click axis filter** → queue filters to that axis, timeline dims non-matching clips to 20% opacity, video stays. *Filter is a lens, not navigation.*
6. **Drag clip endpoints** on timeline → endpoints adjust, score recalculates (debounced 300ms). *The one place we allow editing.*
7. **E** → opens export sheet (§9).
8. **Shift+E** → export all queued clips. Batch progress in a toast.

### 7.4 Keyboard map

| Key | Action |
|---|---|
| `Space` | Play/pause current clip |
| `J` / `K` | Previous / next clip |
| `←` / `→` | Seek ±5s |
| `,` / `.` | Frame step (±1 frame). `Shift+,` / `Shift+.` for ±1s |
| `+` / `-` | Zoom timeline in/out (frame-level at max zoom) |
| `1`–`6` | Toggle axis filters (hype/humor/skill/awkward/emotional/tension) |
| `E` | Export current clip (opens export sheet) |
| `Shift+E` | Export all queued clips |
| `D` | Discard clip (marks rejected, feeds implicit feedback) |
| `U` | Undo discard |
| `M` | Mute/unmute video |
| `F` | Toggle fullscreen video |
| `?` | Keyboard overlay |
| `Esc` | Back to library |

### 7.5 Frame-accurate trimming (H7)

The timeline supports zoom from full-VOD view down to frame level:

- **Zoom control:** `+`/`-` keys or scroll wheel on timeline. At max zoom, each pixel ≈ 1 frame (at 30fps, 1 frame = 33ms).
- **Frame step:** `,`/`.` keys step one frame backward/forward. The video `currentTime` updates by `1/30`.
- **Endpoint drag:** at frame-level zoom, drag handles snap to nearest frame. The timestamp readout shows `HH:MM:SS:FF` (frame number) instead of `HH:MM:SS.mmm`.
- **Visual:** at frame-level zoom, the waveform expands to show individual audio samples. The clip bracket shows frame-accurate start/end.

---

## 8. Screen 3 — Processing

**Job:** Turn 17 minutes of waiting into 17 minutes of trust-building.

### 8.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  Processing · Stream Title · started 2m ago                    │
├──────────────────────────────────────────────────────────────┤
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  PIPELINE                                                │ │
│  │                                                          │ │
│  │  ✓ Audio extraction           0:42                      │ │
│  │  ✓ Transcription              7:18                      │ │
│  │  ✓ Chat parsing               0:08                      │ │
│  │  ⟳ Adaptive segmentation      0:31  ███████░░░  68%     │ │
│  │  · Embedding extraction       —                         │ │
│  │  · LLM triage                 —                         │ │
│  │  · Per-axis scoring           —                         │ │
│  │  · Endpoint resolution        —                         │ │
│  │  · Export preparation         —                         │ │
│  │                                                          │ │
│  │  [Cancel]                                                │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  LIVE FINDINGS                                           │ │
│  │                                                          │ │
│  │  02:14  HYPE   0.87  ▮▮▮▮▮▮▮▮▮░  chat spike             │ │
│  │  01:33  HUMOR  0.71  ▮▮▮▮▮▮▮░░░  laughter + emotes      │ │
│  │  00:48  SKILL  0.65  ▮▮▮▮▮▮░░░░  clutch attempt         │ │
│  │  ...                                                     │ │
│  └──────────────────────────────────────────────────────────┘ │
│                                                                │
│  QUEUE (1 more pending)                                       │
│  ┌──────────────────────────────────────────────────────────┐ │
│  │  Next: Another Stream Title · starts when current finishes│ │
│  └──────────────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────────┘
```

### 8.2 Design intent

- **Pipeline** is a vertical phase list. Completed = `✓` + duration. Active = `⟳` + live progress bar in `--color-text-2`. Pending = `·` dimmed in `--color-text-3`. This is the *transparency* that builds trust.
- **Live findings** streams candidates in as they're found (the `candidate` IPC events). Each row: timestamp (mono), axis (text label), score (mono), mini bar, one-line signal summary. The streamer starts judging clips *before* the pipeline finishes.
- **Queue** (H6) shows the next pending job. Collapsed by default; expands to show full queue on click.
- **GSAP motion:** phase transitions = 200ms fade + 4px slide. New candidate rows = 150ms fade + height grow. No bounce, no spring — calm, instrumental.

---

## 9. Export Sheet (H3 + H4)

**Job:** Let the streamer export a clip in the format their platform needs. Slides up from the bottom, doesn't block the video.

### 9.1 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  EXPORT CLIP 01 · HYPE                              [✕]      │
│  ──────────────────────────────────────────────────────────── │
│                                                                │
│  FORMAT                                                       │
│  [ ● MP4 (H.264) ]  [ ○ MP4 (H.265) ]  [ ○ WebM ]           │
│                                                                │
│  ASPECT RATIO                              CROP PREVIEW       │
│  [ ● 16:9 ]  [ ○ 9:16 ]  [ ○ 1:1 ]      ┌──────────┐        │
│                                          │          │        │
│  [ 9:16 selected → ]                    │  ▓▓▓▓▓▓  │        │
│                                          │  ▓▓▓▓▓▓  │        │
│  Crop position: [ ● Center ] [ ○ Top ]   │  ▓▓▓▓▓▓  │        │
│                                          │  ▓▓▓▓▓▓  │        │
│                                          └──────────┘        │
│                                                                │
│  CAPTIONS                                                     │
│  [☑] Burn in subtitles (from transcription)                  │
│      Style: [ ● Bold white on black ] [ ○ Yellow ] [ ○ Custom]│
│      Position: [ ● Bottom ] [ ○ Top ]                         │
│      Font: Inter  ·  Size: 48px  ·  Background opacity: 80%  │
│                                                                │
│  OUTPUT                                                       │
│  Save to: [ ~/Videos/SemaClip/                    ] [Browse]  │
│  Filename: [ semaclip_hype_02-14-42.mp4           ]          │
│                                                                │
│  [ Cancel ]                              [ Export → ]          │
└──────────────────────────────────────────────────────────────┘
```

### 9.2 Feature mapping

| Feature | Implementation |
|---|---|
| **H3: Aspect ratios** | 16:9 (source), 9:16 (TikTok/Shorts/Reels), 1:1 (Instagram). Crop position: center/top/bottom. Live crop preview shows what gets included. |
| **H4: Caption burn-in** | Uses the Whisper transcription already in the pipeline. Toggle on/off. Three preset styles + custom. Position and font configurable. Rendered via FFmpeg `subtitles` filter. |

### 9.3 Interaction

- Opens as a bottom sheet (GSAP: slide up 300ms, `power2.out`). The video remains visible above — the streamer can still see the clip they're exporting.
- `Esc` closes the sheet without exporting.
- `Enter` triggers export with current settings.
- Export progress appears as a toast in the bottom-right (not blocking the sheet, which closes on export start).

---

## 10. Signal Terrain Timeline (signature element)

This is where the design earns its keep. Three composited layers:

### Layer 1 — Canvas (waveform + chat density)

- **Audio waveform:** Mirrored vertical fill, centered on the timeline's vertical midline. Color: `--color-text-3` (zinc-500) at 60% opacity. Computed once per VOD, cached as a downsampled array.
- **Chat density:** Area chart below the waveform centerline. Color: `--color-surface-3` at 80% opacity. Sparse chat reads as a flat line; a hype moment reads as a spike.
- **Redraw:** 30fps via `requestAnimationFrame`, but only when the playhead is moving or the view is zoomed/panned. Static when paused (battery/CPU considerate).

### Layer 2 — SVG overlay (clip marks + regime boundaries)

- **Clip marks:** Vertical ticks at each clip's peak time. Non-selected: `--color-text-2` (zinc-400), height proportional to score. Selected: `#CC0000`, full height, with `rgba(204,0,0,0.20)` radial glow behind it.
- **Regime boundaries:** Faint vertical hairlines (`--color-border`) spanning the terrain, labeled at top in `--color-text-3` mono (e.g., "GAMEPLAY", "JUST CHATTING", "COLLAB").
- **Selected clip bracket:** `#CC0000` hairlines at start/end times, spanning the terrain height.

### Layer 3 — HTML (playhead, tooltips, drag handles)

- **Playhead:** 1px `#CC0000` vertical line with a 6px `#CC0000` triangle at top. Draggable.
- **Hover tooltip:** On hover over any clip mark, a tooltip appears: rank, axis, score, timestamp. `--color-surface-2` background, `--color-text` text, 12px mono.
- **Drag handles:** On selected clip, 8px-wide handles at start/end. `#CC0000` fill, `--color-text` border. Drag to adjust endpoints.

### The "key light" effect

When a clip is selected, GSAP tweens the canvas + SVG overlay opacity to 0.4 everywhere *except* the selected clip's window, which stays at 1.0. The effect: the rest of the stream recedes, the selected moment is spotlit. One tween, one property, enormous clarity.

At frame-level zoom (H7), the waveform expands to show individual samples, and the clip bracket shows frame-accurate timestamps (`HH:MM:SS:FF`).

---

## 11. Motion Catalogue (GSAP via Svelte `use:action`)

Every animation serves a state change. No decorative motion.

| Moment | What animates | GSAP method | Duration | Easing |
|---|---|---|---|---|
| App launch | Wordmark + rail fade in, stage slides up 8px | timeline stagger | 400ms | `power2.out` |
| Stream card hover | Card bg → `--color-surface-2`, border tightens | `to()` | 150ms | `power1.out` |
| Stream open → Review | Video fades in, queue staggers top-to-bottom, terrain draws left-to-right | timeline stagger | 600ms | `power2.out` |
| Clip select (J/K) | Old detail fades out, new fades in; terrain key-light retargets | `to()` ×2 parallel | 200ms | `power2.inOut` |
| Playhead scrub | Playhead follows `currentTime` with 1-frame lag | direct bind (no GSAP) | — | linear |
| Axis filter toggle | Non-matching clip marks → 20% opacity, matching → 100% | `to()` | 180ms | `power1.inOut` |
| Endpoint drag | Bracket follows cursor; score number counts | `to()` on score | live | linear |
| Export sheet open | Sheet slides up from bottom | `to()` | 300ms | `power2.out` |
| Export sheet close | Sheet slides down | `to()` | 200ms | `power2.in` |
| Export progress | Toast slides up, progress bar fills, slides down on complete | timeline | 300ms in/out | `power2.out` |
| Processing phase complete | `✓` fades in, next phase `·`→`⟳` | `to()` | 200ms | `power1.out` |
| Candidate found | New row fades in + grows height | `fromTo()` | 150ms | `power1.out` |
| Error | Phase row → `--color-error`, message fades in | `to()` | 200ms | `power2.out` |
| Glow on active elements | Radial gradient appears behind selected clip/CTA | `to()` on CSS var | 300ms | `power2.out` |

**Reduced motion:** All durations → 0ms (instant). Respects `prefers-reduced-motion`. The app remains fully usable; only transitions become instant.

---

## 12. Component Inventory

| Component | Tech | Notes |
|---|---|---|
| `Timeline.svelte` | Canvas + SVG + HTML | `requestAnimationFrame` redraw, bound to `video.currentTime` rune |
| `VideoPlayer.svelte` | HTML5 `<video>` + custom controls | `bind:this`, keyboard map, frame-step |
| `ClipQueue.svelte` | Svelte list + TanStack Query | Virtualized if >50 clips |
| `ClipRow.svelte` | Svelte + GSAP `use:action` | Hover/select animations |
| `ClipDetail.svelte` | Svelte | Justification, signal bars, endpoints |
| `SignalBar.svelte` | SVG | Horizontal 0–1 bar, animated fill |
| `AxisFilter.svelte` | Svelte | 6 toggle chips, keyboard 1–6 |
| `ExportSheet.svelte` | Svelte + GSAP | Bottom sheet, aspect ratio + captions |
| `CropPreview.svelte` | Canvas | Live crop preview for 9:16/1:1 |
| `ImportBar.svelte` | Svelte | Drop zone + URL input |
| `JobQueue.svelte` | Svelte + TanStack Query | Queue list, reorder, cancel |
| `ProcessingPipeline.svelte` | Svelte + GSAP | Phase list, live progress |
| `LiveFindings.svelte` | Svelte + GSAP | Streaming candidate list |
| `Library.svelte` | Svelte + TanStack Query | Stream list, drag-drop import |
| `StreamCard.svelte` | Svelte | Stream row with axis distribution bar |
| `Toast.svelte` | Svelte + GSAP | Export progress, errors |
| `KeyboardHelp.svelte` | Svelte | `?` overlay |
| `EmptyState.svelte` | Svelte | Drop zone invitation |

**State stores:**
- `playerStore` — `currentTime`, `duration`, `isPlaying`, `currentClipId`, `zoomLevel`
- `jobStore` — WebSocket-driven, pipeline state + live candidates + queue
- `filterStore` — active axis filters, sort order
- `settingsStore` — TanStack Query-backed app settings (GPU selection, export defaults, caption style)

---

## 13. Feature Scope (v1)

### 13.1 Core features (from ARCHITECTURE.md)

- VOD + chat ingestion (file-based)
- ML pipeline: transcription → segmentation → embedding → LLM triage → per-axis scoring → endpoint resolution
- Multi-axis clip detection (hype, humor, skill, awkward, emotional, tension)
- Adaptive temporal segmentation
- Per-axis endpoint resolution
- Implicit feedback (discard, export, self-label detection)
- Persona model (Kalman filter, online personalization)
- Clip export (FFmpeg)

### 13.2 Filled holes (this document)

| ID | Feature | Screen impact |
|---|---|---|
| H1 | VOD URL import (paste Twitch URL, auto-download via streamlink) | Library: URL input in import bar |
| H2 | Chat auto-fetch (automatic with URL import) | Library: no separate chat file picker needed |
| H3 | Export aspect ratios (16:9, 9:16, 1:1 with crop preview) | Export sheet: aspect ratio picker + crop preview |
| H4 | Caption/subtitle burn-in (from Whisper transcription) | Export sheet: caption toggle + style options |
| H6 | Batch/queue processing (queue multiple VODs, process sequentially) | Library: queue panel; Processing: next-job preview |
| H7 | Frame-accurate endpoint trimming (zoom to frame, frame-step) | Review: timeline zoom + frame-step keys |

### 13.3 Deferred to v1.5/v2

| Feature | Why deferred |
|---|---|
| H5: Clip title + description generation | Useful but not a hole — streamers can write their own titles. v1.5. |
| H8: NLE export (EDL/FCPXML/XML) | High value for professional editors but adds export complexity. v1.5. |
| Clip compilation / highlight reel | New screen (reel editor). v2. |
| Live stream processing | Fundamentally different latency/accuracy constraints. v2. |
| Game-specific visual detectors | Plugin architecture exists; plugins are v2. |
| Multi-streamer support | One streamer per installation in v1. |
| Social media auto-publishing | Out of scope — export locally. |

---

## 14. Anti-Patterns (what we're NOT doing)

- **No 3D spatial navigation** (per user constraint). The "key light" spotlight is a 2D opacity tween.
- **No scroll-triggered reveals.** Desktop app, not a landing page.
- **No parallax.** Decorative, not functional.
- **No card grids for clips.** Clips are a ranked list, not a Pinterest board.
- **No modals for clip preview.** Click = play in the main player.
- **No "AI" visual language.** No neural net motifs, no glowing nodes, no "AI is thinking" spinners.
- **No shadcn/ui components or Lucide icons.** Custom Svelte components + custom SVG icons.
- **No purple gradients, no acid green, no cream paper.** The palette is decided.
- **No per-axis color coding.** All clips are the same red. Axes are differentiated by label and score.
- **No decorative blobs or atmospheric media.** Every pixel is information.
- **No feature list in the empty state.** One sentence, one action.
- **No "welcome" or onboarding flow.** The app opens to the library. Drop a file and go.

---

## 15. Design Tokens (Tailwind config)

```typescript
// frontend/tailwind.config.ts
export default {
  theme: {
    extend: {
      colors: {
        foundation: '#0B0B10',
        surface: {
          DEFAULT: '#16161F',
          2: '#24242F',
          3: '#2E2E3A',
        },
        border: {
          DEFAULT: '#2E2E3A',
          strong: '#3D3D4A',
        },
        text: {
          DEFAULT: '#FFFFFF',
          2: '#A1A1AA',
          3: '#71717A',
        },
        accent: {
          DEFAULT: '#CC0000',
          hover: '#E60000',
          deep: '#8B0000',
          glow: 'rgba(204, 0, 0, 0.20)',
        },
        success: '#22C55E',
        warning: '#EAB308',
        error: '#EF4444',
      },
      fontFamily: {
        display: ['Space Grotesk', 'system-ui', 'sans-serif'],
        body: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'monospace'],
      },
      fontSize: {
        'mono': ['12px', { lineHeight: '16px', letterSpacing: '0.02em' }],
        'body': ['13px', { lineHeight: '18px' }],
        'detail': ['14px', { lineHeight: '22px' }],
        'sub': ['15px', { lineHeight: '20px' }],
        'header': ['18px', { lineHeight: '24px', letterSpacing: '-0.01em' }],
        'title': ['24px', { lineHeight: '32px', letterSpacing: '-0.01em' }],
      },
      borderRadius: {
        'sm': '4px',
        'DEFAULT': '6px',
        'md': '8px',
        'lg': '12px',
      },
      transitionDuration: {
        'fast': '150ms',
        'DEFAULT': '200ms',
        'slow': '300ms',
      },
    },
  },
};
```

---

## 16. Open Questions

- **GPU selection (B4):** The user has a 4090+3090 workstation. Should v1 include a GPU picker in settings? Low effort, high value for multi-GPU users. Recommend: yes, add to settings as a simple dropdown.
- **Clip history/archive (B6):** The DB already stores all clips. A history view is cheap. Recommend: defer to v1.5 — the library already shows processed streams.
- **Watermark/branding (B2):** Not in v1. Streamers who want branding can add it in their NLE.
