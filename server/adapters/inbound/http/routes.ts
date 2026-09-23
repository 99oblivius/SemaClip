import { provisionFfmpeg } from "@/adapters/outbound/ffmpeg/provision.ts";
import type { ToolRegistry } from "@/adapters/outbound/ffmpeg/tool-paths.ts";
import { Hono } from "hono";
import { wsHandler } from "@/adapters/inbound/ws/handler.ts";
import type {
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
  CreateClipUseCase,
  UpdateClipUseCase,
  ClearExportedMarkUseCase,
  ExportClipUseCase,
  ExportQueue,
  ManageQueueUseCase,
  SettingsUseCase,
  SetProjectLocationUseCase,
} from "@/application/use-cases/mod.ts";
import { selectImplicitBatch } from "@/application/use-cases/mod.ts";
import type { Axis, StreamStatus, ExportListEntry, VideoCodec } from "shared/types";
import { CODEC_QUALITY_BANDS, HW_QUALITY_BANDS, MEASURED_ENCODER_SPEEDS } from "shared/types";
import {
  type ExportProfile,
  normaliseProfile,
  validateExportProfile,
} from "shared/types";
import type { FolderPickerPort } from "@/application/ports/folder-picker.ts";
import type { DownloadState as DownloadStateType } from "@/adapters/outbound/vod/download-orchestrator.ts";
import type { EventBus, MediaProbePort, StreamMetadataRepository, StreamStorage, VodDownloadPort } from "@/application/ports/outbound.ts";
import type { SqliteExportPresetRepository } from "@/adapters/outbound/persistence/repositories.ts";
import { parseSrt } from "@/adapters/outbound/transcribe/srt-parse.ts";
import { cuesToSrt } from "@/adapters/outbound/transcribe/srt-write.ts";
import { listEncodersFor, probeGpuEncoder } from "@/adapters/outbound/ffmpeg/gpu-probe.ts";
import {
  extractVodId,
  resolveQualities,
  pickProxyQuality,
  pickBestQuality,
} from "@/adapters/outbound/vod/hls.ts";
import { clampToServable, limitBytes, parseRangeHeader } from "@/adapters/inbound/http/range.ts";
import { projectDownloadView } from "@/application/view/project-download-view.ts";
import { resolvePlayback, resolveMediaSource } from "@/application/view/download-view.ts";
import type { ThumbnailSource, ThumbnailCache } from "@/adapters/outbound/media/thumbnails.ts";
import { EXPORT_CHANGED_TOPIC, STREAM_CHANGED_TOPIC } from "@/application/ports/outbound.ts";
import type { ExportListRepository } from "@/application/ports/outbound.ts";
import { fragmentBoundaryAt, parseIndex } from "@/adapters/outbound/vod/fmp4.ts";
import { run, spawnChild } from "@/adapters/outbound/process/spawn.ts"
import type { ChildHandle } from "@/adapters/outbound/process/spawn.ts";;
import {
  beginWindowDrag,
  beginWindowResize,
  continueWindowDrag,
  endWindowDrag,
  chromeState,
  closeWindow,
  minimizeWindow,
  restartApp,
  restoreWindow,
  toggleMaximizeWindow,
  windowHandleRef,
} from "@/adapters/outbound/platform/window-lifecycle.ts";
import type { ResizeEdge } from "@/adapters/outbound/platform/gtk-frame.ts";
import { logFilePath, readLogTail } from "@/adapters/outbound/platform/log-file.ts";
import { retryUpdateCheck, startUpdateDownload, updateStatus } from "@/adapters/outbound/platform/auto-update.ts";
import { updateLogPath } from "@/adapters/outbound/platform/sidecar.ts";
import { displayVersion } from "@/adapters/outbound/platform/app-version.ts";
import { emitAppEvent, subscribeAppEvents, sseFrame } from "@/application/events.ts";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/adapters/outbound/net/fetch-timeout.ts";

/**
 * How many bytes of `mediaPath` may be served right now.
 *
 * For a COMPLETE file that is its size. For a file a download is still
 * writing it is the download's safe frontier — for a growing fragmented MP4
 * the end of the last complete fragment, because a response ending inside an
 * `mdat` makes Chromium fail with PIPELINE_ERROR_DECODE (verified).
 */
async function servableSizeFor(
  deps: HttpDeps,
  streamId: string,
  mediaPath: string,
  fileSize: number,
): Promise<number> {
  try {
    const dl = await deps.downloadState(streamId);
    if (dl.phase !== "running") return fileSize;
    const isProxy = mediaPath === dl.proxyPath || mediaPath === dl.proxyMp4;
    const isHq = mediaPath === dl.hqPath || mediaPath === dl.hqMp4;
    if (!isProxy && !isHq) return fileSize;
    const mapPath = `${mediaPath.replace(/\.(mp4|ts)$/, "")}.fragments`;
    const text = await Deno.readTextFile(mapPath).catch(() => "");
    if (!text) return fileSize;
    const boundary = fragmentBoundaryAt(parseIndex(text), fileSize);
    // Nothing complete yet (init segment only) → serve nothing rather than
    // a partial fragment; the player retries as the download advances.
    return Math.max(0, Math.min(boundary, fileSize));
  } catch {
    return fileSize;
  }
}

export interface HttpDeps {
  importByFile: ImportStreamByFileUseCase;
  importByUrl: ImportStreamByUrlUseCase;
  listStreams: ListStreamsUseCase;
  getStream: GetStreamUseCase;
  deleteStream: DeleteStreamUseCase;
  updateStream: UpdateStreamUseCase;
  attachChat: AttachChatUseCase;
  /** Point a project at a different folder ("Change Location"). */
  setProjectLocation: SetProjectLocationUseCase;
  /** The OS folder chooser (zenity/yad on Linux, the modern shell dialog on Windows). */
  folderPicker: FolderPickerPort;
  startJob: StartJobUseCase;
  cancelJob: CancelJobUseCase;
  listJobs: ListJobsUseCase;
  listClips: ListClipsUseCase;
  getClip: GetClipUseCase;
  rejectClip: RejectClipUseCase;
  createClip: CreateClipUseCase;
  /** Clip thumbnails: derived data whose cache IS the file (no state to keep in sync). */
  thumbnails: ThumbnailCache;
  /** Source media probing, for the export's source-bitrate semantics. */
  mediaProbe: MediaProbePort;
  updateClip: UpdateClipUseCase;
  /** Drop a clip's `exported` mark when its request is withdrawn or replaced. */
  clearExportedMark: ClearExportedMarkUseCase;
  exportClip: ExportClipUseCase;
  /** The durable list of clips the user means to export (references, never copies). */
  exportList: ExportListRepository;
  /** The durable, resumable export batch. */
  exportQueue: ExportQueue;
  manageQueue: ManageQueueUseCase;
  settings: SettingsUseCase;
  presets: SqliteExportPresetRepository;
  vod: VodDownloadPort;
  /** Resolved ffmpeg/ffprobe plus the ability to provision them on request. */
  tools: ToolRegistry;
  downloadState: (streamId: string) => Promise<DownloadStateType>;
  downloadRevision: (streamId: string) => number;
  /** The full-VOD queue's own view (who is running, who is waiting, in what order). */
  downloadQueue: () => { running: string | null; waiting: string[] };
  /** Record a view change that has no state write (artifact deletion). */
  touchDownload: (streamId: string) => void;
  /** Remove a project's downloaded media directory. */
  purgeArtifacts: (streamId: string) => Promise<{ bytes: number }>;
  /** Stop a whole download and KEEP its files (the cancel verb, distinct from the delete below). */
  cancelDownload: (streamId: string) => Promise<{ stopped: boolean; queued: boolean }>;
  cancelPiece: (streamId: string, kind: "proxy" | "hq" | "chat") => Promise<boolean>;
  deleteVideo: (streamId: string) => Promise<{ deleted: boolean }>;
  deleteProxy: (streamId: string) => Promise<{ deleted: boolean }>;
  deleteChat: (streamId: string) => Promise<{ deleted: boolean }>;
  downloadChatPiece: (opts: { streamId: string }) => Promise<{ started: boolean; quality: string | null }>;
  openFolder: (streamId: string) => Promise<{ opened: boolean; dir: string | null; error?: string }>;
  deleteDownload: (streamId: string) => Promise<boolean>;
  resumeDownload: (streamId: string) => Promise<void>;
  downloadPiece: (opts: { streamId: string; kind: "proxy" | "hq"; proxyHeightCap?: number; maxHeight?: number | null; signal?: AbortSignal | undefined }) => Promise<{ started: boolean; quality: string | null }>
  metadata: StreamMetadataRepository;
  storage: StreamStorage;
}

// ── In-memory chat cache ──
// Parsing a multi-MB chat JSON on every paginated request is the main
// bottleneck. Cache the parsed + mapped messages by file path + mtime.
const chatCache = new Map<string, { mtime: number; msgs: { t: number; user: string; body: string }[] }>();

/**
 * Which file a clip's thumbnail should be extracted from, and at what second.
 *
 * The choice reuses the DOWNLOAD VIEW's own playback resolution rather than re-deriving
 * "which file is the video" here — the view is the one owner of that answer, and a second
 * derivation is the two-owners bug this codebase keeps producing. That also means the proxy is
 * preferred automatically (it is what review plays, and it is a fraction of the I/O for one
 * 320px frame), with the HQ render as the fallback for a project that never had a proxy.
 *
 * Returns null when there is nothing on disk: the route then answers 404 and the UI shows a
 * placeholder, which is the honest outcome.
 */
async function thumbnailSourceFor(
  deps: HttpDeps,
  streamId: string,
  atSec: number,
): Promise<ThumbnailSource | null> {
  const dl = await deps.downloadState(streamId);
  const stream = await deps.getStream.execute(streamId);
  const present = (p: string) => Deno.stat(p).then(() => true).catch(() => false);

  // ONE source rule shared with the player (see resolveMediaSource): a frame drawn from a
  // different file than the user is watching is worse than no frame. A folder-imported project
  // is the case that matters — media on disk with NO download state, so `vodPath` is its only
  // candidate and a download-state-only rule would report "no media" for a file sitting there.
  const path = await resolveMediaSource({
    proxyMp4: dl.proxyMp4,
    proxyPath: dl.proxyPath,
    hqMp4: dl.hqMp4,
    hqPath: dl.hqPath,
    vodPath: stream?.vodPath ?? null,
    present,
  });
  return path ? { path, timeSec: atSec } : null;
}

async function loadChat(chatPath: string): Promise<{ t: number; user: string; body: string }[]> {
  const stat = await Deno.stat(chatPath);
  const mtime = stat.mtime?.getTime() ?? 0;
  const cached = chatCache.get(chatPath);
  if (cached && cached.mtime === mtime) return cached.msgs;
  const raw = await Deno.readTextFile(chatPath);
  const data = JSON.parse(raw);
  const comments: Array<{ content_offset_seconds: number; commenter?: { display_name: string }; message?: { body: string } }> =
    Array.isArray(data) ? data : data.comments ?? [];
  const msgs = comments
    .map((m) => ({ t: m.content_offset_seconds ?? 0, user: m.commenter?.display_name ?? "unknown", body: m.message?.body ?? "" }))
    .sort((a, b) => a.t - b.t);
  chatCache.set(chatPath, { mtime, msgs });
  return msgs;
}

/**
 * Domain errors → HTTP status codes.
 *
 * A refusal the USER can act on is a 400, not a 500: a 500 says "the server broke", and there is
 * nothing the user can do with that. Two of these reached the UI as 500s on ordinary actions —
 * clearing the Name field, and exporting with captions enabled on a stream that has no transcript —
 * so both are named here and return the reason for the page to show.
 */
function errorStatus(msg: string): 400 | 404 | 500 {
  if (/not found|not available/i.test(msg)) return 404;
  if (
    /already terminal|can only reorder|invalid|unsupported|not yet downloaded|a clip name cannot be empty|captions enabled|no video file to export from/i
      .test(msg)
  ) return 400;
  return 500;
}

export function createApp(deps: HttpDeps, bus: EventBus): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    const status = errorStatus(msg);
    if (status === 500) console.error("Unhandled error:", err);
    return c.json({ error: msg }, status);
  });

  // ── Streams ──
  app.get("/api/streams", async (c) => {
    const status = c.req.query("status") as StreamStatus | undefined;
    return c.json(await deps.listStreams.execute(status));
  });

  app.get("/api/streams/:id", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream) return c.json({ error: "Stream not found" }, 404);
    return c.json(stream);
  });

  // Import VOD by local file path (for large pre-downloaded videos).
  app.post("/api/streams/import-file", async (c) => {
    const body = await c.req.json();
    const result = await deps.importByFile.execute(body);
    return c.json(result, 201);
  });

  // Import VOD by Twitch URL (auto-downloads video + chat).
  app.post("/api/streams/import-url", async (c) => {
    const body = await c.req.json();
    const result = await deps.importByUrl.execute(body);
    return c.json(result, 201);
  });

  // ── Progressive download state ──
  app.get("/api/streams/:id/download", async (c) => {
    const streamId = c.req.param("id");
    const state = await deps.downloadState(streamId);
    return c.json(state);
  });

  // Every stream's download VIEW in one call — the single source the whole
  // UI renders from. Composing server-side means no component derives
  // "is a download happening", "is it on disk" or "which file is shared";
  // those local derivations were the source of the reported inconsistencies.
  app.get("/api/downloads", async (c) => {
    const streams = await deps.listStreams.execute();
    // ONE snapshot for the whole response: the queue owns order, so every view is composed
    // against the same instant. Asking per stream could show two projects claiming position 1.
    const queue = deps.downloadQueue();
    const queueTotal = queue.waiting.length + (queue.running ? 1 : 0);
    const views = await Promise.all(streams.map(async (stream) => {
      const [state, markersRaw] = await Promise.all([
        deps.downloadState(stream.id),
        deps.metadata.get(stream.id, "markers").catch(() => null),
      ]);
      let markers: { t: number; label: string; source: string }[] | null = null;
      if (markersRaw) {
        try {
          const parsed = JSON.parse(markersRaw) as { markers?: { t: number; label: string; source: string }[] };
          markers = parsed.markers ?? null;
        } catch {
          markers = null;
        }
      }
      // Reachability is measured HERE, on every read, because this is the layer that can
      // touch the filesystem and this is the request the UI already refreshes on. It is
      // three-valued on purpose: a project that records no folder is not "missing" (it may
      // be empty), so only a recorded-but-absent folder reports false. Measured per read
      // also means a drive that appears or disappears is picked up by the next poll — the
      // same mechanism that makes deletions and completions appear without a refresh.
      let reachable: boolean | null = null;
      if (stream.projectDir) {
        reachable = await Deno.stat(stream.projectDir).then(() => true).catch(() => false);
      }
      const waitingAt = queue.waiting.indexOf(stream.id);
      // THE QUEUE IS THE ONE OWNER of "this project is waiting". The phase is composed here
      // rather than written into the download state, because a queued stream is deliberately
      // not a live run (nothing is being written) — so `getState()` legitimately serves the
      // persisted state, and a second mechanism trying to mark it queued there produced a
      // project that read `phase: idle, active: false` while it was genuinely queued. That
      // made `needsAttention` false, so the Library rendered no container for it at all and
      // the queue position was invisible to the user.
      const viewState = waitingAt === -1 ? state : { ...state, phase: "queued" as const };
      return projectDownloadView({
        streamId: stream.id,
        state: viewState,
        markers,
        hasSource: Boolean(stream.sourceUrl),
        revision: deps.downloadRevision(stream.id),
        reachable,
        // Position within the WAITING list (1-based), so "1 of 2 in queue" means one download
        // is ahead of this project.
        queue: waitingAt === -1 ? null : { position: waitingAt + 1, total: queueTotal },
      });
    }));
    return c.json({ views, revision: deps.downloadRevision("__global__") });
  });

  // Delete a download: abort any in-flight run, remove its artifacts, reset
  // the state to idle (also clears stuck/orphaned states — the old "cancel"
  // was a no-op for those).
  // ── Cancel a whole download ──
  //
  // PAUSE the transfer and KEEP the files. This used to be `DELETE /download`, which swept the
  // artifact directory: the owner reported that pressing Cancel "deletes the proxy and chat as
  // well", and a cancel may not destroy the work it is cancelling. Discarding is the DELETE below,
  // and the two are now separate verbs.
  app.post("/api/streams/:id/download/cancel", async (c) => {
    const streamId = c.req.param("id");
    try {
      const result = await deps.cancelDownload(streamId);
      return c.json({ ok: true, ...result });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Delete a download ──
  //
  // Aborts every live run, sweeps the artifacts and resets the state to idle (also clears
  // stuck/orphaned states — the old "cancel" was a no-op for those). ?piece=<kind> does the same
  // for ONE artifact.
  app.delete("/api/streams/:id/download", async (c) => {
    const streamId = c.req.param("id");
    // ?piece=<kind> cancels just that piece: it aborts the run AND removes the
    // files it wrote (media + fragment index + its own state). Without the
    // query, the whole download and every artifact go.
    const piece = c.req.query("piece");
    if (piece === "proxy" || piece === "hq" || piece === "chat") {
      try {
        const cancelled = await deps.cancelPiece(streamId, piece);
        return c.json({ ok: cancelled });
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    try {
      await deps.deleteDownload(streamId);
      return c.json({ ok: true });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // Resume an interrupted download from the best on-disk point.
  app.post("/api/streams/:id/download/resume", async (c) => {
    const streamId = c.req.param("id");
    try {
      await deps.resumeDownload(streamId);
      return c.json({ ok: true }, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  // Stream-config media actions (download-pipeline scope).
  app.delete("/api/streams/:id/video", async (c) => {
    const id = c.req.param("id");
    const result = await deps.deleteVideo(id);
    deps.touchDownload(id);
    return c.json(result);
  });

  app.delete("/api/streams/:id/proxy", async (c) => {
    const id = c.req.param("id");
    const result = await deps.deleteProxy(id);
    deps.touchDownload(id);
    return c.json(result);
  });

  app.get("/api/streams/:id/folder", async (c) => {
    const result = await deps.openFolder(c.req.param("id"));
    return c.json(result);
  });

  app.delete("/api/streams/:id/chat", async (c) => {
    const id = c.req.param("id");
    const result = await deps.deleteChat(id);
    deps.touchDownload(id);
    return c.json(result);
  });

  app.post("/api/streams/:id/download-piece", async (c) => {
    const body = await c.req.json() as { kind?: string; maxHeight?: number | null; proxyHeightCap?: number | null };
    if (body.kind === "chat") {
      try {
        const result = await deps.downloadChatPiece({ streamId: c.req.param("id") });
        return c.json(result, 202);
      } catch (err) {
        return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
      }
    }
    if (body.kind !== "proxy" && body.kind !== "hq") {
      return c.json({ error: "kind must be 'proxy', 'hq' or 'chat'" }, 400);
    }
    try {
      const result = await deps.downloadPiece({
        streamId: c.req.param("id"),
        kind: body.kind,
        proxyHeightCap: body.proxyHeightCap ?? 540,
        maxHeight: body.maxHeight ?? null,
      });
      return c.json(result, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 409);
    }
  });

  // Available qualities for the import modal's max-quality selector.
  app.get("/api/vod/qualities", async (c) => {
    const url = c.req.query("url") ?? "";
    try {
      const { extractVodId, resolveQualities } = await import("@/adapters/outbound/vod/hls.ts");
      const vodId = extractVodId(url);
      if (!vodId) return c.json({ error: "Not a Twitch VOD URL" }, 400);
      const qualities = await resolveQualities(vodId);
      return c.json({
        qualities: qualities.map((q) => ({
          name: q.name,
          width: q.width,
          height: q.height,
          fps: q.fps,
          bandwidth: q.bandwidth,
        })),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 502);
    }
  });



  // Attach chat by local file path (for pre-downloaded chat files).
  app.post("/api/streams/:id/attach-chat", async (c) => {
    const body = await c.req.json();
    if (!body?.chatPath) return c.json({ error: "chatPath required" }, 400);
    const stream = await deps.attachChat.execute(c.req.param("id"), body.chatPath as string);
    return c.json(stream, 200);
  });

  app.delete("/api/streams/:id", async (c) => {
    const id = c.req.param("id");
    // STOP THE DOWNLOAD FIRST. Deleting the project record while a run was live left that run
    // writing chunks into a directory the very next line purges, and — with the record gone —
    // nothing left in any UI to cancel it with. The owner saw exactly that: "even deleting the
    // project doesn't stop the downloading".
    await deps.cancelDownload(id);
    await deps.deleteStream.execute(id);
    // Media artifacts live outside the storage tree — purge them too, or the
    // downloaded gigabytes stay on disk after the project is gone (and remain
    // reachable by the media route's fallbacks).
    const purged = await deps.purgeArtifacts(id);
    deps.touchDownload(id);
    return c.json({ ok: true, freedBytes: purged.bytes });
  });

  // Update stream metadata (title, streamer, game, vodPath, chatPath).
  app.patch("/api/streams/:id", async (c) => {
    const body = await c.req.json();
    const stream = await deps.updateStream.execute(c.req.param("id"), body);
    return c.json(stream);
  });

  /**
   * Point a project at a different folder ("Change Location").
   *
   * The path may come from the OS folder picker or be typed. It is NOT created when missing:
   * "change location" means "the files are here", so an absent directory is a refusal with the
   * reason — creating it would report success while pointing the project at an empty folder.
   */
  app.post("/api/streams/:id/location", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { dir?: string };
    if (typeof body.dir !== "string" || body.dir.trim().length === 0) {
      return c.json({ error: "dir is required" }, 400);
    }
    try {
      const result = await deps.setProjectLocation.execute(c.req.param("id"), body.dir);
      deps.touchDownload(c.req.param("id"));
      return c.json({
        stream: result.stream,
        dir: result.dir,
        repointed: result.repointed,
        missing: result.missing,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A running download is a conflict, a bad path is a bad request — the UI reports both.
      return c.json({ error: msg }, /running/i.test(msg) ? 409 : 400);
    }
  });

  /** Open the OS folder chooser and return the chosen path (or nothing, on cancel). */
  app.post("/api/system/pick-folder", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { title?: string; initialDir?: string | null };
    try {
      const result = await deps.folderPicker.pick({
        title: body.title ?? "Choose a folder",
        initialDir: body.initialDir ?? null,
      });
      return c.json(result, result.error ? 500 : 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  // ── Jobs ──
  app.get("/api/jobs", async (c) => {
    return c.json(await deps.listJobs.execute());
  });

  app.post("/api/streams/:id/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const job = await deps.startJob.execute(c.req.param("id"), body.config);
    return c.json(job, 201);
  });

  app.post("/api/jobs/:id/cancel", async (c) => {
    const job = await deps.cancelJob.execute(c.req.param("id"));
    return c.json(job);
  });

  app.post("/api/queue/manage", async (c) => {
    const body = await c.req.json();
    const jobs = await deps.manageQueue.execute(body);
    return c.json(jobs);
  });

  // ── Clips ──
  app.get("/api/streams/:id/clips", async (c) => {
    const axisParam = c.req.query("axis");
    const rejectedParam = c.req.query("rejected");
    const filter: { axis?: Axis; rejected?: boolean } = {};
    if (axisParam) filter.axis = axisParam as Axis;
    if (rejectedParam !== undefined) filter.rejected = rejectedParam === "true";
    const clips = await deps.listClips.execute(c.req.param("id"), filter);
    return c.json(clips);
  });

  /**
   * Create a clip BY HAND at a playhead position — no engine involved.
   *
   * `endTime` is optional: the server computes it (next clip's start, else the VOD's end) so
   * the rule lives in one place instead of being re-derived in the browser. The response
   * carries the created clip, since the client cannot know the computed end.
   *
   * Publishes `stream:changed`, because a clip appearing in the panel is exactly the case the
   * skill's refresh model warns about: a mutation that writes the DB without announcing makes
   * the UI lag until an unrelated poll happens.
   */
  app.post("/api/streams/:id/clips", async (c) => {
    const streamId = c.req.param("id");
    const body = await c.req.json().catch(() => ({}));
    const clip = await deps.createClip.execute(streamId, {
      startTime: body?.startTime,
      endTime: body?.endTime,
    });
    bus.publish(STREAM_CHANGED_TOPIC, { type: "stream_changed", streamId, reason: "clip" });
    return c.json(clip, 201);
  });

  app.get("/api/clips/:id", async (c) => {
    const clip = await deps.getClip.execute(c.req.param("id"));
    if (!clip) return c.json({ error: "Clip not found" }, 404);
    return c.json(clip);
  });

  /**
   * One frame at the clip's start, extracted on first request and cached thereafter.
   *
   * A 404 is a legitimate answer here (no video on disk yet, or the file vanished) and the UI
   * renders a placeholder for it. It is deliberately NOT a fabricated image: the panel must
   * never show a thumbnail for media that is not there.
   */
  app.get("/api/clips/:id/thumbnail", async (c) => {
    const clip = await deps.getClip.execute(c.req.param("id"));
    if (!clip) return c.json({ error: "Clip not found" }, 404);

    const bytes = await deps.thumbnails.get(
      clip.streamId,
      clip.id,
      clip.startTime,
      await thumbnailSourceFor(deps, clip.streamId, clip.startTime),
    );
    if (!bytes || bytes.length === 0) return c.json({ error: "No thumbnail available" }, 404);
    // `new Uint8Array(...)` re-wraps into a non-shared ArrayBuffer: `Deno.readFile` returns
    // `Uint8Array<ArrayBufferLike>`, which Hono's `c.body` overload rejects (it wants
    // `Uint8Array<ArrayBuffer>`), and TS reports that as a missing-overload error rather than
    // a type mismatch at the call.
    return c.body(new Uint8Array(bytes), 200, {
      "Content-Type": "image/jpeg",
      // The cache KEY includes the clip's start time, so a frame drawn from a stale start can
      // never be served — there is no invalidation step to get wrong. The browser still needs
      // its own copy busted when the start changes, which the `?at=` query does.
      "Cache-Control": "private, max-age=300",
    });
  });

  app.post("/api/clips/:id/reject", async (c) => {
    const clip = await deps.rejectClip.execute(c.req.param("id"));
    // Rejecting REMOVES the clip from the review surface, so every surface showing it must be
    // told — this is the same publish the delete path needs, and its absence was the class of
    // bug where a mutation took up to 30s to appear.
    bus.publish(STREAM_CHANGED_TOPIC, { type: "stream_changed", streamId: clip.streamId, reason: "clip" });
    return c.json(clip);
  });

  // Persist review edits (trim endpoints).
  app.patch("/api/clips/:id", async (c) => {
    const body = await c.req.json();
    const patch: { startTime?: number; endTime?: number; title?: string | null } = {};
    if (body.startTime !== undefined) patch.startTime = Number(body.startTime);
    if (body.endTime !== undefined) patch.endTime = Number(body.endTime);
    // The clip's NAME. Not `axis`: that column is an engine enum (see the 0.8.0 migration).
    if (body.title !== undefined) patch.title = body.title === null ? null : String(body.title);
    const clip = await deps.updateClip.execute(c.req.param("id"), patch);
    return c.json(clip);
  });

  app.post("/api/clips/:id/export", async (c) => {
    const body = await c.req.json();
    const clipId = c.req.param("id");
    const result = await deps.exportClip.execute({ clipId, ...body });
    // "Export this clip" REPLACES the clip's file, exactly like the batch route: the previous run's
    // `exported` mark is stale the moment this one succeeds, so the badge must not keep claiming a
    // finished export while the new file sits there unverified by the UI.
    await deps.clearExportedMark.execute(clipId);
    return c.json(result, 201);
  });

  // ── The export LIST: durable references to the clips the user means to export ──
  //
  // References, not copies: the clip's boundaries, name and axis live in `clips`, and a snapshot
  // here would be a second owner that drifts the moment either side is edited.
  app.get("/api/export/list", async (c) => {
    const rows = await deps.exportList.list();
    const entries: ExportListEntry[] = [];
    for (const row of rows) {
      const clip = await deps.getClip.execute(row.clipId);
      // A clip the list points at but which no longer exists is reported with clip: null rather
      // than dropped — silently omitting it would make the list length disagree with what the user
      // added, and the page can then say so.
      const stream = clip ? await deps.getStream.execute(clip.streamId) : null;
      entries.push({
        clipId: row.clipId,
        streamId: clip?.streamId ?? "",
        streamTitle: stream?.title ?? "Unavailable",
        position: row.position,
        addedAt: row.addedAt,
        clip,
      });
    }
    return c.json({ entries });
  });

  app.post("/api/export/list", async (c) => {
    const body = await c.req.json() as { clipIds?: string[] };
    const clipIds = Array.isArray(body.clipIds) ? body.clipIds.filter((id) => typeof id === "string") : [];
    if (clipIds.length === 0) return c.json({ error: "clipIds is required" }, 400);
    await deps.exportList.add(clipIds);
    bus.publish(EXPORT_CHANGED_TOPIC, { type: "export_list", reason: "added" } as never);
    return c.json({ ok: true, added: clipIds.length });
  });

  app.delete("/api/export/list/:clipId", async (c) => {
    const clipId = c.req.param("clipId");
    await deps.exportList.remove(clipId);
    // Taking a clip OFF the list withdraws the request, so the `exported` mark must go with it.
    //
    // The mark says "a file was produced for this", and the user has just said they are not sending
    // it — leaving the badge up next to a clip they removed states the opposite of their own action.
    // The FILE is deliberately left alone: it is the user's, and a list edit must not delete an
    // export they still hold.
    await deps.clearExportedMark.execute(clipId);
    bus.publish(EXPORT_CHANGED_TOPIC, { type: "export_list", reason: "removed" } as never);
    return c.json({ ok: true });
  });

  app.delete("/api/export/list", async (c) => {
    // Same rule for the whole list: every entry is being withdrawn, so every mark goes with it.
    const clearing = await deps.exportList.liveIds();
    await deps.exportList.clear();
    for (const clipId of clearing) await deps.clearExportedMark.execute(clipId);
    bus.publish(EXPORT_CHANGED_TOPIC, { type: "export_list", reason: "cleared" } as never);
    return c.json({ ok: true });
  });

  // ── The export BATCH: durable, resumable, cancellable ──
  app.get("/api/export/queue", async (c) => c.json(await deps.exportQueue.view()));

  app.post("/api/export/queue", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      profile?: ExportProfile;
      outputDir?: string | null;
      filename?: string | null;
      clipIds?: string[];
    };
    // A profile the client sent is validated and refused BY NAME, exactly as the single-clip route
    // does: normalising it here would hand back a file labelled as something the user did not ask
    // for.
    if (body.profile) {
      const check = validateExportProfile({
        container: body.profile.container,
        videoCodec: body.profile.videoCodec,
        audioCodec: body.profile.audioCodec,
        maxHeight: body.profile.maxHeight,
      });
      if (!check.ok) return c.json({ error: `Invalid export profile: ${check.reason}` }, 400);
    }
    // The clips this batch will actually re-encode, resolved BEFORE enqueueing so the ids are the
    // real set (the body may omit `clipIds` and mean "everything on the list").
    //
    // An IMPLICIT batch — export-all, the body omitting `clipIds` — excludes clips that already
    // produced a file. Export-all is for the work still OUTSTANDING: re-encoding a clip that is
    // already done wastes the encode and, because this route clears the mark of everything it
    // accepts, destroys the only record that the file exists.
    //
    // An EXPLICIT `clipIds` list is filtered by nothing — there the user named the clips, so a
    // re-send is precisely what they asked for.
    let batchClipIds: string[];
    let skipped = 0;
    if (body.clipIds) {
      batchClipIds = body.clipIds;
    } else {
      const listed = await deps.exportList.liveIds();
      const resolved = await Promise.all(listed.map((id) => deps.getClip.execute(id)));
      ({ clipIds: batchClipIds, skipped } = selectImplicitBatch(resolved));
    }
    // The clips are named EXPLICITLY, even though the ids came from the list: `enqueueAll` would
    // otherwise re-read `liveIds()` and enqueue back the very clips this filter just removed.
    const result = await deps.exportQueue.enqueueAll({
      profile: normaliseProfile(body.profile ?? {}),
      outputDir: body.outputDir ?? null,
      filename: body.filename ?? null,
      clipIds: batchClipIds,
    });
    // A re-send REPLACES the file, so the previous run's `exported` mark stops being true the moment
    // this one is accepted. Leaving it up showed `✓ exported` for a clip whose new encode had not
    // even started. Done after the enqueue so a refused enqueue cannot clear a mark for work the
    // server never took on.
    for (const clipId of batchClipIds) await deps.clearExportedMark.execute(clipId);
    // `skipped` is reported rather than swallowed: a user who pressed Export all on a list where
    // some rows say "exported" is owed the reason those rows did not run.
    return c.json({ ...result, skipped }, 201);
  });

  app.delete("/api/export/queue", async (c) => {
    // Cancels every INCOMPLETE item and deletes the partial artifacts they left. Completed clips are
    // untouched — the owner's rule, and the reason this is not a "clear the queue" verb.
    const result = await deps.exportQueue.cancelIncomplete();
    return c.json({ ok: true, ...result });
  });

  app.delete("/api/export/queue/:clipId", async (c) => {
    const ok = await deps.exportQueue.cancelItem(c.req.param("clipId"));
    return c.json({ ok }, ok ? 200 : 404);
  });

  // ── Chat density (per-second message counts) for signal terrain ──
  app.get("/api/streams/:id/chat-density", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream || !stream.chatPath) return c.json({ error: "Chat not available" }, 404);
    try {
      if (!(await Deno.stat(stream.chatPath).then(() => true).catch(() => false))) {
        return c.json({ error: "Chat file not on disk" }, 404);
      }
      const msgs = await loadChat(stream.chatPath);
      const duration = stream.duration ?? Math.max(0, ...msgs.map((m) => m.t));
      const bucketCount = Math.max(1, Math.ceil(duration));
      const buckets = new Array(bucketCount).fill(0);
      for (const msg of msgs) {
        const sec = Math.floor(msg.t);
        if (sec >= 0 && sec < bucketCount) buckets[sec]++;
      }
      return c.json({ duration, density: buckets });
    } catch {
      return c.json({ error: "Cannot read chat file" }, 500);
    }
  });

  // ── Markers (P1-8): external shortlist evidence, fetched on demand ──
  app.get("/api/streams/:id/markers", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream) return c.json({ error: "Stream not found" }, 404);

    // Cached in stream metadata on first fetch.
    const cached = await deps.metadata.get(stream.id, "markers");
    if (cached) {
      try {
        return c.json(JSON.parse(cached) as { markers: { t: number; label: string; source: string }[] });
      } catch {
        // fall through to refetch
      }
    }

    if (!stream.sourceUrl) {
      return c.json({ markers: [] }); // local files have no marker source
    }
    const markers = await deps.vod.fetchMarkers(stream.sourceUrl);
    await deps.metadata.set(stream.id, "markers", JSON.stringify({ markers }));
    return c.json({ markers });
  });

  // ── Regimes: persisted segmentation boundaries for the timeline ──
  app.get("/api/streams/:id/regimes", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream) return c.json({ error: "Stream not found" }, 404);
    const raw = await deps.metadata.get(stream.id, "regimes_json");
    const regimes = raw ? JSON.parse(raw) as { start: number; end: number; type: string }[] : [];
    return c.json({ regimes });
  });

  // ── Transcript (P0-8): parsed SRT cues for the caption editor ──
  app.get("/api/streams/:id/transcript", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream) return c.json({ error: "Stream not found" }, 404);
    const stored = await deps.metadata.get(stream.id, "transcript_srt");
    if (!stored) return c.json({ error: "No transcript — run processing first" }, 404);
    let srtPath: string;
    try {
      srtPath = (JSON.parse(stored) as { path: string }).path;
    } catch {
      return c.json({ error: "Corrupt transcript metadata" }, 500);
    }
    try {
      const content = await Deno.readTextFile(srtPath);
      const cues = parseSrt(content);
      return c.json({ cues, srtPath });
    } catch {
      return c.json({ error: "Transcript file missing on disk" }, 404);
    }
  });

  // Persist caption edits (P0-8): apply text replacements by cue index,
  // rewrite the SRT on disk. Cue index = position in the GET response.
  app.patch("/api/streams/:id/transcript", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream) return c.json({ error: "Stream not found" }, 404);
    const body = await c.req.json() as { edits?: { index: number; text: string }[] };
    if (!Array.isArray(body.edits)) return c.json({ error: "edits[] required" }, 400);

    const stored = await deps.metadata.get(stream.id, "transcript_srt");
    if (!stored) return c.json({ error: "No transcript to edit" }, 404);
    let srtPath: string;
    try {
      srtPath = (JSON.parse(stored) as { path: string }).path;
    } catch {
      return c.json({ error: "Corrupt transcript metadata" }, 500);
    }

    let content: string;
    try {
      content = await Deno.readTextFile(srtPath);
    } catch {
      return c.json({ error: "Transcript file missing on disk" }, 404);
    }

    const cues = parseSrt(content);
    let applied = 0;
    for (const edit of body.edits) {
      const cue = cues[edit.index - 1];
      if (!cue) continue; // stale index — skip rather than corrupt neighbors
      if (typeof edit.text !== "string" || edit.text.trim() === "") continue;
      cue.text = edit.text.trim();
      applied++;
    }
    if (applied > 0) {
      await Deno.writeTextFile(srtPath, cuesToSrt(cues));
    }
    return c.json({ ok: true, applied });
  });

  // ── Chat messages (paginated, seek-aware) ──
  app.get("/api/streams/:id/chat", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream || !stream.chatPath) return c.json({ error: "Chat not available" }, 404);
    try {
      const msgs = await loadChat(stream.chatPath);
      const limit = Math.min(500, parseInt(c.req.query("limit") ?? "100", 10));
      const around = c.req.query("around");

      if (around !== null && around !== undefined) {
        const aroundSec = parseFloat(around) || 0;
        let lo = 0, hi = msgs.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (msgs[mid]!.t < aroundSec) lo = mid + 1;
          else hi = mid;
        }
        const start = Math.max(0, lo - Math.floor(limit / 2));
        const end = Math.min(msgs.length, start + limit);
        return c.json({ messages: msgs.slice(start, end), total: msgs.length, offset: start });
      }

      const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10));
      return c.json({ messages: msgs.slice(offset, offset + limit), total: msgs.length, offset });
    } catch {
      return c.json({ error: "Cannot read chat file" }, 500);
    }
  });

  // ── Chat search ──
  app.get("/api/streams/:id/chat/search", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream || !stream.chatPath) return c.json({ error: "Chat not available" }, 404);
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ results: [] });
    try {
      const msgs = await loadChat(stream.chatPath);
      const lower = q.toLowerCase();
      const results = msgs
        .filter((m) => m.body.toLowerCase().includes(lower))
        .slice(0, 200);
      return c.json({ results });
    } catch {
      return c.json({ error: "Cannot read chat file" }, 500);
    }
  });
  // ── Seek-aware streaming waveform (SSE) ──
  // Each peak batch carries {firstIndex, startTime, peaks} so the frontend
  // knows WHERE on the timeline to place the data (regardless of arrival order).
  // Accepts ?around=<seconds> to prioritize decoding near the seek point.

  // One peak per second of audio — full resolution, no quantization at any zoom.
  // A 10h stream = 36000 peaks ≈ 352KB JSON, negligible. ~141KB as Float32 binary.
  const TARGET_PEAKS_PER_SEC = 1;

  /**
   * Seconds of media actually present in a file, by ffprobe.
   *
   * For a growing fragmented MP4 this is the muxed extent: the fragments written so far. It is
   * the only honest measure of what a decode of that file can return, which is why the waveform
   * is sized from it rather than from the downloader's in-flight counter.
   */
  const probeMediaSeconds = async (path: string): Promise<number> => {
    try {
      const out = await run(deps.tools.ffprobe, {
        args: ["-v", "quiet", "-print_format", "json", "-show_format", path],
      });
      const info = JSON.parse(new TextDecoder().decode(out.stdout));
      const sec = parseFloat(info.format?.duration ?? "0");
      return Number.isFinite(sec) && sec > 0 ? sec : 0;
    } catch {
      return 0;
    }
  };
  const SAMPLE_RATE = 8000;
  const BATCH_SIZE = 50; // ~50s per batch, fewer SSE events

  /** Run ffmpeg for a time range, compute peaks, yield batches. */
  /**
   * How many waveform decodes may run at once.
   *
   * The Review screen re-requests the waveform every ~30s of newly downloaded media, and
   * each request decodes the media that exists. Each decode is a separate ffmpeg process
   * and only ONE cache entry exists (a partial waveform is deliberately never cached), so
   * without a cap a burst of refetches starts several full-file decodes on a machine the
   * owner also uses for the download itself. Measured during diagnosis: successive
   * requests produced a new ffmpeg every second.
   */
  const MAX_CONCURRENT_WAVEFORMS = 2;
  let waveformsInFlight = 0;

  async function* streamPeaks(
    vodPath: string,
    startSec: number,
    durationSec: number | null, // null = to end of file
    firstIndex: number,
    totalSamples: number,
    /** Aborted when the client goes away, so the decode does not run on unwatched. */
    signal?: AbortSignal,
  ): AsyncGenerator<{ firstIndex: number; startTime: number; peaks: number[] }> {
    const args = [
      "-threads", "0",        // auto-detect CPU cores
      "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-",
    ];
    if (startSec > 0) args.unshift("-ss", String(startSec));
    if (durationSec !== null) args.unshift("-t", String(durationSec));
    args.unshift("-i", vodPath);

    // Wait for a slot: a refetch burst must not stack full-file decodes on the machine
    // that is concurrently doing the download.
    while (waveformsInFlight >= MAX_CONCURRENT_WAVEFORMS) {
      if (signal?.aborted) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    waveformsInFlight++;
    console.log(`[waveform] decode start (${waveformsInFlight}/${MAX_CONCURRENT_WAVEFORMS} in flight)`);

    // Declared before the try so `finally` can always release the slot, even if the
    // spawn itself throws (a missing ffmpeg binary is exactly that case).
    let proc: ChildHandle | undefined;
    let reader: { read(): Promise<{ done: boolean; value: Uint8Array | undefined }>; releaseLock?(): void } | undefined;

    const peakBuf: number[] = [];
    // ── WHY A FIXED RING AND NOT A GROWING ARRAY ────────────────────────────────────
    // This accumulated with `new Float32Array(acc.length + incoming.length)` and copied
    // the WHOLE accumulator on every read from ffmpeg — the same O(n^2) shape that has
    // already frozen this app twice (the fMP4 muxer's stdout, then the box parser).
    // Measured for one 55-minute VOD at this route's 8kHz mono: 79-159GB copied, which is
    // 8-17 seconds of pure memcpy, SYNCHRONOUSLY on the event loop that serves every
    // request. The Review screen requests a waveform as soon as a download starts, so this
    // ran while the download was live — and blocked HTTP for the duration, which is
    // exactly the owner's "the download is frozen and no backend actions happen anymore".
    //
    // A peak needs exactly `totalSamples` samples, so nothing ever has to hold more than
    // that: write into a buffer of exactly that size, collapse it to a peak when it fills,
    // and start over. One copy-free path, constant memory, no reallocation.
    const acc = new Float32Array(totalSamples);
    let accLen = 0;
    let peakIdx = firstIndex;
    const peakTime = totalSamples / SAMPLE_RATE; // seconds per peak = samples ÷ samples/sec

    /** Collapse the accumulator into one peak and reset it. */
    const flushPeak = () => {
      let max = 0;
      for (let i = 0; i < accLen; i++) max = Math.max(max, Math.abs(acc[i] ?? 0));
      peakBuf.push(max);
      accLen = 0;
    };

    try {
      proc = spawnChild(deps.tools.ffmpeg, { args, stdout: "piped" });
      reader = proc.stdout?.getReader();
      if (!reader) throw new Error("ffmpeg waveform output was not captured");

      while (true) {
        // Stop the moment the client is gone: without this the generator kept decoding to
        // EOF for a consumer that had stopped reading, and the child was never killed.
        if (signal?.aborted) break;
        const { done, value } = await reader.read();
        if (value) {
          const incoming = new Float32Array(value.buffer, value.byteOffset, Math.floor(value.length / 4));
          let off = 0;
          while (off < incoming.length) {
            const take = Math.min(totalSamples - accLen, incoming.length - off);
            acc.set(incoming.subarray(off, off + take), accLen);
            accLen += take;
            off += take;
            if (accLen >= totalSamples) flushPeak();
          }
        }

        while (peakBuf.length >= BATCH_SIZE) {
          if (closed) break;
          const batch = peakBuf.splice(0, BATCH_SIZE);
          const startTime = peakIdx * peakTime;
          peakIdx += BATCH_SIZE;
          yield { firstIndex: peakIdx - BATCH_SIZE, startTime, peaks: batch };
        }

        if (done) break;
      }

      // Flush remainder.
      if (accLen > 0) flushPeak();
      if (peakBuf.length > 0) {
        const startTime = peakIdx * peakTime;
        peakIdx += peakBuf.length;
        yield { firstIndex: peakIdx - peakBuf.length, startTime, peaks: [...peakBuf] };
      }
    } finally {
      waveformsInFlight--;
      try { reader?.releaseLock?.(); } catch { /* ok */ }
      // Client disconnect must not leave a full-speed audio decode running to
      // EOF — kill the process, then reap it.
      try { proc?.kill(); } catch { /* already exited */ }
      try { await proc?.status; } catch { /* ok */ }
    }
  }

  app.get("/api/streams/:id/waveform", (c) => {
    const streamId = c.req.param("id");
    const around = parseFloat(c.req.query("around") ?? "0") || 0;

    const body = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Controller already closed (client disconnected).
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };

        // ── CANCEL THE DECODE WHEN THE CLIENT GOES AWAY ─────────────────────────────
        // This stream had no cancellation. `streamPeaks` decodes the file TO EOF (`-t` is
        // omitted), and its `finally` — the only thing that kills the ffmpeg child — runs
        // only when the generator is exhausted or thrown into. A consumer that navigates
        // away, or a request that times out, simply stops pulling: the decode ran on at
        // full speed, the child was never killed, and each abandoned view stacked another.
        // On the owner's machine the backend became unreachable while this was happening,
        // so an unbounded set of full-file audio decodes is exactly the kind of load that
        // produces it.
        const abort = new AbortController();
        const onClientGone = () => {
          closed = true;
          abort.abort();
          console.log(`[waveform ${streamId}] client disconnected — cancelling the decode`);
        };
        try {
          c.req.raw.signal.addEventListener("abort", onClientGone, { once: true });
        } catch {
          // Older runtimes may not expose the request signal; the SSE `close()` guard
          // still stops the work at the next yield.
        }

        try {
          const stream = await deps.getStream.execute(streamId);
          if (!stream) {
            send({ error: "Video not available" });
            close();
            return;
          }
          // The waveform decodes whatever media the player uses — the mp4
          // twin when present (same bytes the video route serves), else the
          // source vodPath. Without this, a mid-download stream has no
          // vodPath yet and the spectrum stays empty while video plays.
          const dl = await deps.downloadState(streamId);
          let mediaPath = stream.vodPath ?? "";
          const statOk = (p: string) => Deno.stat(p).then(() => true).catch(() => false);
          if (!mediaPath || !(await statOk(mediaPath))) {
            const twin = dl.proxyMp4 ?? dl.hqMp4;
            mediaPath = twin && await statOk(twin) ? twin : "";
          }
          if (!mediaPath) {
            send({ error: "Video not available" });
            close();
            return;
          }

          // Media duration is needed both for cache staleness and for the
          // waveform extent — probe it before deciding to trust the cache.
          const probeOut = await run(deps.tools.ffprobe, {
            args: ["-v", "quiet", "-print_format", "json", "-show_format", mediaPath],
          });
          const probeInfo = JSON.parse(new TextDecoder().decode(probeOut.stdout));
          const mediaDuration = parseFloat(probeInfo.format?.duration ?? "0");
          if (!mediaDuration) {
            send({ error: "Cannot determine duration" });
            close();
            return;
          }

          // ── Cache check: if waveform was already computed, serve instantly. ──
          // Staleness: old caches had a fixed 2000 peaks. Per-second resolution
          // needs totalPeaks >= duration. If stale, fall through to recompute.
          const cached = await deps.metadata.get(streamId, "waveform");
          if (cached) {
            const cachePath = JSON.parse(cached).path;
            try {
              const raw = await Deno.readTextFile(cachePath);
              const cachedData = JSON.parse(raw) as { duration: number; totalPeaks: number; peaks: number[] };
              if (cachedData.totalPeaks < cachedData.duration) {
                // Stale low-res cache — recompute at per-second resolution.
                throw new Error("stale cache");
              }
              // A cache computed while the download was still running covers
              // only part of the media; once the file is longer, recompute.
              if ((cachedData.duration || 0) < mediaDuration) {
                throw new Error("stale partial cache");
              }
              send({ duration: cachedData.duration, totalPeaks: cachedData.totalPeaks });
              for (let i = 0; i < cachedData.peaks.length; i += BATCH_SIZE) {
                if (closed) break;
                const slice = cachedData.peaks.slice(i, i + BATCH_SIZE);
                send({ firstIndex: i, startTime: (i / cachedData.peaks.length) * cachedData.duration, peaks: slice });
              }
              send({ done: true });
              close();
              return;
            } catch {
              // Cache file missing/corrupt/stale — fall through to recompute.
            }
          }

          // ── Cache miss: compute from ffmpeg. ──
          const duration = mediaDuration;
          // While a download is running, the file is still growing: only the bytes already
          // written can be decoded, so the waveform must cover exactly what EXISTS.
          //
          // The extent comes from probing the FILE, never from the downloader's
          // `*FrontierSec`. That counter is incremented as chunks are written to ffmpeg's STDIN
          // and ffmpeg buffers, so it runs AHEAD of the media actually muxed — measured on a
          // live 360p download: frontier 1250s / 2260s / 3070s while the file's own duration
          // read 1418s / 2460s / 3244s, i.e. the counter was behind in the middle and overshot
          // at the end. The decoded peak array is produced from the file, so a count of peaks
          // derived from a different number than the file's length is what made the drawn
          // waveform reach further than the audio it holds (the owner's "not fully correctly
          // scaled as the video was built fragment by fragment").
          //
          // ffprobe on a growing fragmented MP4 reports the duration of the fragments present,
          // which is exactly "where the mux reaches" (measured: truncating a 60s file to 50%
          // reported 32.07s, to 80% reported 50.07s — linear in the bytes present).
          const dlState = await deps.downloadState(streamId);
          const downloading = dlState.phase === "running";
          const muxedSec = downloading ? await probeMediaSeconds(mediaPath) : 0;
          const extent = downloading && muxedSec > 0
            ? Math.min(duration, muxedSec)
            : duration;
          // Peaks are per SECOND (TARGET_PEAKS_PER_SEC = 1), so the peak count IS the extent in
          // seconds. Stated as a product only because the rate is a named constant.
          const totalPeaks = Math.max(1, Math.round(extent * TARGET_PEAKS_PER_SEC));
          send({ duration, totalPeaks, extentSec: extent, downloading });

          // 2. Compute peaks per bucket and priority region.
          const samplesPerPeak = Math.max(1, Math.floor(SAMPLE_RATE / TARGET_PEAKS_PER_SEC));
          const peakTime = 1 / TARGET_PEAKS_PER_SEC; // seconds per peak
          const aroundIndex = Math.max(0, Math.min(totalPeaks - 1, Math.floor(around * TARGET_PEAKS_PER_SEC)));

          // Accumulate all peaks for caching.
          const allPeaks = new Array<number>(totalPeaks).fill(-1);

          // 3. Stream priority region (from aroundIndex to end) first.
          for await (const batch of streamPeaks(
            mediaPath,
            aroundIndex * peakTime,
            downloading ? Math.max(0, extent - aroundIndex * peakTime) : null,
            aroundIndex,
            samplesPerPeak,
            abort.signal,
          )) {
            if (closed) break;
            for (let i = 0; i < batch.peaks.length; i++) {
              allPeaks[batch.firstIndex + i] = batch.peaks[i]!;
            }
            send(batch);
          }

          // 4. Then stream the beginning (0 to aroundIndex), filling the gap.
          if (!closed && aroundIndex > 0) {
            for await (const batch of streamPeaks(
              mediaPath,
              0,
              aroundIndex * peakTime,
              0,
              samplesPerPeak,
              abort.signal,
            )) {
              if (closed) break;
              for (let i = 0; i < batch.peaks.length; i++) {
                allPeaks[batch.firstIndex + i] = batch.peaks[i]!;
              }
              send(batch);
            }
          }

          // The client is gone: stop here rather than continuing to compute (and cache)
          // a result nobody will receive. `streamPeaks` already broke out and killed its
          // ffmpeg child; this prevents the FOLLOW-UP work as well.
          if (closed || abort.signal.aborted) {
            console.log(`[waveform ${streamId}] aborted mid-decode — not computing further`);
            close();
            return;
          }
          send({ done: true });

          // Cache only a COMPLETE waveform — a mid-download partial must not
          // be cached, or it would persist after the video finished (the
          // reported "did not regenerate when the video completed").
          if (!closed && !downloading && allPeaks.every((v) => v >= 0)) {
            await deps.storage.ensureStreamDirs(streamId);
            const cachePath = deps.storage.artifactPath(streamId, "waveform.json");
            await Deno.writeTextFile(cachePath, JSON.stringify({ duration, totalPeaks, peaks: allPeaks }));
            await deps.metadata.set(streamId, "waveform", JSON.stringify({ path: cachePath, duration, totalPeaks }));
          }
        } catch (e) {
          send({ error: `Waveform streaming failed: ${e}` });
        } finally {
          close();
        }
      },
    });

    return c.newResponse(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // ── Settings ──
  // ── ffmpeg presence + on-demand provisioning ─────────────────────────────
  // The app does not bundle ffmpeg (~330MB of payload, and the outlier: every
  // comparable tool resolves an existing binary). The UI asks first, then this
  // installs into app data. `available` gates every job/export path.
  app.get("/api/tools", (c) => c.json(deps.tools.status()));

  // ── window chrome ─────────────────────────────────────────────────────────
  // The app draws its own header and, when the window is frameless, must also
  // provide a close action: with no OS decoration there is no other way out. The
  // capability report is served rather than assumed, so the UI never renders a
  // button for something the window class cannot do. Measured against the runtime:
  // minimize/maximize are ABSENT from BrowserWindow.
  app.get("/api/window", (c) => c.json(chromeState()));

  // The app's own log file, readable from the UI. A packaged desktop app has no console,
  // so without this a user seeing a failure has no way to send evidence — which is exactly
  // what happened when the owner reported the download freeze and the missing chrome.
  app.get("/api/log", async (c) => {
    const tail = await readLogTail();
    return c.text(tail, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  // Where the log lives, and whether file logging is on at all. Also reports the window
  // adoption failure (if any), because that is invisible in the UI otherwise.
  app.get("/api/diagnostics", (c) =>
    c.json({
      logPath: logFilePath(),
      logEnabled: Boolean(logFilePath()),
      chrome: chromeState(),
      // displayVersion(), NOT the raw field. `Deno.desktopVersion` is NULL on the Windows target even
      // when the version is baked in (measured — that is why app-version.ts exists), so reading it
      // directly reported "dev" on every packaged Windows build. Verified on a real run: with
      // SEMACLIP_VERSION=26.999 this endpoint answered "dev" while the app's actual version was
      // 26.999, which is the one fact diagnostics exists to report.
      version: displayVersion(),
      os: Deno.build.os,
      serveAddress: Deno.env.get("DENO_SERVE_ADDRESS") ?? null,
    }));

  // The UPDATER's own log, which is written by a separate process the app cannot read through the
  // normal log path.
  //
  // Start the download the user asked for. The check only OFFERS an update now, so this is the
  // one way bytes move: without it a newer version would be visible and never fetched.
  //
  // The reply returns as soon as the transfer STARTS. Holding the request open for a 100MB download
  // would give the UI a request it cannot render progress for; the progress arrives over
  // /api/events, which is what the banner already listens to.
  app.post("/api/update/download", (c) => {
    const res = startUpdateDownload();
    return c.json(res, res.started ? 200 : 409);
  });

  // The app starts the updater detached with its output discarded, so when an update failed the user
  // had nothing to report but "a console flashed and closed". This is that process's account of what
  // it did, and it is the difference between a diagnosable failure and a guess.
  app.get("/api/update/log", async (c) => {
    const path = updateLogPath();
    try {
      const text = await Deno.readTextFile(path);
      // Bounded like the app log: this file is appended to on every attempt.
      return c.text(text.slice(-40_000), 200, { "Content-Type": "text/plain; charset=utf-8" });
    } catch {
      return c.text(`no updater log at ${path}`, 200, { "Content-Type": "text/plain; charset=utf-8" });
    }
  });

  // Real update state, so Settings reports what is true instead of describing the
  // mechanism. A packaged build answers with its baked version; a dev run answers with
  // nulls and the UI shows the dev case rather than inventing a version.
  app.get("/api/update", (c) => c.json(updateStatus()));

  // Re-run the update check on request. The automatic check is once-per-launch (the owner's policy),
  // so without this a transient failure at open — or a download interrupted by closing the app —
  // means no update until the next launch. A no-op while a check is already running, so pressing the
  // button twice cannot start two 100MB downloads.
  app.post("/api/update/check", (c) => {
    const result = retryUpdateCheck();
    return c.json(result, result.started ? 200 : 409);
  });

  // ── Dev hook: release a staged-update event without a compiled release ────────
  //
  // The real stage needs a packaged binary polling a real manifest, so the whole
  // prompt path (SSE → EventSource → banner → restart) would otherwise be verifiable
  // only on a machine running a published build. Gated on an explicit env var, never
  // registered otherwise, and it cannot stage anything — it only emits the event the
  // runtime's own callback emits.
  if (Deno.env.get("SEMACLIP_DEV_HOOKS") === "1") {
    app.post("/api/_test/stage-update", async (c) => {
      const body = await c.req.json().catch(() => ({})) as { version?: string; canApplyByRestart?: boolean };
      const version = body.version ?? "0.0.0-test";
      const canRestart = body.canApplyByRestart ?? (Deno.build.os !== "windows");
      emitAppEvent({ type: "update-staged", version, canApplyByRestart: canRestart });
      return c.json({ emitted: version });
    });
  }

  // App events, so a staged update reaches the UI the instant it happens instead of at
  // the next poll. A late subscriber is replayed what it missed, because the update
  // check runs during boot and can finish before the webview has connected.
  app.get("/api/events", (c) => {
    const body = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        const send = (e: Parameters<typeof sseFrame>[0]) => {
          try {
            controller.enqueue(enc.encode(sseFrame(e)));
          } catch {
            // The client went away; unsubscribe below runs from the abort handler.
          }
        };
        const unsubscribe = subscribeAppEvents(send);
        // A keep-alive keeps intermediaries from closing an idle stream. Comment frames
        // are ignored by EventSource, so this cannot be mistaken for an event.
        const beat = setInterval(() => {
          try {
            controller.enqueue(enc.encode(": keep-alive\n\n"));
          } catch {
            // closed
          }
        }, 25000);
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(beat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            // already closed
          }
        });
      },
    });
    return c.newResponse(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      },
    });
  });

  // Restart to apply a staged update. The reply says whether a restart was STARTED —
  // the process exits immediately after, so a client cannot observe success any other way.
  app.post("/api/window/restart", async (c) => {
    const result = await restartApp();
    return c.json(result, result.restarting ? 200 : 500);
  });

  app.post("/api/window/close", (c) => {
    // Fire the close and report whether it was accepted; the process exits from the
    // window's own close handler, which is also what the OS button triggers.
    return c.json({ closing: closeWindow() });
  });

  // Minimize and maximize, for the app's own chrome.
  //
  // The window class does not expose either (re-verified against the installed runtime: the only
  // `minimize`/`maximize` strings in it belong to `Intl.Locale`), so with the native frame
  // removed the app has to provide the buttons AND the actions. Both are implemented in
  // win-frame.ts against user32, and each reports what the OS did rather than what was asked.
  app.post("/api/window/minimize", (c) => {
    // Minimize TO THE TASKBAR on both platforms (Win32 SW_MINIMIZE / GTK iconify), so the window
    // keeps a taskbar entry the user can click to get it back. The earlier version hid it, which
    // left no taskbar button and let the process exit — the owner saw exactly that.
    const ok = minimizeWindow();
    return c.json({ minimizing: ok });
  });

  app.post("/api/window/maximize", (c) => {
    const res = toggleMaximizeWindow();
    return c.json(res ?? { maximized: false, unsupported: true });
  });

  // Start a window move, from a press in the app's own chrome bar.
  //
  // The two platforms use different mechanisms and that is NOT a preference. Linux hands the press
  // to GTK's move loop (`gtk_window_begin_move_drag`), which owns the input there. Windows cannot:
  // the press is captured by WebView2's own process, so the OS move loop never starts however the
  // Win32 call is spelled (`ReleaseCapture` + `WM_NCLBUTTONDOWN` returns success and moves nothing).
  // Windows therefore follows the pointer instead — /drag/move below.
  //
  // `x`/`y` are the press position in window coordinates; `button` is 1 (left).
  app.post("/api/window/drag", async (c) => {
    const body = await c.req.json().catch(() => ({})) as { x?: number; y?: number; button?: number };
    const started = beginWindowDrag(Number(body.x ?? 0), Number(body.y ?? 0));
    return c.json({ dragging: started });
  });

  /**
   * Continue a pointer-following window move (Windows).
   *
   * Takes NO coordinates: the server reads the cursor itself with `GetCursorPos` and moves the
   * window with `SetWindowPos`, both in native physical pixels. Sending coordinates from the DOM
   * would mean converting CSS pixels through `devicePixelRatio` and the client/screen origin, which
   * is two chances to be wrong for no benefit — and it would make a synthetic test unable to drive
   * the path, since a test can move the real cursor but cannot fake the DOM's.
   */
  app.post("/api/window/drag/move", (c) => {
    const moved = continueWindowDrag();
    return c.json({ moved: moved !== null, position: moved });
  });

  /** End a window move, so a lost mouse-up cannot leave a stale grab offset. */
  app.post("/api/window/drag/end", (c) => {
    endWindowDrag();
    return c.json({ dragging: false });
  });

  /**
   * Start an OS-run resize from one of the app's own edge handles.
   *
   * On Windows this reports `false` on purpose: the resize borders are the OS's own (WS_THICKFRAME
   * is kept), so there is nothing for the app to drive and no handles are drawn. On Linux the app
   * draws handles and this calls `gtk_window_begin_resize_drag`.
   */
  app.post("/api/window/resize", async (c) => {
    const body = await c.req.json().catch(() => ({})) as {
      edge?: string;
      x?: number;
      y?: number;
      button?: number;
    };
    const edge = body.edge as ResizeEdge | undefined;
    const valid: ResizeEdge[] = ["nw", "n", "ne", "w", "e", "sw", "s", "se"];
    if (!edge || !valid.includes(edge)) {
      return c.json({ resizing: false, error: "edge must be one of nw,n,ne,w,e,sw,s,se" }, 400);
    }
    const started = beginWindowResize(edge, Number(body.x ?? 0), Number(body.y ?? 0));
    return c.json({ resizing: started, edge });
  });

  /** Restore/raise the window (the counterpart to minimize). */
  app.post("/api/window/restore", (c) => c.json({ restored: restoreWindow() }));

  app.post("/api/tools/ffmpeg", async (c) => {
    const status = deps.tools.status();
    if (status.available) {
      return c.json({ skipped: true, reason: "ffmpeg is already available", paths: status.paths });
    }
    if (!status.downloadable) {
      return c.json({
        error: "ffmpeg is not available and cannot be downloaded (an override is set)",
      }, 409);
    }
    // Streamed as SSE: this is a 65-82MB transfer and a silent multi-minute POST
    // with no progress reads as a hang.
    const stream = new ReadableStream({
      start: async (controller) => {
        const send = (event: unknown) => {
          controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        try {
          const result = await provisionFfmpeg(status.managedDir, {
            onProgress: (p) => send({ type: "progress", ...p }),
          });
          await deps.tools.refresh();
          send({ type: "done", paths: { ffmpeg: result.ffmpeg, ffprobe: result.ffprobe } });
        } catch (err) {
          send({ type: "error", message: err instanceof Error ? err.message : String(err) });
        } finally {
          controller.close();
        }
      },
    });
    return new Response(stream, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store" },
    });
  });

  app.get("/api/settings", async (c) => c.json(await deps.settings.get()));
  app.put("/api/settings", async (c) => {
    const body = await c.req.json();
    return c.json(await deps.settings.update(body));
  });

  // ── Export presets (P0-7) ──
  app.get("/api/presets", async (c) => c.json(await deps.presets.list()));
  app.put("/api/presets/:id", async (c) => {
    const body = await c.req.json() as { name?: string; profile?: unknown };
    if (!body.name || typeof body.name !== "string") {
      return c.json({ error: "name is required" }, 400);
    }
    // Upsert with the URL id — the body cannot mint arbitrary ids.
    const id = c.req.param("id");
    const existing = (await deps.presets.list()).find((p) => p.id === id);
    // A preset IS a profile, so the profile is NORMALISED on the way in and out: every field filled,
    // the quality clamped to the codec's useful band, and an unencodable codec/container pair
    // degraded to the container's default. Same policy as reading a stored row, because that is
    // exactly what this is — a stored row. (A REQUEST to export is validated instead; see
    // ExportClipUseCase.)
    await deps.presets.save({
      id,
      name: body.name,
      profile: normaliseProfile((body.profile ?? {}) as Partial<ExportProfile>),
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      // A preset created through this endpoint is the USER's by definition; the seeded ones come from
      // the container's DEFAULT_PRESETS and are inserted with `seeded`. An existing row keeps its
      // origin (the repo does not update the column on conflict), so this cannot promote a seeded
      // preset into a deletable one by re-saving over it.
      origin: existing?.origin ?? "user",
    });
    bus.publish(EXPORT_CHANGED_TOPIC, { type: "export_list", reason: "added" } as never);
    return c.json({ ok: true }, 201);
  });
  app.delete("/api/presets/:id", async (c) => {
    const id = c.req.param("id");
    /**
     * A SEEDED preset is refused BY NAME, and the refusal is the point of this route rather than an
     * extra guard on it.
     *
     * These are the starting points the app guarantees, not the user's artefacts: deleting one removes
     * a profile that every future export is offered, and nothing restores it short of a reinstall. The
     * UI only hides the button for them, and a hidden button is not a policy — any client can call
     * this, and the server is where the data lives.
     */
    const origin = await deps.presets.originOf(id);
    if (origin === "seeded") {
      return c.json({ error: `Preset '${id}' ships with the app and cannot be deleted` }, 409);
    }
    if (origin === null) return c.json({ error: `No such preset: ${id}` }, 404);
    await deps.presets.delete(id);
    bus.publish(EXPORT_CHANGED_TOPIC, { type: "export_list", reason: "removed" } as never);
    return c.json({ ok: true });
  });

  // ── System info ──
  // Detect available compute devices: NVIDIA GPUs via nvidia-smi + CPU.
  // The frontend renders these as a single device selector.
  // gpuDevice = null means "auto" (first available GPU, or CPU if none).
  // gpuDevice = -1 means "force CPU".
  app.get("/api/system/devices", async (c) => {
    const devices: { id: string; label: string; index: number | null; type: "gpu" | "cpu"; memoryMB: number }[] = [];

    // Detect NVIDIA GPUs.
    try {
      const out = await run("nvidia-smi", {
        args: ["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
      });
      const text = new TextDecoder().decode(out.stdout).trim();
      if (text) {
        for (const line of text.split("\n")) {
          const [idx, name, mem] = line.split(",").map((s) => s.trim());
          const index = parseInt(idx ?? "0", 10);
          const memoryMB = parseInt(mem ?? "0", 10);
          devices.push({ id: `gpu-${index}`, label: name ?? "Unknown GPU", index, type: "gpu", memoryMB });
        }
      }
    } catch {
      // nvidia-smi not found — no NVIDIA driver or not in PATH.
    }

    // CPU is always available. Index -1 signals "use CPU" to the engine.
    const cpuCores = navigator.hardwareConcurrency ?? 0;
    devices.push({
      id: "cpu",
      label: `CPU${cpuCores > 0 ? ` (${cpuCores} cores)` : ""}`,
      index: -1,
      type: "cpu",
      memoryMB: 0,
    });

    return c.json(devices);
  });

  // ── GPU encode capability (probeGpuEncoder, vendor-aware) ──
  // Surface the detected encode path so Settings can show what the proxy
  // will use. Probed live (test-encode), not assumed from vendor strings.
  app.get("/api/system/gpu-encoder", async (c) => {
    // Per codec: which hardware encoder exists differs by codec, and so does the answer. The speed is
    // the MEASURED one for that encoder, or null when nothing was measured — the UI distinguishes
    // "no hardware here" from "hardware here, speed unmeasured" rather than inventing a number.
    const codec = (c.req.query("codec") ?? "h264") as VideoCodec;
    const cap = await probeGpuEncoder({ codec });
    const speed = cap.backend === "cpu"
      ? null
      : (HW_QUALITY_BANDS[codec].speed ?? null);
    return c.json({ backend: cap.backend, encoder: cap.encoder ?? null, speed, detail: cap.reason ?? "" });
  });

  /**
   * What the SOURCE video is: codec, bitrate, fps, dimensions.
   *
   * The export UI needs it for two decisions it cannot make honestly without it: whether the source's
   * bitrate can be reused at all (only when the output format matches the source's codec), and what
   * "the original bitrate" actually is as a number.
   */
  app.get("/api/streams/:id/source-media", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream) return c.json({ error: "Stream not found" }, 404);
    // The FULL-QUALITY source, not the proxy: the proxy is a low-bitrate preview and its bitrate would
    // be presented as "the original", which would be wrong by an order of magnitude.
    const path = stream.vodPath;
    if (!path) return c.json(null);
    try {
      await Deno.stat(path);
    } catch {
      // A recorded path is a claim; the folder may have moved. Report unmeasured rather than 500.
      return c.json(null);
    }
    return c.json(await deps.mediaProbe.probeSourceMedia(path));
  });

  /**
   * Every encoder the user could pick for a codec on THIS machine.
   *
   * Distinct from `/gpu-encoder`, which answers "what should we use by default?" and stops at the
   * first working family. This one tries every family and reports each that genuinely encodes, so the
   * picker offers the machine's real options instead of one winner — or, previously, none at all for
   * every codec whose hardware was not nvenc.
   */
  app.get("/api/system/encoders", async (c) => {
    const codec = (c.req.query("codec") ?? "h264") as VideoCodec;
    const options = await listEncodersFor({ codec });
    return c.json(options.map((o) => ({
      ...o,
      // Keyed by the ENCODER, not the backend: this host's `h264_nvenc` and `h264_vaapi` are
      // different silicon, and lending one's measurement to the other would read as measured.
      speed: MEASURED_ENCODER_SPEEDS[o.encoder] ?? null,
    })));
  });

  // ── Video file serving (range requests for <video>) ──
  // Video streaming — prefers the proxy proxy (P0-10) when one was generated
  // during processing; falls back to the source VOD.
  app.get("/api/video/:streamId", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("streamId"));
    if (!stream) return c.json({ error: "Video not available" }, 404);

    // Review playback serves the PROXY whenever one exists: it lands in a fraction of
    // the time and scrubs cheaply, which is exactly why it is downloaded first. The
    // video is the RENDER source — exports ask for it explicitly with ?src=full, and
    // the download view reports it separately as `renderPath`.
    //
    // This preference was briefly inverted (video first). That made the proxy
    // unreachable — the purpose it is downloaded for — and made deleting the video look
    // like a no-op, because the route kept serving the proxy's bytes at the same
    // duration. Both symptoms belonged to the preference, not to the proxy.
    const wantFull = c.req.query("src") === "full";
    // Download state is the primary source of truth for playable media —
    // a mid-download stream has no vodPath yet but its proxy twin exists.
    let mediaPath = stream.vodPath ?? "";
    if (!wantFull) {
      // mp4 twins only — Chromium can't demux raw MPEG-TS, so a .ts path is
      // unplayable; its .mp4 twin (kept in the download state) is the playable form of
      // the same bytes.
      const dl = await deps.downloadState(c.req.param("streamId"));
      const present = (p: string) => Deno.stat(p).then(() => true).catch(() => false);
      // The SAME rule the clip-thumbnail route uses (resolveMediaSource). It lives in one place
      // because two consumers now exist, and because it is the only ordering that also covers a
      // folder-imported project: media on disk with no download state at all.
      const playableTwin = await resolveMediaSource({
        proxyMp4: dl.proxyMp4,
        proxyPath: dl.proxyPath,
        hqMp4: dl.hqMp4,
        hqPath: dl.hqPath,
        vodPath: stream.vodPath ?? null,
        present,
      });
      if (playableTwin) {
        mediaPath = playableTwin;
      }
    }

    // MIME by extension — browsers refuse extensionless/unknown responses
    // for <video> (the progressive .ts proxy files played as nothing without
    // this; raw MPEG-TS is video/mp2t in Chromium).
    const mime = mediaPath.endsWith(".mp4") ? "video/mp4"
      : mediaPath.endsWith(".ts") ? "video/mp2t"
      : mediaPath.endsWith(".webm") ? "video/webm"
      : "application/octet-stream";
    c.header("Content-Type", mime);
    c.header("Cache-Control", "no-store");
    if (!mediaPath) {
      return c.json({ error: "Video not available yet" }, 404);
    }
    // Every candidate must be stat-checked before serving: a path recorded in
    // the stream row or the download state can point at a file that no longer
    // exists, and serving a stale path is how "deleted" media kept playing.
    if (!mediaPath || !(await Deno.stat(mediaPath).then(() => true).catch(() => false))) {
      return c.json({ error: "Video not available" }, 404);
    }
    try {
      const stat = await Deno.stat(mediaPath);
      // A file still being written must never be served past its safe
      // frontier. For a growing fragmented MP4 that frontier is the end of
      // the last COMPLETE fragment — a response ending mid-fragment hands
      // Chromium a partial mdat and it dies with PIPELINE_ERROR_DECODE.
      const servable = await servableSizeFor(deps, c.req.param("streamId"), mediaPath, stat.size);
      const range = parseRangeHeader(c.req.header("range") ?? null, servable);
      if (range === "unsatisfiable") {
        c.header("Content-Range", `bytes */${servable}`);
        c.header("Accept-Ranges", "bytes");
        return c.body(null, 416);
      }
      if (range) {
        const end = clampToServable(range.end, servable, stat.size);
        const start = Math.min(range.start, Math.max(0, end));
        const len = end - start + 1;
        const file = await Deno.open(mediaPath, { read: true });
        try {
          await file.seek(start, Deno.SeekMode.Start);
          // STREAM THE RANGE — do NOT buffer it.
          //
          // This used to allocate `new Uint8Array(len)` and read it all before responding, so the
          // first byte arrived only after the ENTIRE range was in memory. Measured against a real
          // 1.32GB file: `Range: bytes=0-` took 1806ms to send any header at all, then transferred
          // 1.32GB; the same read streamed takes ~3ms to the first byte. A browser's seek (and its
          // opening request) is often `bytes=0-`, so the stall scaled with file size — larger
          // resolutions appearing to load slower, with scrubbing instant once loaded, because by
          // then the ranges are small.
          //
          // `file.readable` cannot be sliced directly, so the window is served through a
          // TransformStream that forwards at most `len` bytes and then closes the file. Peak
          // memory is one chunk rather than the whole range.
          c.header("Content-Range", `bytes ${start}-${end}/${servable}`);
          c.header("Accept-Ranges", "bytes");
          c.header("Content-Length", String(len));
          // Stream the window; see limitBytes for why buffering was wrong.
          return c.body(
            limitBytes(file.readable, len, () => {
              try {
                file.close();
              } catch {
                // Already closed.
              }
            }),
            206,
          );
        } catch (err) {
          try {
            file.close();
          } catch {
            // Already closed.
          }
          throw err;
        }
      }
      const file = await Deno.open(mediaPath, { read: true });
      c.header("Content-Length", String(servable));
      c.header("Accept-Ranges", "bytes");
      return c.body(file.readable);
    } catch {
      return c.json({ error: "Cannot read video file" }, 500);
    }
  });

  // ── HLS player proxy: serves the media playlist with chunk URLs rewritten
  // to this server, so the frontend player (hls.js) streams the SAME bytes
  // the orchestrator downloads — already-downloaded chunks come from disk,
  // not-yet-downloaded chunks proxy from Twitch. One fetch, growing playback.
  app.get("/api/streams/:id/hls.m3u8", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream?.sourceUrl) return c.json({ error: "No source URL" }, 404);
    const vodId = extractVodId(stream.sourceUrl);
    if (!vodId) return c.json({ error: "Not a Twitch VOD URL" }, 400);

    const track = c.req.query("track") === "hq" ? "hq" : "proxy";
    const qualities = await resolveQualities(vodId);
    const q = track === "hq"
      ? pickBestQuality(qualities, null)
      : (pickProxyQuality(qualities, 540) ?? pickBestQuality(qualities, null));
    if (!q) return c.json({ error: "No qualities available" }, 404);

    const playlistText = await (await fetchWithTimeout(q.playlistUrl)).text();
    // RELATIVE chunk URLs — hls.js resolves them against the manifest URL,
    // so they ride the same origin as the page (vite dev proxy on 5173,
    // same-origin static serving in production). Absolute origins broke the
    // dev setup with CORS errors (user-reported: requests from 5173 to the
    // absolute 5174 chunk URLs were blocked).
    let index = 0;
    const out = playlistText.split("\n").map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) return line;
      return `/api/streams/${stream.id}/hls-chunk/${track}/${index++}`;
    });
    return c.body(out.join("\n"), 200, { "Content-Type": "application/vnd.apple.mpegurl" });
  });

  // Chunk proxy: index → local byte range (from the chunk map) when the
  // chunk is already on disk, else a remote proxy fetch of that chunk URL.
  app.get("/api/streams/:id/hls-chunk/:track/:index", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream?.sourceUrl) return c.json({ error: "No source URL" }, 404);
    const vodId = extractVodId(stream.sourceUrl);
    if (!vodId) return c.json({ error: "Not a Twitch VOD URL" }, 400);
    const track = c.req.param("track") === "hq" ? "hq" : "proxy";
    const index = parseInt(c.req.param("index"), 10);
    if (!Number.isFinite(index) || index < 0) return c.json({ error: "Bad index" }, 400);

    // Chunk map: "index offset len" lines, derived from the download
    // state's .ts path ({dir}/proxy.chunks next to proxy.ts).
    const dl = await deps.downloadState(stream.id);
    const tsPath = track === "hq" ? dl.hqPath : dl.proxyPath;
    const mapPath = tsPath ? `${tsPath.replace(/\.ts$/, "")}.chunks` : null;

    if (tsPath && mapPath) {
      const mapText = await Deno.readTextFile(mapPath).catch(() => "");
      for (const line of mapText.split("\n")) {
        const m = /^(\d+) (\d+) (\d+)$/.exec(line.trim());
        if (m && parseInt(m[1]!, 10) === index) {
          const offset = parseInt(m[2]!, 10);
          const len = parseInt(m[3]!, 10);
          const file = await Deno.open(tsPath, { read: true });
          try {
            await file.seek(offset, Deno.SeekMode.Start);
            const buf = new Uint8Array(len);
            await file.read(buf);
            c.header("Content-Type", "video/mp2t");
            return c.body(buf);
          } finally {
            file.close();
          }
        }
      }
    }

    // Not on disk yet — proxy the remote chunk (index-based resolution of
    // the media playlist).
    const qualities = await resolveQualities(vodId);
    const q = track === "hq"
      ? pickBestQuality(qualities, null)
      : (pickProxyQuality(qualities, 540) ?? pickBestQuality(qualities, null));
    if (!q) return c.json({ error: "No qualities available" }, 404);
    const playlistText = await (await fetchWithTimeout(q.playlistUrl)).text();
    const chunks = playlistText.split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const chunkUrl = chunks[index];
    if (!chunkUrl) return c.json({ error: "Chunk out of range" }, 404);
    const resolved = chunkUrl.startsWith("http") ? chunkUrl : new URL(chunkUrl, q.playlistUrl).href;
    const upstream = await fetchWithTimeout(resolved, {}, MEDIA_TIMEOUT_MS);
    if (!upstream.ok || !upstream.body) {
      return c.json({ error: `Chunk upstream ${upstream.status}` }, 502);
    }
    c.header("Content-Type", "video/mp2t");
    return c.body(upstream.body);
  });

  // ── WebSocket ──
  app.get("/ws", wsHandler(bus));

  return app;
}
