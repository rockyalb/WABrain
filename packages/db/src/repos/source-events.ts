import { and, asc, desc, eq, isNull, lt } from "drizzle-orm";
import type { Db } from "../client.js";
import { newId } from "../ids.js";
import { sourceEvents } from "../schema.js";

export interface SourceEventInput {
  sessionId: string;
  idempotencyKey: string;
  deliveryId: string;
  eventType: string;
  chatJid: string;
  raw: unknown;
}

/** Inserts an event unless (session, idempotency key) already exists. */
export async function insertSourceEvent(db: Db, input: SourceEventInput): Promise<{ id: string; inserted: boolean }> {
  const [row] = await db
    .insert(sourceEvents)
    .values({ id: newId(), ...input })
    .onConflictDoNothing({ target: [sourceEvents.sessionId, sourceEvents.idempotencyKey] })
    .returning({ id: sourceEvents.id });
  if (row) return { id: row.id, inserted: true };
  const [existing] = await db
    .select({ id: sourceEvents.id })
    .from(sourceEvents)
    .where(and(eq(sourceEvents.sessionId, input.sessionId), eq(sourceEvents.idempotencyKey, input.idempotencyKey)));
  return { id: existing!.id, inserted: false };
}

/** The OpenWA session the most recent event came from, or null before the first one. */
export async function latestSourceSessionId(db: Db): Promise<string | null> {
  const [row] = await db.select({ sessionId: sourceEvents.sessionId }).from(sourceEvents).orderBy(desc(sourceEvents.receivedAt)).limit(1);
  return row?.sessionId ?? null;
}

export async function getSourceEvent(db: Db, id: string) {
  const [row] = await db.select().from(sourceEvents).where(eq(sourceEvents.id, id));
  return row ?? null;
}

export async function markProjected(db: Db, id: string, error: string | null = null): Promise<void> {
  await db
    .update(sourceEvents)
    .set({ projectedAt: new Date(), projectionError: error })
    .where(eq(sourceEvents.id, id));
}

export async function deleteSourceEvent(db: Db, id: string): Promise<void> {
  await db.delete(sourceEvents).where(eq(sourceEvents.id, id));
}

/** Events still unprojected after `olderThan` (lost enqueue or crashed worker). */
export async function listStaleUnprojected(db: Db, olderThan: Date, limit = 500): Promise<string[]> {
  const rows = await db
    .select({ id: sourceEvents.id })
    .from(sourceEvents)
    .where(and(isNull(sourceEvents.projectedAt), lt(sourceEvents.receivedAt, olderThan)))
    .orderBy(asc(sourceEvents.receivedAt))
    .limit(limit);
  return rows.map((row) => row.id);
}
