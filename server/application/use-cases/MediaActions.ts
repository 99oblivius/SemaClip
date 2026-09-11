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
    // Every candidate is stat-checked: a path recorded in state can be stale
    // (the file was deleted), and deriving a directory from a dead path makes
    // every later delete a silent no-op.
    for (const candidate of [dl.proxyPath, dl.proxyMp4, dl.hqPath, dl.hqMp4, dl.chatPath]) {
      if (!candidate) continue;
      const dir = candidate.replace(/\/[^/]+$/, "");
      if (await this.fs.exists(dir)) return dir;
    }
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

  /**
   * Delete the MAIN video artifact only. The proxy, chat and the stream
   * record's chat path are untouched.
   *
   * The video is the file the download state records for the `video`
   * artifact. It is NEVER identified by scanning for legacy filenames: in
   * two-file mode `stream.vodPath` points at whichever artifact completed
   * first (the proxy, while HQ is still running), so deleting "the video"
   * by path scan destroyed the proxy instead — the ripple the owner saw.
   */
  async deleteVideo(streamId: string): Promise<{ deleted: boolean }> {
    const state = await this.orchestrator.getState(streamId);
    const videoPaths = new Set<string>();
    // The state's own record of the video artifact (both fields can point at
    // the same file in single-download mode — that is fine, it is one file).
    if (state.hqPath) videoPaths.add(state.hqPath);
    if (state.hqMp4) videoPaths.add(state.hqMp4);
    // In two-file mode the video is `hq.*`; the proxy is never touched.
    const dir = await this.artifactDir(streamId);
    if (dir && state.includeProxy) {
      for (const name of ["hq.mp4", "hq.fragments", "hq.ts", "hq.chunks"]) {
        const p = `${dir}/${name}`;
        if (await this.fs.exists(p)) videoPaths.add(p);
      }
    }
    // Legacy single-file projects recorded the video as vodPath, but ONLY
    // when no separate proxy file exists.
    const stream = await this.streams.findById(streamId);
    if (stream && !state.includeProxy && stream.vodPath) {
      videoPaths.add(stream.vodPath);
    }

    let removed = false;
    for (const path of videoPaths) {
      if (await this.fs.exists(path)) {
        await this.fs.remove(path);
        removed = true;
      }
    }
    if (!removed) return { deleted: false };

    // Point the stream record at whatever video still exists (the proxy may
    // be the only playable file now) — or clear it so the UI stops claiming
    // a video that is gone.
    if (stream && stream.vodPath && videoPaths.has(stream.vodPath)) {
      const fallback = state.proxyMp4 ?? state.proxyPath ?? "";
      await this.streams.update({ ...stream, vodPath: fallback });
    }
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
    // The proxy is one fragmented MP4 plus its fragment index; legacy
    // runs may have left a .ts/.chunks pair or scrub.* names.
    const candidates = ["proxy.mp4", "proxy.fragments", "proxy.ts", "proxy.chunks",
                        "scrub.mp4", "scrub.ts", "scrub.chunks"];
    let removed = false;
    for (const name of candidates) {
      const path = `${dir}/${name}`;
      if (await this.fs.exists(path)) {
        await this.fs.remove(path);
        removed = true;
      }
    }
    if (!removed) return { deleted: false };
    const state = await this.orchestrator.getState(streamId);
    if (state.proxyPath?.startsWith(`${dir}/`) || state.proxyMp4?.startsWith(`${dir}/`)) {
      state.proxyPath = null;
      state.proxyMp4 = null;
      state.proxyFrontierSec = 0;
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

  /**
   * Remove a project's MEDIA directory.
   *
   * Download artifacts live in `{cacheDir}/vods/{streamId}`, which is NOT the
   * directory `StreamStorage.deleteStream` removes (`{dataDir}/streams/{id}`).
   * Deleting a project therefore left every downloaded gigabyte on disk — and
   * an orphaned file can still be reached by the media route's fallbacks,
   * which is how "deleted" video kept playing. Removing the whole artifact
   * directory is the only honest delete.
   */
  async purgeArtifacts(streamId: string): Promise<{ bytes: number }> {
    const dir = `${this.cacheDir}/vods/${streamId}`;
    let bytes = 0;
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile) continue;
        const st = await Deno.stat(`${dir}/${entry.name}`).catch(() => null);
        bytes += st?.size ?? 0;
      }
      await Deno.remove(dir, { recursive: true });
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    return { bytes };
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