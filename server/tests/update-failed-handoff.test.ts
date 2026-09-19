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

// A packaged build carries a version; without one `status.current` is null and the reconciler stays
// silent BY DESIGN (there is nothing to compare against). Set BEFORE the module is imported, because
// `bakedVersion()` is evaluated at module load.
Deno.env.set("SEMACLIP_VERSION", "26.245");

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
    /reconcileRecordedVersion\(\)/.test(body),
    "the startup path must reconcile the record against the running build",
  );
  // The comparison lives in the reconciler: equal means the hand-off landed, different means it did not.
  assert(
    /previous === status\.current/.test(AUTO) || /previous !== status\.current/.test(AUTO),
    "a record that disagrees is the failure signature",
  );
  // It must reach the field the banner renders — via handoffError, which the getter surfaces.
  const reconciler = AUTO.slice(
    AUTO.indexOf("export async function reconcileRecordedVersion"),
    AUTO.indexOf("async function recordedVersion"),
  );
  assert(
    /status\.handoffError =/.test(reconciler),
    "the diagnosis must be recorded",
  );
  assert(
    /updateError: status\.updateError \?\? status\.handoffError/.test(AUTO),
    "and surfaced in the field the banner reads",
  );
  // And it must run BEFORE the check, so the message survives even if the check also fails.
  const reconcileAt = body.indexOf("reconcileRecordedVersion()");
  const checkAt = body.indexOf("ensureSidecar()");
  assert(checkAt > 0 && reconcileAt > 0, "both must exist on the startup path");
  assert(reconcileAt < checkAt, "the reconciliation must run before the update check");
});

Deno.test("the diagnosis SURVIVES a successful check", async () => {
  // ── THE BUG THE FIRST VERSION SHIPPED ───────────────────────────────────────────────────────
  // The message was written to `updateError`, and `runUpdateCheck` CLEARS that field on success (right
  // for a retry). So "up to date (26.245)" erased the diagnosis one line after boot set it. Measured
  // on the guest: stderr carried the warning while /api/update answered with an EMPTY error, so the
  // banner showed nothing and the loop stayed invisible.
  //
  // Driven for real: seed a record, reconcile, then run a SUCCESSFUL check and assert the diagnosis
  // is still readable through the getter the banner uses.
  Deno.env.set("SEMACLIP_UPDATE_RETRY_MS", "0");
  const mod = await import(`@/adapters/outbound/platform/auto-update.ts?t=${Date.now()}-survive`);

  const dir = await Deno.makeTempDir();
  const record = `${dir}/.semaclip-version`;
  // A record claiming a version this build is not — the failed-hand-off signature.
  await Deno.writeTextFile(record, "version=99.999\n");

  const diagnosis = await mod.reconcileRecordedVersion(record);
  assert(diagnosis !== null, "a disagreeing record must produce a diagnosis");
  assert(diagnosis!.includes("did not install"), `unexpected wording: ${diagnosis}`);
  assert(
    mod.updateStatus().updateError === diagnosis,
    "the banner's field must carry it once set",
  );

  // NOW the thing that broke: a successful check clears `updateError` for a retry.
  await mod.runUpdateCheck(async () => ({ reason: "up to date" }));

  assertEquals(
    mod.updateStatus().updateError,
    diagnosis,
    "a successful CHECK must not erase a failed APPLY — that is the whole loop staying invisible",
  );
  await Deno.remove(record);
});

Deno.test("a matching or absent record clears the diagnosis", async () => {
  // The other half: the next launch must be able to clear it, or a fixed install complains forever.
  const mod = await import(`@/adapters/outbound/platform/auto-update.ts?t=${Date.now()}-clear`);
  const dir = await Deno.makeTempDir();
  const record = `${dir}/.semaclip-version`;

  await Deno.writeTextFile(record, "version=99.999\n");
  assert((await mod.reconcileRecordedVersion(record)) !== null, "precondition: a diagnosis exists");

  // A record that agrees with this build means the hand-off landed.
  const current = mod.updateStatus().current;
  await Deno.writeTextFile(record, `version=${current}\n`);
  assert(
    (await mod.reconcileRecordedVersion(record)) === null,
    "a record matching the running build must not (re)raise the diagnosis",
  );
  // An absent record is the normal state of a hand-unpacked zip.
  await Deno.remove(record);
  assert(
    (await mod.reconcileRecordedVersion(record)) === null,
    "no record must be silent, not treated as a failure",
  );

  // A record carrying the LITERAL "null" — which is what a build with no version writes into it — must
  // also be silent. Measured: without this guard the reconciler raised a diagnosis claiming the swap
  // failed, because String(null) was read back as a version.
  await Deno.writeTextFile(record, "version=null\n");
  assertEquals(
    await mod.reconcileRecordedVersion(record),
    null,
    'a record of "null" is an absent version, not a failed install',
  );
  await Deno.writeTextFile(record, "version=undefined\n");
  assertEquals(await mod.reconcileRecordedVersion(record), null, '"undefined" likewise');
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
  const reconciler = AUTO.slice(AUTO.indexOf("export async function reconcileRecordedVersion"));
  assert(
    /if \(!previous \|\| previous === status\.current\) return null;/.test(reconciler),
    "an absent or matching record must return null so the caller can skip it",
  );
  assert(
    /if \(!status\.current\) return null;/.test(reconciler),
    "a build with no version must not reconcile at all",
  );
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
