/**
 * Media management actions (user-directed, download-pipeline scope).
 *
 * Thin delegation layer: the DownloadOrchestrator owns ALL download state
 * (phases, parts, presence, reconcile, piece execution). This use-case only
 * resolves stream-specific context (source URL, artifact dir, quality
 * picks) and delegates artifact deletion/open actions. One owner, one
 * truth — no parallel state machines.
 */

import type { StreamRepository, StreamMetadataRepository, FileSystemPort } from "@/application/ports/outbound.ts";
import { DownloadOrchestrator, type DownloadState } from "@/adapters/outbound/vod/download-orchestrator.ts";
import { resolveQualities, pickProxyQuality, pickBestQuality, extractVodId, type HlsQuality } from "@/adapters/outbound/vod/hls.ts";

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
   * highest ≤ maxHeight (null = source). Delegates execution to the
   * orchestrator's startPiece — the manager owns state and plumbing.
   */
  async downloadPiece(opts: {
    streamId: string;
    kind: "proxy" | "hq" | "chat";
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

    let dir = await this.artifactDir(opts.streamId);
    if (!dir) {
      // Fresh progressive import with no downloaded media yet — create the
      // canonical cache dir so the piece lands where imports expect it.
      const fresh = `${this.cacheDir}/vods/${opts.streamId}`;
      await this.fs.ensureDir(fresh);
      dir = fresh;
    }
    await this.fs.ensureDir(dir);

    let quality: HlsQuality | null = null;
    if (opts.kind !== "chat") {
      const qualities = await resolveQualities(vodId);
      quality = opts.kind === "proxy"
        ? pickProxyQuality(qualities, opts.proxyHeightCap ?? 540)
        : pickBestQuality(qualities, opts.maxHeight ?? null);
      if (!quality) throw new Error("No qualities available for this VOD");
    }

    const controller = new AbortController();
    this.pieceAborts.set(opts.streamId, controller);
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      await this.orchestrator.startPiece({
        streamId: opts.streamId,
        destDir: dir,
        kind: opts.kind,
        vodId,
        quality: quality ?? undefined,
        signal: controller.signal,
      });
      return { started: true, quality: quality?.name ?? null };
    } finally {
      this.pieceAborts.delete(opts.streamId);
    }
  }
}