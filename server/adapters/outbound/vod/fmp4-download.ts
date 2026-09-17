/**
 * Streaming fMP4 download of an HLS playlist.
 *
 * Fetched chunks pipe into a long-lived ffmpeg (`-c copy -bsf:a
 * aac_adtstoasc -movflags frag_keyframe+empty_moov+default_base_moof`) whose
 * stdout is the growing media file. A tee between ffmpeg and the file feeds
 * `Fmp4BoxParser`, so the fragment index is built from the bytes actually
 * written — no second pass, no remux, no twin.
 *
 * Why a long-lived ffmpeg rather than one process per chunk: the muxer owns
 * the `moov` init segment and the fragment sequence numbers, so restarting
 * it per chunk would emit a new init segment into the middle of the file.
 *
 * Cancel is honest: the ffmpeg child is killed, its partial output is kept
 * (resume re-muxes from the last complete fragment), and the error propagates.
 */
import { Fmp4BoxParser, serializeIndex, type FragmentIndex, type FragmentSpan } from "./fmp4.ts";
import { spawnChild } from "@/adapters/outbound/process/spawn.ts";

export interface Fmp4DownloadProgress {
  downloadedSec: number;
  totalSec: number;
  bytes: number;
  percent: number;
}

export interface Fmp4DownloadOptions {
  onProgress: (p: Fmp4DownloadProgress) => void;
  /** Fired for each completed fragment with its byte span. */
  onFragment?: ((span: FragmentSpan) => void) | undefined;
  signal?: AbortSignal | undefined;
  lookahead?: number;
  /** Resume: seconds already muxed into the output file. Chunks fully below
   *  this point are skipped. */
  resumeSec?: number;
  /** Resolved by resolveToolPaths — never a bare name in a packaged build. */
  ffmpegPath: string;
  /**
   * Sidecar path for the fragment index. Written INCREMENTALLY as fragments
   * complete — the media route reads it to clamp Range responses to a
   * complete fragment, so a stale/absent file means mid-download playback
   * is served past the frontier and dies with PIPELINE_ERROR_DECODE.
   */
  indexPath?: string | undefined;
}

const CHUNK_RETRY_ATTEMPTS = 6;

async function fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < CHUNK_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    try {
      const res = await fetch(url, signal ? { signal } : {});
      if (res.ok) return res;
      lastErr = new Error(`chunk fetch ${res.status}: ${url}`);
      // 4xx other than 429 will not heal — fail fast.
      if (res.status < 500 && res.status !== 429) throw lastErr;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
    }
    const backoffMs = Math.min(32_000, 1000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function parseMediaPlaylist(text: string, base: string): { url: string; durationSec: number }[] {
  const chunks: { url: string; durationSec: number }[] = [];
  let pendingDuration: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      const dur = parseFloat(line.slice(8).split(",")[0] ?? "");
      pendingDuration = Number.isFinite(dur) ? dur : null;
    } else if (line !== "" && !line.startsWith("#") && pendingDuration !== null) {
      const url = line.startsWith("http") ? line : new URL(line, base).href;
      chunks.push({ url, durationSec: pendingDuration });
      pendingDuration = null;
    }
  }
  return chunks;
}

/**
 * Downloads `playlistUrl` into `destPath` as a growing fragmented MP4.
 * Resolves with the fragment index when the whole playlist is muxed.
 */
export async function downloadFmp4(
  playlistUrl: string,
  destPath: string,
  opts: Fmp4DownloadOptions,
): Promise<FragmentIndex> {
  const playlistRes = await fetch(playlistUrl);
  if (!playlistRes.ok) throw new Error(`playlist fetch ${playlistRes.status}: ${playlistUrl}`);
  const chunks = parseMediaPlaylist(await playlistRes.text(), playlistUrl);
  if (chunks.length === 0) throw new Error("Media playlist has no chunks");

  const totalSec = chunks.reduce((s, c) => s + c.durationSec, 0);
  const resumeSec = Math.max(0, opts.resumeSec ?? 0);
  // First chunk not fully covered by the resumed prefix. The muxer re-emits
  // from the next fragment boundary, so a straddling chunk re-downloads.
  let skippedSec = 0;
  let firstIndex = 0;
  while (firstIndex < chunks.length && skippedSec + chunks[firstIndex]!.durationSec <= resumeSec + 1e-6) {
    skippedSec += chunks[firstIndex]!.durationSec;
    firstIndex++;
  }

  // The init segment is written once, at the start; on resume the file
  // already holds it plus fragments, so ffmpeg must APPEND its fragments
  // after the existing ones. A fresh muxer cannot do that — so a resume
  // re-muxes the whole file from the first fragment (see `resume` note in
  // references/growing-media-formats.md): correctness over cleverness.
  const resuming = firstIndex > 0 && resumeSec > 0;
  const dest = await Deno.open(destPath, {
    write: true,
    create: true,
    append: false,
    truncate: true,
  });

  const parser = new Fmp4BoxParser();
  parser.onFragment = opts.onFragment;
  let bytes = 0;
  let downloadedSec = 0;
  let lastReportAt = 0;

  // Incremental index sidecar. Rewritten atomically (tmp + rename) on each
  // new fragment so the media route never reads a half-written index.
  const indexWriter = opts.indexPath
    ? (() => {
      const path = opts.indexPath!;
      const tmp = `${path}.tmp`;
      let pending = false;
      const flush = async () => {
        if (pending) return;
        pending = true;
        try {
          await Deno.writeTextFile(tmp, serializeIndex(parser.index));
          await Deno.rename(tmp, path);
        } catch {
          // Best-effort: a missing index degrades clamping, never the download.
        } finally {
          pending = false;
        }
      };
      return { flush };
    })()
    : null;
  parser.onFragment = (span) => {
    opts.onFragment?.(span);
    void indexWriter?.flush();
  };

  const ffmpeg = spawnChild(opts.ffmpegPath, {
    args: [
      "-hide_banner", "-loglevel", "error",
      "-f", "mpegts", "-i", "pipe:0",
      "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4", "pipe:1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  // Drain ffmpeg stderr so a mux failure is visible instead of hanging.
  let stderrTail = "";
  const stderrDone = (async () => {
    const dec = new TextDecoder();
    if (!ffmpeg.stderr) return;
    for await (const part of ffmpeg.stderr) {
      stderrTail = (stderrTail + dec.decode(part, { stream: true })).slice(-2000);
    }
  })();

  const writeChunk = async (data: Uint8Array): Promise<void> => {
    // stdin is piped by construction above; the guard makes that explicit rather
    // than an unchecked assertion.
    const writer = ffmpeg.stdin?.getWriter();
    if (!writer) return;
    try {
      await writer.write(data);
    } finally {
      writer.releaseLock();
    }
  };

  /** Pump ffmpeg stdout into the file + parser. */
  const pump = (async () => {
    if (!ffmpeg.stdout) throw new Error("ffmpeg stdout was not piped — cannot capture the muxed mp4");
    for await (const part of ffmpeg.stdout) {
      const slice = part instanceof Uint8Array ? part : new Uint8Array(part);
      await dest.write(slice);
      bytes += slice.byteLength;
      parser.push(slice);
      const now = performance.now();
      if (now - lastReportAt > 500) {
        lastReportAt = now;
        opts.onProgress({
          downloadedSec,
          totalSec,
          bytes,
          percent: totalSec > 0 ? downloadedSec / totalSec : 0,
        });
      }
    }
  })();

  try {
    const inFlight = new Map<number, Promise<{ index: number; data: Uint8Array }>>();
    const reorder = new Map<number, { index: number; data: Uint8Array }>();
    const lookahead = Math.max(1, opts.lookahead ?? 3);
    let nextFetch = firstIndex;
    let nextWrite = firstIndex;

    const fetchOne = (index: number) =>
      fetchWithRetry(chunks[index]!.url, opts.signal).then(async (res) => ({
        index,
        data: new Uint8Array(await res.arrayBuffer()),
      }));

    while (nextWrite < chunks.length) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      while (nextFetch < chunks.length && inFlight.size < lookahead) {
        const i = nextFetch++;
        inFlight.set(i, fetchOne(i));
      }
      const winner = await Promise.race([...inFlight.entries()].map(([i, p]) => p.then(() => i)));
      const done = (await inFlight.get(winner!))!;
      inFlight.delete(winner!);
      reorder.set(done.index, done);
      while (reorder.has(nextWrite)) {
        const ready = reorder.get(nextWrite)!;
        reorder.delete(nextWrite);
        await writeChunk(ready.data);
        downloadedSec += chunks[ready.index]!.durationSec;
        opts.onProgress({
          downloadedSec,
          totalSec,
          bytes,
          percent: totalSec > 0 ? downloadedSec / totalSec : 0,
        });
        nextWrite++;
      }
    }
    // Close stdin so ffmpeg flushes its final fragment and exits.
    await ffmpeg.stdin?.close().catch(() => {});
    await pump;
    await stderrDone;
    const status = await ffmpeg.status;
    if (!status.success) {
      throw new Error(`ffmpeg mux failed (${status.code}): ${stderrTail.trim() || "no stderr"}`);
    }
    await indexWriter?.flush();
    void resuming;
    return parser.index;
  } catch (err) {
    // Cancel: kill the muxer and keep the partial file (resume re-muxes).
    try {
      ffmpeg.kill("SIGKILL");
    } catch {
      // already gone
    }
    await pump.catch(() => {});
    await stderrDone.catch(() => {});
    throw err;
  } finally {
    try {
      dest.close();
    } catch {
      // already closed
    }
  }
}
