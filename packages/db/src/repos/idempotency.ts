import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../client.js";
import { idempotencyKeys } from "../schema.js";

export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

export type IdempotencyBegin =
  | { state: "new" }
  | { state: "in_progress" }
  | { state: "mismatch" }
  | { state: "completed"; status: number; body: string };

/** Claims a key, or reports the stored outcome of an earlier request with it. */
export async function beginIdempotent(db: Db, scopeHash: string, requestHash: string, now = new Date()): Promise<IdempotencyBegin> {
  const expiry = new Date(now.getTime() - IDEMPOTENCY_TTL_MS);
  await db.delete(idempotencyKeys).where(and(eq(idempotencyKeys.scopeHash, scopeHash), lt(idempotencyKeys.createdAt, expiry)));
  const inserted = await db
    .insert(idempotencyKeys)
    .values({ scopeHash, requestHash, state: "in_progress", createdAt: now })
    .onConflictDoNothing()
    .returning({ scopeHash: idempotencyKeys.scopeHash });
  if (inserted.length) return { state: "new" };
  const [row] = await db.select().from(idempotencyKeys).where(eq(idempotencyKeys.scopeHash, scopeHash));
  if (!row) return { state: "in_progress" };
  if (row.requestHash !== requestHash) return { state: "mismatch" };
  if (row.state === "in_progress") return { state: "in_progress" };
  return { state: "completed", status: row.responseStatus ?? 200, body: row.responseBody ?? "" };
}

export async function completeIdempotent(db: Db, scopeHash: string, status: number, body: string): Promise<void> {
  await db
    .update(idempotencyKeys)
    .set({ state: "completed", responseStatus: status, responseBody: body })
    .where(eq(idempotencyKeys.scopeHash, scopeHash));
}

export async function abortIdempotent(db: Db, scopeHash: string): Promise<void> {
  await db.delete(idempotencyKeys).where(eq(idempotencyKeys.scopeHash, scopeHash));
}

export async function purgeExpiredIdempotencyKeys(db: Db, now = new Date()): Promise<void> {
  await db.delete(idempotencyKeys).where(lt(idempotencyKeys.createdAt, new Date(now.getTime() - IDEMPOTENCY_TTL_MS)));
}
