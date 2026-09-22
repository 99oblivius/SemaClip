/**
 * A preset read out of the database always carries a FULL profile.
 *
 * This is the regression guard for the worst failure this page has had. Presets were written as the
 * legacy FLAT subset (`format`/`aspectRatio`/`captions`/`nameTemplate`) before the full profile
 * existed, and `list()` spread that blob into the API response verbatim — so the payload had no
 * `profile` field at all. The export page reads `preset.profile.videoCodec`, that threw inside a
 * `$derived`, and a thrown derived aborts the render: the page sat on "Loading presets…" for ever
 * while the HTTP request had returned 200. Nothing in a green unit suite noticed, because the suite
 * asserted the SHAPE THE CODE PRODUCED rather than the shape the DATA had.
 *
 * So these cases are written against the two shapes actually found in a real `export_presets` row,
 * not against the ideal one.
 */
import { assert, assertEquals } from "@std/assert";
import { createDb } from "@/adapters/outbound/persistence/db.ts";
import { SqliteExportPresetRepository } from "@/adapters/outbound/persistence/repositories.ts";
import type { ExportPreset } from "shared/types";

/** The three presets a real database actually contained, verbatim. */
const LEGACY_BLOBS: Record<string, string> = {
  "preset-tiktok-916":
    `{"format":"mp4_h264","aspectRatio":"9:16","cropPosition":"center","captions":{"enabled":true,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{axis}-{ts}-tiktok"}`,
  "preset-shorts-916-vp9":
    `{"format":"webm","aspectRatio":"9:16","cropPosition":"center","captions":{"enabled":true,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{axis}-{ts}-shorts"}`,
  "preset-archive-169":
    `{"format":"mp4_h264","aspectRatio":"16:9","cropPosition":"center","captions":{"enabled":false,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{axis}-{ts}"}`,
};

async function withRepo(
  body: (repo: SqliteExportPresetRepository, path: string) => Promise<void>,
) {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/t.db`;
  try {
    await body(new SqliteExportPresetRepository(createDb(path)), path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

/** Write a row the way the OLD code did: the profile's fields at the top level of the blob. */
async function insertLegacy(path: string, id: string, blob: string, origin = "seeded") {
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(path);
  raw.prepare(
    "INSERT OR REPLACE INTO export_presets (id, name, config_json, created_at, origin) VALUES (?,?,?,?,?)",
  ).run(id, `Name for ${id}`, blob, "2026-01-01T00:00:00Z", origin);
  raw.close();
}

Deno.test("a legacy flat preset is read back with a FULL profile", async () => {
  await withRepo(async (repo, path) => {
    await insertLegacy(path, "preset-tiktok-916", LEGACY_BLOBS["preset-tiktok-916"]!);
    const rows = await repo.list();
    // Looked up BY ID, not by position: these fixtures and the Landscape row migration 0.7.0 inserts
    // can share a `created_at` stamp, so index order is not a stable way to name a row here.
    const p = rows.find((r) => r.id === "preset-tiktok-916");
    assert(p, "the preset must come back at all");
    // The field whose absence threw on the client.
    assert(p.profile, "`profile` must be present — this is the field that was missing");
    // The legacy `format` string must have been understood, not defaulted away.
    assertEquals(p.profile.container, "mp4");
    assertEquals(p.profile.videoCodec, "h264");
    assertEquals(p.profile.audioCodec, "aac");
    // The fields that WERE in the blob must survive the read.
    assertEquals(p.profile.aspectRatio, "9:16");
    assertEquals(p.profile.captions.enabled, true);
    assertEquals(p.profile.captions.fontSize, 48);
    // The stored template is carried through VERBATIM: `list()` normalises a profile's FIELDS, it
    // does not rewrite the user's template text. A template still naming the retired `{axis}` token
    // is repaired by migration 0.7.0, not by the reader — the reader must never silently edit text.
    assertEquals(p.profile.nameTemplate, "{date}-{channel}-{axis}-{ts}-tiktok");
    // The fields the legacy blob could not express must be FILLED, not undefined.
    assertEquals(p.profile.encoder, "auto");
    assertEquals(p.profile.encoderName, null);
    assertEquals(typeof p.profile.options.quality, "number");
    assertEquals(p.profile.options.maxBitrateKbps, null);
    assertEquals(p.origin, "seeded");
  });
});

Deno.test("a webm legacy preset keeps its own container and codec", async () => {
  await withRepo(async (repo, path) => {
    await insertLegacy(path, "preset-shorts-916-vp9", LEGACY_BLOBS["preset-shorts-916-vp9"]!);
    const rows = await repo.list();
    const p = rows.find((r) => r.id === "preset-shorts-916-vp9")!;
    assertEquals(p.profile.container, "webm");
    assertEquals(p.profile.videoCodec, "vp9");
    // The audio codec must be the container's, not a carried-over aac.
    assertEquals(p.profile.audioCodec, "opus");
  });
});

Deno.test("every preset in a legacy database reads back with a profile", async () => {
  await withRepo(async (repo, path) => {
    for (const [id, blob] of Object.entries(LEGACY_BLOBS)) {
      await insertLegacy(path, id, blob);
    }
    const all = await repo.list();
    // The three legacy fixtures must ALL be present. Not `=== 3`: migration 0.7.0 seeds a fourth row
    // into a fresh database, so an exact count would read the intended insert as a defect.
    for (const id of Object.keys(LEGACY_BLOBS)) {
      assert(all.some((p) => p.id === id), `${id} must be readable`);
    }
    // The actual assertion: NO row may lack a profile, whatever its id.
    for (const p of all) {
      assert(p.profile, `${p.id} came back without a profile`);
      assert(p.profile.videoCodec, `${p.id} has no videoCodec`);
    }
  });
});

Deno.test("a preset already carrying a nested profile is read unchanged", async () => {
  await withRepo(async (repo, path) => {
    const modern: ExportPreset = {
      id: "preset-modern",
      name: "Modern",
      createdAt: "2026-01-01T00:00:00Z",
      origin: "user",
      profile: {
        container: "mp4",
        videoCodec: "h265",
        audioCodec: "aac",
        encoder: "hardware",
        encoderName: "hevc_nvenc",
        maxHeight: 1080,
        options: { quality: 24, maxBitrateKbps: 6000 },
        aspectRatio: "1:1",
        captions: { enabled: true, preset: "yellow", position: "top", fontSize: 40, backgroundOpacity: 0.6 },
        nameTemplate: "{date}-{title}",
      },
    };
    await repo.save(modern);
    const rows = await repo.list();
    const p = rows.find((r) => r.id === "preset-modern")!;
    // Normalising on read must be IDEMPOTENT for rows already in the new shape.
    assertEquals(p.profile.videoCodec, "h265");
    assertEquals(p.profile.encoderName, "hevc_nvenc");
    assertEquals(p.profile.maxHeight, 1080);
    assertEquals(p.profile.options.maxBitrateKbps, 6000);
    assertEquals(p.profile.captions.preset, "yellow");
    assertEquals(p.profile.nameTemplate, "{date}-{title}");
    assertEquals(p.origin, "user");
  });
});

Deno.test("an unreadable blob degrades to a usable profile instead of throwing", async () => {
  await withRepo(async (repo, path) => {
    // A hand-edited or truncated row. Reading it must not take the whole list down — one bad row
    // cannot be allowed to blank every preset in the UI.
    await insertLegacy(path, "preset-broken", `{"format":"nonsense","aspectRatio":42}`);
    const rows = await repo.list();
    const p = rows.find((r) => r.id === "preset-broken");
    assert(p, "a damaged row must still appear in the list");
    assert(p.profile, "a damaged row must still yield a usable profile");
    assertEquals(p.profile.container, "mp4");
    assertEquals(p.profile.videoCodec, "h264");
    // The damage must not have spread to any other row.
    for (const r of rows) assert(r.profile, `${r.id} must still have a profile`);
  });
});
