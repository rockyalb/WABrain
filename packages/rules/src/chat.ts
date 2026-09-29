import type { Chat, NormalizedMessage } from "@wabrain/contracts";
import { isOneTimeCode } from "./otp.js";
import { escapeRegex, foldText, sameJid } from "./text.js";

/** The message fields the chat rules look at. A full NormalizedMessage satisfies it. */
export type RuleMessage = Pick<NormalizedMessage, "chatId" | "body" | "kind" | "direction" | "isGroup"> & {
  mentions?: readonly string[];
  isViewOnce?: boolean;
  senderName?: string | null;
};

/** The chat fields the chat rules look at. Null means the chat is not known yet (defaults apply). */
export type RuleChat = Pick<Chat, "mode" | "aliases">;

export type SkipReason = "chat_off" | "status_broadcast" | "channel" | "view_once" | "one_time_code";

export type MessageEvaluation =
  | { action: "analyze"; reason: "direct_chat" | "group_all" | "owner_message" | "mention" | "alias" | "reply_to_owner" }
  | { action: "context_only"; reason: "mention_required" }
  | { action: "skip"; reason: SkipReason };

export const STATUS_BROADCAST_JID = "status@broadcast";

/** WhatsApp Channels ("newsletters") are broadcast feeds, never personal conversations. */
export function isChannelJid(jid: string): boolean {
  return jid.toLowerCase().endsWith("@newsletter");
}

/**
 * Why a message must not be stored at all, or null when it may be stored.
 * Off chats, status updates, channel (newsletter) posts, view-once media, and one-time codes are discarded
 * on intake.
 */
export function skipReason(message: RuleMessage, chat: Pick<Chat, "mode"> | null): SkipReason | null {
  if (chat?.mode === "off") return "chat_off";
  if (message.chatId === STATUS_BROADCAST_JID) return "status_broadcast";
  if (isChannelJid(message.chatId)) return "channel";
  if (message.isViewOnce) return "view_once";
  if (isOneTimeCode(message.body, { senderName: message.senderName ?? null })) return "one_time_code";
  return null;
}

export function shouldStore(message: RuleMessage, chat: Pick<Chat, "mode"> | null): boolean {
  return skipReason(message, chat) === null;
}

/** Possessive endings, so the alias "Alex" also matches "Alex's", for aliases of four or more letters. */
const NAME_SUFFIX = "(?:'s?)?";

/**
 * True when one of the aliases appears as a whole word. Unicode-aware, case- and diacritic-insensitive,
 * tolerant of a leading "@" and of a possessive ending on the name.
 */
export function containsAlias(body: string, aliases: readonly string[]): boolean {
  if (!body) return false;
  const text = foldText(body);
  return aliases.some((alias) => {
    const clean = foldText(alias.trim().replace(/^@+/, "")).trim();
    if (clean.length < 2) return false;
    const pattern = clean.split(/\s+/).map(escapeRegex).join("\\s+");
    // Short aliases ("Al", "Ana") only match exactly.
    const suffix = clean.length >= 4 ? NAME_SUFFIX : "";
    return new RegExp(`(?<![\\p{L}\\p{N}_])@?${pattern}${suffix}(?![\\p{L}\\p{N}_])`, "iu").test(text);
  });
}

export interface EvaluateOptions {
  /** True when the message replies to (quotes) one of the owner's messages. */
  quotesOwner?: boolean;
}

/**
 * Decides whether a message is analyzed for tasks, kept as context only, or skipped.
 * Both directions are analyzed: the owner's own messages can create and close tasks.
 */
export function evaluateMessage(
  message: RuleMessage,
  chat: RuleChat | null,
  /** The owner's JID, or all of them (phone JID and LID) when the account has several. */
  ownerJid: string | readonly string[],
  options: EvaluateOptions = {},
): MessageEvaluation {
  const ownerJids = typeof ownerJid === "string" ? [ownerJid] : ownerJid;
  const skip = skipReason(message, chat);
  if (skip) return { action: "skip", reason: skip };

  if (!message.isGroup) return { action: "analyze", reason: "direct_chat" };
  if (message.direction === "outgoing") return { action: "analyze", reason: "owner_message" };

  // Groups default to mentions-only until the owner switches them on.
  const mode = chat?.mode ?? "mentions_only";
  if (mode === "on") return { action: "analyze", reason: "group_all" };

  if ((message.mentions ?? []).some((jid) => ownerJids.some((owner) => owner && sameJid(jid, owner)))) {
    return { action: "analyze", reason: "mention" };
  }
  if (containsAlias(message.body, chat?.aliases ?? [])) return { action: "analyze", reason: "alias" };
  if (options.quotesOwner) return { action: "analyze", reason: "reply_to_owner" };
  return { action: "context_only", reason: "mention_required" };
}
