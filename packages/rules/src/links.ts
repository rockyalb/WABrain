import type { TaskLink } from "@wabrain/contracts";
import { foldText } from "./text.js";

/**
 * Task links: matching a name from a request ("Send Jordan the list", "in the Design group") to one of
 * the owner's chats, so that chat can later close the task. Pure: the caller loads the chats.
 *
 * - Every word of the name must match a word of the chat's name (saved contact name, person name or
 *   chat name), ignoring case, diacritics and a possessive "'s": "Jordan's", "jordan" → "Jordan";
 *   "Zoe" → "Zoë". One typo is tolerated in names of five or more letters ("Jordna"), but a typo
 *   match is only ever offered as a candidate, never linked on its own.
 * - Exactly one such chat: a confirmed link. Several, but only one the owner has talked to in the last
 *   year: that one ("Sam" means the Sam from this week, not the one from 2023). Otherwise, or with only
 *   partial matches, an unconfirmed link whose candidates the owner picks from, most recently talked to
 *   first. None: an unconfirmed link with no candidates (the owner picks any chat).
 * - A name with a group word ("the Design group", "Design chat") only matches groups when a group matches.
 */

export interface LinkableChat {
  id: string;
  isGroup: boolean;
  /** Display name for the dropdown. */
  name: string;
  /** Every name the chat is known by (saved contact name, person name, chat name). */
  names: readonly string[];
  /** Last message in the chat, either direction; null when unknown. */
  lastMessageAt: Date | null;
}

export interface ResolveLinkOptions {
  /** The task's own chat: never a link target. */
  excludeChatIds?: readonly string[];
  now: Date;
}

/** A chat with no message for this long no longer counts as someone the owner talks to. */
export const ACTIVE_CHAT_DAYS = 365;

const MAX_CANDIDATES = 5;
const DAY_MS = 86_400_000;
const MAX_NAMES = 3;

const GROUP_WORDS = new Set(["group", "groups", "chat", "chats"]);
const FILLER_WORDS = new Set(["the", "in", "to", "on", "at", "for", "with", "of"]);

function words(value: string): string[] {
  return foldText(value.replace(/^~/, ""))
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length >= 2);
}

/**
 * True when the request word is the chat word. Words are already case- and diacritic-folded, and a
 * possessive "'s" is split off as a one-letter word that `words` drops.
 */
export function nameWordMatches(requestWord: string, chatWord: string): boolean {
  return requestWord === chatWord;
}

/** Edit distance with adjacent swaps (optimal string alignment): "jordna" → "jordan" is 1. */
export function editDistance(a: string, b: string): number {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(rows[i - 1]![j]! + 1, rows[i]![j - 1]! + 1, rows[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, rows[i - 2]![j - 2]! + 1);
      rows[i]![j] = best;
    }
  }
  return rows[a.length]![b.length]!;
}

/** Names this short are too easy to confuse ("Dana"/"Dina") to match with a typo. */
const FUZZY_MIN_LENGTH = 5;

/**
 * True when the request word is the chat word with one typo: "Jordna" → "Jordan"; "Jrodna" is two
 * edits and does not match.
 */
export function nameWordFuzzyMatches(requestWord: string, chatWord: string): boolean {
  if (chatWord.length < FUZZY_MIN_LENGTH) return false;
  return Math.abs(requestWord.length - chatWord.length) <= 1 && editDistance(requestWord, chatWord) <= 1;
}

/** 2: exactly the name; 1: one typo away; 0: no match. */
function wordQuality(requestWord: string, chatWords: readonly string[]): 0 | 1 | 2 {
  if (chatWords.some((chatWord) => nameWordMatches(requestWord, chatWord))) return 2;
  if (chatWords.some((chatWord) => nameWordFuzzyMatches(requestWord, chatWord))) return 1;
  return 0;
}

interface Scored {
  chat: LinkableChat;
  /** Every word of the request matched. */
  full: boolean;
  /** Full, and no word needed a typo allowance: safe to link without asking. */
  sure: boolean;
  matched: number;
  quality: number;
}

function score(requestWords: readonly string[], chat: LinkableChat): Scored | null {
  let best: Scored | null = null;
  for (const name of chat.names) {
    const chatWords = words(name);
    if (chatWords.length === 0) continue;
    const qualities = requestWords.map((word) => wordQuality(word, chatWords));
    const matched = qualities.filter((quality) => quality > 0).length;
    if (matched === 0) continue;
    const full = matched === requestWords.length;
    const entry: Scored = { chat, full, sure: full && qualities.every((quality) => quality === 2), matched, quality: qualities.reduce<number>((sum, q) => sum + q, 0) };
    if (!best || byRank(entry, best) < 0) best = entry;
  }
  return best;
}

const lastAt = (entry: Scored) => entry.chat.lastMessageAt?.getTime() ?? 0;
/** Full matches first, then exact before typo matches, more matched words, then the most recently talked to. */
const byRank = (a: Scored, b: Scored) =>
  Number(b.full) - Number(a.full) || Number(b.sure) - Number(a.sure) || b.quality - a.quality || b.matched - a.matched || lastAt(b) - lastAt(a);

/** Cleans a model-reported name: trimmed, no "@", at most 80 characters; null when nothing usable is left. */
export function cleanLinkName(name: string): string | null {
  const clean = name.replace(/\s+/g, " ").replace(/^@+/, "").trim().slice(0, 80);
  return words(clean).length > 0 ? clean : null;
}

/** Resolves one name to a link. Chats in `excludeChatIds` (the task's own chat) never match. */
export function resolveLinkName(name: string, chats: readonly LinkableChat[], options: ResolveLinkOptions): TaskLink {
  const allWords = words(name);
  const groupHint = allWords.some((word) => GROUP_WORDS.has(word));
  const requestWords = allWords.filter((word) => !GROUP_WORDS.has(word) && !FILLER_WORDS.has(word));
  const unresolved = (candidates: Scored[]): TaskLink => ({
    name,
    chatId: null,
    candidates: candidates.slice(0, MAX_CANDIDATES).map(({ chat }) => ({ chatId: chat.id, name: chat.name })),
    source: "ai",
  });
  if (requestWords.length === 0) return unresolved([]);

  const excluded = new Set(options.excludeChatIds ?? []);
  const scored = chats
    .filter((chat) => !excluded.has(chat.id))
    .map((chat) => score(requestWords, chat))
    .filter((entry): entry is Scored => entry !== null)
    .sort(byRank);
  // "the Design group" means a group; a plain name means the person's direct chat, not a group that happens
  // to contain it ("Jordan's birthday"). A group is still found by its plain name when no person matches.
  const inScope =
    groupHint && scored.some((entry) => entry.full && entry.chat.isGroup)
      ? scored.filter((entry) => entry.chat.isGroup)
      : !groupHint && scored.some((entry) => entry.sure && !entry.chat.isGroup)
        ? scored.filter((entry) => !entry.chat.isGroup)
        : scored;
  // Only exact matches link on their own; a typo match is offered, never assumed.
  const sure = inScope.filter((entry) => entry.sure);
  const linked = (entry: Scored): TaskLink => ({ name, chatId: entry.chat.id, candidates: [], source: "ai" });
  if (sure.length === 1) return linked(sure[0]!);
  // Several people match: the only one the owner has talked to within a year is the one meant.
  const activeSince = options.now.getTime() - ACTIVE_CHAT_DAYS * DAY_MS;
  const active = sure.filter((entry) => lastAt(entry) >= activeSince);
  if (sure.length > 1 && active.length === 1) return linked(active[0]!);
  return unresolved(inScope);
}

/**
 * Resolves the names a create reported into its links: at most three, cleaned, one per chat (a name
 * that resolves to a chat already linked is dropped), never the task's own chat.
 */
export function resolveTaskLinks(
  names: readonly string[],
  chats: readonly LinkableChat[],
  options: { ownChatId: string | null; now: Date },
): TaskLink[] {
  const links: TaskLink[] = [];
  const seenNames = new Set<string>();
  for (const raw of names) {
    const name = cleanLinkName(raw);
    if (!name) continue;
    const key = words(name).join(" ");
    if (seenNames.has(key)) continue;
    seenNames.add(key);
    const link = resolveLinkName(name, chats, { excludeChatIds: options.ownChatId ? [options.ownChatId] : [], now: options.now });
    if (link.chatId && links.some((existing) => existing.chatId === link.chatId)) continue;
    links.push(link);
    if (links.length >= MAX_NAMES) break;
  }
  return links;
}

/** The chats a task's confirmed links point at. */
export function linkedChatIds(links: readonly TaskLink[] | null | undefined): string[] {
  return [...new Set((links ?? []).map((link) => link.chatId).filter((id): id is string => Boolean(id)))];
}
