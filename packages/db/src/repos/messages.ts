import type { MessageView } from "@wabrain/contracts";
import { and, asc, desc, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { notFound } from "../errors.js";
import { toMessageView, type MessageRow } from "../mappers.js";
import { messages, participants } from "../schema.js";

const viewColumns = { message: messages, participantName: participants.displayName };

function views(rows: { message: MessageRow; participantName: string | null }[]): MessageView[] {
  return rows.map(({ message, participantName }) => toMessageView(message, message.senderName ?? participantName));
}

export async function getMessageViews(db: Db, ids: string[]): Promise<MessageView[]> {
  if (!ids.length) return [];
  const rows = await db
    .select(viewColumns)
    .from(messages)
    .leftJoin(participants, eq(participants.id, messages.participantId))
    .where(inArray(messages.id, ids))
    .orderBy(asc(messages.sentAt), asc(messages.id));
  return views(rows);
}

/**
 * The conversation around a message, oldest first. Without `around`, returns
 * the latest `before` messages.
 */
export async function getMessagesAround(
  db: Db,
  chatId: string,
  options: { around?: string | null; before?: number; after?: number },
): Promise<MessageView[]> {
  const before = Math.min(Math.max(options.before ?? 20, 0), 100);
  const after = Math.min(Math.max(options.after ?? 20, 0), 100);
  const base = () =>
    db.select(viewColumns).from(messages).leftJoin(participants, eq(participants.id, messages.participantId));

  if (!options.around) {
    const rows = await base()
      .where(eq(messages.chatId, chatId))
      .orderBy(desc(messages.sentAt), desc(messages.id))
      .limit(before || 20);
    return views(rows.reverse());
  }

  const [anchor] = await db
    .select({ sentAt: messages.sentAt, id: messages.id })
    .from(messages)
    .where(and(eq(messages.id, options.around), eq(messages.chatId, chatId)));
  if (!anchor) throw notFound("Message");
  const at = anchor.sentAt;
  const older = await base()
    .where(
      and(
        eq(messages.chatId, chatId),
        or(lt(messages.sentAt, at), and(eq(messages.sentAt, at), lt(messages.id, anchor.id))),
      ),
    )
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(before);
  const newer = await base()
    .where(
      and(
        eq(messages.chatId, chatId),
        or(gt(messages.sentAt, at), and(eq(messages.sentAt, at), sql`${messages.id} >= ${anchor.id}`)),
      ),
    )
    .orderBy(asc(messages.sentAt), asc(messages.id))
    .limit(after + 1);
  return views([...older.reverse(), ...newer]);
}
