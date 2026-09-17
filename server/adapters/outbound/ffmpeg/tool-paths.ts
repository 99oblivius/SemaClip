/**
 * Resolve the ffmpeg/ffprobe binaries this process should run.
 *
 * A compiled desktop build does NOT embed ffmpeg, and the adapters historically
 * spawned the bare names `ffmpeg`/`ffprobe`, which only work when the user
 * happens to have them on PATH. That is the difference between a standalone
 * binary and one that silently cannot download, probe, transcode or export on
 * anyone else's machine.
 *
 * Resolution order (first hit wins):
 *   1. An explicit override — SEMACLIP_FFMPEG / SEMACLIP_FFPROBE. Highest
 *      priority so a user can point at a system or custom build.
 *   2. The bundled native tree, `native/ffmpeg/<os-dir>/`, which is what the
 *      packaged app ships and what `scripts/fetch-native.sh` populates. Both
 *      binaries normally live in the same directory, so one directory hit
 *      resolves both.
 *   3. The bare name, i.e. PATH. Keeps dev runs working on a machine that has
 *      ffmpeg installed but no fetched native tree.
 *
 * Path probing is async and must happen BEFORE the container is built, because
 * every adapter takes its binary path at construction time.
 */
import { dirname, fromFileUrl, join } from "@std/path";

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  /** Where the binaries came from — logged at boot so a wrong pick is visible. */
  source: "env" | "bundled" | "path";
}

/** Per-OS subdir under native/ffmpeg, matching the whisper tree's convention. */
function osDir(): string {
  if (Deno.build.os === "windows") return "win-x64";
  return Deno.build.os === "darwin" ? "macos-arm64" : "linux-x64";
}

function exeName(base: string): string {
  return Deno.build.os === "windows" ? `${base}.exe` : base;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    const stat = await Deno.stat(path);
    return stat.isFile;
  } catch {
    return false;
  }
}

/**
 * @param nativeRoot URL of the `native/` directory (caller owns the layout, so
 *   this module never guesses where the repo is).
 */
export async function resolveToolPaths(nativeRoot: URL): Promise<ToolPaths> {
  const ffmpeg = exeName("ffmpeg");
  const ffprobe = exeName("ffprobe");

  const envFfmpeg = Deno.env.get("SEMACLIP_FFMPEG");
  const envFfprobe = Deno.env.get("SEMACLIP_FFPROBE");
  if (envFfmpeg && envFfprobe) {
    return { ffmpeg: envFfmpeg, ffprobe: envFfprobe, source: "env" };
  }

  const bundledDir = fromFileUrl(new URL(`ffmpeg/${osDir()}/`, nativeRoot));
  const bundledFfmpeg = join(bundledDir, ffmpeg);
  const bundledFfprobe = join(bundledDir, ffprobe);
  if (await isExecutable(bundledFfmpeg) && await isExecutable(bundledFfprobe)) {
    return { ffmpeg: bundledFfmpeg, ffprobe: bundledFfprobe, source: "bundled" };
  }

  return { ffmpeg, ffprobe, source: "path" };
}

/** Directory holding a resolved binary — Linux needs it on LD_LIBRARY_PATH. */
export function toolBinDir(path: string): string {
  return dirname(path);
}
