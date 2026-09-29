/**
 * Intake: the webhook-side decision whether to store an event at all, and the
 * projector that turns a stored source event into chats, people,
 * participants, messages, and media rows.
 *
 * Skip filters and chat-mode evaluation are injectable (`IntakeFilter`) so the
 * rules package can replace the conservative default below.
 */
import type { Chat, NormalizedMessage } from "@wabrain/contracts";
import { normalizeOpenWaWebhook } from "@wabrain/openwa-adapter";
import { and, eq, sql } from "drizzle-orm";
import type { Database, Db } from "../client.js";
import { newId } from "../ids.js";
import { detectLanguage } from "../language.js";
import { toChat, type ChatRow } from "../mappers.js";
import { findChatByJid } from "../repos/chats.js";
import { savedContactNames, unsavedName } from "../repos/contact-names.js";
import { deleteSourceEvent, getSourceEvent, markProjected } from "../repos/source-events.js";
import { chats, mediaObjects, messages, participants, people } from "../schema.js";

export interface IntakeFilter {
  /**
   * False discards the message before anything is stored, including the raw
   * event. `chat` is null for a chat seen for the first time.
   */
  shouldStore(message: NormalizedMessage, chat: Chat | null): boolean;
  /**
   * True selects the message for task analysis (and restarts the chat's analysis debounce); false keeps
   * it as context only. Called only for stored messages. `context.quotesOwner` is true when the message
   * replies to one of the owner's stored messages.
   */
  shouldAnalyze(message: NormalizedMessage, chat: Chat, context?: { quotesOwner?: boolean }): boolean;
}

/** Strips the device suffix and server: "447691234567:12@s.whatsapp.net" → "447691234567". */
export function jidUser(jid: string): string {
  return jid.split("@")[0]!.split(":")[0]!;
}

function hasWord(text: string, word: string): boolean {
  const escaped = word.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (!escaped) return false;
  return new RegExp(`(^|[^\\p{L}\\p{N}_])${escaped}(?=$|[^\\p{L}\\p{N}_])`, "iu").test(text);
}

/**
 * Conservative default until packages/rules provides the real filters:
 * stores everything except Off chats, status updates, and view-once media;
 * analyzes "on" chats, and "mentions_only" chats when the owner is mentioned
 * or an alias appears as a whole word.
 */
export function createDefaultIntakeFilter(options: { selfJids?: string[]; aliases?: string[] } = {}): IntakeFilter {
  const selfUsers = new Set((options.selfJids ?? []).map(jidUser));
  const globalAliases = options.aliases ?? [];
  return {
    shouldStore(message, chat) {
      if (message.chatId === "status@broadcast") return false;
      if (message.isViewOnce) return false;
      return chat?.mode !== "off";
    },
    shouldAnalyze(message, chat) {
      if (chat.mode === "on") return true;
      if (chat.mode === "off") return false;
      if (message.mentions.some((jid) => selfUsers.has(jidUser(jid)))) return true;
      const text = `${message.body}\n${message.derivedText ?? ""}`;
      return [...globalAliases, ...chat.aliases].some((alias) => hasWord(text, alias));
    },
  };
}

export interface IntakeScheduler {
  /** Restart the chat's quiet-period timer for analysis. */
  debounceAnalysis(chatId: string): Promise<void>;
  enqueueMedia(mediaObjectId: string): Promise<void>;
}

export interface ProjectorDeps {
  database: Database;
  filter: IntakeFilter;
  scheduler: IntakeScheduler;
}

export type ProjectionResult =
  | { status: "missing" | "already_projected" | "invalid" | "skipped" }
  | { status: "stored" | "duplicate"; chatId: string; messageId: string };

/** Webhook-side check: may this message be stored at all? */
export async function shouldStoreIncoming(
  db: Db,
  filter: IntakeFilter,
  message: NormalizedMessage,
): Promise<boolean> {
  const chat = await findChatByJid(db, message.chatId);
  return filter.shouldStore(message, chat ? toChat(chat) : null);
}

const MEDIA_TO_PROCESS = new Set(["image", "voice", "audio", "document"]);

function phoneLabel(jid: string): string {
  const user = jidUser(jid);
  return /^\d{6,}$/.test(user) ? `+${user}` : user;
}

/**
 * The names this message should be stored under: the owner's saved contact name for the sender and,
 * in a direct chat, for the chat; otherwise the sender's WhatsApp name marked "~Ana". Group names
 * are the group's own subject and stay as they are.
 */
async function withContactNames(db: Db, message: NormalizedMessage): Promise<NormalizedMessage> {
  const incoming = message.direction === "incoming";
  const saved = await savedContactNames(db, message.isGroup ? [message.senderId] : [message.senderId, message.chatId]);
  const savedSender = saved.get(message.senderId) ?? message.senderSavedName ?? null;
  const senderName = incoming ? (savedSender ?? unsavedName(message.senderName)) : message.senderName;
  const chatName = message.isGroup
    ? message.chatName
    : (saved.get(message.chatId) ??
      (incoming ? savedSender : null) ??
      unsavedName(message.chatName ?? (incoming ? message.senderName : null)));
  return { ...message, senderName: senderName ?? null, chatName: chatName ?? null };
}

async function upsertChat(db: Db, message: NormalizedMessage, sentAt: Date): Promise<ChatRow> {
  const name = message.chatName ?? (!message.isGroup && message.direction === "incoming" ? message.senderName : null) ?? null;
  const [row] = await db
    .insert(chats)
    .values({
      id: newId(),
      jid: message.chatId,
      name,
      isGroup: message.isGroup,
      mode: message.isGroup ? "mentions_only" : "on",
      lastMessageAt: sentAt,
    })
    .onConflictDoUpdate({
      target: chats.jid,
      set: {
        name: sql`coalesce(excluded.name, ${chats.name})`,
        lastMessageAt: sql`greatest(${chats.lastMessageAt}, excluded.last_message_at)`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row!;
}

async function upsertDirectPerson(db: Db, chat: ChatRow, message: NormalizedMessage): Promise<string> {
  const realName = chat.name ?? (message.direction === "incoming" ? message.senderName : null) ?? null;
  await db
    .insert(people)
    .values({
      id: newId(),
      displayName: realName ?? phoneLabel(chat.jid),
      primaryJid: chat.jid,
      jids: [chat.jid],
    })
    .onConflictDoUpdate({
      target: people.primaryJid,
      set: { displayName: sql`excluded.display_name`, updatedAt: sql`now()` },
      setWhere: realName
        ? sql`${people.displayNameSource} = 'auto' and ${people.displayName} is distinct from excluded.display_name`
        : sql`false`,
    });
  const [person] = await db.select({ id: people.id }).from(people).where(eq(people.primaryJid, chat.jid));
  if (chat.personId !== person!.id) {
    await db.update(chats).set({ personId: person!.id, updatedAt: sql`now()` }).where(eq(chats.id, chat.id));
  }
  return person!.id;
}

async function upsertParticipant(
  db: Db,
  chatId: string,
  message: NormalizedMessage,
  personId: string | null,
  sentAt: Date,
): Promise<string> {
  let resolvedPerson = personId;
  if (!resolvedPerson) {
    const [match] = await db
      .select({ id: people.id })
      .from(people)
      .where(sql`${message.senderId} = any(${people.jids})`)
      .limit(1);
    resolvedPerson = match?.id ?? null;
  }
  const [row] = await db
    .insert(participants)
    .values({
      id: newId(),
      chatId,
      jid: message.senderId,
      displayName: message.senderName ?? null,
      personId: resolvedPerson,
      lastSeenAt: sentAt,
    })
    .onConflictDoUpdate({
      target: [participants.chatId, participants.jid],
      set: {
        displayName: sql`coalesce(excluded.display_name, ${participants.displayName})`,
        personId: sql`coalesce(${participants.personId}, excluded.person_id)`,
        lastSeenAt: sql`greatest(${participants.lastSeenAt}, excluded.last_seen_at)`,
      },
    })
    .returning({ id: participants.id });
  return row!.id;
}

/**
 * Projects one source event. Idempotent: safe to retry at any point. The
 * event is marked projected only after analysis/media scheduling succeeded.
 */
export async function projectSourceEvent(deps: ProjectorDeps, sourceEventId: string): Promise<ProjectionResult> {
  const { database, filter, scheduler } = deps;
  const event = await getSourceEvent(database.db, sourceEventId);
  if (!event) return { status: "missing" };
  if (event.projectedAt) return { status: "already_projected" };

  let message: NormalizedMessage;
  try {
    const normalized = normalizeOpenWaWebhook(event.raw);
    message = event.eventType === "history.message" ? { ...normalized, source: "history" } : normalized;
  } catch {
    await markProjected(database.db, event.id, "invalid_payload");
    return { status: "invalid" };
  }
  const sentAt = new Date(message.timestamp * 1000);

  const projected = await database.transaction(async ({ db }) => {
    message = await withContactNames(db, message);
    const existingChat = await findChatByJid(db, message.chatId);
    if (!filter.shouldStore(message, existingChat ? toChat(existingChat) : null)) {
      // Off chats, status updates, view-once, one-time codes: keep nothing.
      await deleteSourceEvent(db, event.id);
      return null;
    }
    const chat = await upsertChat(db, message, sentAt);
    const personId = chat.isGroup ? null : await upsertDirectPerson(db, chat, message);
    const participantId =
      message.direction === "incoming" ? await upsertParticipant(db, chat.id, message, personId, sentAt) : null;

    let quotedMessageId: string | null = null;
    let quotesOwner = false;
    if (message.quotedMessageId) {
      const [quoted] = await db
        .select({ id: messages.id, fromOwner: messages.fromOwner })
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.waMessageId, message.quotedMessageId)));
      quotedMessageId = quoted?.id ?? null;
      quotesOwner = quoted?.fromOwner ?? false;
    }
    const analyzable = filter.shouldAnalyze(message, toChat(chat), { quotesOwner });

    const [inserted] = await db
      .insert(messages)
      .values({
        id: newId(),
        chatId: chat.id,
        waMessageId: message.id,
        sourceEventId: event.id,
        participantId,
        senderJid: message.senderId,
        senderName: message.direction === "incoming" ? (message.senderName ?? null) : null,
        direction: message.direction,
        fromOwner: message.direction === "outgoing",
        kind: message.kind,
        body: message.body,
        derivedText: message.derivedText ?? null,
        language: message.language ?? detectLanguage(message.body),
        quotedWaMessageId: message.quotedMessageId ?? null,
        quotedMessageId,
        mentions: message.mentions,
        hasMedia: message.hasMedia,
        source: message.source,
        analyzable,
        sentAt,
      })
      .onConflictDoNothing({ target: [messages.chatId, messages.waMessageId] })
      .returning({ id: messages.id });

    let messageId = inserted?.id;
    let duplicate = false;
    if (!messageId) {
      const [existing] = await db
        .select({ id: messages.id, sourceEventId: messages.sourceEventId })
        .from(messages)
        .where(and(eq(messages.chatId, chat.id), eq(messages.waMessageId, message.id)));
      messageId = existing!.id;
      // A retry of this same event continues; a different delivery of the same message is a duplicate.
      duplicate = existing!.sourceEventId !== event.id;
    }

    let mediaObjectId: string | null = null;
    if (!duplicate && message.hasMedia) {
      const [media] = await db
        .insert(mediaObjects)
        .values({
          id: newId(),
          messageId,
          kind: message.kind,
          mimetype: message.media?.mimetype ?? null,
          filename: message.media?.filename ?? null,
          sizeBytes: message.media?.sizeBytes ?? null,
          // Context-only media (e.g. a group image without a mention) is never fetched.
          status: MEDIA_TO_PROCESS.has(message.kind) && (analyzable || message.source === "history") ? "pending" : "skipped",
        })
        .onConflictDoNothing({ target: mediaObjects.messageId })
        .returning();
      const [current] = media
        ? [media]
        : await db.select().from(mediaObjects).where(eq(mediaObjects.messageId, messageId));
      mediaObjectId = current?.status === "pending" ? current.id : null;
    }
    return { chat: toChat(chat), messageId, duplicate, mediaObjectId, analyzable };
  });

  if (!projected) return { status: "skipped" };
  if (!projected.duplicate) {
    if (projected.mediaObjectId) await scheduler.enqueueMedia(projected.mediaObjectId);
    if (projected.analyzable) await scheduler.debounceAnalysis(projected.chat.id);
  }
  await markProjected(database.db, event.id);
  return {
    status: projected.duplicate ? "duplicate" : "stored",
    chatId: projected.chat.id,
    messageId: projected.messageId,
  };
}
