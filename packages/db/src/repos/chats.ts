import type { Chat, ChatMode } from "@wabrain/contracts";
import { and, desc, eq, ilike, or, sql, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../client.js";
import { notFound } from "../errors.js";
import { toChat, type ChatRow } from "../mappers.js";
import { clampLimit, decodeCursor, toPage, type Page, type PageRequest } from "../pagination.js";
import { chats, messageChunks, messages, participants, personFacts, sourceEvents, taskEvents, tasks } from "../schema.js";

export const likePattern = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;

const lastAt = sql`coalesce(${chats.lastMessageAt}, 'epoch'::timestamptz)`;

export async function listChats(
  db: Db,
  filter: { q?: string | null; mode?: ChatMode | null } & PageRequest = {},
): Promise<Page<Chat>> {
  const limit = clampLimit(filter.limit);
  const where: SQL[] = [];
  if (filter.q) where.push(or(ilike(chats.name, likePattern(filter.q)), ilike(chats.jid, likePattern(filter.q)))!);
  if (filter.mode) where.push(eq(chats.mode, filter.mode));
  if (filter.cursor) {
    const [at, id] = decodeCursor(filter.cursor, 2);
    where.push(sql`(${lastAt}, ${chats.id}) < (${String(at)}::timestamptz, ${String(id)})`);
  }
  const rows = await db
    .select()
    .from(chats)
    .where(and(...where))
    .orderBy(desc(lastAt), desc(chats.id))
    .limit(limit + 1);
  return toPage(rows, limit, toChat, (row) => [(row.lastMessageAt ?? new Date(0)).toISOString(), row.id]);
}

export async function getChatRow(db: Db, id: string): Promise<ChatRow> {
  const [row] = await db.select().from(chats).where(eq(chats.id, id));
  if (!row) throw notFound("Chat");
  return row;
}

export async function getChat(db: Db, id: string): Promise<Chat> {
  return toChat(await getChatRow(db, id));
}

export async function findChatByJid(db: Db, jid: string): Promise<ChatRow | null> {
  const [row] = await db.select().from(chats).where(eq(chats.jid, jid));
  return row ?? null;
}

export type ChatPatch = Partial<
  Pick<Chat, "mode" | "defaultContextId" | "contextConfirmed" | "autoCreate" | "minimumAutoConfidence" | "aliases">
>;

export async function updateChat(db: Db, id: string, patch: ChatPatch): Promise<Chat> {
  const [row] = await db
    .update(chats)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(chats.id, id))
    .returning();
  if (!row) throw notFound("Chat");
  return toChat(row);
}

/** Removes `messageIds` from every evidence/source array that references them. */
async function scrubMessageReferences(db: Db, chatId: string): Promise<void> {
  const ids = sql`array(select ${messages.id} from ${messages} where ${messages.chatId} = ${chatId})`;
  const scrub = (column: AnyPgColumn) =>
    sql`coalesce(array(select e from unnest(${column}) as e where e <> all(${ids})), '{}'::text[])`;
  await db
    .update(tasks)
    .set({ evidenceMessageIds: scrub(tasks.evidenceMessageIds), updatedAt: sql`now()` })
    .where(sql`${tasks.evidenceMessageIds} && ${ids}`);
  await db
    .update(taskEvents)
    .set({ evidenceMessageIds: scrub(taskEvents.evidenceMessageIds) })
    .where(sql`${taskEvents.evidenceMessageIds} && ${ids}`);
  await db
    .update(personFacts)
    .set({ sourceMessageIds: scrub(personFacts.sourceMessageIds) })
    .where(sql`${personFacts.sourceMessageIds} && ${ids}`);
}

/**
 * Deletes a chat's messages, media, derived text, embeddings, raw events, and
 * participants. Call it inside a transaction so the chat row lock lasts until commit. The chat row (with its rule) and its tasks remain; the tasks
 * lose their evidence links.
 */
export async function purgeChatData(db: Db, chatId: string): Promise<void> {
  // Row lock: the embed-chat job writes chunks under FOR SHARE, so it never interleaves with a purge.
  const [chat] = await db.select({ jid: chats.jid }).from(chats).where(eq(chats.id, chatId)).for("update");
  if (!chat) throw notFound("Chat");
  await scrubMessageReferences(db, chatId);
  await db.delete(messageChunks).where(eq(messageChunks.chatId, chatId));
  await db.delete(messages).where(eq(messages.chatId, chatId));
  await db.delete(sourceEvents).where(eq(sourceEvents.chatJid, chat.jid));
  await db.delete(participants).where(eq(participants.chatId, chatId));
}
