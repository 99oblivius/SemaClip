/**
 * Media management actions (user-directed, download-pipeline scope):
 * - Delete the LQ proxy file (review falls back to full-res proxybing).
 * - Re-download a missing proxy or an HQ file at a different resolution
 *   (progressive orchestrator re-run, scoped to the missing part).
 *
 * The download state lives in stream metadata; the artifact dir is derived
 * from the transcript_srt path (same convention the engine and video route
 * use). Streams without an artifact dir can't have these actions applied.
 */

import type { StreamRepository, StreamMetadataRepository, FileSystemPort } from "@/application/ports/outbound.ts";
import { DownloadOrchestrator, type DownloadState } from "@/adapters/outbound/vod/download-orchestrator.ts";
import { resolveQualities, pickProxyQuality, pickBestQuality, downloadProgressive, extractVodId } from "@/adapters/outbound/vod/hls.ts";
import { remuxToMp4, mp4Twin } from "@/adapters/outbound/vod/remux.ts";
import { downloadChat } from "@/adapters/outbound/vod/chat-fetch.ts";

export class MediaActionsUseCase {
  /** Live piece downloads by stream — DELETE /download aborts these too. */
  private readonly pieceAborts = new Map<string, AbortController>();

  constructor(
    private readonly streams: StreamRepository,
    private readonly metadata: StreamMetadataRepository,
    private readonly fs: FileSystemPort,
    private readonly orchestrator: DownloadOrchestrator,
    /** Server cache root — the import flow writes VODs to {cacheDir}/vods/{streamId}. */
    private readonly cacheDir: string,
  ) {}

  /** Abort a live piece download, if any. */
  cancelPiece(streamId: string): boolean {
    const controller = this.pieceAborts.get(streamId);
    if (!controller) return false;
    controller.abort();
    this.pieceAborts.delete(streamId);
    return true;
  }

  /**
   * The artifact dir — derived from the proxyPath recorded by the download
   * state (present from the moment the proxy download starts), falling back
   * to the transcript_srt metadata path (post-processing streams).
   */
  private async artifactDir(streamId: string): Promise<string | null> {
    const dl = await this.orchestrator.getState(streamId);
    if (dl.proxyPath) return dl.proxyPath.replace(/\/[^/]+$/, "");
    if (dl.hqPath) return dl.hqPath.replace(/\/[^/]+$/, "");
    const raw = await this.metadata.get(streamId, "transcript_srt");
    if (raw) {
      try {
        const path = (JSON.parse(raw) as { path: string }).path;
        return path.replace(/\/[^/]+$/, "");
      } catch {
        // fall through to the cache-dir default
      }
    }
    // Default import layout (ImportStreamByUrlUseCase): {cacheDir}/vods/{id}.
    if (await this.fs.exists(`${this.cacheDir}/vods/${streamId}`)) {
      return `${this.cacheDir}/vods/${streamId}`;
    }
    return null;
  }

  async getState(streamId: string): Promise<DownloadState> {
    return this.orchestrator.getState(streamId);
  }

  /** Deletes the LQ proxy file if it exists; idempotent. */
  /** Delete the HQ video only (hq.ts/.mp4 + chunk map). Proxy, chat and
   *  the stream record's chat path are untouched. */
  async deleteVideo(streamId: string): Promise<{ deleted: boolean }> {
    const dir = await this.artifactDir(streamId);
    if (!dir) return { deleted: false };
    const targets = ["hq.ts", "hq.mp4", "hq.chunks", "video.mp4"];
    let removed = false;
    for (const name of targets) {
      const path = `${dir}/${name}`;
      if (await this.fs.exists(path)) {
        await this.fs.remove(path);
        removed = true;
      }
    }
    // Legacy single-file imports: vodPath may point at a video in this dir.
    const stream = await this.streams.findById(streamId);
    if (stream && stream.vodPath && stream.vodPath.startsWith(`${dir}/`)) {
      await this.fs.remove(stream.vodPath).catch(() => {});
      removed = true;
      await this.streams.update({ ...stream, vodPath: "" });
    }
    const state = await this.orchestrator.getState(streamId);
    if (state.hqPath || state.hqMp4) {
      state.hqPath = null;
      state.hqMp4 = null;
      const part = state.parts.find((x) => x.kind === "hq");
      if (part && part.status === "done") part.status = "pending";
      await this.orchestrator.setState(streamId, state);
    }
    return { deleted: removed };
  }

  async deleteProxy(streamId: string): Promise<{ deleted: boolean }> {
    const dir = await this.artifactDir(streamId);
    if (!dir) return { deleted: false };
    // New runs write proxy.ts; pre-rename runs left scrub.ts — accept both.
    const proxyPath = `${dir}/proxy.ts`;
    const legacyPath = `${dir}/scrub.ts`;
    const target = (await this.fs.exists(proxyPath)) ? proxyPath : legacyPath;
    if (!(await this.fs.exists(target))) return { deleted: false };
    const tsPath = target;
    await this.fs.remove(tsPath);
    // The mp4 twin is the playable form — leaving it would keep dead video
    // on the video route's twin preference. The chunk map dies with it.
    await this.fs.remove(`${dir}/proxy.mp4`).catch(() => {});
    await this.fs.remove(`${dir}/scrub.mp4`).catch(() => {});
    await this.fs.remove(`${dir}/proxy.chunks`).catch(() => {});
    await this.fs.remove(`${dir}/scrub.chunks`).catch(() => {});
    // State note: proxyPath/proxyFrontierSec in the download state describe
    // what WAS downloaded; clearing them keeps the UI honest (review now
    // proxys the HQ file or falls back to source).
    const state = await this.orchestrator.getState(streamId);
    if (state.proxyPath === tsPath) {
      state.proxyPath = null;
      state.proxyMp4 = null;
      await this.orchestrator.setState(streamId, state);
    }
    return { deleted: true };
  }

  /** Open the artifact folder in the OS file manager (xdg-open / explorer). */
  async openFolder(streamId: string): Promise<{ opened: boolean; dir: string | null }> {
    const dir = await this.artifactDir(streamId);
    if (!dir || !(await this.fs.exists(dir))) return { opened: false, dir: null };
    const cmd = Deno.build.os === "windows" ? "explorer" : "xdg-open";
    try {
      const child = new Deno.Command(cmd, { args: [dir] });
      child.spawn();
      return { opened: true, dir };
    } catch {
      return { opened: false, dir };
    }
  }

  /** Delete the chat JSON (chatPath in the stream record + download state). */
  async deleteChat(streamId: string): Promise<{ deleted: boolean }> {
    const dir = await this.artifactDir(streamId);
    if (!dir) return { deleted: false };
    const chatPath = `${dir}/chat.json`;
    if (!(await this.fs.exists(chatPath))) return { deleted: false };
    await this.fs.remove(chatPath);
    const state = await this.orchestrator.getState(streamId);
    state.chatPath = null;
    state.chatCount = 0;
    const part = state.parts.find((x) => x.kind === "chat");
    if (part && part.status === "done") part.status = "pending";
    await this.orchestrator.setState(streamId, state);
    const stream = await this.streams.findById(streamId);
    if (stream?.chatPath === chatPath) {
      await this.streams.update({ ...stream, chatPath: null });
    }
    return { deleted: true };
  }

  /**
   * Downloads a single missing piece at an explicit quality height:
   * kind="proxy" → the highest ≤ cap (defaults 540), kind="hq" → the
   * highest ≤ maxHeight (null = source). Fails honestly when the stream
   * has no source URL (local files have nothing to re-fetch) or a download
   * is already running.
   */
  async downloadPiece(opts: {
    streamId: string;
    kind: "proxy" | "hq";
    proxyHeightCap?: number;
    maxHeight?: number | null;
    signal?: AbortSignal | undefined;
  }): Promise<{ started: boolean; quality: string | null }> {
    const stream = await this.streams.findById(opts.streamId);
    if (!stream?.sourceUrl) {
      throw new Error("Stream has no source URL — nothing to download from");
    }
    const vodId = extractVodId(stream.sourceUrl);
    if (!vodId) throw new Error(`Unparseable source URL: ${stream.sourceUrl}`);

    const existing = await this.orchestrator.getState(opts.streamId);
    if (existing.phase === "running") {
      throw new Error("A download is already running for this stream");
    }

    let dir = await this.artifactDir(opts.streamId);
    if (!dir) {
      // Fresh progressive import with no downloaded media yet — create the
      // canonical cache dir so the piece lands where imports expect it.
      const fresh = `${this.cacheDir}/vods/${opts.streamId}`;
      await this.fs.ensureDir(fresh);
      dir = fresh;
    }
    await this.fs.ensureDir(dir);

    const qualities = await resolveQualities(vodId);
    const quality = opts.kind === "proxy"
      ? pickProxyQuality(qualities, opts.proxyHeightCap ?? 540)
      : pickBestQuality(qualities, opts.maxHeight ?? null);
    if (!quality) throw new Error("No qualities available for this VOD");

    const destPath = opts.kind === "proxy" ? `${dir}/proxy.ts` : `${dir}/hq.ts`;
    // Single-part run: mark the other video part done/skipped so the state
    // stays coherent (this is a targeted re-download, not a full pipeline).
    await this.orchestrator.setState(opts.streamId, {
      ...existing,
      phase: "running",
      startedAt: new Date().toISOString(),
      parts: existing.parts.map((p) => {
        if (p.kind === opts.kind) {
          const { error: _drop, ...rest } = p;
          return { ...rest, status: "running" as const, percent: 0 };
        }
        if (p.status === "running") {
          return { ...p, status: "skipped" as const };
        }
        return p;
      }),
      overall: { percent: 0, etaSec: null },
    });

    const wasProxy = opts.kind === "proxy";
    // Own the abort: DELETE /download must be able to cancel piece runs.
    const controller = new AbortController();
    this.pieceAborts.set(opts.streamId, controller);
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const pieceSignal = controller.signal;
    // Piece progress: maintained locally then written wholesale — the
    // fire-and-forget get/set chain here raced itself and dropped updates
    // (the user-visible frozen progress bar).
    let lastWrite = 0;
    const liveState = await this.orchestrator.getState(opts.streamId);
    try {
      await downloadProgressive(quality.playlistUrl, destPath, {
        signal: pieceSignal,
        lookahead: wasProxy ? 3 : 4,
        onChunk: (index, offset, len) => {
          void Deno.writeTextFile(
            `${dir}/${opts.kind}.chunks`,
            `${index} ${offset} ${len}\n`,
            { append: true },
          ).catch(() => {});
        },
        onProgress: (p) => {
          if (wasProxy) liveState.proxyFrontierSec = p.downloadedSec;
          const part = liveState.parts.find((x) => x.kind === opts.kind);
          if (part) {
            part.percent = p.percent;
            part.downloadedSec = p.downloadedSec;
            part.totalSec = p.totalSec;
          }
          liveState.overall.percent = p.percent;
          // Throttle writes to ~2 Hz — every chunk would thrash SQLite.
          const now = performance.now();
          if (now - lastWrite > 1000) {
            lastWrite = now;
            void this.orchestrator.setState(opts.streamId, liveState);
          }
        },
      });
      // Final write + playable mp4 twin (raw TS is unplayable in Chromium).
      if (wasProxy) liveState.proxyFrontierSec = Number.MAX_SAFE_INTEGER;
      const twin = await remuxToMp4(destPath, mp4Twin(destPath));
      if (wasProxy) {
        liveState.proxyMp4 = twin ? mp4Twin(destPath) : null;
      } else {
        liveState.hqMp4 = twin ? mp4Twin(destPath) : null;
      }
      await this.orchestrator.setState(opts.streamId, liveState);
    } catch (err) {
      this.pieceAborts.delete(opts.streamId);
      const state = await this.orchestrator.getState(opts.streamId);
      const part = state.parts.find((x) => x.kind === opts.kind);
      if (part) {
        part.status = controller.signal.aborted ? "skipped" : "failed";
        part.error = err instanceof Error ? err.message : String(err);
      }
      state.phase = "failed";
      state.overall.etaSec = null;
      await this.orchestrator.setState(opts.streamId, state);
      throw err;
    }

    const part = liveState.parts.find((x) => x.kind === opts.kind);
    if (part) {
      part.status = "done";
      part.percent = 1;
    }
    if (wasProxy) {
      liveState.proxyPath = destPath;
    } else {
      liveState.hqPath = destPath;
    }
    this.pieceAborts.delete(opts.streamId);
    // Done only when BOTH video parts have playable files (a piece run can
    // complete while the other piece never landed).
    const bothPlayable = liveState.proxyPath !== null && liveState.hqPath !== null
      && (liveState.proxyMp4 !== null || liveState.hqMp4 !== null);
    liveState.phase = bothPlayable ? "done" : "idle";
    await this.orchestrator.setState(opts.streamId, liveState);
    return { started: true, quality: quality.name };
  }

  /** Chat-only piece: GQL page-by-page fetch into the artifact dir. */
  async downloadChatPiece(opts: {
    streamId: string;
    signal?: AbortSignal | undefined;
  }): Promise<{ started: boolean; count: number }> {
    const stream = await this.streams.findById(opts.streamId);
    if (!stream?.sourceUrl) {
      throw new Error("Stream has no source URL — nothing to download from");
    }
    const vodId = extractVodId(stream.sourceUrl);
    if (!vodId) throw new Error(`Unparseable source URL: ${stream.sourceUrl}`);

    const existing = await this.orchestrator.getState(opts.streamId);
    if (existing.phase === "running") {
      throw new Error("A download is already running for this stream");
    }
    let dir = await this.artifactDir(opts.streamId);
    if (!dir) {
      const fresh = `${this.cacheDir}/vods/${opts.streamId}`;
      await this.fs.ensureDir(fresh);
      dir = fresh;
    }

    await this.orchestrator.setState(opts.streamId, {
      ...existing,
      phase: "running",
      startedAt: existing.startedAt ?? new Date().toISOString(),
      parts: existing.parts.map((p) =>
        p.kind === "chat" ? { ...p, status: "running" as const, percent: 0 } : p,
      ),
    });

    const controller = new AbortController();
    this.pieceAborts.set(opts.streamId, controller);
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    const liveState = await this.orchestrator.getState(opts.streamId);
    try {
      let lastWrite = 0;
      const count = await downloadChat(vodId, `${dir}/chat.json`, {
        signal: controller.signal,
        onProgress: (p) => {
          const part = liveState.parts.find((x) => x.kind === "chat");
          if (part) {
            // GQL chat gives no total page count — track pages fetched.
            part.percent = part.percent === 0 ? 0.01 : Math.min(0.99, part.percent + 0.01);
            part.downloadedSec = p.comments;
            part.totalSec = p.pages;
            part.downloadedBytes = p.comments * 180; // rough per-comment bytes for the size label
          }
          const now = performance.now();
          if (now - lastWrite > 1000) {
            lastWrite = now;
            void this.orchestrator.setState(opts.streamId, liveState);
          }
        },
      });
      const part = liveState.parts.find((x) => x.kind === "chat");
      if (part) {
        part.status = "done";
        part.percent = 1;
      }
      liveState.chatPath = `${dir}/chat.json`;
      liveState.chatCount = count;
      await this.orchestrator.setState(opts.streamId, liveState);
      const fresh = await this.streams.findById(opts.streamId);
      if (fresh) await this.streams.update({ ...fresh, chatPath: `${dir}/chat.json` });
      return { started: true, count };
    } catch (err) {
      const state = await this.orchestrator.getState(opts.streamId);
      const part = state.parts.find((x) => x.kind === "chat");
      if (part) {
        part.status = controller.signal.aborted ? "skipped" : "failed";
        part.error = err instanceof Error ? err.message : String(err);
      }
      await this.orchestrator.setState(opts.streamId, state);
      throw err;
    } finally {
      this.pieceAborts.delete(opts.streamId);
    }
  }
}