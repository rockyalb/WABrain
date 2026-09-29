/** Small server-side key/value state. Values are metadata or server secrets, never message content. */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { appState } from "../schema.js";

export async function getAppState<T>(db: Db, key: string): Promise<T | null> {
  const [row] = await db.select().from(appState).where(eq(appState.key, key));
  return (row?.value as T | undefined) ?? null;
}

export async function setAppState(db: Db, key: string, value: unknown): Promise<void> {
  await db
    .insert(appState)
    .values({ key, value })
    .onConflictDoUpdate({ target: appState.key, set: { value, updatedAt: sql`now()` } });
}

/** Inserts `value` unless the key exists, then returns the stored value (first writer wins). */
export async function getOrCreateAppState<T>(db: Db, key: string, create: () => T): Promise<T> {
  const existing = await getAppState<T>(db, key);
  if (existing !== null) return existing;
  await db.insert(appState).values({ key, value: create() as unknown }).onConflictDoNothing();
  return (await getAppState<T>(db, key))!;
}

export async function deleteAppState(db: Db, key: string): Promise<void> {
  await db.delete(appState).where(eq(appState.key, key));
}
