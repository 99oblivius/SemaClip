/**
 * ffmpeg discovery: "found nothing" must be a distinct VALUE, not an error path.
 *
 * The measured bug: the not-found case returned `source: "path"`, identical to a
 * successful PATH hit, and availability was derived from a SECOND check. On Windows
 * those disagreed and the log said both things at once —
 *   Tools:    ffmpeg=ffmpeg.exe (path)
 *   Tools:    ffmpeg is missing — the UI will offer to download it
 * — after which the app downloaded ~80MB it did not need.
 */
import { assert, assertEquals } from "@std/assert";
import { ToolRegistry } from "@/adapters/outbound/ffmpeg/tool-paths.ts";

Deno.test("a machine with no ffmpeg reports source=missing and is unavailable", async () => {
  // Point PATH at an empty dir so the real machine's ffmpeg cannot be found, and
  // give a managed dir that does not exist.
  const empty = await Deno.makeTempDir();
  const dataDir = await Deno.makeTempDir();
  const prev = Deno.env.get("PATH");
  try {
    Deno.env.set("PATH", empty);
    const registry = await ToolRegistry.create(dataDir);
    const st = registry.status();
    assertEquals(st.paths.source, "missing", "not-found must not masquerade as a path hit");
    assertEquals(st.available, false);
    assertEquals(st.downloadable, true, "an ordinary machine may download it");
  } finally {
    if (prev !== undefined) Deno.env.set("PATH", prev);
  }
});

Deno.test("an unavailable registry is downloadable, an env override is not", async () => {
  const empty = await Deno.makeTempDir();
  const dataDir = await Deno.makeTempDir();
  const prevPath = Deno.env.get("PATH");
  try {
    Deno.env.set("PATH", empty);
    // No override: downloadable.
    const a = await ToolRegistry.create(dataDir);
    assertEquals(a.status().downloadable, true);

    // With an override pointing nowhere, the user has already decided where it
    // lives, so offering a download would contradict them.
    Deno.env.set("SEMACLIP_FFMPEG", "/nonexistent/ffmpeg");
    Deno.env.set("SEMACLIP_FFPROBE", "/nonexistent/ffprobe");
    const b = await ToolRegistry.create(dataDir);
    assertEquals(b.status().paths.source, "env");
    assertEquals(b.status().downloadable, false);
  } finally {
    if (prevPath !== undefined) Deno.env.set("PATH", prevPath);
    Deno.env.delete("SEMACLIP_FFMPEG");
    Deno.env.delete("SEMACLIP_FFPROBE");
  }
});

Deno.test("source and available never contradict each other", async () => {
  // The invariant the bug violated: a non-missing source means available.
  const empty = await Deno.makeTempDir();
  const dataDir = await Deno.makeTempDir();
  const prev = Deno.env.get("PATH");
  try {
    Deno.env.set("PATH", empty);
    const st = (await ToolRegistry.create(dataDir)).status();
    assertEquals(st.available, st.paths.source !== "missing");
  } finally {
    if (prev !== undefined) Deno.env.set("PATH", prev);
  }
});
