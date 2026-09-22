import type {
  ClipRepository,
  StreamRepository,
  FFmpegExportPort,
  FileSystemPort,
  StreamMetadataRepository,
} from "@/application/ports/outbound.ts";
import type { ExportClipInput, ExportResult } from "shared/types";
import { normaliseProfile, renderFilenameTemplate, validateExportProfile } from "shared/types";
import { markExported } from "@/domain/mod.ts";
import { uniqueName, vodFolderName } from "@/application/use-cases/artifact-naming.ts";
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
    /**
     * The user's configured export directory, asked PER EXPORT rather than captured at boot.
     *
     * `defaultExportDir` above is the process default (`{dataDir}/exports`). The settings value is
     * what the OWNER chose, and it has to win — otherwise the app writes somewhere the user never
     * picked and their own path never appears, which is exactly what was reported ("no files written
     * to the export path": they were written to the boot default, and the configured directory was
     * never created at all).
     *
     * A getter rather than a value: settings can change while the server runs, and a path captured at
     * boot would keep writing to the old directory until the next restart.
     */
    private readonly configuredExportDir: () => Promise<string> = async () => defaultExportDir,
  ) {}

  /**
   * The file a clip must be RENDERED from, or null when no video exists.
   *
   * The RENDER source is the FULL-QUALITY video, never the proxy: `stream.vodPath` for a project that
   * was imported from a file or a folder (the user's own copy IS the video), and the download state's
   * `hqMp4` for a downloaded one.
   *
   * Two things this must not do. It must not fall back to the proxy — `deleteVideo` repoints
   * `vodPath` at the proxy so playback keeps working, and rendering from it would silently export
   * the low-quality preview as the deliverable. And it must not return the proxy when the video is
   * simply ABSENT, which is why the proxy is not in this candidate list at all.
   *
   * Existence is checked on disk, because a recorded path is a claim: the folder may have been moved
   * or the file deleted since.
   */
  private async resolveRenderPath(stream: { id: string; vodPath: string }): Promise<string | null> {
    const state = this.orchestrator ? await this.orchestrator.getState(stream.id) : null;
    // The download view's own `renderPath` is "a video is playable" — it is null for a project whose
    // media was imported rather than downloaded, which is the ONLY source some projects have.
    const candidates = [state?.hqMp4, state?.hqPath, stream.vodPath];
    for (const candidate of candidates) {
      if (candidate && (await this.fs.exists(candidate))) return candidate;
    }
    return null;
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
    const renderPath = await this.resolveRenderPath(stream);
    if (!renderPath) {
      throw new Error(
        "No video file to export from — only a preview (proxy) exists. " +
          "Download the video to enable exports.",
      );
    }

    // ONE profile reaches the encoder, whether the client sent a whole profile or the older
    // individual fields — both are folded through the same normaliser, which also fills anything a
    // stored preset left out.
    //
    // A profile the CLIENT sent is validated first and refused BY NAME. Filling is right for reading
    // a stored preset row (the user wants something usable, not an error), but applying it to a
    // request would silently substitute a different codec than the one asked for — the user would
    // receive an H.264 file labelled VP9 and have no way to tell.
    if (input.profile) {
      const check = validateExportProfile({
        container: input.profile.container,
        videoCodec: input.profile.videoCodec,
        audioCodec: input.profile.audioCodec,
        maxHeight: input.profile.maxHeight,
      });
      if (!check.ok) throw new Error(`Invalid export profile: ${check.reason}`);
    }
    const profile = normaliseProfile(
      input.profile ?? {
        format: input.format,
        ...(input.aspectRatio ? { aspectRatio: input.aspectRatio } : {}),
        ...(input.captions ? { captions: input.captions } : {}),
      },
    );

    // ── Where the file goes, and what it is called ──
    //
    // THREE decisions, in this order, and each one was previously wrong:
    //
    //  1. WHICH directory. `input.outputPath` is an explicit per-batch override; otherwise the
    //     user's configured directory wins over the process default, because the configured one is
    //     what they chose. Asked per export so a settings change takes effect without a restart.
    //  2. WHICH subfolder. One folder per VOD, named exactly like the project folders
    //     (`{streamer}-{game}-{local-date}`) so the export tree reads the same way the project tree
    //     does. Composed from the STREAM, not the clip: several clips of one stream belong together,
    //     which is the whole point of the folder.
    //  3. WHAT it is called. The template is RENDERED HERE from the clip's own data. The client
    //     still formats it for its preview, but its value is treated as a TEMPLATE, never trusted as
    //     a filename — that trust is what wrote `date---channel---name---ts.mp4` for every export.
    const exportDir = input.outputPath ?? await this.configuredExportDir();
    const ext = { mp4: ".mp4", webm: ".webm", mkv: ".mkv" }[profile.container];

    const streamFolder = vodFolderName({
      id: stream.id,
      streamer: stream.streamer,
      game: stream.game,
      createdAt: stream.createdAt,
    });
    const outputDir = this.fs.joinPath(exportDir, streamFolder);
    await this.fs.ensureDir(outputDir);

    const template = input.filename?.trim() || profile.nameTemplate || "{date}-{channel}-{name}-{ts}";
    // The same precedence the rest of the app displays for a clip's name: the user's own name, then
    // the engine's axis, then the kind. Resolved before rendering so an unnamed clip still produces
    // a legible filename instead of a hole in the middle of it.
    const clipLabel = clip.title ?? clip.axis ?? "manual";
    const rendered = renderFilenameTemplate(template, {
      channel: stream.streamer ?? null,
      name: clipLabel,
      startTime: clip.startTime,
      streamTitle: stream.title ?? "",
    });
    // A template is free text and may render to nothing (a blank template, or one whose every token
    // resolved empty). Fall back rather than writing ".mp4".
    const stem = rendered.length > 0 ? rendered : `semaclip_${clipLabel}_${this.fmtTime(clip.peakTime)}`;
    // COLLISION. Two exports of the same clip — or of two clips that render to the same name — must
    // not overwrite each other, which is precisely what happened before: three clips, one file. The
    // suffix rule is the project folders' own (`name`, `name-2`, `name-3`), taken as a listing
    // because only the directory can answer whether a name is free.
    const taken = await this.fs.listFiles(outputDir);
    const filename = `${uniqueName(this.sanitiseStem(stem), taken)}${ext}`;
    const outputPath = this.fs.joinPath(outputDir, filename);

    // Caption SRT: only a genuinely generated transcript sidecar qualifies.
    // v1 renamed chat.json → .srt and burned garbage; refusing is the honest path.
    let srtPath: string | null = null;
    if (profile.captions.enabled) {
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
      profile,
      srtPath,
      onProgress: input.onProgress,
      signal: input.signal,
    });

    const exported = markExported(clip, result.exportPath);
    await this.clips.update(exported);

    return {
      clipId: clip.id,
      exportPath: result.exportPath,
      durationMs: result.durationMs,
      // Passed through rather than reconstructed: only the adapter that ran the process knows which
      // encoder produced this file.
      backend: result.backend,
    };
  }

  /**
   * The last line of defence for a stem that becomes a filename.
   *
   * `renderFilenameTemplate` already removes path separators and the characters a filesystem
   * refuses. This runs afterwards because the FALLBACK stem is composed here, not by that renderer,
   * and because a cap has to be applied to the joined result: a 60-character name inside a
   * 120-character template is otherwise a 180-character filename, and the length is the filesystem's
   * limit, not the template's.
   */
  private sanitiseStem(stem: string): string {
    const safe = stem
      .replace(/[^\w.\- ]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 120)
      .replace(/-+$/g, "");
    // A template can render to nothing usable (all separators, or an over-long cap that ate
    // everything). ".mp4" is not a filename.
    return safe.length > 0 ? safe : "semaclip-export";
  }

  private fmtTime(seconds: number): string {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${String(h).padStart(2, "0")}-${String(m).padStart(2, "0")}-${String(s).padStart(2, "0")}`;
  }
}