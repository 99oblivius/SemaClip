#!/bin/bash
# Repack the AppImage with the icon bits libappimage needs: .DirIcon at the root and a hicolor tree.
#
# WHY: AppImageLauncher's "integrate" fails with "Failed to register AppImage in system via
# libappimage" because libappimage resolves an icon from `usr/share/icons/<theme>/…`, falls back to
# `.DirIcon` at the AppImage root, and `deno desktop` ships NEITHER — only AppIcon.png/SemaClip.png
# with `Icon=AppIcon` in the .desktop. Its own stderr says exactly this:
#   WARNING: No icons found at "usr/share/icons"
#   WARNING: Using .DirIcon as default app icon
#   ERROR: Entry doesn't exists: .DirIcon
#
# This is a REPACK: the type-2 runtime bytes are preserved verbatim and only the squashfs payload is
# rebuilt, so the result is still a runnable AppImage. Offsets are recomputed, so the concatenation
# is reconstructed rather than patched in place.
#
# Usage: repack-appimage.sh <in.AppImage> <out.AppImage> <icon.png>
set -euo pipefail

# `--offset-only <file>`: print the squashfs payload offset and exit.
#
# Exists so CI never needs an inline `python3 - <<'PY'` heredoc: a heredoc's terminator must sit at
# column 0, which leaves a `run: |` YAML block and makes the workflow unparseable — a real failure
# that stopped a release before any step ran. Keeping the Python in this file is the same reason the
# workflow header says manifest surgery lives in scripts/ci/manifest.py.
if [ "${1:-}" = "--offset-only" ]; then
  TARGET="${2:?usage: repack-appimage.sh --offset-only <AppImage>}"
  python3 - "$TARGET" <<'OFFSETPY'
import sys

d = open(sys.argv[1], "rb").read()
KNOWN_COMP = {1, 2, 3, 4, 5, 6}


def valid(off: int) -> bool:
    if off + 30 > len(d):
        return False
    inodes = int.from_bytes(d[off + 4:off + 8], "little")
    block = int.from_bytes(d[off + 12:off + 16], "little")
    comp = int.from_bytes(d[off + 20:off + 22], "little")
    return (
        0 < inodes <= 50_000_000
        and 4096 <= block <= 1048576
        and (block & (block - 1)) == 0
        and comp in KNOWN_COMP
    )


i = 8
while True:
    i = d.find(b"hsqs", i + 1)
    if i < 0:
        raise SystemExit("no squashfs payload found")
    if valid(i):
        print(i)
        break
OFFSETPY
  exit 0
fi

IN="${1:?usage: repack-appimage.sh <in> <out> <icon.png>}"
OUT="${2:?usage: repack-appimage.sh <in> <out> <icon.png>}"
ICON="${3:?usage: repack-appimage.sh <in> <out> <icon.png>}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Split runtime from squashfs.
#
#    The type-2 magic is at offset 8. The squashfs does NOT simply start at the first `hsqs` bytes:
#    MEASURED on a real 108MB AppImage, `hsqs` occurs twice (at 194183 and 944632) and the first is a
#    coincidental byte pair inside the runtime — `unsquashfs` rejects it with "Can't find a valid
#    SQUASHFS superblock". So every candidate is validated as a superblock (sane inode count, power-of
#    -two block size, known compression id) and the first VALID one is the payload.
python3 - "$IN" "$WORK" <<'PY'
import sys

src, work = sys.argv[1], sys.argv[2]
d = open(src, "rb").read()
assert d[0:4] == b"\x7fELF", "not an ELF-based AppImage"
assert b"AI\x02" in d[8:12], f"not a type-2 AppImage (magic at offset 8: {d[8:12]!r})"

KNOWN_COMP = {1, 2, 3, 4, 5, 6}  # gzip, lzma, lzo, xz, lz4, zstd

def valid_superblock(off: int) -> bool:
    if off + 30 > len(d):
        return False
    inodes = int.from_bytes(d[off + 4:off + 8], "little")
    block = int.from_bytes(d[off + 12:off + 16], "little")
    comp = int.from_bytes(d[off + 20:off + 22], "little")
    # 4KB..1MB, a power of two, and a compression id the format defines. A coincidental `hsqs`
    # inside compiled code fails all three essentially always.
    if inodes <= 0 or inodes > 50_000_000:
        return False
    if block < 4096 or block > 1048576 or (block & (block - 1)) != 0:
        return False
    return comp in KNOWN_COMP

cands = []
i = 8
while True:
    i = d.find(b"hsqs", i + 1)
    if i < 0:
        break
    cands.append((i, valid_superblock(i)))

good = [o for o, ok in cands if ok]
print(f"  hsqs candidates: {cands}")
assert good, "no valid squashfs superblock found"
off = good[0]

# The SOURCE's compressor, which the repack MUST preserve. See the note on -comp below: writing a
# different one produced an AppImage the runtime could not mount at all.
COMPRESSORS = {1: "gzip", 2: "lzma", 3: "lzo", 4: "xz", 5: "lz4", 6: "zstd"}
comp = int.from_bytes(d[off + 20:off + 22], "little")
assert comp in COMPRESSORS, f"unknown source compression id {comp}"
open(f"{work}/comp", "w").write(str(comp))
print(f"  source compression id: {comp} ({COMPRESSORS[comp]})")

open(f"{work}/runtime", "wb").write(d[:off])
open(f"{work}/payload.squashfs", "wb").write(d[off:])
# The offset is written out because READING the result back needs it: `unsquashfs` derives the
# squashfs position from the ELF section table, which describes the ORIGINAL payload, so on a
# repacked file it reports "Can't find a valid SQUASHFS superblock" unless given `-offset`. The file
# itself is fine — the AppImage runtime locates its payload by its own means and runs it.
with open(f"{work}/offset", "w") as fh:
    fh.write(str(off))
print(f"  runtime: {off} bytes; squashfs: {len(d)-off} bytes")
PY

# 2. Extract, add the icon locations libappimage looks for, rebuild.
# The payload's files are ROOT-OWNED (an AppImage's contents always are), so a plain extraction makes
# a tree that cannot be written into or even chmod'd. `fakeroot` handles this without any elevation:
# it fakes ownership for the tools running under it, so `unsquashfs` can create its root-owned tree
# and `mksquashfs -all-root` records root ownership in the new image, while the real files on disk stay
# ours. No root, no polkit prompt — which matters because this also has to run in CI.
echo "  extracting and repacking (fakeroot: no elevation needed)"
fakeroot -s "$WORK/fakeroot.state" --   unsquashfs -q -d "$WORK/root" "$WORK/payload.squashfs" >/dev/null
echo "  extracted: $(ls "$WORK/root" | tr '\n' ' ')"

# The icon locations libappimage looks for: `.DirIcon` at the root, and a hicolor theme entry whose
# name resolves from the .desktop's `Icon=`. Both entries use a bare name, so provide both spellings.
cp "$ICON" "$WORK/root/.DirIcon"
mkdir -p "$WORK/root/usr/share/icons/hicolor/512x512/apps"
cp "$ICON" "$WORK/root/usr/share/icons/hicolor/512x512/apps/semaclip.png"
cp "$ICON" "$WORK/root/usr/share/icons/hicolor/512x512/apps/SemaClip.png"

# 3. mksquashfs with the SOURCE'S OWN compressor, and NO appended padding so the concatenation
#    stays tight. -all-root records the ownership an AppImage's contents must have.
#
#    ── WHY THE COMPRESSOR IS PRESERVED AND NOT CHOSEN ───────────────────────────────────────
#    This used to hard-code xz. The type-2 runtime's FUSE mount is squashfuse-based and its own
#    error string is "Squashfs image uses %s compression, this version supports only " — zlib and
#    zstd, in the build Deno ships. A repacked xz image therefore FAILED TO MOUNT AT ALL, and the
#    app could not be opened: every Linux release from the first repack until this fix was dead.
#    The source (deno desktop's own output) is zstd, so preserving it is both correct and what the
#    runtime can read. `-comp` is derived from the superblock, not hard-coded, so a future Deno
#    that changes its default keeps working without touching this script.
COMP_ID="$(cat "$WORK/comp")"
case "$COMP_ID" in
  1) COMP_COMP=gzip ;;
  2) COMP_COMP=lzma ;;
  3) COMP_COMP=lzo ;;
  4) COMP_COMP=xz ;;
  5) COMP_COMP=lz4 ;;
  6) COMP_COMP=zstd ;;
  *) echo "unsupported source compression id $COMP_ID" >&2; exit 1 ;;
esac
echo "  repacking with the source compressor: $COMP_COMP"
fakeroot -i "$WORK/fakeroot.state" -s "$WORK/fakeroot.state" --   mksquashfs "$WORK/root" "$WORK/new.squashfs" \
    -comp "$COMP_COMP" -b 128K -noappend -all-root -no-progress >/dev/null

# FAIL LOUDLY if the result is not readable by the runtime. This is the check whose absence let an
# unopenable AppImage ship: the squashfs is valid, self-consistent and passes every other assertion
# here, and only the compressor makes it unusable. The superblock of the OUTPUT is re-read and
# compared with the source, so a repack that silently switches compressor cannot get past this.
python3 - "$WORK/new.squashfs" "$COMP_ID" <<'CHECKSQ'
import sys

path, want = sys.argv[1], int(sys.argv[2])
d = open(path, "rb").read(64)
comp = int.from_bytes(d[20:22], "little")
NAMES = {1: "gzip", 2: "lzma", 3: "lzo", 4: "xz", 5: "lz4", 6: "zstd"}
assert comp == want, (
    f"repacked compression id {comp} ({NAMES.get(comp)}) != source {want} ({NAMES.get(want)}) — "
    f"the runtime mounts only what the source used"
)
print(f"  repacked compression verified: {comp} ({NAMES.get(comp)})")
CHECKSQ


# 4. Reassemble runtime + new squashfs.
cat "$WORK/runtime" "$WORK/new.squashfs" > "$OUT"
chmod +x "$OUT"
echo "  repacked: $(stat -c%s "$OUT") bytes -> $OUT"

# Print the payload offset so a caller can inspect the result with `unsquashfs -offset <n>`.
python3 - "$OUT" <<'PY'
import sys

d = open(sys.argv[1], "rb").read()
KNOWN_COMP = {1, 2, 3, 4, 5, 6}


def valid(off: int) -> bool:
    if off + 30 > len(d):
        return False
    inodes = int.from_bytes(d[off + 4:off + 8], "little")
    block = int.from_bytes(d[off + 12:off + 16], "little")
    comp = int.from_bytes(d[off + 20:off + 22], "little")
    return 0 < inodes <= 50_000_000 and 4096 <= block <= 1048576 and (block & (block - 1)) == 0 and comp in KNOWN_COMP


i = 8
while True:
    i = d.find(b"hsqs", i + 1)
    if i < 0:
        break
    if valid(i):
        print(f"  payload offset: {i}")
        break
PY
