import {
  checkpointHistoryImport,
  failHistoryImport,
  finishHistoryImport,
  getHistoryImport,
  insertSourceEvent,
  listHistoryChatIds,
  markHistoryImportRunning,
  projectSourceEvent,
  recordHistoryImportGap,
  requestProfileCatchUp,
  shouldStoreIncoming,
  type Database,
  type IntakeFilter,
} from "@wabrain/db";
import { historyEnvelope } from "@wabrain/openwa-adapter";
import type { HistorySource } from "./pipeline/deps.js";
import type { JobLogger, JobQueue } from "./queue.js";

const PAGE_SIZE = 100;

export interface HistoryImportDeps {
  database: Database;
  queue: JobQueue;
  filter: IntakeFilter;
  source: HistorySource;
  logger: JobLogger;
  /** Test seam; OpenWA accepts at most 100 rows per page. */
  pageSize?: number;
}

/**
 * Imports context only. The normal rules filter leaves history unanalyzable, so
 * no historical message can create a task or Review proposal.
 * A page cursor is committed only after every message in that page is safe to replay.
 */
export async function runHistoryImport(deps: HistoryImportDeps, sessionId: string): Promise<"completed" | "cancelled" | "failed" | "missing"> {
  const { database, queue, filter, source } = deps;
  const run = await markHistoryImportRunning(database.db, sessionId);
  if (!run) return (await getHistoryImport(database.db, sessionId))?.status === "cancelled" ? "cancelled" : "missing";
  let after = run.afterCursor ?? undefined;
  const scheduler = {
    debounceAnalysis: (chatId: string) => queue.debounceChat(chatId),
    enqueueMedia: async (mediaObjectId: string) => { await queue.enqueue("process-media", { mediaObjectId }, { singletonKey: mediaObjectId }); },
  };

  try {
    for (;;) {
      const current = await getHistoryImport(database.db, sessionId);
      if (!current || current.cancelRequested || current.generation !== run.generation) return "cancelled";
      const pageSize = deps.pageSize ?? PAGE_SIZE;
      const page = await source.listStoredMessages(sessionId, { limit: pageSize, after });
      const afterFetch = await getHistoryImport(database.db, sessionId);
      if (!afterFetch || afterFetch.cancelRequested || afterFetch.generation !== run.generation) return "cancelled";
      if (page.messages.length === 0) break;
      let lastCursor: string | null = null;
      let reachedCutoff = false;
      for (const [index, row] of page.messages.entries()) {
        if (index % 10 === 0) {
          const latest = await getHistoryImport(database.db, sessionId);
          if (!latest || latest.cancelRequested || latest.generation !== run.generation) return "cancelled";
        }
        const raw = row && typeof row === "object" && !Array.isArray(row) ? row as Record<string, unknown> : null;
        const cursor = typeof raw?.id === "string" && raw.id ? raw.id : null;
        if (!cursor) throw new Error("OpenWA returned a stored message without a paging id");
        lastCursor = cursor;
        let item;
        try {
          item = historyEnvelope(row, sessionId);
        } catch {
          item = null;
        }
        if (!item) {
          await recordHistoryImportGap(database.db, sessionId, cursor, typeof raw?.chatId === "string" ? raw.chatId : "unknown", "invalid_message");
          continue;
        }
        if (new Date(item.message.timestamp * 1000) < run.cutoffAt) {
          reachedCutoff = true;
          continue;
        }
        if (!(await shouldStoreIncoming(database.db, filter, item.message))) continue;
        const event = await insertSourceEvent(database.db, {
          sessionId,
          idempotencyKey: item.envelope.idempotencyKey,
          deliveryId: item.envelope.deliveryId,
          eventType: "history.message",
          chatJid: item.message.chatId,
          raw: item.envelope,
        });
        await projectSourceEvent({ database, filter, scheduler }, event.id);
      }
      if (lastCursor === after) throw new Error("OpenWA history cursor did not advance");
      if (!(await checkpointHistoryImport(database.db, sessionId, run.generation, lastCursor!, page.messages.length, page.total))) return "cancelled";
      after = lastCursor!;
      if (reachedCutoff || page.messages.length < pageSize) break;
    }
    const beforeFinish = await getHistoryImport(database.db, sessionId);
    if (!beforeFinish || beforeFinish.cancelRequested || beforeFinish.generation !== run.generation) return "cancelled";
    // Profile every imported message, not only the latest ones: a catch-up target makes profile-chat
    // read the whole chat in batches. Without a text provider (or budget) now, profile-sweep picks
    // the pending catch-up up later.
    for (const chatId of await listHistoryChatIds(database.db, sessionId)) {
      if (await requestProfileCatchUp(database.db, chatId)) await queue.enqueue("profile-chat", { chatId }, { singletonKey: chatId });
    }
    if (!(await finishHistoryImport(database.db, sessionId, run.generation))) return "cancelled";
    // Imported senders arrived with WhatsApp names; apply the owner's saved ones.
    await queue.enqueue("sync-contacts", { sessionId }, { singletonKey: "sync-contacts" });
    deps.logger.info("history import completed", { sessionId });
    return "completed";
  } catch (error) {
    const reason = error instanceof Error ? error.message : "unknown_error";
    await failHistoryImport(database.db, sessionId, run.generation, reason);
    deps.logger.warn("history import failed", { sessionId, reason });
    return "failed";
  }
}
