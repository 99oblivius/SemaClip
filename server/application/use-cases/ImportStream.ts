import type {
  StreamRepository,
  VodDownloadPort,
  EventBus,
  FileSystemPort,
  MediaProbePort,
} from "@/application/ports/outbound.ts";
import { DOWNLOAD_PROGRESS_TOPIC } from "@/application/ports/outbound.ts";
import type { ImportByFileInput, ImportByUrlInput, ImportResult, Stream } from "shared/types";
import { createStream } from "@/domain/mod.ts";
import type { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";
import { fetchVodMeta, extractVodId } from "@/adapters/outbound/vod/hls.ts";
import { streamSlug, uniqueName, vodFolderName } from "@/application/use-cases/artifact-naming.ts";
import { DownloadQueue } from "@/application/use-cases/DownloadQueue.ts";

export class ImportStreamByFileUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly fs: FileSystemPort,
    private readonly probe: MediaProbePort,
  ) {}

  async execute(input: ImportByFileInput): Promise<ImportResult> {
    // Folder import: the first video file is the HQ video; any proxy
    // artifact (proxy.ts/.mp4 or a legacy scrub.ts) and chat.json alongside
    // it are picked up automatically.
    const resolved = input.folderPath
      ? await this.resolveFolder(input.folderPath)
      : { vodPath: input.vodPath, proxyPath: null as string | null, chatPath: null as string | null };
    if (!(await this.fs.exists(resolved.vodPath))) {
      throw new Error(`VOD file not found: ${resolved.vodPath}`);
    }
    const duration = await this.probe.probeDuration(resolved.vodPath);
    const stream = createStream({
      vodPath: resolved.vodPath,
      chatPath: input.chatPath ?? resolved.chatPath,
      sourceUrl: input.sourceUrl ?? null,
      title: input.title,
      streamer: input.streamer,
      duration: duration ?? undefined,
      // A folder import references a folder the user already has: record it as the
      // project's location, so this project too can report itself unreachable when that
      // folder is not there (an unmounted drive is exactly the case this covers).
      projectDir: resolved.vodPath.replace(/[\\/][^\\/]+$/, ""),
    });
    await this.streams.save(stream);
    return { stream, downloadJobId: null };
  }

  private async resolveFolder(folder: string): Promise<{ vodPath: string; proxyPath: string | null; chatPath: string | null }> {
    if (!(await this.fs.exists(folder))) throw new Error(`Folder not found: ${folder}`);
    const names = await this.fs.listFiles(folder);
    const VIDEO_EXT = [".mp4", ".mkv", ".webm", ".mov", ".avi", ".ts"];
    const isVideo = (n: string) => VIDEO_EXT.some((e) => n.toLowerCase().endsWith(e));
    const isProxy = (n: string) => ["proxy.ts", "proxy.mp4", "scrub.ts"].some((s) => n.toLowerCase() === s);
    // HQ preference: a full-quality container over a raw TS, and the largest
    // candidate wins when several exist (proxy.ts is also .ts — excluded
    // from HQ by the proxy check before the video check).
    const videos = names.filter((n) => isVideo(n) && !isProxy(n));
    if (videos.length === 0) throw new Error(`No video file found in folder: ${folder}`);
    const hq = videos.find((n) => !n.toLowerCase().endsWith(".ts")) ?? videos[0]!;
    const proxyName = names.find((n) => isProxy(n)) ?? null;
    return {
      vodPath: this.fs.joinPath(folder, hq),
      proxyPath: proxyName ? this.fs.joinPath(folder, proxyName) : null,
      chatPath: names.includes("chat.json") ? this.fs.joinPath(folder, "chat.json") : null,
    };
  }
}

export class ImportStreamByUrlUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly vodDownloader: VodDownloadPort,
    private readonly fs: FileSystemPort,
    private readonly bus: EventBus,
    private readonly cacheDir: string,
    /** Progressive orchestrator — present when progressive download is available. */
    private readonly orchestrator: DownloadOrchestrator | null = null,
    /** Per-stream abort controllers for in-flight progressive downloads. */
    private readonly aborts = new Map<string, AbortController>(),
    /**
     * Where new project folders are created. Returns the configured VOD directory, or the
     * app's cache when the user has not chosen one — resolved on EVERY import rather than
     * captured, so changing the setting applies to the next download without a restart.
     */
    private readonly vodRoot: () => Promise<string> = () => Promise.resolve(`${cacheDir}/vods`),
    /**
     * The full-VOD download queue. Injected because the UI needs the QUEUE's own view (which
     * project is running, which are waiting and in what order) — and a queue that lived only
     * inside this use-case could not be read by the layer composing the download view.
     */
    private readonly queue: DownloadQueue = new DownloadQueue(),
  ) {}

  /**
   * Create (or find) this project's folder, `{vodRoot}/{streamer}-{game}-{date}`.
   *
   * The name is unique within the root: two VODs from the same streamer and game in the
   * same minute would otherwise share a folder and interleave their artifacts. The
   * directory listing decides, so the folder name is not a guess.
   */
  private async projectDirFor(stream: Stream): Promise<string> {
    const root = await this.vodRoot();
    await this.fs.ensureDir(root);
    const base = vodFolderName({
      id: stream.id,
      streamer: stream.streamer,
      game: stream.game,
      createdAt: stream.createdAt,
    });
    let names: string[] = [];
    try {
      names = await this.fs.listFiles(root);
    } catch {
      names = [];
    }
    // `listFiles` returns files only; colliding with an existing DIRECTORY is what matters,
    // so ask the filesystem directly rather than relying on that listing alone.
    let candidate = uniqueName(base, names);
    for (let n = 2; n < 50 && await this.fs.exists(this.fs.joinPath(root, candidate)); n++) {
      candidate = uniqueName(base, [...names, candidate]);
    }
    return this.fs.joinPath(root, candidate);
  }

  async execute(input: ImportByUrlInput): Promise<ImportResult> {
    // Instrumented step by step: the owner reported the import POST never appears to
    // return on Windows (no container, no progress, an inert Download button), and with
    // no logs there was no way to tell WHICH step stalled. Each line below is a point the
    // request can get stuck, so a single run localises it.
    const t0 = performance.now();
    const step = (label: string) =>
      console.log(`[import] ${label} +${Math.round(performance.now() - t0)}ms`);

    step("start");
    if (!this.vodDownloader.isSupported(input.url)) {
      throw new Error(`Unsupported VOD URL: ${input.url}`);
    }
    step("url supported");

    // Fetch metadata first for immediate stream record. The progressive
    // URL imports fetch metadata via GQL directly (no twitch-dl dependency).
    const meta = await (async () => {
      const id = extractVodId(input.url);
      if (!id) throw new Error(`Unsupported VOD URL: ${input.url}`);
      step("fetching VOD metadata (GQL)");
      const m = await fetchVodMeta(id);
      step("metadata fetched");
      return { title: m.title, streamer: m.streamer, game: m.game, duration: m.durationSec };
    })();
    const stream = createStream({
      vodPath: "", // filled after download
      sourceUrl: input.url,
      title: input.title ?? meta.title,
      streamer: input.streamer ?? meta.streamer,
      game: meta.game,
      duration: meta.duration,
    });
    await this.streams.save(stream);
    step("stream record saved");

    // URL imports always use the chunked/live HLS orchestrator — chunks are
    // proxybable as they land regardless of the proxy-first toggle (the
    // directive's "opted out" case: single download at max quality, still
    // live). includeProxy picks one file (max quality) or two (540p first).
    // The twitch-dl legacy path is gone: it was a /tmp venv dependency and
    // delivered no live-chunk behavior.
    const controller = new AbortController();
    this.aborts.set(stream.id, controller);
    // The folder is decided HERE, before the download starts, and recorded on the project:
    // that is what makes a project's location a fact rather than something re-derived from
    // the download state later.
    const destDir = await this.projectDirFor(stream);
    await this.fs.ensureDir(destDir);
    stream.projectDir = destDir;
    await this.streams.update(stream);
    const slug = this.artifactStem(stream, destDir);
    // QUEUED, not started: full VOD downloads run one at a time in the order they were added,
    // so two imports do not split the link between them (measured on the owner's own data:
    // two VODs imported five seconds apart both ended with an empty vod_path).
    const position = this.queue.enqueue({
      streamId: stream.id,
      label: stream.title ?? stream.id.slice(0, 8),
      run: () => this.runProgressive(stream.id, input, meta, destDir, controller, false, slug),
    });
    // Nothing is written to the download state here: the queue is the ONE owner of "waiting",
    // and the downloads route composes the `queued` phase from its snapshot. A second marker
    // in the state was tried and read back as idle (see the route's comment for the measurement).
    step(`queued at position ${position} — returning 201 to the client`);
    return { stream, downloadJobId: stream.id };
  }

  /** The queue's own snapshot, for composing queued positions into the download view. */
  queueSnapshot(): { running: string | null; waiting: string[] } {
    return this.queue.snapshot();
  }

  /** Drop a stream from the queue (a delete, or a cancel of a queued download). */
  dequeue(streamId: string): boolean {
    return this.queue.cancel(streamId);
  }

  private async runProgressive(
    streamId: string,
    input: ImportByUrlInput,
    _meta: { title: string },
    destDir: string,
    controller: AbortController,
    resume = false,
    presetSlug?: string,
  ): Promise<void> {
    if (!this.orchestrator) return;
    // Live-run marker: reconcile() must not flip a genuinely running
    // download's phase to failed while the poller reads state.
    this.orchestrator.markRunLive(streamId, true);
    try {
      await this.runProgressiveInner(streamId, input, destDir, controller, resume, presetSlug);
    } finally {
      this.orchestrator.markRunLive(streamId, false);
    }
  }

  /**
   * The artifact stem for every file this project writes.
   *
   * It is the PROJECT FOLDER'S NAME, so the folder and the files inside it say the same
   * thing: `novastar-minecraft-2026-09-20-0634 - video.mp4`. Deriving it from the stream
   * TITLE (as this did) meant a folder named after the stream containing files named after
   * a title that may since have changed, and two identities for one project. Role
   * identification never depended on the stem being the title — `findArtifact` matches the
   * role by SUFFIX — so this is coherence, not a behaviour change.
   *
   * The recorded `projectDir` is authoritative: a legacy project (or one the user moved)
   * keeps the stem it already has rather than renaming files behind its record.
   */
  private artifactStem(stream: Stream | null, destDir: string): string {
    const recorded = stream?.projectDir;
    if (recorded && recorded === destDir) {
      const name = destDir.replace(/^.*[\\/]/, "");
      if (name.length > 0) return name;
    }
    return streamSlug({
      id: stream?.id ?? "",
      title: stream?.title ?? null,
      streamer: stream?.streamer ?? null,
    });
  }

  private async runProgressiveInner(
    streamId: string,
    input: ImportByUrlInput,
    destDir: string,
    controller: AbortController,
    resume: boolean,
    presetSlug?: string,
  ): Promise<void> {
    const stream = await this.streams.findById(streamId);
    const result = await this.orchestrator!.run({
      streamId,
      sourceUrl: input.url,
      destDir,
      // The stem is computed when the run is QUEUED, so it describes the project as it was
      // then; falling back here keeps a direct call (resume) working.
      slug: presetSlug ?? this.artifactStem(stream, destDir),
      proxyHeightCap: input.proxyHeightCap ?? 540,
      maxQualityHeight: input.maxQualityHeight ?? null,
      // Proxy-first (two files: 540p then HQ) is the opt-in — default is a
      // single download at max quality, still chunk-live.
      includeProxy: input.includeProxy ?? false,
      resume,
      signal: controller.signal,
      // Attach each artifact to the stream record the moment its part
      // completes — review can start on proxy while HQ still downloads,
      // and chat lands even if a later video pass fails.
      onPartDone: (kind, state) => this.attachPart(streamId, kind, state),
    });
    this.aborts.delete(streamId);

    // Point the stream at the best downloaded media: HQ if present, else
    // the proxy file (single-download case), plus the fetched chat.
    const existing = await this.streams.findById(streamId);
    if (!existing) return;
    const best = result.hqPath ?? result.proxyPath;
    if (best || result.chatPath) {
      await this.streams.update({
        ...existing,
        ...(best ? { vodPath: best } : {}),
        ...(result.chatPath ? { chatPath: result.chatPath } : {}),
      });
    }
  }

  /** Point the stream at each artifact as its part completes. */
  private async attachPart(
    streamId: string,
    kind: "chat" | "markers" | "proxy" | "hq",
    state: { chatPath: string | null; proxyPath: string | null; hqPath: string | null },
  ): Promise<void> {
    const existing = await this.streams.findById(streamId);
    if (!existing) return;
    const patch: Partial<Stream> = {};
    if (kind === "chat" && state.chatPath) patch.chatPath = state.chatPath;
    // `vodPath` is the main video's path and nothing else. Recording the proxy here (the
    // pre-rename branch checked only for a "/proxy.ts" suffix, which the current
    // "- proxy.mp4" name never matches) made whichever artifact finished FIRST the render
    // source — and in a two-file download that is always the proxy.
    if (kind === "hq" && state.hqPath) patch.vodPath = state.hqPath;
    if (Object.keys(patch).length === 0) return;
    await this.streams.update({ ...existing, ...patch });
  }

  /**
   * Resume an interrupted/stalled progressive download: re-runs the pipeline
   * with resume=true so each video part keeps its on-disk chunk prefix and
   * chat is skipped when already fetched. Throws honestly when the stream
   * has no source URL or a download is already live.
   */
  async resumeDownload(streamId: string): Promise<void> {
    if (!this.orchestrator) throw new Error("Progressive download not available");
    const stream = await this.streams.findById(streamId);
    if (!stream?.sourceUrl) throw new Error("Stream has no source URL to resume from");

    const existing = await this.orchestrator.getState(streamId);
    if (existing.phase === "running") {
      // A live run holds a controller; an orphaned "running" (server restart,
      // crash) doesn't. Only refuse when THIS process still owns the run.
      if (this.aborts.has(streamId)) {
        throw new Error("A download is already running for this stream");
      }
    }

    const controller = new AbortController();
    this.aborts.set(streamId, controller);
    // Resume writes into the project's RECORDED folder — not a re-derived one: the folder
    // name is fixed at creation (and may carry a collision suffix), so re-deriving it would
    // resume into a different, empty directory.
    const destDir = stream.projectDir ?? (await this.projectDirFor(stream));
    await this.fs.ensureDir(destDir);
    if (!stream.projectDir) {
      stream.projectDir = destDir;
      await this.streams.update(stream);
    }
    // Resume carries the same settings as the last run, persisted in state. It QUEUES like an
    // import: a resume moves the same gigabytes and must not compete with a running download.
    const resumeSlug = this.artifactStem(stream, destDir);
    this.queue.enqueue({
      streamId,
      label: stream.title ?? streamId.slice(0, 8),
      run: () =>
        this.runProgressive(streamId, {
          url: stream.sourceUrl!,
          progressive: true,
          proxyHeightCap: (existing.qualities.length > 0 ? undefined : 540) ?? 540,
          maxQualityHeight: null,
          includeProxy: existing.parts.some((p) => p.kind === "hq" && p.status !== "skipped") &&
            existing.proxyPath !== existing.hqPath,
        } as ImportByUrlInput, { title: stream.title ?? "" }, destDir, controller, true, resumeSlug),
    });
  }

  /**
   * Cancel a download (route: DELETE /download).
   *
   * A QUEUED entry is dropped here — otherwise "cancel" would leave a download that starts by
   * itself a moment later, which is the opposite of what the button says. A running one is
   * aborted via its controller, and the queue releases the next when that run resolves.
   */
  cancelProgressive(streamId: string): boolean {
    const dequeued = this.queue.cancel(streamId);
    const controller = this.aborts.get(streamId);
    if (!controller) return dequeued;
    controller.abort();
    return true;
  }

  /**
   * Delete a download: abort any in-flight run, remove every artifact the
   * pipeline produced (.ts, .mp4 twins, chat.json, playlists cache) and
   * reset the download state to idle. The "cancel that does nothing" case —
   * a stuck/orphaned state from a crashed server — clears here too, since
   * it doesn't depend on an active AbortController.
   */
  async deleteDownload(streamId: string, cacheDir: string): Promise<boolean> {
    // Abort an in-flight run if one is live (best effort; the orphaned case
    // has no controller).
    this.cancelProgressive(streamId);
    // Give the aborted fetches a beat to release file handles.
    await new Promise((r) => setTimeout(r, 300));

    // Remove EVERY artifact this project may hold: the project-named files
    // (the current scheme), every legacy boilerplate name, and the fragment
    // indexes. Hardcoding the old names meant a delete silently removed
    // nothing once artifacts were project-named — the reported "pressing
    // delete download does nothing".
    //
    // The folder comes from the RECORD first: a project lives wherever its own path says
    // (the VOD directory setting, or a drive the user moved it to), and `{cacheDir}/vods/id`
    // is only the pre-0.5.0 layout.
    const recorded = await this.streams.findById(streamId);
    const dir = recorded?.projectDir ?? `${cacheDir}/vods/${streamId}`;
    let names: string[] = [];
    try {
      names = [...Deno.readDirSync(dir)].filter((e) => e.isFile).map((e) => e.name);
    } catch {
      // No artifact directory — nothing to remove.
    }
    for (const name of names) {
      try {
        await Deno.remove(`${dir}/${name}`);
      } catch {
        // absent — fine
      }
    }
    // Reset the state to a TRUE idle so the Library item leaves the list.
    // (Resetting to idle while a view still treated "incomplete" as
    // noteworthy is what made this button look like a no-op.)
    if (this.orchestrator) {
      const state = await this.orchestrator.getState(streamId);
      state.phase = "idle";
      state.parts = [];
      state.overall = { percent: 0, etaSec: null };
      state.proxyFrontierSec = 0;
      state.videoFrontierSec = 0;
      state.proxyPath = null;
      state.hqPath = null;
      state.proxyMp4 = null;
      state.hqMp4 = null;
      state.chatPath = null;
      state.chatCount = 0;
      state.qualities = [];
      state.startedAt = null;
      await this.orchestrator.setState(streamId, state);
      // The RAM copy must go too, or the very next read serves the stale
      // pre-delete state back to the UI.
      this.orchestrator.markRunLive(streamId, false);
    }
    // The stream record must stop claiming files that no longer exist.
    const stream = await this.streams.findById(streamId);
    if (stream && (stream.vodPath || stream.chatPath)) {
      await this.streams.update({ ...stream, vodPath: "", chatPath: null });
    }
    return true;
  }

  /**
   * The legacy twitch-dl path. Its only caller used to be the non-progressive import
   * branch, which no longer exists (URL imports always run the chunked orchestrator), so
   * nothing calls it. It is left untouched rather than extended to the new layout: wiring
   * dead code to a new path resolution would be maintaining a mechanism for no caller.
   */
  private async downloadInBackground(jobId: string, url: string, streamId: string): Promise<void> {
    const destDir = `${this.cacheDir}/vods/${streamId}`;
    await this.fs.ensureDir(destDir);

    const { vodPath, chatPath } = await this.vodDownloader.download(url, destDir, (p) => {
      this.bus.publish(DOWNLOAD_PROGRESS_TOPIC, { jobId, streamId, ...p });
    });

    const existing = await this.streams.findById(streamId);
    if (!existing) return;
    await this.streams.update({ ...existing, vodPath, chatPath });
  }
}
