/**
 * Queries used by the processing pipeline (analysis, media, profiles, reminders). Kept here so the
 * worker never builds SQL itself.
 */
import { and, asc, desc, eq, gte, inArray, isNull, lt, lte, ne, notInArray, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { newId } from "../ids.js";
import type { MessageRow } from "../mappers.js";
import {
  chatPipelineState,
  chats,
  mediaObjects,
  messages,
  people,
  personFacts,
  pushEndpoints,
  reviewItems,
  sourceEvents,
  tasks,
} from "../schema.js";

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

/** Messages selected for analysis that no run has consumed yet, oldest first. */
export async function listUnanalyzedMessages(db: Db, chatId: string, limit: number): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), eq(messages.analyzable, true), isNull(messages.analysisRunId)))
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .limit(limit);
}

/** The latest `limit` messages at or before `until`, excluding `excludeIds`, oldest first. */
export async function listMessagesBefore(
  db: Db,
  chatId: string,
  until: Date,
  excludeIds: readonly string[],
  limit: number,
): Promise<MessageRow[]> {
  if (limit <= 0) return [];
  const rows = await db
    .select()
    .from(messages)
    .where(
      and(
        eq(messages.chatId, chatId),
        lte(messages.sentAt, until),
        excludeIds.length ? notInArray(messages.id, [...excludeIds]) : undefined,
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

export async function listMessagesByIds(db: Db, chatId: string, ids: readonly string[]): Promise<MessageRow[]> {
  if (!ids.length) return [];
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), inArray(messages.id, [...ids])));
}

/** Latest messages of a chat (any direction), oldest first. */
export async function listRecentMessages(db: Db, chatId: string, limit: number): Promise<MessageRow[]> {
  const rows = await db
    .select()
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(limit);
  return rows.reverse();
}

/** Media of these messages that is still waiting for (or in) processing. */
export async function countPendingMedia(db: Db, messageIds: readonly string[]): Promise<number> {
  if (!messageIds.length) return 0;
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mediaObjects)
    .where(and(inArray(mediaObjects.messageId, [...messageIds]), inArray(mediaObjects.status, ["pending", "processing"])));
  return row?.count ?? 0;
}

/** Marks messages as consumed by a run. Messages already consumed by another run are left alone. */
export async function markMessagesAnalyzed(db: Db, messageIds: readonly string[], runId: string): Promise<number> {
  if (!messageIds.length) return 0;
  const rows = await db
    .update(messages)
    .set({ analysisRunId: runId })
    .where(and(inArray(messages.id, [...messageIds]), isNull(messages.analysisRunId)))
    .returning({ id: messages.id });
  return rows.length;
}

/** Chats that have messages waiting for analysis since before `olderThan` (lost or deferred jobs). */
export async function listChatsWithStaleUnanalyzed(db: Db, olderThan: Date, limit = 100): Promise<string[]> {
  const rows = await db
    .selectDistinct({ chatId: messages.chatId })
    .from(messages)
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .where(
      and(
        eq(messages.analyzable, true),
        isNull(messages.analysisRunId),
        lt(messages.createdAt, olderThan),
        ne(chats.mode, "off"),
      ),
    )
    .limit(limit);
  return rows.map((row) => row.chatId);
}

export type ChatPipelineState = typeof chatPipelineState.$inferSelect;

export async function getChatPipelineState(db: Db, chatId: string): Promise<ChatPipelineState | null> {
  const [row] = await db.select().from(chatPipelineState).where(eq(chatPipelineState.chatId, chatId));
  return row ?? null;
}

export async function updateChatPipelineState(
  db: Db,
  chatId: string,
  patch: Partial<Omit<ChatPipelineState, "chatId" | "updatedAt">>,
): Promise<void> {
  await db
    .insert(chatPipelineState)
    .values({ chatId, ...patch })
    .onConflictDoUpdate({ target: chatPipelineState.chatId, set: { ...patch, updatedAt: sql`now()` } });
}

/**
 * Atomically claims the once-per-day profile slot for a chat. Returns false when the chat was already
 * profiled on `localDate`.
 */
export async function claimDailyProfile(db: Db, chatId: string, localDate: string, now: Date): Promise<boolean> {
  const rows = await db
    .insert(chatPipelineState)
    .values({ chatId, lastProfileDate: localDate, lastProfileAt: now })
    .onConflictDoUpdate({
      target: chatPipelineState.chatId,
      set: { lastProfileDate: localDate, lastProfileAt: now, updatedAt: sql`now()` },
      setWhere: sql`${chatPipelineState.lastProfileDate} is distinct from ${localDate}`,
    })
    .returning({ chatId: chatPipelineState.chatId });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Media
// ---------------------------------------------------------------------------

export type MediaObjectRow = typeof mediaObjects.$inferSelect;

export interface MediaJobContext {
  media: MediaObjectRow;
  message: MessageRow;
  chat: { id: string; jid: string; mode: "off" | "on" | "mentions_only"; personId: string | null };
  /** OpenWA session of the event that delivered the message. */
  sessionId: string | null;
  /** Raw webhook media metadata (untrusted), e.g. a duration in seconds when the engine sends one. */
  rawMedia: Record<string, unknown> | null;
}

export async function getMediaJobContext(db: Db, mediaObjectId: string): Promise<MediaJobContext | null> {
  const [row] = await db
    .select({
      media: mediaObjects,
      message: messages,
      chat: { id: chats.id, jid: chats.jid, mode: chats.mode, personId: chats.personId },
      sessionId: sourceEvents.sessionId,
      raw: sourceEvents.raw,
    })
    .from(mediaObjects)
    .innerJoin(messages, eq(messages.id, mediaObjects.messageId))
    .innerJoin(chats, eq(chats.id, messages.chatId))
    .leftJoin(sourceEvents, eq(sourceEvents.id, messages.sourceEventId))
    .where(eq(mediaObjects.id, mediaObjectId));
  if (!row) return null;
  const data = (row.raw as { data?: Record<string, unknown> } | null)?.data;
  const rawMedia = data && typeof data.media === "object" && data.media && !Array.isArray(data.media)
    ? { ...(data.media as Record<string, unknown>), ...(typeof data.duration === "number" ? { duration: data.duration } : {}) }
    : null;
  return { media: row.media, message: row.message, chat: row.chat, sessionId: row.sessionId ?? null, rawMedia };
}

/** Moves a media object to processing and counts the attempt. Returns null when it is already final. */
export async function claimMediaObject(db: Db, id: string): Promise<MediaObjectRow | null> {
  const [row] = await db
    .update(mediaObjects)
    .set({ status: "processing", attempts: sql`${mediaObjects.attempts} + 1`, updatedAt: sql`now()` })
    .where(and(eq(mediaObjects.id, id), inArray(mediaObjects.status, ["pending", "processing"])))
    .returning();
  return row ?? null;
}

/** Puts a media object back to pending after a transient failure (it will be retried). */
export async function releaseMediaObject(db: Db, id: string, error: string, options: { refundAttempt?: boolean } = {}): Promise<void> {
  await db
    .update(mediaObjects)
    .set({
      status: "pending",
      error: error.slice(0, 300),
      // A deferral (budget) is not a failed attempt.
      ...(options.refundAttempt ? { attempts: sql`greatest(${mediaObjects.attempts} - 1, 0)` } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(mediaObjects.id, id));
}

/** Final state without derived text: failed (with the reason) or skipped (not analyzable). */
export async function finishMediaObject(
  db: Db,
  id: string,
  status: "failed" | "skipped",
  reason: string,
  extra: { sizeBytes?: number | null; contentSha256?: string | null; rawDeleted?: boolean } = {},
): Promise<void> {
  await db
    .update(mediaObjects)
    .set({
      status,
      error: reason.slice(0, 300),
      ...(extra.sizeBytes != null ? { sizeBytes: extra.sizeBytes } : {}),
      ...(extra.contentSha256 ? { contentSha256: extra.contentSha256 } : {}),
      ...(extra.rawDeleted ? { rawDeletedAt: sql`now()` } : {}),
      updatedAt: sql`now()`,
    })
    .where(eq(mediaObjects.id, id));
}

/** A finished analysis of identical bytes, for content-hash dedupe. */
export async function findProcessedMediaByHash(db: Db, contentSha256: string, excludeId: string): Promise<MediaObjectRow | null> {
  const [row] = await db
    .select()
    .from(mediaObjects)
    .where(and(eq(mediaObjects.contentSha256, contentSha256), eq(mediaObjects.status, "done"), ne(mediaObjects.id, excludeId)))
    .limit(1);
  return row ?? null;
}

/**
 * Stores the derived text on the media object and its message in one transaction-friendly pair of
 * updates, and records that the raw bytes are gone (they only ever lived in memory).
 */
export async function completeMediaObject(
  db: Db,
  input: {
    id: string;
    messageId: string;
    derivedText: string;
    language: string | null;
    contentSha256: string;
    sizeBytes: number;
    durationSeconds?: number | null;
    /** Set the message's language when it has no text of its own. */
    setMessageLanguage: boolean;
  },
): Promise<void> {
  await db
    .update(mediaObjects)
    .set({
      status: "done",
      derivedText: input.derivedText,
      language: input.language,
      contentSha256: input.contentSha256,
      sizeBytes: input.sizeBytes,
      durationSeconds: input.durationSeconds ?? null,
      error: null,
      rawDeletedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(mediaObjects.id, input.id));
  await db
    .update(messages)
    .set({
      derivedText: input.derivedText,
      ...(input.setMessageLanguage && input.language ? { language: input.language } : {}),
    })
    .where(eq(messages.id, input.messageId));
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

/** Language tags of the messages a person wrote in a chat recently, most frequent first. */
export async function languageCounts(db: Db, chatId: string, since: Date): Promise<Array<{ language: string; count: number }>> {
  const rows = await db
    .select({ language: messages.language, count: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(eq(messages.chatId, chatId), eq(messages.fromOwner, false), gte(messages.sentAt, since), sql`${messages.language} is not null`),
    )
    .groupBy(messages.language)
    .orderBy(desc(sql`count(*)`));
  return rows.map((row) => ({ language: row.language!, count: row.count }));
}

export async function setPersonLanguages(db: Db, personId: string, languages: string[]): Promise<boolean> {
  const rows = await db
    .update(people)
    .set({ languages, updatedAt: sql`now()` })
    .where(and(eq(people.id, personId), sql`${people.languages} is distinct from ${sql.param(languages, people.languages)}`))
    .returning({ id: people.id });
  return rows.length > 0;
}

const SINGLE_VALUED_KEYS = new Set(["name", "company", "role", "relationship", "location"]);

export interface ProposedFactInput {
  key: (typeof personFacts.$inferInsert)["key"];
  value: string;
  confidence: number;
  selfClaimed: boolean;
  sourceMessageIds: string[];
  existingFactId: string | null;
}

/**
 * Applies AI-proposed facts. Owner-entered and verified facts are never modified; AI facts are never
 * marked verified here (self-claims stay unverified). A single-valued key (name, company, role,
 * relationship, location) keeps one AI fact, updated in place.
 */
export async function applyProposedFacts(db: Db, personId: string, facts: readonly ProposedFactInput[]): Promise<number> {
  let changed = 0;
  const existing = await db.select().from(personFacts).where(eq(personFacts.personId, personId));
  for (const fact of facts) {
    const target =
      (fact.existingFactId ? existing.find((row) => row.id === fact.existingFactId) : undefined) ??
      (SINGLE_VALUED_KEYS.has(fact.key) ? existing.find((row) => row.key === fact.key && row.source === "ai" && !row.verified) : undefined);
    if (target) {
      if (target.source !== "ai" || target.verified) continue;
      await db
        .update(personFacts)
        .set({
          value: fact.value,
          confidence: fact.confidence,
          selfClaimed: fact.selfClaimed,
          sourceMessageIds: fact.sourceMessageIds,
          updatedAt: sql`now()`,
        })
        .where(and(eq(personFacts.id, target.id), eq(personFacts.source, "ai"), eq(personFacts.verified, false)));
    } else {
      await db.insert(personFacts).values({
        id: newId(),
        personId,
        key: fact.key,
        value: fact.value,
        confidence: fact.confidence,
        verified: false,
        selfClaimed: fact.selfClaimed,
        source: "ai",
        sourceMessageIds: fact.sourceMessageIds,
      });
    }
    changed += 1;
  }
  return changed;
}

/** Sets a suggested default context on a chat that has none (the owner confirms it later). */
export async function suggestChatDefaultContext(db: Db, chatId: string, contextId: string): Promise<boolean> {
  const rows = await db
    .update(chats)
    .set({ defaultContextId: contextId, contextConfirmed: false, updatedAt: sql`now()` })
    .where(and(eq(chats.id, chatId), isNull(chats.defaultContextId)))
    .returning({ id: chats.id });
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Reminders and summary
// ---------------------------------------------------------------------------

/** Open tasks whose reminder time (dueAt - lead) has passed and whose due is not long past. */
export async function listTasksDueForReminder(
  db: Db,
  input: { now: Date; leadMinutes: number; graceMs: number; limit?: number },
) {
  const remindBefore = new Date(input.now.getTime() + input.leadMinutes * 60_000);
  const notBefore = new Date(input.now.getTime() - input.graceMs);
  return db
    .select({ id: tasks.id, title: tasks.title, dueAt: tasks.dueAt })
    .from(tasks)
    .where(and(eq(tasks.status, "open"), lte(tasks.dueAt, remindBefore), gte(tasks.dueAt, notBefore)))
    .orderBy(asc(tasks.dueAt))
    .limit(input.limit ?? 100);
}

export async function taskSummaryCounts(db: Db, input: { now: Date; dayEnd: Date }) {
  const [row] = await db
    .select({
      open: sql<number>`count(*)::int`,
      overdue: sql<number>`count(*) filter (where ${lt(tasks.dueAt, input.now)})::int`,
      dueToday: sql<number>`count(*) filter (where ${and(gte(tasks.dueAt, input.now), lt(tasks.dueAt, input.dayEnd))})::int`,
    })
    .from(tasks)
    .where(eq(tasks.status, "open"));
  const [review] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(reviewItems)
    .where(eq(reviewItems.state, "pending"));
  return { open: row?.open ?? 0, dueToday: row?.dueToday ?? 0, overdue: row?.overdue ?? 0, review: review?.count ?? 0 };
}

// ---------------------------------------------------------------------------
// Push delivery bookkeeping
// ---------------------------------------------------------------------------

export async function markPushDelivered(db: Db, endpointId: string): Promise<void> {
  await db
    .update(pushEndpoints)
    .set({ lastSuccessAt: sql`now()`, failureCount: 0 })
    .where(eq(pushEndpoints.id, endpointId));
}

export async function markPushFailed(db: Db, endpointId: string): Promise<void> {
  await db
    .update(pushEndpoints)
    .set({ lastFailureAt: sql`now()`, failureCount: sql`${pushEndpoints.failureCount} + 1` })
    .where(eq(pushEndpoints.id, endpointId));
}

/** Removes an endpoint the push service reported as gone (404/410). */
export async function removePushEndpoint(db: Db, endpointId: string): Promise<void> {
  await db.delete(pushEndpoints).where(eq(pushEndpoints.id, endpointId));
}

