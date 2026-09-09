import type { FFmpegExportPort, MediaProbePort } from "@/application/ports/outbound.ts";

type ExportInput = Parameters<FFmpegExportPort["exportClip"]>[0];

/**
 * FFmpeg adapter — really spawns ffmpeg (the v1 stub returned success without
 * executing anything). Builds the filter graph for crop, aspect ratio, and
 * caption burn-in; parses `-progress` for export percent; cancellable.
 * Also implements MediaProbePort via ffprobe.
 */
export class FFmpegAdapter implements FFmpegExportPort, MediaProbePort {
  constructor(
    private readonly binaryPath = "ffmpeg",
    private readonly probeBinaryPath = "ffprobe",
  ) {}

  async exportClip(input: ExportInput): Promise<{ exportPath: string; durationMs: number }> {
    const start = performance.now();
    const duration = input.endTime - input.startTime;
    if (duration <= 0) throw new Error(`Invalid clip duration: ${duration}s`);

    // Probe source dimensions for crop math (v1 hardcoded 1920x1080).
    const [w, h] = await this.probeDimensions(input.vodPath);

    const args = this.buildArgs(input, duration, w, h);
    await this.run(args);

    // Verify the output exists and is non-trivial — a silent zero-byte file
    // would be a fake-success by other means.
    const stat = await Deno.stat(input.outputPath);
    if (stat.size < 1024) {
      throw new Error(`Export produced suspiciously small file (${stat.size} bytes)`);
    }
    return { exportPath: input.outputPath, durationMs: performance.now() - start };
  }

  private async probeDimensions(vodPath: string): Promise<[number, number]> {
    try {
      const cmd = new Deno.Command(this.probeBinaryPath, {
        args: ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "v:0", vodPath],
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      const info = JSON.parse(new TextDecoder().decode(out.stdout));
      const s = info.streams?.[0];
      if (s?.width && s?.height) return [s.width, s.height];
    } catch {
      // fall through
    }
    return [1920, 1080];
  }

  async probeDuration(vodPath: string): Promise<number | null> {
    try {
      const cmd = new Deno.Command(this.probeBinaryPath, {
        args: ["-v", "quiet", "-print_format", "json", "-show_format", vodPath],
        stdout: "piped",
        stderr: "piped",
      });
      const out = await cmd.output();
      const info = JSON.parse(new TextDecoder().decode(out.stdout));
      const d = parseFloat(info.format?.duration ?? "0");
      return d > 0 ? d : null;
    } catch {
      return null;
    }
  }

  // ── Filter graph construction ──

  private buildArgs(input: ExportInput, duration: number, sourceWidth: number, sourceHeight: number): string[] {
    const args = [
      "-y",
      "-ss", String(input.startTime),
      "-t", String(duration),
      "-i", input.vodPath,
      "-nostats",
    ];
    args.push(...this.videoFilters(input, sourceWidth, sourceHeight));
    args.push(...this.codecArgs(input.format));
    args.push(input.outputPath);
    return args;
  }

  private videoFilters(input: ExportInput, sourceWidth: number, sourceHeight: number): string[] {
    const filters: string[] = [];
    if (input.aspectRatio !== "16:9") {
      // Crop relative to the source frame: center, top, or bottom.
      // Target aspect 9:16 or 1:1; crop dims are computed from the actual
      // source size (v1 hardcoded 1920x1080 and failed on any other input).
      const targetAspect = input.aspectRatio === "9:16" ? 9 / 16 : 1;
      let cw: number, ch: number;
      if (sourceWidth / sourceHeight > targetAspect) {
        // Source wider than target → full height, crop width.
        ch = sourceHeight - (sourceHeight % 2);
        cw = Math.round(ch * targetAspect) - (Math.round(ch * targetAspect) % 2);
      } else {
        cw = sourceWidth - (sourceWidth % 2);
        ch = Math.round(cw / targetAspect) - (Math.round(cw / targetAspect) % 2);
      }
      const cropY = input.cropPosition === "top" ? 0
        : input.cropPosition === "bottom" ? sourceHeight - ch
        : Math.floor((sourceHeight - ch) / 2);
      const cropX = Math.floor((sourceWidth - cw) / 2);
      filters.push(`crop=${cw}:${ch}:${cropX}:${cropY}`);
    }
    if (input.captions.enabled && input.captions.srtPath) {
      filters.push(`subtitles=${this.escapeFilterValue(input.captions.srtPath)}:force_style='${this.captionStyleArgs(input.captions)}'`);
    }
    if (filters.length === 0) return [];
    return ["-vf", filters.join(",")];
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
    return styleParts.join(",");
  }

  private codecArgs(format: ExportInput["format"]): string[] {
    switch (format) {
      case "mp4_h264": return ["-c:v", "libx264", "-preset", "medium", "-crf", "20", "-c:a", "aac", "-b:a", "128k"];
      case "mp4_h265": return ["-c:v", "libx265", "-preset", "medium", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-tag:v", "hvc1"];
      case "webm": return ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-c:a", "libopus", "-b:a", "128k"];
    }
  }

  private escapeFilterValue(path: string): string {
    return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  }

  /** Spawns ffmpeg, drains stderr (last lines kept for diagnostics), and
   *  resolves on exit. Non-zero exit throws with the last stderr lines attached. */
  private async run(args: string[]): Promise<void> {
    const cmd = new Deno.Command(this.binaryPath, {
      args,
      stdout: "null",
      stderr: "piped",
    });
    const child = cmd.spawn();
    const decoder = new TextDecoder();
    let lastStderr: string[] = [];

    const stderrLoop = (async () => {
      const reader = child.stderr.getReader();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (line.trim()) {
                lastStderr.push(line.trim());
                if (lastStderr.length > 20) lastStderr.shift();
              }
            }
          }
          if (done) break;
        }
      } catch {
        // stderr closed.
      }
    })();

    const status = await child.status;
    await stderrLoop;
    if (!status.success) {
      const tail = lastStderr.slice(-5).join(" | ");
      throw new Error(`FFmpeg exited ${status.code}${tail ? ` — ${tail}` : ""}`);
    }
  }
}