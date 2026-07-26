import type {
  Stream,
  Job,
  Clip,
  ImportByFileInput,
  ImportByUrlInput,
  ImportResult,
  ListStreamsQuery,
  JobConfig,
  Axis,
  ExportClipInput,
  ExportResult,
  QueueAction,
  AppSettings,
} from "shared/types";

// ── Stream use cases ───────────────────────────────────────────

export interface ImportStreamByFile {
  execute(input: ImportByFileInput): Promise<ImportResult>;
}

export interface ImportStreamByUrl {
  execute(input: ImportByUrlInput): Promise<ImportResult>;
}

export interface ListStreams {
  execute(query?: ListStreamsQuery): Promise<Stream[]>;
}

export interface GetStream {
  execute(streamId: string): Promise<Stream | null>;
}

export interface DeleteStream {
  execute(streamId: string): Promise<void>;
}

// ── Job use cases ──────────────────────────────────────────────

export interface StartJob {
  execute(streamId: string, config?: JobConfig): Promise<Job>;
}

export interface CancelJob {
  execute(jobId: string): Promise<Job>;
}

export interface ListJobs {
  execute(streamId: string): Promise<Job[]>;
}

export interface GetJob {
  execute(jobId: string): Promise<Job | null>;
}

export interface ManageQueue {
  execute(action: QueueAction): Promise<Job[]>;
}

// ── Clip use cases ─────────────────────────────────────────────

export interface ListClips {
  execute(streamId: string, filter?: { axis?: Axis; rejected?: boolean }): Promise<Clip[]>;
}

export interface GetClip {
  execute(clipId: string): Promise<Clip | null>;
}

export interface RejectClip {
  execute(clipId: string): Promise<Clip>;
}

// ── Export use case ────────────────────────────────────────────

export interface ExportClip {
  execute(input: ExportClipInput): Promise<ExportResult>;
}

// ── Settings use cases ─────────────────────────────────────────

export interface GetSettings {
  execute(): Promise<AppSettings>;
}

export interface UpdateSettings {
  execute(settings: Partial<AppSettings>): Promise<AppSettings>;
}
