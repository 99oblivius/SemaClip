import type {
  StreamRepository,
  VodDownloadPort,
  EventBus,
  FileSystemPort,
  MediaProbePort,
} from "@/application/ports/outbound.ts";
import { DOWNLOAD_PROGRESS_TOPIC } from "@/application/ports/outbound.ts";
import type { ImportByFileInput, ImportByUrlInput, ImportResult, Stream } from "shared/types";
import { createStream } from "@/domain/mod.ts";
import type { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";
import { fetchVodMeta, extractVodId } from "@/adapters/outbound/vod/hls.ts";

export class ImportStreamByFileUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly fs: FileSystemPort,
    private readonly probe: MediaProbePort,
  ) {}

  async execute(input: ImportByFileInput): Promise<ImportResult> {
    // Folder import: the first video file is the HQ video; any proxy
    // artifact (proxy.ts/.mp4 or a legacy scrub.ts) and chat.json alongside
    // it are picked up automatically.
    const resolved = input.folderPath
      ? await this.resolveFolder(input.folderPath)
      : { vodPath: input.vodPath, proxyPath: null as string | null, chatPath: null as string | null };
    if (!(await this.fs.exists(resolved.vodPath))) {
      throw new Error(`VOD file not found: ${resolved.vodPath}`);
    }
    const duration = await this.probe.probeDuration(resolved.vodPath);
    const stream = createStream({
      vodPath: resolved.vodPath,
      chatPath: input.chatPath ?? resolved.chatPath,
      sourceUrl: input.sourceUrl ?? null,
      title: input.title,
      streamer: input.streamer,
      duration: duration ?? undefined,
    });
    await this.streams.save(stream);
    return { stream, downloadJobId: null };
  }

  private async resolveFolder(folder: string): Promise<{ vodPath: string; proxyPath: string | null; chatPath: string | null }> {
    if (!(await this.fs.exists(folder))) throw new Error(`Folder not found: ${folder}`);
    const names = await this.fs.listFiles(folder);
    const VIDEO_EXT = [".mp4", ".mkv", ".webm", ".mov", ".avi", ".ts"];
    const isVideo = (n: string) => VIDEO_EXT.some((e) => n.toLowerCase().endsWith(e));
    const isProxy = (n: string) => ["proxy.ts", "proxy.mp4", "scrub.ts"].some((s) => n.toLowerCase() === s);
    // HQ preference: a full-quality container over a raw TS, and the largest
    // candidate wins when several exist (proxy.ts is also .ts — excluded
    // from HQ by the proxy check before the video check).
    const videos = names.filter((n) => isVideo(n) && !isProxy(n));
    if (videos.length === 0) throw new Error(`No video file found in folder: ${folder}`);
    const hq = videos.find((n) => !n.toLowerCase().endsWith(".ts")) ?? videos[0]!;
    const proxyName = names.find((n) => isProxy(n)) ?? null;
    return {
      vodPath: this.fs.joinPath(folder, hq),
      proxyPath: proxyName ? this.fs.joinPath(folder, proxyName) : null,
      chatPath: names.includes("chat.json") ? this.fs.joinPath(folder, "chat.json") : null,
    };
  }
}

export class ImportStreamByUrlUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly vodDownloader: VodDownloadPort,
    private readonly fs: FileSystemPort,
    private readonly bus: EventBus,
    private readonly cacheDir: string,
    /** Progressive orchestrator — present when progressive download is available. */
    private readonly orchestrator: DownloadOrchestrator | null = null,
    /** Per-stream abort controllers for in-flight progressive downloads. */
    private readonly aborts = new Map<string, AbortController>(),
  ) {}

  async execute(input: ImportByUrlInput): Promise<ImportResult> {
    if (!this.vodDownloader.isSupported(input.url)) {
      throw new Error(`Unsupported VOD URL: ${input.url}`);
    }

    // Fetch metadata first for immediate stream record. The progressive
    // URL imports fetch metadata via GQL directly (no twitch-dl dependency).
    const meta = await (async () => {
      const id = extractVodId(input.url);
      if (!id) throw new Error(`Unsupported VOD URL: ${input.url}`);
      const m = await fetchVodMeta(id);
      return { title: m.title, streamer: m.streamer, game: m.game, duration: m.durationSec };
    })();
    const stream = createStream({
      vodPath: "", // filled after download
      sourceUrl: input.url,
      title: input.title ?? meta.title,
      streamer: input.streamer ?? meta.streamer,
      game: meta.game,
      duration: meta.duration,
    });
    await this.streams.save(stream);

    // URL imports always use the chunked/live HLS orchestrator — chunks are
    // proxybable as they land regardless of the proxy-first toggle (the
    // directive's "opted out" case: single download at max quality, still
    // live). includeProxy picks one file (max quality) or two (540p first).
    // The twitch-dl legacy path is gone: it was a /tmp venv dependency and
    // delivered no live-chunk behavior.
    const controller = new AbortController();
    this.aborts.set(stream.id, controller);
    const destDir = `${this.cacheDir}/vods/${stream.id}`;
    await this.fs.ensureDir(destDir);
    this.runProgressive(stream.id, input, meta, destDir, controller).catch((err) => {
      console.error(`Progressive download failed for ${input.url}:`, err);
    });
    return { stream, downloadJobId: stream.id };
  }

  private async runProgressive(
    streamId: string,
    input: ImportByUrlInput,
    _meta: { title: string },
    destDir: string,
    controller: AbortController,
    resume = false,
  ): Promise<void> {
    if (!this.orchestrator) return;
    // Live-run marker: reconcile() must not flip a genuinely running
    // download's phase to failed while the poller reads state.
    this.orchestrator.markRunLive(streamId, true);
    try {
      await this.runProgressiveInner(streamId, input, destDir, controller, resume);
    } finally {
      this.orchestrator.markRunLive(streamId, false);
    }
  }

  private async runProgressiveInner(
    streamId: string,
    input: ImportByUrlInput,
    destDir: string,
    controller: AbortController,
    resume: boolean,
  ): Promise<void> {
    const result = await this.orchestrator!.run({
      streamId,
      sourceUrl: input.url,
      destDir,
      proxyHeightCap: input.proxyHeightCap ?? 540,
      maxQualityHeight: input.maxQualityHeight ?? null,
      // Proxy-first (two files: 540p then HQ) is the opt-in — default is a
      // single download at max quality, still chunk-live.
      includeProxy: input.includeProxy ?? false,
      resume,
      signal: controller.signal,
      // Attach each artifact to the stream record the moment its part
      // completes — review can start on proxy while HQ still downloads,
      // and chat lands even if a later video pass fails.
      onPartDone: (kind, state) => this.attachPart(streamId, kind, state),
    });
    this.aborts.delete(streamId);

    // Point the stream at the best downloaded media: HQ if present, else
    // the proxy file (single-download case), plus the fetched chat.
    const existing = await this.streams.findById(streamId);
    if (!existing) return;
    const best = result.hqPath ?? result.proxyPath;
    if (best || result.chatPath) {
      await this.streams.update({
        ...existing,
        ...(best ? { vodPath: best } : {}),
        ...(result.chatPath ? { chatPath: result.chatPath } : {}),
      });
    }
  }

  /** Point the stream at each artifact as its part completes. */
  private async attachPart(
    streamId: string,
    kind: "chat" | "markers" | "proxy" | "hq",
    state: { chatPath: string | null; proxyPath: string | null; hqPath: string | null },
  ): Promise<void> {
    const existing = await this.streams.findById(streamId);
    if (!existing) return;
    const patch: Partial<Stream> = {};
    if (kind === "chat" && state.chatPath) patch.chatPath = state.chatPath;
    if (kind === "proxy" && state.proxyPath && !existing.vodPath.includes("/proxy.ts")) {
      patch.vodPath = state.proxyPath;
    }
    if (kind === "hq" && state.hqPath) patch.vodPath = state.hqPath;
    if (Object.keys(patch).length === 0) return;
    await this.streams.update({ ...existing, ...patch });
  }

  /**
   * Resume an interrupted/stalled progressive download: re-runs the pipeline
   * with resume=true so each video part keeps its on-disk chunk prefix and
   * chat is skipped when already fetched. Throws honestly when the stream
   * has no source URL or a download is already live.
   */
  async resumeDownload(streamId: string): Promise<void> {
    if (!this.orchestrator) throw new Error("Progressive download not available");
    const stream = await this.streams.findById(streamId);
    if (!stream?.sourceUrl) throw new Error("Stream has no source URL to resume from");

    const existing = await this.orchestrator.getState(streamId);
    if (existing.phase === "running") {
      // A live run holds a controller; an orphaned "running" (server restart,
      // crash) doesn't. Only refuse when THIS process still owns the run.
      if (this.aborts.has(streamId)) {
        throw new Error("A download is already running for this stream");
      }
    }

    const controller = new AbortController();
    this.aborts.set(streamId, controller);
    const destDir = `${this.cacheDir}/vods/${streamId}`;
    await this.fs.ensureDir(destDir);
    // Resume carries the same settings as the last run, persisted in state.
    this.runProgressive(streamId, {
      url: stream.sourceUrl,
      progressive: true,
      proxyHeightCap: (existing.qualities.length > 0 ? undefined : 540) ?? 540,
      maxQualityHeight: null,
      includeProxy: existing.parts.some((p) => p.kind === "hq" && p.status !== "skipped") &&
        existing.proxyPath !== existing.hqPath,
    } as ImportByUrlInput, { title: stream.title ?? "" }, destDir, controller, true).catch((err) => {
      console.error(`Resume download failed for ${streamId}:`, err);
    });
  }

  /** Cancel an in-flight progressive download (route: DELETE /download). */
  cancelProgressive(streamId: string): boolean {
    const controller = this.aborts.get(streamId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Delete a download: abort any in-flight run, remove every artifact the
   * pipeline produced (.ts, .mp4 twins, chat.json, playlists cache) and
   * reset the download state to idle. The "cancel that does nothing" case —
   * a stuck/orphaned state from a crashed server — clears here too, since
   * it doesn't depend on an active AbortController.
   */
  async deleteDownload(streamId: string, cacheDir: string): Promise<boolean> {
    // Abort an in-flight run if one is live (best effort; the orphaned case
    // has no controller).
    this.cancelProgressive(streamId);
    // Give the aborted fetches a beat to release file handles.
    await new Promise((r) => setTimeout(r, 300));

    const dir = `${cacheDir}/vods/${streamId}`;
    for (const name of [
      "proxy.ts", "proxy.mp4", "proxy.chunks", "scrub.ts", "scrub.mp4", "scrub.chunks",
      "hq.ts", "hq.mp4", "hq.chunks", "video.mp4", "chat.json",
    ]) {
      try {
        await Deno.remove(`${dir}/${name}`);
      } catch {
        // absent — fine
      }
    }
    // Reset state to idle so the Library item leaves the download list.
    const idle = await this.orchestrator?.getState(streamId);
    if (idle && idle.phase !== "idle") {
      idle.phase = "idle";
      idle.parts = [];
      idle.overall = { percent: 0, etaSec: null };
      idle.proxyFrontierSec = 0;
      idle.proxyPath = null;
      idle.hqPath = null;
      idle.proxyMp4 = null;
      idle.hqMp4 = null;
      idle.chatPath = null;
      idle.chatCount = 0;
      idle.qualities = [];
      idle.startedAt = null;
      await this.orchestrator!.setState(streamId, idle);
    }
    return true;
  }

  private async downloadInBackground(jobId: string, url: string, streamId: string): Promise<void> {
    const destDir = `${this.cacheDir}/vods/${streamId}`;
    await this.fs.ensureDir(destDir);

    const { vodPath, chatPath } = await this.vodDownloader.download(url, destDir, (p) => {
      this.bus.publish(DOWNLOAD_PROGRESS_TOPIC, { jobId, streamId, ...p });
    });

    const existing = await this.streams.findById(streamId);
    if (!existing) return;
    await this.streams.update({ ...existing, vodPath, chatPath });
  }
}
