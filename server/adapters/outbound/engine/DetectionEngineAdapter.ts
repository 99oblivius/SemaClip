/**
 * DetectionEngine — the real v2 engine as an in-process pipeline runner.
 *
 * Replaces the v1 Python mock (ARCHITECTURE.md §2 stack decision: detection
 * is TypeScript; native runtimes are spawned per stage). Implements the same
 * EnginePort contract as the old PythonEngineAdapter so the job lifecycle is
 * unchanged — but there is no engine subprocess: stages run in-process and
 * emit EngineEvents through the bus (same topics the WS handler forwards).
 *
 * Cancellation is cooperative (AbortSignal checked between chunks/seconds).
 */
import type { EnginePort } from "@/application/ports/outbound.ts";
import { ENGINE_EVENT_TOPIC } from "@/application/ports/outbound.ts";
import type { EventBus } from "@/application/ports/outbound.ts";
import type { EngineCommand, EngineEvent, EnginePhase, Stream } from "shared/types";
import { FFmpegAdapter } from "@/adapters/outbound/ffmpeg/FFmpegAdapter.ts";
import { parseTwitchChatJson } from "../../../../detection/chat.ts";
import { chatFeatures } from "../../../../detection/signals/chat.ts";
import { audioFeatures, applyTranscriptCoverage } from "../../../../detection/signals/audio.ts";
import { computeBaselines } from "../../../../detection/baselines.ts";
import { computeRegimes } from "../../../../detection/segmentation.ts";
import { HypeDetector } from "../../../../detection/axes/hype.ts";
import { ReactionDetector } from "../../../../detection/axes/reaction.ts";
import { runDetection } from "../../../../detection/pipeline.ts";
import type { FeatureTable, TranscriptSegment } from "../../../../detection/types.ts";
import { TranscribeAdapter, type WhisperPaths } from "../transcribe/TranscribeAdapter.ts";
import { toSrt } from "../transcribe/srt.ts";
import { generateUuid } from "@/infrastructure/uuid.ts";

export interface DetectionEngineConfig {
  whisper: WhisperPaths;
  /** ffmpeg binary for audio extraction. */
  ffmpegPath: string;
}

export class DetectionEngineAdapter {
  private bus: EventBus | null = null;
  private abort = new AbortController();
  private running = false;

  constructor(private readonly config: DetectionEngineConfig) {}

  attachBus(bus: EventBus): void {
    this.bus = bus;
  }

  isRunning(): boolean {
    return this.running;
  }

  private emit(event: EngineEvent): void {
    this.bus?.publish(ENGINE_EVENT_TOPIC, event);
  }

  private progress(jobId: string, phase: EnginePhase, percent: number, message?: string): void {
    this.emit({ type: "progress", jobId, phase, percent, ...(message ? { message } : {}) });
  }

  /**
   * Runs the full pipeline for one job. Resolves when complete; the caller
   * (StartJobUseCase's runJob) awaits engine.start() exactly as before.
   */
  async start(command: EngineCommand): Promise<void> {
    if (command.type !== "start") return;
    if (this.running) throw new Error("Engine already running — cancel first");
    this.running = true;
    this.abort = new AbortController();

    const jobId = command.jobId;
    try {
      await this.runPipeline(command, jobId);
    } finally {
      this.running = false;
    }
  }

  async cancel(): Promise<void> {
    this.abort.abort();
  }

  onEvent(handler: (event: EngineEvent) => void): () => void {
    // Events flow through the bus; the port's onEvent is kept for parity.
    if (this.bus === null) {
      // Handlers still work without a bus: wrap them.
      const wrapper = (e: unknown) => handler(e as EngineEvent);
      this.directHandlers.add(wrapper);
      return () => this.directHandlers.delete(wrapper);
    }
    return () => {};
  }

  private directHandlers = new Set<(e: unknown) => void>();

  // ── Pipeline stages ──

  private async runPipeline(command: Extract<EngineCommand, { type: "start" }>, jobId: string): Promise<void> {
    const { vodPath, chatPath } = command;
    const t0 = performance.now();
    /** Measured per-stage wall seconds — emitted in the complete message. */
    const stageTimes: Partial<Record<EnginePhase, number>> = {};
    const stamps = new Map<EnginePhase, number>();
    const beginStage = (p: EnginePhase) => stamps.set(p, performance.now());
    const endStage = (p: EnginePhase) => {
      const s = stamps.get(p);
      if (s !== undefined) stageTimes[p] = (performance.now() - s) / 1000;
    };

    // ── Chat parsing ──
    beginStage("chat_parsing");
    this.emit({ type: "progress", jobId, phase: "chat_parsing", percent: 0.05, message: "Parsing chat…" });
    let parsedChat: ReturnType<typeof parseTwitchChatJson> | null = null;
    if (chatPath) {
      parsedChat = parseTwitchChatJson(await Deno.readTextFile(chatPath));
    }
    const durationSec = parsedChat?.durationSec ?? (await this.probeDuration(vodPath)) ?? 0;
    if (durationSec === 0) {
      this.emit({ type: "error", jobId, phase: "chat_parsing", message: "Cannot determine VOD duration" });
      return;
    }
    this.emit({ type: "progress", jobId, phase: "chat_parsing", percent: 1, message: `${parsedChat?.events.length ?? 0} chat events` });
    endStage("chat_parsing");

    // ── Audio extraction + features ──
    beginStage("audio_extraction");
    this.emit({ type: "progress", jobId, phase: "audio_extraction", percent: 0.05, message: "Extracting audio…" });
    const wavPath = await this.extractAudio(vodPath, this.abort.signal);
    this.emit({ type: "progress", jobId, phase: "audio_extraction", percent: 0.6, message: "Computing per-second features…" });
    const samples = await this.readWavPcm16(wavPath);
    const audio = audioFeatures(samples, 16000);
    // Transcript speech coverage applied after transcription (below).
    this.emit({ type: "progress", jobId, phase: "audio_extraction", percent: 1, message: `${audio.length}s of audio` });
    endStage("audio_extraction");

    // ── Transcription (whisper.cpp, parallel chunks) ──
    beginStage("transcription");
    this.emit({ type: "progress", jobId, phase: "transcription", percent: 0, message: `Transcribing (${command.workers ?? "?"} workers)…` });
    const transcriber = new TranscribeAdapter(this.config.whisper, this.config.ffmpegPath);
    let lastTranscribePct = 0;
    const { segments } = await transcriber.transcribe(vodPath, {
      workers: command.workers ?? Math.min(Math.max(1, (navigator.hardwareConcurrency ?? 4) >> 1), 8),
      signal: this.abort.signal,
      onProgress: (f) => {
        const pct = Math.floor(f * 100);
        if (pct > lastTranscribePct) {
          lastTranscribePct = pct;
          this.emit({ type: "progress", jobId, phase: "transcription", percent: f, message: `Transcribing… ${pct}%` });
        }
      },
    });
    applyTranscriptCoverage(audio, segments as TranscriptSegment[]);

    // Transcript SRT sidecar — the honest caption path (ExportClipUseCase
    // refuses captions without this artifact). Written to the stream's
    // artifact dir; the use-case layer registers it in stream_metadata.
    let srtPath: string | null = null;
    if (segments.length > 0 && command.artifactDir) {
      srtPath = `${command.artifactDir}/transcript.srt`;
      await Deno.writeTextFile(srtPath, toSrt(segments as TranscriptSegment[]));
      this.emit({ type: "progress", jobId, phase: "transcription", percent: 1, message: `Transcript: ${segments.length} segments` });
    }
    endStage("transcription");

    // ── Segmentation + scoring (array math) ──
    beginStage("segmentation");
    this.emit({ type: "progress", jobId, phase: "segmentation", percent: 0.5, message: "Computing baselines…" });
    const chat = chatFeatures(parsedChat?.events ?? [], durationSec);
    const features: FeatureTable = { durationSec, chat, audio, transcript: segments };
    const E = new Float32Array(durationSec);
    for (let s = 0; s < durationSec; s++) {
      const c = chat[s];
      const a = audio[s];
      E[s] = (c ? Math.min(1, c.velocity / 10) + 1.4 * Math.min(1, c.emoteDensity / 8) + 0.5 * c.capsRatio : 0)
        + 0.6 * Math.min(1, (a?.rms ?? 0) * 3);
    }
    const baselines = computeBaselines(E, durationSec, { localWindowSec: 300, outlierK: 3, minSpread: 0.02 });
    const regimes = computeRegimes(chat.length > 0 ? chat : null, audio, E, durationSec);
    this.emit({ type: "progress", jobId, phase: "segmentation", percent: 0.75, message: `${regimes.length} regimes` });
    for (const r of regimes) {
      this.emit({ type: "segment", jobId, start: r.start, end: r.end, regime: r.type });
    }
    this.emit({ type: "progress", jobId, phase: "segmentation", percent: 1 });
    endStage("segmentation");

    // ── Axis scoring ──
    beginStage("axis_scoring");
    this.emit({ type: "progress", jobId, phase: "axis_scoring", percent: 0.5 });
    const candidates = runDetection(features, baselines, regimes, [new HypeDetector(), new ReactionDetector()], {
      maxClips: command.config.maxClips ?? 50,
      minSlotsPerAxis: 1,
    });
    this.emit({ type: "progress", jobId, phase: "axis_scoring", percent: 1 });
    endStage("axis_scoring");

    // ── Endpoint resolution (Phase 1: axis cap only) ──
    this.emit({ type: "progress", jobId, phase: "endpoint_resolution", percent: 1 });

    // ── Emit clips (ordered by score desc → rank) ──
    const ranked = [...candidates].sort((a, b) => b.score - a.score);
    for (const [i, c] of ranked.entries()) {
      this.emit({
        type: "clip",
        jobId,
        id: generateUuid(),
        axis: c.axis as "hype",
        start: c.start,
        end: c.end,
        peak: c.peak,
        score: c.score,
        justification: c.justification,
        signals: c.signals,
      });
    }

    // ── Proxy generation (P0-10): proxy media, generated post-detection so
    // it never delays candidate discovery. Failure is non-fatal — the video
    // route falls back to the source VOD. ──
    // Proxy can take minutes on a 5.8h VOD with zero events otherwise — the
    // 300s job watchdog killed a healthy run here (2026-09-09). Heartbeat
    // keeps the watchdog fed while ffmpeg churns.
    const heartbeat = setInterval(() => {
      this.emit({ type: "progress", jobId, phase: "proxy_generation", percent: 0.5, message: "Generating proxy proxy…" });
    }, 30_000);
    try {
      const proxyPath = `${command.artifactDir}/proxy.mp4`;
      const ffmpeg = new FFmpegAdapter(this.config.ffmpegPath);
      await ffmpeg.generateProxy({ vodPath, outputPath: proxyPath, height: 540 });
      this.emit({ type: "progress", jobId, phase: "proxy_generation", percent: 1, message: "Proxy ready (540p)" });
    } catch (err) {
      console.error(`[engine] proxy generation failed (non-fatal):`, err);
      this.emit({ type: "progress", jobId, phase: "proxy_generation", percent: 1, message: "Proxy generation failed — using full-res" });
    } finally {
      clearInterval(heartbeat);
    }

    this.emit({ type: "complete", jobId, clipsFound: ranked.length });
    const total = ((performance.now() - t0) / 1000).toFixed(1);
    const timings = Object.entries(stageTimes).map(([p, s]) => `${p}=${s!.toFixed(1)}s`).join(", ");
    console.log(`[engine] job ${jobId} complete: ${ranked.length} clips in ${total}s — ${timings}`);
    // Complete message carries the timing summary in the message field (the
    // Processing screen reads it verbatim — the budget is user-visible).
    this.emit({
      type: "progress",
      jobId,
      phase: "endpoint_resolution",
      percent: 1,
      message: `Done in ${total}s (${timings})`,
    });
  }

  private async probeDuration(vodPath: string): Promise<number | null> {
    try {
      const cmd = new Deno.Command("ffprobe", {
        args: ["-v", "quiet", "-print_format", "json", "-show_format", vodPath],
        stdout: "piped", stderr: "null",
      });
      const out = await cmd.output();
      const info = JSON.parse(new TextDecoder().decode(out.stdout));
      const d = parseFloat(info.format?.duration ?? "0");
      return d > 0 ? d : null;
    } catch {
      return null;
    }
  }

  private async extractAudio(vodPath: string, signal: AbortSignal): Promise<string> {
    const out = await Deno.makeTempFile({ prefix: "semaclip-engine-audio-", suffix: ".wav" });
    const cmd = new Deno.Command(this.config.ffmpegPath, {
      args: ["-y", "-i", vodPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", out],
      stdout: "null", stderr: "null",
    });
    const child = cmd.spawn();
    const onAbort = () => { try { child.kill(); } catch { /* ok */ } };
    signal.addEventListener("abort", onAbort, { once: true });
    const status = await child.status;
    signal.removeEventListener("abort", onAbort);
    if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
    if (!status.success) throw new Error(`ffmpeg audio extraction failed (${status.code})`);
    return out;
  }

  private async readWavPcm16(path: string): Promise<Int16Array> {
    const raw = await Deno.readFile(path);
    const dec = new TextDecoder();
    let dataOff = 44;
    for (let i = 12; i < Math.min(200, raw.byteLength - 8); i++) {
      if (dec.decode(raw.slice(i, i + 4)) === "data") { dataOff = i + 8; break; }
    }
    // Int16Array requires an even byteOffset; also guard a truncated header.
    if (dataOff % 2 !== 0) dataOff += 1;
    const avail = raw.byteLength - dataOff;
    if (avail < 2) throw new Error(`WAV has no PCM data: ${path}`);
    return new Int16Array(raw.buffer, dataOff, Math.floor(avail / 2));
  }
}