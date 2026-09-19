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
// scripts/ has no import map, so this is a RELATIVE import into server/ (measured:
// `@/...` does not resolve outside server/). The launcher body must have exactly one
// definition — a second copy here would drift from the one the app writes at runtime.
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
// Per-target container format. Windows ships the portable BUNDLE DIRECTORY, which the release
// zips; there is no installer, and none is built.
// ── NO .msi IS BUILT (owner decision) ───────────────────────────────────────────────────────────
// Windows gets a portable-bundle DIRECTORY, which is zipped by the release. This used to be
// `${out}.msi`, because a per-machine installer was the original plan; that plan was abandoned
// (the .msi installs under Program Files, where the WebView2 runtime it needs cannot write its
// profile, so the window comes up blank) and the installer was then built and uploaded while never
// being OFFERED by the manifest.
//
// MEASURED: the extension is what decides. With a `.msi` path `deno desktop` authors an installer
// and leaves the app directory beside it; with no extension it emits the directory alone.
const output = platform === "win-x64"
  ? out
  : appImage
  ? `${out}.AppImage`
  : out;

// Windows needs two files before `deno desktop` runs, because they must be IN
// the assembled bundle. They are written into the app directory after the build
// instead of being `--include`d, which embeds a file in the payload's virtual
// filesystem where a SEPARATE process (the updater) cannot reach it.
//
// NO version.txt IS STAGED, deliberately. A version stamp in the archive makes the payload
// version-SPECIFIC when it is not: the same files serve any version, and the manifest already
// publishes the target. The updater reads its own per-user record of what it applied, so the file
// bought nothing and cost the archive its idempotence. `server/appfiles/version.txt` is also
// actively REMOVED here — a stale one left in the tree would be embedded into the payload by the
// next build and then shadow the per-user state on the user's machine, making an applied update
// look unapplied and re-apply on every launch.
const stage = join(REPO, "server", "appfiles");
if (platform === "win-x64") {
  await Deno.mkdir(stage, { recursive: true });
  await Deno.remove(join(stage, "version.txt")).catch(() => {});
  await buildSidecar(stage);
  await buildHideConsoleRelay(stage);
}

// The launch workaround must exist in the environment BEFORE the runtime starts,
// because the webview backend initialises first (setting it in main.ts is measured
// too late). `deno desktop --env-file` bakes it into the binary, so the process is
// born with it — this replaces an in-app re-exec, which spawned a second runtime and
// therefore a second window.
// MEASURED: `deno desktop --env-file` only honours a file named exactly `.env`.
// Given any other name it warns "the environment file specified '.env' was not
// found" and carries on WITHOUT the variables — and if the wrong file does get
// compiled it is evaluated as a MODULE, so a dotenv body crashes startup with
// "FOO is not defined". Both are silent-ish failures, so the name is not a detail.
const envFile = join(REPO, "server", ".env");
// Passed RELATIVE to the desktop command (cwd is server/), which is the form the
// minimal-app probe proved works.
const envArg = ".env";
// NOTE: nothing PER-USER belongs in this file. Measured on Deno 2.9.6: `%VAR%` is
// not expanded at all (it ships literally, which is how a Windows install ended up
// with a directory literally named %LOCALAPPDATA%), and `${VAR}` is expanded at
// BUILD time, so it bakes the build machine's value. Neither can name a directory on
// the user's machine. WEBVIEW2_USER_DATA_FOLDER is therefore resolved at RUNTIME in
// server/adapters/outbound/platform/webview-fix.ts.
//
// The version is read HERE, before the env file is written, because the env file is where it is
// baked in. `readVersion()` is hoisted below as a function declaration; this is its first use.
const version = await readVersion();
const launchEnv = platform === "win-x64"
  // SEMACLIP_VERSION is the WINDOWS version channel. `Deno.desktopVersion` is null on the Windows
  // target even when deno.json carries a version (measured: the same app reports "9.9.9" on
  // linux-x64 and null on win-x64, with "app_version":"9.9.9" present in the Windows dylib), and
  // every consumer guards on it — so without this the Windows update check is a silent no-op and the
  // user is never prompted. server/adapters/outbound/platform/app-version.ts reads it as the second
  // channel. It is set for EVERY platform for the same reason: one mechanism, no per-OS surprise.
  ? { SEMACLIP_VERSION: version }
  // Linux keeps native Wayland: the DMA-BUF renderer is what fails on NVIDIA +
  // Wayland, and this flag is the same for every user, so build time is correct.
  // GDK_BACKEND=x11 also works but downgrades the whole app to X11.
  : { WEBKIT_DISABLE_DMABUF_RENDERER: "1", SEMACLIP_VERSION: version };
await Deno.writeTextFile(
  envFile,
  Object.entries(launchEnv).map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
);
console.log(
  Object.keys(launchEnv).length
    ? `launch env (${platform}): ${Object.keys(launchEnv).join(", ")}`
    : `launch env (${platform}): none at build time (per-user paths resolve at runtime)`,
);

const args = [
  "desktop",
  "--allow-all",
  // MEASURED (four variants, minimal app): the file must be named exactly `.env`,
  // in dotenv syntax, AND --no-check must be present — the `.env` is otherwise
  // TYPE-CHECKED as a module and a dotenv body fails with
  // "Cannot find name 'WEBKIT_DISABLE_DMABUF_RENDERER'" (TS2304), aborting the
  // build. Given any other file NAME, desktop warns it looked for '.env' and
  // silently ships without the variables. The JS-module form (`export default {}`)
  // is accepted by the flag but never reaches Deno.env at runtime.
  "--no-check",
  `--env-file=${envArg}`,
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
// beside the payload. The app can read its own embedded files (verified), but a
// SEPARATE process — the Windows sidecar — cannot, and the portable zip that the
// sidecar downloads is built from this directory.
//
// The sidecar and its log live in the bundle and record what they applied, so the
// payload stays version-idempotent regardless of where the bundle is unpacked.
if (platform === "win-x64") {
  const appDir = output;
  await Deno.remove(join(appDir, "version.txt")).catch(() => {});
  await buildSidecar(appDir);
  await buildHideConsoleRelay(appDir);

  // NO LAUNCHER IS SHIPPED. It existed so a user could apply an update by hand, because the app
  // could not start the updater itself. It can now: it spawns the updater detached with its own pid
  // and quits, and the updater swaps the payload and relaunches. A second way to do the same thing
  // is a second thing to keep correct, and this one was never reached any more.
  console.log("portable bundle: SemaClipUpdater.exe (the app starts it itself)");

  await Deno.remove(stage, { recursive: true }).catch(() => {});
// `.env` is a build input generated here, and server/.gitignore excludes it.
await Deno.remove(envFile).catch(() => {});
  console.log(`app files: sidecar written into ${appDir} (no version stamp: the payload is version-idempotent)`);
}

if (platform === "win-x64" && !Deno.env.get("SEMACLIP_SKIP_ICON")) {
  const ico = join(REPO, "assets", "icon.ico");
  const appDir = output;
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

/**
 * Cross-compile the console-hiding relay that Windows spawns run through.
 *
 * Deno cannot spawn a Windows child with BOTH no console window and a writable stdin:
 * `node:child_process` hides the console but deadlocks past ~1MB of stdin (the download
 * freeze), while `Deno.Command` writes reliably but has no console-hiding option (the blank
 * cmd window the owner sees during every download). `conhost.exe --headless` hides it but
 * breaks stdio, so the relay is the only route that satisfies both: it sets
 * CREATE_NO_WINDOW on the real child and proxies stdio on goroutines.
 *
 * `-H=windowsgui` is REQUIRED, not cosmetic: a console-subsystem relay is itself spawned
 * with a console by Deno, which reopens the very window this exists to prevent. Measured:
 * the console-subsystem build added a conhost, the GUI-subsystem build did not, and both
 * proxied stdio identically.
 */
async function buildHideConsoleRelay(appDir: string): Promise<void> {
  const src = join(REPO, "tools", "hidewin");
  const out = join(appDir, "hidewin.exe");
  const go = await new Deno.Command("go", { args: ["version"] }).output();
  if (go.code !== 0) throw new Error("go toolchain not found — needed to build the console-hiding relay");
  const r = await new Deno.Command("go", {
    args: ["build", "-trimpath", "-ldflags", "-s -w -H=windowsgui", "-o", out, "."],
    cwd: src,
    env: { ...Deno.env.toObject(), GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  }).spawn().status;
  if (r.code !== 0) throw new Error(`hidewin build failed (exit ${r.code})`);
  console.log(`hidewin: ${out}`);
}

await Deno.remove(stage, { recursive: true }).catch(() => {});
// `.env` is a build input generated here, and server/.gitignore excludes it.
await Deno.remove(envFile).catch(() => {});

Deno.exit(0);
