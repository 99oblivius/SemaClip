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

EXE="$(find "$APPDIR" -maxdepth 1 -name '*.exe' -print -quit)"
[ -n "$EXE" ] || { echo "no .exe in $APPDIR" >&2; exit 1; }
[ -f "$ICO" ] || { echo "no icon at $ICO" >&2; exit 1; }

# A launcher with no icon resource yet. If it already has one the step is a no-op
# (idempotent), so re-running a build does not double-apply.
count_icons() {
  python3 - "$1" <<'PY' 2>/dev/null || echo 0
import sys
try:
    import lief
except ImportError:
    print(0); sys.exit(0)
pe = lief.PE.parse(sys.argv[1])
print(len(pe.resources_manager.icons) if pe and pe.has_resources else 0)
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

# Wine prints MESA/dri warnings on a headless host; they are noise, so keep only
# real errors and let the post-check decide success.
"${RUN[@]}" "$RCEDIT" "$EXE" --set-icon "$ICO" 2>&1 \
  | grep -viE 'MESA-EGL|pci id for fd|failed to create dri|^wine:|fixme:' || true

AFTER="$(count_icons "$EXE")"
if [ "${AFTER:-0}" -le 0 ]; then
  # Loud, not silent: an unapplied icon is exactly the defect this exists to fix.
  echo "::error::rcedit ran but $EXE still has no icon resources"
  exit 1
fi
echo "windows icon applied: $EXE ($BEFORE -> $AFTER resources)"
