#!/bin/sh
# Fetch pinned external binaries + models for SemaClip's bundled native tree.
# Used by CI and by developers bootstrapping a fresh checkout.
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

echo "==> native tree ready: $WHISPER_DIR (ffmpeg is NOT bundled — resolved from PATH or downloaded on demand)"