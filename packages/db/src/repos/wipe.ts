import { eq, sql } from "drizzle-orm";
import type { Database } from "../client.js";
import { chats } from "../schema.js";
import { seedDefaultContexts } from "./settings.js";
import { SYNC_LOCK } from "./sync.js";

const WIPED_TABLES = sql.raw(`
  message_chunks, media_objects, messages, participants, source_events,
  person_facts, task_events, review_items, eval_examples, analysis_runs,
  tasks, chats, people, contexts, sync_tombstones, idempotency_keys,
  applied_actions, chat_pipeline_state, notification_log, notification_deliveries, notification_events,
  history_import_gaps, history_import_runs`);

export interface WipeResult {
  /** Off chats kept as bare identifiers so they stay Off. */
  keptOffChats: number;
}

/**
 * Deletes all WhatsApp-derived and task data. Keeps the owner account,
 * devices (so paired phones resync to the empty state), settings, and the
 * audit log. Every existing sync cursor is invalidated, forcing a full sync.
 *
 * Chats switched Off survive as the minimum needed to recognize them (SPEC:
 * Off chats keep only their identifier): the same id, the JID, whether the
 * JID is a group (derivable from the JID), and mode Off. Name, person,
 * context, aliases, rules, and timestamps are reset to their defaults, so
 * new events for these chats are still discarded after the wipe.
 */
export async function wipeAllData(database: Database): Promise<WipeResult> {
  return database.transaction(async ({ db }) => {
    // Take the truncate's locks (same tables, same order) before reading the Off
    // chats, so no mode change can slip in between the read and the truncate.
    await db.execute(sql`lock table ${WIPED_TABLES} in access exclusive mode`);
    const offChats = await db
      .select({ id: chats.id, jid: chats.jid, isGroup: chats.isGroup })
      .from(chats)
      .where(eq(chats.mode, "off"));
    await db.execute(sql`truncate table ${WIPED_TABLES} cascade`);
    await db.execute(sql`delete from app_state where key = 'task.calibration'`);
    await db.execute(sql`select pg_advisory_xact_lock_shared(${SYNC_LOCK})`);
    // Re-created after the truncate: every other chat field takes its default.
    if (offChats.length) await db.insert(chats).values(offChats.map((chat) => ({ ...chat, mode: "off" as const })));
    await db.execute(sql`update settings set sync_reset_version = nextval('sync_version_seq'), updated_at = now() where id = 1`);
    await seedDefaultContexts(db);
    return { keptOffChats: offChats.length };
  });
}
