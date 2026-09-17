/**
 * TS→MP4 remux helper — Chromium <video> refuses raw MPEG-TS (verified:
 * headless Thorium fires `error` on video/mp2t in <video>), so every .ts
 * the orchestrator produces needs an mp4 twin for playback. Stream-copy
 * remux is ~4200× realtime (0.2s per 10.5 min of 540p), so re-running it
 * over the downloaded prefix is effectively free.
 */
import { run, runStatus } from "@/adapters/outbound/process/spawn.ts";
import { join } from "node:path";

export interface RemuxOptions {
  /** Resolved by resolveToolPaths — never a bare name in a packaged build. */
  ffmpegPath: string;
}

/** Remux src.ts → dst.mp4 (stream copy + faststart). Non-throwing: returns
 *  true when the mp4 was written, false when ffmpeg failed — the .ts stays
 *  the source of truth either way. */
export async function remuxToMp4(srcTs: string, dstMp4: string, opts: RemuxOptions): Promise<boolean> {
  const tmp = `${dstMp4}.part`;
  const status = await runStatus(opts.ffmpegPath, {
    args: ["-y", "-i", srcTs, "-c", "copy", "-movflags", "+faststart", "-f", "mp4", tmp],
    stdout: "null", stderr: "null",
  });
  try {
    if (!status.success) {
      await Deno.remove(tmp).catch(() => {});
      return false;
    }
    // Atomic-ish swap so the video route never sees a half-written mp4.
    await Deno.rename(tmp, dstMp4);
    return true;
  } catch {
    await Deno.remove(tmp).catch(() => {});
    return false;
  }
}

/** Default mp4 twin path for a .ts file. */
export function mp4Twin(tsPath: string): string {
  return tsPath.replace(/\.ts$/, ".mp4");
}