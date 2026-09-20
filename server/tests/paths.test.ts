/**
 * User-entered path resolution, and the two settings that use it.
 *
 * The behaviour under test is the class of bug this replaces: `exportDir` defaulted to the
 * literal string `~/Videos/SemaClip` and nothing expanded the tilde, so the "directory" was
 * a RELATIVE path named `~` under whatever CWD the app was launched from. Whether exports
 * landed somewhere sane depended on the launch context. A relative path is refused outright
 * for the same reason, and a trailing separator is removed because it survives into string
 * concatenation as "dir//name".
 */
import { assertEquals, assertThrows } from "@std/assert";
import { isAbsolutePath, resolveUserPath, separator } from "@/application/use-cases/paths.ts";
import { SettingsUseCase, DEFAULT_SETTINGS } from "@/application/use-cases/SettingsUseCase.ts";
import type { SettingsRepository } from "@/application/ports/outbound.ts";
import type { EventBus } from "@/application/ports/outbound.ts";

const SEP = separator();
const HOME = Deno.env.get("HOME") ?? Deno.env.get("USERPROFILE") ?? "";

Deno.test("resolveUserPath: expands ~ to the real home directory", () => {
  const resolved = resolveUserPath("~/Videos/SemaClip");
  assertEquals(resolved.startsWith(HOME), true, `expected the home prefix: ${resolved}`);
  assertEquals(resolved.includes("~"), false, "the literal tilde must not survive");
  assertEquals(resolved.endsWith(`${SEP}SemaClip`), true, resolved);
});

Deno.test("resolveUserPath: bare ~ is the home directory", () => {
  assertEquals(resolveUserPath("~"), HOME.replace(new RegExp(`[\\\\/]+$`), ""));
});

Deno.test("resolveUserPath: refuses a RELATIVE path instead of guessing a base", () => {
  // The exact failure being prevented: this would land under whatever directory the app
  // happened to be launched from, and differ between launches.
  assertThrows(() => resolveUserPath("vods/projects"), Error, "not an absolute path");
  assertThrows(() => resolveUserPath("./vods"), Error, "not an absolute path");
  assertThrows(() => resolveUserPath("vods"), Error, "not an absolute path");
});

Deno.test("resolveUserPath: refuses another user's tilde rather than guessing", () => {
  assertThrows(() => resolveUserPath("~someoneelse/vods"), Error, "Only");
});

Deno.test("resolveUserPath: refuses an empty path", () => {
  assertThrows(() => resolveUserPath(""), Error, "empty");
  assertThrows(() => resolveUserPath("   "), Error, "empty");
});

Deno.test("resolveUserPath: normalises separators and drops the trailing one", () => {
  const absolute = Deno.build.os === "windows" ? "C:\\a\\b\\c" : "/a/b/c";
  const trailing = Deno.build.os === "windows" ? "C:\\a\\b\\c\\" : "/a/b/c/";
  assertEquals(resolveUserPath(trailing), absolute, "a trailing separator becomes 'dir//name'");
  // Mixed separators unify to the host's own, so anything spawned or shown the path works.
  const mixed = Deno.build.os === "windows" ? "C:/a/b/c" : "/a/b/c";
  assertEquals(resolveUserPath(mixed), absolute);
  assertEquals(resolveUserPath(absolute).includes(SEP), true);
});

Deno.test("isAbsolutePath: platform-correct, so a POSIX path is not absolute on Windows", () => {
  if (Deno.build.os === "windows") {
    assertEquals(isAbsolutePath("C:\\x"), true);
    assertEquals(isAbsolutePath("C:/x"), true);
    assertEquals(isAbsolutePath("\\\\server\\share"), true);
    assertEquals(isAbsolutePath("/x"), false, "a drive-less path is relative on Windows");
  } else {
    assertEquals(isAbsolutePath("/x"), true);
    assertEquals(isAbsolutePath("C:\\x"), false);
  }
});

// ── The setting that uses it ──────────────────────────────────────────────

class FakeSettingsRepo implements SettingsRepository {
  value: string | null = null;
  async get(_key: string): Promise<string | null> {
    return this.value;
  }
  async set(_key: string, value: string): Promise<void> {
    this.value = value;
  }
}

const fakeBus = { publish: () => {}, subscribe: () => () => {} } as unknown as EventBus;

Deno.test("vodDir: an untouched install answers with the concrete cache location", async () => {
  const repo = new FakeSettingsRepo();
  const settings = new SettingsUseCase(repo, fakeBus, "/data/SemaClip/cache/vods");
  const value = await settings.get();
  assertEquals(value.vodDir, "/data/SemaClip/cache/vods");
  // …and reading must not WRITE: nothing is persisted until the user chooses.
  assertEquals(repo.value, null, "a read must not create a stored setting");
});

Deno.test("vodDir: a chosen directory persists resolved, not verbatim", async () => {
  const repo = new FakeSettingsRepo();
  const settings = new SettingsUseCase(repo, fakeBus, "/data/cache/vods");
  const saved = await settings.update({ vodDir: `~/VODs${SEP}` });
  assertEquals(saved.vodDir.includes("~"), false, "stored verbatim, the OS could not use it");
  assertEquals(saved.vodDir.endsWith(`VODs`), true, saved.vodDir);
  // Round-trips: the stored value is what comes back.
  assertEquals((await settings.get()).vodDir, saved.vodDir);
});

Deno.test("vodDir: a relative path is REFUSED, and nothing is written", async () => {
  const repo = new FakeSettingsRepo();
  const settings = new SettingsUseCase(repo, fakeBus, "/data/cache/vods");
  await assertThrowsAsync(() => settings.update({ vodDir: "VODs" }));
  assertEquals(repo.value, null, "a refused setting must not be persisted in any form");
});

Deno.test("exportDir: the tilde default is expanded on save", async () => {
  const repo = new FakeSettingsRepo();
  const settings = new SettingsUseCase(repo, fakeBus, "/data/cache/vods");
  const saved = await settings.update({ exportDir: DEFAULT_SETTINGS.exportDir });
  assertEquals(saved.exportDir.includes("~"), false, "the stored default must be usable");
  assertEquals(saved.exportDir.startsWith(HOME), true, saved.exportDir);
});

async function assertThrowsAsync(fn: () => Promise<unknown>): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "expected the update to throw");
}
