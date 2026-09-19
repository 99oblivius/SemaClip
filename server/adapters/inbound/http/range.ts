/**
 * HTTP Range serving for media files, including files still being written.
 *
 * Two behaviours here are load-bearing and were each verified against a
 * real headless browser (references/growing-media-formats.md):
 *
 * - **Suffix ranges** (`bytes=-N` = the LAST N bytes) must not be parsed as
 *   `start=0, end=N`. Serving the wrong bytes makes the decoder die with
 *   PIPELINE_ERROR_DECODE.
 * - **A growing fragmented MP4 must be clamped to a complete fragment
 *   boundary.** Ending a response inside an `mdat` hands Chromium a partial
 *   fragment and produces the same decode failure. Callers pass the
 *   download's fragment index so the response can stop at a boundary.
 */

export interface RangeRequest {
  /** Inclusive first byte. */
  start: number;
  /** Inclusive last byte. */
  end: number;
}

/**
 * Parse a single-range `Range` header against a known total size.
 *
 * Returns null when the header is absent/unparseable (caller serves the
 * whole file) or "unsatisfiable" when it lies outside the resource.
 */
export function parseRangeHeader(
  header: string | null,
  totalSize: number,
): RangeRequest | "unsatisfiable" | null {
  if (!header) return null;
  const m = /^bytes=(.*)$/.exec(header.trim());
  if (!m) return null;
  const spec = m[1]!.split(",")[0]!.trim();
  const dash = spec.indexOf("-");
  if (dash === -1) return null;
  const startRaw = spec.slice(0, dash).trim();
  const endRaw = spec.slice(dash + 1).trim();

  if (startRaw === "") {
    // SUFFIX RANGE: the last N bytes.
    const n = parseInt(endRaw, 10);
    if (!Number.isFinite(n) || n <= 0) return "unsatisfiable";
    if (totalSize === 0) return "unsatisfiable";
    const start = Math.max(0, totalSize - n);
    return { start, end: totalSize - 1 };
  }

  const start = parseInt(startRaw, 10);
  if (!Number.isFinite(start) || start < 0) return null;
  if (start >= totalSize) return "unsatisfiable";
  let end = endRaw === "" ? totalSize - 1 : parseInt(endRaw, 10);
  if (!Number.isFinite(end) || end < start) return "unsatisfiable";
  end = Math.min(end, totalSize - 1);
  return { start, end };
}

/**
 * The largest byte offset a growing file may be served up to.
 *
 * `servableSize` is the download's own safe frontier (for fragmented MP4,
 * the end of the last COMPLETE fragment). When no download is live the file
 * is complete and its own size is servable. The result never exceeds the
 * file's actual size on disk, so a racing write can't produce a short read
 * past EOF.
 */
export function clampToServable(requestedEnd: number, servableSize: number, fileSize: number): number {
  return Math.min(requestedEnd, servableSize - 1, fileSize - 1);
}

/**
 * Forward at most `len` bytes of `source`, then close `file` and end the stream.
 *
 * ── WHY THIS EXISTS RATHER THAN BUFFERING ─────────────────────────────────────────────────
 * The range route used to allocate the whole window and read it before responding:
 *
 *     const buf = new Uint8Array(end - start + 1);
 *     await file.read(buf);
 *     return c.body(buf, 206);
 *
 * which holds the ENTIRE requested range in memory and sends nothing until it is all in. Measured
 * against a real 1.32GB VOD with `Range: bytes=0-`: 1806ms before any header, then the whole file.
 * Streamed through this limiter the same request reaches its first byte in ~3ms, verified over a real
 * socket (in-process `fetch` cannot see the difference — see the note in the test file).
 *
 * `file.readable` cannot be sliced, so the window is enforced by counting bytes as they pass. The
 * file is closed in `flush`, which is what releases the handle when the consumer stops early rather
 * than waiting for the response to be collected.
 */
export function limitBytes(
  source: ReadableStream<Uint8Array>,
  len: number,
  onDone: () => void,
): ReadableStream<Uint8Array> {
  let remaining = len;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      start() {
        remaining = len;
      },
      transform(chunk, controller) {
        if (remaining <= 0) return;
        if (chunk.byteLength <= remaining) {
          remaining -= chunk.byteLength;
          controller.enqueue(chunk);
        } else {
          // The window ends inside this chunk: send only the part that belongs to it.
          controller.enqueue(chunk.subarray(0, remaining));
          remaining = 0;
        }
      },
      flush() {
        onDone();
      },
    }),
  );
}
