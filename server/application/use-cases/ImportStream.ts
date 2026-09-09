import type {
  StreamRepository,
  VodDownloadPort,
  EventBus,
  FileSystemPort,
  MediaProbePort,
} from "@/application/ports/outbound.ts";
import { DOWNLOAD_PROGRESS_TOPIC } from "@/application/ports/outbound.ts";
import type { ImportByFileInput, ImportByUrlInput, ImportResult } from "shared/types";
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
    if (!(await this.fs.exists(input.vodPath))) {
      throw new Error(`VOD file not found: ${input.vodPath}`);
    }
    const duration = await this.probe.probeDuration(input.vodPath);
    const stream = createStream({
      vodPath: input.vodPath,
      chatPath: input.chatPath ?? null,
      sourceUrl: input.sourceUrl ?? null,
      title: input.title,
      streamer: input.streamer,
      duration: duration ?? undefined,
    });
    await this.streams.save(stream);
    return { stream, downloadJobId: null };
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
    // path uses GQL directly (no twitch-dl dependency); legacy flow keeps
    // twitch-dl.
    const meta = input.progressive && this.orchestrator
      ? await (async () => {
          const id = extractVodId(input.url);
          if (!id) throw new Error(`Unsupported VOD URL: ${input.url}`);
          const m = await fetchVodMeta(id);
          return { title: m.title, streamer: m.streamer, game: m.game, duration: m.durationSec };
        })()
      : await this.vodDownloader.fetchMetadata(input.url);
    const stream = createStream({
      vodPath: "", // filled after download
      sourceUrl: input.url,
      title: input.title ?? meta.title,
      streamer: input.streamer ?? meta.streamer,
      game: meta.game,
      duration: meta.duration,
    });
    await this.streams.save(stream);

    // Progressive (scrub-first) download when requested and available;
    // legacy single-file flow otherwise.
    if (input.progressive && this.orchestrator) {
      const controller = new AbortController();
      this.aborts.set(stream.id, controller);
      const destDir = `${this.cacheDir}/vods/${stream.id}`;
      await this.fs.ensureDir(destDir);
      this.runProgressive(stream.id, input, meta, destDir, controller).catch((err) => {
        console.error(`Progressive download failed for ${input.url}:`, err);
      });
      return { stream, downloadJobId: stream.id };
    }

    // Download async — progress published to event bus.
    const downloadJobId = stream.id;
    this.downloadInBackground(downloadJobId, input.url, stream.id).catch((err) => {
      console.error(`VOD download failed for ${input.url}:`, err);
    });

    return { stream, downloadJobId };
  }

  private async runProgressive(
    streamId: string,
    input: ImportByUrlInput,
    _meta: { title: string },
    destDir: string,
    controller: AbortController,
  ): Promise<void> {
    if (!this.orchestrator) return;
    const result = await this.orchestrator.run({
      streamId,
      sourceUrl: input.url,
      destDir,
      scrubHeightCap: input.scrubHeightCap ?? 540,
      maxQualityHeight: input.maxQualityHeight ?? null,
      includeScrub: input.includeScrub ?? true,
      signal: controller.signal,
    });
    this.aborts.delete(streamId);

    // Point the stream at the best downloaded media: HQ if present, else
    // the scrub file (single-download case), plus the fetched chat.
    const existing = await this.streams.findById(streamId);
    if (!existing) return;
    const best = result.hqPath ?? result.scrubPath;
    if (best || result.chatPath) {
      await this.streams.update({
        ...existing,
        ...(best ? { vodPath: best } : {}),
        ...(result.chatPath ? { chatPath: result.chatPath } : {}),
      });
    }
  }

  /** Cancel an in-flight progressive download (route: DELETE /download). */
  cancelProgressive(streamId: string): boolean {
    const controller = this.aborts.get(streamId);
    if (!controller) return false;
    controller.abort();
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
