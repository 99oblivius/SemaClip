import type { FFmpegExportPort, MediaProbePort } from "@/application/ports/outbound.ts";
import { run, spawnChild } from "@/adapters/outbound/process/spawn.ts";
import { listEncodersFor, probeGpuEncoderCached, proxyEncodeArgs, blacklistGpuBackend } from "./gpu-probe.ts";
import { buildExportArgs } from "@/domain/export-profile.ts";
import type { ExportPhase, ExportProfile, SourceMedia } from "shared/types";

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

  async exportClip(input: ExportInput): Promise<{ exportPath: string; durationMs: number; backend: string }> {
    const start = performance.now();
    const [w, h] = await this.probeDimensions(input.vodPath);
    // Which hardware encoder to use, and which device it needs.
    //
    // The profile may NAME one (the user picked it from this machine's verified list); otherwise the
    // probe picks. Either way the answer is cross-checked against the machine's real list, so a
    // profile naming an encoder that is not on this host falls back to the probe rather than to an
    // ffmpeg failure — a saved profile can travel between machines.
    const codec = input.profile.videoCodec;
    const offered = await listEncodersFor({ codec });
    const named = input.profile.encoderName
      ? offered.find((o) => o.encoder === input.profile.encoderName) ?? null
      : null;
    const cap = named ? null : await probeGpuEncoderCached(codec);
    /**
     * A NAMED encoder wins outright, software or hardware.
     *
     * `buildExportArgs` picks its software encoder from a per-codec table, so a user who explicitly
     * chose a different software encoder than that table's would otherwise be silently ignored. Naming
     * the pick as the hardware slot when it is in fact software would also mislabel the run, so the
     * choice is carried as a capability and `hardwareEncoder` is reserved for genuine hardware.
     */
    const hwEncoder = named
      ? (named.software ? null : named.encoder)
      : (cap!.backend === "cpu" ? null : cap!.encoder!);
    // A named SOFTWARE pick must still be honoured: passed through when it differs from the table's
    // default, and `buildExportArgs` prefers it. Named hardware needs no override — `hwEncoder` is it.
    const forcedEncoder = named && named.software ? named.encoder : null;
    const deviceArgs = named ? named.deviceArgs : cap?.deviceArgs;

    const args = buildExportArgs({
      profile: input.profile,
      startTime: input.startTime,
      endTime: input.endTime,
      vodPath: input.vodPath,
      outputPath: input.outputPath,
      sourceWidth: w,
      sourceHeight: h,
      srtPath: input.srtPath,
      hardwareEncoder: hwEncoder,
      softwareEncoder: forcedEncoder,
      namedEncoder: named ? { encoder: named.encoder, hardware: !named.software } : null,
      deviceArgs,
      escapePath: (p) => this.escapeFilterValue(p),
      captionStyle: (c) => this.captionStyleArgs(c),
    });
    const wantsHardware = args.includes(hwEncoder ?? "\u0000");
    // What actually produced the file. Reported by name, and NOT "wantsHardware": if the hardware
    // run fails and the CPU retry succeeds, claiming hardware would describe a file that does not
    // exist.
    let ranOn = wantsHardware ? hwEncoder! : "cpu";

    try {
      await this.runWithProgress(args, input.onProgress ?? null, input.signal);
    } catch (err) {
      // A cancel is a deliberate act, not a failure: the caller records it as cancelled and deletes
      // the partial file, so this must NOT be retried on the CPU arm — retrying would start the
      // very export the user just stopped.
      if (input.signal?.aborted) throw err;
      // A backend that verified at PROBE time can still fail on the real input (device busy, odd
      // dimensions). Re-encode on the software arm rather than failing the whole export — and
      // blacklist it so the next export does not pay the same failure again.
      if (!wantsHardware || !hwEncoder) throw err;
      // Only reachable when hardware ran, so there is a capability to blacklist; the guard keeps the
      // `named` branch (which skips the probe entirely) honest rather than asserting on a maybe-null.
      if (cap) blacklistGpuBackend(cap.backend);
      console.error(`[ffmpeg] ${hwEncoder} export failed (${err instanceof Error ? err.message : err}) — retrying on CPU`);
      const cpuArgs = buildExportArgs({
        profile: input.profile,
        startTime: input.startTime,
        endTime: input.endTime,
        vodPath: input.vodPath,
        outputPath: input.outputPath,
        sourceWidth: w,
        sourceHeight: h,
        srtPath: input.srtPath,
        hardwareEncoder: null,
        escapePath: (p) => this.escapeFilterValue(p),
        captionStyle: (c) => this.captionStyleArgs(c),
      });
      await this.runWithProgress(cpuArgs, input.onProgress ?? null, input.signal);
      ranOn = "cpu";
    }

    // Verify the output exists and is non-trivial — a silent zero-byte file
    // would be a fake-success by other means.
    const stat = await Deno.stat(input.outputPath);
    if (stat.size < 1024) {
      throw new Error(`Export produced suspiciously small file (${stat.size} bytes)`);
    }
    return {
      exportPath: input.outputPath,
      durationMs: performance.now() - start,
      backend: ranOn,
    };
  }

  /**
   * Generates a proxy proxy (P0-10): 960×540-class H.264, hardware-accelerated
   * when a GPU encoder verifies (nvenc > qsv > vaapi > amf, probed once and
   * cached; cpu libx264 fallback). Hardware encode releases the CPU — the
   * measured 12-core libx264 process became ~2s of core-time on NVENC.
   */
  async generateProxy(input: { vodPath: string; outputPath: string; height: number }): Promise<{ proxyPath: string; durationMs: number; backend: string }> {
    const start = performance.now();
    const cap = await probeGpuEncoderCached();
    const enc = proxyEncodeArgs(cap, input.height);
    const args = [
      "-y",
      ...enc.hwaccelArgs,
      "-i", input.vodPath,
      "-nostats",
      "-vf", enc.vf,
      ...enc.encoderArgs,
      "-c:a", "aac", "-b:a", "96k",
      "-movflags", "+faststart", // stream-ready for the <video> element
      input.outputPath,
    ];
    try {
      await this.run(args);
    } catch (err) {
      // A hardware path that verified at probe time can still fail on the
      // real input (odd dimensions, device busy). Fall back to CPU once
      // rather than failing the whole proxy — detection already finished.
      if (cap.backend !== "cpu") {
        console.error(`[ffmpeg] ${cap.backend} proxy failed (${err instanceof Error ? err.message : err}) — retrying on CPU`);
        const cpuArgs = [
          "-y",
          "-i", input.vodPath,
          "-nostats",
          "-vf", `scale=-2:${input.height}`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
          "-c:a", "aac", "-b:a", "96k",
          "-movflags", "+faststart",
          input.outputPath,
        ];
        await this.run(cpuArgs);
        // Don't trust this backend blindly again — blacklist it so the
        // next proxy run re-probes excluding it (the failure may have been
        // input-specific, but repeated failures would cost ~11s each).
        blacklistGpuBackend(cap.backend);
      } else {
        throw err;
      }
    }
    const stat = await Deno.stat(input.outputPath);
    if (stat.size < 1024) {
      throw new Error(`Proxy produced suspiciously small file (${stat.size} bytes)`);
    }
    return { proxyPath: input.outputPath, durationMs: performance.now() - start, backend: cap.backend };
  }

  /**
   * The source video's own media facts: codec, bitrate, fps and dimensions.
   *
   * ONE probe call rather than four. The export page needs all of it: the dimensions for the geometry
   * and the bitrate estimate, and the CODEC because "use the original bitrate" is only meaningful when
   * the chosen format actually matches the source's — a transcode to a different codec cannot reuse
   * the source's bitrate, which is why the UI forces a bitrate in that case.
   */
  async probeSourceMedia(vodPath: string): Promise<SourceMedia | null> {
    try {
      const out = await run(this.probeBinaryPath, {
        args: ["-v", "quiet", "-print_format", "json", "-show_streams", "-select_streams", "v:0", vodPath],
      });
      const info = JSON.parse(new TextDecoder().decode(out.stdout));
      const s = info.streams?.[0];
      if (!s) return null;
      // `bit_rate` is absent on some containers; the format-level bitrate is the honest fallback and
      // is what "the original bitrate" means to a user looking at a file.
      let kbps: number | null = null;
      if (s.bit_rate) kbps = Math.round(parseInt(String(s.bit_rate), 10) / 1000);
      if (!kbps) {
        try {
          const fmtOut = await run(this.probeBinaryPath, {
            args: ["-v", "quiet", "-print_format", "json", "-show_format", vodPath],
          });
          const fmt = JSON.parse(new TextDecoder().decode(fmtOut.stdout));
          const total = parseInt(String(fmt.format?.bit_rate ?? "0"), 10);
          // The FORMAT bitrate includes audio, so subtract it rather than overstating the video rate.
          const audio = (fmt.streams ?? []).find((x: { codec_type?: string }) => x.codec_type === "audio");
          const audioBps = audio?.bit_rate ? parseInt(String(audio.bit_rate), 10) : 0;
          if (total > 0) kbps = Math.max(0, Math.round((total - audioBps) / 1000));
        } catch {
          // leave null: unmeasured is reported as unmeasured
        }
      }
      const rate = String(s.r_frame_rate ?? "0/1").split("/");
      const fps = rate.length === 2 && Number(rate[1]) > 0
        ? Math.round(Number(rate[0]) / Number(rate[1]))
        : null;
      return {
        codec: String(s.codec_name ?? "") || null,
        bitrateKbps: kbps && kbps > 0 ? kbps : null,
        width: Number(s.width) || null,
        height: Number(s.height) || null,
        fps,
      };
    } catch {
      return null;
    }
  }

  private async probeDimensions(vodPath: string): Promise<[number, number]> {
    const media = await this.probeSourceMedia(vodPath);
    if (media?.width && media?.height) return [media.width, media.height];
    return [1920, 1080];
  }

  async probeDuration(vodPath: string): Promise<number | null> {
    try {
      const out = await run(this.probeBinaryPath, {
        args: ["-v", "quiet", "-print_format", "json", "-show_format", vodPath],
      });
      const info = JSON.parse(new TextDecoder().decode(out.stdout));
      const d = parseFloat(info.format?.duration ?? "0");
      return d > 0 ? d : null;
    } catch {
      return null;
    }
  }

  // ── Filter graph construction ──

  // The argument list is NOT built here any more: it lives in `@/domain/export-profile.ts`, where
  // the profile→args rules are pure and testable without spawning ffmpeg. Only the two
  // adapter-specific bits (escaping, subtitle style) are supplied from here.

  private captionStyleArgs(captions: ExportProfile["captions"]): string {
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


  private escapeFilterValue(path: string): string {
    return path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "\\'");
  }

  /** Spawns ffmpeg, drains stderr (last lines kept for diagnostics), and
   *  resolves on exit. Non-zero exit throws with the last stderr lines attached. */
  private async run(args: string[]): Promise<void> {
    return this.runWithProgress(args, null);
  }

  /**
   * Spawns ffmpeg with real progress reporting and cooperative cancellation.
   *
   * Progress comes from `-progress pipe:1`, NOT from parsing stderr: ffmpeg writes stats to stderr
   * for humans, and the machine-readable stream is the documented interface. `-progress` emits
   * `key=value` blocks on stdout ending in `progress=continue|end`, and `out_time_ms` is the
   * ENCODED position in the output — which is what the bar shows.
   *
   * The previous version of this file claimed in its header to parse `-progress` for export
   * percent. It did not: it passed `-nostats` and sent stdout to the void, so nothing observed the
   * run at all. Stale claims like that are worse than no claim, because they read as a feature.
   *
   * Cancellation kills the child rather than only ignoring its result: ffmpeg writing a partial file
   * for another twenty minutes after a cancel is exactly the defect the download path had, where the
   * backend "still showed progress and chunks being written without ever stopping".
   */
  private async runWithProgress(
    args: string[],
    onProgress: ((p: { encodedSec: number }) => void) | null,
    signal?: AbortSignal,
  ): Promise<void> {
    const child = spawnChild(this.binaryPath, {
      args,
      // Progress must be READ, so stdout is piped whenever anyone is listening. Without a listener
      // it stays null rather than buffering a stream nobody drains.
      stdout: onProgress ? "piped" : "null",
      stderr: "piped",
    });
    const decoder = new TextDecoder();
    let lastStderr: string[] = [];

    // Cancellation: kill the process group, because ffmpeg spawns nothing but a killed parent can
    // leave a partially written file — and the caller deletes it by the path it recorded.
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // Already exited.
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    const stderrLoop = (async () => {
      // The stream is only present when stderr was piped; without this the
      // rolling error tail would throw instead of reporting a failed run.
      const reader = child.stderr?.getReader();
      if (!reader) return;
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

    // `-progress` writes `key=value` lines ending each block with `progress=…`. Accumulate keys
    // until that terminator, then emit one sample: emitting per line would report partial blocks.
    const stdoutLoop = (async () => {
      const reader = child.stdout?.getReader();
      if (!reader || !onProgress) return;
      let buffer = "";
      let outTimeUs: number | null = null;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (value) {
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              const [k, v] = line.trim().split("=");
              if (k === "out_time_us" || k === "out_time_ms") {
                // ffmpeg's `out_time_ms` is MICROSECONDS (a long-standing misnomer); `out_time_us`
                // is the correctly named twin. Both are read, and the value is treated as µs.
                const n = Number(v);
                if (Number.isFinite(n) && n > 0) outTimeUs = n;
              } else if (k === "progress" && outTimeUs !== null) {
                // The ENCODED position in SECONDS, not a percentage: this adapter does not know the
                // clip's window, and inventing a denominator here would be a second owner of the
                // duration the caller already holds. The conversion to a fraction happens there.
                onProgress({ encodedSec: outTimeUs / 1_000_000 });
                if (v === "end") outTimeUs = null;
              }
            }
          }
          if (done) break;
        }
      } catch {
        // stdout closed.
      }
    })();

    const status = await child.status;
    await Promise.all([stderrLoop, stdoutLoop]);
    signal?.removeEventListener("abort", onAbort);

    if (aborted) throw new Error("Export cancelled");
    if (!status.success) {
      const tail = lastStderr.slice(-5).join(" | ");
      throw new Error(`FFmpeg exited ${status.code}${tail ? ` — ${tail}` : ""}`);
    }
  }
}