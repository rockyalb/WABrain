import { desc } from "drizzle-orm";
import type { Db } from "../client.js";
import { newId } from "../ids.js";
import { auditEvents } from "../schema.js";

export interface AuditInput {
  /** "owner", "device:<id>", "ai", or "system". */
  actor: string;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  ip?: string | null;
  /** Metadata only: never message content, tokens, or passwords. */
  details?: Record<string, unknown> | null;
}

export async function writeAudit(db: Db, input: AuditInput): Promise<void> {
  await db.insert(auditEvents).values({
    id: newId(),
    actor: input.actor,
    action: input.action,
    targetType: input.targetType ?? null,
    targetId: input.targetId ?? null,
    ip: input.ip ?? null,
    details: input.details ?? null,
  });
}

export async function listAudit(db: Db, limit = 100) {
  return db.select().from(auditEvents).orderBy(desc(auditEvents.at)).limit(limit);
}
