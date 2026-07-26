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
  ) {}

  async execute(input: ImportByUrlInput): Promise<ImportResult> {
    if (!this.vodDownloader.isSupported(input.url)) {
      throw new Error(`Unsupported VOD URL: ${input.url}`);
    }

    // Fetch metadata first for immediate stream record.
    const meta = await this.vodDownloader.fetchMetadata(input.url);
    const stream = createStream({
      vodPath: "", // filled after download
      sourceUrl: input.url,
      title: input.title ?? meta.title,
      streamer: input.streamer ?? meta.streamer,
      game: meta.game,
      duration: meta.duration,
    });
    await this.streams.save(stream);

    // Download async — progress published to event bus.
    const downloadJobId = stream.id;
    this.downloadInBackground(downloadJobId, input.url, stream.id).catch((err) => {
      console.error(`VOD download failed for ${input.url}:`, err);
    });

    return { stream, downloadJobId };
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
