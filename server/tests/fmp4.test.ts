/**
 * Fmp4BoxParser tests — the parser is what makes fragment-boundary clamping
 * possible, and a wrong boundary is a silent playback killer
 * (PIPELINE_ERROR_DECODE). Validated against real ffmpeg output, not
 * hand-built boxes.
 */
import { assert, assertEquals } from "@std/assert";
import { Fmp4BoxParser, fragmentBoundaryAt, parseIndex, serializeIndex } from "@/adapters/outbound/vod/fmp4.ts";

/** Real fragmented mp4 produced by ffmpeg from a lavfi TS fixture. */
async function makeFmp4(): Promise<Uint8Array> {
  const tmp = await Deno.makeTempDir({ prefix: "semaclip-fmp4-" });
  const ts = `${tmp}/src.ts`;
  const mp4 = `${tmp}/out.mp4`;
  const gen = new Deno.Command("ffmpeg", {
    args: ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
           "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
           "-t", "12", "-c:v", "libx264", "-preset", "ultrafast", "-g", "60",
           "-c:a", "aac", "-f", "mpegts", ts, "-y"],
    stdout: "null", stderr: "null",
  });
  const genRes = await gen.output();
  assertEquals(genRes.success, true, "fixture TS generation failed");
  const mux = new Deno.Command("ffmpeg", {
    args: ["-v", "error", "-i", ts, "-c", "copy", "-bsf:a", "aac_adtstoasc",
           "-movflags", "+frag_keyframe+empty_moov+default_base_moof", "-f", "mp4", mp4, "-y"],
    stdout: "null", stderr: "null",
  });
  const muxRes = await mux.output();
  assertEquals(muxRes.success, true, "fixture fMP4 mux failed");
  const data = await Deno.readFile(mp4);
  await Deno.remove(tmp, { recursive: true }).catch(() => {});
  return data;
}

/** Independent box scan — the oracle the streaming parser is checked against. */
function scanBoxes(data: Uint8Array): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  let off = 0;
  const dv = new DataView(data.buffer, data.byteOffset, data.length);
  while (off + 8 <= data.length) {
    let size = dv.getUint32(off);
    const type = String.fromCharCode(data[off + 4]!, data[off + 5]!, data[off + 6]!, data[off + 7]!);
    let headerLen = 8;
    if (size === 1) {
      size = dv.getUint32(off + 8) * 2 ** 32 + dv.getUint32(off + 12);
      headerLen = 16;
    }
    if (size < headerLen || off + size > data.length) break;
    out.push({ type, start: off, end: off + size });
    off += size;
  }
  return out;
}

Deno.test("Fmp4BoxParser: finds head + every fragment, matching an independent scan", async () => {
  const data = await makeFmp4();
  const boxes = scanBoxes(data);
  const oracleFrags = [];
  let headEnd = 0;
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i]!;
    if (b.type === "moov") headEnd = b.end;
    if (b.type === "mdat" && i > 0 && boxes[i - 1]!.type === "moof") {
      oracleFrags.push({ start: boxes[i - 1]!.start, end: b.end });
    }
  }
  assert(headEnd > 0, "oracle found no moov");
  assert(oracleFrags.length > 0, "oracle found no fragments");

  const parser = new Fmp4BoxParser();
  parser.push(data);
  assertEquals(parser.index.headEnd, headEnd, "headEnd mismatch");
  assertEquals(parser.index.fragments, oracleFrags, "fragment spans mismatch");
});

Deno.test("Fmp4BoxParser: arbitrary chunk sizes produce identical boundaries", async () => {
  const data = await makeFmp4();
  const whole = new Fmp4BoxParser();
  whole.push(data);

  // Chunk boundaries are the real-world case: bytes arrive from a pipe.
  for (const size of [1, 7, 13, 64, 4096, 65537]) {
    const p = new Fmp4BoxParser();
    for (let off = 0; off < data.length; off += size) {
      p.push(data.subarray(off, Math.min(off + size, data.length)));
    }
    assertEquals(p.index.headEnd, whole.index.headEnd, `headEnd differs at chunk size ${size}`);
    assertEquals(p.index.fragments, whole.index.fragments, `fragments differ at chunk size ${size}`);
  }
});

Deno.test("Fmp4BoxParser: a truncated stream yields only COMPLETE fragments", async () => {
  const data = await makeFmp4();
  const whole = new Fmp4BoxParser();
  whole.push(data);
  const full = whole.index.fragments;
  assert(full.length >= 2, "need at least 2 fragments for this test");

  // Cut mid-way through the last fragment — the parser must not report it.
  const last = full[full.length - 1]!;
  const cut = Math.floor((last.start + last.end) / 2);
  const p = new Fmp4BoxParser();
  p.push(data.subarray(0, cut));
  assertEquals(p.index.fragments.length, full.length - 1, "reported a partial fragment as complete");
  assertEquals(p.index.fragments, full.slice(0, -1));
});

Deno.test("fragmentBoundaryAt: clamps to the last complete fragment", async () => {
  const data = await makeFmp4();
  const p = new Fmp4BoxParser();
  p.push(data);
  const frags = p.index.fragments;
  assert(frags.length >= 2);

  // Anywhere inside fragment N must clamp to fragment N's start (the
  // previous boundary) — never mid-fragment, which breaks Chromium.
  const f1 = frags[1]!;
  const mid = Math.floor((f1.start + f1.end) / 2);
  assertEquals(fragmentBoundaryAt(p.index, mid), frags[0]!.end);
  // Exactly at a boundary is inclusive of that fragment.
  assertEquals(fragmentBoundaryAt(p.index, f1.end), f1.end);
  // Before any fragment completes: the init segment only.
  assertEquals(fragmentBoundaryAt(p.index, p.index.headEnd), p.index.headEnd);
  // Past everything: the last fragment.
  assertEquals(fragmentBoundaryAt(p.index, data.length), frags[frags.length - 1]!.end);
});

Deno.test("index sidecar round-trips", async () => {
  const data = await makeFmp4();
  const p = new Fmp4BoxParser();
  p.push(data);
  const restored = parseIndex(serializeIndex(p.index));
  assertEquals(restored.headEnd, p.index.headEnd);
  assertEquals(restored.fragments, p.index.fragments);
});
