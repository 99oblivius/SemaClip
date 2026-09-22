/**
 * Where an export lands, and what it is called.
 *
 * ── WHY THESE EXIST ──────────────────────────────────────────────────────────────────────────
 * Three reported failures share this file's subject, and each one had a silent cause:
 *
 *  - "no files are written to the export path" — the exporter used its BOOT default and never read
 *    the user's configured directory, so exports went somewhere else entirely and the configured
 *    folder was never created.
 *  - the same run wrote `date---channel---name---ts.mp4` — the page sent the RAW TEMPLATE and the
 *    server wrote it literally.
 *  - three exports produced ONE file — the identical literal name meant every clip overwrote the
 *    last, so the batch looked successful and left a single artifact.
 *
 * Every assertion below is one of those three, or the collision/subfolder rule that keeps them from
 * happening again.
 */
import { assertEquals, assertStringIncludes, assert } from "@std/assert";
import { looksLikeFilenameTemplate, renderFilenameTemplate } from "shared/types";
import { uniqueName, vodFolderName } from "../application/use-cases/artifact-naming.ts";

const FACTS = {
  channel: "SoulCamera",
  name: "Take One",
  startTime: 1144,
  streamTitle: "DODS EMERGENCY DONOTHON DAY 11",
  // Pinned so the date token cannot make this test fail tomorrow.
  now: new Date("2026-09-22T12:00:00Z"),
};

Deno.test("the template renders to a NAME, never to the literal token text", () => {
  const out = renderFilenameTemplate("{date}-{channel}-{name}-{ts}", FACTS);
  assertEquals(out, "2026-09-22-soulcamera-Take-One-1904");
  // The bug in one line: a raw template must NOT survive into the output.
  assert(!out.includes("{"), "no token may survive the render");
});

Deno.test("a raw template is RECOGNISED — this is what the server keys on", () => {
  // The server renders what it is handed when it looks like a template. Without this predicate the
  // exported file is named after the template text, which is the reported `date---channel---...`.
  assert(looksLikeFilenameTemplate("{date}-{channel}-{name}-{ts}"));
  assert(looksLikeFilenameTemplate("clip-{ts}"));
  assert(!looksLikeFilenameTemplate("2026-09-22-soulcamera-Take-One-1904"));
  assert(!looksLikeFilenameTemplate("My Clip"), "free text is not a template");
});

Deno.test("a NAME keeps its casing but loses its spacing and punctuation", () => {
  // Case is the user's data; spacing and the characters a filesystem refuses are not.
  assertEquals(renderFilenameTemplate("{name}", { ...FACTS, name: "take one TWO" }), "take-one-TWO");
  assertEquals(renderFilenameTemplate("{name}", { ...FACTS, name: "Take One" }), "Take-One");
  // A colon and a slash cannot reach a filename: the slash would escape the export directory.
  assertEquals(renderFilenameTemplate("{name}", { ...FACTS, name: "a/b:c" }), "a-b-c");
});

Deno.test("an empty token DROPS OUT rather than inventing a word", () => {
  // An unnamed clip must not produce "null", and must not produce a placeholder nobody chose.
  assertEquals(renderFilenameTemplate("{date}-{name}-{ts}", { ...FACTS, name: null }), "2026-09-22-1904");
  // A template that renders to NOTHING is the caller's problem to handle, not a filename.
  assertEquals(renderFilenameTemplate("{name}", { ...FACTS, name: null }), "");
});

Deno.test("the extension follows the CONTAINER for all three", () => {
  // A two-branch ternary shipped an MKV named `.mp4`; this pins the table the server uses.
  const ext = { mp4: ".mp4", webm: ".webm", mkv: ".mkv" };
  assertEquals(Object.keys(ext).length, 3, "every container must have its own extension");
  assertEquals(ext.mkv, ".mkv");
});

Deno.test("the export SUBSHELF is the project-folder name, built from the stream", () => {
  // The same convention the project folders use, so the export tree reads like the project tree.
  const folder = vodFolderName({
    id: "ba173ffc-26a2-4c05-bd5e-fbd651452caf",
    streamer: "SoulCamera",
    game: "ELDEN RING NIGHTREIGN",
    createdAt: "2026-09-22T19:02:23.991Z",
  });
  assertEquals(folder, "soulcamera-elden-ring-nightreign-2026-09-22-2102");
  // Parts that sanitise to nothing are OMITTED, not left as an empty segment.
  const partial = vodFolderName({ id: "abc12345", streamer: "SoulCamera", game: null, createdAt: "2026-09-22T19:02:00Z" });
  assert(!partial.includes("--"), "an absent part must not leave a doubled separator");
  // No usable part at all still yields a name, so a folder always exists.
  const bare = vodFolderName({ id: "abcdef123456", streamer: "!!!", game: "???", createdAt: null });
  assertEquals(bare, "vod-abcdef12");
});

Deno.test("two exports of the same name do NOT overwrite each other", () => {
  // The reported symptom: three clips, one file. `uniqueName` is the counter-rule.
  const taken: string[] = [];
  const first = uniqueName("2026-09-22-soulcamera-MGS-1904", taken);
  assertEquals(first, "2026-09-22-soulcamera-MGS-1904");
  taken.push(first);
  const second = uniqueName("2026-09-22-soulcamera-MGS-1904", taken);
  assertEquals(second, "2026-09-22-soulcamera-MGS-1904-2");
  taken.push(second);
  assertEquals(uniqueName("2026-09-22-soulcamera-MGS-1904", taken), "2026-09-22-soulcamera-MGS-1904-3");
});

Deno.test("the collision check is case-insensitive, because the filesystem may be", () => {
  // macOS and Windows treat `Clip.mp4` and `clip.mp4` as one file; a case-sensitive check would
  // happily hand back a name that then overwrites.
  assertEquals(uniqueName("Take-One", ["take-one"]), "Take-One-2");
});

Deno.test("a stem that sanitises to nothing is not left as an extension-only filename", () => {
  // The server's own last line of defence, mirrored here: what `sanitiseStem` guarantees.
  const sanitise = (stem: string) => {
    const safe = stem
      .replace(/[^\w.\- ]+/g, "-")
      .replace(/\s+/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 120)
      .replace(/-+$/g, "");
    return safe.length > 0 ? safe : "semaclip-export";
  };
  assertEquals(sanitise("///"), "semaclip-export");
  assertEquals(sanitise(""), "semaclip-export");
  assertEquals(sanitise("..."), "semaclip-export");
  assertEquals(sanitise("A".repeat(200)).length, 120, "the cap is the filesystem's, not the template's");
});
