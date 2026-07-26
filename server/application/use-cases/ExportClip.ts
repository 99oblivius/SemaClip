import type {
  ClipRepository,
  StreamRepository,
  FFmpegExportPort,
  FileSystemPort,
} from "@/application/ports/outbound.ts";
import type { ExportClipInput, ExportResult } from "shared/types";
import { markExported } from "@/domain/mod.ts";

export class ExportClipUseCase {
  constructor(
    private readonly clips: ClipRepository,
    private readonly streams: StreamRepository,
    private readonly ffmpeg: FFmpegExportPort,
    private readonly fs: FileSystemPort,
    private readonly defaultExportDir: string,
  ) {}

  async execute(input: ExportClipInput): Promise<ExportResult> {
    const clip = await this.clips.findById(input.clipId);
    if (!clip) throw new Error(`Clip not found: ${input.clipId}`);

    const stream = await this.streams.findById(clip.streamId);
    if (!stream) throw new Error(`Stream not found for clip: ${clip.streamId}`);

    const exportDir = input.outputPath ?? this.defaultExportDir;
    await this.fs.ensureDir(exportDir);

    const filename = `semaclip_${clip.axis}_${this.fmtTime(clip.peakTime)}.mp4`;
    const outputPath = `${exportDir}/${filename}`;

    // Caption SRT path — the engine generates this during processing.
    const srtPath = stream.chatPath?.replace(/\.json$/, ".srt") ?? null;

    const result = await this.ffmpeg.exportClip({
      vodPath: stream.vodPath,
      startTime: clip.startTime,
      endTime: clip.endTime,
      outputPath,
      format: input.format,
      aspectRatio: input.aspectRatio,
      cropPosition: input.cropPosition,
      captions: {
        enabled: input.captions.enabled,
        srtPath,
        preset: input.captions.preset,
        position: input.captions.position,
        fontSize: input.captions.fontSize,
        backgroundOpacity: input.captions.backgroundOpacity,
      },
    });

    const exported = markExported(clip, result.exportPath);
    await this.clips.update(exported);

    return { clipId: clip.id, exportPath: result.exportPath, durationMs: result.durationMs };
  }

  private fmtTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(s).padStart(2, "0")}`;
  }
}
