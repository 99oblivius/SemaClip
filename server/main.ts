import { createApp } from "@/adapters/inbound/http/routes.ts";
import { buildContainer } from "@/composition/container.ts";
import type { WhisperPaths } from "@/adapters/outbound/transcribe/TranscribeAdapter.ts";
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

const container = await buildContainer({
  dbPath: DB_PATH,
  dataDir: DATA_DIR,
  cacheDir: CACHE_DIR,
  exportDir: EXPORT_DIR,
  engineBinaryPath: ENGINE_BINARY,
  gpuDevice: null,
  detectionWhisper,
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
Deno.serve({ port: PORT, hostname: "127.0.0.1" }, app.fetch);

console.log(`SemaClip server running on http://localhost:${PORT}`);
console.log(`  DB:       ${DB_PATH}`);
console.log(`  Cache:    ${CACHE_DIR}`);
console.log(`  Export:   ${EXPORT_DIR}`);
console.log(`  Engine:   ${ENGINE_BINARY}`);
