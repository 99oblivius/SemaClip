import type { ClipRepository } from "@/application/ports/outbound.ts";
import type { Clip, Axis } from "shared/types";
import { reject as rejectClip } from "@/domain/mod.ts";

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
  constructor(private readonly clips: ClipRepository) {}
  async execute(clipId: string): Promise<Clip> {
    const clip = await this.clips.findById(clipId);
    if (!clip) throw new Error(`Clip not found: ${clipId}`);
    const rejected = rejectClip(clip);
    await this.clips.update(rejected);
    return rejected;
  }
}

/** Persist user review edits (trim endpoints). Rejects inverted ranges. */
export class UpdateClipUseCase {
  constructor(private readonly clips: ClipRepository) {}
  async execute(
    clipId: string,
    patch: { startTime?: number; endTime?: number },
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
    return this.clips.update({ ...clip, startTime, endTime });
  }
}