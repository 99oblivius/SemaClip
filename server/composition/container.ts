import { createDb } from "@/adapters/outbound/persistence/mod.ts";
import {
  SqliteStreamRepository,
  SqliteJobRepository,
  SqliteClipRepository,
  SqlitePersonaRepository,
  SqliteStreamMetadataRepository,
  SqliteSettingsRepository,
  SqliteExportPresetRepository,
  DenoStreamStorage,
} from "@/adapters/outbound/persistence/mod.ts";
import { InProcessEventBus } from "@/adapters/outbound/eventbus/mod.ts";
import { PythonEngineAdapter } from "@/adapters/outbound/engine/mod.ts";
import { DetectionEngineAdapter } from "@/adapters/outbound/engine/DetectionEngineAdapter.ts";
import type { WhisperPaths } from "@/adapters/outbound/transcribe/TranscribeAdapter.ts";
import { DEFAULT_SETTINGS, cpuWorkers } from "@/application/use-cases/SettingsUseCase.ts";
import { TwitchDlAdapter } from "@/adapters/outbound/vod/mod.ts";
import { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";
import { MediaActionsUseCase } from "@/application/use-cases/MediaActions.ts";
import { FFmpegAdapter } from "@/adapters/outbound/ffmpeg/mod.ts";
import type { ToolRegistry } from "@/adapters/outbound/ffmpeg/tool-paths.ts";
import {
  ImportStreamByFileUseCase,
  ImportStreamByUrlUseCase,
  ListStreamsUseCase,
  GetStreamUseCase,
  StreamReconciler,
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
  /** Immediate children (files only), names sorted. Folder import scan. */
  async listFiles(dir: string): Promise<string[]> {
    const names: string[] = [];
    for await (const entry of Deno.readDir(dir)) {
      if (entry.isFile) names.push(entry.name);
    }
    return names.sort();
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
  /** Resolved ffmpeg/ffprobe + the ability to provision them. See tool-paths.ts. */
  tools: ToolRegistry;
  /** When set, the in-process TS detection engine is used with these native paths. */
  detectionWhisper?: WhisperPaths | undefined;
}

export interface AppContainer {
  httpDeps: HttpDeps;
  bus: InProcessEventBus;
}

export async function buildContainer(config: AppConfig): Promise<AppContainer> {
  // The data dir (and cache/export) must exist before SQLite opens the DB —
  // a fresh platform-default location (~/.local/share/SemaClip) starts empty.
  for (const dir of [config.dataDir, config.cacheDir, config.exportDir]) {
    await Deno.mkdir(dir, { recursive: true });
  }
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
  const ffmpeg = new FFmpegAdapter(config.tools.ffmpeg, config.tools.ffprobe);
  // v2 engine: in-process TS detection + bundled native runtimes (whisper.cpp).
  // The old Python subprocess adapter remains for the pre-bundling dev path.
  const engine = config.detectionWhisper
    ? new DetectionEngineAdapter({
      whisper: config.detectionWhisper,
      ffmpegPath: config.tools.ffmpeg,
      ffprobePath: config.tools.ffprobe,
    })
    : new PythonEngineAdapter(config.engineBinaryPath, bus, config.gpuDevice);
  if (config.detectionWhisper) {
    (engine as DetectionEngineAdapter).attachBus(bus);
  }

  // Use cases
  const importByFile = new ImportStreamByFileUseCase(streamRepo, fs, ffmpeg);
  const downloadOrchestrator = new DownloadOrchestrator(metadataRepo, config.tools);
  const mediaActions = new MediaActionsUseCase(streamRepo, metadataRepo, fs, downloadOrchestrator, config.cacheDir);
  const importByUrl = new ImportStreamByUrlUseCase(streamRepo, vodDownloader, fs, bus, config.cacheDir, downloadOrchestrator);
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
  const streamReconciler = new StreamReconciler(streamRepo, fs, config.cacheDir);
  const getStream = new GetStreamUseCase(streamRepo, streamReconciler);
  const listStreams = new ListStreamsUseCase(streamRepo, streamReconciler);
  const listClips = new ListClipsUseCase(clipRepo);
  const getClip = new GetClipUseCase(clipRepo);
  const rejectClip = new RejectClipUseCase(clipRepo);
  const updateClip = new UpdateClipUseCase(clipRepo);
  const exportClip = new ExportClipUseCase(clipRepo, streamRepo, ffmpeg, fs, config.exportDir, metadataRepo, downloadOrchestrator);
  const manageQueue = new ManageQueueUseCase(jobRepo);
  const settings = new SettingsUseCase(new SqliteSettingsRepository(db), bus);
  const presets = new SqliteExportPresetRepository(db);
  // Seed the spec's default presets once (idempotent by fixed ids).
  const DEFAULT_PRESETS = [
    {
      id: "preset-tiktok-916",
      name: "TikTok 9:16 H.264",
      format: "mp4_h264" as const,
      aspectRatio: "9:16" as const,
      cropPosition: "center" as const,
      captions: { enabled: true, preset: "bold-white" as const, position: "bottom" as const, fontSize: 48, backgroundOpacity: 0.8 },
      nameTemplate: "{date}-{channel}-{axis}-{ts}-tiktok",
      createdAt: "2026-01-01T00:00:00Z",
    },
    {
      id: "preset-shorts-916-vp9",
      name: "Shorts 9:16 VP9",
      format: "webm" as const,
      aspectRatio: "9:16" as const,
      cropPosition: "center" as const,
      captions: { enabled: true, preset: "bold-white" as const, position: "bottom" as const, fontSize: 48, backgroundOpacity: 0.8 },
      nameTemplate: "{date}-{channel}-{axis}-{ts}-shorts",
      createdAt: "2026-01-01T00:00:01Z",
    },
    {
      id: "preset-archive-169",
      name: "16:9 Archive H.264",
      format: "mp4_h264" as const,
      aspectRatio: "16:9" as const,
      cropPosition: "center" as const,
      captions: { enabled: false, preset: "bold-white" as const, position: "bottom" as const, fontSize: 48, backgroundOpacity: 0.8 },
      nameTemplate: "{date}-{channel}-{axis}-{ts}",
      createdAt: "2026-01-01T00:00:02Z",
    },
  ];
  const existingPresets = await presets.list();
  if (existingPresets.length === 0) {
    for (const p of DEFAULT_PRESETS) await presets.save(p);
    console.log(`Seeded ${DEFAULT_PRESETS.length} default export presets`);
  }

  /** Stop every live download for a stream (piece + pipeline). */
  const cancelLiveDownloads = (id: string): boolean => {
    const piece = mediaActions.cancelPiece(id);
    const main = importByUrl.cancelProgressive(id);
    return piece || main;
  };

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
      presets,
      vod: vodDownloader,
      tools: config.tools,
      downloadState: (id: string) => downloadOrchestrator.getState(id),
      downloadRevision: (id: string) => id === "__global__" ? downloadOrchestrator.globalRev : downloadOrchestrator.revision(id),
      touchDownload: (id: string) => downloadOrchestrator.touch(id),
      purgeArtifacts: (id: string) => mediaActions.purgeArtifacts(id),
      cancelDownload: (id: string) => {
        const piece = mediaActions.cancelPiece(id);
        const main = importByUrl.cancelProgressive(id);
        return piece || main;
      },
      cancelPiece: (id: string) => mediaActions.cancelPiece(id),
      // Deleting an artifact must not leave a live downloader writing into a
      // removed file (verified: DELETE /proxy during a run left ffmpeg
      // appending to a deleted inode while the view honestly showed 0 bytes).
      // Cancel any live run for the stream first, then delete.
      deleteVideo: (id: string) => {
        cancelLiveDownloads(id);
        return mediaActions.deleteVideo(id);
      },
      deleteProxy: (id: string) => {
        cancelLiveDownloads(id);
        return mediaActions.deleteProxy(id);
      },
      deleteChat: (id: string) => {
        cancelLiveDownloads(id);
        return mediaActions.deleteChat(id);
      },
      downloadChatPiece: (opts: { streamId: string }) => mediaActions.downloadPiece({ ...opts, kind: "chat" }),
      openFolder: (id: string) => mediaActions.openFolder(id),
      deleteDownload: (id: string) => importByUrl.deleteDownload(id, config.cacheDir),
      resumeDownload: (id: string) => importByUrl.resumeDownload(id),
      downloadPiece: (opts: { streamId: string; kind: "proxy" | "hq"; proxyHeightCap?: number; maxHeight?: number | null; signal?: AbortSignal | undefined }) =>
        mediaActions.downloadPiece(opts),
      metadata: metadataRepo,
      storage: streamStorage,
    },
  };
}
