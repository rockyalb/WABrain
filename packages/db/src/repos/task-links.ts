/**
 * Task links (TaskLink): another chat a task involves, so that chat can close it. The pipeline resolves
 * names to chats (rules' resolveTaskLinks) from listLinkableChats; analysis of a linked chat reads the
 * tasks and pending creates linked to it.
 */
import type { ReviewItem, Task } from "@wabrain/contracts";
import { and, asc, desc, eq, ne, or, isNull, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { toReviewItem, toTask } from "../mappers.js";
import { chats, contactNames, people, reviewItems, tasks } from "../schema.js";

/** A chat as the link matcher sees it (structurally the rules' LinkableChat). */
export interface LinkableChatRow {
  id: string;
  isGroup: boolean;
  name: string;
  names: string[];
  lastMessageAt: Date | null;
}

const linkedTo = (column: unknown, chatId: string) => sql`${column} @> ${JSON.stringify([{ chatId }])}::jsonb`;

/**
 * Every chat a task may link to: not Off (Off chats are never analyzed, so they could never close it),
 * with all the names it is known by, most recently active first.
 */
export async function listLinkableChats(db: Db): Promise<LinkableChatRow[]> {
  const rows = await db
    .select({
      id: chats.id,
      isGroup: chats.isGroup,
      chatName: chats.name,
      personName: people.displayName,
      savedName: contactNames.name,
      lastMessageAt: chats.lastMessageAt,
    })
    .from(chats)
    .leftJoin(people, eq(people.id, chats.personId))
    .leftJoin(contactNames, eq(contactNames.jid, chats.jid))
    .where(ne(chats.mode, "off"))
    .orderBy(sql`${chats.lastMessageAt} desc nulls last`, asc(chats.id));
  return rows.flatMap((row) => {
    const names = [...new Set([row.savedName, row.personName, row.chatName].map((name) => name?.trim()).filter((name): name is string => Boolean(name)))];
    if (names.length === 0) return [];
    return [{ id: row.id, isGroup: row.isGroup, name: names[0]!, names, lastMessageAt: row.lastMessageAt }];
  });
}

/** Open tasks of other chats with a confirmed link to this chat, oldest first. */
export async function listLinkedOpenTasks(db: Db, chatId: string): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, "open"), linkedTo(tasks.links, chatId), or(isNull(tasks.chatId), ne(tasks.chatId, chatId))))
    .orderBy(asc(tasks.createdAt))
    .limit(20);
  return rows.map(toTask);
}

/** Creates of other chats still waiting in Review whose proposal links to this chat, oldest first. */
export async function listLinkedPendingCreates(db: Db, chatId: string): Promise<ReviewItem[]> {
  const rows = await db
    .select()
    .from(reviewItems)
    .where(
      and(
        eq(reviewItems.state, "pending"),
        eq(reviewItems.type, "create"),
        linkedTo(sql`${reviewItems.action}->'links'`, chatId),
        or(isNull(reviewItems.chatId), ne(reviewItems.chatId, chatId)),
      ),
    )
    .orderBy(asc(reviewItems.createdAt))
    .limit(20);
  return rows.map(toReviewItem);
}

/** True while an open task or a pending create of another chat is linked to this chat. */
export async function hasOpenLinks(db: Db, chatId: string): Promise<boolean> {
  const [task] = await db
    .select({ id: tasks.id })
    .from(tasks)
    .where(and(eq(tasks.status, "open"), linkedTo(tasks.links, chatId)))
    .limit(1);
  if (task) return true;
  const [item] = await db
    .select({ id: reviewItems.id })
    .from(reviewItems)
    .where(and(eq(reviewItems.state, "pending"), eq(reviewItems.type, "create"), linkedTo(sql`${reviewItems.action}->'links'`, chatId)))
    .orderBy(desc(reviewItems.createdAt))
    .limit(1);
  return Boolean(item);
}
