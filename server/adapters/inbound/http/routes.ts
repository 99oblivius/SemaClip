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
  UpdateClipUseCase,
  ExportClipUseCase,
  ManageQueueUseCase,
  SettingsUseCase,
} from "@/application/use-cases/mod.ts";
import type { Axis, StreamStatus } from "shared/types";
import type { DownloadState as DownloadStateType } from "@/adapters/outbound/vod/download-orchestrator.ts";
import type { EventBus, StreamMetadataRepository, StreamStorage, VodDownloadPort } from "@/application/ports/outbound.ts";
import type { SqliteExportPresetRepository } from "@/adapters/outbound/persistence/repositories.ts";
import { parseSrt } from "@/adapters/outbound/transcribe/srt-parse.ts";
import { cuesToSrt } from "@/adapters/outbound/transcribe/srt-write.ts";
import { probeGpuEncoder } from "@/adapters/outbound/ffmpeg/gpu-probe.ts";
import {
  extractVodId,
  resolveQualities,
  pickProxyQuality,
  pickBestQuality,
} from "@/adapters/outbound/vod/hls.ts";
import { clampToServable, parseRangeHeader } from "@/adapters/inbound/http/range.ts";
import { projectDownloadView } from "@/application/view/project-download-view.ts";
import { fragmentBoundaryAt, parseIndex } from "@/adapters/outbound/vod/fmp4.ts";
import { run, spawnChild } from "@/adapters/outbound/process/spawn.ts";
import {
  chromeState,
  closeWindow,
} from "@/adapters/outbound/platform/window-lifecycle.ts";

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
  startJob: StartJobUseCase;
  cancelJob: CancelJobUseCase;
  listJobs: ListJobsUseCase;
  listClips: ListClipsUseCase;
  getClip: GetClipUseCase;
  rejectClip: RejectClipUseCase;
  updateClip: UpdateClipUseCase;
  exportClip: ExportClipUseCase;
  manageQueue: ManageQueueUseCase;
  settings: SettingsUseCase;
  presets: SqliteExportPresetRepository;
  vod: VodDownloadPort;
  /** Resolved ffmpeg/ffprobe plus the ability to provision them on request. */
  tools: ToolRegistry;
  downloadState: (streamId: string) => Promise<DownloadStateType>;
  downloadRevision: (streamId: string) => number;
  /** Record a view change that has no state write (artifact deletion). */
  touchDownload: (streamId: string) => void;
  /** Remove a project's downloaded media directory. */
  purgeArtifacts: (streamId: string) => Promise<{ bytes: number }>;
  cancelDownload: (streamId: string) => boolean;
  cancelPiece: (streamId: string) => boolean;
  deleteVideo: (streamId: string) => Promise<{ deleted: boolean }>;
  deleteProxy: (streamId: string) => Promise<{ deleted: boolean }>;
  deleteChat: (streamId: string) => Promise<{ deleted: boolean }>;
  downloadChatPiece: (opts: { streamId: string }) => Promise<{ started: boolean; quality: string | null }>;
  openFolder: (streamId: string) => Promise<{ opened: boolean; dir: string | null }>;
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

/** Domain errors → HTTP status codes. */
function errorStatus(msg: string): 400 | 404 | 500 {
  if (/not found|not available/i.test(msg)) return 404;
  if (/already terminal|can only reorder|invalid|unsupported|not yet downloaded/i.test(msg)) return 400;
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

  // ── Progressive download state (docs/DOWNLOAD-PIPELINE.md) ──
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
      return projectDownloadView({
        streamId: stream.id,
        state,
        markers,
        hasSource: Boolean(stream.sourceUrl),
        revision: deps.downloadRevision(stream.id),
      });
    }));
    return c.json({ views, revision: deps.downloadRevision("__global__") });
  });

  // Delete a download: abort any in-flight run, remove its artifacts, reset
  // the state to idle (also clears stuck/orphaned states — the old "cancel"
  // was a no-op for those).
  app.delete("/api/streams/:id/download", async (c) => {
    const streamId = c.req.param("id");
    // ?piece=<kind> cancels just that piece (files + state kept, phase
    // honestly restored); without it the whole download + artifacts go.
    const piece = c.req.query("piece");
    if (piece === "proxy" || piece === "hq" || piece === "chat") {
      const cancelled = deps.cancelPiece(streamId);
      return c.json({ ok: cancelled });
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

  app.get("/api/clips/:id", async (c) => {
    const clip = await deps.getClip.execute(c.req.param("id"));
    if (!clip) return c.json({ error: "Clip not found" }, 404);
    return c.json(clip);
  });

  app.post("/api/clips/:id/reject", async (c) => {
    const clip = await deps.rejectClip.execute(c.req.param("id"));
    return c.json(clip);
  });

  // Persist review edits (trim endpoints).
  app.patch("/api/clips/:id", async (c) => {
    const body = await c.req.json();
    const patch: { startTime?: number; endTime?: number } = {};
    if (body.startTime !== undefined) patch.startTime = Number(body.startTime);
    if (body.endTime !== undefined) patch.endTime = Number(body.endTime);
    const clip = await deps.updateClip.execute(c.req.param("id"), patch);
    return c.json(clip);
  });

  app.post("/api/clips/:id/export", async (c) => {
    const body = await c.req.json();
    const result = await deps.exportClip.execute({ clipId: c.req.param("id"), ...body });
    return c.json(result, 201);
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
  const SAMPLE_RATE = 8000;
  const BATCH_SIZE = 50; // ~50s per batch, fewer SSE events

  /** Run ffmpeg for a time range, compute peaks, yield batches. */
  async function* streamPeaks(
    vodPath: string,
    startSec: number,
    durationSec: number | null, // null = to end of file
    firstIndex: number,
    totalSamples: number,
  ): AsyncGenerator<{ firstIndex: number; startTime: number; peaks: number[] }> {
    const args = [
      "-threads", "0",        // auto-detect CPU cores
      "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-",
    ];
    if (startSec > 0) args.unshift("-ss", String(startSec));
    if (durationSec !== null) args.unshift("-t", String(durationSec));
    args.unshift("-i", vodPath);

    const proc = spawnChild(deps.tools.ffmpeg, { args, stdout: "piped" });
    const reader = proc.stdout?.getReader();
    if (!reader) throw new Error("ffmpeg waveform output was not captured");

    let peakBuf: number[] = [];
    let acc = new Float32Array(0);
    let peakIdx = firstIndex;
    const peakTime = totalSamples / SAMPLE_RATE; // seconds per peak = samples ÷ samples/sec

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          const incoming = new Float32Array(value.buffer, value.byteOffset, Math.floor(value.length / 4));
          const merged = new Float32Array(acc.length + incoming.length);
          merged.set(acc);
          merged.set(incoming, acc.length);
          acc = merged;

          while (acc.length >= totalSamples) {
            let max = 0;
            for (let i = 0; i < totalSamples; i++) max = Math.max(max, Math.abs(acc[i] ?? 0));
            peakBuf.push(max);
            acc = acc.slice(totalSamples);
          }
        }

        while (peakBuf.length >= BATCH_SIZE) {
          const batch = peakBuf.splice(0, BATCH_SIZE);
          const startTime = peakIdx * peakTime;
          peakIdx += BATCH_SIZE;
          yield { firstIndex: peakIdx - BATCH_SIZE, startTime, peaks: batch };
        }

        if (done) break;
      }

      // Flush remainder.
      if (acc.length > 0) {
        let max = 0;
        for (let i = 0; i < acc.length; i++) max = Math.max(max, Math.abs(acc[i] ?? 0));
        peakBuf.push(max);
      }
      if (peakBuf.length > 0) {
        const startTime = peakIdx * peakTime;
        peakIdx += peakBuf.length;
        yield { firstIndex: peakIdx - peakBuf.length, startTime, peaks: [...peakBuf] };
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* ok */ }
      // Client disconnect must not leave a full-speed audio decode running to
      // EOF — kill the process, then reap it.
      try { proc.kill(); } catch { /* already exited */ }
      try { await proc.status; } catch { /* ok */ }
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
          // While a download is running, the file is still growing: only the
          // bytes already written can be decoded. Report the media extent as
          // the downloaded frontier so the waveform covers exactly what
          // exists instead of stretching across the whole timeline (the
          // reported "displays itself across the entire timeline").
          const dlState = await deps.downloadState(streamId);
          const downloading = dlState.phase === "running";
          const frontierSec = downloading
            ? Math.max(0, dlState.proxyFrontierSec || 0)
            : duration;
          const extent = downloading && frontierSec > 0
            ? Math.min(duration, frontierSec)
            : duration;
          const totalPeaks = Math.max(1, Math.ceil(extent * TARGET_PEAKS_PER_SEC));
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
            )) {
              if (closed) break;
              for (let i = 0; i < batch.peaks.length; i++) {
                allPeaks[batch.firstIndex + i] = batch.peaks[i]!;
              }
              send(batch);
            }
          }

          if (!closed) send({ done: true });

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

  app.post("/api/window/close", (c) => {
    // Fire the close and report whether it was accepted; the process exits from the
    // window's own close handler, which is also what the OS button triggers.
    return c.json({ closing: closeWindow() });
  });

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
    const body = await c.req.json();
    // Upsert with the URL id — the body cannot mint arbitrary ids.
    await deps.presets.save({ ...body, id: c.req.param("id") });
    return c.json({ ok: true }, 201);
  });
  app.delete("/api/presets/:id", async (c) => {
    await deps.presets.delete(c.req.param("id"));
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
    const cap = await probeGpuEncoder();
    return c.json({ backend: cap.backend, detail: cap.reason ?? "" });
  });

  // ── Video file serving (range requests for <video>) ──
  // Video streaming — prefers the proxy proxy (P0-10) when one was generated
  // during processing; falls back to the source VOD.
  app.get("/api/video/:streamId", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("streamId"));
    if (!stream) return c.json({ error: "Video not available" }, 404);

    // Proxy preference: explicit ?src=full override, else proxy if it exists.
    const wantFull = c.req.query("src") === "full";
    // Download state is the primary source of truth for playable media —
    // a mid-download stream has no vodPath yet but its proxy twin exists.
    let mediaPath = stream.vodPath ?? "";
    if (!wantFull) {
      // mp4 twins first — Chromium can't demux raw MPEG-TS, so a .ts vodPath
      // is unplayable; its .mp4 twin (kept in the download state) is the
      // playable form of the same bytes.
      const dl = await deps.downloadState(c.req.param("streamId"));
      // Prefer the MAIN video over the proxy: the proxy is a preview copy, so
      // playing it while a full-quality file exists wastes the download — and
      // it made deleting the video look like it changed nothing, because the
      // route kept serving the proxy's bytes at the same duration.
      // Mid-download only the proxy exists, so this falls through naturally.
      const pickPlayable = async (p: string | null | undefined) =>
        p && await Deno.stat(p).then(() => true).catch(() => false) ? p : null;
      const playableTwin = (await pickPlayable(dl.hqMp4))
        ?? (await pickPlayable(dl.hqPath))
        ?? (await pickPlayable(dl.proxyMp4))
        ?? (await pickPlayable(dl.proxyPath));
      if (playableTwin && await Deno.stat(playableTwin).then(() => true).catch(() => false)) {
        mediaPath = playableTwin;
      } else {
        try {
          const meta = await deps.metadata.get(stream.id, "transcript_srt");
          if (meta) {
            const artifactDir = (JSON.parse(meta) as { path: string }).path.replace(/\/[^/]+$/, "");
            const proxyPath = `${artifactDir}/proxy.mp4`;
            if (await Deno.stat(proxyPath).then(() => true).catch(() => false)) {
              mediaPath = proxyPath;
            }
          }
        } catch {
          // fall back to source
        }
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
        const file = await Deno.open(mediaPath, { read: true });
        try {
          await file.seek(start, Deno.SeekMode.Start);
          const buf = new Uint8Array(end - start + 1);
          await file.read(buf);
          c.header("Content-Range", `bytes ${start}-${end}/${servable}`);
          c.header("Accept-Ranges", "bytes");
          c.header("Content-Length", String(end - start + 1));
          return c.body(buf, 206);
        } finally {
          file.close();
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

    const playlistText = await (await fetch(q.playlistUrl)).text();
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
    const playlistText = await (await fetch(q.playlistUrl)).text();
    const chunks = playlistText.split("\n").map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    const chunkUrl = chunks[index];
    if (!chunkUrl) return c.json({ error: "Chunk out of range" }, 404);
    const resolved = chunkUrl.startsWith("http") ? chunkUrl : new URL(chunkUrl, q.playlistUrl).href;
    const upstream = await fetch(resolved);
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
