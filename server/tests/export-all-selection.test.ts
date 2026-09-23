/**
 * Export all means the work still OUTSTANDING.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * The owner reported that pressing export all re-exported clips already marked `exported`, and that
 * a batch exported alongside already-completed exports came out with the wrong file names. Both were
 * in the batch path:
 *
 *  - the implicit selection was `exportList.liveIds()` — every clip on the list, marked or not —
 *    and the route clears the mark of everything it accepts, so pressing export all both wasted the
 *    encode and destroyed the record that a file already exists;
 *  - the batch travelled with ONE `filename` for every clip, so one clip's rendered name was
 *    stamped across the whole run (see `export-naming.test.ts` for the renderer's own boundaries).
 *
 * The rule below is deliberately NOT applied to an explicit list of clip ids: there the user named
 * the clips, so re-sending one is exactly what they asked for.
 */
import { assertEquals } from "@std/assert";
import { selectImplicitBatch } from "../application/use-cases/ClipUseCases.ts";
import type { Clip } from "shared/types";

function clip(id: string, over: Partial<Clip> = {}): Clip {
  return {
    id, streamId: "s1", startTime: 0, endTime: 30, peakTime: 10,
    justification: null, title: null, rank: null, exported: false, exportPath: null,
    rejected: false, signals: null,
    ...over,
  } as Clip;
}

Deno.test("export all skips clips that already produced a file", () => {
  const { clipIds, skipped } = selectImplicitBatch([
    clip("done", { exported: true, exportPath: "/exports/vod/done.mp4" }),
    clip("todo"),
    clip("alsoTodo"),
  ]);
  assertEquals(clipIds, ["todo", "alsoTodo"]);
  assertEquals(skipped, 1);
});

Deno.test("export all on an all-exported list enqueues nothing and says why", () => {
  // The degenerate case the owner hit. An empty batch must be reported as such rather than
  // silently succeeding, so the UI can explain why nothing ran.
  const { clipIds, skipped } = selectImplicitBatch([
    clip("a", { exported: true, exportPath: "/exports/a.mp4" }),
    clip("b", { exported: true, exportPath: "/exports/b.mp4" }),
  ]);
  assertEquals(clipIds, []);
  assertEquals(skipped, 2);
});

Deno.test("export all leaves an unexported list untouched", () => {
  const { clipIds, skipped } = selectImplicitBatch([clip("a"), clip("b"), clip("c")]);
  assertEquals(clipIds, ["a", "b", "c"]);
  assertEquals(skipped, 0);
});

Deno.test("the ORDER of the list is preserved, so the batch runs as the user arranged it", () => {
  // The list is the user's ordering; selection must not reorder it.
  const { clipIds } = selectImplicitBatch([
    clip("third"),
    clip("first"),
    clip("second", { exported: true, exportPath: "/exports/second.mp4" }),
  ]);
  assertEquals(clipIds, ["third", "first"]);
});

Deno.test("a dangling list reference is dropped, not exported and not fatal", () => {
  // The list can reference a clip that no longer exists (it is reported as `clip: null`). It must
  // neither crash the user's action nor be counted as skipped work.
  const { clipIds, skipped } = selectImplicitBatch([
    clip("real"),
    null,
    clip("done", { exported: true, exportPath: "/exports/done.mp4" }),
  ]);
  assertEquals(clipIds, ["real"]);
  assertEquals(skipped, 1);
});

Deno.test("an empty list yields an empty batch", () => {
  const { clipIds, skipped } = selectImplicitBatch([]);
  assertEquals(clipIds, []);
  assertEquals(skipped, 0);
});

Deno.test("`exported` WITHOUT a path is still skipped", () => {
  // The mark is the rule, not the path: a clip whose file was moved still carries the record that
  // an export was made for it, and export all is never the verb for redoing that.
  const { clipIds, skipped } = selectImplicitBatch([clip("moved", { exported: true, exportPath: null })]);
  assertEquals(clipIds, []);
  assertEquals(skipped, 1);
});
