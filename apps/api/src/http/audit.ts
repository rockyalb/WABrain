import { writeAudit, type AuditInput, type Db } from "@wabrain/db";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";

/** Writes an audit event attributed to the request's principal and IP. */
export function audit(
  deps: AppDeps,
  c: Context<AppEnv>,
  input: Omit<AuditInput, "actor" | "ip"> & { actor?: string },
  db: Db = deps.database.db,
): Promise<void> {
  return writeAudit(db, { actor: c.get("principal"), ip: c.get("clientIp"), ...input });
}

export async function notifySync(deps: AppDeps): Promise<void> {
  try {
    await deps.notifier.notify({ type: "sync" });
  } catch (error) {
    deps.logger.warn("notifier failed", { error });
  }
}
