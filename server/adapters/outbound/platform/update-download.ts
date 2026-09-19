/**
 * Download an update payload while the app is still running, reporting progress, and verify it
 * before anything is allowed to install it.
 *
 * ── WHY THIS IS ITS OWN MODULE ─────────────────────────────────────────────────────────────
 * Both platforms need the same three things and had different halves of them:
 *
 *   Linux  downloaded while the app ran, but buffered the entire payload with
 *          `new Uint8Array(await res.arrayBuffer())` and reported nothing. A 100MB update was 100MB
 *          of resident memory and a UI that looked hung, which is worse than the stall it replaced.
 *   Windows waited until the app had already QUIT, so there was nothing to show progress in and no
 *          moment at which the user could be told to keep the window open.
 *
 * The sequence the owner asked for is the one that makes sense: download to a staged file while the
 * app is open and usable, show how far along it is, and only once the bytes are on disk and verified
 * close, swap and relaunch. Nothing here quits anything — the callers do that, after this resolves.
 *
 * ── CONSTANT MEMORY, AND A HASH THAT ARRIVES WITH THE BYTES ─────────────────────────────────
 * Chunks are written straight to the file and fed to an INCREMENTAL digest, so peak memory is one
 * chunk regardless of payload size. Buffering the chunks to hash them at the end would have been the
 * same mistake as the `arrayBuffer()` version: 100MB of resident memory for a 100MB update, on a
 * machine that may be mid-transcode.
 *
 * `node:crypto`'s createHash is used because `crypto.subtle` is ONE-SHOT — there is no streaming
 * digest in the web API, and the repo already imports `node:` modules elsewhere (node:sqlite,
 * node:path), so this is consistent rather than novel. Verified equivalent to the one-shot API on
 * the same bytes.
 *
 * ── WHY THE HASH IS CHECKED BEFORE THE FILE IS TRUSTED ──────────────────────────────────────
 * The download goes to `dest.part` and is renamed only after the hash matches, so an interrupted or
 * tampered download cannot leave something a later run would install.
 */
import { createHash } from "node:crypto";

export interface DownloadProgress {
  /** Bytes received so far. */
  received: number;
  /** Total bytes, or 0 when the server did not declare one. */
  total: number;
  /** 0..1, or null when the total is unknown — the UI must not invent a percentage. */
  fraction: number | null;
}

export interface DownloadResult {
  ok: boolean;
  /** Bytes written, for the log and the record. */
  bytes: number;
  /** Lowercase hex of the payload, when it was verified. */
  sha256: string | null;
  error: string | null;
}

/** How often progress is reported, so a fast download cannot flood the event stream. */
const PROGRESS_INTERVAL_MS = 250;

/**
 * Stream `url` to `dest`, verifying its sha256 and reporting progress.
 *
 * `expectSha256` is REQUIRED by signature, not optional: an update with no expected hash is an update
 * that installs whatever the network handed it. A caller that genuinely has no hash must say so
 * explicitly by passing null.
 */
export async function downloadVerified(
  url: string,
  dest: string,
  expectSha256: string | null,
  opts: {
    onProgress?: (p: DownloadProgress) => void;
    signal?: AbortSignal;
    log?: (msg: string) => void;
  } = {},
): Promise<DownloadResult> {
  const log = opts.log ?? (() => {});
  const part = `${dest}.part`;

  let res: Response;
  try {
    // Built conditionally rather than passing `signal: undefined`: this project compiles with
    // `exactOptionalPropertyTypes`, and an explicit undefined is not assignable to `AbortSignal|null`.
    res = await fetch(url, opts.signal ? { signal: opts.signal } : {});
  } catch (err) {
    return { ok: false, bytes: 0, sha256: null, error: `download failed: ${describe(err)}` };
  }
  if (!res.ok) {
    return { ok: false, bytes: 0, sha256: null, error: `download failed: HTTP ${res.status}` };
  }
  if (!res.body) {
    // Without a body there is nothing to stream. Treat it as a failure rather than writing an empty
    // file that would then fail the hash with a confusing message.
    return { ok: false, bytes: 0, sha256: null, error: "download failed: response has no body" };
  }

  const declared = Number(res.headers.get("content-length") ?? "0");
  const total = Number.isFinite(declared) && declared > 0 ? declared : 0;

  const file = await Deno.open(part, { create: true, write: true, truncate: true });
  const hasher = createHash("sha256");
  let received = 0;
  let lastReport = 0;

  try {
    for await (const chunk of res.body) {
      await file.write(chunk);
      hasher.update(chunk);
      received += chunk.byteLength;
      const now = performance.now();
      if (now - lastReport >= PROGRESS_INTERVAL_MS) {
        lastReport = now;
        opts.onProgress?.({
          received,
          total,
          fraction: total > 0 ? Math.min(1, received / total) : null,
        });
      }
    }
  } catch (err) {
    try { file.close(); } catch { /* already closed */ }
    await Deno.remove(part).catch(() => {});
    return {
      ok: false,
      bytes: received,
      sha256: null,
      error: `download interrupted: ${describe(err)}`,
    };
  }
  try { file.close(); } catch { /* already closed */ }

  // A body that ends before its declared length is TRUNCATED.
  //
  // MEASURED: Deno's fetch already errors on this ("error reading a body from connection"), so this
  // branch is normally preempted by the catch above — it is INSURANCE, not the mechanism. It stays
  // because the invariant belongs to this function: with no sha supplied, this comparison is the last
  // thing between the user and a partial program, and a future runtime that ends such a stream
  // cleanly would otherwise silently install a truncated build. The guard does not depend on how the
  // runtime chooses to report a closed connection.
  if (total > 0 && received < total) {
    await Deno.remove(part).catch(() => {});
    return {
      ok: false,
      bytes: received,
      sha256: null,
      error: `download truncated: got ${received} of ${total} bytes`,
    };
  }

  // Final progress, so the UI reaches 100% even if the last tick was skipped.
  //
  // `fraction: 1` is honest — the stream ENDED, so completion is a fact regardless of whether the
  // server declared a length. `total` is NOT substituted with `received`: that would fabricate a
  // number the server never sent, and the UI prints it as "4.1MB of 4.1MB". An unknown total stays
  // unknown, and the consumer shows no byte line for it.
  opts.onProgress?.({ received, total, fraction: 1 });

  const got = hasher.digest("hex");
  if (expectSha256 && got !== expectSha256.toLowerCase()) {
    await Deno.remove(part).catch(() => {});
    // A STALE `dest` IS REMOVED TOO. It can only be a previous update's payload for a DIFFERENT
    // version, and leaving it would let the caller hand the sidecar a file whose bytes do not match
    // the version it is told to install. The `.part` cleanup alone left it behind (measured).
    await Deno.remove(dest).catch(() => {});
    return {
      ok: false,
      bytes: received,
      sha256: got,
      error:
        `sha256 mismatch (expected ${expectSha256.slice(0, 12)}…, got ${got.slice(0, 12)}…) — ` +
        `refusing to install`,
    };
  }

  try {
    // Same directory, so this is an atomic rename and there is never a partial file at `dest`.
    await Deno.rename(part, dest);
  } catch (err) {
    await Deno.remove(part).catch(() => {});
    return {
      ok: false,
      bytes: received,
      sha256: got,
      error: `could not finalise the download: ${describe(err)}`,
    };
  }
  log(`Updates: downloaded ${(received / 1e6).toFixed(0)}MB, sha256 ${got.slice(0, 12)}…`);
  return { ok: true, bytes: received, sha256: got, error: null };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
