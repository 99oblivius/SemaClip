/**
 * Locate ffmpeg/ffprobe, and fetch them on demand when the machine has neither.
 *
 * WHY NOT BUNDLE. An earlier design embedded a static ffmpeg pair in the app
 * (`native/ffmpeg/<os>-<arch>/`) to make the binary "standalone". That was the
 * wrong call, and the cost was concrete: it added ~330MB to a ~550MB payload,
 * which made CI artifact downloads truncate, made bsdiff patches need more RAM
 * than a runner has, and made first launch spend ~20s extracting a virtual
 * filesystem. Bundling a 164MB ffmpeg into every installer is also the outlier —
 * Electron, Tauri, OBS and HandBrake all resolve an existing ffmpeg and ask the
 * user before fetching one. SemaClip needs ffmpeg at job/export time, never at
 * launch, so there is nothing to buy by shipping it.
 *
 * RESOLUTION ORDER (first hit wins):
 *   1. SEMACLIP_FFMPEG / SEMACLIP_FFPROBE — explicit override, also what the
 *      Settings screen targets when someone points at a custom build.
 *   2. The managed directory in app data, where an approved download lands.
 *   3. PATH — a system ffmpeg beats downloading anything: already installed,
 *      already updated by the distro, costs no disk.
 * Order matters: a managed build is preferred over PATH so an approved download
 * keeps being used, but PATH comes before "offer a download" so a machine that
 * already has ffmpeg is never asked to fetch a second copy.
 *
 * The registry is mutable by design. Adapters take paths at construction time, so
 * a path resolved before a download would go stale — read `registry.ffmpeg` at
 * spawn time and a post-download `refresh()` is all it takes.
 */
import { dirname, join } from "node:path";

export interface ToolPaths {
  ffmpeg: string;
  ffprobe: string;
  /**
   * Where the binaries came from. "missing" is a real source value, not an error:
   * it says discovery found nothing, which is the only thing availability may be
   * derived from.
   */
  source: "env" | "managed" | "path" | "missing";
}

/** One downloadable build per target platform, pinned to a dated release tag. */
export interface ToolArchive {
  url: string;
  /** Directory the archive's bin/ and lib/ live under once extracted. */
  inner: string;
  ext: "tar.xz" | "zip";
}

/**
 * BtbN's static builds, pinned to a DATED tag. Dated tags carry build-hash asset
 * names; the `master-latest` names exist only under the moving `latest` tag and
 * 404 at a dated one (verified).
 *
 * The `-shared` variants are chosen deliberately: 65-82MB against 144-185MB for
 * the fully static ones. Size matters for a user-initiated download, and the
 * extractor keeps the accompanying lib/ tree so the binaries still run.
 */
const ARCHIVES: Record<string, ToolArchive> = {
  "linux-x64": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-16-19-44/ffmpeg-N-126593-gbc46eab87c-linux64-gpl-shared.tar.xz",
    inner: "ffmpeg-N-126593-gbc46eab87c-linux64-gpl-shared",
    ext: "tar.xz",
  },
  "linux-arm64": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-16-19-44/ffmpeg-N-126593-gbc46eab87c-linuxarm64-gpl-shared.tar.xz",
    inner: "ffmpeg-N-126593-gbc46eab87c-linuxarm64-gpl-shared",
    ext: "tar.xz",
  },
  "win-x64": {
    url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-16-19-44/ffmpeg-N-126593-gbc46eab87c-win64-gpl-shared.zip",
    inner: "ffmpeg-N-126593-gbc46eab87c-win64-gpl-shared",
    ext: "zip",
  },
};

export function hostPlatform(): string {
  if (Deno.build.os === "windows") return "win-x64";
  return Deno.build.arch === "aarch64" ? "linux-arm64" : "linux-x64";
}

export function archiveFor(platform = hostPlatform()): ToolArchive {
  const archive = ARCHIVES[platform];
  if (!archive) throw new Error(`no ffmpeg build is known for platform ${platform}`);
  return archive;
}

function exeName(base: string): string {
  return Deno.build.os === "windows" ? `${base}.exe` : base;
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Probes PATH the way a shell would, without spawning anything. A bare-name spawn
 * would also work, but it throws ENOENT from wherever the spawn happens — this
 * lets the UI ask about a download before any work starts.
 */
async function onPath(name: string): Promise<boolean> {
  const path = Deno.env.get("PATH") ?? "";
  const separator = Deno.build.os === "windows" ? ";" : ":";
  for (const dir of path.split(separator)) {
    if (dir && await isExecutable(join(dir, name))) return true;
  }
  return false;
}

async function discover(managedDir: string): Promise<ToolPaths> {
  const ffmpeg = exeName("ffmpeg");
  const ffprobe = exeName("ffprobe");

  const envFfmpeg = Deno.env.get("SEMACLIP_FFMPEG");
  const envFfprobe = Deno.env.get("SEMACLIP_FFPROBE");
  if (envFfmpeg && envFfprobe) {
    return { ffmpeg: envFfmpeg, ffprobe: envFfprobe, source: "env" };
  }

  const managedFfmpeg = join(managedDir, "bin", ffmpeg);
  const managedFfprobe = join(managedDir, "bin", ffprobe);
  if (await isExecutable(managedFfmpeg) && await isExecutable(managedFfprobe)) {
    return { ffmpeg: managedFfmpeg, ffprobe: managedFfprobe, source: "managed" };
  }

  if (await onPath(ffmpeg) && await onPath(ffprobe)) {
    return { ffmpeg, ffprobe, source: "path" };
  }

  // Nothing usable. source "missing" is DISTINCT from "path" on purpose: returning
  // "path" here made "found on PATH" and "found nothing" the same value, so any
  // consumer deriving availability from it disagreed with the real answer.
  return { ffmpeg, ffprobe, source: "missing" };
}

export interface ToolStatus {
  paths: ToolPaths;
  /** False when the binaries are missing and must be provisioned. */
  available: boolean;
  /** True when a user-approved download could supply them. */
  downloadable: boolean;
  /** Where an approved download would be installed. */
  managedDir: string;
  platform: string;
}

/**
 * Resolves and remembers the tool paths. Construct once at boot, hand it to every
 * adapter, and call `refresh()` after provisioning.
 */
export class ToolRegistry {
  #paths: ToolPaths;
  #available: boolean;
  readonly #managedDir: string;

  private constructor(paths: ToolPaths, available: boolean, managedDir: string) {
    this.#paths = paths;
    this.#available = available;
    this.#managedDir = managedDir;
  }

  /** `dataDir` is app data; downloads live under `<dataDir>/tools/ffmpeg/…`. */
  static async create(dataDir: string): Promise<ToolRegistry> {
    const managedDir = join(dataDir, "tools", "ffmpeg", hostPlatform());
    const paths = await discover(managedDir);
    // Discovery already established whether the binaries exist; re-deriving it here
    // was the second owner of the same fact and is what produced the contradiction.
    return new ToolRegistry(paths, paths.source !== "missing", managedDir);
  }

  get ffmpeg(): string {
    return this.#paths.ffmpeg;
  }

  get ffprobe(): string {
    return this.#paths.ffprobe;
  }

  get paths(): ToolPaths {
    return { ...this.#paths };
  }

  /** Re-resolve after a download or a settings change. */
  async refresh(): Promise<ToolPaths> {
    this.#paths = await discover(this.#managedDir);
    this.#available = this.#paths.source !== "missing";
    return this.paths;
  }

  status(): ToolStatus {
    return {
      paths: this.paths,
      available: this.#available,
      // An env override means the user already decided where ffmpeg lives.
      downloadable: !this.#available && this.#paths.source !== "env",
      managedDir: this.#managedDir,
      platform: hostPlatform(),
    };
  }
}

/** Directory holding a resolved binary — Linux needs it on LD_LIBRARY_PATH. */
export function toolBinDir(path: string): string {
  return dirname(path);
}
