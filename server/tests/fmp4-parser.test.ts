/**
 * The box parser must produce identical boundaries to the simple implementation it
 * replaced — while not blocking the event loop on a large fragment.
 *
 * WHY THIS FILE EXISTS. The parser shares its event loop with every HTTP request, and the
 * original implementation concatenated each arriving chunk into a fresh array. That is
 * O(n^2) in the largest outstanding box, and ffmpeg emits a `moof` header long before the
 * `mdat` payload belonging to it finishes arriving, so a large fragment means a large
 * buffer copied over and over. Measured on this machine, one 200MB `mdat` in 64KB chunks:
 *
 *     original (concatenate):            64,898ms   ~305GB copied
 *     append + plain doubling:           28,671ms
 *     append + a multi-MB growth floor:      34ms
 *
 * 65 seconds of a blocked event loop is the reported app freeze, and it is worse on
 * Windows because a slower machine reaches a large outstanding fragment sooner.
 *
 * The speedup is only acceptable if the OUTPUT is unchanged, so these tests compare the
 * parser against a reference re-implementation of the original algorithm rather than
 * asserting a handful of hand-written expectations.
 */
import { assert, assertEquals } from "@std/assert";
import { Fmp4BoxParser, type FragmentIndex } from "@/adapters/outbound/vod/fmp4.ts";

/** A REAL box: an 8-byte header carrying its size, then the payload. */
function box(type: string, payloadBytes: number): Uint8Array {
  const size = 8 + payloadBytes;
  const b = new Uint8Array(size);
  new DataView(b.buffer).setUint32(0, size);
  for (let i = 0; i < 4; i++) b[4 + i] = type.charCodeAt(i);
  return b;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/**
 * The ORIGINAL algorithm, kept here as the oracle: concatenate on every push.
 *
 * A reference copy (rather than only asserting spans) is what makes an optimisation safe
 * to land — a speedup that changes the output is a regression that reads as a win.
 */
class ReferenceParser {
  private buf = new Uint8Array(0);
  private fileOffset = 0;
  readonly index: FragmentIndex = { headEnd: 0, fragments: [] };
  onFragment?: ((span: { start: number; end: number }) => void) | undefined;
  private pendingMoofStart: number | null = null;

  push(chunk: Uint8Array): void {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf, 0);
    merged.set(chunk, this.buf.length);
    this.buf = merged;
    while (true) {
      if (this.buf.length < 8) break;
      const dv = new DataView(this.buf.buffer, this.buf.byteOffset, this.buf.length);
      let size = dv.getUint32(0);
      const type = String.fromCharCode(this.buf[4]!, this.buf[5]!, this.buf[6]!, this.buf[7]!);
      let headerLen = 8;
      if (size === 1) {
        if (this.buf.length < 16) break;
        size = dv.getUint32(8) * 2 ** 32 + dv.getUint32(12);
        headerLen = 16;
      } else if (size === 0) break;
      if (size < headerLen) {
        this.buf = new Uint8Array(0);
        break;
      }
      if (this.buf.length < size) break;
      const start = this.fileOffset;
      const end = this.fileOffset + size;
      this.fileOffset = end;
      this.buf = this.buf.subarray(size);
      if (type === "moov") this.index.headEnd = end;
      else if (type === "moof") this.pendingMoofStart = start;
      else if (type === "mdat" && this.pendingMoofStart !== null) {
        const span = { start: this.pendingMoofStart, end };
        this.index.fragments.push(span);
        this.onFragment?.(span);
        this.pendingMoofStart = null;
      }
    }
  }
}

/** Feed one stream to both parsers in fixed-size pieces and require identical output. */
function expectSame(stream: Uint8Array, chunkBytes: number, label: string): void {
  const fast = new Fmp4BoxParser();
  const ref = new ReferenceParser();
  const fastSpans: string[] = [];
  const refSpans: string[] = [];
  fast.onFragment = (s) => fastSpans.push(`${s.start}-${s.end}`);
  ref.onFragment = (s) => refSpans.push(`${s.start}-${s.end}`);

  for (let off = 0; off < stream.length; off += chunkBytes) {
    const slice = stream.subarray(off, Math.min(off + chunkBytes, stream.length));
    fast.push(slice);
    ref.push(slice);
  }

  assertEquals(fast.index.headEnd, ref.index.headEnd, `${label}: headEnd`);
  assertEquals(fast.index.fragments.length, ref.index.fragments.length, `${label}: fragment count`);
  assertEquals(fastSpans, refSpans, `${label}: spans`);
}

function stream(fragments: number, mdatBytes: number): Uint8Array {
  const parts = [box("ftyp", 32), box("moov", 64)];
  for (let i = 0; i < fragments; i++) {
    parts.push(box("moof", 60), box("mdat", mdatBytes));
  }
  return concat(...parts);
}

Deno.test("identical output at every arrival pattern", () => {
  const s = stream(20, 4000);
  // A fragmented MP4 arrives in whatever sizes the network and the muxer produce, so the
  // chunking must not change the answer.
  for (const chunk of [1 << 16, 4096, 512, 64, 7]) {
    expectSame(s, chunk, `20 frags @ ${chunk}B chunks`);
  }
});

Deno.test("identical output for one large fragment split across many chunks", () => {
  // The freeze scenario: a big mdat whose moof was already seen.
  expectSame(stream(1, 8_000_000), 64 * 1024, "8MB mdat @ 64KB chunks");
});

Deno.test("identical output for the degenerate streams", () => {
  expectSame(concat(box("ftyp", 32), box("moov", 64)), 8, "init only");
  expectSame(new Uint8Array(0), 64, "empty");
  // A download cut off mid-`mdat`: no fragment is complete, so none may be reported.
  expectSame(stream(3, 1000).subarray(0, 40 + 3 * 68 + 100), 16, "truncated mid-mdat");
});

Deno.test("a large fragment does not block the event loop", () => {
  // The regression guard. Not a tight bound — it only has to fail loudly if the parser
  // goes back to copying a growing buffer (which measured 28-65s for this input).
  const bytes = 64_000_000;
  const p = new Fmp4BoxParser();
  p.push(box("ftyp", 32));
  p.push(box("moov", 64));
  p.push(box("moof", 60));
  p.push(box("mdat", bytes));
  const payload = new Uint8Array(bytes);
  const t0 = performance.now();
  for (let off = 0; off < bytes; off += 64 * 1024) {
    p.push(payload.subarray(off, Math.min(off + 64 * 1024, bytes)));
  }
  const ms = performance.now() - t0;
  assertEquals(p.index.fragments.length, 1, "the fragment is still reported");
  assert(
    ms < 2000,
    `pushing ${bytes / 1e6}MB must not take seconds (took ${ms.toFixed(0)}ms); ` +
      `the concatenating implementation measured 28s+ for this input`,
  );
});
