/**
 * UI scale persistence + validation.
 *
 * The scale is the only setting the frontend indexes into a lookup table
 * (`UI_SCALE_FACTOR[scale]`), so an unrecognised value read back from the DB
 * would render at the default while the Settings dropdown displayed the stored
 * string — the UI would disagree with itself. These tests pin the three valid
 * steps, the default, and the rejection of everything else through the real
 * repository round-trip (persist -> fresh use case -> read), which is the path a
 * restart takes.
 */
import { assert, assertEquals } from "@std/assert";
import { SettingsUseCase, DEFAULT_SETTINGS } from "@/application/use-cases/SettingsUseCase.ts";
import type { EventBus, SettingsRepository } from "@/application/ports/outbound.ts";

/** Minimal in-memory stand-in for the key/value settings table. */
class FakeRepo implements SettingsRepository {
  private store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<void> {
    this.store.set(key, value);
  }
}

const fakeBus = { publish: () => {}, subscribe: () => () => {} } as unknown as EventBus;

function makeUseCase(repo = new FakeRepo()) {
  return { repo, useCase: new SettingsUseCase(repo, fakeBus) };
}

Deno.test("uiScale defaults to medium", () => {
  assertEquals(DEFAULT_SETTINGS.uiScale, "medium");
});

Deno.test("uiScale: each valid step round-trips through a fresh use case", async () => {
  for (const scale of ["small", "medium", "large"] as const) {
    const { repo, useCase } = makeUseCase();
    const saved = await useCase.update({ uiScale: scale });
    assertEquals(saved.uiScale, scale, `${scale} was not accepted`);

    // A second use case over the same store is what a restart does — this is the
    // path that would surface a value the frontend cannot index.
    const reread = await new SettingsUseCase(repo, fakeBus).get();
    assertEquals(reread.uiScale, scale, `${scale} did not survive a re-read`);
  }
});

Deno.test("uiScale: an unknown value is rejected, keeping the default", async () => {
  const { useCase } = makeUseCase();
  // The frontend looks this up in UI_SCALE_FACTOR; an unknown key would read
  // undefined and multiply the base font to NaN.
  const saved = await useCase.update({ uiScale: "huge" });
  assertEquals(saved.uiScale, "medium");
});

Deno.test("uiScale: a corrupt stored value falls back to the default", async () => {
  const { repo, useCase } = makeUseCase();
  await repo.set("app", JSON.stringify({ uiScale: "gigantic" }));
  const state = await useCase.get();
  assertEquals(state.uiScale, "medium");
});

Deno.test("uiScale is independent of the other settings", async () => {
  const { useCase } = makeUseCase();
  await useCase.update({ uiScale: "large" });
  const after = await useCase.update({ cpuUsage: "fast" });
  assertEquals(after.uiScale, "large");
  assertEquals(after.cpuUsage, "fast");
});
