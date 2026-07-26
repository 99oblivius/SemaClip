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
  listByJob(jobId: string): Promise<Clip[]>;
  listByStream(streamId: string, filter?: { axis?: Axis; rejected?: boolean }): Promise<Clip[]>;
  update(clip: Clip): Promise<void>;
}

export interface PersonaRepository {
  findById(id: string): Promise<Persona | null>;
  save(persona: Persona): Promise<void>;
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

// ── Clock port (testability) ───────────────────────────────────

export interface Clock {
  now(): Date;
  isoNow(): string;
}

// ── File system port ───────────────────────────────────────────

export interface FileSystemPort {
  exists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  joinPath(...segments: string[]): string;
}
