/**
 * Media management actions (user-directed, download-pipeline scope):
 * - Delete the LQ scrub file (review falls back to full-res scrubbing).
 * - Re-download a missing scrub or an HQ file at a different resolution
 *   (progressive orchestrator re-run, scoped to the missing part).
 *
 * The download state lives in stream metadata; the artifact dir is derived
 * from the transcript_srt path (same convention the engine and video route
 * use). Streams without an artifact dir can't have these actions applied.
 */

import type { StreamRepository, StreamMetadataRepository, FileSystemPort } from "@/application/ports/outbound.ts";
import { DownloadOrchestrator, type DownloadState } from "@/adapters/outbound/vod/download-orchestrator.ts";
import { resolveQualities, pickScrubQuality, pickBestQuality, downloadProgressive, extractVodId } from "@/adapters/outbound/vod/hls.ts";
import { remuxToMp4, mp4Twin } from "@/adapters/outbound/vod/remux.ts";

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
   * The artifact dir — derived from the scrubPath recorded by the download
   * state (present from the moment the scrub download starts), falling back
   * to the transcript_srt metadata path (post-processing streams).
   */
  private async artifactDir(streamId: string): Promise<string | null> {
    const dl = await this.orchestrator.getState(streamId);
    if (dl.scrubPath) return dl.scrubPath.replace(/\/[^/]+$/, "");
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

  /** Deletes the LQ scrub file if it exists; idempotent. */
  async deleteScrub(streamId: string): Promise<{ deleted: boolean }> {
    const dir = await this.artifactDir(streamId);
    if (!dir) return { deleted: false };
    const scrubPath = `${dir}/scrub.ts`;
    if (!(await this.fs.exists(scrubPath))) return { deleted: false };
    await this.fs.remove(scrubPath);
    // The mp4 twin is the playable form — leaving it would keep dead video
    // on the video route's twin preference.
    await this.fs.remove(`${dir}/scrub.mp4`).catch(() => {});
    // State note: scrubPath/scrubFrontierSec in the download state describe
    // what WAS downloaded; clearing them keeps the UI honest (review now
    // scrubs the HQ file or falls back to source).
    const state = await this.orchestrator.getState(streamId);
    if (state.scrubPath === scrubPath) {
      state.scrubPath = null;
      state.scrubMp4 = null;
      await this.orchestrator.setState(streamId, state);
    }
    return { deleted: true };
  }

  /**
   * Downloads a single missing piece at an explicit quality height:
   * kind="scrub" → the highest ≤ cap (defaults 540), kind="hq" → the
   * highest ≤ maxHeight (null = source). Fails honestly when the stream
   * has no source URL (local files have nothing to re-fetch) or a download
   * is already running.
   */
  async downloadPiece(opts: {
    streamId: string;
    kind: "scrub" | "hq";
    scrubHeightCap?: number;
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
    const quality = opts.kind === "scrub"
      ? pickScrubQuality(qualities, opts.scrubHeightCap ?? 540)
      : pickBestQuality(qualities, opts.maxHeight ?? null);
    if (!quality) throw new Error("No qualities available for this VOD");

    const destPath = opts.kind === "scrub" ? `${dir}/scrub.ts` : `${dir}/hq.ts`;
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

    const wasScrub = opts.kind === "scrub";
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
        lookahead: wasScrub ? 3 : 4,
        onChunk: (index, offset, len) => {
          void Deno.writeTextFile(
            `${dir}/${opts.kind}.chunks`,
            `${index} ${offset} ${len}\n`,
            { append: true },
          ).catch(() => {});
        },
        onProgress: (p) => {
          if (wasScrub) liveState.scrubFrontierSec = p.downloadedSec;
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
      if (wasScrub) liveState.scrubFrontierSec = Number.MAX_SAFE_INTEGER;
      const twin = await remuxToMp4(destPath, mp4Twin(destPath));
      if (wasScrub) {
        liveState.scrubMp4 = twin ? mp4Twin(destPath) : null;
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
    if (wasScrub) {
      liveState.scrubPath = destPath;
    } else {
      liveState.hqPath = destPath;
    }
    this.pieceAborts.delete(opts.streamId);
    // Done only when BOTH video parts have playable files (a piece run can
    // complete while the other piece never landed).
    const bothPlayable = liveState.scrubPath !== null && liveState.hqPath !== null
      && (liveState.scrubMp4 !== null || liveState.hqMp4 !== null);
    liveState.phase = bothPlayable ? "done" : "idle";
    await this.orchestrator.setState(opts.streamId, liveState);
    return { started: true, quality: quality.name };
  }
}