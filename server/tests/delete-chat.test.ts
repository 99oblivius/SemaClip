/**
 * `DELETE /chat` must delete the chat file that EXISTS.
 *
 * Artifacts are project-named (`{slug}.chat.json`), but `deleteChat` tested one
 * hardcoded `chat.json`. On every project created since the rename that path matched
 * nothing, so the route answered 200 with `deleted: false` and the file stayed on disk —
 * which surfaces as the owner's report that a deleted artifact's label never changes.
 *
 * The same hardcoded-name-list defect was already fixed once for `DELETE /download`;
 * this test pins the chat case so it cannot come back a third time.
 */
import { assert, assertEquals } from "@std/assert";
import { MediaActionsUseCase } from "@/application/use-cases/MediaActions.ts";

/** An in-memory filesystem recording what was removed. */
function fakeFs(files: Set<string>) {
  return {
    exists: (p: string) => Promise.resolve(files.has(p)),
    remove: (p: string) => {
      files.delete(p);
      return Promise.resolve();
    },
    ensureDir: () => Promise.resolve(),
  };
}

const SLUG = "my-stream";
const DIR = "/cache/vods/s1";

function harness(recordedChatPath: string | null, existing: string[]) {
  // The directory itself must exist: `artifactDir` stat-checks each candidate DIRECTORY
  // before deriving from it, so a fake FS without the dir makes every delete a no-op and
  // the test would pass for the wrong reason.
  const files = new Set(existing);
  for (const p of existing) files.add(p.replace(/\/[^/]+$/, ""));
  files.add(DIR);
  files.add("/home/user/myvods");
  const state: Record<string, unknown> = {
    chatPath: recordedChatPath,
    chatCount: 42,
    parts: [{ kind: "chat", status: "done", percent: 1 }],
  };
  let written: Record<string, unknown> | null = null;
  const streams = {
    findById: () =>
      Promise.resolve({
        id: "s1",
        // A title that slugifies to exactly SLUG.
        title: "My Stream",
        streamer: "streamer",
        chatPath: recordedChatPath,
      }),
    update: () => Promise.resolve(),
  };
  const useCase = new MediaActionsUseCase(
    streams as never,
    { get: () => Promise.resolve(null), set: () => Promise.resolve() } as never,
    fakeFs(files) as never,
    {
      getState: () => Promise.resolve({ ...state }),
      setState: (_id: string, s: Record<string, unknown>) => {
        written = s;
        return Promise.resolve();
      },
    } as never,
    "/cache",
  );
  return { useCase, files, writtenState: () => written };
}

Deno.test("deleteChat removes a PROJECT-NAMED chat file", async () => {
  const name = `${SLUG}.chat.json`;
  const h = harness(`${DIR}/${name}`, [`${DIR}/${name}`]);

  const res = await h.useCase.deleteChat("s1");

  assertEquals(res.deleted, true, "the delete must report success");
  assert(!h.files.has(`${DIR}/${name}`), "the project-named chat file must be gone");
});

Deno.test("deleteChat still removes a LEGACY chat.json", async () => {
  const h = harness(`${DIR}/chat.json`, [`${DIR}/chat.json`]);
  const res = await h.useCase.deleteChat("s1");
  assertEquals(res.deleted, true);
  assert(!h.files.has(`${DIR}/chat.json`));
});

Deno.test("deleteChat follows the RECORDED path, wherever it lives", async () => {
  // A folder import references the user's own directory, not the cache layout.
  const external = "/home/user/myvods/whatever.chat.json";
  const h = harness(external, [external]);

  const res = await h.useCase.deleteChat("s1");

  assertEquals(res.deleted, true);
  assert(!h.files.has(external), "the recorded path must be the one deleted");
});

Deno.test("deleteChat resets the state and reports nothing deleted when no file exists", async () => {
  const h = harness(`${DIR}/missing.chat.json`, []);
  const res = await h.useCase.deleteChat("s1");
  assertEquals(res.deleted, false, "no file means nothing was deleted");
  assertEquals(h.writtenState(), null, "and the state must not be rewritten");
});
