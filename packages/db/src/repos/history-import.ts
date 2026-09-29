import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { chats, historyImportGaps, historyImportRuns, mediaObjects, messages, sourceEvents } from "../schema.js";

export type HistoryImportRun = typeof historyImportRuns.$inferSelect;

/** Start a new 90-day scan, or resume a cancelled/failed scan at its last committed cursor. */
export async function startHistoryImport(db: Db, sessionId: string, days: number, now: Date): Promise<HistoryImportRun> {
  const [created] = await db.insert(historyImportRuns).values({
    sessionId, status: "queued", days, cutoffAt: new Date(now.getTime() - days * 86_400_000), startedAt: now,
  }).onConflictDoNothing().returning();
  if (created) return created;
  const [existing] = await db.select().from(historyImportRuns).where(eq(historyImportRuns.sessionId, sessionId));
  if (existing!.status === "queued" || existing!.status === "running") return existing!;
  const resume = (existing!.status === "cancelled" || existing!.status === "failed") && existing!.days === days;
  const [row] = await db.update(historyImportRuns).set({
    status: "queued", days,
    generation: sql`${historyImportRuns.generation} + 1`,
    cutoffAt: resume ? existing!.cutoffAt : new Date(now.getTime() - days * 86_400_000),
    afterCursor: resume ? existing!.afterCursor : null,
    fetchedCount: resume ? existing!.fetchedCount : 0,
    totalEstimate: resume ? existing!.totalEstimate : null,
    cancelRequested: false, lastError: null, startedAt: now, finishedAt: null, updatedAt: now,
  }).where(and(eq(historyImportRuns.sessionId, sessionId), inArray(historyImportRuns.status, ["completed", "cancelled", "failed"]))).returning();
  if (row && !resume) await db.delete(historyImportGaps).where(eq(historyImportGaps.sessionId, sessionId));
  return row ?? (await getHistoryImport(db, sessionId))!;
}

export async function getHistoryImport(db: Db, sessionId: string): Promise<HistoryImportRun | null> {
  const [row] = await db.select().from(historyImportRuns).where(eq(historyImportRuns.sessionId, sessionId));
  return row ?? null;
}

export async function listUnfinishedHistoryImports(db: Db): Promise<string[]> {
  const rows = await db.select({ sessionId: historyImportRuns.sessionId }).from(historyImportRuns)
    .where(and(inArray(historyImportRuns.status, ["queued", "running"]), eq(historyImportRuns.cancelRequested, false)));
  return rows.map((row) => row.sessionId);
}

export async function cancelHistoryImport(db: Db, sessionId: string): Promise<HistoryImportRun | null> {
  const [row] = await db.update(historyImportRuns).set({ cancelRequested: true, status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(historyImportRuns.sessionId, sessionId), inArray(historyImportRuns.status, ["queued", "running"]))).returning();
  return row ?? getHistoryImport(db, sessionId);
}

export async function markHistoryImportRunning(db: Db, sessionId: string): Promise<HistoryImportRun | null> {
  const [row] = await db.update(historyImportRuns).set({ status: "running", updatedAt: new Date() })
    .where(and(eq(historyImportRuns.sessionId, sessionId), inArray(historyImportRuns.status, ["queued", "running"]), eq(historyImportRuns.cancelRequested, false))).returning();
  return row ?? null;
}

/** The cursor moves only after every row in a page has been projected or recorded as a gap. */
export async function checkpointHistoryImport(db: Db, sessionId: string, generation: number, afterCursor: string, fetched: number, total: number): Promise<boolean> {
  const [row] = await db.update(historyImportRuns).set({
    afterCursor, fetchedCount: sql`${historyImportRuns.fetchedCount} + ${fetched}`,
    totalEstimate: total, updatedAt: new Date(),
  }).where(and(eq(historyImportRuns.sessionId, sessionId), eq(historyImportRuns.generation, generation), eq(historyImportRuns.status, "running"), eq(historyImportRuns.cancelRequested, false)))
    .returning({ sessionId: historyImportRuns.sessionId });
  return Boolean(row);
}

export async function finishHistoryImport(db: Db, sessionId: string, generation: number): Promise<boolean> {
  const [row] = await db.update(historyImportRuns).set({ status: "completed", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(historyImportRuns.sessionId, sessionId), eq(historyImportRuns.generation, generation), eq(historyImportRuns.status, "running"), eq(historyImportRuns.cancelRequested, false)))
    .returning({ sessionId: historyImportRuns.sessionId });
  return Boolean(row);
}

export async function failHistoryImport(db: Db, sessionId: string, generation: number, reason: string): Promise<void> {
  await db.update(historyImportRuns).set({ status: "failed", lastError: reason.slice(0, 200), finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(historyImportRuns.sessionId, sessionId), eq(historyImportRuns.generation, generation), eq(historyImportRuns.status, "running")));
}

export async function recordHistoryImportGap(db: Db, sessionId: string, cursor: string, chatJid: string, reason: string): Promise<void> {
  await db.insert(historyImportGaps).values({ sessionId, cursor, chatJid, reason }).onConflictDoNothing();
}

export async function listHistoryChatIds(db: Db, sessionId: string): Promise<string[]> {
  const rows = await db.selectDistinct({ chatId: messages.chatId }).from(messages)
    .innerJoin(sourceEvents, eq(sourceEvents.id, messages.sourceEventId))
    .where(and(eq(messages.source, "history"), eq(sourceEvents.sessionId, sessionId)));
  return rows.map((row) => row.chatId);
}

export async function historyImportCoverage(db: Db, sessionId: string) {
  const [run, rows, gaps] = await Promise.all([
    getHistoryImport(db, sessionId),
    db.select({
      chatId: chats.jid, chatName: chats.name,
      earliestAt: sql<string>`min(${messages.sentAt})`,
      messageCount: sql<number>`count(${messages.id})::int`,
      mediaOk: sql<number>`count(${mediaObjects.id}) filter (where ${mediaObjects.status} = 'done')::int`,
      mediaFailed: sql<number>`count(${mediaObjects.id}) filter (where ${mediaObjects.status} = 'failed')::int`,
      mediaPending: sql<number>`count(${mediaObjects.id}) filter (where ${mediaObjects.status} in ('pending', 'processing'))::int`,
      mediaSkipped: sql<number>`count(${mediaObjects.id}) filter (where ${mediaObjects.status} = 'skipped')::int`,
    }).from(chats).innerJoin(messages, eq(messages.chatId, chats.id))
      .innerJoin(sourceEvents, eq(sourceEvents.id, messages.sourceEventId))
      .leftJoin(mediaObjects, eq(mediaObjects.messageId, messages.id))
      .where(eq(sourceEvents.sessionId, sessionId))
      .groupBy(chats.id).orderBy(asc(chats.jid)),
    db.select().from(historyImportGaps).where(eq(historyImportGaps.sessionId, sessionId)),
  ]);
  const items: Array<{ chatId: string; chatName: string | null; earliestAt: string | null; messageCount: number;
    mediaOk: number; mediaFailed: number; gaps: string[] }> = rows.map((row) => ({
      chatId: row.chatId, chatName: row.chatName, earliestAt: new Date(row.earliestAt).toISOString(),
      messageCount: row.messageCount, mediaOk: row.mediaOk, mediaFailed: row.mediaFailed,
      gaps: [
        ...(row.mediaPending ? [`media pending (${row.mediaPending})`] : []),
        ...(row.mediaSkipped ? [`media skipped (${row.mediaSkipped})`] : []),
        ...Object.entries(gaps.filter((gap) => gap.chatJid === row.chatId).reduce<Record<string, number>>((counts, gap) => {
          counts[gap.reason] = (counts[gap.reason] ?? 0) + 1;
          return counts;
        }, {})).map(([reason, count]) => `${reason} (${count})`),
      ],
    }));
  for (const chatJid of new Set(gaps.map((gap) => gap.chatJid))) {
    if (items.some((item) => item.chatId === chatJid)) continue;
    const counts = gaps.filter((gap) => gap.chatJid === chatJid).reduce<Record<string, number>>((result, gap) => {
      result[gap.reason] = (result[gap.reason] ?? 0) + 1;
      return result;
    }, {});
    items.push({ chatId: chatJid, chatName: null, earliestAt: null, messageCount: 0, mediaOk: 0, mediaFailed: 0,
      gaps: Object.entries(counts).map(([reason, count]) => `${reason} (${count})`) });
  }
  items.sort((a, b) => a.chatId.localeCompare(b.chatId));
  return {
    items,
    run: run ? {
      status: run.status, startedAt: run.startedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
      progress: run.status === "completed" ? 1 : run.totalEstimate ? Math.min(1, run.fetchedCount / run.totalEstimate) : null,
      error: run.lastError,
    } : null,
  };
}
