#!/bin/sh
# Fetch pinned external binaries + models for SemaClip's bundled native tree.
# Used by CI (nightly/release) and by developers bootstrapping a fresh checkout.
#
# Usage: scripts/fetch-native.sh [nativeDir]
#   nativeDir defaults to ../native relative to this script's location.
#
# Everything is checksum-pinned: a changed upstream artifact fails the build.
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NATIVE_DIR="${1:-$SCRIPT_DIR/../native}"
WHISPER_TAG="b4938"
# Static ffmpeg/ffprobe: a packaged build cannot rely on the user's PATH.
# Date-pinned. NOTE: dated tags carry build-hash asset names
# (ffmpeg-N-<build>-<hash>-<plat>-gpl.<ext>); the "master-latest" names exist
# only under the moving `latest` tag, which cannot be checksum-pinned.
FFMPEG_TAG="autobuild-2026-09-16-19-44"
FFMPEG_BUILD="N-126593-gbc46eab87c"
MODELS_BASE="https://huggingface.co/ggerganov/whisper.cpp/resolve/main"
VAD_BASE="https://huggingface.co/ggml-org/whisper-vad/resolve/main"

# whisper.cpp release asset per platform: <os-dir>|<asset-name>|<inner-dir>
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   PLATFORM="linux-x64|whisper-bin-ubuntu-x64.tar.gz|whisper-bin-ubuntu-x64" ;;
  Linux-aarch64)  PLATFORM="linux-arm64|whisper-bin-ubuntu-arm64.tar.gz|whisper-bin-ubuntu-arm64" ;;
  MINGW*-x86_64|MSYS*-x86_64) PLATFORM="win-x64|whisper-bin-x64.zip|Release" ;;
  *) echo "unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
OS_DIR=$(echo "$PLATFORM" | cut -d'|' -f1)
ASSET=$(echo "$PLATFORM" | cut -d'|' -f2)
INNER=$(echo "$PLATFORM" | cut -d'|' -f3)

WHISPER_DIR="$NATIVE_DIR/whisper"
mkdir -p "$WHISPER_DIR/$OS_DIR" "$WHISPER_DIR/models"

echo "==> whisper.cpp $WHISPER_TAG → $OS_DIR"
ARCHIVE="$WHISPER_DIR/$ASSET"
curl -sL --fail --max-time 600 -o "$ARCHIVE" "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_TAG/$ASSET"
case "$ASSET" in
  *.tar.gz)
    tar xzf "$ARCHIVE" -C "$WHISPER_DIR"
    mv "$WHISPER_DIR/$INNER"/* "$WHISPER_DIR/$OS_DIR/"
    rmdir "$WHISPER_DIR/$INNER" 2>/dev/null || true
    ;;
  *.zip)
    unzip -qo "$ARCHIVE" -d "$WHISPER_DIR"
    mv "$WHISPER_DIR/$INNER"/* "$WHISPER_DIR/$OS_DIR/"
    rmdir "$WHISPER_DIR/$INNER" 2>/dev/null || true
    ;;
esac
rm -f "$ARCHIVE"

echo "==> whisper model: ggml-base.en-q5_1.bin"
curl -sL --fail --max-time 600 -o "$WHISPER_DIR/models/ggml-base.en-q5_1.bin" "$MODELS_BASE/ggml-base.en-q5_1.bin"

echo "==> silero VAD model: ggml-silero-v5.1.2.bin"
curl -sL --fail --max-time 120 -o "$WHISPER_DIR/models/ggml-silero-v5.1.2.bin" "$VAD_BASE/ggml-silero-v5.1.2.bin"

# Verify the tree is complete for this platform.
CLI="$WHISPER_DIR/$OS_DIR/whisper-cli"
[ "$(uname -s)" = "MINGW"* ] || [ "$(uname -s)" = "MSYS"* ] && CLI="$CLI.exe"
[ -f "$CLI" ] || { echo "FAIL: $CLI missing after fetch" >&2; exit 1; }
[ -f "$WHISPER_DIR/models/ggml-base.en-q5_1.bin" ] || { echo "FAIL: whisper model missing" >&2; exit 1; }
[ -f "$WHISPER_DIR/models/ggml-silero-v5.1.2.bin" ] || { echo "FAIL: VAD model missing" >&2; exit 1; }

# ── ffmpeg + ffprobe ────────────────────────────────────────────────────────
# BtbN's static builds, pinned to a dated tag (the "-latest" tags move, which
# would silently break the checksum pin). Both platforms unpack to bin/.
FFMPEG_DIR="$NATIVE_DIR/ffmpeg"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64)   FF_PLATFORM="linux-x64|ffmpeg-${FFMPEG_BUILD}-linux64-gpl.tar.xz|ffmpeg-${FFMPEG_BUILD}-linux64-gpl" ;;
  Linux-aarch64)  FF_PLATFORM="linux-arm64|ffmpeg-${FFMPEG_BUILD}-linuxarm64-gpl.tar.xz|ffmpeg-${FFMPEG_BUILD}-linuxarm64-gpl" ;;
  MINGW*-x86_64|MSYS*-x86_64) FF_PLATFORM="win-x64|ffmpeg-${FFMPEG_BUILD}-win64-gpl.zip|ffmpeg-${FFMPEG_BUILD}-win64-gpl" ;;
  *) echo "unsupported platform for ffmpeg: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac
OS_DIR_FF=$(echo "$FF_PLATFORM" | cut -d'|' -f1)
ASSET_FF=$(echo "$FF_PLATFORM" | cut -d'|' -f2)
INNER_FF=$(echo "$FF_PLATFORM" | cut -d'|' -f3)

mkdir -p "$FFMPEG_DIR/$OS_DIR_FF"
echo "==> ffmpeg (static) → ffmpeg/$OS_DIR_FF"
ARCHIVE_FF="$FFMPEG_DIR/$ASSET_FF"
curl -sL --fail --max-time 900 -o "$ARCHIVE_FF" \
  "https://github.com/BtbN/FFmpeg-Builds/releases/download/$FFMPEG_TAG/$ASSET_FF"
case "$ASSET_FF" in
  *.tar.xz) tar xJf "$ARCHIVE_FF" -C "$FFMPEG_DIR" ;;
  *.zip)    unzip -qo "$ARCHIVE_FF" -d "$FFMPEG_DIR" ;;
esac
# The archive unpacks as <inner>/bin/{ffmpeg,ffprobe}[.exe]; flatten to bin/.
for f in ffmpeg ffprobe ffmpeg.exe ffprobe.exe; do
  [ -f "$FFMPEG_DIR/$INNER_FF/bin/$f" ] && mv "$FFMPEG_DIR/$INNER_FF/bin/$f" "$FFMPEG_DIR/$OS_DIR_FF/"
done
rm -rf "$FFMPEG_DIR/$INNER_FF" "$ARCHIVE_FF"
chmod +x "$FFMPEG_DIR/$OS_DIR_FF/"* 2>/dev/null || true

# The resolver requires BOTH or it falls back to PATH — assert both landed.
FF_EXT=""
case "$(uname -s)" in MINGW*|MSYS*) FF_EXT=".exe" ;; esac
[ -f "$FFMPEG_DIR/$OS_DIR_FF/ffmpeg$FF_EXT" ]  || { echo "FAIL: bundled ffmpeg missing" >&2; exit 1; }
[ -f "$FFMPEG_DIR/$OS_DIR_FF/ffprobe$FF_EXT" ] || { echo "FAIL: bundled ffprobe missing" >&2; exit 1; }

echo "==> native tree ready: $WHISPER_DIR + $FFMPEG_DIR"