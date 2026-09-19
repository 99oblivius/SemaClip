#!/usr/bin/env python3
"""Assert a repacked AppImage's payload uses a compressor the AppImage runtime can mount.

── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────────────
The type-2 runtime mounts its payload with squashfuse, whose error string is

    Squashfs image uses %s compression, this version supports only

— zlib and zstd, in the build `deno desktop` ships. A repacked payload compressed with anything else
is a perfectly VALID squashfs that every other check here passes: correct inode count, power-of-two
block size, readable by `unsquashfs`, icons present, dylib present. The only thing wrong with it is
that the app cannot open.

That shipped. `scripts/repack-appimage.sh` hard-coded `-comp xz` while `deno desktop` writes zstd,
so EVERY Linux AppImage from the first repack until the fix was unopenable, and the owner hit it as
"suddenly only supports zlib and zstd". Nothing in the pipeline noticed, because the failure is at
mount time on the user's machine and never in the build.

Usage: appimage_compressor.py <repacked.AppImage> <payload-offset>
Exit 0 when the payload compressor is one squashfuse can mount.
"""
import sys

# squashfs superblock compression ids. The runtime in Deno's type-2 launcher handles 1 (gzip/zlib)
# and 6 (zstd); the others are listed so the failure message can name what was actually found.
COMPRESSORS = {1: "gzip", 2: "lzma", 3: "lzo", 4: "xz", 5: "lz4", 6: "zstd"}

# What the shipped runtime can mount. Kept as a set rather than a single value so a future runtime
# that gains xz does not need this rewritten to a range.
MOUNTABLE = {1, 6}


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__)
        return 2
    path, offset = sys.argv[1], int(sys.argv[2])

    with open(path, "rb") as fh:
        fh.seek(offset)
        head = fh.read(32)

    if len(head) < 22 or head[0:4] != b"hsqs":
        print(f"::error::no squashfs superblock at offset {offset} in {path}", file=sys.stderr)
        return 1

    comp = int.from_bytes(head[20:22], "little")
    name = COMPRESSORS.get(comp, f"unknown({comp})")

    if comp not in MOUNTABLE:
        mountable = ", ".join(sorted(COMPRESSORS[c] for c in MOUNTABLE))
        print(
            f"::error::AppImage payload uses {name} compression, which the AppImage runtime cannot "
            f"mount — the app would not open. It supports {mountable}. "
            f"scripts/repack-appimage.sh must preserve the source compressor, not choose one.",
            file=sys.stderr,
        )
        return 1

    print(f"AppImage payload compression is {name} — mountable by the runtime")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
