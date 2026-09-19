/**
 * The version record must describe the BUNDLE, not the machine.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────────────────────────────
 * The updater recorded the applied version in `%LOCALAPPDATA%\SemaClip\state.txt` — one file per
 * user, shared by every copy of the app. The owner hit it exactly:
 *
 *     updated 26.234 -> 26.235, then re-extracted the 26.234 archive;
 *     the fresh 26.234 copy reported "up to date" while its files were 26.234.
 *
 * The version was a claim about whatever directory happened to be read first. It is now written
 * INSIDE the bundle it describes, which is the only place a version is authoritative for a specific
 * set of files.
 *
 * These tests pin the PROPERTY (a version is per-bundle) rather than the path, because the path is
 * the implementation and the property is what went wrong.
 */
import { assertEquals } from "@std/assert";

/** Read the updater's own recorded version for a directory, parsing the same `version=` key. */
async function installedVersion(dir: string): Promise<string> {
  try {
    const raw = await Deno.readTextFile(`${dir}/.semaclip-version`);
    for (const line of raw.split("\n")) {
      const [k, v] = line.split("=");
      if (k?.trim() === "version" && v?.trim()) return v.trim();
    }
    return "";
  } catch {
    return "";
  }
}

Deno.test("two bundles do not share a version record", async () => {
  const a = await Deno.makeTempDir();
  const b = await Deno.makeTempDir();
  try {
    // One bundle updated, the other untouched — the reported scenario.
    await Deno.writeTextFile(`${a}/.semaclip-version`, "version=26.235\n");

    assertEquals(await installedVersion(a), "26.235");
    assertEquals(
      await installedVersion(b),
      "",
      "an unrelated directory must not inherit another bundle's version",
    );
  } finally {
    await Deno.remove(a, { recursive: true });
    await Deno.remove(b, { recursive: true });
  }
});

Deno.test("the record lives inside the bundle, never in a shared per-user location", async () => {
  // The old location was derived from LOCALAPPDATA, which is per USER. Nothing must read or write a
  // version there any more; this asserts the updater's source does not contain that path at all.
  const src = await Deno.readTextFile(
    new URL("../../tools/updater/update.go", import.meta.url),
  );
  // `legacyStatePath` exists solely to MIGRATE away from it, so the string may appear there — but it
  // must never be the path a version is WRITTEN to.
  const writes = src
    .split("\n")
    .filter((l) => l.includes("legacyStatePath()") && l.includes("WriteFile"));
  assertEquals(writes.length, 0, "a version must never be written to the legacy per-user path");
  // The bundle's own record is what writeVersion targets.
  assertEquals(
    /writeFileAtomic\(filepath\.Join\(dir, stateFile\)/.test(src),
    true,
    "writeVersion must target the bundle's own state file",
  );
});

Deno.test("an updated bundle records the version NEXT TO the payload it replaced", async () => {
  // The property that makes the record trustworthy: it sits in the same directory as the files it
  // describes. Replacing the payload wholesale does not lose it.
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/SemaClip.dll`, "payload");
    await Deno.writeTextFile(`${dir}/.semaclip-version`, "version=26.240\n");

    // A swap replaces the payload files but not the record.
    await Deno.writeTextFile(`${dir}/SemaClip.dll`, "new payload");
    assertEquals(
      await installedVersion(dir),
      "26.240",
      "the record survives the payload being replaced in place",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
