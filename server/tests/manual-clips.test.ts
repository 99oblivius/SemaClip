/**
 * Manual clips: a clip made by hand, with no engine behind it.
 *
 * The load-bearing change is a MIGRATION that drops NOT NULL from `clips.job_id`, `axis` and
 * `score` (SQLite cannot ALTER that away, so it is a table rebuild). These tests drive the real
 * migration runner against an in-memory database, because the failure mode a rebuild introduces
 * is data loss or an index left behind — neither of which a type check can see.
 */
import { assertEquals, assert } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { migrations, runMigrations, LATEST_VERSION } from "../adapters/outbound/persistence/migrations.ts";
import { clipEndFrom, createManualClip } from "../domain/Clip.ts";

/** Apply every migration up to (and including) `upTo`, recording them as the real runner does. */
function migrateTo(db: DatabaseSync, upTo: string): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  for (const m of migrations) {
    if (m.version > upTo) break;
    for (const stmt of m.up) db.exec(stmt);
    // Recording the version is what makes this a PARTIAL state: without it the real runner
    // re-applies from 0.1.0 and dies on an already-added column.
    db.prepare("INSERT INTO schema_versions (version, description, applied_at) VALUES (?, ?, ?)")
      .run(m.version, m.description, "2026-09-22T00:00:00Z");
  }
}

Deno.test("migration 0.6.0 lets a clip exist with no job, no axis and no score", () => {
  const db = new DatabaseSync(":memory:");
  const result = runMigrations(db);
  assertEquals(result.to, LATEST_VERSION);

  // A manual clip: every engine-derived column null.
  db.exec(`INSERT INTO streams (id, vod_path, created_at, status)
           VALUES ('s1', '/tmp/v.mp4', '2026-09-22T00:00:00Z', 'completed')`);
  db.exec(`INSERT INTO clips (id, job_id, stream_id, axis, score, start_time, end_time, peak_time)
           VALUES ('c1', NULL, 's1', NULL, NULL, 10, 40, 10)`);

  const row = db.prepare("SELECT * FROM clips WHERE id = 'c1'").get() as Record<string, unknown>;
  assertEquals(row.job_id, null);
  assertEquals(row.axis, null);
  assertEquals(row.score, null);
  assertEquals(row.start_time, 10);
  assertEquals(row.end_time, 40);
  // Defaults still apply — the columns that WERE NOT NULL and defaulted must be intact.
  assertEquals(row.exported, 0);
  assertEquals(row.rejected, 0);
  db.close();
});

Deno.test("an engine clip is unaffected by the rebuild and keeps its signals", () => {
  const db = new DatabaseSync(":memory:");
  // Land on the PREVIOUS migration, insert a real engine clip, then migrate — this is what an
  // existing install does, and it is where a rebuild would silently drop rows or a column.
  migrateTo(db, "0.5.0");
  db.exec(`INSERT INTO streams (id, vod_path, created_at, status)
           VALUES ('s1', '/tmp/v.mp4', '2026-09-22T00:00:00Z', 'completed')`);
  db.exec(`INSERT INTO clips
             (id, job_id, stream_id, axis, score, start_time, end_time, peak_time,
              justification, rank, exported, export_path, rejected, signals_json)
           VALUES ('c9', 'j9', 's1', 'hype', 0.91, 5, 25, 12, 'because', 1, 1, '/tmp/out.mp4', 0,
                   '{"chatExcitement":0.8}')`);

  runMigrations(db); // applies 0.6.0

  const row = db.prepare("SELECT * FROM clips WHERE id = 'c9'").get() as Record<string, unknown>;
  assertEquals(row.job_id, "j9", "an engine clip keeps its job");
  assertEquals(row.axis, "hype");
  assertEquals(row.score, 0.91);
  assertEquals(row.justification, "because");
  assertEquals(row.rank, 1);
  assertEquals(row.exported, 1);
  assertEquals(row.export_path, "/tmp/out.mp4");
  assertEquals(JSON.parse(row.signals_json as string).chatExcitement, 0.8);
  db.close();
});

Deno.test("the rebuild recreates the indexes it dropped with the table, and leaves nothing behind", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  const names = (sql: string) =>
    (db.prepare(sql).all() as Array<{ name: string }>).map((r) => r.name);

  const indexes = names("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='clips'");
  // DROP TABLE takes its indexes with it, so these must be recreated by 0.6.0. Their absence
  // turns every clip-by-stream query into a table scan and nothing else in the suite notices.
  assert(indexes.includes("idx_clips_stream"), `missing idx_clips_stream, got ${indexes.join(",")}`);
  assert(indexes.includes("idx_clips_job"), `missing idx_clips_job, got ${indexes.join(",")}`);

  // And the rebuild must not leave its scratch table behind: `clips_new` existing after the
  // rename is the classic failed-rebuild symptom, and it would shadow nothing while holding a
  // stale copy of every clip.
  const tables = names("SELECT name FROM sqlite_master WHERE type='table'");
  assert(!tables.includes("clips_new"), `clips_new survived the rebuild: ${tables.join(",")}`);
  db.close();
});

Deno.test("the REMAINING not-nulls are not loosened along with the three", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);
  db.exec(`INSERT INTO streams (id, vod_path, created_at, status)
           VALUES ('s1', '/tmp/v.mp4', '2026-09-22T00:00:00Z', 'completed')`);
  // start_time/end_time/peak_time/stream_id must still be required — a rebuild that dropped
  // every constraint would let a clip with no endpoints into the database, which every reader
  // (the player, the timeline, export) assumes cannot happen.
  for (const cols of ["start_time", "end_time", "peak_time", "stream_id"]) {
    let threw = false;
    const values: Record<string, string> = {
      id: `bad-${cols}`, stream_id: "'s1'", start_time: "1", end_time: "2", peak_time: "1",
    };
    delete values[cols];
    const body = Object.entries(values).map(([k, v]) => `${k}, ${v}`).join(", ");
    try {
      db.exec(`INSERT INTO clips (${body})`);
    } catch {
      threw = true;
    }
    assert(threw, `${cols} must stay NOT NULL after the rebuild`);
  }
  db.close();
});

Deno.test("clipEndFrom: the next clip's start bounds the new clip", () => {
  // A neighbour INSIDE the cap wins: the new clip must not swallow it. (130 is 30s away, so it is
  // tighter than the 60s cap; a neighbour beyond the cap cannot bound anything — that case is the
  // test below.)
  assertEquals(
    clipEndFrom({ startTime: 100, duration: 3600, existingStartTimes: [50, 130, 900] }),
    130,
  );
});

Deno.test("clipEndFrom: the CAP bounds the clip when nothing is nearer", () => {
  // Nothing later and hours of video left: this is the case that produced hour-long "clips"
  // before the cap. Both other bounds are further away, so 60s is the answer.
  assertEquals(
    clipEndFrom({ startTime: 100, duration: 3600, existingStartTimes: [10, 50] }),
    160,
  );
});

Deno.test("clipEndFrom: a neighbour BEYOND the cap does not extend the clip", () => {
  // The cap is a ceiling, not a target: a neighbour 10 minutes away must not make a 10-minute
  // clip. This is the boundary the old code got wrong in the other direction.
  assertEquals(
    clipEndFrom({ startTime: 100, duration: 3600, existingStartTimes: [700] }),
    160,
  );
});

Deno.test("clipEndFrom: the end of the video wins over the cap near the end", () => {
  // 40s of video left, cap 60s → the video ends first.
  assertEquals(
    clipEndFrom({ startTime: 3560, duration: 3600, existingStartTimes: [] }),
    3600,
  );
});

Deno.test("clipEndFrom: a clip starting AT the playhead is not 'next'", () => {
  // A start exactly at startTime would make a zero-length clip, so it is skipped. The clip
  // then runs to the cap rather than to the following clip, because 240 is beyond it.
  assertEquals(
    clipEndFrom({ startTime: 100, duration: 3600, existingStartTimes: [100, 240] }),
    160,
  );
});

Deno.test("clipEndFrom: a degenerate 'next' start is skipped, not used", () => {
  // A later clip 0.2s away cannot bound anything usable; it is skipped rather than producing a
  // 0.2s clip. The cap then applies — NOT the end of the video, which is where the pre-cap
  // rule would have gone.
  assertEquals(
    clipEndFrom({ startTime: 100, duration: 3600, existingStartTimes: [100.2] }),
    160,
  );
});

Deno.test("clipEndFrom: playhead at the very end yields a usable default, never a refusal", () => {
  // Less than the 0.5s floor of video left: there is no honest boundary, so a default length
  // keeps the button working and the trim UI is how the user fixes it. The CAP must NOT be
  // used here — it is not a source of video that does not exist, and using it produced a 60s
  // clip running past the end of the stream.
  assertEquals(clipEndFrom({ startTime: 3599.8, duration: 3600, existingStartTimes: [] }), 3629.8);
  // An unknown duration has no video end to honour, so the CAP is the only bound — the clip gets
  // the full 60s rather than a shorter arbitrary default. This changed with the cap: the old rule
  // returned `fallbackLength` (30s) here. The cap is a ceiling either way, so 60s is inside the
  // owner's rule, and "unknown length" is not a reason to hand back a shorter clip than asked for.
  assertEquals(clipEndFrom({ startTime: 0, duration: null, existingStartTimes: [] }), 60);
});

Deno.test("clipEndFrom: a second of video left is still a legitimate end", () => {
  // The boundary in the other direction — 1s is above the 0.5s floor, so the VOD's own end is
  // the answer rather than the fallback. Getting this wrong would silently invent a 30s clip
  // past the end of the video.
  assertEquals(clipEndFrom({ startTime: 3599, duration: 3600, existingStartTimes: [] }), 3600);
});

Deno.test("clipEndFrom: the cap is configurable, and a smaller cap still bounds", () => {
  // `maxLength` exists so the rule can be re-stated without editing the constant; the boundary
  // is the same shape.
  assertEquals(
    clipEndFrom({ startTime: 100, duration: 3600, existingStartTimes: [], maxLength: 15 }),
    115,
  );
  assertEquals(
    clipEndFrom({ startTime: 100, duration: 3600, existingStartTimes: [110], maxLength: 15 }),
    110,
  );
});

Deno.test("clipEndFrom: a neighbour inside the floor is skipped, not a zero-length clip", () => {
  // The tightest boundary there is: a neighbour 0.1s away. The clip must remain creatable.
  const end = clipEndFrom({ startTime: 100, duration: 3600, existingStartTimes: [100.1] });
  assertEquals(end, 160);
  assertEquals(end > 100, true);
});

Deno.test("createManualClip records ABSENCE, never a sentinel", () => {
  // The panel distinguishes a hand-made clip from an engine finding by these being null. A
  // sentinel axis or score:0 would present a deliberate edit as a bad detection, and a
  // synthesised jobId would fabricate a job that never ran.
  const clip = createManualClip({ streamId: "s1", startTime: 12, endTime: 45 });
  assertEquals(clip.jobId, null);
  assertEquals(clip.axis, null);
  assertEquals(clip.score, null);
  assertEquals(clip.signals, null);
  assertEquals(clip.rank, null);
  assertEquals(clip.justification, null);
  // A manual clip is UNNAMED until someone names it — null, not "manual" and not "". Storing the
  // kind in the name field would make "manual" a name somebody could accidentally export.
  assertEquals(clip.title, null);
  assertEquals(clip.rejected, false);
  assertEquals(clip.exported, false);
  // The start is the only endpoint the user chose, so it is also the peak.
  assertEquals(clip.peakTime, 12);
  assertEquals(clip.startTime, 12);
  assertEquals(clip.endTime, 45);
  assert(clip.id.length > 0, "a manual clip still needs an id");
});

Deno.test("migration 0.7.0 adds a NAME column that cannot be the axis", () => {
  const db = new DatabaseSync(":memory:");
  runMigrations(db);

  db.exec(`INSERT INTO streams (id, vod_path, created_at, status)
           VALUES ('s1', '/tmp/v.mp4', '2026-09-22T00:00:00Z', 'completed')`);
  // 0.7.0 is an ALTER, so this also pins that the rebuild in 0.6.0 did not lose the table.
  db.exec(`INSERT INTO clips (id, job_id, stream_id, axis, score, start_time, end_time, peak_time, title)
           VALUES ('c1', NULL, 's1', NULL, NULL, 10, 40, 10, 'the good bit')`);
  const row = db.prepare("SELECT axis, title FROM clips WHERE id = 'c1'").get() as
    { axis: string | null; title: string | null };

  // The name lives in its OWN column and the axis stays null. If a name were written into `axis`,
  // `isAxis` would reject the row on the next engine write, the axis filter would return it as a
  // bogus category, and axis-weight feedback would learn a category the engine never emits.
  assertEquals(row.axis, null);
  assertEquals(row.title, "the good bit");
});

Deno.test("0.7.0 names a legacy ENGINE clip from its axis, and leaves the axis itself intact", () => {
  const db = new DatabaseSync(":memory:");
  // A database that has everything up to 0.6.0, holding a clip created before the engine named them.
  migrateTo(db, "0.6.0");
  db.exec(`INSERT INTO streams (id, vod_path, created_at, status)
           VALUES ('s1', '/tmp/v.mp4', '2026-09-22T00:00:00Z', 'completed')`);
  db.exec(`INSERT INTO clips (id, job_id, stream_id, axis, score, start_time, end_time, peak_time)
           VALUES ('c1', NULL, 's1', 'hype', 0.5, 10, 40, 20)`);

  // Then the new migration runs as it would on the next startup.
  const rest = migrations.filter((m) => m.version > "0.6.0");
  for (const m of rest) for (const stmt of m.up) db.exec(stmt);

  const row = db.prepare("SELECT axis, score, title FROM clips WHERE id = 'c1'").get() as
    { axis: string | null; score: number | null; title: string | null };
  // ── THE POLICY HERE WAS REVERSED BY THE OWNER, DELIBERATELY ────────────────────────────────────
  // This test used to assert `title === null` with the reasoning that naming a clip from its axis
  // "invents a label nobody chose". The owner's call is that the axis is the RIGHT label and the
  // problem was its APPLICABILITY, not its accuracy: a detected clip genuinely was kept BECAUSE of
  // that axis, so the axis is the honest name for it — and it is what `{name}` renders into a
  // filename. What must NOT happen is the reverse: a HAND-MADE clip has no axis and must never be
  // given one (see the test above), which is the distinction the rule actually turns on.
  assertEquals(row.title, "hype");
  // The axis column is untouched. The name is a COPY of the fact, not a move: the axis filter, the
  // axis-weight feedback and `isAxis` all still read the column they always did.
  assertEquals(row.axis, "hype");
  assertEquals(row.score, 0.5);
});

Deno.test("0.7.0 leaves a legacy HAND-MADE clip unnamed", () => {
  // The other half of the rule, and the case a blanket `title = axis` would break: a hand-made clip
  // has `axis IS NULL`, and naming it would fabricate the engine evidence its whole design omits.
  const db = new DatabaseSync(":memory:");
  migrateTo(db, "0.6.0");
  db.exec(`INSERT INTO streams (id, vod_path, created_at, status)
           VALUES ('s1', '/tmp/v.mp4', '2026-09-22T00:00:00Z', 'completed')`);
  db.exec(`INSERT INTO clips (id, job_id, stream_id, axis, score, start_time, end_time, peak_time)
           VALUES ('c2', NULL, 's1', NULL, NULL, 10, 40, 10)`);

  const rest = migrations.filter((m) => m.version > "0.6.0");
  for (const m of rest) for (const stmt of m.up) db.exec(stmt);

  const row = db.prepare("SELECT axis, title FROM clips WHERE id = 'c2'").get() as
    { axis: string | null; title: string | null };
  assertEquals(row.title, null, "a hand-made clip must stay unnamed — it was never detected into an axis");
  assertEquals(row.axis, null);
});

Deno.test("0.7.0 never overwrites a name the user typed", () => {
  // The guard the `title IS NULL` condition exists for. A detected clip the user has RENAMED keeps
  // their text; backfilling over it would destroy the only column they can edit.
  const db = new DatabaseSync(":memory:");
  migrateTo(db, "0.6.0");
  db.exec(`INSERT INTO streams (id, vod_path, created_at, status)
           VALUES ('s1', '/tmp/v.mp4', '2026-09-22T00:00:00Z', 'completed')`);
  db.exec(`INSERT INTO clips (id, job_id, stream_id, axis, score, start_time, end_time, peak_time, title)
           VALUES ('c3', NULL, 's1', 'humor', 0.7, 10, 40, 20, 'the bit where she drops it')`);

  const rest = migrations.filter((m) => m.version > "0.6.0");
  for (const m of rest) for (const stmt of m.up) db.exec(stmt);

  const row = db.prepare("SELECT title FROM clips WHERE id = 'c3'").get() as { title: string | null };
  assertEquals(row.title, "the bit where she drops it");
});
