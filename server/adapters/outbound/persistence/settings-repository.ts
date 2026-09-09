import { eq } from "drizzle-orm";
import type { Db } from "./db.ts";
import { schema } from "./db.ts";
import type { SettingsRepository } from "@/application/ports/outbound.ts";

/** settings table adapter — single key-value row per settings group. */
export class SqliteSettingsRepository implements SettingsRepository {
  constructor(private readonly db: Db) {}

  async get(key: string): Promise<string | null> {
    const rows = await this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).limit(1).all();
    return rows[0]?.value ?? null;
  }

  async set(key: string, value: string): Promise<void> {
    await this.db.insert(schema.settings).values({ key, value })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
      .run();
  }
}