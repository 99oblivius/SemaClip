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

Deno.test("the hand-off passes the DOWNLOADED PAYLOAD instead of re-downloading", () => {
  // ── WHY THIS IS THE POINT OF THE WHOLE FEATURE ──────────────────────────────────────────────
  // The app downloads while it is still open so the user can see progress and keep working. If the
  // sidecar then fetched the archive itself after the app quit, that work would be discarded: the
  // progress would be theatre and the restart would be as slow as the original download. So the
  // staged path, its hash and its version must all be handed over.
  // Each flag is matched as its own QUOTED literal. A bare /-payload/ also matches "-payload-sha256",
  // so removing the payload flag alone left the assertion green — the test proved nothing about the
  // flag it named.
  assert(SRC.includes('"-payload",'), "the downloaded archive must be handed to the sidecar");
  assert(/status\.stagedPath/.test(SRC), "the path handed over must be the staged one");
  assert(SRC.includes('"-payload-sha256",'), "the hash must travel with it, verified at install time");
  assert(/status\.stagedSha256/.test(SRC), "the hash handed over must be the verified one");
  assert(SRC.includes('"-version",'), "the version must be recorded by whoever performs the swap");
  assert(/status\.pendingVersion/.test(SRC), "the recorded version must be the one that was downloaded");
});

Deno.test("a download in flight is not offered as installable", () => {
  // `pendingVersion` is set ONLY after the bytes are on disk and verified. Setting it when the
  // download STARTS would let the banner offer a restart that installs nothing.
  //
  // Scoped to the DOWNLOAD FUNCTION, not the check. The check no longer downloads at all, so a
  // window from the check to `applyWindowsUpdate` would now include the download helper and prove
  // nothing about the function it names — which is exactly how this test passed before the split.
  const start = SRC.indexOf("async function downloadWindowsUpdate");
  const end = SRC.indexOf("export function startUpdateDownload");
  assert(start > 0 && end > start, "the download function must exist on its own");
  const fn = SRC.slice(start, end);

  const setPending = fn.indexOf("status.pendingVersion = latest;");
  const downloadCall = fn.indexOf("await downloadVerified(url, staged");
  assert(downloadCall > 0 && setPending > 0, "both the download and the assignment must exist");
  assert(
    setPending > downloadCall,
    "the pending version must be assigned AFTER the download, not before it",
  );
});

Deno.test("opening the app OFFERS an update and downloads nothing", () => {
  // ── THE OWNER'S DIRECTIVE ───────────────────────────────────────────────────────────────────
  // "Even the downloading should not be happening automatically." So the check must not be able to
  // reach a download: no downloadVerified call inside it, and the offer recorded instead.
  //
  // This is asserted on the CHECK's own body, because that is the function the startup path runs.
  const start = SRC.indexOf("async function checkWindowsUpdate");
  const end = SRC.indexOf("async function downloadWindowsUpdate");
  assert(start > 0 && end > start, "the Windows check function must exist");
  const check = SRC.slice(start, end);

  assertEquals(
    check.includes("downloadVerified"),
    false,
    "the check must not download: opening the app must not spend the user's bandwidth",
  );
  assert(
    /status\.availableVersion\s*=\s*latest;/.test(check),
    "the check must RECORD the offer, or the UI would never learn an update exists",
  );
  assert(
    check.includes('emitAppEvent({ type: "update-available"'),
    "the offer must be pushed to the UI, which is the only surface that can ask for it",
  );
});

Deno.test("the download is reachable ONLY through an explicit request", () => {
  // The other half of the directive: bytes may move on a click and on nothing else. The only caller
  // of the download is the exported entry point the endpoint uses.
  const start = SRC.indexOf("export function startUpdateDownload");
  assert(start > 0, "an explicit start entry point must exist");
  const fn = SRC.slice(start, start + 800);
  assert(
    fn.includes("downloadWindowsUpdate()"),
    "the explicit path must be what actually fetches",
  );
  // `void` rather than `await`: the endpoint answers immediately and progress arrives over the
  // event stream. Awaiting would hold the HTTP request for the length of a 100MB transfer.
  assert(fn.includes("void downloadWindowsUpdate()"), "the fetch must not block the request");
});

Deno.test("the hand-off is DETACHED, because it must outlive the process it waits for", () => {
  // A helper that dies with its parent can never perform the swap: the parent IS the thing that has
  // to exit first. `unref()` is what detaches it.
  assert(
    /cmd\.spawn\(\)\.unref\(\)/.test(SRC),
    "the sidecar must be spawned unref'd, or it would be killed with the app it is waiting for",
  );
});
