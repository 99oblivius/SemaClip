/**
 * TranscribeAdapter — bundled whisper.cpp integration.
 *
 * Pipeline (ARCHITECTURE.md §4.2):
 *   1. ffmpeg: VOD → 16kHz mono WAV (full duration, one pass)
 *   2. whisper-vad-speech-segments: speech regions (silero VAD)
 *   3. chunk the speech regions into 30-120s segments with 2s overlap
 *   4. N parallel whisper-cli workers transcribe chunks (N = min(cores÷2, 8))
 *   5. merge chunk transcripts into a global segment list (sorted, deduped)
 *
 * All binaries come from the bundled native/ tree (fetched by release CI);
 * nothing relies on system-installed packages.
 */
import type { TranscriptSegment } from "../../../../detection/types.ts";
import { memoryCappedWorkers } from "@/application/use-cases/SettingsUseCase.ts";
import { run, runStatus, spawnChild } from "@/adapters/outbound/process/spawn.ts";

export interface WhisperPaths {
  /** Directory containing whisper-cli + whisper-vad-speech-segments (+ libs). */
  binDir: string;
  /** Directory containing ggml model files. */
  modelsDir: string;
  /** Whisper model filename (tier-selected by the manifest). */
  modelFile: string;
  /** VAD model filename. */
  vadModelFile: string;
}

export interface TranscribeOptions {
  /** Worker process count. Default: min(cores÷2, 8). */
  workers?: number;
  /** Progress callback (0-1 overall). */
  onProgress?: (fraction: number) => void;
  /** Abort signal — checked between chunk dispatches. */
  signal?: AbortSignal;
}

export interface ChunkResult {
  /** Offset of the chunk in the VOD (seconds). */
  offset: number;
  segments: TranscriptSegment[];
  elapsedMs: number;
}

export class TranscribeAdapter {
  constructor(
    private readonly paths: WhisperPaths,
    private readonly ffmpegPath = "ffmpeg",
    private readonly ffprobePath = "ffprobe",
  ) {}

  /**
   * CPU-tier worker count clamped by a host memory budget. Per-worker RSS
   * estimate: model file + whisper context/compute state (~4× model for
   * base-class models) + the ≤120s decoded slice (~15MB float32).
   */
  private async resolveWorkers(requested?: number): Promise<number> {
    const byCpu = requested ?? Math.min(Math.max(1, (navigator.hardwareConcurrency ?? 4) >> 1), 8);
    const modelBytes = await Deno.stat(`${this.paths.modelsDir}/${this.paths.modelFile}`)
      .then((s) => s.size).catch(() => 0);
    if (modelBytes === 0) return byCpu;
    const perWorker = modelBytes * 5 + 15 * 1024 * 1024;
    let totalMem = 8 * 1024 * 1024 * 1024; // conservative fallback
    try {
      const mem = new TextDecoder().decode(await Deno.readFile("/proc/meminfo"));
      const m = /MemTotal:\s+(\d+) kB/.exec(mem);
      if (m) totalMem = parseInt(m[1]!, 10) * 1024;
    } catch {
      // non-Linux (Windows): keep the fallback
    }
    const capped = memoryCappedWorkers(byCpu, totalMem, perWorker);
    if (capped < byCpu) {
      console.log(`[transcribe] workers ${byCpu} → ${capped} (memory cap: ${Math.round(perWorker / 1024 / 1024)}MB/worker)`);
    }
    return capped;
  }

  /**
   * Full transcription of a VOD. Returns segments with VOD-absolute times.
   */
  async transcribe(
    vodPath: string,
    opts: TranscribeOptions = {},
  ): Promise<{ segments: TranscriptSegment[]; totalMs: number; workers: number }> {
    const totalStart = performance.now();
    const workers = await this.resolveWorkers(opts.workers);

    // 1. Extract 16kHz mono WAV.
    const wavPath = await this.extractAudio(vodPath);

    // 2. VAD → speech regions.
    const speech = await this.speechSegments(wavPath);
    console.log(`[transcribe] VAD: ${speech.length} speech regions, ${speech.reduce((a, s) => a + (s.end - s.start), 0).toFixed(0)}s of speech`);

    // 3. Chunk speech regions (30-120s targets, 2s tail pad).
    const chunks = this.chunkSpeech(speech, 120, 2);

    // 4. Slice the WAV per chunk (each worker reads only its slice — pointing
    //    every worker at the full file made whisper-cli decode ~1.8GB of PCM
    //    per process; 16 workers paged the machine). Slicing is cheap: ffmpeg
    //    -ss/-t copy on pcm_s16le. Chunks are sliced lazily in runChunks so
    //    at most `workers` slice files exist at once, each ≤ 120s ≈ 3.8MB.
    // 5. Parallel workers (memory-capped).
    const results = await this.runChunks(wavPath, chunks, workers, opts);

    // 6. Merge (offset-corrected, sorted).
    const segments = results
      .flatMap((r) => r.segments.map((s) => ({ start: s.start + r.offset, end: s.end + r.offset, text: s.text })))
      .sort((a, b) => a.start - b.start);

    return { segments, totalMs: performance.now() - totalStart, workers };
  }

  private async extractAudio(vodPath: string): Promise<string> {
    const out = await Deno.makeTempFile({ prefix: "semaclip-audio-", suffix: ".wav" });
    const status = await runStatus(this.ffmpegPath, {
      args: ["-y", "-i", vodPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
    });
    if (!status.success) throw new Error(`ffmpeg audio extraction failed (${status.code})`);
    return out;
  }

  private async speechSegments(wavPath: string): Promise<Array<{ start: number; end: number }>> {
    const vadBin = `${this.paths.binDir}/whisper-vad-speech-segments${Deno.build.os === "windows" ? ".exe" : ""}`;
    const vadModel = `${this.paths.modelsDir}/${this.paths.vadModelFile}`;
    const out = await run(vadBin, {
      args: ["-vm", vadModel, "-f", wavPath],
      env: Deno.build.os === "windows"
        ? {}
        : { LD_LIBRARY_PATH: this.paths.binDir },
    });
    if (!out.success) throw new Error(`VAD failed (${out.code})`);
    // stdout format: "Speech segment N: start = 29.00, end = 221.00" —
    // values are CENTISECONDS (221.00 = 2.21s). Diagnostics go to stderr.
    const text = new TextDecoder().decode(out.stdout);
    const segments: Array<{ start: number; end: number }> = [];
    const re = /Speech segment \d+: start = ([\d.]+), end = ([\d.]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      segments.push({ start: parseFloat(m[1]!) / 100, end: parseFloat(m[2]!) / 100 });
    }
    if (segments.length === 0) {
      throw new Error("VAD produced no speech segments (unexpected output format)");
    }
    return segments;
  }

  /** Split speech regions into whisper-sized chunks: target ≤ maxChunkSec,
   *  merging adjacent regions with gaps < gapMergeSec. */
  private chunkSpeech(
    speech: Array<{ start: number; end: number }>,
    maxChunkSec: number,
    gapMergeSec: number,
  ): Array<{ start: number; end: number }> {
    const chunks: Array<{ start: number; end: number }> = [];
    let cur: { start: number; end: number } | null = null;
    for (const seg of speech) {
      if (cur && seg.start - cur.end <= gapMergeSec && (seg.end - cur.start) <= maxChunkSec) {
        cur.end = seg.end;
      } else {
        if (cur) chunks.push(cur);
        // A single region longer than max is split.
        if (seg.end - seg.start > maxChunkSec) {
          let s = seg.start;
          while (s < seg.end) {
            chunks.push({ start: s, end: Math.min(seg.end, s + maxChunkSec) });
            s += maxChunkSec;
          }
          cur = null;
        } else {
          cur = { ...seg };
        }
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  private async runChunks(
    wavPath: string,
    chunks: Array<{ start: number; end: number }>,
    workers: number,
    opts: TranscribeOptions,
  ): Promise<ChunkResult[]> {
    const results: ChunkResult[] = [];
    let next = 0;
    let done = 0;
    // Slice-file registry for cleanup: slices are created lazily per chunk
    // and removed once their result is collected.
    const slicePaths = new Map<number, string>();

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= chunks.length) return;
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const chunk = chunks[i]!;
        const started = performance.now();
        // Slice this chunk's audio: whisper-cli then decodes ≤120s of PCM
        // (~3.8MB) instead of the full VOD (~1.8GB float32).
        const slicePath = await this.sliceWav(wavPath, chunk, i);
        slicePaths.set(i, slicePath);
        try {
          const segments = await this.transcribeChunk(slicePath, { start: 0, end: chunk.end - chunk.start }, opts.signal);
          results.push({ offset: chunk.start, segments, elapsedMs: performance.now() - started });
          done++;
          opts.onProgress?.(done / chunks.length);
        } finally {
          slicePaths.delete(i);
          await Deno.remove(slicePath).catch(() => {}); // free the slice promptly
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(workers, chunks.length) }, worker));
    } finally {
      // Abort/failure mid-run: remove any slice files still on disk.
      for (const p of slicePaths.values()) await Deno.remove(p).catch(() => {});
    }
    return results;
  }

  /** Extract chunk [start, end) from the source WAV into a small slice file.
   *  pcm_s16le copy: sample-accurate seek on plain PCM, no re-encode. */
  private async sliceWav(
    wavPath: string,
    chunk: { start: number; end: number },
    index: number,
  ): Promise<string> {
    const out = await Deno.makeTempFile({ prefix: `semaclip-slice-${index}-`, suffix: ".wav" });
    const cmd = spawnChild(this.ffmpegPath, {
      args: [
        "-y", "-i", wavPath,
        "-ss", String(chunk.start), "-t", String(chunk.end - chunk.start),
        "-c", "copy", out,
      ],
    });
    const status = await cmd.status;
    if (!status.success) {
      await Deno.remove(out).catch(() => {});
      throw new Error(`WAV slice failed (${status.code}) on chunk ${chunk.start}-${chunk.end}`);
    }
    return out;
  }

  private async transcribeChunk(
    wavPath: string,
    chunk: { start: number; end: number },
    signal?: AbortSignal | undefined,
  ): Promise<TranscriptSegment[]> {
    const cli = `${this.paths.binDir}/whisper-cli${Deno.build.os === "windows" ? ".exe" : ""}`;
    const model = `${this.paths.modelsDir}/${this.paths.modelFile}`;
    const out = await run(cli, {
      signal,
      args: [
        "-m", model,
        "-f", wavPath,
        // Default output = timestamped lines on stdout: "[00:00:02.000 --> 00:00:10.400] text".
        // (-otxt strips timestamps — unusable for segment extraction.)
        // The wav is pre-sliced to the chunk, so no -ot/-d windowing needed
        // (kept for parity if a caller passes an unsliced path).
        "-np", // no prints
        "-ot", String(Math.round(chunk.start * 1000)), // offset-t: milliseconds
        "-d", String(Math.round((chunk.end - chunk.start) * 1000)), // duration: milliseconds
      ],
      stdout: "piped",
      stderr: "null",
      env: Deno.build.os === "windows"
        ? {}
        : { LD_LIBRARY_PATH: this.paths.binDir },
    });
    // Cancel still kills in-flight whisper processes: run() receives the signal,
    // so an abort terminates the child rather than leaving 2GB+ of RSS alive after
    // the job settled (the 2026-09-09 incident). The result reports the failure.
    if (!out.success) throw new Error(`whisper-cli failed (${out.code}) on chunk ${chunk.start}-${chunk.end}`);
    return this.parseWhisperTxt(new TextDecoder().decode(out.stdout));
  }

  /** Parses whisper-cli txt output lines: "[00:00:00.000 --> 00:00:11.000] text" */
  parseWhisperTxt(output: string): TranscriptSegment[] {
    const segments: TranscriptSegment[] = [];
    const re = /\[(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})\]\s*(.*)/;
    for (const line of output.split("\n")) {
      const m = line.match(re);
      if (!m) continue;
      const start = hmsToSec(m[1]!, m[2]!, m[3]!, m[4]!);
      const end = hmsToSec(m[5]!, m[6]!, m[7]!, m[8]!);
      const text = m[9]!.trim();
      if (text) segments.push({ start, end, text });
    }
    return segments;
  }
}

function hmsToSec(h: string, m: string, s: string, ms: string): number {
  return parseInt(h, 10) * 3600 + parseInt(m, 10) * 60 + parseInt(s, 10) + parseInt(ms, 10) / 1000;
}