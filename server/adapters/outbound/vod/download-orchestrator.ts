/**
 * Download orchestrator — runs the import pipeline
 *   chat → markers → scrub (progressive, live) → HQ (capped)
 * and publishes one unified state for the UI via
 *   GET /api/streams/:id/download
 *
 * Progress semantics (docs/DOWNLOAD-PIPELINE.md):
 * - overall.percent is a byte-weighted mean across parts (video parts weight
 *   by BANDWIDTH × totalSec; chat/markers carry tiny fixed weights).
 * - Per-part ETA from a rolling 10s throughput window — total/elapsed lies
 *   badly at the start and after stalls.
 * - Parts fail independently; remaining parts still run. The stream becomes
 *   reviewable as soon as the scrub is complete; waiting for HQ is never
 *   required for review.
 */

import type { StreamMetadataRepository } from "@/application/ports/outbound.ts";
import {
  extractVodId,
  resolveQualities,
  pickScrubQuality,
  pickBestQuality,
  downloadProgressive,
  type HlsQuality,
} from "./hls.ts";
import { downloadChat } from "./chat-fetch.ts";

export type DownloadPartKind = "chat" | "markers" | "scrub" | "hq";
export type DownloadPartStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface DownloadPart {
  kind: DownloadPartKind;
  status: DownloadPartStatus;
  percent: number;
  /** Seconds of video downloaded (video parts). */
  downloadedSec: number;
  totalSec: number;
  etaSec: number | null;
  error?: string;
}

export interface DownloadState {
  phase: "idle" | "running" | "done" | "failed";
  parts: DownloadPart[];
  overall: { percent: number; etaSec: number | null };
  /** Seconds of scrub media playable so far. */
  scrubFrontierSec: number;
  scrubPath: string | null;
  hqPath: string | null;
  /** Path of the fetched chat JSON (progressive part 1). */
  chatPath: string | null;
  chatCount: number;
  qualities: { name: string; width: number; height: number }[];
  startedAt: string | null;
}

interface PartRuntime {
  status: DownloadPartStatus;
  percent: number;
  downloadedSec: number;
  totalSec: number;
  /** Byte weight for the overall mean. */
  weightBytes: number;
  /** Rolling throughput samples: [timestampMs, cumulativeBytes]. */
  samples: [number, number][];
  etaSec: number | null;
  error?: string;
}

const ETA_WINDOW_MS = 10_000;
const ETA_MIN_SPAN_MS = 2_000;

function newPart(): PartRuntime {
  return {
    status: "pending",
    percent: 0,
    downloadedSec: 0,
    totalSec: 0,
    weightBytes: 0,
    samples: [],
    etaSec: null,
  };
}

/** Throughput-based ETA over a rolling window; null until stable. */
function updateEta(part: PartRuntime, cumulativeBytes: number): void {
  const now = performance.now();
  part.samples.push([now, cumulativeBytes]);
  while (part.samples.length > 2 && now - (part.samples[0]?.[0] ?? now) > ETA_WINDOW_MS) {
    part.samples.shift();
  }
  const first = part.samples[0];
  if (!first) return;
  const spanMs = now - first[0];
  if (spanMs < ETA_MIN_SPAN_MS) return;
  const bps = (cumulativeBytes - first[1]) / (spanMs / 1000);
  if (bps <= 0 || part.percent <= 0.001) return;
  // Estimated total from observed throughput vs percent; remaining / bps.
  const remainingBytes = (cumulativeBytes / part.percent) - cumulativeBytes;
  part.etaSec = Math.round(remainingBytes / bps);
}

export class DownloadOrchestrator {
  constructor(private readonly metadata: StreamMetadataRepository) {}

  async getState(streamId: string): Promise<DownloadState> {
    const raw = await this.metadata.get(streamId, "download_state");
    if (!raw) return this.idle();
    try {
      return JSON.parse(raw) as DownloadState;
    } catch {
      return this.idle();
    }
  }

  private idle(): DownloadState {
    return {
      phase: "idle",
      parts: [],
      overall: { percent: 0, etaSec: null },
      scrubFrontierSec: 0,
      scrubPath: null,
      hqPath: null,
      chatPath: null,
      chatCount: 0,
      qualities: [],
      startedAt: null,
    };
  }

  async setState(streamId: string, state: DownloadState): Promise<void> {
    await this.metadata.set(streamId, "download_state", JSON.stringify(state));
  }

  /**
   * Runs the full progressive pipeline. Resolves when every part is terminal
   * (done or failed); live state is readable via getState() throughout.
   * One download per stream at a time — a second run while running throws.
   */
  async run(opts: {
    streamId: string;
    sourceUrl: string;
    destDir: string;
    /** Quality picks are resolved here; includeScrub=false → single download. */
    scrubHeightCap: number;
    maxQualityHeight: number | null;
    includeScrub: boolean;
    signal?: AbortSignal;
  }): Promise<DownloadState> {
    const existing = await this.getState(opts.streamId);
    if (existing.phase === "running") {
      throw new Error("A download is already running for this stream");
    }

    const vodId = extractVodId(opts.sourceUrl);
    if (!vodId) throw new Error(`Not a Twitch VOD URL: ${opts.sourceUrl}`);

    const state: DownloadState = {
      phase: "running",
      parts: [],
      overall: { percent: 0, etaSec: null },
      scrubFrontierSec: 0,
      scrubPath: null,
      hqPath: null,
      chatPath: null,
      chatCount: 0,
      qualities: [],
      startedAt: new Date().toISOString(),
    };
    const rt = new Map<DownloadPartKind, PartRuntime>();
    for (const kind of ["chat", "markers", "scrub", "hq"] as const) {
      rt.set(kind, newPart());
    }
    // Chat/markers are near-instant next to video; tiny fixed weights.
    rt.get("chat")!.weightBytes = 1;
    rt.get("markers")!.weightBytes = 1;

    // ── Part 1: chat (GQL, page-by-page) ──
    rt.get("chat")!.status = "running";
    try {
      const chatPath = `${opts.destDir}/chat.json`;
      const n = await downloadChat(vodId, chatPath, {
        signal: opts.signal,
        onProgress: ({ comments }) => {
          const part = rt.get("chat")!;
          // Percent unknown until done — show pages as pseudo-percent via
          // log scale (chat pages are tiny; the bar mainly proves liveness).
          part.percent = Math.min(0.95, Math.log10(1 + comments) / 4);
          void this.persist(opts.streamId, state, rt);
        },
      });
      rt.get("chat")!.status = "done";
      rt.get("chat")!.percent = 1;
      state.chatPath = chatPath;
      state.chatCount = n;
    } catch (err) {
      if (opts.signal?.aborted) {
        rt.get("chat")!.status = "failed";
        rt.get("chat")!.error = "aborted";
        rt.get("markers")!.status = "skipped";
        rt.get("scrub")!.status = "skipped";
        rt.get("hq")!.status = "skipped";
        return this.finalize(opts.streamId, state, rt);
      }
      // Chat failure doesn't block video — the stream can still be reviewed.
      this.fail(rt.get("chat")!, err);
    }
    await this.persist(opts.streamId, state, rt);

    // ── Part 2: markers (fetched on demand + cached by the API route) ──
    rt.get("markers")!.status = "done";
    rt.get("markers")!.percent = 1;

    // ── Quality resolution (any failure fails both video parts) ──
    let qualities: HlsQuality[] = [];
    try {
      qualities = await resolveQualities(vodId);
      if (qualities.length === 0) throw new Error("usher returned no qualities");
    } catch (err) {
      this.fail(rt.get("scrub")!, err);
      this.fail(rt.get("hq")!, err);
      state.qualities = [];
      return this.finalize(opts.streamId, state, rt);
    }
    state.qualities = qualities.map((q) => ({ name: q.name, width: q.width, height: q.height }));

    const scrub = pickScrubQuality(qualities, opts.scrubHeightCap);
    const hq = pickBestQuality(qualities, opts.maxQualityHeight);

    // ── Single-download case: no scrub opt-in, no scrub pick, or scrub IS
    // already the max quality — one download serves both roles. ──
    if (!opts.includeScrub || !scrub || scrub === hq) {
      const target = scrub ?? hq;
      if (target) {
        try {
          await downloadProgressive(target.playlistUrl, `${opts.destDir}/scrub.ts`, {
            signal: opts.signal ?? undefined,
            onProgress: (p) => {
              const part = rt.get("scrub")!;
              this.noteVideoProgress(part, p, target);
              state.scrubFrontierSec = p.downloadedSec;
              state.scrubPath = `${opts.destDir}/scrub.ts`;
              state.hqPath = `${opts.destDir}/scrub.ts`;
              void this.persist(opts.streamId, state, rt);
            },
          });
          rt.get("scrub")!.status = "done";
          rt.get("scrub")!.percent = 1;
          rt.get("hq")!.status = "done"; // same file serves HQ
          rt.get("hq")!.percent = 1;
        } catch (err) {
          this.fail(rt.get("scrub")!, err);
          this.fail(rt.get("hq")!, err);
        }
      }
      return this.finalize(opts.streamId, state, rt);
    }

    // ── Scrub pass (live, reviewable the moment it completes) ──
    rt.get("scrub")!.status = "running";
    try {
      await downloadProgressive(scrub.playlistUrl, `${opts.destDir}/scrub.ts`, {
        signal: opts.signal ?? undefined,
        onProgress: (p) => {
          const part = rt.get("scrub")!;
          this.noteVideoProgress(part, p, scrub);
          state.scrubFrontierSec = p.downloadedSec;
          state.scrubPath = `${opts.destDir}/scrub.ts`;
          void this.persist(opts.streamId, state, rt);
        },
      });
      rt.get("scrub")!.status = "done";
      rt.get("scrub")!.percent = 1;
    } catch (err) {
      if (opts.signal?.aborted) {
        rt.get("scrub")!.status = "failed";
        rt.get("scrub")!.error = "aborted";
        rt.get("hq")!.status = "skipped"; // cancelled before starting
        await this.persist(opts.streamId, state, rt);
        return this.finalize(opts.streamId, state, rt);
      }
      this.fail(rt.get("scrub")!, err);
      state.scrubPath = null;
    }
    await this.persist(opts.streamId, state, rt);

    // ── HQ pass ──
    if (opts.signal?.aborted) {
      rt.get("hq")!.status = "skipped";
      await this.persist(opts.streamId, state, rt);
      return this.finalize(opts.streamId, state, rt);
    }
    if (hq && hq.name !== scrub.name) {
      rt.get("hq")!.status = "running";
      try {
        await downloadProgressive(hq.playlistUrl, `${opts.destDir}/hq.ts`, {
          signal: opts.signal ?? undefined,
          lookahead: 4,
          onProgress: (p) => {
            const part = rt.get("hq")!;
            this.noteVideoProgress(part, p, hq);
            void this.persist(opts.streamId, state, rt);
          },
        });
        rt.get("hq")!.status = "done";
        rt.get("hq")!.percent = 1;
        state.hqPath = `${opts.destDir}/hq.ts`;
      } catch (err) {
        this.fail(rt.get("hq")!, err);
      }
    } else {
      // Same quality — scrub file is the HQ file.
      rt.get("hq")!.status = "done";
      rt.get("hq")!.percent = 1;
      state.hqPath = state.scrubPath;
    }

    return this.finalize(opts.streamId, state, rt);
  }

  /** Aborts a running download by flagging the state; the running fetches
   *  observe the signal the caller passed to run(). The route layer holds
   *  the AbortController per stream. */
  async markAborted(streamId: string): Promise<void> {
    const state = await this.getState(streamId);
    if (state.phase !== "running") return;
    for (const p of state.parts) {
      if (p.status === "running") {
        p.status = "failed";
        p.error = "aborted";
      }
    }
    state.phase = "failed";
    state.overall.etaSec = null;
    await this.setState(streamId, state);
  }

  private noteVideoProgress(
    part: PartRuntime,
    p: { downloadedSec: number; totalSec: number; bytes: number; percent: number },
    quality: HlsQuality,
  ): void {
    part.downloadedSec = p.downloadedSec;
    part.totalSec = p.totalSec;
    if (part.weightBytes === 0) {
      part.weightBytes = quality.bandwidth * p.totalSec;
    }
    part.percent = p.percent;
    updateEta(part, p.bytes);
  }

  private fail(part: PartRuntime, err: unknown): void {
    part.status = "failed";
    part.error = err instanceof Error ? err.message : String(err);
  }

  private async finalize(
    streamId: string,
    state: DownloadState,
    rt: Map<DownloadPartKind, PartRuntime>,
  ): Promise<DownloadState> {
    const snapshot = this.snapshot(rt);
    state.parts = snapshot.parts;
    state.overall = snapshot.overall;
    state.phase =
      snapshot.parts.every((p) => p.status === "done" || p.status === "skipped")
        ? "done"
        : snapshot.parts.some((p) => p.status === "running")
          ? "running"
          : snapshot.parts.some((p) => p.status === "failed")
            ? "failed"
            : "idle";
    await this.setState(streamId, state);
    return state;
  }

  private snapshot(rt: Map<DownloadPartKind, PartRuntime>): {
    parts: DownloadPart[];
    overall: { percent: number; etaSec: number | null };
  } {
    const parts: DownloadPart[] = [...rt.entries()].map(([kind, p]) => ({
      kind,
      status: p.status,
      percent: p.percent,
      downloadedSec: p.downloadedSec,
      totalSec: p.totalSec,
      etaSec: p.etaSec,
      ...(p.error ? { error: p.error } : {}),
    }));
    let totalWeight = 0;
    let weightedSum = 0;
    for (const [, p] of rt.entries()) {
      if (p.weightBytes > 0) {
        totalWeight += p.weightBytes;
        weightedSum += p.percent * p.weightBytes;
      }
    }
    const runningEtas = parts
      .filter((p) => p.status === "running" && p.etaSec !== null)
      .map((p) => p.etaSec!);
    return {
      parts,
      overall: {
        percent: totalWeight > 0 ? weightedSum / totalWeight : 0,
        etaSec: runningEtas.length > 0 ? Math.max(...runningEtas) : null,
      },
    };
  }

  private async persist(
    streamId: string,
    state: DownloadState,
    rt: Map<DownloadPartKind, PartRuntime>,
  ): Promise<void> {
    const { parts, overall } = this.snapshot(rt);
    await this.setState(streamId, { ...state, parts, overall });
  }
}