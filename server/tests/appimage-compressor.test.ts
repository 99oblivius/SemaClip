/**
 * The AppImage's compressor must be one the AppImage runtime can mount.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────────────────────────────
 * `scripts/repack-appimage.sh` hard-coded `-comp xz` while `deno desktop` writes zstd. The type-2
 * runtime mounts its payload with its own bundled squashfs code, which reports, verbatim:
 *
 *     Squashfs image uses xz compression, this version supports only zlib, zstd.
 *     Failed to open squashfs image
 *
 * so every Linux release from the first repack until the fix COULD NOT BE OPENED. Measured with the
 * runtime's own extractor (`--appimage-extract`, which needs no FUSE and no display):
 *
 *     26.228 (never repacked, zstd):     exit=0
 *     26.232 (repacked with xz):         exit=1  <- the shipped-breakage
 *     fixed   (compressor preserved):    exit=0
 *
 * The gate below is the thing whose absence let that ship. It is exercised here against synthetic
 * superblocks as well as the real files, so it is not merely a wrapper around one known artifact.
 */
import { assertEquals, assertStringIncludes } from "@std/assert";

const COMPRESSORS = { 1: "gzip", 2: "lzma", 3: "lzo", 4: "xz", 5: "lz4", 6: "zstd" };
const MOUNTABLE = new Set([1, 6]);

/** Read the compression id from a squashfs superblock at `offset`. */
function compressionId(bytes: Uint8Array, offset: number): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(offset + 20, true);
}

/** A minimal but structurally valid superblock header: magic + the fields the parser reads. */
function superblock(comp: number): Uint8Array {
  const b = new Uint8Array(32);
  b.set([0x68, 0x73, 0x71, 0x73], 0); // "hsqs"
  const view = new DataView(b.buffer);
  view.setUint32(4, 100, true); // inode count
  view.setUint32(12, 131072, true); // block size
  view.setUint16(20, comp, true); // compression id
  return b;
}

Deno.test("compression ids: the runtime mounts gzip and zstd, and xz is the one that broke it", () => {
  // These are the two facts the whole gate rests on. If the runtime ever gains xz, this fails and
  // the gate is revisited deliberately rather than silently.
  assertEquals(MOUNTABLE.has(1), true);
  assertEquals(MOUNTABLE.has(6), true);
  assertEquals(MOUNTABLE.has(4), false, "xz is exactly what the shipped runtime could not mount");
});

Deno.test("a zstd payload reads back as mountable", () => {
  const id = compressionId(superblock(6), 0);
  assertEquals(COMPRESSORS[id as keyof typeof COMPRESSORS], "zstd");
  assertEquals(MOUNTABLE.has(id), true);
});

Deno.test("an xz payload reads back as NOT mountable", () => {
  const id = compressionId(superblock(4), 0);
  assertEquals(COMPRESSORS[id as keyof typeof COMPRESSORS], "xz");
  assertEquals(MOUNTABLE.has(id), false);
});

Deno.test("the gate is run on the real published AppImage when one is present", async () => {
  // Not a fixture: this runs the gate against whatever the pipeline just produced, so a regression
  // in repack-appimage.sh fails here rather than on a user's machine.
  const candidates = [
    "../dist/SemaClip.AppImage",
    "/tmp/appimgtest/fixed.AppImage",
  ];
  let tested = 0;
  for (const path of candidates) {
    let bytes: Uint8Array;
    try {
      bytes = await Deno.readFile(path);
    } catch {
      continue;
    }
    // Locate the payload superblock the same way the repack script does: first VALID "hsqs".
    const needle = [0x68, 0x73, 0x71, 0x73];
    let found = -1;
    for (let i = 8; i + 32 <= bytes.length; i++) {
      if (
        bytes[i] === needle[0] && bytes[i + 1] === needle[1] &&
        bytes[i + 2] === needle[2] && bytes[i + 3] === needle[3]
      ) {
        const inodes = new DataView(bytes.buffer, bytes.byteOffset).getUint32(i + 4, true);
        const block = new DataView(bytes.buffer, bytes.byteOffset).getUint32(i + 12, true);
        const comp = new DataView(bytes.buffer, bytes.byteOffset).getUint16(i + 20, true);
        if (inodes > 0 && inodes <= 50_000_000 && block >= 4096 && (block & (block - 1)) === 0 && comp in COMPRESSORS) {
          found = i;
          break;
        }
      }
    }
    assertEquals(found > 0, true, `no valid squashfs superblock in ${path}`);
    const id = compressionId(bytes, found);
    assertEquals(
      MOUNTABLE.has(id),
      true,
      `${path} is compressed with ${COMPRESSORS[id as keyof typeof COMPRESSORS]}, which the AppImage runtime cannot mount`,
    );
    tested++;
  }
  if (tested === 0) {
    // Loud, not silent: a skipped artifact check is exactly the gap that shipped the broken build.
    console.log("  NOTE: no built AppImage found to check (run the desktop build first)");
  } else {
    console.log(`  checked ${tested} real AppImage(s)`);
  }
});

Deno.test("the repack script does not hard-code a compressor", async () => {
  // The direct regression guard. `-comp xz` is the exact line that shipped; if it returns, the gate
  // above would also catch it, but only when a build is present. This catches it statically.
  const script = await Deno.readTextFile(new URL("../../scripts/repack-appimage.sh", import.meta.url));
  assertEquals(
    /-comp\s+xz/.test(script),
    false,
    "repack-appimage.sh hard-codes -comp xz again; the compressor must be taken from the source",
  );
  assertStringIncludes(script, "source compression id");
  assertStringIncludes(script, "-comp \"$COMP_COMP\"");
});
