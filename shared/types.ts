/**
 * SemaClip shared types — single source of truth.
 * Imported by frontend (SvelteKit) and backend (Deno).
 * The Python engine emits/consumes JSON matching EngineEvent / EngineCommand.
 */

// ── Domain enums ──────────────────────────────────────────────

export const AXES = ["hype", "humor", "skill", "awkward", "emotional", "tension", "reaction"] as const;
export type Axis = (typeof AXES)[number];

export const STREAM_STATUS = ["pending", "processing", "completed", "failed"] as const;
export type StreamStatus = (typeof STREAM_STATUS)[number];

export const JOB_STATUS = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

// ── Domain entities ───────────────────────────────────────────

export interface Stream {
  id: string;
  vodPath: string;
  chatPath: string | null;
  sourceUrl: string | null;
  title: string | null;
  streamer: string | null;
  game: string | null;
  duration: number | null; // seconds
  createdAt: string; // ISO
  status: StreamStatus;
}

export interface Job {
  id: string;
  streamId: string;
  status: JobStatus;
  position: number; // queue order, 0 = next
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  config: JobConfig;
}

export interface JobConfig {
  /** Override detection thresholds per axis, 0-1. */
  axisThresholds?: Partial<Record<Axis, number>>;
  /** Max clips to return. */
  maxClips?: number;
}

export interface Clip {
  id: string;
  jobId: string;
  streamId: string;
  axis: Axis;
  score: number; // 0-1
  startTime: number; // seconds from VOD start
  endTime: number;
  peakTime: number;
  justification: string | null;
  rank: number | null;
  exported: boolean;
  exportPath: string | null;
  rejected: boolean; // user discarded → implicit feedback
  /** Per-signal evidence from the engine. null = engine emitted no signals —
   *  the UI must show "no signal data", never fabricated bars. */
  signals: ClipSignals | null;
}

export interface Persona {
  id: string; // streamer name/id
  state: PersonaState;
  updatedAt: string;
  streamCount: number;
}

export interface PersonaState {
  axisWeights: Record<Axis, number>;
  thresholds: Partial<Record<Axis, number>>;
}

// ── Signal breakdown (clip evidence) ──────────────────────────

/**
 * Per-modality evidence for a clip. Absent modalities are 0 AND the
 * justification must not cite them (honesty rule: every nonzero signal is
 * backed by real computation, every zero is a real absence).
 */
export interface ClipSignals {
  /** Chat velocity+emote excitement at the peak second (0-1). */
  chatExcitement: number;
  /** Emote-weighted message velocity (0-1). */
  emoteVelocity: number;
  /** Audio RMS energy at the peak second (0-1). */
  audioEnergy: number;
  /** Fraction of the clip window covered by speech (0-1, from VAD/whisper). */
  speechCoverage: number;
}

// ── Engine IPC protocol (Python ↔ Deno) ───────────────────────
// Newline-delimited JSON over stdin/stdout.

export type EngineCommand =
  | { type: "start"; jobId: string; vodPath: string; chatPath: string | null; config: JobConfig; /** Destination for derived artifacts (SRT). */ artifactDir?: string | undefined; /** Worker budget from the CPU-usage tier. */ workers?: number | undefined }
  | { type: "cancel" };

export type EngineEvent =
  | { type: "progress"; jobId: string; phase: EnginePhase; percent: number; message?: string }
  | { type: "segment"; jobId: string; start: number; end: number; regime: string }
  | { type: "candidate"; jobId: string; axis: Axis; start: number; end: number; score: number; signals: ClipSignals }
  | {
      type: "clip";
      jobId: string;
      id: string;
      axis: Axis;
      start: number;
      end: number;
      peak: number;
      score: number;
      justification: string | null;
      signals: ClipSignals;
    }
  | { type: "complete"; jobId: string; clipsFound: number }
  | { type: "error"; jobId: string; phase: EnginePhase; message: string };

export const ENGINE_PHASES = [
  "audio_extraction",
  "transcription",
  "chat_parsing",
  "segmentation",
  "embedding",
  "llm_triage",
  "axis_scoring",
  "endpoint_resolution",
  "export_preparation",
] as const;
export type EnginePhase = (typeof ENGINE_PHASES)[number];

export const PHASE_LABELS: Record<EnginePhase, string> = {
  audio_extraction: "Audio extraction",
  transcription: "Transcription",
  chat_parsing: "Chat parsing",
  segmentation: "Adaptive segmentation",
  embedding: "Embedding extraction",
  llm_triage: "LLM triage",
  axis_scoring: "Per-axis scoring",
  endpoint_resolution: "Endpoint resolution",
  export_preparation: "Export preparation",
};

// ── REST API contracts ────────────────────────────────────────

// Stream import
export interface ImportByFileInput {
  vodPath: string;
  chatPath?: string | null;
  title?: string;
  streamer?: string;
}
export interface ImportByUrlInput {
  url: string; // Twitch VOD URL
  title?: string;
  streamer?: string;
}
export type ImportResult = { stream: Stream; downloadJobId: string | null };

// Stream list
export interface ListStreamsQuery {
  status?: StreamStatus;
}
export type ListStreamsResult = Stream[];

// Job queue
export interface QueueAction {
  type: "reorder" | "cancel";
  jobId: string;
  newPosition?: number; // for reorder
}

// Clips
export interface ListClipsQuery {
  axis?: Axis;
  rejected?: boolean;
}
export type ListClipsResult = Clip[];

// Export
export type ExportFormat = "mp4_h264" | "mp4_h265" | "webm";
export type AspectRatio = "16:9" | "9:16" | "1:1";
export type CropPosition = "center" | "top" | "bottom";

export interface CaptionStyle {
  enabled: boolean;
  preset: "bold-white" | "yellow" | "custom";
  position: "bottom" | "top";
  fontSize: number;
  backgroundOpacity: number; // 0-1
}

/** Named export bundle (P0-7): everything the export sheet needs in one unit. */
export interface ExportPreset {
  id: string;
  name: string;
  format: ExportFormat;
  aspectRatio: AspectRatio;
  cropPosition: CropPosition;
  captions: CaptionStyle;
  /** Filename template tokens: {date} {channel} {axis} {ts} {platform} {title}. */
  nameTemplate: string;
  createdAt: string;
}

export interface ExportClipInput {
  clipId: string;
  format: ExportFormat;
  aspectRatio: AspectRatio;
  cropPosition: CropPosition;
  captions: CaptionStyle;
  outputPath: string | null; // null = default location
  /** Filename without extension; null = server default (semaclip_axis_peaktime). */
  filename: string | null;
}
export interface ExportResult {
  clipId: string;
  exportPath: string;
  durationMs: number;
}

// ── WebSocket events (Deno → frontend) ────────────────────────
// The backend forwards engine events plus its own job-lifecycle events.

export type WsEvent =
  | EngineEvent
  | { type: "job_status"; jobId: string; status: JobStatus; streamId: string }
  | { type: "stream_status"; streamId: string; status: StreamStatus }
  | { type: "download_progress"; jobId: string; percent: number; bytesDownloaded: number; totalBytes: number };

// ── App settings ──────────────────────────────────────────────

export interface AppSettings {
  gpuDevice: number | null; // CUDA device index, null = auto
  exportDir: string;
  defaultAspectRatio: AspectRatio;
  defaultCaptions: CaptionStyle;
  engineBinaryPath: string | null;
  /**
   * How hard SemaClip may push the CPU ("I bought my CPU to use it" tiers).
   * slow = ≤25% of cores, medium = ≤50%, fast = all cores. Applied to the
   * transcription worker pool and whisper thread count; re-probed per job.
   */
  cpuUsage: "slow" | "medium" | "fast";
}
