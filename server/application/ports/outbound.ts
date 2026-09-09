import type {
  Stream,
  Job,
  Clip,
  Persona,
  StreamStatus,
  Axis,
  EngineEvent,
  EngineCommand,
  ClipSignals,
} from "shared/types";

// ── Persistence ports ──────────────────────────────────────────

export interface StreamRepository {
  save(stream: Stream): Promise<void>;
  findById(id: string): Promise<Stream | null>;
  list(status?: StreamStatus): Promise<Stream[]>;
  update(stream: Stream): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface JobRepository {
  save(job: Job): Promise<void>;
  findById(id: string): Promise<Job | null>;
  listByStream(streamId: string): Promise<Job[]>;
  listQueued(): Promise<Job[]>;
  listRunning(): Promise<Job[]>;
  update(job: Job): Promise<void>;
  delete(id: string): Promise<void>;
}

export interface ClipRepository {
  save(clip: Clip): Promise<void>;
  findById(id: string): Promise<Clip | null>;
  listByStream(streamId: string, filter?: { axis?: Axis; rejected?: boolean }): Promise<Clip[]>;
  update(clip: Clip): Promise<Clip>;
}

export interface PersonaRepository {
  findById(id: string): Promise<Persona | null>;
  save(persona: Persona): Promise<void>;
}

/** Key-value metadata store for derived artifacts (waveforms, chat density, thumbnails).
 *  Values are JSON strings. Composite key: (streamId, key). */
export interface StreamMetadataRepository {
  get(streamId: string, key: string): Promise<string | null>;
  set(streamId: string, key: string, value: string): Promise<void>;
  delete(streamId: string, key: string): Promise<void>;
  deleteAll(streamId: string): Promise<void>;
}

/** Manages per-stream directory structure for file artifacts.
 *  Layout: {dataDir}/streams/{streamId}/{vod,chat,waveform,thumbnails,exports}/ */
export interface StreamStorage {
  /** Root directory for a stream's artifacts. */
  streamDir(streamId: string): string;
  /** Path for a derived artifact (e.g. waveform.json, density.json). */
  artifactPath(streamId: string, name: string): string;
  /** Ensure all subdirectories exist for a stream. */
  ensureStreamDirs(streamId: string): Promise<void>;
  /** Delete all artifacts for a stream (called on stream deletion). */
  deleteStream(streamId: string): Promise<void>;
}

// ── Engine port (Python subprocess) ───────────────────────────

export interface EnginePort {
  start(command: EngineCommand): Promise<void>;
  cancel(): Promise<void>;
  /** Subscribe to engine events. Returns an unsubscribe function. */
  onEvent(handler: (event: EngineEvent) => void): () => void;
  isRunning(): boolean;
}

// ── VOD download port ──────────────────────────────────────────

export interface VodMetadata {
  title: string;
  streamer: string;
  game: string | null;
  duration: number;
}

export interface VodDownloadPort {
  fetchMetadata(url: string): Promise<VodMetadata>;
  download(
    url: string,
    destDir: string,
    onProgress: (p: { percent: number; bytesDownloaded: number; totalBytes: number }) => void,
  ): Promise<{ vodPath: string; chatPath: string | null }>;
  isSupported(url: string): boolean;
}

// ── Media probe port (ffprobe) ────────────────────────────────

export interface MediaProbePort {
  /** Probe a video file's duration in seconds. Returns null on failure. */
  probeDuration(vodPath: string): Promise<number | null>;
}

// ── FFmpeg export port ──────────────────────────────────────────

export interface FFmpegExportPort {
  exportClip(input: {
    vodPath: string;
    startTime: number;
    endTime: number;
    outputPath: string;
    format: "mp4_h264" | "mp4_h265" | "webm";
    aspectRatio: "16:9" | "9:16" | "1:1";
    cropPosition: "center" | "top" | "bottom";
    captions: {
      enabled: boolean;
      srtPath: string | null;
      preset: "bold-white" | "yellow" | "custom";
      position: "bottom" | "top";
      fontSize: number;
      backgroundOpacity: number;
    };
  }): Promise<{ exportPath: string; durationMs: number }>;
}

/** Key-value settings store (the `settings` table — v1 created it, nothing used it). */
export interface SettingsRepository {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

// ── Event bus port ─────────────────────────────────────────────

export type EventHandler<T = unknown> = (event: T) => void;

export interface EventBus {
  publish<T>(topic: string, event: T): void;
  subscribe<T>(topic: string, handler: EventHandler<T>): () => void;
}

export const ENGINE_EVENT_TOPIC = "engine:event";
export const JOB_STATUS_TOPIC = "job:status";
export const STREAM_STATUS_TOPIC = "stream:status";
export const DOWNLOAD_PROGRESS_TOPIC = "download:progress";

// ── Clock note: no Clock port — domain code uses `new Date()` directly. A
// clock abstraction earned nothing at this size (v1 declared one, nothing
// implemented it). Reintroduce only when a test genuinely needs frozen time.

// ── File system port ───────────────────────────────────────────

export interface FileSystemPort {
  exists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  joinPath(...segments: string[]): string;
}
