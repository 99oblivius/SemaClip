#!/usr/bin/env -S deno run --allow-all
/**
 * Package SemaClip as a desktop app for ONE target platform.
 *
 * Wraps `deno desktop` for two reasons the raw command cannot express:
 *
 *  1. PER-PLATFORM PAYLOAD. `--include ../native` embeds EVERY per-OS subdir, so
 *     a Linux build shipped 21MB of Windows whisper binaries and a Windows build
 *     shipped 330MB of Linux ffmpeg — dead weight in every download and in every
 *     bsdiff patch. The other platform's subtrees are excluded here.
 *     NOTE: `native/whisper/models/` is shared by both platforms and must NOT be
 *     excluded; only the `<os>-<arch>` subdirs are per-platform.
 *
 *  2. CROSS-TARGET CORRECTNESS. `deno desktop` needs `--target` when building for
 *     a platform other than the host, and the app resolves its binaries by the
 *     RUNTIME os (Deno.build.os), not the build host — so the target and the
 *     fetched native tree must agree. This script derives both from one value.
 *
 * Usage:  deno run --allow-all scripts/build-desktop.ts [target]
 *         target: linux-x64 (default) | win-x64
 *         Override with SEMACLIP_TARGET, or by passing an explicit deno target
 *         triple as the first argument.
 *   env:  OUT=<path>  output path (default ../dist/SemaClip)
 *         SEMACLIP_APPIMAGE=1  emit a single-file .AppImage instead of a dir
 */
// node:path + node:url: this script sits OUTSIDE server/, so it has no
// import map and cannot use the "@/..." or "@std/..." aliases.
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO = resolve(dirname(SELF), "..");

/** Maps our platform slug -> the Rust triple deno desktop wants. */
const TRIPLES: Record<string, string> = {
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
  "win-x64": "x86_64-pc-windows-msvc",
};

function hostPlatform(): string {
  if (Deno.build.os === "windows") return "win-x64";
  if (Deno.build.os === "darwin") return "macos-arm64";
  return Deno.build.arch === "aarch64" ? "linux-arm64" : "linux-x64";
}

const argTarget = Deno.args[0];
const platform = argTarget ?? Deno.env.get("SEMACLIP_TARGET") ?? hostPlatform();
const triple = TRIPLES[platform];
if (!triple) {
  console.error(`unknown target "${platform}" — expected one of ${Object.keys(TRIPLES).join(", ")}`);
  Deno.exit(2);
}

// Exclude the OTHER platforms' per-OS subtrees. Both tools lay out their trees
// as <os>-<arch>, so a single rule per family covers ffmpeg and whisper alike.
const exclusions: string[] = [];
for (const sub of Object.keys(TRIPLES)) {
  if (sub === platform) continue;
  exclusions.push(`../native/ffmpeg/${sub}`, `../native/whisper/${sub}`);
}

const out = Deno.env.get("OUT") ?? join(REPO, "dist", "SemaClip");
const appImage = Deno.env.get("SEMACLIP_APPIMAGE") === "1";
const output = appImage ? `${out}.AppImage` : out;

const args = [
  "desktop",
  "--allow-all",
  "--include",
  "../frontend/build",
  "--include",
  "../native",
  ...exclusions.flatMap((e) => ["--exclude", e]),
  "--target",
  triple,
  "-o",
  output,
  "main.ts",
];

console.log(`building for ${platform} (${triple})`);
console.log(`excluding other platforms: ${exclusions.join(", ")}`);
await Deno.remove(output, { recursive: true }).catch(() => {});
const status = await new Deno.Command("deno", {
  args,
  cwd: join(REPO, "server"),
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn().status;
Deno.exit(status.code);
