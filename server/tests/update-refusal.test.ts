/**
 * A refused update hand-off must KEEP THE APP RUNNING and explain itself.
 *
 * ── THE REPORTED FAILURE ────────────────────────────────────────────────────────────────────────
 * "both open a terminal briefly that closes itself and the app. Then when I try to open the app again
 * it is still on the old version."
 *
 * Two separate defects produced that, and both are asserted here:
 *
 *   1. `restartApp` FELL THROUGH on a failed hand-off and restarted the app anyway. The restart had
 *      nothing to do with restarting: the update had already failed, and the relaunched app ran the
 *      same check, found the same update, and failed again. The user saw the window close and reopen
 *      on the same version with no message.
 *   2. Nothing anywhere reported WHY the hand-off failed, because the updater's output is discarded
 *      when it is spawned detached — hence "a terminal flashed and vanished".
 *
 * The fix is a preflight: the app asks the updater whether the install can succeed BEFORE it stops
 * anything, and a refusal becomes a message with the window still open.
 */
import { assert, assertEquals } from "@std/assert";

const AUTO = await Deno.readTextFile(
  new URL("../../server/adapters/outbound/platform/auto-update.ts", import.meta.url),
);
const LIFECYCLE = await Deno.readTextFile(
  new URL("../../server/adapters/outbound/platform/window-lifecycle.ts", import.meta.url),
);

/** The body of `restartApp`, which is what the route calls. */
function restartBody(): string {
  const i = LIFECYCLE.indexOf("export async function restartApp");
  assert(i > 0, "restartApp must exist");
  return LIFECYCLE.slice(i, LIFECYCLE.indexOf("export ", i + 10));
}

Deno.test("a refused Windows hand-off does NOT close the window", () => {
  const body = restartBody();
  const at = body.indexOf('Deno.build.os === "windows" && updateStatus().pendingVersion');
  assert(at > 0, "the Windows hand-off branch must exist");
  const branch = body.slice(at, body.indexOf("const exe = Deno.execPath()"));

  // The refusal must be RETURNED. Falling through closes the window for an update that already
  // failed, which is the reported "the app closed and stayed on the old version".
  //
  // Asserted POSITIONALLY rather than with one regex spanning the branch: the explanatory comment
  // between the two returns is long, and a `{0,400}` window silently ran out and reported a correct
  // branch as broken (it did). Position cannot be fooled by prose length.
  const spawnIdx = branch.indexOf("const res = applyWindowsUpdate();");
  const guardIdx = branch.indexOf("if (res.restarting) return res;");
  const finalReturn = branch.lastIndexOf("return res;");
  assert(spawnIdx > 0, "the hand-off must be attempted");
  assert(guardIdx > spawnIdx, "a started hand-off must return immediately");
  assert(
    finalReturn > guardIdx,
    "a refused hand-off must return its error, not fall through to a restart",
  );
  // And nothing may restart from inside this branch: that is the fall-through being asserted against.
  const between = branch.slice(guardIdx, finalReturn);
  assertEquals(
    /Deno\.Command\(/.test(between),
    false,
    "no restart command may run between a failed hand-off and its return",
  );
});

Deno.test("the app validates BEFORE it stops anything", () => {
  // Ordering is the point: a preflight that runs after the spawn cannot keep the window open.
  const i = AUTO.indexOf("export function applyWindowsUpdate");
  const body = AUTO.slice(i, AUTO.indexOf("\n}", i));
  const preflightAt = body.indexOf("preflight(sidecar");
  const spawnAt = body.indexOf("cmd.spawn().unref()");
  assert(preflightAt > 0, "applyWindowsUpdate must run a preflight");
  assert(spawnAt > 0, "it must still spawn the sidecar");
  assert(preflightAt < spawnAt, "the preflight must run BEFORE the sidecar is spawned");
  // And it must happen before the process is told to exit.
  assert(
    preflightAt < body.indexOf("Deno.exit(0)"),
    "the preflight must run before the deferred exit",
  );
});

Deno.test("the preflight is synchronous, because the window must survive it", () => {
  // An async preflight would have to be awaited by the route, and a slow one would leave the user
  // waiting with no indication. `outputSync` also gives a hard, bounded answer.
  assert(
    /const out = cmd\.outputSync\(\)/.test(AUTO),
    "the preflight must not be an unbounded async call",
  );
  assert(
    /if \(out\.success\) return \{ ok: true, error: null \}/.test(AUTO),
    "a non-zero exit must be read as a refusal",
  );
});

Deno.test("a preflight that cannot run is a REFUSAL, never a pass", () => {
  // The dangerous default: if the updater is missing or crashes, treating that as "ok" authorises a
  // hand-off that loses the window. Every non-success path must return ok:false with a reason.
  const i = AUTO.indexOf("function preflight(");
  const body = AUTO.slice(i, AUTO.indexOf("\n}", i));
  assert(
    /catch \(err\) \{[\s\S]{0,300}?ok: false/.test(body),
    "a throwing preflight must refuse",
  );
  assertEquals(
    /catch \(err\) \{[\s\S]{0,300}?ok: true/.test(body),
    false,
    "no failure path may report success",
  );
});

Deno.test("the refusal names the real problem", () => {
  // A bare "update failed" would leave the owner where they started. The updater's message is
  // carried through, and its own message is actionable (it says to move the app to a writable folder).
  assert(
    /error:\s*text\.length > 0\s*\?/.test(AUTO),
    "the updater's own message must be surfaced",
  );
  assert(
    /exited \$\{out\.code\} with no message/.test(AUTO),
    "a silent non-zero exit must still say something",
  );
});

Deno.test("the Windows branch checks pendingVersion, so a plain restart is unaffected", () => {
  // The guard matters: a restart with no update staged must still do an ordinary restart, or the
  // user's Restart button stops working the moment an update fails.
  const body = restartBody();
  assert(
    /if \(Deno\.build\.os === "windows" && updateStatus\(\)\.pendingVersion\) \{/.test(body),
    "the hand-off must only be attempted when something is actually staged",
  );
  // And the plain restart path must still exist for that case.
  assert(
    /cmd", \{ args: \["\/c", "start", "", exe\]/.test(body),
    "an ordinary restart must remain available",
  );
});
