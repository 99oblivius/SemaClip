import { createDb } from "@/adapters/outbound/persistence/mod.ts";
import {
  SqliteStreamRepository,
  SqliteJobRepository,
  SqliteClipRepository,
  SqlitePersonaRepository,
  SqliteStreamMetadataRepository,
  SqliteSettingsRepository,
  DenoStreamStorage,
} from "@/adapters/outbound/persistence/mod.ts";
import { InProcessEventBus } from "@/adapters/outbound/eventbus/mod.ts";
import { PythonEngineAdapter } from "@/adapters/outbound/engine/mod.ts";
import { DetectionEngineAdapter } from "@/adapters/outbound/engine/DetectionEngineAdapter.ts";
import type { WhisperPaths } from "@/adapters/outbound/transcribe/TranscribeAdapter.ts";
import { DEFAULT_SETTINGS, cpuWorkers } from "@/application/use-cases/SettingsUseCase.ts";
import { TwitchDlAdapter } from "@/adapters/outbound/vod/mod.ts";
import { FFmpegAdapter } from "@/adapters/outbound/ffmpeg/mod.ts";
import {
  ImportStreamByFileUseCase,
  ImportStreamByUrlUseCase,
  ListStreamsUseCase,
  GetStreamUseCase,
  DeleteStreamUseCase,
  UpdateStreamUseCase,
  AttachChatUseCase,
  StartJobUseCase,
  CancelJobUseCase,
  ListJobsUseCase,
  ListClipsUseCase,
  GetClipUseCase,
  RejectClipUseCase,
  UpdateClipUseCase,
  ExportClipUseCase,
  ManageQueueUseCase,
  SettingsUseCase,
} from "@/application/use-cases/mod.ts";
import type { FileSystemPort } from "@/application/ports/outbound.ts";
import type { HttpDeps } from "@/adapters/inbound/http/routes.ts";

/** Deno native filesystem adapter implementing FileSystemPort. */
class DenoFileSystem implements FileSystemPort {
  async exists(path: string): Promise<boolean> {
    try {
      await Deno.stat(path);
      return true;
    } catch {
      return false;
    }
  }
  async ensureDir(path: string): Promise<void> {
    await Deno.mkdir(path, { recursive: true });
  }
  async remove(path: string): Promise<void> {
    await Deno.remove(path, { recursive: true });
  }
  joinPath(...segments: string[]): string {
    return segments.join("/").replace(/\/+/g, "/");
  }
}

export interface AppConfig {
  dbPath: string;
  dataDir: string;
  cacheDir: string;
  exportDir: string;
  engineBinaryPath: string;
  gpuDevice: number | null;
  /** When set, the in-process TS detection engine is used with these native paths. */
  detectionWhisper?: WhisperPaths | undefined;
}

export interface AppContainer {
  httpDeps: HttpDeps;
  bus: InProcessEventBus;
}

export function buildContainer(config: AppConfig): AppContainer {
  const db = createDb(config.dbPath);
  const bus = new InProcessEventBus();
  const fs = new DenoFileSystem();

  // Outbound adapters
  const streamRepo = new SqliteStreamRepository(db);
  const jobRepo = new SqliteJobRepository(db);
  const clipRepo = new SqliteClipRepository(db);
  const personaRepo = new SqlitePersonaRepository(db);
  const metadataRepo = new SqliteStreamMetadataRepository(db);
  const streamStorage = new DenoStreamStorage(config.dataDir);
  const vodDownloader = new TwitchDlAdapter();
  const ffmpeg = new FFmpegAdapter();
  // v2 engine: in-process TS detection + bundled native runtimes (whisper.cpp).
  // The old Python subprocess adapter remains for the pre-bundling dev path.
  const engine = config.detectionWhisper
    ? new DetectionEngineAdapter({ whisper: config.detectionWhisper, ffmpegPath: "ffmpeg" })
    : new PythonEngineAdapter(config.engineBinaryPath, bus, config.gpuDevice);
  if (config.detectionWhisper) {
    (engine as DetectionEngineAdapter).attachBus(bus);
  }

  // Use cases
  const importByFile = new ImportStreamByFileUseCase(streamRepo, fs, ffmpeg);
  const importByUrl = new ImportStreamByUrlUseCase(streamRepo, vodDownloader, fs, bus, config.cacheDir);
  const deleteStream = new DeleteStreamUseCase(streamRepo, jobRepo, metadataRepo, streamStorage);
  const updateStream = new UpdateStreamUseCase(streamRepo);
  const attachChat = new AttachChatUseCase(streamRepo, fs);
  const startJob = new StartJobUseCase(
    streamRepo,
    jobRepo,
    clipRepo,
    engine,
    bus,
    fs,
    undefined,
    metadataRepo,
    streamStorage,
    cpuWorkers(DEFAULT_SETTINGS.cpuUsage, navigator.hardwareConcurrency ?? 4),
  );
  const cancelJob = new CancelJobUseCase(jobRepo, streamRepo, engine, bus, startJob);
  const listJobs = new ListJobsUseCase(jobRepo);
  const getStream = new GetStreamUseCase(streamRepo);
  const listStreams = new ListStreamsUseCase(streamRepo);
  const listClips = new ListClipsUseCase(clipRepo);
  const getClip = new GetClipUseCase(clipRepo);
  const rejectClip = new RejectClipUseCase(clipRepo);
  const updateClip = new UpdateClipUseCase(clipRepo);
  const exportClip = new ExportClipUseCase(clipRepo, streamRepo, ffmpeg, fs, config.exportDir, metadataRepo);
  const manageQueue = new ManageQueueUseCase(jobRepo);
  const settings = new SettingsUseCase(new SqliteSettingsRepository(db), bus);

  return {
    bus,
    httpDeps: {
      importByFile,
      importByUrl,
      listStreams,
      getStream,
      deleteStream,
      updateStream,
      attachChat,
      startJob,
      cancelJob,
      listJobs,
      listClips,
      getClip,
      rejectClip,
      updateClip,
      exportClip,
      manageQueue,
      settings,
      metadata: metadataRepo,
      storage: streamStorage,
    },
  };
}
