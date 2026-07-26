import type { FFmpegExportPort } from "@/application/ports/outbound.ts";

type ExportInput = Parameters<FFmpegExportPort["exportClip"]>[0];

/** FFmpeg adapter — builds the filter graph for crop, aspect ratio, and caption burn-in. */
export class FFmpegAdapter implements FFmpegExportPort {
  constructor(private readonly binaryPath = "ffmpeg") {}

  async exportClip(input: ExportInput): Promise<{ exportPath: string; durationMs: number }> {
    const start = performance.now();
    const duration = input.endTime - input.startTime;
    const args = this.buildArgs(input, duration);
    await this.run(args);
    return { exportPath: input.outputPath, durationMs: performance.now() - start };
  }

  // ── Filter graph construction ──

  private buildArgs(input: ExportInput, duration: number): string[] {
    const args = ["-y", "-ss", String(input.startTime), "-t", String(duration), "-i", input.vodPath];
    args.push(...this.videoFilters(input));
    if (input.captions.enabled && input.captions.srtPath) {
      args.push("-vf", `subtitles=${this.escapeFilterValue(input.captions.srtPath)}:${this.captionStyleArgs(input.captions)}`);
    }
    args.push(...this.codecArgs(input.format));
    args.push(input.outputPath);
    return args;
  }

  private videoFilters(input: ExportInput): string[] {
    if (input.aspectRatio === "16:9") return ["-c:v", "copy"];
    // Crop for vertical/square: center, top, or bottom of the 16:9 frame.
    const [cw, ch] = input.aspectRatio === "9:16" ? [608, 1080] : [720, 720];
    const cropY = input.cropPosition === "top" ? 0 : input.cropPosition === "bottom" ? 1080 - ch : (1080 - ch) / 2;
    const filter = `crop=${cw}:${ch}:0:${Math.round(cropY)},scale=${cw}:${ch}`;
    return ["-vf", filter];
  }

  private captionStyleArgs(captions: ExportInput["captions"]): string {
    const styleParts: string[] = [];
    if (captions.preset === "bold-white") styleParts.push("FontName=Inter", "FontColor=white", "Bold=1");
    else if (captions.preset === "yellow") styleParts.push("FontName=Inter", "FontColor=yellow", "Bold=1");
    else styleParts.push("FontName=Inter", "FontColor=white");
    styleParts.push(`FontSize=${captions.fontSize}`);
    if (captions.position === "top") styleParts.push("MarginV=40");
    const alpha = Math.round(captions.backgroundOpacity * 255);
    styleParts.push(`BackColour=&H${alpha.toString(16).padStart(2, "0")}000000`);
    return `force_style='${styleParts.join(",")}'`;
  }

  private codecArgs(format: ExportInput["format"]): string[] {
    switch (format) {
      case "mp4_h264": return ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "128k"];
      case "mp4_h265": return ["-c:v", "libx265", "-preset", "medium", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-tag:v", "hvc1"];
      case "webm": return ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-b:a", "128k"];
    }
  }

  private escapeFilterValue(path: string): string {
    // Escape special chars in file paths for FFmpeg filter syntax.
    return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  }

  private async run(args: string[]): Promise<void> {
    const cmd = new Deno.Command(this.binaryPath, {
      args,
      stdout: "inherit",
      stderr: "piped",
    });
    const child = cmd.spawn();
    this.readStderr(child.stderr).catch(() => {});
    const { success, code } = await child.output();
    if (!success) throw new Error(`FFmpeg exited ${code}`);
  }

  private async readStderr(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        console.debug("ffmpeg:", decoder.decode(value, { stream: true }));
      }
    } catch {
      // Stream closed — ignore.
    }
  }
}
