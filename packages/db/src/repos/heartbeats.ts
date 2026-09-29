import { desc, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { workerHeartbeats } from "../schema.js";

export async function recordHeartbeat(db: Db, workerId: string): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ id: workerId })
    .onConflictDoUpdate({ target: workerHeartbeats.id, set: { seenAt: sql`now()` } });
}

export async function latestHeartbeat(db: Db): Promise<Date | null> {
  const [row] = await db.select().from(workerHeartbeats).orderBy(desc(workerHeartbeats.seenAt)).limit(1);
  return row?.seenAt ?? null;
}
