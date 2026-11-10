/**
 * The plugin's own named values (1.4.0), sealed with the installation key
 * through ctx.secrets.seal: never in the database in the clear, and readable
 * without an acting user, which notification delivery has none of.
 */

import { eq } from "drizzle-orm";
import type {
  PluginContext,
  PluginDatabase,
} from "@termix-ssh/plugin-sdk/backend";
import { state as stateDef } from "./tables.js";

// Drizzle's table and client types are per dialect; treated loosely here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Table = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Drizzle = any;

export type StateName = "signing-secret";

export type StateStore = Awaited<ReturnType<typeof createStateStore>>;

export async function createStateStore(
  db: PluginDatabase,
  secrets: PluginContext["secrets"],
) {
  const table: Table = await db.define(stateDef);
  const client = (): Promise<Drizzle> => db.client<Drizzle>();

  async function read(name: StateName) {
    const rows = await (
      await client()
    )
      .select()
      .from(table)
      .where(eq(table.name, name))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      sealed: String(row.value),
      updatedBy: String(row.updatedBy),
      updatedAt: String(row.updatedAt),
    };
  }

  return {
    /** Who set it and when, without the value. */
    async info(
      name: StateName,
    ): Promise<{ updatedBy: string; updatedAt: string } | null> {
      const row = await read(name);
      return row
        ? { updatedBy: row.updatedBy, updatedAt: row.updatedAt }
        : null;
    },

    /** The value, or null when unset or no longer readable. */
    async get(name: StateName): Promise<string | null> {
      const row = await read(name);
      return row ? secrets.unseal(row.sealed) : null;
    },

    async set(name: StateName, value: string, by: string): Promise<string> {
      const sealed = await secrets.seal(value);
      const at = new Date().toISOString();
      const drizzle = await client();
      await drizzle.delete(table).where(eq(table.name, name));
      await drizzle
        .insert(table)
        .values({ name, value: sealed, updatedBy: by, updatedAt: at });
      await db.persist();
      return at;
    },
  };
}
