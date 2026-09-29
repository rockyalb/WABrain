import { and, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { newId } from "../ids.js";
import { devices, pushEndpoints } from "../schema.js";

export interface PushEndpointInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** One endpoint per device; re-registering replaces it. */
export async function upsertPushEndpoint(db: Db, deviceId: string, input: PushEndpointInput): Promise<void> {
  await db
    .insert(pushEndpoints)
    .values({ id: newId(), deviceId, ...input })
    .onConflictDoUpdate({
      target: pushEndpoints.deviceId,
      set: { ...input, updatedAt: sql`now()`, failureCount: 0, lastFailureAt: null },
    });
}

export async function deletePushEndpoint(db: Db, deviceId: string): Promise<boolean> {
  const rows = await db.delete(pushEndpoints).where(eq(pushEndpoints.deviceId, deviceId)).returning({ id: pushEndpoints.id });
  return rows.length > 0;
}

/** Endpoints of active devices, for the push sender. */
export async function listPushEndpoints(db: Db) {
  return db
    .select({
      id: pushEndpoints.id,
      deviceId: pushEndpoints.deviceId,
      endpoint: pushEndpoints.endpoint,
      p256dh: pushEndpoints.p256dh,
      auth: pushEndpoints.auth,
      failureCount: pushEndpoints.failureCount,
    })
    .from(pushEndpoints)
    .innerJoin(devices, eq(devices.id, pushEndpoints.deviceId))
    .where(and(isNull(devices.revokedAt), sql`(${devices.id} not like 'web:%' or exists (select 1 from owner_sessions s where s.token_hash = substring(${devices.id} from 5) and s.expires_at > now()))`));
}
