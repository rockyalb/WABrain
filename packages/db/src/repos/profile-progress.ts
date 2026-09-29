/**
 * Checkpointed person profiling (profile-chat job). Every message of a direct chat is read by the
 * profile extraction exactly once in batches, in the order it was stored (`created_at`, then id), so
 * imported history — stored after newer live messages — is covered too.
 *
 * - `profile_cursor_*`: the last message a successful extraction consumed.
 * - `profile_target_*`: set while a catch-up is running (after a history import, or when a daily run
 *   finds more than one batch). Until the cursor reaches it, batches continue without the
 *   once-per-day limit.
 * - `last_profile_date`: recorded only after a successful extraction, so a failed model call can be
 *   retried the same day.
 */
import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import type { MessageRow } from "../mappers.js";
import { chatPipelineState, chats, mediaObjects, messages } from "../schema.js";

/** A position in a chat's messages in storage order. */
export interface ProfileMessageKey {
  createdAt: Date;
  messageId: string;
}

export interface ProfileProgress {
  cursor: ProfileMessageKey | null;
  target: ProfileMessageKey | null;
  lastProfileDate: string | null;
}

const key = (createdAt: Date | null, messageId: string | null): ProfileMessageKey | null =>
  createdAt && messageId ? { createdAt, messageId } : null;

const after = (position: ProfileMessageKey | null) =>
  position
    ? sql`(${messages.createdAt}, ${messages.id}) > (${position.createdAt.toISOString()}::timestamptz, ${position.messageId})`
    : undefined;

export async function getProfileProgress(db: Db, chatId: string): Promise<ProfileProgress> {
  const [row] = await db
    .select({
      cursorAt: chatPipelineState.profileCursorCreatedAt,
      cursorId: chatPipelineState.profileCursorMessageId,
      targetAt: chatPipelineState.profileTargetCreatedAt,
      targetId: chatPipelineState.profileTargetMessageId,
      lastProfileDate: chatPipelineState.lastProfileDate,
    })
    .from(chatPipelineState)
    .where(eq(chatPipelineState.chatId, chatId));
  return {
    cursor: key(row?.cursorAt ?? null, row?.cursorId ?? null),
    target: key(row?.targetAt ?? null, row?.targetId ?? null),
    lastProfileDate: row?.lastProfileDate ?? null,
  };
}

/** The next messages after `cursor` in storage order (at most `limit`). */
export async function listProfileBatch(db: Db, chatId: string, cursor: ProfileMessageKey | null, limit: number): Promise<MessageRow[]> {
  return db
    .select()
    .from(messages)
    .where(and(eq(messages.chatId, chatId), after(cursor)))
    .orderBy(asc(messages.createdAt), asc(messages.id))
    .limit(limit);
}

/** The chat's last message in storage order, or null when it has none. */
export async function latestProfileKey(db: Db, chatId: string): Promise<ProfileMessageKey | null> {
  const [row] = await db
    .select({ createdAt: messages.createdAt, messageId: messages.id })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(desc(messages.createdAt), desc(messages.id))
    .limit(1);
  return row ?? null;
}

const atOrBefore = (position: ProfileMessageKey) =>
  sql`(${messages.createdAt}, ${messages.id}) <= (${position.createdAt.toISOString()}::timestamptz, ${position.messageId})`;

/** True when the chat has messages after `cursor` (and at or before `upTo`, when given). */
export async function hasProfileBacklog(db: Db, chatId: string, cursor: ProfileMessageKey | null, upTo: ProfileMessageKey | null = null): Promise<boolean> {
  const [row] = await db
    .select({ id: messages.id })
    .from(messages)
    .where(and(eq(messages.chatId, chatId), after(cursor), upTo ? atOrBefore(upTo) : undefined))
    .limit(1);
  return Boolean(row);
}

/**
 * Asks for a catch-up over every message stored so far (a history import finished): moves the target
 * to the chat's last message when the profile has not read it yet. Only direct chats with a person
 * (not Off) are profiled. Idempotent. Returns whether a catch-up is pending.
 */
export async function requestProfileCatchUp(db: Db, chatId: string): Promise<boolean> {
  const [chat] = await db.select({ mode: chats.mode, isGroup: chats.isGroup, personId: chats.personId }).from(chats).where(eq(chats.id, chatId));
  if (!chat || chat.mode === "off" || chat.isGroup || !chat.personId) return false;
  const current = await getProfileProgress(db, chatId);
  if (!(await hasProfileBacklog(db, chatId, current.cursor))) return false;
  const latest = await latestProfileKey(db, chatId);
  if (!latest) return false;
  await db
    .insert(chatPipelineState)
    .values({ chatId, profileTargetCreatedAt: latest.createdAt, profileTargetMessageId: latest.messageId })
    .onConflictDoUpdate({
      target: chatPipelineState.chatId,
      set: { profileTargetCreatedAt: latest.createdAt, profileTargetMessageId: latest.messageId, updatedAt: sql`now()` },
    });
  return true;
}

/**
 * Records a successful extraction: the new cursor (unchanged when null), the target (null clears it),
 * and the local day of the run.
 */
export async function saveProfileProgress(
  db: Db,
  chatId: string,
  progress: { cursor: ProfileMessageKey | null; target: ProfileMessageKey | null; localDate: string; at: Date },
): Promise<void> {
  const patch = {
    ...(progress.cursor
      ? { profileCursorCreatedAt: progress.cursor.createdAt, profileCursorMessageId: progress.cursor.messageId }
      : {}),
    profileTargetCreatedAt: progress.target?.createdAt ?? null,
    profileTargetMessageId: progress.target?.messageId ?? null,
    lastProfileDate: progress.localDate,
    lastProfileAt: progress.at,
  };
  await db
    .insert(chatPipelineState)
    .values({ chatId, ...patch })
    .onConflictDoUpdate({ target: chatPipelineState.chatId, set: { ...patch, updatedAt: sql`now()` } });
}

/** Clears a finished (or no longer reachable) catch-up target. */
export async function clearProfileTarget(db: Db, chatId: string): Promise<void> {
  await db
    .update(chatPipelineState)
    .set({ profileTargetCreatedAt: null, profileTargetMessageId: null, updatedAt: sql`now()` })
    .where(eq(chatPipelineState.chatId, chatId));
}

/**
 * Direct chats with a person (not Off) that have messages the profile has not read yet and may run
 * now: a catch-up is pending, or the chat was not profiled on `localDate`. For the periodic sweep
 * that recovers deferred runs (no provider, budget, failures) and imported history.
 */
export async function listChatsNeedingProfile(
  db: Db,
  options: { localDate: string; limit?: number; batchSize?: number; /** False leaves out chats in a catch-up. Default true. */ includeCatchUp?: boolean },
): Promise<string[]> {
  const eligible =
    options.includeCatchUp === false
      ? sql`(${chatPipelineState.profileTargetMessageId} is null and ${chatPipelineState.lastProfileDate} is distinct from ${options.localDate})`
      : sql`(${chatPipelineState.profileTargetMessageId} is not null or ${chatPipelineState.lastProfileDate} is distinct from ${options.localDate})`;
  const rows = await db
    .select({ id: chats.id })
    .from(chats)
    .leftJoin(chatPipelineState, eq(chatPipelineState.chatId, chats.id))
    .where(
      and(
        sql`${chats.mode} <> 'off'`,
        eq(chats.isGroup, false),
        sql`${chats.personId} is not null`,
        eligible,
        sql`exists (
          select 1 from ${messages} m
          where m.chat_id = ${chats.id}
            and (${chatPipelineState.profileCursorMessageId} is null
              or (m.created_at, m.id) > (${chatPipelineState.profileCursorCreatedAt}, ${chatPipelineState.profileCursorMessageId}))
        )`,
        // Media-blocked chats must not monopolize the bounded sweep ahead of ready chats.
        // Check only the next batch so ready prefixes can still make progress.
        sql`not exists (
          select 1 from (
            select m.id from ${messages} m
            where m.chat_id = ${chats.id}
              and (${chatPipelineState.profileCursorMessageId} is null
                or (m.created_at, m.id) > (${chatPipelineState.profileCursorCreatedAt}, ${chatPipelineState.profileCursorMessageId}))
            order by m.created_at, m.id
            limit ${options.batchSize ?? 40}
          ) batch
          join ${mediaObjects} media on media.message_id = batch.id
          where media.status in ('pending', 'processing')
        )`,
      ),
    )
    .orderBy(sql`${chatPipelineState.profileTargetMessageId} is null`, asc(chats.id))
    .limit(options.limit ?? 50);
  return rows.map((row) => row.id);
}
