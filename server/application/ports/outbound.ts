import type {
  SourceMedia,
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

// ── Export list & batch repositories ───────────────────────────

/** A row of the export list, as stored. The clip itself is resolved by the caller. */
export interface ExportListRow {
  clipId: string;
  addedAt: string;
  position: number;
  removedAt: string | null;
}

/**
 * The durable record of "which clips the user means to export".
 *
 * References only. Nothing about a clip's content is stored here — see `export_list` in the schema
 * for why a copy would be a second owner of the same truth.
 */
export interface ExportListRepository {
  /** Add references, keeping the existing order. Re-adding a removed clip RESTORES its position. */
  add(clipIds: string[]): Promise<void>;
  /** Live entries, in order. Removed ones are excluded. */
  list(): Promise<ExportListRow[]>;
  /** Soft-remove: sets `removed_at`, never DELETE — the history is what preserves a re-add's place. */
  remove(clipId: string): Promise<void>;
  removeMany(clipIds: string[]): Promise<void>;
  clear(): Promise<void>;
  /** Clip ids live on the list, for the UI's "already added" state. */
  liveIds(): Promise<string[]>;
}

/**
 * The durable export batch.
 *
 * Durable on purpose: a batch interrupted by a restart must resume. See the `export_jobs` table for
 * the one-row-per-clip rule and why `artifact_path` is recorded.
 */
export interface ExportJobRepository {
  /** Insert or replace a queued item at the end. Never creates a second row for one clip. */
  upsertQueued(row: {
    clipId: string;
    profileJson: string;
    outputDir: string | null;
    filename: string | null;
    position: number;
    /** The BATCH's stamp, shared by every row of one enqueue — see the adapter for why. */
    requestedAt: string;
  }): Promise<void>;
  list(): Promise<ExportJobRecord[]>;
  get(clipId: string): Promise<ExportJobRecord | null>;
  /** The next item to run: lowest position among `queued`. */
  nextQueued(): Promise<ExportJobRecord | null>;
  markRunning(clipId: string, startedAt: string): Promise<void>;
  /**
   * Progress of the running item. Deliberately does NOT touch `status`, so a slow sample cannot
   * resurrect a cancelled row — the same class of bug as a cancelled download writing `done`.
   */
  setProgress(clipId: string, phase: string | null, percent: number, artifactPath: string | null): Promise<void>;
  markCompleted(clipId: string, exportPath: string, completedAt: string): Promise<void>;
  markFailed(clipId: string, error: string, completedAt: string): Promise<void>;
  markCancelled(clipId: string, completedAt: string): Promise<void>;
  /**
   * Forget a deleted artifact path.
   *
   * Called after a cancel removes the partial file, so the row does not keep pointing at something
   * that no longer exists — and so a second cancel does not re-report the same deletion.
   */
  clearArtifactPath(clipId: string): Promise<void>;
  /**
   * Clear the items a cancel asked to drop, keeping the finished and failed history.
   *
   * Returns what it dropped so the caller can delete each item's `artifactPath`: this is the
   * handover that lets a cancelled partial file be removed without re-deriving its name.
   */
  dropIncomplete(): Promise<ExportJobRecord[]>;
  /** Batch totals, so the progress stats are computed from the database and not re-counted in the UI. */
  counts(): Promise<Record<string, number>>;
}

/** One export batch row. */
export interface ExportJobRecord {
  clipId: string;
  status: string;
  position: number;
  profileJson: string;
  outputDir: string | null;
  filename: string | null;
  artifactPath: string | null;
  phase: string | null;
  percent: number;
  requestedAt: string;
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
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
  /** External markers for the VOD (P1-8 v1: Twitch `/marker` entries). */
  fetchMarkers(url: string): Promise<{ t: number; label: string; source: string }[]>;
}

// ── Media probe port (ffprobe) ────────────────────────────────

export interface MediaProbePort {
  /** Probe a video file's duration in seconds. Returns null on failure. */
  probeDuration(vodPath: string): Promise<number | null>;
  /**
   * Probe the source video's codec, bitrate, fps and dimensions.
   *
   * Separate from `probeDuration` because it answers a different question and is needed by the export
   * UI: "the original bitrate is used" and "this is a transcode, so a bitrate must be forced" both
   * depend on the source's own facts. Returns null when the probe fails — an unmeasured source is
   * reported as unmeasured rather than defaulted.
   */
  probeSourceMedia(vodPath: string): Promise<SourceMedia | null>;
}

// ── FFmpeg export port ──────────────────────────────────────────

export interface FFmpegExportPort {
  /**
   * Cut a clip out of the video and encode it to the profile's container/codec.
   *
   * The PROFILE carries every output decision (container, codecs, cap, quality, aspect, captions) so
   * there is one source of truth: a second argument repeating any of it is how the two drift.
   */
  exportClip(input: {
    vodPath: string;
    startTime: number;
    endTime: number;
    outputPath: string;
    profile: import("shared/types").ExportProfile;
    /** The transcript to burn in, resolved by the caller; null when there is none. */
    srtPath: string | null;
    /**
     * Where the run has reached, in ENCODED SECONDS of the clip. Called about once a second.
     *
     * Seconds rather than a fraction: the adapter holds the ffmpeg process and the caller holds the
     * clip window, so converting here would duplicate the duration the caller already knows.
     */
    onProgress?: ((p: { encodedSec: number }) => void) | undefined;
    /** Cancellation. Aborting kills the encoder; the caller deletes the partial file it recorded. */
    signal?: AbortSignal | undefined;
  }): Promise<{ exportPath: string; durationMs: number; /** Which encoder actually ran. */ backend: string }>;
  /** Generate a low-res proxy proxy (P0-10). Null vodPath output = reuse source dir. */
  generateProxy(input: {
    vodPath: string;
    outputPath: string;
    /** Target height in px (width derived from aspect). */
    height: number;
  }): Promise<{ proxyPath: string; durationMs: number }>;
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

/**
 * The export list or batch changed — the UI should re-read it.
 *
 * Same contract as STREAM_CHANGED_TOPIC: the payload says WHAT changed and the client refetches,
 * because duplicating the batch's state into an event would make a second source of truth for it.
 * The one exception is per-item progress, which rides its own topic with numbers attached — see
 * `EXPORT_PROGRESS_TOPIC`.
 */
export const EXPORT_CHANGED_TOPIC = "export:changed";

/**
 * One export item's progress, carrying the numbers.
 *
 * Progress is the case where the thin-payload rule does not apply: an ffmpeg run emits a sample
 * every second, and answering each one with a refetch would put the whole batch's state on the wire
 * sixty times a minute to move a bar. The authoritative state stays in the database; this is the
 * fast path, and a dropped event costs nothing because the next sample corrects it.
 */
export const EXPORT_PROGRESS_TOPIC = "export:progress";

/**
 * Something about a stream's stored state changed and the UI should re-read it.
 *
 * This exists because every artifact mutation (delete chat, delete video, attach a piece,
 * finish a download) changed the database and then told the client NOTHING. The client
 * compensated by polling every 30 seconds when idle, which is why deleting chat took half a
 * minute to show up in the panel that had just been told to expect it. Publishing one event
 * replaces the wait with a refetch.
 *
 * The payload is deliberately thin — an id and what changed — because the event's job is
 * "re-read", not "here is the new state". Duplicating state into the event would create a
 * second source of truth for it.
 */
export const STREAM_CHANGED_TOPIC = "stream:changed";

/** Topics the WebSocket forwards to clients. Anything not listed is server-internal. */
export interface StreamChangedEvent {
  streamId: string;
  /** What changed, for a client that wants to invalidate narrowly. */
  reason: "chat" | "video" | "proxy" | "download" | "metadata";
}

// ── Clock note: no Clock port — domain code uses `new Date()` directly. A
// clock abstraction earned nothing at this size (v1 declared one, nothing
// implemented it). Reintroduce only when a test genuinely needs frozen time.

// ── File system port ───────────────────────────────────────────

export interface FileSystemPort {
  exists(path: string): Promise<boolean>;
  ensureDir(path: string): Promise<void>;
  remove(path: string): Promise<void>;
  joinPath(...segments: string[]): string;
  /**
   * The path in the form the OS expects, for anything that LEAVES this process — a
   * spawned argument, a shell command, or a path shown to the user. In-process Deno APIs
   * accept "/" on every platform, but external programs may not: `explorer.exe` needs
   * backslashes, and the Open Folder button was a silent no-op because it was handed a
   * forward-slashed path.
   */
  nativePath(path: string): string;
  /** Immediate children (files only), names sorted. Folder import scan. */
  listFiles(dir: string): Promise<string[]>;
}
