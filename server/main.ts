import { createApp } from "@/adapters/inbound/http/routes.ts";
import { buildContainer } from "@/composition/container.ts";
const PORT = parseInt(Deno.env.get("PORT") ?? "5174", 10);
const DB_PATH = Deno.env.get("SEMACLIP_DB") ?? `${Deno.env.get("HOME")}/.semaclip/semaclip.db`;
const CACHE_DIR = Deno.env.get("SEMACLIP_CACHE") ?? `${Deno.env.get("HOME")}/.semaclip/cache`;
const EXPORT_DIR = Deno.env.get("SEMACLIP_EXPORT") ?? `${Deno.env.get("HOME")}/.semaclip/exports`;
const ENGINE_BINARY = Deno.env.get("SEMACLIP_ENGINE") ?? "semaclip-engine";

const container = buildContainer({
  dbPath: DB_PATH,
  cacheDir: CACHE_DIR,
  exportDir: EXPORT_DIR,
  engineBinaryPath: ENGINE_BINARY,
  gpuDevice: null,
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

Deno.serve({ port: PORT }, app.fetch);

console.log(`SemaClip server running on http://localhost:${PORT}`);
console.log(`  DB:       ${DB_PATH}`);
console.log(`  Cache:    ${CACHE_DIR}`);
console.log(`  Export:   ${EXPORT_DIR}`);
console.log(`  Engine:   ${ENGINE_BINARY}`);
