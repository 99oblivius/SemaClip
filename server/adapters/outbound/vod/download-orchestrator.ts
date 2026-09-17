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
import type { ToolRegistry } from "@/adapters/outbound/ffmpeg/tool-paths.ts";
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
import { downloadFmp4 } from "./fmp4-download.ts";
import { artifactName, indexPathFor, LEGACY_NAMES } from "@/application/use-cases/artifact-naming.ts";
import { run } from "@/adapters/outbound/process/spawn.ts";

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
  /** Two-file mode: a separate proxy file exists alongside the main video.
   *  false (default) = ONE video file serves the project. Recorded
   *  explicitly because the UI cannot infer it from part kinds — in
   *  single-download mode the `proxy` PART carries the video. */
  includeProxy: boolean;
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
  constructor(
    private readonly metadata: StreamMetadataRepository,
    /** Resolved at spawn time via the registry: a download can land mid-session,
     *  and a path captured at construction would go stale. */
    private readonly tools: ToolRegistry,
  ) {}

  /** Streams with an orchestrator run in THIS process — reconcile() must
   *  not touch their running phase (orphaned vs live distinction). */
  private liveRuns = new Set<string>();

  /**
   * Live view registry — the authoritative state for streams downloading in
   * THIS process. Reads during a run come from here, so a 1 Hz poll costs no
   * disk I/O, cannot observe a torn intermediate write, and cannot lag the
   * downloader. The persisted snapshot remains the durability record and is
   * read (with reconciliation) only when no live run exists.
   */
  private liveStates = new Map<string, DownloadState>();

  /** Monotonic revision per stream — lets a client detect change cheaply. */
  private revisions = new Map<string, number>();

  /**
   * Bumped whenever ANY stream's download view changes (state write, run
   * start/finish, artifact delete). A single global counter lets the client
   * detect "something changed" in ONE cheap comparison instead of diffing
   * every view, and it is what makes deletions and completions appear
   * immediately rather than on the next 30s idle poll.
   */
  private globalRevision = 0;

  /** Latest global revision — changes on any download mutation anywhere. */
  get globalRev(): number {
    return this.globalRevision;
  }

  /** Record a change that affects a stream's view but not its state file
   *  (artifact deletions, external file changes). */
  touch(streamId: string): void {
    this.bumpRevision(streamId);
  }

  /** Mark/unmark a stream's orchestrator run as live (run()/piece runners). */
  markRunLive(streamId: string, live: boolean): void {
    if (live) this.liveRuns.add(streamId);
    else {
      this.liveRuns.delete(streamId);
      // The run is over: drop the RAM copy so later reads reconcile against
      // disk (the durability record is now the truth).
      this.liveStates.delete(streamId);
    }
  }

  /** Current revision for a stream (0 when never touched in this process). */
  revision(streamId: string): number {
    return this.revisions.get(streamId) ?? 0;
  }

  private bumpRevision(streamId: string): void {
    this.revisions.set(streamId, (this.revisions.get(streamId) ?? 0) + 1);
    this.globalRevision++;
  }

  async getState(streamId: string): Promise<DownloadState> {
    // A live run owns the state in RAM: return it directly (no disk read, no
    // reconcile — reconcile would fight the downloader for ownership).
    const live = this.liveStates.get(streamId);
    if (live && this.liveRuns.has(streamId)) {
      return { ...live, presence: await this.presence(live) };
    }
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

    // A state with a playable file on disk is a real download — hydrate the
    // phase so the player/library reflect it. A project whose video was
    // deleted but whose proxy survives is still playable, so it stays done.
    if (state.phase === "idle" || state.phase === "failed") {
      const playable = [state.proxyMp4, state.hqMp4, state.proxyPath, state.hqPath]
        .find((p) => p && (p.endsWith(".mp4") || p.endsWith(".ts")));
      if (playable && await exists(playable)) {
        state = { ...state, phase: "done" };
        changed = true;
      }
    }

    // Post-completion storage hygiene: a done project keeps ONE file per
    // video kind. States from the ts+twin era still reference proxy.ts /
    // hq.ts — repoint them at the fMP4 and sweep the leftovers.
    if (state.phase === "done") {
      for (const [pathKey, mp4Key] of [["proxyPath", "proxyMp4"], ["hqPath", "hqMp4"]] as const) {
        const p = state[pathKey];
        const mp4 = state[mp4Key];
        if (p && p.endsWith(".ts")) {
          const candidate = mp4 && !mp4.endsWith(".ts") ? mp4 : p.replace(/\.ts$/, ".mp4");
          if (await exists(candidate)) {
            state = { ...state, [pathKey]: candidate, [mp4Key]: candidate };
            changed = true;
          }
        }
      }
      await this.sweepLegacyArtifacts(state);
    }

    // A part whose file is gone and which is not running is no longer
    // failed — it is simply absent (the user deleted it). Leaving it failed
    // made the container read "interrupted: Video" forever.
    if (state.phase === "done") {
      const fixed = state.parts.map((p) => {
        if (p.status !== "failed") return p;
        const pathFor = p.kind === "hq" ? [state.hqPath, state.hqMp4]
          : p.kind === "proxy" ? [state.proxyPath, state.proxyMp4]
            : p.kind === "chat" ? [state.chatPath] : [];
        const anyAlive = pathFor.some(Boolean);
        if (anyAlive) return p;
        const { error: _drop, ...rest } = p;
        return { ...rest, status: "pending" as const, percent: 0, downloadedBytes: 0, etaSec: null };
      });
      if (fixed.some((p, i) => p.status !== state.parts[i]!.status)) {
        state = { ...state, parts: fixed };
        changed = true;
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
    /** Project slug for artifact filenames. */
    slug: string;
    quality?: HlsQuality | undefined;   // video pieces
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const live = this.liveRuns.has(opts.streamId);
    if (live) throw new Error("A download is already running for this stream");
    // Seed the RAM copy from the persisted state so the piece's first
    // progress write has a full state object to extend.
    this.liveStates.set(opts.streamId, await this.getState(opts.streamId));
    this.markRunLive(opts.streamId, true);
    if (opts.kind === "chat") {
      await this.runChatPiece({ streamId: opts.streamId, destDir: opts.destDir, vodId: opts.vodId, slug: opts.slug, signal: opts.signal });
    } else {
      await this.runVideoPiece({
        streamId: opts.streamId,
        destDir: opts.destDir,
        kind: opts.kind,
        slug: opts.slug,
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
    slug: string;
    quality: HlsQuality;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const { kind } = opts;
    const controller = new AbortController();
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });

    const started = await this.getState(opts.streamId);
    const rt = this.ensureParts(started);
    const part = rt.get(kind)!;
    part.status = "running";
    part.percent = 0;
    delete (part as Partial<PartRuntime>).error;
    await this.persist(opts.streamId, started, rt);

    // One growing fragmented MP4 per artifact role. The `hq` kind IS the
    // main video, so it writes the video artifact's name — not "hq.mp4",
    // which left the project with a second, differently-named video file.
    const role = kind === "proxy" ? "proxy" : "video";
    const mp4Path = `${opts.destDir}/${artifactName(role, opts.slug)}`;
    const indexPath = `${opts.destDir}/${artifactName(role === "proxy" ? "proxy-index" : "video-index", opts.slug)}`;
    let lastWrite = 0;
    try {
      await downloadFmp4(opts.quality.playlistUrl, mp4Path, {
        signal: controller.signal,
        lookahead: kind === "proxy" ? 3 : 4,
        indexPath,
        ffmpegPath: this.tools.ffmpeg,
        onProgress: (p) => {
          this.noteVideoProgress(part, p, opts.quality);
          if (kind === "proxy") {
            started.proxyFrontierSec = p.downloadedSec;
            started.proxyPath = mp4Path;
            started.proxyMp4 = mp4Path;
          } else {
            started.hqPath = mp4Path;
            started.hqMp4 = mp4Path;
          }
          const now = performance.now();
          if (now - lastWrite > 1000) {
            lastWrite = now;
            void this.persist(opts.streamId, started, rt);
          }
        },
      });
      part.status = "done";
      part.percent = 1;
      if (kind === "proxy") {
        started.proxyPath = mp4Path;
        started.proxyMp4 = mp4Path;
      } else {
        started.hqPath = mp4Path;
        started.hqMp4 = mp4Path;
      }
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
      this.markRunLive(opts.streamId, false);
    }
  }

  /** Chat-only executor: page-by-page GQL fetch with an indeterminate part. */
  private async runChatPiece(opts: {
    streamId: string;
    destDir: string;
    vodId: string;
    slug: string;
    signal?: AbortSignal | undefined;
  }): Promise<void> {
    const chatPath = `${opts.destDir}/${artifactName("chat", opts.slug)}`;
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
      includeProxy: false,
    };
  }

  /** Serialized state writes — concurrent SQLite writes surface as
   *  "disk I/O error" (SQLITE_BUSY) under the throttled fire-and-forget
   *  progress writes; a per-stream queue keeps them ordered. */
  private writeQueues = new Map<string, Promise<void>>();

  async setState(streamId: string, state: DownloadState): Promise<void> {
    if (this.liveRuns.has(streamId)) {
      this.liveStates.set(streamId, state);
      this.bumpRevision(streamId);
    }
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
    /** Project slug for artifact filenames (see artifact-naming.ts). */
    slug: string;
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
      includeProxy: opts.includeProxy,
    };
    // Publish to RAM immediately: the very first poll must already see the
    // running phase (otherwise a container appears only after a refresh).
    this.liveStates.set(opts.streamId, state);
    this.bumpRevision(opts.streamId);
    const rt = new Map<DownloadPartKind, PartRuntime>();
    for (const kind of ["chat", "markers", "proxy", "hq"] as const) {
      rt.set(kind, newPart());
    }
    // Chat/markers are near-instant next to video; tiny fixed weights.
    rt.get("chat")!.weightBytes = 1;
    rt.get("markers")!.weightBytes = 1;

    // ── Part 1: chat (GQL, page-by-page) — skipped entirely when the file
    // already exists (resume: chat is immutable per VOD). ──
    const chatPath = `${opts.destDir}/${artifactName("chat", opts.slug)}`;
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

    const hq = pickBestQuality(qualities, opts.maxQualityHeight);
    // The proxy must sit BELOW the video's resolution — a proxy at the same
    // resolution is a duplicate of the video, not a preview.
    const proxy = pickProxyQuality(qualities, opts.proxyHeightCap, hq?.height ?? opts.maxQualityHeight ?? null);

    // ── Single-download case: no proxy opt-in, no proxy pick, or proxy IS
    // already the max quality — one download serves both roles. ──
    if (!opts.includeProxy || !proxy || proxy === hq) {
      const target = proxy ?? hq;
      if (target) {
        // ONE growing fragmented MP4 serves the project — no .ts, no twin,
        // no remux, and crucially no second artifact aliasing this file
        // (the old model set hqPath = proxyPath, so the HQ row's trash
        // deleted the proxy's media and both rows lost their bytes).
        const videoPath = `${opts.destDir}/${artifactName("video", opts.slug)}`;
        const indexPath = `${opts.destDir}/${artifactName("video-index", opts.slug)}`;
        const resumeSec = opts.resume ? Math.floor(await this.fileSeconds(videoPath)) : 0;
        // Mark the part running BEFORE the first chunk: a part left
        // "pending" while bytes land makes the UI show a pending row next to
        // a growing percentage (user-reported: bars that do not change).
        rt.get("proxy")!.status = "running";
        await this.persist(opts.streamId, state, rt);
        try {
          await downloadFmp4(target.playlistUrl, videoPath, {
            signal: opts.signal ?? undefined,
            resumeSec,
            indexPath,
            ffmpegPath: this.tools.ffmpeg,
          onProgress: (p) => {
              const part = rt.get("proxy")!;
              this.noteVideoProgress(part, p, target);
              state.proxyFrontierSec = p.downloadedSec;
              state.proxyPath = videoPath;
              state.proxyMp4 = videoPath;
              void this.persist(opts.streamId, state, rt);
            },
          });
          rt.get("proxy")!.status = "done";
          rt.get("proxy")!.percent = 1;
          rt.get("hq")!.status = "skipped"; // one file: no separate HQ pass
          rt.get("hq")!.percent = 1;
          state.proxyPath = videoPath;
          state.proxyMp4 = videoPath;
          void this.persist(opts.streamId, state, rt);
          await opts.onPartDone?.("proxy", state);
        } catch (err) {
          if (opts.signal?.aborted) {
            rt.get("proxy")!.status = "failed";
            rt.get("proxy")!.error = "aborted";
            rt.get("hq")!.status = "skipped";
            await this.persist(opts.streamId, state, rt);
            return this.finalize(opts.streamId, state, rt);
          }
          this.fail(rt.get("proxy")!, err);
          state.proxyPath = null;
          state.proxyMp4 = null;
        }
      }
      return this.finalize(opts.streamId, state, rt);
    }

    // ── Proxy pass (live, reviewable the moment it completes) ──
    // Legacy artifacts (scrub.*/proxy.ts + .chunks twins) are removed by
    // the post-completion sweep in finalize()/reconcile(): the fMP4 is the
    // only file a completed project keeps.
    rt.get("proxy")!.status = "running";
    // ── Proxy pass: ONE growing fragmented MP4 (no .ts, no twin, no remux) ──
    // Chunks pipe straight into ffmpeg and the muxed fragments are written
    // to proxy.mp4; the fragment index sidecar lets the media route clamp
    // Range responses to a complete fragment (a mid-fragment clamp makes
    // Chromium die with PIPELINE_ERROR_DECODE).
    const proxyMp4Path = `${opts.destDir}/${artifactName("proxy", opts.slug)}`;
    const proxyIndexPath = `${opts.destDir}/${artifactName("proxy-index", opts.slug)}`;
    const proxyResume = opts.resume ? Math.floor(await this.fileSeconds(proxyMp4Path)) : 0;
    rt.get("proxy")!.status = "running";
    await this.persist(opts.streamId, state, rt);
    try {
      await downloadFmp4(proxy.playlistUrl, proxyMp4Path, {
        signal: opts.signal ?? undefined,
        resumeSec: proxyResume,
        indexPath: proxyIndexPath,
        ffmpegPath: this.tools.ffmpeg,
        onProgress: (p) => {
          const part = rt.get("proxy")!;
          this.noteVideoProgress(part, p, proxy);
          state.proxyFrontierSec = p.downloadedSec;
          state.proxyPath = proxyMp4Path;
          state.proxyMp4 = proxyMp4Path;
          void this.persist(opts.streamId, state, rt);
        },
      });
      rt.get("proxy")!.status = "done";
      rt.get("proxy")!.percent = 1;
      state.proxyPath = proxyMp4Path;
      state.proxyMp4 = proxyMp4Path;
      void this.persist(opts.streamId, state, rt);
      await opts.onPartDone?.("proxy", state);
    } catch (err) {
      if (opts.signal?.aborted) {
        rt.get("proxy")!.status = "failed";
        rt.get("proxy")!.error = "aborted";
        rt.get("hq")!.status = "skipped"; // cancelled before starting
        await this.persist(opts.streamId, state, rt);
        return this.finalize(opts.streamId, state, rt);
      }
      this.fail(rt.get("proxy")!, err);
      state.proxyPath = null;
      state.proxyMp4 = null;
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
      const hqMp4Path = `${opts.destDir}/${artifactName("video", opts.slug)}`;
      const hqIndexPath = `${opts.destDir}/${artifactName("video-index", opts.slug)}`;
      const hqResume = opts.resume ? Math.floor(await this.fileSeconds(hqMp4Path)) : 0;
      try {
        await downloadFmp4(hq.playlistUrl, hqMp4Path, {
          signal: opts.signal ?? undefined,
          lookahead: 4,
          resumeSec: hqResume,
          indexPath: hqIndexPath,
          ffmpegPath: this.tools.ffmpeg,
          onProgress: (p) => {
            const part = rt.get("hq")!;
            this.noteVideoProgress(part, p, hq);
            state.hqPath = hqMp4Path;
            state.hqMp4 = hqMp4Path;
            void this.persist(opts.streamId, state, rt);
          },
        });
        rt.get("hq")!.status = "done";
        rt.get("hq")!.percent = 1;
        state.hqPath = hqMp4Path;
        state.hqMp4 = hqMp4Path;
        void this.persist(opts.streamId, state, rt);
        await opts.onPartDone?.("hq", state);
      } catch (err) {
        this.fail(rt.get("hq")!, err);
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

  /**
   * Remove artifacts from the ts+twin era. A completed fMP4 project keeps
   * exactly one media file per kind; the raw `.ts`, its `.chunks` byte map,
   * and any `scrub.*` leftovers are dead weight (they were the doubling the
   * owner flagged). Best-effort: a failed unlink never breaks the state.
   */
  private async sweepLegacyArtifacts(state: DownloadState): Promise<void> {
    const dirs = new Set<string>();
    for (const p of [state.proxyPath, state.hqPath, state.proxyMp4, state.hqMp4]) {
      if (p) dirs.add(p.replace(/\/[^/]+$/, ""));
    }
    if (dirs.size === 0) return;
    // Only sweep when the surviving artifact is an fMP4 — otherwise the .ts
    // may still be the playable file.
    const keepTs = [state.proxyPath, state.hqPath].some((p) => p?.endsWith(".ts"));
    if (keepTs) return;
    const victims = new Set<string>([
      "proxy.ts", "hq.ts", "video.ts", "scrub.ts",
      "proxy.chunks", "hq.chunks", "video.chunks", "scrub.chunks",
      "scrub.mp4", "proxy.mp4.part",
      // Legacy boilerplate media + their indexes. A project-named artifact is
      // what survives; these are dead once the download completes.
      ...LEGACY_NAMES.proxy, ...LEGACY_NAMES.video,
      ...LEGACY_NAMES["proxy-index"], ...LEGACY_NAMES["video-index"],
    ]);
    // Never delete a file the state currently points at.
    const keep = new Set(
      [state.proxyPath, state.hqPath, state.proxyMp4, state.hqMp4, state.chatPath]
        .filter((p): p is string => Boolean(p)),
    );
    for (const dir of dirs) {
      for (const name of victims) {
        const path = `${dir}/${name}`;
        if (keep.has(path)) continue;
        await Deno.remove(path).catch(() => {});
      }
    }
    // An index with no media beside it is always dead weight.
    for (const dir of dirs) {
      let names: string[] = [];
      try {
        names = [...Deno.readDirSync(dir)].filter((e) => e.isFile).map((e) => e.name);
      } catch {
        continue;
      }
      for (const name of names) {
        if (!name.endsWith(".fragments")) continue;
        const media = `${dir}/${name.replace(/\.fragments$/, ".mp4")}`;
        if (keep.has(media)) continue;
        if (!names.includes(name.replace(/\.fragments$/, ".mp4"))) {
          await Deno.remove(`${dir}/${name}`).catch(() => {});
        }
      }
    }
  }

  private async fileExists(path: string): Promise<boolean> {
    return await Deno.stat(path).then(() => true).catch(() => false);
  }

  /** Actual media seconds on disk (ffprobe) — the resume base. 0 on any
   *  failure (missing/corrupt file → fresh download). */
  private async fileSeconds(path: string): Promise<number> {
    const out = await run(this.tools.ffprobe, {
      args: ["-v", "quiet", "-print_format", "json", "-show_format", path],
    });
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
    const ok = await remuxToMp4(tsPath, mp4, { ffmpegPath: this.tools.ffmpeg });
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

    // Storage: the fragmented MP4 IS the artifact — one file per video kind,
    // playable while it grows. Legacy leftovers from the ts+twin era
    // (proxy.ts/hq.ts, their .chunks maps, scrub.*) are swept here so a
    // completed project never keeps two copies of the same media.
    if (state.phase === "done") {
      await this.sweepLegacyArtifacts(state);
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