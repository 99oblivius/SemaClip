/**
 * Windows can install its own update: the app hands off to the sidecar and quits.
 *
 * ── WHY THIS MATTERS ────────────────────────────────────────────────────────────────────────
 * The first Windows implementation told the user to run
 * `C:\Users\<u>\AppData\Local\SemaClip\Launch SemaClip (updates).cmd` by hand. The sidecar exists
 * precisely so nobody has to do that, and the banner copy was an admission that the app could not do
 * what every other desktop app does.
 *
 * The mechanism is now the same shape as the Linux AppImage one: start a helper that OUTLIVES this
 * process (it must — the thing it waits for is this process exiting), let it swap the payload, and
 * let it relaunch. `canApply` is therefore true on both platforms, and the banner offers a real
 * Restart instead of pointing at a file.
 */
import { assert, assertEquals } from "@std/assert";

const SRC = await Deno.readTextFile(
  new URL("../../server/adapters/outbound/platform/auto-update.ts", import.meta.url),
);

Deno.test("canApply is true on every platform", () => {
  // It used to be `Deno.build.os !== "windows"`. That is the bug being fixed: Windows could not
  // apply, so the UI had to say so and offer a manual step instead.
  assertEquals(
    /canApply:\s*true/.test(SRC),
    true,
    "both platforms can apply their own update now",
  );
  assertEquals(
    /canApply:\s*Deno\.build\.os\s*!==\s*"windows"/.test(SRC),
    false,
    "the Windows exclusion must be gone, not merely bypassed",
  );
});

Deno.test("the Windows check offers a restart rather than a manual launcher", () => {
  // `canApplyByRestart: false` was what made the banner render the launcher instruction. It must now
  // be true, or the UI would keep telling the user to run a .cmd that the app can run itself.
  assert(
    /emitAppEvent\(\{\s*type:\s*"update-staged",\s*version:\s*latest,\s*canApplyByRestart:\s*true\s*\}\)/
      .test(SRC),
    "the Windows stage event must report that a restart installs it",
  );
  assertEquals(
    /canApplyByRestart:\s*false/.test(SRC),
    false,
    "no path may still claim a restart cannot apply",
  );
});

Deno.test("the hand-off waits for THIS pid and passes the app directory", () => {
  // Both arguments are load-bearing:
  //   -wait-pid: the sidecar is started detached, so its parent is not this process, and without an
  //     explicit pid it would wait on the wrong thing (or nothing);
  //   -app: the sidecar's default target is its OWN directory, which on an installed build is a
  //     per-user extraction dir, not the payload.
  assert(/-relaunch/.test(SRC), "the sidecar's restart mode must be used");
  assert(/-wait-pid/.test(SRC), "the current pid must be passed explicitly");
  assert(/String\(Deno\.pid\)/.test(SRC), "the pid must be this process's");
  assert(/-app/.test(SRC), "the app directory must be named");
});

Deno.test("the hand-off is DETACHED, because it must outlive the process it waits for", () => {
  // A helper that dies with its parent can never perform the swap: the parent IS the thing that has
  // to exit first. `unref()` is what detaches it.
  assert(
    /cmd\.spawn\(\)\.unref\(\)/.test(SRC),
    "the sidecar must be spawned unref'd, or it would be killed with the app it is waiting for",
  );
});
