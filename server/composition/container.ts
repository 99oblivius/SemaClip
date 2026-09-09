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
  const engine = new PythonEngineAdapter(config.engineBinaryPath, bus, config.gpuDevice);

  // Use cases
  const importByFile = new ImportStreamByFileUseCase(streamRepo, fs, ffmpeg);
  const importByUrl = new ImportStreamByUrlUseCase(streamRepo, vodDownloader, fs, bus, config.cacheDir);
  const deleteStream = new DeleteStreamUseCase(streamRepo, jobRepo, metadataRepo, streamStorage);
  const updateStream = new UpdateStreamUseCase(streamRepo);
  const attachChat = new AttachChatUseCase(streamRepo, fs);
  const startJob = new StartJobUseCase(streamRepo, jobRepo, clipRepo, engine, bus, fs);
  const cancelJob = new CancelJobUseCase(jobRepo, streamRepo, engine, bus, startJob);
  const listJobs = new ListJobsUseCase(jobRepo);
  const getStream = new GetStreamUseCase(streamRepo);
  const listStreams = new ListStreamsUseCase(streamRepo);
  const listClips = new ListClipsUseCase(clipRepo);
  const getClip = new GetClipUseCase(clipRepo);
  const rejectClip = new RejectClipUseCase(clipRepo);
  const exportClip = new ExportClipUseCase(clipRepo, streamRepo, ffmpeg, fs, config.exportDir);
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
      exportClip,
      manageQueue,
      settings,
      metadata: metadataRepo,
      storage: streamStorage,
    },
  };
}
