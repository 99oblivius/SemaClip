/**
 * Download orchestrator — runs the import pipeline
 *   chat → markers → proxy (progressive, live) → HQ (capped)
 * and publishes one unified state for the UI via
 *   GET /api/streams/:id/download
 *
 * Progress semantics (docs/DOWNLOAD-PIPELINE.md):
 * - overall.percent is a byte-weighted mean across parts (video parts weight
 *   by BANDWIDTH × totalSec; chat/markers carry tiny fixed weights).
 * - Per-part ETA from a rolling 10s throughput window — total/elapsed lies
 *   badly at the start and after stalls.
 * - Parts fail independently; remaining parts still run. The stream becomes
 *   reviewable as soon as the proxy is complete; waiting for HQ is never
 *   required for review.
 */

import type { StreamMetadataRepository } from "@/application/ports/outbound.ts";
import {
  extractVodId,
  resolveQualities,
  pickProxyQuality,
  pickBestQuality,
  downloadProgressive,
  type HlsQuality,
} from "./hls.ts";
import { downloadChat } from "./chat-fetch.ts";
import { remuxToMp4, mp4Twin } from "./remux.ts";

export type DownloadPartKind = "chat" | "markers" | "proxy" | "hq";
export type DownloadPartStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface DownloadPart {
  kind: DownloadPartKind;
  status: DownloadPartStatus;
  percent: number;
  /** Seconds of video downloaded (video parts). */
  downloadedSec: number;
  totalSec: number;
  /** Bytes of the artifact on disk so far (chat: comments fetched). */
  downloadedBytes: number;
  etaSec: number | null;
  error?: string;
}

export interface DownloadState {
  phase: "idle" | "running" | "done" | "failed";
  parts: DownloadPart[];
  overall: { percent: number; etaSec: number | null };
  /** Seconds of proxy media playable so far. */
  proxyFrontierSec: number;
  proxyPath: string | null;
  hqPath: string | null;
  /** Playable mp4 twins of the .ts files (Chromium can't demux raw TS). */
  proxyMp4: string | null;
  hqMp4: string | null;
  /** Path of the fetched chat JSON (progressive part 1). */
  chatPath: string | null;
  chatCount: number;
  qualities: { name: string; width: number; height: number }[];
  startedAt: string | null;
  /** Disk truth per artifact, computed fresh on every read — never
   *  persisted (this field is the "on disk / size" source of truth). */
  presence?: Partial<Record<"proxy" | "hq" | "chat", Artifact>>;
}

/** One artifact: the primary file (.ts or the playable mp4) it represents. */
export interface Artifact {
  onDisk: boolean;
  bytes: number;
  path: string | null;
}

interface PartRuntime {
  status: DownloadPartStatus;
  percent: number;
  downloadedSec: number;
  totalSec: number;
  /** Bytes of the artifact so far (chat: comments fetched). */
  downloadedBytes: number;
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
    downloadedBytes: 0,
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

  /** Streams with an orchestrator run in THIS process — reconcile() must
   *  not touch their running phase (orphaned vs live distinction). */
  private liveRuns = new Set<string>();

  /** Mark/unmark a stream's orchestrator run as live (run()/piece runners). */
  markRunLive(streamId: string, live: boolean): void {
    if (live) this.liveRuns.add(streamId);
    else this.liveRuns.delete(streamId);
  }

  async getState(streamId: string): Promise<DownloadState> {
    const raw = await this.metadata.get(streamId, "download_state");
    if (!raw) return this.idle();
    try {
      const parsed = JSON.parse(raw) as DownloadState & {
        scrubPath?: string | null;
        scrubMp4?: string | null;
        scrubFrontierSec?: number;
      };
      // Pre-rename states stored scrub* keys and scrub.ts artifacts — map
      // them onto the proxy names so existing projects keep playing.
      const state: DownloadState = {
        ...parsed,
        proxyPath: parsed.proxyPath ?? parsed.scrubPath ?? null,
        proxyMp4: parsed.proxyMp4 ?? parsed.scrubMp4 ?? null,
        proxyFrontierSec: parsed.proxyFrontierSec ?? parsed.scrubFrontierSec ?? 0,
      };
      delete (state as unknown as Record<string, unknown>).scrubPath;
      delete (state as unknown as Record<string, unknown>).scrubMp4;
      delete (state as unknown as Record<string, unknown>).scrubFrontierSec;
      const reconciled = await this.reconcile(streamId, state);
      reconciled.presence = await this.presence(reconciled);
      return reconciled;
    } catch {
      return this.idle();
    }
  }

  /**
   * Reconcile the persisted state against disk — the state must describe
   * reality, never claim it (user-reported: HQ "on disk" with no file,
   * blank 0% containers from orphaned states). Read-mostly: only a
   * mismatch triggers a write-back.
   */
  private async reconcile(streamId: string, state: DownloadState): Promise<DownloadState> {
    const exists = (p: string | null): Promise<boolean> =>
      p ? Deno.stat(p).then(() => true).catch(() => false) : Promise.resolve(false);

    let changed = false;
    // Paths that no longer exist on disk are dropped from the state — the
    // file may have been deleted/moved externally; the record must follow.
    for (const key of ["proxyPath", "proxyMp4", "hqPath", "hqMp4", "chatPath"] as const) {
      if (state[key] && !(await exists(state[key]))) {
        state = { ...state, [key]: null };
        changed = true;
      }
    }

    // A "running" phase belongs to this process only — a crash/restart
    // leaves nothing holding the run; orphaned running states become
    // failed with resume available. A LIVE run (this process) is untouched.
    if (state.phase === "running" && !this.liveRuns.has(streamId)) {
      state = {
        ...state,
        phase: "failed",
        parts: state.parts.map((p) =>
          p.status === "running" ? { ...p, status: "failed", error: "interrupted (server restart)" } : p,
        ),
        overall: { ...state.overall, etaSec: null },
      };
      changed = true;
    }

    // An idle/failed state with a playable twin is a real download —
    // hydrate the phase so the player/library reflect it.
    if ((state.phase === "idle" || state.phase === "failed") &&
        (state.proxyPath || state.hqPath) &&
        (state.proxyMp4 || state.hqMp4)) {
      state = { ...state, phase: "done" };
      changed = true;
    }

    // Post-completion storage hygiene for states that finished before the
    // cleanup existed: a done phase with a playable twin still referencing
    // a .ts means the raw file + chunk map are dead weight — same drop as
    // finalize().
    if (state.phase === "done") {
      for (const [tsKey, twinKey] of [["proxyPath", "proxyMp4"], ["hqPath", "hqMp4"]] as const) {
        const tsPath = state[tsKey];
        const twinPath = state[twinKey];
        if (tsPath && twinPath && tsPath.endsWith(".ts") && twinPath !== tsPath
            && await exists(twinPath)) {
          for (const victim of [tsPath, tsPath.replace(/\.ts$/, ".chunks")]) {
            await Deno.remove(victim).catch(() => {});
          }
          state = { ...state, [tsKey]: twinPath };
          changed = true;
        }
      }
    }

    // Nothing on disk at all → the state is a husk (blank 0% containers).
    if (!state.proxyPath && !state.hqPath && !state.proxyMp4 && !state.hqMp4 &&
        !state.chatPath && state.phase !== "running") {
      state = this.idle();
      changed = true;
    }

    if (changed) await this.setState(streamId, state);
    return state;
  }

  /** Disk truth per artifact: primary file = the playable mp4 when
   *  present, else the raw .ts; bytes from stat, never from the state. */
  private async presence(state: DownloadState): Promise<NonNullable<DownloadState["presence"]>> {
    const statOne = async (p: string | null): Promise<Artifact> => {
      if (!p) return { onDisk: false, bytes: 0, path: null };
      try {
        const st = await Deno.stat(p);
        return { onDisk: true, bytes: st.size, path: p };
      } catch {
        return { onDisk: false, bytes: 0, path: p };
      }
    };
    // Prefer the playable mp4 twin as the artifact identity — that's what
    // "on disk" means for playback; the .ts is its source.
    const pick = async (ts: string | null, mp4: string | null, kind: "proxy" | "hq"): Promise<Artifact> => {
      // A playable twin is unambiguous disk truth. A raw .ts without a twin
      // is only "on disk" when its part is NOT running — a growing .ts is a
      // download in progress, not a usable artifact (user-reported: manual
      // downloads instantly reading "on disk" with a checkmark).
      if (mp4) return statOne(mp4);
      const art = await statOne(ts);
      const part = state.parts.find((x) => x.kind === kind);
      if (part?.status === "running") return { onDisk: false, bytes: art.bytes, path: art.path };
      return art;
    };
    const chatPath = state.chatPath;
    return {
      proxy: await pick(state.proxyPath, state.proxyMp4, "proxy"),
      hq: await pick(state.hqPath, state.hqMp4, "hq"),
      chat: await statOne(chatPath),
    };
  }


  /**
   * Start a single-part download (manual piece) — the manager's public API
   * for targeted re-downloads from project settings. Video pieces carry an
   * explicit quality; chat pieces fetch GQL page-by-page. Live-run marked,
   * abortable, throttled-persisted, twin-remuxed — identical plumbing to
   * run()'s passes, without duplicating it in use-cases.
   */
  async startPiece(opts: {
    streamId: string;
    destDir: string;
    kind: "proxy" | "hq" | "chat";
    vodId: string;
    quality?: HlsQuality | undefined;   // video pieces
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const live = this.liveRuns.has(opts.streamId);
    if (live) throw new Error("A download is already running for this stream");
    this.markRunLive(opts.streamId, true);
    if (opts.kind === "chat") {
      await this.runChatPiece({ streamId: opts.streamId, destDir: opts.destDir, vodId: opts.vodId, signal: opts.signal });
    } else {
      await this.runVideoPiece({
        streamId: opts.streamId,
        destDir: opts.destDir,
        kind: opts.kind,
        quality: opts.quality!,
        signal: opts.signal,
      });
    }
  }

  /** Canonical 4-part skeleton — every state write carries all parts so UI
   *  rows never depend on a parts array that may be empty after reconcile. */
  private ensureParts(state: DownloadState): Map<DownloadPartKind, PartRuntime> {
    const rt = new Map<DownloadPartKind, PartRuntime>();
    for (const kind of ["chat", "markers", "proxy", "hq"] as const) {
      const persisted = state.parts.find((p) => p.kind === kind);
      const part = persisted
        ? { ...newPart(), ...persisted }
        : newPart();
      rt.set(kind, part);
    }
    rt.get("chat")!.weightBytes = 1;
    rt.get("markers")!.weightBytes = 1;
    return rt;
  }

  /** Generic single-part video executor: chunk map + throttled persist +
   *  periodic twin remux + honest completion. One body for proxy and HQ. */
  private async runVideoPiece(opts: {
    streamId: string;
    destDir: string;
    kind: "proxy" | "hq";
    quality: HlsQuality;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const { kind } = opts;
    const tsPath = `${opts.destDir}/${kind}.ts`;
    const controller = new AbortController();
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const started = await this.getState(opts.streamId);
    const rt = this.ensureParts(started);
    const part = rt.get(kind)!;
    part.status = "running";
    part.percent = 0;
    delete (part as Partial<PartRuntime>).error;
    await this.persist(opts.streamId, started, rt);

    const mapPath = `${opts.destDir}/${kind}.chunks`;
    const mapFile = await Deno.open(mapPath, { write: true, create: true, append: false });
    const lastMux = { t: 0 };
    let lastWrite = 0;
    try {
      await downloadProgressive(opts.quality.playlistUrl, tsPath, {
        signal: controller.signal,
        lookahead: kind === "proxy" ? 3 : 4,
        onChunk: (index, offset, len) => {
          void mapFile.write(new TextEncoder().encode(`${index} ${offset} ${len}\n`));
        },
        onProgress: (p) => {
          this.noteVideoProgress(part, p, opts.quality);
          if (kind === "proxy") {
            started.proxyFrontierSec = p.downloadedSec;
            started.proxyPath = tsPath;
          } else {
            started.hqPath = tsPath;
          }
          // No mid-run twin remux for pieces: the previous twin may be a
          // complete artifact from an earlier download — remuxing a partial
          // .ts over it destroys the playable file. The completion remux
          // below replaces it atomically.
          const now = performance.now();
          if (now - lastWrite > 1000) {
            lastWrite = now;
            void this.persist(opts.streamId, started, rt);
          }
        },
      });
      part.status = "done";
      part.percent = 1;
      if (kind === "proxy") started.proxyPath = tsPath;
      else started.hqPath = tsPath;
      const mp4 = await remuxToMp4(tsPath, mp4Twin(tsPath));
      if (kind === "proxy") started.proxyMp4 = mp4 ? mp4Twin(tsPath) : null;
      else started.hqMp4 = mp4 ? mp4Twin(tsPath) : null;
      started.phase = "done";
      await this.persist(opts.streamId, started, rt);
    } catch (err) {
      part.status = controller.signal.aborted ? "skipped" : "failed";
      part.error = err instanceof Error ? err.message : String(err);
      // Cancel keeps files + state: a video artifact from an earlier
      // download means the project is still complete; a bare failed piece
      // is failed-with-resume. Blanket-failed here made Cancel look broken.
      started.phase = (started.proxyPath || started.hqPath) && (started.proxyMp4 || started.hqMp4)
        ? "done"
        : "failed";
      started.overall.etaSec = null;
      await this.persist(opts.streamId, started, rt);
      if (!controller.signal.aborted) throw err;
    } finally {
      try {
        await mapFile.close();
      } catch {
        // already closed
      }
      this.markRunLive(opts.streamId, false);
    }
  }

  /** Chat-only executor: page-by-page GQL fetch with an indeterminate part. */
  private async runChatPiece(opts: {
    streamId: string;
    destDir: string;
    vodId: string;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const chatPath = `${opts.destDir}/chat.json`;
    const controller = new AbortController();
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const started = await this.getState(opts.streamId);
    const rt = this.ensureParts(started);
    const part = rt.get("chat")!;
    part.status = "running";
    part.percent = 0;
    delete (part as Partial<PartRuntime>).error;
    await this.persist(opts.streamId, started, rt);

    try {
      let lastWrite = 0;
      const count = await downloadChat(opts.vodId, chatPath, {
        signal: controller.signal,
        onProgress: ({ comments }) => {
          part.percent = Math.min(0.95, Math.log10(1 + comments) / 4);
          part.downloadedBytes = comments * 180;
          const now = performance.now();
          if (now - lastWrite > 1000) {
            lastWrite = now;
            void this.persist(opts.streamId, started, rt);
          }
        },
      });
      part.status = "done";
      part.percent = 1;
      started.chatPath = chatPath;
      started.chatCount = count;
      started.phase = (started.proxyPath || started.hqPath) ? "done" : "idle";
      await this.persist(opts.streamId, started, rt);
    } catch (err) {
      part.status = controller.signal.aborted ? "skipped" : "failed";
      part.error = err instanceof Error ? err.message : String(err);
      started.phase = (started.proxyPath || started.hqPath) ? "done" : "idle";
      await this.persist(opts.streamId, started, rt);
      throw err;
    } finally {
      this.markRunLive(opts.streamId, false);
    }
  }

  private idle(): DownloadState {
    return {
      phase: "idle",
      parts: [],
      overall: { percent: 0, etaSec: null },
      proxyFrontierSec: 0,
      proxyPath: null,
      hqPath: null,
      proxyMp4: null,
      hqMp4: null,
      chatPath: null,
      chatCount: 0,
      qualities: [],
      startedAt: null,
    };
  }

  /** Serialized state writes — concurrent SQLite writes surface as
   *  "disk I/O error" (SQLITE_BUSY) under the throttled fire-and-forget
   *  progress writes; a per-stream queue keeps them ordered. */
  private writeQueues = new Map<string, Promise<void>>();

  async setState(streamId: string, state: DownloadState): Promise<void> {
    const prev = this.writeQueues.get(streamId) ?? Promise.resolve();
    const next = prev.then(() => this.metadata.set(streamId, "download_state", JSON.stringify(state)));
    // Queue survives a failed write; the error surfaces to this caller only.
    this.writeQueues.set(streamId, next.catch(() => {}));
    await next;
  }

  /**
   * Runs the full progressive pipeline. Resolves when every part is terminal
   * (done or failed); live state is readable via getState() throughout.
   * One download per stream at a time — a second run while running throws.
   * onPartDone fires as each part reaches a terminal status, so consumers
   * (e.g. chat → stream record) don't wait for the whole pipeline.
   */
  async run(opts: {
    streamId: string;
    sourceUrl: string;
    destDir: string;
    /** Quality picks are resolved here; includeProxy=false → single download. */
    proxyHeightCap: number;
    maxQualityHeight: number | null;
    includeProxy: boolean;
    signal?: AbortSignal;
    onPartDone?: (kind: DownloadPartKind, state: DownloadState) => void | Promise<void>;
    /** Resume: keep the on-disk chunk prefix of each video part and download
     *  only the missing tail (false = start over). */
    resume?: boolean;
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
      proxyFrontierSec: 0,
      proxyPath: null,
      hqPath: null,
      proxyMp4: null,
      hqMp4: null,
      chatPath: null,
      chatCount: 0,
      qualities: [],
      startedAt: new Date().toISOString(),
    };
    const rt = new Map<DownloadPartKind, PartRuntime>();
    for (const kind of ["chat", "markers", "proxy", "hq"] as const) {
      rt.set(kind, newPart());
    }
    // Chat/markers are near-instant next to video; tiny fixed weights.
    rt.get("chat")!.weightBytes = 1;
    rt.get("markers")!.weightBytes = 1;

    // ── Part 1: chat (GQL, page-by-page) — skipped entirely when the file
    // already exists (resume: chat is immutable per VOD). ──
    const chatPath = `${opts.destDir}/chat.json`;
    if (opts.resume && await this.fileExists(chatPath)) {
      try {
        const parsed = JSON.parse(await Deno.readTextFile(chatPath)) as { comments?: unknown[] };
        rt.get("chat")!.status = "done";
        rt.get("chat")!.percent = 1;
        state.chatPath = chatPath;
        state.chatCount = parsed.comments?.length ?? 0;
        await opts.onPartDone?.("chat", state);
      } catch {
        // corrupt file → fall through to a fresh fetch below
        rt.get("chat")!.status = "running";
      }
    }
    // Fetch unless chat is already handled (done via resume skip, or
    // running from a corrupt-file fallthrough). A fresh import lands here
    // with status "pending" — the old `!== "running"` guard skipped the
    // fetch entirely and chat stayed pending (user-reported).
    if (rt.get("chat")!.status === "pending" || rt.get("chat")!.status === "running") {
    rt.get("chat")!.status = "running";
    try {
      const n = await downloadChat(vodId, chatPath, {
        signal: opts.signal,
        onProgress: ({ comments }) => {
          const part = rt.get("chat")!;
          // Percent unknown until done — show pages as pseudo-percent via
          // log scale (chat pages are tiny; the bar mainly proves liveness).
          part.percent = Math.min(0.95, Math.log10(1 + comments) / 4);
          part.downloadedBytes = comments * 180;
          void this.persist(opts.streamId, state, rt);
        },
      });
      rt.get("chat")!.status = "done";
      rt.get("chat")!.percent = 1;
      state.chatPath = chatPath;
      state.chatCount = n;
      await opts.onPartDone?.("chat", state);
    } catch (err) {
      if (opts.signal?.aborted) {
        rt.get("chat")!.status = "failed";
        rt.get("chat")!.error = "aborted";
        rt.get("markers")!.status = "skipped";
        rt.get("proxy")!.status = "skipped";
        rt.get("hq")!.status = "skipped";
        return this.finalize(opts.streamId, state, rt);
      }
      // Chat failure doesn't block video — the stream can still be reviewed.
      this.fail(rt.get("chat")!, err);
    }
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
      this.fail(rt.get("proxy")!, err);
      this.fail(rt.get("hq")!, err);
      state.qualities = [];
      return this.finalize(opts.streamId, state, rt);
    }
    state.qualities = qualities.map((q) => ({ name: q.name, width: q.width, height: q.height }));

    const proxy = pickProxyQuality(qualities, opts.proxyHeightCap);
    const hq = pickBestQuality(qualities, opts.maxQualityHeight);

    // ── Single-download case: no proxy opt-in, no proxy pick, or proxy IS
    // already the max quality — one download serves both roles. ──
    if (!opts.includeProxy || !proxy || proxy === hq) {
      const target = proxy ?? hq;
      if (target) {
        const tsPath = `${opts.destDir}/proxy.ts`;
        const lastMux = { t: 0 };
        // Resume from the previous run's frontier when the .ts survives —
        // chunk-complete prefix is kept, only the tail re-downloads.
        const resumeSec = opts.resume && await this.fileSeconds(tsPath).then((s) => s > 0).catch(() => false)
          ? Math.floor(await this.fileSeconds(tsPath))
          : 0;
        try {
          const mapPath = `${opts.destDir}/proxy.chunks`;
          const mapFile = await Deno.open(mapPath, { write: true, create: true, append: resumeSec > 0, truncate: resumeSec === 0 });
          try {
            await downloadProgressive(target.playlistUrl, tsPath, {
              signal: opts.signal ?? undefined,
              resumeSec,
              onChunk: (index, offset, len) => {
                void mapFile.write(new TextEncoder().encode(`${index} ${offset} ${len}\n`));
              },
              onProgress: (p) => {
              const part = rt.get("proxy")!;
              this.noteVideoProgress(part, p, target);
              state.proxyFrontierSec = p.downloadedSec;
              state.proxyPath = tsPath;
              state.hqPath = tsPath;
              void this.remuxTwin(tsPath, state, lastMux).then((mp4) => {
                state.proxyMp4 = mp4;
                state.hqMp4 = mp4;
                void this.persist(opts.streamId, state, rt);
              });
              void this.persist(opts.streamId, state, rt);
            },
          });
          rt.get("proxy")!.status = "done";
          rt.get("proxy")!.percent = 1;
          rt.get("hq")!.status = "done"; // same file serves HQ
          rt.get("hq")!.percent = 1;
          // Final remux (not throttled) so the complete file is playable.
          const mp4 = await remuxToMp4(tsPath, mp4Twin(tsPath));
          state.proxyMp4 = state.hqMp4 = mp4 ? mp4Twin(tsPath) : null;
          void this.persist(opts.streamId, state, rt);
          } finally {
            await mapFile.close();
          }
        } catch (err) {
          this.fail(rt.get("proxy")!, err);
          this.fail(rt.get("hq")!, err);
        }
      }
      return this.finalize(opts.streamId, state, rt);
    }

    // ── Proxy pass (live, reviewable the moment it completes) ──
    // One-time legacy migration: pre-rename runs stored artifacts as
    // scrub.ts/scrub.chunks — carry them onto the proxy names so resume
    // keeps the on-disk prefix instead of re-downloading from zero.
    if (opts.resume) {
      const legacyTs = `${opts.destDir}/scrub.ts`;
      if (!(await this.fileExists(`${opts.destDir}/proxy.ts`)) && (await this.fileExists(legacyTs))) {
        await Deno.rename(legacyTs, `${opts.destDir}/proxy.ts`);
        const legacyMap = `${opts.destDir}/scrub.chunks`;
        if (await this.fileExists(legacyMap)) {
          await Deno.rename(legacyMap, `${opts.destDir}/proxy.chunks`).catch(() => {});
        }
      }
    }
    rt.get("proxy")!.status = "running";
    const proxyTs = `${opts.destDir}/proxy.ts`;
    const lastMuxProxy = { t: 0 };
    const proxyResume = opts.resume
      ? Math.floor(await this.fileSeconds(proxyTs))
      : 0;
    const proxyMapPath = `${opts.destDir}/proxy.chunks`;
    const proxyMapFile = await Deno.open(proxyMapPath, { write: true, create: true, append: proxyResume > 0, truncate: proxyResume === 0 });
    try {
      await downloadProgressive(proxy.playlistUrl, proxyTs, {
        signal: opts.signal ?? undefined,
        resumeSec: proxyResume,
        onChunk: (index, offset, len) => {
          void proxyMapFile.write(new TextEncoder().encode(`${index} ${offset} ${len}\n`));
        },
        onProgress: (p) => {
          const part = rt.get("proxy")!;
          this.noteVideoProgress(part, p, proxy);
          state.proxyFrontierSec = p.downloadedSec;
          state.proxyPath = proxyTs;
          void this.remuxTwin(proxyTs, state, lastMuxProxy).then((mp4) => {
            state.proxyMp4 = mp4;
            void this.persist(opts.streamId, state, rt);
          });
          void this.persist(opts.streamId, state, rt);
        },
      });
      rt.get("proxy")!.status = "done";
      rt.get("proxy")!.percent = 1;
      state.proxyPath = proxyTs;
      const proxyMp4 = await remuxToMp4(proxyTs, mp4Twin(proxyTs));
      state.proxyMp4 = proxyMp4 ? mp4Twin(proxyTs) : null;
      void this.persist(opts.streamId, state, rt);
      await proxyMapFile.close();
      await opts.onPartDone?.("proxy", state);
    } catch (err) {
      if (opts.signal?.aborted) {
        rt.get("proxy")!.status = "failed";
        rt.get("proxy")!.error = "aborted";
        rt.get("hq")!.status = "skipped"; // cancelled before starting
        await proxyMapFile.close();
        await this.persist(opts.streamId, state, rt);
        return this.finalize(opts.streamId, state, rt);
      }
      this.fail(rt.get("proxy")!, err);
      state.proxyPath = null;
    }
    await this.persist(opts.streamId, state, rt);

    // ── HQ pass ──
    if (opts.signal?.aborted) {
      rt.get("hq")!.status = "skipped";
      await this.persist(opts.streamId, state, rt);
      return this.finalize(opts.streamId, state, rt);
    }
    if (hq && hq.name !== proxy.name) {
      rt.get("hq")!.status = "running";
      const hqTs = `${opts.destDir}/hq.ts`;
      const lastMuxHq = { t: 0 };
      const hqResume = opts.resume
        ? Math.floor(await this.fileSeconds(hqTs))
        : 0;
      const hqMapPath = `${opts.destDir}/hq.chunks`;
      const hqMapFile = await Deno.open(hqMapPath, { write: true, create: true, append: hqResume > 0, truncate: hqResume === 0 });
      try {
        await downloadProgressive(hq.playlistUrl, hqTs, {
          signal: opts.signal ?? undefined,
          lookahead: 4,
          resumeSec: hqResume,
          onChunk: (index, offset, len) => {
            void hqMapFile.write(new TextEncoder().encode(`${index} ${offset} ${len}\n`));
          },
          onProgress: (p) => {
            const part = rt.get("hq")!;
            this.noteVideoProgress(part, p, hq);
            void this.remuxTwin(hqTs, state, lastMuxHq).then((mp4) => {
              state.hqMp4 = mp4;
              void this.persist(opts.streamId, state, rt);
            });
            void this.persist(opts.streamId, state, rt);
          },
        });
        rt.get("hq")!.status = "done";
        rt.get("hq")!.percent = 1;
        state.hqPath = hqTs;
        const hqMp4 = await remuxToMp4(hqTs, mp4Twin(hqTs));
        state.hqMp4 = hqMp4 ? mp4Twin(hqTs) : null;
        void this.persist(opts.streamId, state, rt);
        await hqMapFile.close();
        await opts.onPartDone?.("hq", state);
      } catch (err) {
        this.fail(rt.get("hq")!, err);
        try {
          await hqMapFile.close();
        } catch {
          // already closed
        }
      }
    } else {
      // Same quality — proxy file is the HQ file.
      rt.get("hq")!.status = "done";
      rt.get("hq")!.percent = 1;
      state.hqPath = state.proxyPath;
      state.hqMp4 = state.proxyMp4;
    }

    return this.finalize(opts.streamId, state, rt);
  }

  private async fileExists(path: string): Promise<boolean> {
    return await Deno.stat(path).then(() => true).catch(() => false);
  }

  /** Actual media seconds on disk (ffprobe) — the resume base. 0 on any
   *  failure (missing/corrupt file → fresh download). */
  private async fileSeconds(path: string): Promise<number> {
    const cmd = new Deno.Command("ffprobe", {
      args: ["-v", "quiet", "-print_format", "json", "-show_format", path],
      stdout: "piped", stderr: "null",
    });
    const out = await cmd.output();
    if (!out.success) return 0;
    try {
      const info = JSON.parse(new TextDecoder().decode(out.stdout));
      const d = parseFloat(info.format?.duration ?? "0");
      return Number.isFinite(d) && d > 0 ? d : 0;
    } catch {
      return 0;
    }
  }

  /**
   * Throttled mp4-twin remux for a downloading .ts. Returns the twin path
   * when a remux ran and produced the file, null otherwise (throttled out
   * or ffmpeg failed — the .ts stays authoritative and the next tick or the
   * final completion remux will catch up).
   */
  private async remuxTwin(
    tsPath: string,
    state: { proxyMp4: string | null; hqMp4: string | null },
    lastMuxAt: { t: number },
  ): Promise<string | null> {
    const now = performance.now();
    if (now - lastMuxAt.t < 20_000) return state.proxyMp4 ?? state.hqMp4;
    lastMuxAt.t = now;
    const mp4 = mp4Twin(tsPath);
    const ok = await remuxToMp4(tsPath, mp4);
    return ok ? mp4 : null;
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
    part.downloadedBytes = p.bytes;
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
    // "done" must mean the video bytes are actually complete on disk — a
    // chat/markers-only finish (video skipped by an abort) is NOT done; the
    // user reported a download showing complete with an aborted proxy file.
    const videoOk = state.proxyPath !== null && state.proxyMp4 !== null
      && (state.hqPath === state.proxyPath || state.hqPath !== null);
    state.phase = snapshot.parts.some((p) => p.status === "running")
      ? "running"
      : (videoOk && snapshot.parts.every((p) => p.status === "done" || p.status === "skipped"))
        ? "done"
        : snapshot.parts.some((p) => p.status === "failed")
          ? "failed"
          : "idle";

    // Storage: the mp4 twin is the artifact; the raw .ts and its chunk map
    // only exist for (a) the growing-file player and (b) resume. Both roles
    // end at completion — drop them so one file remains per video kind
    // (user-reported: .ts + .chunks doubling storage after downloads).
    if (state.phase === "done") {
      for (const [tsKey, twinKey] of [["proxyPath", "proxyMp4"], ["hqPath", "hqMp4"]] as const) {
        const tsPath = state[tsKey];
        const twinPath = state[twinKey];
        if (tsPath && twinPath && tsPath.endsWith(".ts") && twinPath !== tsPath
            && await this.fileExists(twinPath)) {
          for (const victim of [tsPath, tsPath.replace(/\.ts$/, ".chunks")]) {
            await Deno.remove(victim).catch(() => {});
          }
          // Repoint the state at the twin — reconcile() then validates it.
          state[tsKey] = twinPath;
        }
      }
    }
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
      downloadedBytes: p.downloadedBytes,
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