import { spawnChild } from "@/adapters/outbound/process/spawn.ts";

/**
 * Clip thumbnails: one frame at a clip's start, extracted on demand and cached.
 *
 * WHY EXTRACT ON DEMAND rather than generating during processing: a clip's start can change
 * with every trim, and the panel shows clips that the engine has not finished producing, so a
 * batch pass would be both stale and late. Extraction is ~50ms per frame (measured on a real
 * proxy) and only ever happens once per (clip, start-time) pair.
 *
 * WHY THE PROXY IS THE SOURCE WHEN IT EXISTS: a thumbnail is a ~320px image. Decoding a
 * multi-GB HQ render for it wastes the seek on the largest possible file for no visible gain,
 * and the proxy is what the user is already looking at. The HQ path is the fallback for
 * projects that never had a proxy. This is the same preference the player uses, resolved from
 * the download state rather than from a guess.
 *
 * The cache is derived data and holds no state of its own: the file IS the cache. Nothing here
 * records what was generated — a missing file means "extract it", which is why the cache can
 * never disagree with the disk.
 */
export interface ThumbnailSource {
  /** Video file to extract from (proxy preferred, HQ fallback). */
  path: string;
  /** Seconds into that file — the clip's start. */
  timeSec: number;
}

export interface ThumbnailCache {
  /** Cached image bytes for that exact (clip, start) pair, or null when it has not been made. */
  read(streamId: string, clipId: string, atSec: number): Promise<Uint8Array | null>;
  /** Extract (if needed) and return image bytes. Throws when extraction fails. */
  get(streamId: string, clipId: string, atSec: number, source: ThumbnailSource | null): Promise<Uint8Array | null>;
  /** Drop EVERY cached image for the clip, whatever start times they were made at. */
  remove(streamId: string, clipId: string): Promise<void>;
  /** Path of one cached image (for tests and diagnostics). */
  pathFor(streamId: string, clipId: string, atSec: number): string;
}

/** Image dimensions. Wide enough to read a face, small enough that a panel of them is cheap. */
const THUMB_WIDTH = 320;

/**
 * The ffmpeg argv for one frame.
 *
 * `-ss` is placed BEFORE `-i` (input seeking), which seeks by keyframe index instead of
 * decoding everything up to the timestamp. `-frames:v 1` stops at the first frame. The scale
 * target is 320 wide with `-2` for height so the result is always even, which some encoders
 * require.
 */
export function thumbnailArgs(input: { path: string; timeSec: number; outPath: string }): string[] {
  return [
    "-y",
    "-ss", String(Math.max(0, input.timeSec)),
    "-i", input.path,
    "-frames:v", "1",
    "-vf", `scale=${THUMB_WIDTH}:-2`,
    "-q:v", "4",
    "-f", "image2",
    "-c:v", "mjpeg",
    input.outPath,
  ];
}

export class FfmpegThumbnailCache implements ThumbnailCache {
  constructor(
    private readonly thumbDirFor: (streamId: string) => string,
    private readonly binaryPath = "ffmpeg",
  ) {}

  /**
   * ONE file per clip, named for the start time it was drawn from; any other name is stale.
   *
   * Two wrong designs were possible here and both are avoided by this shape:
   *
   * - Keyed by the clip id alone, a trim would keep serving the OLD frame for ever (the file
   *   still exists, and a query-string cache-buster cannot change which file the server reads).
   * - Keyed by `{clipId}@{start}`, the extraction follows the START, and the endpoint drag in
   *   `Timeline` PATCHes on every `pointermove` with no debounce — so dragging an in-point for
   *   five seconds would leave a file per pixel moved, none of which any surface can name again.
   *
   * So the name carries the start (staleness is impossible) AND the filename is replaced rather
   * than accumulated: `get` writes the new file FIRST and only then removes the other names.
   * A file whose mtime is newer than the newest live file — still being written — is never a
   * deletion candidate, which is what makes a concurrent read safe.
   */
  pathFor(streamId: string, clipId: string, atSec: number): string {
    const key = Math.round(Math.max(0, atSec) * 1000) / 1000;
    return `${this.thumbDirFor(streamId)}/${clipId}@${key}.jpg`;
  }

  async read(streamId: string, clipId: string, atSec: number): Promise<Uint8Array | null> {
    try {
      return await Deno.readFile(this.pathFor(streamId, clipId, atSec));
    } catch (e) {
      if (e instanceof Deno.errors.NotFound) return null;
      throw e;
    }
  }

  async get(
    streamId: string,
    clipId: string,
    atSec: number,
    source: ThumbnailSource | null,
  ): Promise<Uint8Array | null> {
    const cached = await this.read(streamId, clipId, atSec);
    if (cached) return cached;
    // Nothing cached and nothing to extract from: an honest null (the caller renders a
    // placeholder), never a fabricated frame.
    if (!source) return null;
    if (!(await Deno.stat(source.path).then(() => true).catch(() => false))) return null;

    const out = this.pathFor(streamId, clipId, atSec);
    await Deno.mkdir(this.thumbDirFor(streamId), { recursive: true });
    await this.extract(thumbnailArgs({ path: source.path, timeSec: atSec, outPath: out }));

    // Read back what ffmpeg actually wrote — the file is the proof extraction happened, and a
    // run that exits 0 without producing a frame must not read as success.
    const bytes = await this.read(streamId, clipId, atSec);
    if (bytes) await this.dropOtherFrames(streamId, clipId, out);
    return bytes;
  }

  /** Frames for this clip other than `keep`, except ones newer than `keep` (still being written). */
  private async dropOtherFrames(streamId: string, clipId: string, keep: string): Promise<void> {
    const dir = this.thumbDirFor(streamId);
    let keepMtime: number;
    try {
      keepMtime = (await Deno.stat(keep)).mtime?.getTime() ?? 0;
    } catch {
      return;
    }
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (!entry.isFile || !this.isFrameFor(entry.name, clipId)) continue;
        const p = `${dir}/${entry.name}`;
        if (p === keep) continue;
        const mt = (await Deno.stat(p)).mtime?.getTime() ?? 0;
        if (mt > keepMtime) continue; // an in-flight write for another start: not ours to delete
        await Deno.remove(p).catch(() => {});
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  /** `{clipId}@{start}.jpg` — the id is a UUID, so the `@` cannot collide across clips. */
  private isFrameFor(name: string, clipId: string): boolean {
    return name.startsWith(`${clipId}@`) && name.endsWith(".jpg");
  }

  async remove(streamId: string, clipId: string): Promise<void> {
    // EVERY start time for this clip, not just the current one: a trimmed clip can have left an
    // older-named frame, and reject is the delete verb. A frame no surface can name again is
    // exactly the orphan this codebase has produced before.
    const dir = this.thumbDirFor(streamId);
    try {
      for await (const entry of Deno.readDir(dir)) {
        if (entry.isFile && this.isFrameFor(entry.name, clipId)) {
          await Deno.remove(`${dir}/${entry.name}`);
        }
      }
    } catch (e) {
      if (!(e instanceof Deno.errors.NotFound)) throw e;
    }
  }

  private async extract(args: string[]): Promise<void> {
    const child = spawnChild(this.binaryPath, { args, stdout: "null", stderr: "piped" });
    const reader = child.stderr?.getReader();
    let tail = "";
    const drain = (async () => {
      if (!reader) return;
      const decoder = new TextDecoder();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (value) tail = (tail + decoder.decode(value, { stream: true })).slice(-2000);
          if (done) break;
        }
      } catch {
        // stderr closed.
      }
    })();
    const status = await child.status;
    await drain;
    if (!status.success) {
      throw new Error(`thumbnail extraction failed (exit ${status.code}): ${tail.slice(-200)}`);
    }
  }
}
