import type {
  ClipRepository,
  StreamRepository,
  FFmpegExportPort,
  FileSystemPort,
  StreamMetadataRepository,
} from "@/application/ports/outbound.ts";
import type { ExportClipInput, ExportResult } from "shared/types";
import { markExported } from "@/domain/mod.ts";
import { projectDownloadView } from "@/application/view/project-download-view.ts";
import type { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";

export class ExportClipUseCase {
  constructor(
    private readonly clips: ClipRepository,
    private readonly streams: StreamRepository,
    private readonly ffmpeg: FFmpegExportPort,
    private readonly fs: FileSystemPort,
    private readonly defaultExportDir: string,
    /** Stream metadata repo — the transcript SRT (if generated) is stored there. */
    private readonly metadata: StreamMetadataRepository,
    /** The download state owner — the only source of what is playable/rendered. */
    private readonly orchestrator: DownloadOrchestrator | null = null,
  ) {}

  /**
   * The file a clip must be RENDERED from, or null when no video exists.
   *
   * Derived from the download view so the rule has ONE definition: the same
   * `media.renderPath` the UI shows as the export source, rather than a second guess at
   * which file on disk counts as the video.
   */
  private async resolveRenderPath(streamId: string): Promise<string | null> {
    if (!this.orchestrator) return null;
    const state = await this.orchestrator.getState(streamId);
    const view = projectDownloadView({
      streamId,
      state,
      markers: null,
      hasSource: false,
      revision: 0,
    });
    return view.media.renderPath;
  }

  async execute(input: ExportClipInput): Promise<ExportResult> {
    const clip = await this.clips.findById(input.clipId);
    if (!clip) throw new Error(`Clip not found: ${input.clipId}`);

    const stream = await this.streams.findById(clip.streamId);
    if (!stream) throw new Error(`Stream not found for clip: ${clip.streamId}`);

    // EXPORTS RENDER FROM THE VIDEO, NEVER FROM A PREVIEW COPY.
    //
    // `stream.vodPath` is not a safe render source: `deleteVideo` repoints it at the proxy
    // so playback keeps working when the video is removed, and the download view
    // deliberately serves the proxy for review. Rendering from it would silently export the
    // low-quality preview as if it were the deliverable. The download view reports the
    // render source explicitly as `media.renderPath`, so ask it and refuse when it is
    // absent.
    const renderPath = await this.resolveRenderPath(clip.streamId);
    if (!renderPath) {
      throw new Error(
        "No video file to export from — only a preview (proxy) exists. " +
          "Download the video to enable exports.",
      );
    }

    const exportDir = input.outputPath ?? this.defaultExportDir;
    await this.fs.ensureDir(exportDir);

    const ext = input.format === "webm" ? ".webm" : ".mp4";
    // Client-computed filename from the naming template (P1-2); server
    // sanitizes as defense-in-depth — the template renders in the browser
    // where all context (channel, date, preset) lives.
    const base = input.filename?.trim();
    const safeBase = base
      ? base.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120)
      : null;
    const filename = safeBase ? `${safeBase}${ext}` : `semaclip_${clip.axis}_${this.fmtTime(clip.peakTime)}${ext}`;
    const outputPath = `${exportDir}/${filename}`;

    // Caption SRT: only a genuinely generated transcript sidecar qualifies.
    // v1 renamed chat.json → .srt and burned garbage; refusing is the honest path.
    let srtPath: string | null = null;
    if (input.captions.enabled) {
      const stored = await this.metadata.get(stream.id, "transcript_srt");
      if (stored) {
        srtPath = JSON.parse(stored).path as string;
        if (!(await this.fs.exists(srtPath))) {
          throw new Error("Captions enabled but transcript SRT is missing on disk — re-run processing or disable captions");
        }
      } else {
        throw new Error("Captions enabled but no transcript SRT exists for this stream — captions require completed transcription");
      }
    }

    const result = await this.ffmpeg.exportClip({
      vodPath: renderPath,
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