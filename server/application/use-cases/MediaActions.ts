/**
 * Media management actions (user-directed, download-pipeline scope).
 *
 * Thin delegation layer: the DownloadOrchestrator owns ALL download state
 * (phases, parts, presence, reconcile, piece execution). This use-case only
 * resolves stream-specific context (source URL, artifact dir, quality
 * picks) and delegates artifact deletion/open actions. One owner, one
 * truth — no parallel state machines.
 */

import type { EventBus, StreamRepository, StreamMetadataRepository, FileSystemPort } from "@/application/ports/outbound.ts";
import type { Stream } from "shared/types";
import { STREAM_CHANGED_TOPIC } from "@/application/ports/outbound.ts";
import { DownloadOrchestrator, type DownloadState } from "@/adapters/outbound/vod/download-orchestrator.ts";
import { resolveQualities, pickProxyQuality, pickBestQuality, extractVodId, type HlsQuality } from "@/adapters/outbound/vod/hls.ts";
import { artifactName, indexPathFor, LEGACY_NAMES, streamSlug } from "@/application/use-cases/artifact-naming.ts";
import { scanArtifactNames, type ArtifactDirScan } from "@/application/use-cases/reconcile-stream.ts";
import { runStatus } from "@/adapters/outbound/process/spawn.ts";

export class MediaActionsUseCase {
  /** Live piece downloads by stream — DELETE /download aborts these too. */
  private readonly pieceAborts = new Map<string, AbortController>();

  constructor(
    private readonly streams: StreamRepository,
    private readonly metadata: StreamMetadataRepository,
    private readonly fs: FileSystemPort,
    private readonly orchestrator: DownloadOrchestrator,
    /** Server cache root — the import flow writes VODs to {cacheDir}/vods/{streamId}. */
    private readonly cacheDir: string,
    /**
     * Announces artifact changes so the UI can re-read instead of polling.
     *
     * OPTIONAL on purpose: this use-case is constructed in tests without a bus, and a missing
     * announcement degrades to the old behaviour (the client notices late) rather than
     * breaking the mutation.
     */
    private readonly bus?: EventBus,
  ) {}

  /**
   * Tell the client something about this stream's stored state changed.
   *
   * Every mutation here used to change the database and stay silent, which is why deleting
   * chat took up to 30 seconds to show in the panel that had just initiated the delete.
   */
  private announce(streamId: string, reason: "chat" | "video" | "proxy" | "download" | "metadata"): void {
    try {
      // `type` is included because the client dispatches on it; the bus is a passthrough and
      // does not wrap payloads.
      this.bus?.publish(STREAM_CHANGED_TOPIC, { type: "stream_changed", streamId, reason });
    } catch {
      // A failed announcement must never fail the mutation it describes.
    }
  }

  /**
   * Abort a live piece download AND remove what it wrote.
   *
   * ── THE BUG THIS FIXES ─────────────────────────────────────────────────────────────────────
   * This only called `controller.abort()`. Every caller treats "cancel" as "stop and clean up", so
   * the reported behaviour was exactly what the code did: the download stopped, the partial file and
   * its `.fragments` index stayed on disk, and the UI still reported the piece as present. Verified
   * on the owner's cache: completed projects carried a `.mp4` plus a `.fragments` after a cancel.
   *
   * The whole-download DELETE does sweep the directory, which is why "cancel" and "delete
   * everything" behaved differently for the same gesture in two different panels. This makes the
   * per-piece cancel honest on its own terms: abort, then remove THIS piece's files and reset only
   * this piece's state.
   *
   * Deliberately NOT a directory purge — cancelling the proxy must not touch the video, the chat, or
   * a piece that is already complete and on disk. Only files belonging to `kind` are removed, and
   * only when the state does not record them as finished.
   */
  async cancelPiece(streamId: string, kind: "proxy" | "hq" | "chat"): Promise<boolean> {
    const controller = this.pieceAborts.get(streamId);
    let aborted = false;
    if (controller) {
      controller.abort();
      this.pieceAborts.delete(streamId);
      aborted = true;
    }
    // An abort is asynchronous: the writer needs a beat to release its file handles before the
    // files can be unlinked. Without this the remove can lose the race and leave the file behind —
    // which is the very symptom being fixed.
    await new Promise((r) => setTimeout(r, 300));

    const removed = kind === "chat"
      ? await this.deleteChat(streamId)
      : kind === "proxy"
        ? await this.deleteProxy(streamId)
        : await this.deleteVideo(streamId);

    // The piece's own state is reset HERE, after the delete, rather than relying on the delete's
    // internal reset. Two reasons:
    //   - a piece that never wrote a file (cancelled in its first second, or an orphaned state) makes
    //     `deleteProxy` return early WITHOUT resetting anything, because it has nothing to remove;
    //     the piece would keep reporting as running with the old counters;
    //   - reading the state after the delete means this cannot clobber what the delete persisted.
    const state = await this.orchestrator.getState(streamId);
    const part = state.parts.find((x) => x.kind === kind);
    if (part) {
      part.status = "pending";
      part.percent = 0;
      part.downloadedBytes = 0;
      part.downloadedSec = 0;
      delete part.error;
    }
    if (state.phase === "running" || state.phase === "failed") {
      state.phase = "idle";
    }
    await this.orchestrator.setState(streamId, state);
    this.announce(streamId, "download");
    // `aborted` alone would report failure for an orphaned state that had nothing to abort but
    // whose files were successfully cleaned — the second half of this bug.
    return aborted || removed.deleted;
  }

  /**
   * The artifact dir — derived from the proxyPath recorded by the download
   * state (present from the moment the proxy download starts), falling back
   * to the transcript_srt metadata path (post-processing streams).
   */
  /**
   * What the artifact folder actually holds, by role.
   *
   * Uses the same shared rule every other read uses, so this use-case cannot drift from the
   * reconciler that repairs the record.
   */
  /**
   * The artifact stem for files this use-case WRITES or scans for.
   *
   * New projects take their stem from the FOLDER NAME, so folder and files match. A project
   * whose folder was NOT named by the current scheme (anything created before it, including
   * the pre-0.5.0 `{id}` folders) keeps the stem it already has: renaming a project's files
   * behind its own record is how artifact identity breaks.
   */
  private artifactStemFor(dir: string, stream: Stream | null): string {
    if (stream?.projectDir && stream.projectDir === dir) {
      const name = dir.replace(/^.*[\\/]/, "");
      if (name.length > 0) return name;
    }
    return stream
      ? streamSlug({ id: stream.id, title: stream.title, streamer: stream.streamer })
      : "";
  }

  /**
   * Every stem this project's artifacts may carry, for a DELETION sweep.
   *
   * Both are needed, and the reason is a real case: a project created before the folder-name
   * scheme has `projectDir` adopted as its `{id}` folder, so the folder basename is a UUID
   * while its files are `{title-slug} - proxy.mp4`. Sweeping only the current stem would
   * silently delete nothing — the exact defect class this file has already been fixed for
   * twice (hardcoded names, then the title-only slug).
   */
  private candidateStems(dir: string, stream: Stream | null): string[] {
    const stems = new Set<string>();
    const current = this.artifactStemFor(dir, stream);
    if (current) stems.add(current);
    if (stream) {
      const legacy = streamSlug({ id: stream.id, title: stream.title, streamer: stream.streamer });
      if (legacy) stems.add(legacy);
    }
    // The folder's own basename is a candidate even when the record does not point at it:
    // it covers a project whose files were written under the new scheme but whose recorded
    // projectDir is momentarily unreadable.
    const base = dir.replace(/^.*[\\/]/, "");
    if (base.length > 0) stems.add(base);
    return [...stems];
  }

  private async scanArtifacts(streamId: string): Promise<ArtifactDirScan | null> {
    const dir = await this.artifactDir(streamId);
    if (!dir) return null;
    try {
      const names = await this.fs.listFiles(dir);
      const stream = await this.streams.findById(streamId);
      // The stem only PREFERS an exact filename here; role identification falls back to the
      // role suffix, so a project whose stem is unknown is still scanned correctly.
      return scanArtifactNames(dir, names, this.artifactStemFor(dir, stream) || null);
    } catch {
      return null;
    }
  }

  private async artifactDir(streamId: string): Promise<string | null> {
    const dl = await this.orchestrator.getState(streamId);
    // The project's RECORDED folder comes first: it is the only source that knows where the
    // media lives when the files are gone from view (an unmounted drive, a moved folder), and
    // it is what makes a stale path recoverable rather than silently creating a new folder
    // somewhere else.
    const stream = await this.streams.findById(streamId);
    if (stream?.projectDir && await this.fs.exists(stream.projectDir)) return stream.projectDir;
    // Every candidate is stat-checked: a path recorded in state can be stale
    // (the file was deleted), and deriving a directory from a dead path makes
    // every later delete a silent no-op.
    for (const candidate of [dl.proxyPath, dl.proxyMp4, dl.hqPath, dl.hqMp4, dl.chatPath]) {
      if (!candidate) continue;
      const dir = candidate.replace(/[\\/][^\\/]+$/, "");
      if (await this.fs.exists(dir)) return dir;
    }
    const raw = await this.metadata.get(streamId, "transcript_srt");
    if (raw) {
      try {
        const path = (JSON.parse(raw) as { path: string }).path;
        return path.replace(/[\\/][^\\/]+$/, "");
      } catch {
        // fall through to the cache-dir default
      }
    }
    // Default import layout (ImportStreamByUrlUseCase): {cacheDir}/vods/{id}.
    if (await this.fs.exists(`${this.cacheDir}/vods/${streamId}`)) {
      return `${this.cacheDir}/vods/${streamId}`;
    }
    return null;
  }

  async getState(streamId: string): Promise<DownloadState> {
    return this.orchestrator.getState(streamId);
  }

  /**
   * Delete the MAIN video artifact only. The proxy, chat and the stream
   * record's chat path are untouched.
   *
   * The video is the file the download state records for the `video`
   * artifact. It is NEVER identified by scanning for legacy filenames: in
   * two-file mode `stream.vodPath` points at whichever artifact completed
   * first (the proxy, while HQ is still running), so deleting "the video"
   * by path scan destroyed the proxy instead — the ripple the owner saw.
   */
  async deleteVideo(streamId: string): Promise<{ deleted: boolean }> {
    const state = await this.orchestrator.getState(streamId);
    const videoPaths = new Set<string>();
    // The state's own record of the video artifact (both fields can point at
    // the same file in single-download mode — that is fine, it is one file).
    if (state.hqPath) videoPaths.add(state.hqPath);
    if (state.hqMp4) videoPaths.add(state.hqMp4);
    // In two-file mode the video is its own artifact; the proxy is never
    // touched. Sweep every name the video may carry (project-named + all
    // legacy boilerplate) INCLUDING the index sidecar — a leftover
    // `.fragments` is exactly the reported "video.fragments remains".
    const dir = await this.artifactDir(streamId);
    if (dir && state.includeProxy) {
      const names = [
        ...LEGACY_NAMES.video, ...LEGACY_NAMES["video-index"],
      ];
      const streamForSlug = await this.streams.findById(streamId);
      if (streamForSlug) {
        for (const stem of this.candidateStems(dir, streamForSlug)) {
          names.push(artifactName("video", stem), artifactName("video-index", stem));
        }
      }
      for (const name of names) {
        const p = `${dir}/${name}`;
        if (await this.fs.exists(p)) videoPaths.add(p);
      }
    }
    // The index always dies with its media, whatever it was named — and that has to include the
    // index named after the RECORDED media file, not only the canonical/legacy names.
    //
    // MEASURED: this used to derive the index from the canonical names only, so a project whose file
    // was `{slug} - video.mp4` (the current scheme) kept `{slug} - video.fragments` behind after a
    // delete. The owner saw exactly that: a `.fragments` left on disk next to a removed `.mp4`.
    // `indexPathFor` is the same helper the downloader uses to name the index, so deriving from the
    // recorded path cannot drift from where it was written.
    for (const p of [...videoPaths]) {
      videoPaths.add(indexPathFor(p));
    }
    // Legacy single-file projects recorded the video as vodPath, but ONLY
    // when no separate proxy file exists.
    const stream = await this.streams.findById(streamId);
    if (stream && !state.includeProxy && stream.vodPath) {
      videoPaths.add(stream.vodPath);
    }

    let removed = false;
    for (const path of videoPaths) {
      if (await this.fs.exists(path)) {
        await this.fs.remove(path);
        removed = true;
      }
    }
    if (!removed) return { deleted: false };
    this.announce(streamId, "video");

    // `vodPath` is the RENDER SOURCE. If the deleted file owned it, re-derive it from what is
    // still on disk — the VIDEO artifact only, via the same reconciler every other read uses.
    // Deliberately NOT `state.proxyMp4`: pointing the render source at the 540p preview meant
    // deleting the video looked like a no-op and Export would have rendered from the proxy.
    if (stream && stream.vodPath && videoPaths.has(stream.vodPath)) {
      const scan = await this.scanArtifacts(streamId);
      await this.streams.update({ ...stream, vodPath: scan?.video ?? "" });
    }
    if (state.hqPath || state.hqMp4) {
      state.hqPath = null;
      state.hqMp4 = null;
      const part = state.parts.find((x) => x.kind === "hq");
      if (part) {
        // Reset the COUNTERS, not just the status. Leaving `downloadedBytes`/`downloadedSec`
        // behind made the view keep reporting the deleted file's full size as the video
        // artifact after the delete — and, worse, immediately after a re-download started, so
        // the UI showed a complete video the moment a new one began. That stale size is what
        // the player reads, and it is why a re-downloaded video took an extremely long time to
        // appear: the frontier never looked like it had dropped.
        part.status = "pending";
        part.percent = 0;
        part.downloadedBytes = 0;
        part.downloadedSec = 0;
        delete part.error;
      }
      await this.orchestrator.setState(streamId, state);
    }
    return { deleted: removed };
  }

  async deleteProxy(streamId: string): Promise<{ deleted: boolean }> {
    const dir = await this.artifactDir(streamId);
    if (!dir) return { deleted: false };
    // The proxy is one fragmented MP4 plus its fragment index; legacy
    // runs may have left a .ts/.chunks pair or scrub.* names.
    const candidates = [...LEGACY_NAMES.proxy, ...LEGACY_NAMES["proxy-index"]];
    const streamForSlug = await this.streams.findById(streamId);
    if (streamForSlug) {
      for (const stem of this.candidateStems(dir, streamForSlug)) {
        candidates.push(artifactName("proxy", stem), artifactName("proxy-index", stem));
      }
    }
    let removed = false;
    for (const name of candidates) {
      const path = `${dir}/${name}`;
      if (await this.fs.exists(path)) {
        await this.fs.remove(path);
        removed = true;
      }
    }
    if (!removed) return { deleted: false };
    const state = await this.orchestrator.getState(streamId);
    // Clear the references that pointed at what was just deleted, and the PART's counters with
    // them. A stale `downloadedBytes` reports the deleted proxy as still on disk — and, once a
    // re-download starts, as already complete, which is what the player reads to decide
    // whether to reload.
    //
    // Guarded by path: in single-file mode an older state recorded the project's ONLY video in
    // the proxy slot, so clearing that slot unconditionally forgot a file that is still on
    // disk (the 1.1GB video the user had just kept). Only forget a path that was actually
    // among the files removed above.
    const removedPaths = new Set(candidates.map((name) => `${dir}/${name}`));
    if (state.proxyPath && removedPaths.has(state.proxyPath)) {
      state.proxyPath = null;
      state.proxyMp4 = null;
      state.proxyFrontierSec = 0;
    }
    if (state.hqPath && removedPaths.has(state.hqPath)) {
      state.hqPath = null;
      state.hqMp4 = null;
      state.videoFrontierSec = 0;
    }
    {
      const part = state.parts.find((x) => x.kind === "proxy");
      if (part) {
        part.status = "pending";
        part.percent = 0;
        part.downloadedBytes = 0;
        part.downloadedSec = 0;
        delete part.error;
      }
    }
    await this.orchestrator.setState(streamId, state);
    this.announce(streamId, "proxy");
    return { deleted: true };
  }

  /** Open the artifact folder in the OS file manager (xdg-open / explorer). */
  async openFolder(streamId: string): Promise<{ opened: boolean; dir: string | null; error?: string }> {
    const dir = await this.artifactDir(streamId);
    // Nothing to show yet. Report WHY (the UI can say "this project has no files yet"), rather
    // than a bare refusal the button turns into silence.
    if (!dir || !(await this.fs.exists(dir))) {
      return { opened: false, dir: null, error: "This project has no files on disk yet." };
    }
    const cmd = Deno.build.os === "windows" ? "explorer" : "xdg-open";
    try {
      // `explorer.exe` does not accept a forward-slashed path, and every path this
      // process builds uses "/" — so handing it `dir` verbatim made the button a silent
      // no-op on Windows (it resolves a relative path, or nothing at all). Every path
      // that leaves the process must be host-native.
      const native = this.fs.nativePath(dir);
      // Fire-and-forget: opening the folder in the OS file manager. No output is wanted.
      //
      // `showWindow: true` is REQUIRED, not cosmetic: every child is spawned hidden by default
      // (CREATE_NO_WINDOW), and a hidden explorer.exe starts, stays alive and creates NO window —
      // which is exactly why this button did nothing on Windows.
      //
      // The result is now REPORTED rather than assumed. This used to `void` the spawn and return
      // `opened: true` unconditionally, so a spawn that failed (or a window suppressed by the
      // flag above) was indistinguishable from one that worked. `explorer` also exits 1 as a
      // matter of course, so only an outright spawn failure counts as failure here.
      const status = await runStatus(cmd, { args: [native], showWindow: true });
      if (!status.success && status.code !== 1) {
        return { opened: false, dir: native };
      }
      return { opened: true, dir: native };
    } catch (err) {
      return { opened: false, dir, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /**
   * Remove a project's MEDIA directory.
   *
   * Download artifacts live in `{cacheDir}/vods/{streamId}`, which is NOT the
   * directory `StreamStorage.deleteStream` removes (`{dataDir}/streams/{id}`).
   * Deleting a project therefore left every downloaded gigabyte on disk — and
   * an orphaned file can still be reached by the media route's fallbacks,
   * which is how "deleted" video kept playing. Removing the whole artifact
   * directory is the only honest delete.
   */
  async purgeArtifacts(streamId: string): Promise<{ bytes: number }> {
    // The project's own folder when it has one, else the pre-0.5.0 layout. Deleting the
    // wrong one leaves every downloaded gigabyte on disk.
    const stream = await this.streams.findById(streamId);
    const dir = stream?.projectDir ?? `${this.cacheDir}/vods/${streamId}`;
    let bytes = 0;
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile) continue;
        const st = await Deno.stat(`${dir}/${entry.name}`).catch(() => null);
        bytes += st?.size ?? 0;
      }
      await Deno.remove(dir, { recursive: true });
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
    if (bytes > 0) this.announce(streamId, "download");
    return { bytes };
  }

  /**
   * Delete the chat JSON.
   *
   * ENUMERATES the names the chat may carry — project-named (`{slug}.chat.json`) plus
   * every legacy boilerplate name — rather than testing one hardcoded path. Artifacts are
   * project-named, so `chat.json` matched nothing on any project created since the rename:
   * the route returned 200 with `deleted: false` and the file stayed on disk, which the UI
   * reports as "no chat" never appearing after a delete. Exactly the hardcoded-name-list
   * defect already fixed for `DELETE /download`; this was the same bug one artifact over.
   *
   * All THREE owners are reset: the file, the download state, and the stream record.
   */
  async deleteChat(streamId: string): Promise<{ deleted: boolean }> {
    const dir = await this.artifactDir(streamId);
    if (!dir) return { deleted: false };

    const names = [...LEGACY_NAMES.chat];
    const stream = await this.streams.findById(streamId);
    if (stream) {
      for (const stem of this.candidateStems(dir, stream)) {
        names.push(artifactName("chat", stem));
      }
    }
    // Whatever the state or the record actually points at, wherever it lives — a
    // folder import references the user's own directory, which is not `dir`.
    const state = await this.orchestrator.getState(streamId);
    const recorded = [state.chatPath, stream?.chatPath].filter(
      (p): p is string => Boolean(p),
    );

    let removed = false;
    for (const path of new Set([...recorded, ...names.map((n) => `${dir}/${n}`)])) {
      if (await this.fs.exists(path)) {
        await this.fs.remove(path);
        removed = true;
      }
    }
    if (!removed) return { deleted: false };

    state.chatPath = null;
    state.chatCount = 0;
    const part = state.parts.find((x) => x.kind === "chat");
    if (part && part.status === "done") part.status = "pending";
    await this.orchestrator.setState(streamId, state);
    if (stream?.chatPath && recorded.includes(stream.chatPath)) {
      await this.streams.update({ ...stream, chatPath: null });
    }
    this.announce(streamId, "chat");
    return { deleted: true };
  }

  /**
   * Downloads a single missing piece at an explicit quality height:
   * kind="proxy" → the highest ≤ cap (defaults 540), kind="hq" → the
   * highest ≤ maxHeight (null = source). Delegates execution to the
   * orchestrator's startPiece — the manager owns state and plumbing.
   */
  async downloadPiece(opts: {
    streamId: string;
    kind: "proxy" | "hq" | "chat";
    proxyHeightCap?: number;
    maxHeight?: number | null;
    signal?: AbortSignal | undefined;
  }): Promise<{ started: boolean; quality: string | null }> {
    const stream = await this.streams.findById(opts.streamId);
    if (!stream?.sourceUrl) {
      throw new Error("Stream has no source URL — nothing to download from");
    }
    const vodId = extractVodId(stream.sourceUrl);
    if (!vodId) throw new Error(`Unparseable source URL: ${stream.sourceUrl}`);

    let dir = await this.artifactDir(opts.streamId);
    if (!dir) {
      // No media on disk yet. Use the project's RECORDED folder when it has one (a fresh
      // import has already created it), else the app's cache — never a re-derived name, or
      // the piece would land in a folder the project does not know about.
      const fresh = stream.projectDir ?? `${this.cacheDir}/vods/${opts.streamId}`;
      await this.fs.ensureDir(fresh);
      dir = fresh;
    }
    await this.fs.ensureDir(dir);

    let quality: HlsQuality | null = null;
    if (opts.kind !== "chat") {
      const qualities = await resolveQualities(vodId);
      const mainVideo = pickBestQuality(qualities, opts.maxHeight ?? null);
      quality = opts.kind === "proxy"
        // A proxy at the video's own resolution is a duplicate, not a preview.
        ? pickProxyQuality(qualities, opts.proxyHeightCap ?? 540, mainVideo?.height ?? null)
        : mainVideo;
      if (!quality) throw new Error("No qualities available for this VOD");
    }

    const controller = new AbortController();
    this.pieceAborts.set(opts.streamId, controller);
    if (opts.signal) opts.signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      await this.orchestrator.startPiece({
        streamId: opts.streamId,
        destDir: dir,
        kind: opts.kind,
        vodId,
        slug: this.artifactStemFor(dir, stream),
        quality: quality ?? undefined,
        signal: controller.signal,
      });
      return { started: true, quality: quality?.name ?? null };
    } finally {
      this.pieceAborts.delete(opts.streamId);
    }
  }
}