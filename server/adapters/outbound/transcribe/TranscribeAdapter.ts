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
   * Full transcription of a VOD. Returns segments with VOD-absolute times.
   */
  async transcribe(
    vodPath: string,
    opts: TranscribeOptions = {},
  ): Promise<{ segments: TranscriptSegment[]; totalMs: number; workers: number }> {
    const totalStart = performance.now();
    const workers = opts.workers ?? Math.min(Math.max(1, (navigator.hardwareConcurrency ?? 4) >> 1), 8);

    // 1. Extract 16kHz mono WAV.
    const wavPath = await this.extractAudio(vodPath);

    // 2. VAD → speech regions.
    const speech = await this.speechSegments(wavPath);
    console.log(`[transcribe] VAD: ${speech.length} speech regions, ${speech.reduce((a, s) => a + (s.end - s.start), 0).toFixed(0)}s of speech`);

    // 3. Chunk speech regions (30-120s targets, 2s tail pad).
    const chunks = this.chunkSpeech(speech, 120, 2);

    // 4. Parallel workers.
    const results = await this.runChunks(wavPath, chunks, workers, opts);

    // 5. Merge (offset-corrected, sorted).
    const segments = results
      .flatMap((r) => r.segments.map((s) => ({ start: s.start + r.offset, end: s.end + r.offset, text: s.text })))
      .sort((a, b) => a.start - b.start);

    return { segments, totalMs: performance.now() - totalStart, workers };
  }

  private async extractAudio(vodPath: string): Promise<string> {
    const out = await Deno.makeTempFile({ prefix: "semaclip-audio-", suffix: ".wav" });
    const cmd = new Deno.Command(this.ffmpegPath, {
      args: ["-y", "-i", vodPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
      stdout: "null",
      stderr: "null",
    });
    const status = await cmd.spawn().status;
    if (!status.success) throw new Error(`ffmpeg audio extraction failed (${status.code})`);
    return out;
  }

  private async speechSegments(wavPath: string): Promise<Array<{ start: number; end: number }>> {
    const vadBin = `${this.paths.binDir}/whisper-vad-speech-segments`;
    const vadModel = `${this.paths.modelsDir}/${this.paths.vadModelFile}`;
    const cmd = new Deno.Command(vadBin, {
      args: ["-vm", vadModel, "-f", wavPath],
      stdout: "piped",
      stderr: "null",
      env: { LD_LIBRARY_PATH: this.paths.binDir },
    });
    const out = await cmd.output();
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

    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= chunks.length) return;
        if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const chunk = chunks[i]!;
        const started = performance.now();
        const segments = await this.transcribeChunk(wavPath, chunk);
        results.push({ offset: chunk.start, segments, elapsedMs: performance.now() - started });
        done++;
        opts.onProgress?.(done / chunks.length);
      }
    };

    await Promise.all(Array.from({ length: Math.min(workers, chunks.length) }, worker));
    return results;
  }

  private async transcribeChunk(
    wavPath: string,
    chunk: { start: number; end: number },
  ): Promise<TranscriptSegment[]> {
    const cli = `${this.paths.binDir}/whisper-cli`;
    const model = `${this.paths.modelsDir}/${this.paths.modelFile}`;
    const cmd = new Deno.Command(cli, {
      args: [
        "-m", model,
        "-f", wavPath,
        // Default output = timestamped lines on stdout: "[00:00:02.000 --> 00:00:10.400] text".
        // (-otxt strips timestamps — unusable for segment extraction.)
        "-np", // no prints
        "-ot", String(Math.round(chunk.start * 1000)), // offset-t: milliseconds
        "-d", String(Math.round((chunk.end - chunk.start) * 1000)), // duration: milliseconds
      ],
      stdout: "piped",
      stderr: "null",
      env: { LD_LIBRARY_PATH: this.paths.binDir },
    });
    const out = await cmd.output();
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