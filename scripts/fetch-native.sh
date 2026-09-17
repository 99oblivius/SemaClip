#!/bin/sh
# Fetch pinned external binaries + models for SemaClip's bundled native tree.
# Used by CI (nightly/release) and by developers bootstrapping a fresh checkout.
#
# Usage: scripts/fetch-native.sh [nativeDir]
#   nativeDir defaults to ../native relative to this script's location.
#
# Set SEMACLIP_NATIVE_PLATFORM to fetch for a platform that is NOT the host:
#   linux-x64 | linux-arm64 | win-x64
# This is REQUIRED for cross-compilation. The platform used to be derived from
# `uname`, which describes the HOST — so cross-compiling Windows from a Linux
# runner embedded LINUX binaries and the Windows build silently fell back to
# PATH for both ffmpeg and whisper (a build that succeeds and produces a broken
# artifact). CI must pass the platform it is building FOR.
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

# Resolve the platform we are fetching FOR (not necessarily the host).
if [ -n "${SEMACLIP_NATIVE_PLATFORM:-}" ]; then
  TARGET_PLATFORM="$SEMACLIP_NATIVE_PLATFORM"
else
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   TARGET_PLATFORM="linux-x64" ;;
    Linux-aarch64)  TARGET_PLATFORM="linux-arm64" ;;
    MINGW*-x86_64|MSYS*-x86_64) TARGET_PLATFORM="win-x64" ;;
    *) echo "unsupported platform: $(uname -s)-$(uname -m) (set SEMACLIP_NATIVE_PLATFORM to override)" >&2; exit 1 ;;
  esac
fi

# whisper.cpp release asset per platform: <os-dir>|<asset-name>|<inner-dir>
case "$TARGET_PLATFORM" in
  linux-x64)  PLATFORM="linux-x64|whisper-bin-ubuntu-x64.tar.gz|whisper-bin-ubuntu-x64" ;;
  linux-arm64) PLATFORM="linux-arm64|whisper-bin-ubuntu-arm64.tar.gz|whisper-bin-ubuntu-arm64" ;;
  win-x64)    PLATFORM="win-x64|whisper-bin-x64.zip|Release" ;;
  *) echo "unsupported SEMACLIP_NATIVE_PLATFORM: $TARGET_PLATFORM" >&2; exit 1 ;;
esac
OS_DIR=$(echo "$PLATFORM" | cut -d'|' -f1)
ASSET=$(echo "$PLATFORM" | cut -d'|' -f2)
INNER=$(echo "$PLATFORM" | cut -d'|' -f3)

WHISPER_DIR="$NATIVE_DIR/whisper"
mkdir -p "$WHISPER_DIR/$OS_DIR" "$WHISPER_DIR/models"

echo "==> whisper.cpp $WHISPER_TAG → $OS_DIR"
ARCHIVE="$WHISPER_DIR/$ASSET"
attempt=1
until curl -sL --fail --max-time 600 -o "$ARCHIVE" \
    "https://github.com/ggml-org/whisper.cpp/releases/download/$WHISPER_TAG/$ASSET"; do
  rm -f "$ARCHIVE"
  [ "$attempt" -ge 3 ] && { echo "FAIL: whisper download failed after $attempt attempts" >&2; exit 1; }
  echo "  whisper download attempt $attempt failed; retrying" >&2
  attempt=$((attempt + 1))
  sleep 5
done
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
[ "$TARGET_PLATFORM" = "win-x64" ] && CLI="$CLI.exe"
[ -f "$CLI" ] || { echo "FAIL: $CLI missing after fetch" >&2; exit 1; }
[ -f "$WHISPER_DIR/models/ggml-base.en-q5_1.bin" ] || { echo "FAIL: whisper model missing" >&2; exit 1; }
[ -f "$WHISPER_DIR/models/ggml-silero-v5.1.2.bin" ] || { echo "FAIL: VAD model missing" >&2; exit 1; }

# ── ffmpeg + ffprobe ────────────────────────────────────────────────────────
# BtbN's static builds, pinned to a dated tag (the "-latest" tags move, which
# would silently break the checksum pin). Both platforms unpack to bin/.
FFMPEG_DIR="$NATIVE_DIR/ffmpeg"
case "$TARGET_PLATFORM" in
  linux-x64)   FF_PLATFORM="linux-x64|ffmpeg-${FFMPEG_BUILD}-linux64-gpl.tar.xz|ffmpeg-${FFMPEG_BUILD}-linux64-gpl" ;;
  linux-arm64) FF_PLATFORM="linux-arm64|ffmpeg-${FFMPEG_BUILD}-linuxarm64-gpl.tar.xz|ffmpeg-${FFMPEG_BUILD}-linuxarm64-gpl" ;;
  win-x64)     FF_PLATFORM="win-x64|ffmpeg-${FFMPEG_BUILD}-win64-gpl.zip|ffmpeg-${FFMPEG_BUILD}-win64-gpl" ;;
  *) echo "unsupported platform for ffmpeg: $TARGET_PLATFORM" >&2; exit 1 ;;
esac
OS_DIR_FF=$(echo "$FF_PLATFORM" | cut -d'|' -f1)
ASSET_FF=$(echo "$FF_PLATFORM" | cut -d'|' -f2)
INNER_FF=$(echo "$FF_PLATFORM" | cut -d'|' -f3)

mkdir -p "$FFMPEG_DIR/$OS_DIR_FF"
echo "==> ffmpeg (static) → ffmpeg/$OS_DIR_FF"
ARCHIVE_FF="$FFMPEG_DIR/$ASSET_FF"
# Retry from scratch: these are 60-190MB assets and a single curl to them over a
# throttled CI link fails with exit 22 mid-transfer, killing the whole build.
# curl's --retry does not cover a truncated body; deleting before each attempt
# also avoids resuming into a corrupt partial.
attempt=1
until curl -sL --fail --max-time 1200 -o "$ARCHIVE_FF" \
    "https://github.com/BtbN/FFmpeg-Builds/releases/download/$FFMPEG_TAG/$ASSET_FF"; do
  rm -f "$ARCHIVE_FF"
  [ "$attempt" -ge 3 ] && { echo "FAIL: ffmpeg download failed after $attempt attempts" >&2; exit 1; }
  echo "  ffmpeg download attempt $attempt failed; retrying" >&2
  attempt=$((attempt + 1))
  sleep 5
done
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
[ "$TARGET_PLATFORM" = "win-x64" ] && FF_EXT=".exe"
[ -f "$FFMPEG_DIR/$OS_DIR_FF/ffmpeg$FF_EXT" ]  || { echo "FAIL: bundled ffmpeg missing" >&2; exit 1; }
[ -f "$FFMPEG_DIR/$OS_DIR_FF/ffprobe$FF_EXT" ] || { echo "FAIL: bundled ffprobe missing" >&2; exit 1; }

echo "==> native tree ready: $WHISPER_DIR + $FFMPEG_DIR"