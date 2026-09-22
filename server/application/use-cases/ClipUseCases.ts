import type { ClipRepository, StreamRepository } from "@/application/ports/outbound.ts";
import type { Clip, Axis } from "shared/types";
import { reject as rejectClip, createManualClip, clipEndFrom, markNotExported } from "@/domain/mod.ts";
import type { ThumbnailCache } from "@/adapters/outbound/media/thumbnails.ts";

export class ListClipsUseCase {
  constructor(private readonly clips: ClipRepository) {}

  async execute(streamId: string, filter?: { axis?: Axis; rejected?: boolean }): Promise<Clip[]> {
    return this.clips.listByStream(streamId, filter);
  }
}

export class GetClipUseCase {
  constructor(private readonly clips: ClipRepository) {}
  async execute(clipId: string): Promise<Clip | null> {
    return this.clips.findById(clipId);
  }
}

export class RejectClipUseCase {
  constructor(
    private readonly clips: ClipRepository,
    /** The thumbnail cache, if one exists — rejecting is a delete, so its derived file goes too. */
    private readonly thumbnails: ThumbnailCache | null = null,
  ) {}

  async execute(clipId: string): Promise<Clip> {
    const clip = await this.clips.findById(clipId);
    if (!clip) throw new Error(`Clip not found: ${clipId}`);
    const rejected = rejectClip(clip);
    await this.clips.update(rejected);
    // Reject is the whole delete verb (owner's choice: no row is ever removed), so anything
    // DERIVED from the clip goes with it. The thumbnail is regenerated on demand if the clip
    // is ever brought back, so dropping it costs nothing and leaving it would leave a file
    // for a clip the app no longer shows.
    await this.thumbnails?.remove(clip.streamId, clip.id);
    return rejected;
  }
}

/**
 * Creates a clip BY HAND at a playhead position — the manual-clip path (no engine involved).
 *
 * The end is computed rather than supplied: it runs to the next clip's start, else to the end
 * of the video (`clipEndFrom`, which owns that rule and its boundaries). The UI may still send
 * an explicit `endTime`, which is used verbatim.
 */
export class CreateClipUseCase {
  constructor(
    private readonly clips: ClipRepository,
    private readonly streams: StreamRepository,
  ) {}

  async execute(
    streamId: string,
    input: { startTime: number; endTime?: number | undefined },
  ): Promise<Clip> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);

    const startTime = Number(input.startTime);
    if (!Number.isFinite(startTime) || startTime < 0) {
      throw new Error("startTime must be a non-negative finite number");
    }

    const existing = await this.clips.listByStream(streamId);

    let endTime: number;
    if (input.endTime !== undefined) {
      endTime = Number(input.endTime);
      if (!Number.isFinite(endTime)) throw new Error("endTime must be a finite number");
      if (endTime - startTime < 0.5) {
        throw new Error("Clip too short: out must be at least 0.5s after in");
      }
    } else {
      endTime = clipEndFrom({
        startTime,
        duration: stream.duration ?? null,
        existingStartTimes: existing.map((c) => c.startTime),
      });
    }

    const clip = createManualClip({ streamId, startTime, endTime });
    await this.clips.save(clip);
    return clip;
  }
}

/** Persist user review edits (trim endpoints). Rejects inverted ranges. */
export class UpdateClipUseCase {
  constructor(private readonly clips: ClipRepository) {}
  async execute(
    clipId: string,
    patch: { startTime?: number; endTime?: number; title?: string | null },
  ): Promise<Clip> {
    const clip = await this.clips.findById(clipId);
    if (!clip) throw new Error(`Clip not found: ${clipId}`);
    const startTime = patch.startTime ?? clip.startTime;
    const endTime = patch.endTime ?? clip.endTime;
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
      throw new Error("Endpoints must be finite numbers");
    }
    if (endTime - startTime < 0.5) {
      throw new Error("Clip too short: out must be at least 0.5s after in");
    }
    // The clip's NAME, in its own column — never in `axis`. `axis` is an engine enum that
    // `isAxis` validates, the axis filter queries and axis-weight feedback aggregates; a typed
    // name stored there would fail validation on the next engine write, enter feedback as if it
    // were a detected axis, and erase the "manual clip = absence of axis" invariant.
    //
    // A blank name is REFUSED rather than stored: `null` already means "unnamed", so persisting
    // "" as well would spell the same absence two ways, and the panel would show an empty field
    // that reads as a failed edit. Clearing a name back to null is explicit (`title: null`).
    let title = clip.title;
    if (patch.title !== undefined) {
      title = patch.title === null ? null : patch.title.trim();
      if (title === "") throw new Error("A clip name cannot be empty — send null to clear it");
    }
    return this.clips.update({ ...clip, startTime, endTime, title });
  }
}

/**
 * Drop the `exported` mark for clips whose request has been withdrawn or replaced.
 *
 * ── WHY THIS IS A USE CASE AND NOT A REPOSITORY CALL ────────────────────────────────────────────
 * `exported`/`exportPath` are domain facts about a clip, so the rule for changing them belongs in a
 * use case, next to the other clip mutations — not in an HTTP route reaching into the repository.
 *
 * The rule: the mark describes the LAST ATTEMPT. Withdrawing a clip from the export list, or
 * re-sending it for export, makes the old mark describe something that is no longer true — a `✓
 * exported` badge beside a clip the user just removed, or beside one whose replacement encode has not
 * started. The FILE is never touched: it is the user's, and a list edit must not destroy an export.
 *
 * A clip that does not exist is skipped rather than throwing: this runs as a side effect of list and
 * queue edits, and a dangling reference must not fail the user's actual action.
 */
export class ClearExportedMarkUseCase {
  constructor(private readonly clips: ClipRepository) {}

  async execute(clipId: string): Promise<void> {
    const clip = await this.clips.findById(clipId);
    if (!clip) return;
    // Already unmarked: no write, so a repeated list edit is not a burst of pointless updates.
    if (!clip.exported && clip.exportPath === null) return;
    await this.clips.update(markNotExported(clip));
  }
}