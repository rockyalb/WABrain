/**
 * Scheduled notifications already queued (reminders, daily summaries), so each is produced once.
 * The claim is written in the same transaction as the durable notification (./notifications.ts);
 * delivery, retries and acknowledgement are tracked there, not here.
 */
import type { Db } from "../client.js";
import { notificationLog } from "../schema.js";

/** Records (kind, key) and returns true, or returns false when it was already recorded. */
export async function claimNotification(db: Db, kind: string, key: string, at = new Date()): Promise<boolean> {
  const rows = await db.insert(notificationLog).values({ kind, key, sentAt: at }).onConflictDoNothing().returning({ key: notificationLog.key });
  return rows.length > 0;
}
