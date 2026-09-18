/**
 * Download and install ffmpeg/ffprobe into app data, on the user's say-so.
 *
 * This is the acquisition half of the "don't bundle it" decision (see
 * tool-paths.ts for why). The app never starts a multi-hundred-MB download on its
 * own: the UI asks, because a desktop app that silently pulls 65-82MB the first
 * time it touches a VOD is a bad citizen, and a user behind a metered link
 * deserves the choice.
 *
 * Two properties matter for correctness:
 *   - The extract lands under `<managedDir>/bin/` + `lib/`, which is exactly the
 *     layout the upstream archive uses inside its inner directory. ffmpeg must
 *     keep its sibling lib/ tree or a `-shared` build cannot start.
 *   - Nothing is moved into place until the binaries exist and report a version,
 *     so a truncated download can never leave a half-installed tree that
 *     `discover()` would then treat as valid.
 */
import { run, runStatus } from "@/adapters/outbound/process/spawn.ts";
import { join } from "node:path";
import { archiveFor, type ToolArchive } from "./tool-paths.ts";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS } from "@/adapters/outbound/net/fetch-timeout.ts";

export interface ProvisionProgress {
  phase: "downloading" | "extracting" | "verifying";
  bytesDownloaded: number;
  totalBytes: number;
  percent: number;
}

export interface ProvisionResult {
  ffmpeg: string;
  ffprobe: string;
}

const FFMPEG_EXE = Deno.build.os === "windows" ? "ffmpeg.exe" : "ffmpeg";
const FFPROBE_EXE = Deno.build.os === "windows" ? "ffprobe.exe" : "ffprobe";

function log(message: string): void {
  console.log(`ffmpeg provision: ${message}`);
}

/**
 * Fetches and installs the pinned build for this platform.
 *
 * `onProgress` fires while downloading (the only phase with a known total). The
 * whole archive is buffered to a temp file first — these builds are 65-82MB, and
 * streaming an extract out of a partially-received archive is how you get a
 * corrupt install.
 */
export async function provisionFfmpeg(
  managedDir: string,
  opts: {
    signal?: AbortSignal | undefined;
    onProgress?: ((p: ProvisionProgress) => void) | undefined;
  } = {},
): Promise<ProvisionResult> {
  const archive: ToolArchive = archiveFor();
  await Deno.mkdir(managedDir, { recursive: true });

  const tmp = await Deno.makeTempFile({ prefix: "semaclip-ffmpeg-", suffix: `.${archive.ext}` });
  try {
    await download(archive.url, tmp, opts);
    if (opts.signal?.aborted) throw new Error("ffmpeg provisioning was cancelled");

    opts.onProgress?.({ phase: "extracting", bytesDownloaded: 0, totalBytes: 0, percent: 1 });
    await extract(archive, tmp, managedDir);

    opts.onProgress?.({ phase: "verifying", bytesDownloaded: 0, totalBytes: 0, percent: 1 });
    const ffmpeg = join(managedDir, "bin", FFMPEG_EXE);
    const ffprobe = join(managedDir, "bin", FFPROBE_EXE);
    await assertRunnable(ffmpeg, "-version");
    await assertRunnable(ffprobe, "-version");
    log(`installed into ${managedDir}`);
    return { ffmpeg, ffprobe };
  } finally {
    await Deno.remove(tmp).catch(() => {});
  }
}

async function download(
  url: string,
  dest: string,
  opts: { signal?: AbortSignal | undefined; onProgress?: ((p: ProvisionProgress) => void) | undefined },
): Promise<void> {
  // Retry from scratch: a truncated body is the common failure on a large asset,
  // and curl's own --retry does not cover it. Three attempts, clean each time.
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // MEDIA budget: this transfers a runtime binary (~80MB for ffmpeg).
      const res = await fetchWithTimeout(
        url,
        { redirect: "follow", ...(opts.signal ? { signal: opts.signal } : {}) },
        MEDIA_TIMEOUT_MS,
      );
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const total = Number(res.headers.get("content-length") ?? 0);
      const file = await Deno.open(dest, { write: true, create: true, truncate: true });
      let received = 0;
      try {
        if (res.body) {
          for await (const chunk of res.body) {
            await file.write(chunk);
            received += chunk.length;
            opts.onProgress?.({
              phase: "downloading",
              bytesDownloaded: received,
              totalBytes: total,
              percent: total ? received / total : 0,
            });
          }
        }
      } finally {
        file.close();
      }
      if (total && received !== total) {
        throw new Error(`truncated download: got ${received} of ${total} bytes`);
      }
      return;
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      lastError = err;
      log(`attempt ${attempt} failed: ${err instanceof Error ? err.message : err}`);
      await Deno.remove(dest).catch(() => {});
      if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
  throw new Error(`ffmpeg download failed after 3 attempts: ${
    lastError instanceof Error ? lastError.message : lastError
  }`);
}

/**
 * tar/unzip both ship with Windows 10+ and every Linux, so no JS archive library
 * is needed. The inner directory is flattened into <managedDir>/{bin,lib,…}.
 */
async function extract(archive: ToolArchive, file: string, managedDir: string): Promise<void> {
  const staging = `${managedDir}.staging`;
  await Deno.remove(staging, { recursive: true }).catch(() => {});
  await Deno.mkdir(staging, { recursive: true });

  const status = await run("tar", {
    args: archive.ext === "zip" ? ["-xf", file, "-C", staging] : ["-xJf", file, "-C", staging],
  });
  if (!status.success) {
    throw new Error(`extract failed: ${new TextDecoder().decode(status.stderr).trim()}`);
  }

  const inner = join(staging, archive.inner);
  try {
    await Deno.stat(inner);
  } catch {
    throw new Error(`archive did not contain the expected directory ${archive.inner}`);
  }

  // Move bin/ and lib/ (and anything else) up one level, then drop the staging
  // tree so a failed install cannot masquerade as a partial one.
  await Deno.remove(managedDir, { recursive: true }).catch(() => {});
  await Deno.mkdir(managedDir, { recursive: true });
  for await (const entry of Deno.readDir(inner)) {
    await Deno.rename(join(inner, entry.name), join(managedDir, entry.name));
  }
  await Deno.remove(staging, { recursive: true }).catch(() => {});

  // The binaries must be executable; a tar from a non-POSIX source can lose that.
  if (Deno.build.os !== "windows") {
    await Deno.chmod(join(managedDir, "bin", FFMPEG_EXE), 0o755).catch(() => {});
    await Deno.chmod(join(managedDir, "bin", FFPROBE_EXE), 0o755).catch(() => {});
  }
}

async function assertRunnable(binary: string, flag: string): Promise<void> {
  // run() reports a spawn failure as a result, so no .catch is needed to keep the
  // "did it actually run" check below meaningful.
  const status = await run(binary, { args: [flag] });
  if (!status?.success) {
    throw new Error(`${binary} did not run after installation`);
  }
}
