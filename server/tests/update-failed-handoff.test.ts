/**
 * The reported loop: the app closes, nothing installs, and reopening offers the same update forever.
 *
 * ── WHAT THE USER SAW ───────────────────────────────────────────────────────────────────────────
 * "it downloads 244, and if I don't touch anything for 4 seconds a terminal opens, and the app closes
 * with the terminal. Then I reopen and it's not updated and loops the same again."
 *
 * The 4-second timer is the auto-restart working as designed; the failure is that nothing installed
 * AND nothing said so. The updater already knows what it applied — it records the version INSIDE the
 * bundle — so a record that disagrees with the running binary is the signature of a hand-off that
 * closed the app without completing its swap. That check is what turns an endless loop into a visible
 * message on the very first failure.
 *
 * ── WHY THE PATH IS ASSERTED TOO ────────────────────────────────────────────────────────────────
 * The same class of bug bit the updater's LOG: it was written into the app directory while the route
 * read it from the sidecar directory, so on a portable install the endpoint answered "no log" while
 * the file sat one directory away. The record must be read from where the updater writes it.
 */
import { assert, assertEquals } from "@std/assert";

const AUTO = await Deno.readTextFile(
  new URL("../../server/adapters/outbound/platform/auto-update.ts", import.meta.url),
);
const SIDECAR = await Deno.readTextFile(
  new URL("../../server/adapters/outbound/platform/sidecar.ts", import.meta.url),
);
// Both files, because the two constants live in DIFFERENT ones: the version record is in update.go
// and the log's name is in main.go. Reading only one made this test claim the wrong thing.
const UPDATER = await Deno.readTextFile(
  new URL("../../tools/updater/update.go", import.meta.url),
);
const UPDATER_MAIN = await Deno.readTextFile(
  new URL("../../tools/updater/main.go", import.meta.url),
);

Deno.test("a recorded version that disagrees with the running build is reported", () => {
  const i = AUTO.indexOf("export async function startAutoUpdate");
  const body = AUTO.slice(i, AUTO.indexOf("export ", i + 10));

  assert(
    /recordedVersion\(\)/.test(body),
    "the startup path must reconcile the record against the running build",
  );
  // The comparison is the whole point: equal means the hand-off landed, different means it did not.
  assert(
    /previous !== status\.current/.test(body),
    "a record that disagrees is the failure signature",
  );
  // It must set the SAME field the banner renders, or the message has no reader.
  assert(
    /status\.updateError =/.test(body),
    "the diagnosis must reach the field the banner shows",
  );
  // And it must run BEFORE the check, so the message survives even if the check also fails.
  const reconcileAt = body.indexOf("recordedVersion()");
  const checkAt = body.indexOf("ensureSidecar()");
  assert(checkAt > 0 && reconcileAt > 0, "both must exist on the startup path");
  assert(reconcileAt < checkAt, "the reconciliation must run before the update check");
});

Deno.test("a missing or unreadable record is silent, not a fabricated failure", () => {
  // Every hand-unpacked zip starts with no record. Reporting that as a failed update would put an
  // error on screen for every first run.
  const i = AUTO.indexOf("async function recordedVersion");
  const body = AUTO.slice(i, AUTO.indexOf("\n}", i));
  assert(/catch \{/.test(body), "an absent record must be caught, not thrown");
  assert(
    /return null/.test(body),
    "no record must return null so the caller can skip the comparison",
  );
  // And the caller must guard on it being present.
  const caller = AUTO.slice(AUTO.indexOf("export async function startAutoUpdate"));
  assert(/if \(previous && previous !== status\.current\)/.test(caller), "null must skip the check");
});

Deno.test("the record is read from the APP directory, where the updater writes it", () => {
  // The log had this exact bug: written into the app dir, read from the sidecar dir, so the endpoint
  // reported nothing on a portable install. Both paths are asserted together because they are the
  // same kind of claim.
  assert(
    /export function updateRecordPath\(\): string \{\s*\n\s*return `\$\{appDirPath[^}]*\}/.test(SIDECAR),
    "the record must be read from the app directory",
  );
  assertEquals(
    /updateRecordPath[\s\S]{0,120}?sidecarDir\(/.test(SIDECAR),
    false,
    "reading it from the sidecar directory misses every portable install",
  );
  assert(
    /export function updateLogPath\(\): string \{\s*\n\s*return `\$\{appDirPath[^}]*\}/.test(SIDECAR),
    "the log has the same requirement",
  );
});

Deno.test("the name matches what the updater actually writes", () => {
  // Two owners of one filename is how a reader ends up looking for a file nobody creates.
  const record = SIDECAR.match(/UPDATE_RECORD_NAME = "([^"]+)"/)?.[1];
  assertEquals(record, ".semaclip-version");
  assert(
    UPDATER.includes(`const stateFile = "${record}"`),
    `tools/updater must write ${record} — the reader and writer must name the same file`,
  );

  const log = SIDECAR.match(/UPDATE_LOG_NAME = "([^"]+)"/)?.[1];
  assertEquals(log, ".semaclip-update.log");
  assert(
    UPDATER_MAIN.includes(`const updateLogName = "${log}"`),
    `tools/updater must write ${log} (declared in main.go)`,
  );
});
