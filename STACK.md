# SemaClip — Technology Stack v1

> The opinionated, fully-decided technology stack for SemaClip. Every layer is chosen, justified, and structured. No undecided options remain.

---

## 1. Stack Summary

```
┌──────────────────────────────────────────────────────┐
│  Native Window (Deno Desktop + CEF)                    │
│  ┌────────────────────────────────────────────────┐   │
│  │  CEF Webview (full Chromium)                   │   │
│  │  ┌──────────────────────────────────────────┐ │   │
│  │  │  SvelteKit SPA                          │ │   │
│  │  │  ├── Svelte 5 (runes)                   │ │   │
│  │  │  ├── Tailwind CSS                       │ │   │
│  │  │  ├── GSAP (use:action)                  │ │   │
│  │  │  ├── TanStack Query (server state)      │ │   │
│  │  │  ├── HTML5 <video> (clip preview)       │ │   │
│  │  │  └── Canvas + SVG (timeline)            │ │   │
│  │  └──────────────┬───────────────────────────┘ │   │
│  └─────────────────┼──────────────────────────────┘   │
│  ┌─────────────────▼──────────────────────────────┐   │
│  │  Deno Backend (in-process bindings)            │   │
│  │  ├── Deno.serve() (HTTP API + WebSocket)      │   │
│  │  ├── Deno.Command (Python subprocess mgmt)     │   │
│  │  ├── better-sqlite3 + Drizzle ORM             │   │
│  │  ├── Deno.Tray (system tray)                  │   │
│  │  ├── Native file dialogs                      │   │
│  │  ├── File I/O (VOD import, clip export)       │   │
│  │  └── Auto-update (bsdiff)                     │   │
│  └─────────────────┬──────────────────────────────┘   │
└─────────────────────┼──────────────────────────────────┘
                      │ stdin/stdout JSON (newline-delimited)
┌─────────────────────▼──────────────────────────────────┐
│  Python ML Engine (PyInstaller binary)                  │
│  ├── faster-whisper (transcription)                    │
│  ├── PyTorch (embeddings, models)                      │
│  ├── sentence-transformers                             │
│  └── FFmpeg (clip export)                               │
└────────────────────────────────────────────────────────┘
```

**Two binaries distributed:**
1. `semaclip` — Deno Desktop binary (~150MB with CEF, contains frontend + backend + native window)
2. `semaclip-engine` — PyInstaller binary (~200-400MB, contains Python + ML models)

**Languages:** TypeScript (frontend + backend) + Python (ML only)

---

## 2. Decision Rationale

### 2.1 Why Not Tauri / Electron / Wails / Slint?

| Option | Eliminated because |
|---|---|
| **Slint** | No mature video playback component. Loses web ecosystem (Tailwind, GSAP, devtools). Dealbreaker for a clip tool with timelines. |
| **Electron** | Bundles 150MB Chromium + Node.js runtime. Poor developer experience (Node main process, IPC complexity, security model). You have no Electron experience. |
| **Tauri (wry/system webview)** | Linux WebKitGTK instability — rendering varies by distro. You explicitly rejected this. |
| **Tauri + cef-rs** | cef-rs is in early development, not production-ready. Betting on an unfinished feature. |
| **Wails** | Same system webview issue as Tauri on Linux. v3 is pre-release. |
| **Pure browser (no desktop shell)** | "Open in browser" is poor UX for non-technical streamers. No native file dialogs, no system tray, no auto-update. |

### 2.2 Why Deno Desktop + CEF?

Deno Desktop (shipped in Deno 2.9, June 2026) provides:

- **CEF backend**: Identical Chromium rendering on macOS, Windows, and Linux. No WebKitGTK fragmentation.
- **Native window**: Feels like a real application, not a browser tab.
- **SvelteKit auto-detection**: Point `deno desktop` at a SvelteKit project and it runs — dev server with HMR in development, embedded static build in production.
- **Cross-compilation**: Build for all three platforms from one machine. Pre-built CEF backends downloaded automatically.
- **In-process bindings**: Backend ↔ webview communication goes through in-process channels, not socket IPC. No cross-process round-trip.
- **Built-in features**: System tray, native file dialogs, notifications, DevTools, auto-update (bsdiff patches with rollback).
- **Not Electron**: No Node.js main process, no IPC complexity, no security model overhead. Deno's runtime is leaner.
- **Same language as frontend**: TypeScript on both sides means shared types natively — no codegen, no drift.

### 2.3 Why TypeScript/Deno for Backend (Not Rust)?

The ML engine is Python regardless — the backend is purely an orchestration layer (HTTP API, WebSocket, subprocess management, database, file I/O). For this I/O-bound workload:

- Deno's `Deno.Command` provides clean subprocess management with stdout streaming
- `Deno.serve()` provides HTTP + WebSocket natively
- Same language as frontend = shared TypeScript types (no ts-rs codegen)
- Deno Desktop's in-process bindings eliminate the IPC boundary that would exist between a Rust backend and the webview
- Cross-compilation is trivial (vs Rust's cross-compile toolchain complexity)
- The performance difference is negligible — the bottleneck is Python ML (17 min), not the backend

### 2.4 Why Svelte 5 + SvelteKit?

- **Fine-grained reactivity (runes)**: `currentTime` updates at 30fps during video scrubbing update only the bound DOM nodes — no component tree re-render
- **Cleanest GSAP integration**: `use:action` directive wraps GSAP on mount, cleans up on destroy. No virtual DOM fighting imperative animation.
- **Smallest bundle**: ~10KB runtime
- **SvelteKit SPA mode**: Routing, code splitting, Vite build
- **Existing experience**: Svelte is in your skill set
- **Bespoke design**: Svelte's simplicity encourages custom design over component library defaults — aligns with "not AI-looking" goal

### 2.5 Why Not Qwik?

Qwik's core innovation is resumability — eliminating hydration. This matters for slow networks (2-5s hydration tax). But SemaClip is a **local application served from localhost**:

- No slow network — JS bundle transfers at memory speed
- No SSR — it's a pure SPA, nothing to hydrate
- Qwik's advantage is neutralized by local deployment

What remains is a signals-based framework with a small ecosystem and no experience advantage.

---

## 3. Project Structure

```
SemaClip/
├── frontend/                     # SvelteKit SPA
│   ├── package.json
│   ├── svelte.config.js
│   ├── vite.config.ts
│   ├── tailwind.config.ts
│   ├── src/
│   │   ├── routes/               # SvelteKit routes (SPA mode)
│   │   │   ├── +layout.svelte    # App shell, navigation
│   │   │   ├── +page.svelte      # Dashboard / stream list
│   │   │   ├── stream/
│   │   │   │   └── [id]/
│   │   │   │       └── +page.svelte  # Stream detail + clip review
│   │   │   └── settings/
│   │   │       └── +page.svelte
│   │   ├── lib/
│   │   │   ├── components/
│   │   │   │   ├── Timeline.svelte        # Canvas + SVG timeline
│   │   │   │   ├── VideoPlayer.svelte     # HTML5 video + custom controls
│   │   │   │   ├── ClipCard.svelte        # Clip result card
│   │   │   │   ├── ClipGrid.svelte        # Ranked clip grid
│   │   │   │   ├── ProgressOverlay.svelte # Job progress display
│   │   │   │   ├── AxisBadge.svelte       # Moment type badge
│   │   │   │   └── ...
│   │   │   ├── stores/
│   │   │   │   ├── job.ts                 # WebSocket job progress store
│   │   │   │   ├── player.ts              # Video player state
│   │   │   │   └── settings.ts            # App settings store
│   │   │   ├── api/
│   │   │   │   └── client.ts              # TanStack Query setup
│   │   │   ├── actions/
│   │   │   │   ├── gsap.ts                # GSAP use:action directives
│   │   │   │   └── canvas.ts              # Canvas binding action
│   │   │   └── utils/
│   │   └── app.html
│   └── static/
│   │   └── assets/
│
├── server/                       # Deno backend
│   ├── deno.json                 # Deno config + desktop config
│   ├── main.ts                   # Entry: window creation, server start
│   ├── api/
│   │   ├── routes.ts             # REST API route definitions
│   │   ├── streams.ts            # Stream endpoints
│   │   ├── jobs.ts               # Job endpoints
│   │   ├── clips.ts              # Clip endpoints
│   │   └── settings.ts           # Settings endpoints
│   ├── ws/
│   │   └── handler.ts            # WebSocket handler (progress streaming)
│   ├── python/
│   │   └── manager.ts            # Python subprocess lifecycle + stdout streaming
│   ├── db/
│   │   ├── schema.ts             # Drizzle schema definitions
│   │   ├── client.ts             # better-sqlite3 + Drizzle setup
│   │   └── migrations/          # SQL migrations
│   └── config.ts                 # App configuration (figment-style layering)
│
├── engine/                       # Python ML engine
│   ├── engine.py                 # Entry point (stdin/stdout IPC)
│   ├── semaclip/
│   │   ├── __init__.py
│   │   ├── engine.py             # Main pipeline orchestrator
│   │   ├── persona.py            # Cold-start persona model
│   │   ├── segmentation.py       # Adaptive temporal segmentation
│   │   ├── encoder.py            # Universal stream encoder
│   │   ├── kalman.py             # Online state tracking
│   │   ├── axes/
│   │   │   ├── __init__.py
│   │   │   ├── base.py           # Base axis detector interface
│   │   │   ├── hype.py
│   │   │   ├── humor.py
│   │   │   ├── skill.py
│   │   │   ├── awkward.py
│   │   │   ├── emotional.py
│   │   │   └── tension.py
│   │   ├── chat.py               # Chat parsing, classification, excitement signal
│   │   ├── voice.py              # Voice analysis: prosody, topic boundaries
│   │   ├── audio.py              # Audio scene analysis
│   │   ├── endpoints.py          # Endpoint resolution logic
│   │   ├── ranking.py            # Cross-axis ranking + diversity
│   │   ├── feedback.py           # Implicit feedback extraction
│   │   ├── export.py             # FFmpeg clip export
│   │   └── config.py             # Configuration, defaults, persistence
│   ├── pyproject.toml
│   └── requirements.txt
│
├── shared/                       # Shared TypeScript types
│   └── types.ts                  # API contracts, IPC protocol, domain models
│
├── data/                         # VODs and chat (gitignored)
│   ├── training/
│   └── testing/
│
├── ARCHITECTURE.md               # ML pipeline architecture
├── STACK.md                      # This document
├── README.md
└── .gitignore
```

---

## 4. Technology Inventory

### 4.1 Frontend

| Technology | Version | Purpose |
|---|---|---|
| Svelte | 5.x | UI framework (runes reactivity) |
| SvelteKit | 2.x | Meta-framework (SPA mode, routing, Vite) |
| Vite | 6.x | Build tool (via SvelteKit) |
| Tailwind CSS | 4.x | Styling |
| GSAP | 3.x | Animation (via Svelte `use:action`) |
| TanStack Query | 5.x | Server state (REST API caching, invalidation) |
| TypeScript | 5.x | Type safety |

### 4.2 Backend (Deno)

| Technology | Version | Purpose |
|---|---|---|
| Deno | 2.9+ | Runtime + desktop framework |
| Deno Desktop | 2.9+ | Native window + CEF backend |
| better-sqlite3 | 11.x | SQLite database (synchronous, fast) |
| Drizzle ORM | 0.36+ | Type-safe schema, migrations, query builder |
| TypeScript | 5.x | Type safety (shared with frontend) |

### 4.3 ML Engine (Python)

| Technology | Version | Purpose |
|---|---|---|
| Python | 3.12+ | ML runtime |
| faster-whisper | 1.x | Audio transcription (large-v3 model) |
| PyTorch | 2.x | Tensor computation, model inference |
| sentence-transformers | 3.x | Sentence embeddings (all-MiniLM-L6-v2) |
| CLAP / Wav2Vec2 | — | Audio event detection / embeddings |
| DistilBERT | — | Chat sentiment classification |
| NumPy / SciPy | — | Signal processing, statistics |
| scikit-learn | — | Change-point detection, Kalman filter |
| FFmpeg | — | Video processing, clip export |
| PyInstaller | 6.x | Binary packaging |

### 4.4 LLM (Local Inference)

| Technology | Purpose |
|---|---|
| Qwen 2.5 7B or Llama 3.1 8B | Semantic triage of candidate moments |
| Served via local inference (vLLM, llama.cpp, or TabbyAPI) | ~80 tok/s on RTX 4090 |

---

## 5. Database Schema

SQLite via better-sqlite3 + Drizzle ORM. Single file (`semaclip.db`), WAL mode.

### Schema

```typescript
// server/db/schema.ts
import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const streams = sqliteTable("streams", {
  id: text("id").primaryKey(),              // UUID
  vodPath: text("vod_path").notNull(),
  chatPath: text("chat_path"),
  title: text("title"),
  streamer: text("streamer"),
  game: text("game"),
  duration: real("duration"),                // seconds
  createdAt: text("created_at").notNull(),   // ISO timestamp
  status: text("status").default("pending"), // pending|processing|completed|failed
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  streamId: text("stream_id").notNull().references(() => streams.id),
  status: text("status").default("queued"),  // queued|running|completed|failed
  startedAt: text("started_at"),
  completedAt: text("completed_at"),
  error: text("error"),
  configJson: text("config_json"),            // job-specific config override
});

export const clips = sqliteTable("clips", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull().references(() => jobs.id),
  streamId: text("stream_id").notNull().references(() => streams.id),
  axis: text("axis").notNull(),               // hype|humor|skill|awkward|emotional|tension
  score: real("score").notNull(),             // 0.0-1.0 (percentile-based)
  startTime: real("start_time").notNull(),    // seconds from VOD start
  endTime: real("end_time").notNull(),
  peakTime: real("peak_time"),
  justification: text("justification"),       // LLM-generated explanation
  rank: integer("rank"),                      // final ranking position
  exported: integer("exported").default(0),
  exportPath: text("export_path"),
});

export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),                // streamer name or ID
  stateJson: text("state_json").notNull(),    // Kalman filter state, axis weights
  updatedAt: text("updated_at").notNull(),
  streamCount: integer("stream_count").default(0),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),             // JSON-encoded value
});
```

---

## 6. IPC Protocol

### 6.1 Deno → Python (stdin, newline-delimited JSON)

```typescript
// Job start
{ "type": "job", "id": "abc-123", "vod_path": "/path/to/video.mp4", "chat_path": "/path/to/chat.json" }

// Cancel running job
{ "type": "cancel" }
```

### 6.2 Python → Deno (stdout, newline-delimited JSON)

```typescript
// Progress update
{ "type": "progress", "phase": "transcription", "percent": 0.45, "message": "Transcribing..." }

// Segment detected
{ "type": "segment", "start": 120.5, "end": 185.3, "regime": "gameplay" }

// Candidate moment detected
{ "type": "candidate", "axis": "hype", "start": 142.0, "end": 168.5, "score": 0.87 }

// Final clip (after ranking + endpoint resolution)
{ "type": "clip", "id": "clip-1", "axis": "hype", "start": 142.0, "end": 168.5, "score": 0.87, "justification": "..." }

// Job complete
{ "type": "complete", "clips_found": 12 }

// Error
{ "type": "error", "message": "CUDA OOM", "phase": "embedding" }
```

### 6.3 Deno → Frontend (WebSocket)

The Deno backend forwards Python stdout events to WebSocket subscribers. The frontend receives the same JSON events and updates the UI via Svelte stores.

### 6.4 Frontend → Deno (REST API)

Standard HTTP REST endpoints for CRUD operations (streams, jobs, clips, settings). TanStack Query manages caching and invalidation.

---

## 7. Shared Types

```typescript
// shared/types.ts

// Domain models
export type Axis = "hype" | "humor" | "skill" | "awkward" | "emotional" | "tension";

export interface Stream {
  id: string;
  vodPath: string;
  chatPath?: string;
  title?: string;
  streamer?: string;
  game?: string;
  duration?: number;
  createdAt: string;
  status: "pending" | "processing" | "completed" | "failed";
}

export interface Job {
  id: string;
  streamId: string;
  status: "queued" | "running" | "completed" | "failed";
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface Clip {
  id: string;
  jobId: string;
  streamId: string;
  axis: Axis;
  score: number;
  startTime: number;
  endTime: number;
  peakTime?: number;
  justification?: string;
  rank?: number;
  exported: boolean;
  exportPath?: string;
}

// IPC protocol (Python ↔ Deno)
export type EngineEvent =
  | { type: "progress"; phase: string; percent: number; message?: string }
  | { type: "segment"; start: number; end: number; regime: string }
  | { type: "candidate"; axis: Axis; start: number; end: number; score: number }
  | { type: "clip"; id: string; axis: Axis; start: number; end: number; score: number; justification?: string }
  | { type: "complete"; clips_found: number }
  | { type: "error"; message: string; phase: string };

export type EngineCommand =
  | { type: "job"; id: string; vod_path: string; chat_path?: string }
  | { type: "cancel" };
```

---

## 8. Runtime Estimates

### 4-hour VOD, RTX 4090

| Phase | Time | Where |
|---|---|---|
| Audio extraction + transcription | ~8 min | Python (faster-whisper, GPU) |
| Chat parsing | ~30s | Python |
| Adaptive segmentation | ~1 min | Python (CPU) |
| Embedding extraction | ~4 min | Python (GPU) |
| LLM triage (candidates) | ~2 min | Python (local LLM, GPU) |
| Per-axis scoring | ~1 min | Python (CPU) |
| Endpoint resolution + export | ~1 min | Python (FFmpeg) |
| **Total** | **~17 min** | Python engine |

The Deno backend adds negligible overhead (subprocess management + WebSocket streaming).

---

## 9. Distribution

### 9.1 Build

```bash
# Build the Deno Desktop binary (cross-compilable)
deno desktop --backend cef --all-targets server/main.ts

# Build the Python ML engine binary
cd engine && pyinstaller --onefile engine.py
```

### 9.2 Output

| Binary | Size (est.) | Contains |
|---|---|---|
| `semaclip` | ~150MB | Deno runtime + CEF + SvelteKit build + backend |
| `semaclip-engine` | ~200-400MB | Python + ML libraries (models downloaded separately) |

### 9.3 Model Download

ML models (Whisper large-v3, sentence-transformers, etc.) are too large to bundle. On first run, the Python engine downloads them to a local cache directory (`~/.semaclip/models/`).

### 9.4 Auto-Update

Deno Desktop provides built-in bsdiff auto-update. Ship a `latest.json` manifest; the runtime polls, applies patches, and rolls back on failed launches. The Python engine can be updated separately by replacing the binary.

---

## 10. Development Workflow

### 10.1 Frontend Development

```bash
cd frontend
npm run dev    # SvelteKit dev server with HMR (Vite)
```

Deno Desktop runs the SvelteKit dev server with `--hmr` during development.

### 10.2 Backend Development

```bash
cd server
deno task dev   # Run Deno server with file watching
```

### 10.3 ML Engine Development

```bash
cd engine
python engine.py --job test --vod ../data/training/video.mp4 --chat ../data/training/chat.json
```

Test the IPC protocol directly by piping JSON to stdin and reading stdout.

### 10.4 Full Stack Development

```bash
# Terminal 1: ML engine (standalone test)
cd engine && python engine.py

# Terminal 2: Deno Desktop (dev mode, HMR)
cd server && deno desktop --hmr main.ts
```

---

## 11. What We Explicitly Are NOT Building (v1)

- **Real-time live stream processing.** V1 is post-hoc VOD analysis.
- **Automatic social media publishing.** Export clips locally.
- **Game-specific visual detectors.** Plugin architecture exists; plugins are v2.
- **Training the universal encoder in v1.** Architecture defined; pretraining is a separate project.
- **Multi-streamer support in a single instance.** One streamer per installation.
- **A web UI hosted on a server.** This is a local desktop application.

---

## 12. Open Questions for v2

- **Live mode**: Real-time inference during the stream.
- **Cross-stream memory**: Long-term memory of clip quality across streams.
- **Visual game-state detection**: OCR on kill feeds, HUD detection, game-specific event APIs.
- **Editor-in-the-loop explicit feedback**: Review UI for keep/discard labels.
- **Collaborative filtering**: Transfer preferences between similar streamers.
- **Model fine-tuning pipeline**: Train the universal stream encoder on user's clips.
