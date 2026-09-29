import type { Context } from "@wabrain/contracts";
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { toContext } from "../mappers.js";
import { chats, contexts, people, tasks } from "../schema.js";
import { listContextsOrdered } from "./settings.js";

export async function listContexts(db: Db): Promise<Context[]> {
  return (await listContextsOrdered(db)).map(toContext);
}

export async function getContext(db: Db, id: string): Promise<Context> {
  const [row] = await db.select().from(contexts).where(eq(contexts.id, id));
  if (!row) throw notFound("Context");
  return toContext(row);
}

export async function assertContextExists(db: Db, id: string | null | undefined): Promise<void> {
  if (id) await getContext(db, id).catch(() => Promise.reject(invalid(`Unknown context ${id}`)));
}

export async function createContext(db: Db, input: { name: string; color?: string | null }): Promise<Context> {
  const [max] = await db.select({ value: sql<number>`coalesce(max(${contexts.sortOrder}), -1)::int` }).from(contexts);
  const [row] = await db
    .insert(contexts)
    .values({ id: newId(), name: input.name, color: input.color ?? null, sortOrder: (max?.value ?? -1) + 1 })
    .returning();
  return toContext(row!);
}

export async function updateContext(
  db: Db,
  id: string,
  patch: { name?: string; color?: string | null; sortOrder?: number },
): Promise<Context> {
  const [row] = await db
    .update(contexts)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(contexts.id, id))
    .returning();
  if (!row) throw notFound("Context");
  return toContext(row);
}

/** Deletes a context, moving its tasks, chats, and people to `reassignTo` (or none). */
export async function deleteContext(db: Db, id: string, reassignTo: string | null): Promise<void> {
  await getContext(db, id);
  if (reassignTo === id) throw invalid("reassignTo must be a different context");
  await assertContextExists(db, reassignTo);
  const now = sql`now()`;
  await db.update(tasks).set({ contextId: reassignTo, updatedAt: now }).where(eq(tasks.contextId, id));
  await db.update(chats).set({ defaultContextId: reassignTo, updatedAt: now }).where(eq(chats.defaultContextId, id));
  await db.update(people).set({ defaultContextId: reassignTo, updatedAt: now }).where(eq(people.defaultContextId, id));
  await db.delete(contexts).where(eq(contexts.id, id));
}
