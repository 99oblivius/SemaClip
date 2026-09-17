#!/usr/bin/env -S deno run --allow-all
/**
 * Package SemaClip as a desktop app for ONE target platform.
 *
 * Wraps `deno desktop` for two reasons the raw command cannot express:
 *
 *  1. PER-PLATFORM PAYLOAD. `--include ../native` embeds EVERY per-OS subdir, so
 *     a Linux build shipped Windows whisper binaries as dead weight in every
 *     download and every patch. The other platform's subtrees are excluded here.
 *     NOTE: `native/whisper/models/` is shared by both platforms and must NOT be
 *     excluded; only the `<os>-<arch>` subdirs are per-platform.
 *     (ffmpeg is NOT bundled at all — see server/adapters/outbound/ffmpeg/tool-paths.ts
 *     for why the 330MB payload that caused was removed.)
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
  exclusions.push(`../native/whisper/${sub}`);
}

const out = Deno.env.get("OUT") ?? join(REPO, "dist", "SemaClip");
const appImage = Deno.env.get("SEMACLIP_APPIMAGE") === "1";
// Per-target container format. Windows ships a real .msi (owner decision:
// native installer, authored by deno desktop in pure Rust and cross-compiled
// from Linux). The version scheme is what makes this possible -- see
// scripts/version.sh for the Windows Installer ProductVersion bounds.
// MEASURED: the .msi write ALSO leaves the assembled app directory beside it
// (SemaClip/ with the .exe and .dll), so a portable zip needs no second build.
const output = platform === "win-x64"
  ? `${out}.msi`
  : appImage
  ? `${out}.AppImage`
  : out;

// Windows needs two files INSIDE the assembler's input, so they must exist before
// `deno desktop` runs — a post-step only reaches the app directory it leaves
// beside the .msi, never the .msi's own cabinet (measured: the installer carried
// exactly the payload and the launcher, with no updater and no version.txt).
const stage = join(REPO, "server", "appfiles");
if (platform === "win-x64") {
  await Deno.mkdir(stage, { recursive: true });
  await Deno.writeTextFile(
    join(stage, "version.txt"),
    `version=${await readVersion()}\nchannel=${channel()}\nmanifest=${manifestUrl()}\n`,
  );
  console.log(`version.txt: ${await readVersion()} (${channel()})`);
  await buildSidecar(stage);
}

const args = [
  "desktop",
  "--allow-all",
  "--include",
  "../frontend/build",
  "--include",
  "../native",
  ...(platform === "win-x64" ? ["--include", "appfiles"] : []),
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
if (status.code !== 0) Deno.exit(status.code);

// Windows: `deno desktop` puts the icon on the payload DLL, not the launcher
// EXE, and Windows reads a GUI process's taskbar/Explorer icon from the launcher.
// Post-process it so the icon declared in deno.json actually appears.
// Real files in the assembled app directory, AFTER the build.
//
// `--include appfiles` does NOT do this: measured, --include embeds a file into
// the compiled executable's virtual filesystem and never emits it as a real file
// beside the payload. The app can read an embedded version.txt (verified), but a
// SEPARATE process — the Windows sidecar — cannot, and the portable zip that the
// sidecar downloads is built from this directory, so an embedded-only
// version.txt left the published payload with no version record at all.
//
// The MSI is authored before this point and so cannot carry these (deno desktop
// limitation); the sidecar therefore falls back to a per-user state file, which
// is also the only location that stays writable in Program Files.
if (platform === "win-x64") {
  const appDir = output.endsWith(".msi") ? output.slice(0, -4) : output;
  await Deno.writeTextFile(
    join(appDir, "version.txt"),
    `version=${await readVersion()}\nchannel=${channel()}\nmanifest=${manifestUrl()}\n`,
  );
  await buildSidecar(appDir);
  await Deno.remove(stage, { recursive: true }).catch(() => {});
  console.log(`app files: version.txt + sidecar written into ${appDir}`);
}

if (platform === "win-x64" && !Deno.env.get("SEMACLIP_SKIP_ICON")) {
  const ico = join(REPO, "assets", "icon.ico");
  // The .msi build leaves the assembled app directory next to the installer.
  const appDir = output.endsWith(".msi") ? output.slice(0, -4) : output;
  const r = await new Deno.Command(join(REPO, "scripts", "apply-windows-icon.sh"), {
    args: [appDir, ico],
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  // Non-fatal by design: a missing rcedit/wine warns and exits 0, but a genuine
  // failure to apply exits non-zero and must not be swallowed.
  if (r.code !== 0) {
    console.error("windows icon step failed (see above)");
    Deno.exit(r.code);
  }
}

/** The version the bundle claims, taken from frontend/package.json — the same
 *  file the UI banner is built from, so the banner and version.txt cannot drift. */
async function readVersion(): Promise<string> {
  const pkg = JSON.parse(await Deno.readTextFile(join(REPO, "frontend", "package.json")));
  const v = String(pkg.version ?? "");
  if (!v) throw new Error("frontend/package.json has no version");
  return v;
}

/** Nightly unless the build explicitly asks for stable. */
function channel(): string {
  return Deno.env.get("SEMACLIP_CHANNEL") === "stable" ? "stable" : "nightly";
}

/** The manifest this build should poll, mirroring deno.json's desktop.release. */
function manifestUrl(): string {
  const override = Deno.env.get("SEMACLIP_UPDATE_URL");
  if (override) return override;
  const denoJson = JSON.parse(Deno.readTextFileSync(join(REPO, "server", "deno.json")));
  const base = denoJson?.desktop?.release?.baseUrl;
  if (!base) throw new Error("server/deno.json has no desktop.release.baseUrl");
  return `${String(base).replace(/\/$/, "")}/latest.json`;
}

/**
 * Cross-compile the Windows sidecar updater into the bundle.
 *
 * Go, stdlib only: it builds a static .exe from any host with no module
 * downloads, which matters because this runs inside the release pipeline. The
 * updater cannot update itself (a running executable cannot overwrite its own
 * image), so it is replaced only by a new installer.
 */
async function buildSidecar(appDir: string): Promise<void> {
  const src = join(REPO, "tools", "updater");
  const out = join(appDir, "SemaClipUpdater.exe");
  const go = await new Deno.Command("go", { args: ["version"] }).output();
  if (go.code !== 0) throw new Error("go toolchain not found — needed to build the Windows sidecar updater");
  const r = await new Deno.Command("go", {
    args: ["build", "-trimpath", "-ldflags", "-s -w", "-o", out, "."],
    cwd: src,
    env: { ...Deno.env.toObject(), GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (r.code !== 0) throw new Error(`sidecar build failed (exit ${r.code})`);
  console.log(`sidecar: ${out}`);
}

await Deno.remove(stage, { recursive: true }).catch(() => {});

Deno.exit(0);
