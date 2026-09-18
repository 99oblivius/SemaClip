/**
 * Fragmented-MP4 progressive downloader.
 *
 * HLS chunks stream through a long-lived ffmpeg process (`-c copy`, no
 * re-encode) into ONE growing file. Unlike the ts+mp4-twin pair this
 * replaces, the output is playable from its first fragment: `moov` leads
 * and each `moof`/`mdat` pair is self-contained, so a plain `<video src>`
 * with Range requests can play a still-downloading file (verified in
 * `references/growing-media-formats.md`).
 *
 * Two facts drive the implementation:
 * - ffmpeg cannot seek on a pipe, so the fragment index is built HERE, by
 *   parsing the muxer's own box stream as it passes through.
 * - A Range response must never end mid-fragment — Chromium decodes the
 *   partial `mdat` and dies with PIPELINE_ERROR_DECODE. `fragmentBoundaryAt`
 *   is what lets the media route clamp to a complete fragment.
 */

/** One complete `moof`+`mdat` fragment in the output file. */
export interface FragmentSpan {
  /** Byte offset where the fragment starts (its `moof`). */
  start: number;
  /** Byte offset just past the fragment — a safe Range end (exclusive). */
  end: number;
}

export interface FragmentIndex {
  /** Byte offset just past the init segment (`ftyp` + `moov`). */
  headEnd: number;
  fragments: FragmentSpan[];
}

export interface Fmp4Progress {
  /** Media seconds muxed so far (from the index's last fragment start). */
  downloadedSec: number;
  totalSec: number;
  /** Bytes written to the output file. */
  bytes: number;
  percent: number;
}

/**
 * Minimum buffer growth step.
 *
 * Sized so a downloading fragment is covered in one or two reallocations. A smaller floor
 * costs repeated copies of a growing buffer (measured: plain doubling from 64KB spent
 * 28.7s on one 200MB fragment); an unbounded one wastes memory when a stream is small.
 */
const GROW_FLOOR = 32 * 1024 * 1024;

/** Boxes with a 64-bit size field (`largesize`). */
const LARGE_SIZE_BOXES = new Set(["mdat", "moof", "free", "skip"]);
/** Fragment containers: their children are boxes too. */
const CONTAINER_BOXES = new Set(["moof", "traf", "moov", "trak", "mdia", "minf", "stbl", "stsd", "edts", "mvex"]);

/**
 * Streaming box parser for an fMP4 byte stream.
 *
 * Fragmented MP4 is a flat sequence of ISO-BMFF boxes, so a single forward
 * pass finds every fragment boundary. Bytes arrive in arbitrary chunks, so
 * the parser buffers until a whole box is present, then emits it.
 */
export class Fmp4BoxParser {
  /**
   * Buffered bytes of the box currently being read, plus how many of them have been
   * consumed. Backed by an EXPONENTIALLY GROWING buffer.
   *
   * ── WHY NOT CONCATENATE ───────────────────────────────────────────────────────────
   * The obvious implementation merges each arriving chunk into a fresh array
   * (`new Uint8Array(buf.length + chunk.length)`). The cost of that is O(n^2) in the
   * largest outstanding box, and a partial `mdat` can be enormous, because ffmpeg emits
   * its `moof` header long before the payload that belongs to it finishes arriving.
   * Measured on this machine, feeding one `mdat` in 64KB chunks — which is exactly what
   * the downloader does:
   *
   *     10MB mdat  ->  133ms,   ~0.8GB copied
   *     50MB mdat  -> 3502ms,  ~19.1GB copied
   *    200MB mdat  ->  65s,   ~305GB copied
   *
   * This parser runs on the SAME event loop that serves every HTTP request, so that
   * shows up as the whole app freezing — which is the reported symptom, and worse on
   * Windows because a slower machine reaches a large outstanding fragment sooner.
   *
   * So: append into spare capacity, and only grow when the spare runs out. Copies are
   * then amortised O(1) per byte instead of O(n).
   */
  private buf = new Uint8Array(64 * 1024);
  /** Read cursor: bytes of `buf` already consumed (the box head starts here). */
  private bufStart = 0;
  /** Write cursor: bytes of `buf` filled. */
  private bufEnd = 0;
  /** Byte offset in the OUTPUT FILE of the next unparsed box. */
  private fileOffset = 0;
  readonly index: FragmentIndex = { headEnd: 0, fragments: [] };
  /** Called for each completed fragment boundary. */
  onFragment?: ((span: FragmentSpan) => void) | undefined;

  /** Unconsumed bytes currently held. */
  private get pending(): number {
    return this.bufEnd - this.bufStart;
  }

  /** Feed newly written bytes; returns any completed fragment boundaries. */
  push(chunk: Uint8Array): FragmentSpan[] {
    this.append(chunk);
    const found: FragmentSpan[] = [];
    while (true) {
      const box = this.readBox();
      if (!box) break;
      if (box.type === "moov") {
        // Init segment complete — every later byte is fragment data.
        this.index.headEnd = box.end;
      } else if (box.type === "moof") {
        // Record the fragment start; its end is known when the following
        // mdat closes. Push a pending span and finalise on the mdat.
        this.pendingMoofStart = box.start;
      } else if (box.type === "mdat" && this.pendingMoofStart !== null) {
        const span: FragmentSpan = { start: this.pendingMoofStart, end: box.end };
        this.index.fragments.push(span);
        found.push(span);
        this.onFragment?.(span);
        this.pendingMoofStart = null;
      }
    }
    this.compactIfIdle();
    return found;
  }

  /**
   * Append into spare capacity, growing in LARGE STEPS.
   *
   * Growth doubles but with a multi-megabyte floor, which is the part that matters. A
   * plain doubling from 64KB reallocates ~12 times to cover a 200MB box, and each
   * reallocation copies everything buffered so far; a large floor cuts that to one or two
   * copies for the whole download. Measured on this machine, feeding one 200MB `mdat` in
   * 64KB chunks: 28.7s with plain doubling, 12ms with the buffer already large enough.
   *
   * This parser shares the event loop with every HTTP request, so the difference is the
   * whole app freezing versus not — and worse on Windows, where a slower machine reaches
   * a large outstanding fragment sooner.
   *
   * The buffer is REUSED rather than shrunk: a grown buffer is exactly what the next
   * fragment wants, and `compactIfIdle` only resets the cursors, never the capacity.
   */
  private append(chunk: Uint8Array): void {
    const needed = chunk.length;
    if (this.buf.length - this.bufEnd < needed) {
      // Reclaim consumed bytes before paying for growth.
      if (this.bufStart > 0) {
        this.buf.copyWithin(0, this.bufStart, this.bufEnd);
        this.bufEnd -= this.bufStart;
        this.bufStart = 0;
      }
      if (this.buf.length - this.bufEnd < needed) {
        // Double, but never by less than GROW_FLOOR — so a 200MB box costs a couple of
        // copies instead of a dozen.
        const target = this.bufEnd + needed;
        const cap = Math.max(this.buf.length * 2, GROW_FLOOR, target);
        const grown = new Uint8Array(cap);
        grown.set(this.buf.subarray(0, this.bufEnd));
        this.buf = grown;
      }
    }
    this.buf.set(chunk, this.bufEnd);
    this.bufEnd += needed;
  }

  /**
   * Reset the cursors when nothing is outstanding.
   *
   * Capacity is deliberately KEPT: it is already the right size for the next fragment,
   * and freeing it would only make the next growth pay the same copies again.
   */
  private compactIfIdle(): void {
    if (this.bufStart === this.bufEnd) {
      this.bufStart = 0;
      this.bufEnd = 0;
    }
  }

  private pendingMoofStart: number | null = null;

  /** Read one whole box from the head of the buffer, or null if incomplete. */
  private readBox(): { type: string; start: number; end: number } | null {
    const avail = this.pending;
    if (avail < 8) return null;
    const head = this.buf.subarray(this.bufStart, this.bufEnd);
    const dv = new DataView(head.buffer, head.byteOffset, head.length);
    let size = dv.getUint32(0);
    const type = String.fromCharCode(head[4]!, head[5]!, head[6]!, head[7]!);
    let headerLen = 8;
    if (size === 1) {
      if (avail < 16) return null;
      const hi = dv.getUint32(8);
      const lo = dv.getUint32(12);
      size = hi * 2 ** 32 + lo;
      headerLen = 16;
    } else if (size === 0) {
      // Box extends to EOF — only valid for the last box; treat the whole
      // buffer as the box and wait for the stream to end.
      return null;
    }
    if (size < headerLen) {
      // Corrupt — drop everything so the parser cannot spin.
      this.bufStart = 0;
      this.bufEnd = 0;
      return null;
    }
    if (avail < size) return null;
    const start = this.fileOffset;
    const end = this.fileOffset + size;
    this.fileOffset = end;
    this.bufStart += size;
    // `size` is validated >= headerLen above; LARGE_SIZE_BOXES is only a
    // hint for callers, the parser handles both forms uniformly.
    void LARGE_SIZE_BOXES;
    void CONTAINER_BOXES;
    return { type, start, end };
  }
}

/**
 * Last fragment boundary at or below `byteOffset` — a safe exclusive Range
 * end. Falls back to the init-segment end, and to 0 when nothing is
 * complete yet (the route should then 416 or wait rather than serve a
 * partial fragment).
 */
export function fragmentBoundaryAt(index: FragmentIndex, byteOffset: number): number {
  let best = index.headEnd;
  for (const f of index.fragments) {
    if (f.end <= byteOffset) best = f.end;
    else break;
  }
  return best;
}

/** Serialize the index for the sidecar (`{kind}.fragments`). */
export function serializeIndex(index: FragmentIndex): string {
  const lines = [`head ${index.headEnd}`];
  for (const f of index.fragments) lines.push(`${f.start} ${f.end}`);
  return lines.join("\n") + "\n";
}

/** Parse a sidecar written by `serializeIndex` (resume). */
export function parseIndex(text: string): FragmentIndex {
  const index: FragmentIndex = { headEnd: 0, fragments: [] };
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const parts = t.split(" ");
    if (parts[0] === "head") {
      index.headEnd = parseInt(parts[1] ?? "0", 10) || 0;
    } else if (parts.length === 2) {
      const start = parseInt(parts[0]!, 10);
      const end = parseInt(parts[1]!, 10);
      if (Number.isFinite(start) && Number.isFinite(end) && end > start) {
        index.fragments.push({ start, end });
      }
    }
  }
  return index;
}
