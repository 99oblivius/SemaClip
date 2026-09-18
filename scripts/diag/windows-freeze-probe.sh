#!/bin/bash
# DOES THE EVENT LOOP BLOCK ON WINDOWS WHEN ffmpeg IS FED AN EMPTY PIPE?
#
# The freeze was isolated to the gap between ffmpeg spawning and the first muxed bytes, on
# a machine where ffmpeg never exited and chat had completed. On Linux this exact shape
# does not reproduce (a 1080p60 import held a 3.8ms worst loop latency over 750 samples),
# so the remaining suspects are Windows-specific. This settles which one, in ~30 seconds,
# with no app build required.
#
# Usage:  bash windows-freeze-probe.sh /path/to/ffmpeg.exe
set -u
FF="${1:-C:/Users/light/AppData/Roaming/SemaClip/tools/ffmpeg/win-x64/bin/ffmpeg.exe}"
OUT="${TEMP:-/tmp}/semaclip-probe"
rm -rf "$OUT"; mkdir -p "$OUT"

echo "=== ffmpeg under test: $FF"
if [ ! -x "$FF" ] && [ ! -f "$FF" ]; then echo "ERROR: not found: $FF"; exit 1; fi
echo

# ── Probe A: does this ffmpeg even RUN? ───────────────────────────────────────────────
# The managed download is a `-shared` build with a lib/ tree beside it. If a DLL is
# missing, ffmpeg fails instantly — and the app's spawn step would look like a stall.
echo "=== A. version check (does ffmpeg run at all?)"
"$FF" -version 2>&1 | head -3 | sed 's/^/  /'
echo "  exit=$?"
echo

# ── Probe B: THE SUSPECT. Start ffmpeg with a piped stdin and NEVER write. ────────────
# Exactly what the app does while it fetches the first HLS chunk. If the event loop blocks
# here, the whole app freezes — no HTTP, no navigation, nothing.
echo "=== B. ffmpeg with a piped stdin that never receives data (the app's stall shape)"
cat > "$OUT/probe.mjs" <<'EOF'
import { spawn } from "node:child_process";

const ff = process.argv[2];
const child = spawn(ff, [
  "-hide_banner", "-loglevel", "error",
  "-f", "mpegts", "-i", "pipe:0",
  "-c", "copy", "-bsf:a", "aac_adtstoasc",
  "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
  "-f", "mp4", "pipe:1",
], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });

let stderr = "";
child.stderr.on("data", (d) => { stderr += d.toString(); });
let stdoutBytes = 0;
child.stdout.on("data", (d) => { stdoutBytes += d.length; });

// The measurement: a 100ms timer must keep firing. If it stops, the loop is blocked.
let ticks = 0;
let worstGap = 0;
let last = Date.now();
const timer = setInterval(() => {
  const now = Date.now();
  const gap = now - last;
  last = now;
  if (gap > worstGap) worstGap = gap;
  ticks++;
}, 100);

// Answer any HTTP request so we measure the loop, not the network.
import { createServer } from "node:http";
const port = 5399;
const server = createServer((_req, res) => res.end("ok"));
server.listen(port, "127.0.0.1");

setTimeout(async () => {
  console.log(`  ticks in 10s:      ${ticks} (expect ~100 if the loop is healthy)`);
  console.log(`  worst timer gap:   ${worstGap}ms`);
  let httpOk = "no";
  try {
    const r = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(3000) });
    if (r.ok) httpOk = "yes";
  } catch (e) { httpOk = `FAILED: ${e.name}`; }
  console.log(`  HTTP responded:    ${httpOk}`);
  console.log(`  ffmpeg stdout:     ${stdoutBytes} bytes`);
  console.log(`  ffmpeg alive:      ${child.exitCode === null ? "yes (hung, as the app saw)" : `exited ${child.exitCode}`}`);
  if (stderr.trim()) console.log(`  ffmpeg stderr:     ${stderr.trim().slice(0, 400)}`);
  console.log();
  if (ticks >= 90 && httpOk === "yes") {
    console.log("  => THE LOOP IS HEALTHY. The freeze is NOT in ffmpeg/pipe handling.");
    console.log("     Next suspect: the chunk fetch that never arrives.");
  } else {
    console.log("  => THE LOOP IS BLOCKED. THIS IS THE FREEZE.");
  }
  clearInterval(timer);
  child.kill();
  server.close();
  process.exit(0);
}, 10_000);
EOF
node "$OUT/probe.mjs" "$FF" 2>&1 | sed 's/^/  /'
echo

# ── Probe C: can ffmpeg actually open a network stream from here? ─────────────────────
echo "=== C. can ffmpeg reach the network? (a stall could be a blocked CDN connection)"
"$FF" -hide_banner -loglevel error -t 2 -i "https://usher.ttvnw.net/vod/2869431804.m3u8" -f null - 2>&1 | head -4 | sed 's/^/  /'
echo "  (an auth error means the network WORKS; a timeout means it does not)"
echo

echo "=== DONE — send this whole output back"
