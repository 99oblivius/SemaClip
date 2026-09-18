import { createApp } from "@/adapters/inbound/http/routes.ts";
import { buildContainer } from "@/composition/container.ts";
import { ToolRegistry } from "@/adapters/outbound/ffmpeg/tool-paths.ts";
import {
  applyWebviewLaunchEnvironment,
  reportWebviewLaunchEnvironment,
} from "@/adapters/outbound/platform/webview-fix.ts";
import { startAutoUpdate } from "@/adapters/outbound/platform/auto-update.ts";
import {
  adoptWindowLifecycle,
  chromeState,
  logWindowDiagnostics,
} from "@/adapters/outbound/platform/window-lifecycle.ts";
import type { WhisperPaths } from "@/adapters/outbound/transcribe/TranscribeAdapter.ts";

/**
 * The app's version, for the window title.
 *
 * `Deno.desktopVersion` is what a packaged build was compiled with; under `deno run`
 * it is null, so a dev run falls back to the same file the banner reads. Reading the
 * file at startup is cheap and keeps the title honest in both cases.
 */
function appVersion(): string {
  const baked = (Deno as { desktopVersion?: string | null }).desktopVersion;
  if (baked) return baked;
  try {
    const pkg = JSON.parse(
      Deno.readTextFileSync(new URL("../frontend/package.json", import.meta.url)),
    );
    return String(pkg.version ?? "dev");
  } catch {
    return "dev";
  }
}

const PORT = parseInt(Deno.env.get("PORT") ?? "5174", 10);
/** Platform app-data default; SEMACLIP_DATA overrides (isolated test runs). */
const DATA_DIR = Deno.env.get("SEMACLIP_DATA")
  ?? (Deno.build.os === "windows"
    ? `${Deno.env.get("APPDATA") ?? `${Deno.env.get("USERPROFILE") ?? ""}/AppData/Roaming`}/SemaClip`
    : `${Deno.env.get("XDG_DATA_HOME") ?? `${Deno.env.get("HOME")}/.local/share`}/SemaClip`);
const DB_PATH = Deno.env.get("SEMACLIP_DB") ?? `${DATA_DIR}/semaclip.db`;
const CACHE_DIR = Deno.env.get("SEMACLIP_CACHE") ?? `${DATA_DIR}/cache`;
const EXPORT_DIR = Deno.env.get("SEMACLIP_EXPORT") ?? `${DATA_DIR}/exports`;
const ENGINE_BINARY = Deno.env.get("SEMACLIP_ENGINE") ?? "semaclip-engine";

// Install file logging BEFORE anything else: a packaged desktop app has no console, so a
// startup failure would otherwise leave no trace at all. This is what makes a bug report
// from a user's machine possible.
installFileLogging(DATA_DIR);

// Report what the window was actually created with, and whether adoption worked. The
// owner reported "still decorated, no functional chrome" and there was no way to tell
// WHY — an adoption failure must be visible, not a silent early return.
logWindowDiagnostics();

/**
 * v2 engine selection: if the bundled whisper.cpp tree exists under native/,
 * the in-process TS detection engine is used. Falls back to the external
 * engine binary (Python mock) when bundling hasn't happened — but logs it.
 */
const nativeRoot = new URL("../native/whisper/", import.meta.url);
const nativeSubdir = Deno.build.os === "windows" ? "win-x64" : "linux-x64";
let detectionWhisper: WhisperPaths | undefined;
try {
  const cliName = Deno.build.os === "windows" ? "whisper-cli.exe" : "whisper-cli";
  await Deno.stat(new URL(`${nativeSubdir}/${cliName}`, nativeRoot));
  await Deno.stat(new URL("models/ggml-base.en-q5_1.bin", nativeRoot));
  const binDir = new URL(`${nativeSubdir}/`, nativeRoot).pathname;
  detectionWhisper = {
    binDir,
    modelsDir: new URL("models/", nativeRoot).pathname,
    modelFile: "ggml-base.en-q5_1.bin",
    vadModelFile: "ggml-silero-v5.1.2.bin",
  };
  console.log("Engine: in-process detection (whisper.cpp bundled)");
} catch {
  console.log("Engine: external binary mode (SEMACLIP_ENGINE) — native whisper.cpp tree not found");
}

// ffmpeg/ffprobe are NOT bundled: a system copy on PATH is used as-is, and a
// machine without one is offered a download from the UI (see tool-paths.ts).
// Resolved before the container because adapters take a path at construction.
const tools = await ToolRegistry.create(DATA_DIR);

const container = await buildContainer({
  dbPath: DB_PATH,
  dataDir: DATA_DIR,
  cacheDir: CACHE_DIR,
  exportDir: EXPORT_DIR,
  engineBinaryPath: ENGINE_BINARY,
  gpuDevice: null,
  detectionWhisper,
  tools,
});

const app = createApp(container.httpDeps, container.bus);

// Frontend static files + SPA fallback.
const frontendRoot = new URL("../frontend/build/", import.meta.url);
let frontendExists = false;
try {
  await Deno.stat(frontendRoot);
  frontendExists = true;
} catch {
  console.warn("Frontend build not found — API-only mode");
}

if (frontendExists) {
  // Serve static assets (JS, CSS, images) from the frontend build.
  app.get("/_app/*", async (c) => {
    return await serveFile(c.req.path, frontendRoot);
  });
  app.get("/favicon*", async (c) => {
    return await serveFile(c.req.path, frontendRoot);
  });

  // SPA fallback: any non-API route serves index.html.
  app.get("*", async (c) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith("/api") || path === "/ws") return c.notFound();

    // Try to serve the exact file first.
    const fileResp = await serveFile(path, frontendRoot);
    if (fileResp.status === 200) return fileResp;

    // Fallback to index.html for client-side routing.
    return await serveFile("/index.html", frontendRoot);
  });
}

async function serveFile(
  path: string,
  root: URL,
): Promise<Response> {
  const cleanPath = path === "/" ? "/index.html" : path;
  const filePath = new URL(`.${cleanPath}`, root);
  try {
    const file = await Deno.open(filePath, { read: true });
    const stat = await file.stat();
    const headers = new Headers();
    headers.set("Content-Length", String(stat.size));
    headers.set("Accept-Ranges", "bytes");
    // Set content type based on extension.
    if (cleanPath.endsWith(".html")) headers.set("Content-Type", "text/html");
    else if (cleanPath.endsWith(".js")) headers.set("Content-Type", "application/javascript");
    else if (cleanPath.endsWith(".css")) headers.set("Content-Type", "text/css");
    else if (cleanPath.endsWith(".svg")) headers.set("Content-Type", "image/svg+xml");
    else if (cleanPath.endsWith(".json")) headers.set("Content-Type", "application/json");
    return new Response(file.readable, { status: 200, headers });
  } catch {
    return new Response("Not Found", { status: 404 });
  }
}

// Bind loopback only: the API accepts arbitrary local paths (import-file,
// PATCH vodPath) and serves files — binding all interfaces would expose
// filesystem reads and subprocess triggers to the LAN.
// Before serving: the window must be adopted while it exists, and this is also
// what makes a window close exit the process instead of leaving a headless server
// holding the port (measured on Windows: close did nothing).
// Resolve per-user launch environment BEFORE anything else: the webview host may
// initialise around the entrypoint, and the Windows profile path cannot come from the
// build-time env file (see webview-fix.ts for the measurements).
applyWebviewLaunchEnvironment();

// Report the launch workaround this build was compiled with (see webview-fix.ts).
// It must arrive via `deno desktop --env-file`, because setting it here is too late.
reportWebviewLaunchEnvironment();

// Adopt the startup window. Frameless chrome is the DEFAULT: the owner's requirement is
// a desktop app with its own chrome, and "still has decoration on Windows when it should
// not" is a bug report against the opt-in default this used to have.
//
// The app can carry drag, close, and any paint. It CANNOT minimise or maximise: verified
// against the runtime's own string table (Deno 2.9.6) — the window class exposes
// getSize/setSize/getPosition/setPosition/isResizable/setResizable/isAlwaysOnTop/
// setAlwaysOnTop/getOpacity/setOpacity/isVisible/focus/openDevtools/reload/executeJs/
// getNativeWindow/bind/unbind, and the only `minimize`/`maximize` strings in the binary
// belong to Intl.Locale. A frameless window therefore has no titlebar and no replacements.
//
// SEMACLIP_NATIVE_DECORATIONS=1 restores the OS titlebar for anyone who needs the system
// controls back — an explicit, documented escape hatch rather than a silent default.
const useNativeDecorations = Deno.env.get("SEMACLIP_NATIVE_DECORATIONS") === "1";
const frameless = !useNativeDecorations;
const APP_TITLE = `SemaClip ${appVersion()}`;
// ONE construction, with the title applied to the window it adopts. Calling any
// separate title setter here would construct a SECOND window: the runtime adopts the
// implicit one on the first construction and opens a new window on every one after
// that, which is what produced a blank extra window on both platforms.
adoptWindowLifecycle({ frameless, title: APP_TITLE });
{
  const c = chromeState();
  console.log(
    `window: decorations=${c.nativeDecorations ? "native" : "none (custom chrome)"} ` +
      `minimize=${c.canMinimize} maximize=${c.canMaximize}`,
  );
}

Deno.serve({ port: PORT, hostname: "127.0.0.1" }, app.fetch);

// Report the address that is ACTUALLY serving. Inside a desktop app the runtime
// binds Deno.serve to DENO_SERVE_ADDRESS and ignores PORT entirely, so printing
// "localhost:5174" described a port nothing was listening on — misleading on every
// packaged launch, and it sent the earlier phantom-window investigation after the
// wrong address.
const serveAddress = Deno.env.get("DENO_SERVE_ADDRESS");
console.log(
  serveAddress
    ? `SemaClip server running on http://${serveAddress.replace(/^tcp:/, "")} (desktop)`
    : `SemaClip server running on http://localhost:${PORT}`,
);
console.log(`  DB:       ${DB_PATH}`);
console.log(`  Cache:    ${CACHE_DIR}`);
console.log(`  Export:   ${EXPORT_DIR}`);
console.log(`  Engine:   ${ENGINE_BINARY}`);
// One line, one answer: the previous version printed the resolved NAME with its
// source and then a separate availability check, which could (and did) contradict
// itself on screen.
{
  const st = tools.status();
  console.log(
    st.available
      ? `  Tools:    ffmpeg=${tools.ffmpeg} (${st.paths.source})`
      : `  Tools:    ffmpeg missing — the UI offers to download it (${st.managedDir})`,
  );
}

// Update check. Inert under `deno run` (no baked-in version) and when no
// release URL is configured, so this changes nothing in development.
//
// Awaited because on Windows it first places the sidecar updater at a real per-user
// path — the payload's virtual filesystem is readable only from this process, so if
// that does not complete there is no way for a staged update to ever be applied.
import { installFileLogging } from "@/adapters/outbound/platform/log-file.ts";
await startAutoUpdate();
