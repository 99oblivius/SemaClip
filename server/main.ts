import { serveStatic } from "hono/deno";
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

// Frontend static files (production build from ../frontend/build)
const frontendRoot = new URL("../frontend/build/", import.meta.url);
try {
  await Deno.stat(frontendRoot);
  app.use("*", serveStatic({ root: frontendRoot.pathname }));
} catch {
  console.warn("Frontend build not found — API-only mode");
}

Deno.serve({ port: PORT }, app.fetch);

console.log(`SemaClip server running on http://localhost:${PORT}`);
console.log(`  DB:       ${DB_PATH}`);
console.log(`  Cache:    ${CACHE_DIR}`);
console.log(`  Export:   ${EXPORT_DIR}`);
console.log(`  Engine:   ${ENGINE_BINARY}`);
