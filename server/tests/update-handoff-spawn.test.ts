/**
 * The update hand-off must start a process that is NOT the app's child.
 *
 * ── THE REPORTED FAILURE ────────────────────────────────────────────────────────────────────────
 * "it downloads, a terminal opens, the app closes with it, and reopening shows the old version."
 *
 * The updater's own log is what settled it: the entry after a real in-app update attempt ends after
 * the preflight, and there is NO `-relaunch` header. The header is the first thing the updater writes
 * on startup, so a `-relaunch` process that had begun would have logged one. It never ran.
 *
 * The cause is the spawn itself. `new Deno.Command(sidecar, …).spawn().unref()` does not detach on
 * Windows — the app remains the child's parent, and the app exiting takes it down. `unref()` only
 * releases the child from the PARENT'S event loop; it does not sever the parent-child relationship.
 * The updater was killed between its preflight (a synchronous child, which completes) and its
 * `-relaunch` start (a detached child, which does not).
 *
 * `cmd /c start` is the standard Windows hand-off: the SHELL starts the program, so its parent is
 * `cmd`/`explorer` rather than the app, and it survives. The app already used exactly this for its
 * plain restart path, which is why a plain restart worked and the update one did not.
 */
import { assert, assertEquals } from "@std/assert";

const AUTO = await Deno.readTextFile(
  new URL("../../server/adapters/outbound/platform/auto-update.ts", import.meta.url),
);

/** The body of `applyWindowsUpdate`. */
function applyBody(): string {
  const i = AUTO.indexOf("export function applyWindowsUpdate");
  assert(i > 0, "applyWindowsUpdate must exist");
  return AUTO.slice(i, AUTO.indexOf("\n}\n", i));
}

Deno.test("the updater is started through the shell, not as a direct child", () => {
  const body = applyBody();
  // The old shape, which killed the updater. Asserted as an ABSENCE so a regression fails here.
  assertEquals(
    /new Deno\.Command\(\s*sidecar/.test(body),
    false,
    "spawning the updater directly makes it the app's child, and the app's exit kills it",
  );
  assert(
    /updaterLaunchCommand\(sidecar/.test(body),
    "the hand-off must go through updaterLaunchCommand",
  );

  // And that helper must actually use the shell.
  const helper = AUTO.slice(
    AUTO.indexOf("export function updaterLaunchCommand"),
    AUTO.indexOf("export function applyWindowsUpdate"),
  );
  assert(
    /new Deno\.Command\("cmd"/.test(helper),
    "cmd /c start is what makes the new process's parent the shell",
  );
  assert(
    /args:\s*\["\/c",\s*"start"/.test(helper),
    "the command must be `cmd /c start`",
  );
});

Deno.test("the start command carries the empty title argument and a quoted path", () => {
  // Both are load-bearing and both are silent failures:
  //   - `start` treats a QUOTED first argument as the window TITLE, so `""` must come first or the
  //     executable path is swallowed as a title and nothing runs;
  //   - the path must be QUOTED because `start` does its own parsing and the owner's install lives
  //     under a folder with a space in its name.
  const helper = AUTO.slice(
    AUTO.indexOf("export function updaterLaunchCommand"),
    AUTO.indexOf("export function applyWindowsUpdate"),
  );
  assert(
    /"\/c",\s*"start",\s*""/.test(helper),
    "the empty title argument is required before the executable",
  );
  assert(
    /`"\$\{sidecar\}"`/.test(helper),
    "the executable path must be quoted for start's own parser",
  );
});

Deno.test("the updater still learns WHICH process to wait for", () => {
  // The hand-off only works because the updater can wait for the app to exit. That depends on the pid
  // travelling, and on the app actually exiting — which is why the wait is not a formality.
  const body = applyBody();
  for (const flag of ['"-relaunch"', '"-wait-pid"', 'String(Deno.pid)', '"-app"', '"-payload"', '"-version"']) {
    assert(body.includes(flag), `the hand-off must still pass ${flag}`);
  }
});

Deno.test("the app validates before it stops anything, and only then exits", () => {
  const body = applyBody();
  const preflightAt = body.indexOf("preflight(sidecar");
  const spawnAt = body.indexOf("updaterLaunchCommand(sidecar");
  const exitAt = body.indexOf("Deno.exit(0)");
  assert(preflightAt > 0 && spawnAt > 0 && exitAt > 0, "all three steps must exist");
  assert(preflightAt < spawnAt, "a refusal must keep the window open");
  assert(spawnAt < exitAt, "the process must be started before the app quits");
});
