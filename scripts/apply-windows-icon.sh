#!/usr/bin/env bash
# Put the app icon on the Windows LAUNCHER exe.
#
# WHY: `deno desktop`'s Windows build is two PEs — <App>.exe (launcher, GUI
# subsystem, owns the process and window) and <App>.dll (the ~563MB payload).
# The icon ends up on the DLL and NOT on the launcher: measured on Deno 2.9.6,
# the exe had 0 icon resources while the dll had 6 correctly-sized ones. Windows
# resolves a GUI process's taskbar/Explorer icon from the module that owns it, so
# a shipped installer shows the default Deno icon. app.icons.windows writes an
# AppIcon.ico beside the output but never applies it to the launcher, and the
# --icon flag behaves identically.
#
# HOW: rcedit is the tool Electron/Tauri use for exactly this. It is a Windows
# binary, so on a non-Windows host it needs wine — both are only required for a
# Windows target, and the step is skipped with a clear message rather than
# silently doing nothing if either is missing.
#
# Usage: scripts/apply-windows-icon.sh <appdir-with-exe-and-dll> <icon.ico>
set -euo pipefail

APPDIR="${1:?usage: apply-windows-icon.sh <appdir> <icon.ico>}"
ICO="${2:?usage: apply-windows-icon.sh <appdir> <icon.ico>}"

# The LAUNCHER, which is <dirname>.exe. NOT the first .exe found: this directory also
# carries sidecars (SemaClipUpdater.exe, and hidewin.exe for the console-hiding relay), and
# `find -print -quit` returns whichever the filesystem lists first. Once hidewin.exe was
# built first the icon landed on IT and the real launcher shipped bare — the owner noticed a
# relay bearing the app icon and SemaClip.exe with none.
NAME="$(basename "$APPDIR")"
EXE="$APPDIR/$NAME.exe"
if [ ! -f "$EXE" ]; then
  # Fall back to the only .exe that is not a known sidecar.
  EXE="$(find "$APPDIR" -maxdepth 1 -name '*.exe' \
    ! -name 'hidewin.exe' ! -name 'SemaClipUpdater.exe' -print -quit)"
fi
[ -n "$EXE" ] && [ -f "$EXE" ] || { echo "no launcher .exe in $APPDIR (looked for $NAME.exe)" >&2; exit 1; }
echo "launcher: $EXE"
[ -f "$ICO" ] || { echo "no icon at $ICO" >&2; exit 1; }

# A launcher with no icon resource yet. If it already has one the step is a no-op
# (idempotent), so re-running a build does not double-apply.
# Counts RT_GROUP_ICON resources by parsing the PE resource directory directly.
# Deliberately NOT via LIEF: CI does not install it, so an earlier version of this
# check hit its ImportError path and always returned 0 — reporting "the icon did
# not apply" while rcedit had actually succeeded. A verification that depends on
# a package CI lacks is worse than no verification, because it produces a
# confident false negative.
count_icons() {
  python3 - "$1" <<'PY' 2>/dev/null || echo 0
import struct, sys

data = open(sys.argv[1], "rb").read()
if data[:2] != b"MZ":
    print(0); sys.exit(0)
pe = struct.unpack_from("<I", data, 0x3C)[0]
if data[pe:pe+4] != b"PE\0\0":
    print(0); sys.exit(0)
# The optional header begins at pe+24 (after the 4-byte signature and 20-byte
# COFF header). Its data directories sit 112 bytes in for PE32+ and 96 for PE32,
# so the offsets are relative to pe+24 -- getting this wrong reads a zero
# resource RVA and every file looks icon-less.
opt = pe + 24
magic = struct.unpack_from("<H", data, opt)[0]
dd = opt + (112 if magic == 0x20B else 96)
rva, _size = struct.unpack_from("<II", data, dd + 2 * 8)  # index 2 = resources
if rva == 0:
    print(0); sys.exit(0)

# Section table: find the section containing the resource RVA.
nsec = struct.unpack_from("<H", data, pe + 6)[0]
opt_size = struct.unpack_from("<H", data, pe + 20)[0]
sec = pe + 24 + opt_size
for i in range(nsec):
    off = sec + i * 40
    vsize, vaddr, rawsize, rawptr = struct.unpack_from("<IIII", data, off + 8)
    if vaddr <= rva < vaddr + max(vsize, rawsize):
        base = rawptr + (rva - vaddr)
        break
else:
    print(0); sys.exit(0)

def entries(dir_off):
    named, ids = struct.unpack_from("<HH", data, dir_off + 12)
    return dir_off + 16, named + ids

# Level 1: resource types. RT_GROUP_ICON is 14, RT_ICON is 3.
pos, total = entries(base)
groups = 0
for _ in range(total):
    _id, _off = struct.unpack_from("<II", data, pos)
    if (_id & 0x7FFFFFFF) == 14:
        # RT_GROUP_ICON present: the shell has an icon to read. One is enough --
        # the group references the RT_ICON images, and counting those instead
        # would report 4 for a single applied icon.
        lvl2 = base + (_off & 0x7FFFFFFF)
        _p2, n2 = entries(lvl2)
        groups += max(n2, 1)
    pos += 8
print(groups)
PY
}

BEFORE="$(count_icons "$EXE")"
if [ "${BEFORE:-0}" -gt 0 ]; then
  echo "launcher already has $BEFORE icon resource(s); nothing to do"
  exit 0
fi

if command -v rcedit >/dev/null 2>&1; then
  RCEDIT="rcedit"
elif [ -n "${RCEDIT_PATH:-}" ] && [ -f "$RCEDIT_PATH" ]; then
  RCEDIT="$RCEDIT_PATH"
else
  echo "::warning::rcedit not found (set RCEDIT_PATH or install it); the Windows launcher will carry the default Deno icon"
  exit 0
fi

# rcedit is a Windows executable; wine runs it elsewhere.
if head -c2 "$RCEDIT" | grep -q 'MZ' && [ "$(uname -s)" != "MINGW"* ] && [ "$(uname -s)" != "MSYS"* ]; then
  # On Ubuntu the wine64 package installs NOTHING on PATH and a `wine` symlink to
  # the loader fails ("could not exec the wine loader") -- measured. The loader
  # must be invoked by its real path, so prefer WINELOADER_BIN and fall back to a
  # `wine` only if one genuinely exists.
  if [ -n "${WINELOADER_BIN:-}" ] && [ -x "$WINELOADER_BIN" ]; then
    RUN=("$WINELOADER_BIN")
  elif [ -x /usr/lib/wine/wine64 ]; then
    RUN=(/usr/lib/wine/wine64)
  elif command -v wine >/dev/null 2>&1; then
    RUN=(wine)
  else
    echo "::warning::rcedit needs wine and no usable loader was found; skipping the icon"
    exit 0
  fi
else
  RUN=()
fi

# Capture rcedit's own output AND its exit code. Filtering the pipeline with
# `| grep ... || true` (an earlier version) threw away both, so a real failure
# surfaced only as "still has no icon resources" with no cause — the diagnostic
# was as broken as the thing it was diagnosing.
OUT="$(mktemp)"
set +e
"${RUN[@]}" "$RCEDIT" "$EXE" --set-icon "$ICO" >"$OUT" 2>&1
RC=$?
set -e
# Wine on a headless runner emits X/ole/MESA noise that is expected and
# harmless. Keep everything else: if rcedit itself complained, that is the cause.
NOISE='MESA-EGL|pci id for fd|failed to create dri|nodrv_CreateWindow|X server is running|start_rpcss|Failed to open RpcSs|apartment_|CoMarshalInterface|StdMarshalImpl|MarshalInterface|explorer process failed|^wine: created the configuration|configuration in .* has been updated|^[0-9a-f]{4}:err:(ole|winediag)'
INTERESTING="$(grep -viE "$NOISE" "$OUT" | grep -v '^$' || true)"

AFTER="$(count_icons "$EXE")"
if [ "${AFTER:-0}" -le 0 ]; then
  # Loud, not silent: an unapplied icon is exactly the defect this exists to fix.
  echo "::error::rcedit did not apply the icon to $EXE (exit $RC)"
  [ -n "$INTERESTING" ] && echo "rcedit output: $INTERESTING"
  rm -f "$OUT"
  exit 1
fi
rm -f "$OUT"
[ "$RC" -ne 0 ] && echo "note: rcedit exited $RC but the icon landed anyway"
echo "windows icon applied: $EXE ($BEFORE -> $AFTER resources)"
