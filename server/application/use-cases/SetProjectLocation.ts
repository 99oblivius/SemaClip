/**
 * The move-a-project use-case.
 *
 * Thin by design: it owns the ORDER of operations and the refusals, and delegates the
 * judgement to `rePointPaths` (pure, tested) and the download state to the orchestrator.
 * Every path it writes is derived from what is actually on disk — never from a guess.
 */
import type { EventBus, FileSystemPort, StreamRepository } from "@/application/ports/outbound.ts";
import { STREAM_CHANGED_TOPIC } from "@/application/ports/outbound.ts";
import type { Stream } from "shared/types";
import type { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";
import { rePointPaths } from "@/application/use-cases/project-location.ts";
import { resolveUserPath } from "@/application/use-cases/paths.ts";
import { findArtifact, type ArtifactRole } from "@/application/use-cases/artifact-naming.ts";

export interface MoveResult {
  stream: Stream;
  dir: string;
  /** Artifact paths now pointing into the new folder. */
  repointed: number;
  /** Recorded artifacts that are NOT in the new folder (nothing was changed for them). */
  missing: string[];
}

export class SetProjectLocationUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly fs: FileSystemPort,
    private readonly orchestrator: DownloadOrchestrator | null,
    private readonly bus?: EventBus,
  ) {}

  /**
   * Point a project at `input`.
   *
   * REFUSALS, each for a reason that would otherwise corrupt state:
   *   - a download is running: it is writing into the OLD folder right now, and repointing
   *     mid-run would leave the state describing files in two places;
   *   - the path is not absolute (or is empty/`~`-relative): it would resolve against the
   *     app's launch directory, so the same project would land in different places;
   *   - the directory does not exist: creating it would report success while pointing the
   *     project at an empty folder, hiding the actual problem (a wrong path, an unmounted
   *     drive). "Change location" means "it is HERE", so a path that is not there is a
   *     refusal with the reason, not a mkdir.
   */
  async execute(streamId: string, input: string): Promise<MoveResult> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);

    const dir = resolveUserPath(input);

    if (this.orchestrator) {
      const state = await this.orchestrator.getState(streamId);
      if (state.phase === "running" || state.phase === "starting") {
        throw new Error("A download is running for this project — stop it before changing its location.");
      }
    }

    if (!(await this.fs.exists(dir))) {
      throw new Error(`Folder not found: ${dir}`);
    }

    let repointed = 0;
    const missing: string[] = [];

    // The download state holds the artifact paths the VIEW resolves presence from, so this is
    // what makes a moved project show its files again.
    if (this.orchestrator) {
      const before = await this.orchestrator.getState(streamId);
      const result = await rePointPaths(
        before as unknown as Record<string, unknown>,
        dir,
        (p) => this.fs.exists(p),
      );
      // rePointPaths spreads its input, so it returns a NEW object: every later edit must land
      // on THAT one. Mutating `before` and persisting `result.state` would write a copy that
      // never saw the slot-filling below — which is exactly how this failed first: the video
      // slot was filled on one object and a stale twin was saved.
      const state = result.state as unknown as typeof before;
      repointed += result.repointed.length;
      missing.push(...result.kept.map(([, p]) => p));

      // ── SLOTS THE STATE NEVER RECORDED ──────────────────────────────────────────────────
      // Repointing alone is not enough, and the live run proved it: a project whose video is
      // on disk still reported `video: false` with `renderPath: null`, because presence comes
      // from the STATE's slots and this project's state carried no video path at all (it was
      // downloaded before the state recorded one, so `vodPath` was the only owner).
      //
      // So a slot is FILLED when its artifact is unambiguously identifiable in the new folder
      // and the slot is empty. This is not a guess: `findArtifact` decides by role from the
      // FILENAME (the same rule every reader uses), so `- video.mp4` is the video and
      // `- proxy.mp4` is the proxy wherever they are found.
      const names = await this.fs.listFiles(dir).catch(() => [] as string[]);
      const slots: [keyof typeof state, ArtifactRole, keyof typeof state][] = [
        ["hqPath", "video", "hqMp4"],
        ["proxyPath", "proxy", "proxyMp4"],
      ];
      let filled = 0;
      let videoFilled = false;
      for (const [slot, role, mp4Slot] of slots) {
        const current = state[slot];
        if (typeof current === "string" && current.length > 0) continue; // already recorded
        const found = findArtifact(role, names, null);
        if (!found) continue;
        const path = `${dir}/${found}`;
        (state as unknown as Record<string, unknown>)[slot] = path;
        // The mp4 twin is the same file in this pipeline (one fragmented MP4 per role); a `.ts`
        // from the legacy era keeps its own twin unset rather than aliasing it.
        if (found.endsWith(".mp4")) {
          (state as unknown as Record<string, unknown>)[mp4Slot] = path;
        }
        if (role === "video") videoFilled = true;
        filled++;
      }
      if (filled > 0) {
        // The artifact is COMPLETE on disk, so its part must stop reporting a failure or a
        // stale size: that is what makes the row show a checkmark and the right bytes.
        const part = state.parts?.find((p) => (p.kind === "hq" && videoFilled) || (p.kind === "proxy" && !videoFilled));
        if (part && part.status !== "running") {
          part.status = "done";
          part.percent = 1;
          const filledPath = videoFilled
            ? (state as unknown as Record<string, unknown>).hqPath
            : (state as unknown as Record<string, unknown>).proxyPath;
          if (typeof filledPath === "string") {
            const bytes = await Deno.stat(filledPath).then((s) => s.size).catch(() => 0);
            if (bytes > 0) part.downloadedBytes = bytes;
          }
        }
        if (state.phase === "idle" || state.phase === "failed") state.phase = "done";
      }

      // Written when ANY of the three changed: paths repointed, slots filled, phase hydrated.
      if (result.repointed.length > 0 || filled > 0) {
        await this.orchestrator.setState(streamId, state);
      }
    }

    // The stream record holds the render source and the chat path. Re-derived from the new
    // folder only when the file is actually there — a missing video must NOT become a
    // plausible-looking path, and `vodPath` is never set to the proxy (Export renders from it).
    const recordCandidates: [string, string][] = [];
    for (const [key, value] of [
      ["vodPath", stream.vodPath],
      ["chatPath", stream.chatPath],
    ] as const) {
      if (!value) continue;
      const base = value.replace(/^.*[\\/]/, "");
      const candidate = `${dir}/${base}`;
      if (await this.fs.exists(candidate)) {
        recordCandidates.push([key, candidate]);
      } else {
        missing.push(value);
      }
    }

    const patch: Partial<Stream> = { projectDir: dir };
    for (const [key, value] of recordCandidates) {
      if (key === "vodPath") patch.vodPath = value;
      else patch.chatPath = value;
    }
    repointed += recordCandidates.length;

    const updated = await this.streams.update({ ...stream, ...patch });
    const result = updated ?? { ...stream, ...patch };

    // Every surface that shows the project's files re-reads: the location changed, so the
    // Library row, the settings rows and the download view all describe something else now.
    try {
      this.bus?.publish(STREAM_CHANGED_TOPIC, { type: "stream_changed", streamId, reason: "download" });
    } catch {
      // A failed announcement must never fail the move it describes.
    }

    return { stream: result, dir, repointed, missing };
  }
}
