import { createDb } from "@/adapters/outbound/persistence/mod.ts";
import {
  SqliteStreamRepository,
  SqliteJobRepository,
  SqliteClipRepository,
  SqlitePersonaRepository,
  SqliteStreamMetadataRepository,
  SqliteSettingsRepository,
  SqliteExportPresetRepository,
  SqliteExportListRepository,
  SqliteExportJobRepository,
  DenoStreamStorage,
} from "@/adapters/outbound/persistence/mod.ts";
import { InProcessEventBus } from "@/adapters/outbound/eventbus/mod.ts";
import { PythonEngineAdapter } from "@/adapters/outbound/engine/mod.ts";
import { DetectionEngineAdapter } from "@/adapters/outbound/engine/DetectionEngineAdapter.ts";
import type { WhisperPaths } from "@/adapters/outbound/transcribe/TranscribeAdapter.ts";
import { DEFAULT_SETTINGS, cpuWorkers } from "@/application/use-cases/SettingsUseCase.ts";
import { CODEC_QUALITY_BANDS, type ExportPreset } from "shared/types";
import { missingShippedPresets } from "@/domain/export-profile.ts";
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
  CreateClipUseCase,
  UpdateClipUseCase,
  ClearExportedMarkUseCase,
  ExportClipUseCase,
  ExportQueue,
  ManageQueueUseCase,
  SettingsUseCase,
  SetProjectLocationUseCase,
} from "@/application/use-cases/mod.ts";
import { DownloadQueue } from "@/application/use-cases/DownloadQueue.ts";
import type { FolderPickerPort } from "@/application/ports/folder-picker.ts";
import { LinuxFolderPicker } from "@/adapters/outbound/platform/folder-picker-linux.ts";
import { WindowsFolderPicker } from "@/adapters/outbound/platform/folder-picker-windows.ts";
import { sidecarDir } from "@/adapters/outbound/platform/sidecar.ts";
import type { FileSystemPort } from "@/application/ports/outbound.ts";
import { FfmpegThumbnailCache } from "@/adapters/outbound/media/thumbnails.ts";
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
  /**
   * Join with the HOST separator, and normalise whatever the caller passed.
   *
   * This used to force "/" as the separator on every platform. Mixed separators work in
   * Node/Deno path APIs, but NOT everywhere a path is handed to the OS: spawning
   * `explorer.exe` with `C:/Users/.../AppData/Roaming/SemaClip/cache/vods/<id>` fails
   * where the back-slashed form opens, which is the owner's "Open Folder button stopped
   * opening the file explorer". Any path that leaves this process — a spawn argument, a
   * shell, an OS dialog — must be host-native.
   */
  joinPath(...segments: string[]): string {
    const sep = Deno.build.os === "windows" ? "\\" : "/";
    return segments
      .filter((seg) => seg.length > 0)
      .join(sep)
      .replace(/[\\/]+/g, sep);
  }

  /** A path in the form the OS expects, for anything spawned or shown to the user. */
  nativePath(path: string): string {
    return Deno.build.os === "windows" ? path.replace(/\//g, "\\") : path;
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
  /** The export batch, exposed so boot can resume one that a restart interrupted. */
  exportQueue: ExportQueue;
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
  const exportListRepo = new SqliteExportListRepository(db);
  const exportJobRepo = new SqliteExportJobRepository(db);
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
  const downloadOrchestrator = new DownloadOrchestrator(metadataRepo, config.tools, streamRepo);
  const mediaActions = new MediaActionsUseCase(streamRepo, metadataRepo, fs, downloadOrchestrator, config.cacheDir, bus);
  // ONE queue for full VOD downloads: the import use-case enqueues into it, and the downloads
  // route reads its snapshot for positions. Two queues would be two answers to "what is next".
  const downloadQueue = new DownloadQueue();
  // The VOD directory is read per import (not captured), so changing the setting applies to
  // the next download without a restart.
  const importByUrl = new ImportStreamByUrlUseCase(
    streamRepo,
    vodDownloader,
    fs,
    bus,
    config.cacheDir,
    downloadOrchestrator,
    undefined,
    async () => (await settings.get()).vodDir,
    downloadQueue,
  );
  const deleteStream = new DeleteStreamUseCase(streamRepo, jobRepo, metadataRepo, streamStorage);

  // The pipeline's abort register is ImportStream's own, and that use-case is built after this one
  // — so it is handed over here, once, rather than duplicating the register. `cancelEverything`
  // consults BOTH registers; a cancel that reached only one of them is how "it does not actually
  // stop" survived.
  mediaActions.pipelineAbort = (id: string) => importByUrl.cancelProgressive(id);
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
  const setProjectLocation = new SetProjectLocationUseCase(streamRepo, fs, downloadOrchestrator, bus);
  // The OS folder chooser. Per-platform because the runtime exposes no dialog API at all
  // (see application/ports/folder-picker.ts for the measurements).
  const folderPicker: FolderPickerPort = Deno.build.os === "windows"
    ? new WindowsFolderPicker(sidecarDir())
    : new LinuxFolderPicker();
  const listClips = new ListClipsUseCase(clipRepo);
  const getClip = new GetClipUseCase(clipRepo);
  // The thumbnail cache is derived data with no state of its own (the file IS the cache), so
  // it is composed here and handed to the two things that must know about it: reject (which
  // deletes it) and the thumbnail route (which generates it).
  const thumbnails = new FfmpegThumbnailCache(
    (streamId) => `${streamStorage.streamDir(streamId)}/thumbnails`,
  );
  const rejectClip = new RejectClipUseCase(clipRepo, thumbnails);
  const createClip = new CreateClipUseCase(clipRepo, streamRepo);
  const updateClip = new UpdateClipUseCase(clipRepo);
  const clearExportedMark = new ClearExportedMarkUseCase(clipRepo);
  // Settings FIRST: the export path is read from them, and a value captured at boot would ignore a
  // change the user made in the running app.
  const settings = new SettingsUseCase(new SqliteSettingsRepository(db), bus, `${config.cacheDir}/vods`);
  const exportClip = new ExportClipUseCase(
    clipRepo,
    streamRepo,
    ffmpeg,
    fs,
    config.exportDir,
    metadataRepo,
    downloadOrchestrator,
    // The user's configured directory wins over the process default. Asked per export, so a change
    // in Settings takes effect on the next export rather than the next restart.
    async () => (await settings.get()).exportDir,
  );
  // The export BATCH wraps the single-clip exporter: it does not re-implement exporting, it
  // sequences it, records it durably, and reports progress.
  const exportQueue = new ExportQueue(
    exportJobRepo,
    exportListRepo,
    clipRepo,
    streamRepo,
    metadataRepo,
    fs,
    exportClip,
    bus,
  );
  const manageQueue = new ManageQueueUseCase(jobRepo);
  const presets = new SqliteExportPresetRepository(db);
  // Seed the spec's default presets once (idempotent by fixed ids).
  /**
   * The seeded presets, each carrying a FULL profile.
   *
   * They used to carry only the legacy subset (format/aspectRatio/captions/
   * nameTemplate), which could not express the encoder, the resolution cap or the bitrate ceiling —
   * three of the things that most change what a user actually gets. A preset is a saved answer to
   * "how should this be encoded", so it stores the profile itself.
   *
   * Quality defaults to each codec's OWN recommended value (CODEC_QUALITY_BANDS.default: x264 23,
   * libvpx-vp9 31) rather than one number for all of them, and `encoder: "auto"` takes the measured
   * per-codec default — so the AV1 preset lands on hardware and the H.264 one stays on software.
   */
  const DEFAULT_PRESETS: ExportPreset[] = [
    {
      // FIRST in the list (ordering is `created_at`, so it gets the earliest stamp). Landscape is the
      // default a user with no opinion wants: the source is almost always 16:9 and this is the only
      // preset that does not crop it.
      id: "preset-landscape-169",
      name: "Landscape 16:9 H.264",
      profile: {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        encoder: "auto",
        encoderName: null,
        maxHeight: 1920,
        options: { quality: CODEC_QUALITY_BANDS.h264.default, maxBitrateKbps: null },
        aspectRatio: "16:9",
        captions: { enabled: false, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 },
        nameTemplate: "{date}-{channel}-{name}-{ts}",
      },
      createdAt: "2026-01-01T00:00:00Z",
      // Shipped with the app: selectable, never deletable (the server refuses by name).
      origin: "seeded",
    },
    {
      id: "preset-tiktok-916",
      name: "Portrait 9:16 H.264",
      profile: {
        container: "mp4",
        videoCodec: "h264",
        audioCodec: "aac",
        encoder: "auto",
        encoderName: null,
        maxHeight: 1920,
        options: { quality: CODEC_QUALITY_BANDS.h264.default, maxBitrateKbps: null },
        aspectRatio: "9:16",
        // Captions OFF: a preset must not turn a burn-in on for the user. Captions are opt-in per
        // export, and a preset that enables them silently changes the PICTURE of every export made
        // from it.
        captions: { enabled: false, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 },
        nameTemplate: "{date}-{channel}-{name}-{ts}",
      },
      createdAt: "2026-01-01T00:00:01Z",
      // Shipped with the app: selectable, never deletable (the server refuses by name).
      origin: "seeded",
    },
    {
      id: "preset-shorts-916-vp9",
      name: "Shorts 9:16 VP9",
      profile: {
        container: "webm",
        videoCodec: "vp9",
        audioCodec: "opus",
        encoder: "auto",
        encoderName: null,
        maxHeight: 1920,
        options: { quality: CODEC_QUALITY_BANDS.vp9.default, maxBitrateKbps: null },
        aspectRatio: "9:16",
        // Captions OFF — same rule as Portrait above.
        captions: { enabled: false, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 },
        nameTemplate: "{date}-{channel}-{name}-{ts}",
      },
      createdAt: "2026-01-01T00:00:02Z",
      // Shipped with the app: selectable, never deletable (the server refuses by name).
      origin: "seeded",
    },
  ];
  const existingPresets = await presets.list();
  // SEED PER ID, NOT per empty table. The reasoning lives with the rule, in
  // `missingShippedPresets` — the short version is that 0.7.0 now inserts Landscape during migration,
  // so the table is never empty at boot and a `length === 0` gate silently seeded nothing.
  const missing = missingShippedPresets(DEFAULT_PRESETS, existingPresets);
  for (const p of missing) await presets.save(p);
  if (missing.length > 0) {
    console.log(`Seeded ${missing.length} default export preset(s): ${missing.map((p) => p.id).join(", ")}`);
  }

  /**
   * Stop every live download for a stream (piece + pipeline).
   *
   * `cancelPiece` now also REMOVES the piece's files, so this must not be used before a delete that
   * wants the files gone anyway — it is, and the delete follows immediately, so the two agree. When
   * only the abort is wanted (no cleanup), use `cancelProgressive` alone.
   */
  const cancelLiveDownloads = (id: string): Promise<boolean> => {
    const main = importByUrl.cancelProgressive(id);
    return mediaActions.cancelPiece(id, "proxy").then((piece) => piece || main);
  };

  return {
    bus,
    /** The export batch, exposed so boot can resume an interrupted one (see main.ts). */
    exportQueue,
    httpDeps: {
      importByFile,
      importByUrl,
      listStreams,
      getStream,
      deleteStream,
      updateStream,
      attachChat,
      setProjectLocation,
      folderPicker,
      startJob,
      cancelJob,
      listJobs,
      listClips,
      getClip,
      rejectClip,
      createClip,
      thumbnails,
      /** Source media probing lives on the ffmpeg adapter (it is the same ffprobe). */
      mediaProbe: ffmpeg,
      updateClip,
      clearExportedMark,
      exportClip,
      exportList: exportListRepo,
      exportQueue,
      manageQueue,
      settings,
      presets,
      vod: vodDownloader,
      tools: config.tools,
      downloadState: (id: string) => downloadOrchestrator.getState(id),
      downloadQueue: () => downloadQueue.snapshot(),
      downloadRevision: (id: string) => id === "__global__" ? downloadOrchestrator.globalRev : downloadOrchestrator.revision(id),
      touchDownload: (id: string) => downloadOrchestrator.touch(id),
      purgeArtifacts: (id: string) => mediaActions.purgeArtifacts(id),
      // Cancel = STOP and keep the files. Distinct from `deleteDownload` (the discard verb), which
      // is what the Cancel button used to call — destroying the partial download it was cancelling.
      cancelDownload: (id: string) => mediaActions.cancelEverything(id),
      cancelPiece: (id: string, kind: "proxy" | "hq" | "chat") => mediaActions.cancelPiece(id, kind),
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
      // Cancel = STOP and keep the files. Distinct from `deleteDownload` (the discard verb), which
      // is what the Cancel button used to call — destroying the partial download it was cancelling.
      deleteDownload: (id: string) => importByUrl.deleteDownload(id, config.cacheDir),
      resumeDownload: (id: string) => importByUrl.resumeDownload(id),
      downloadPiece: (opts: { streamId: string; kind: "proxy" | "hq"; proxyHeightCap?: number; maxHeight?: number | null; signal?: AbortSignal | undefined }) =>
        mediaActions.downloadPiece(opts),
      metadata: metadataRepo,
      storage: streamStorage,
    },
  };
}
