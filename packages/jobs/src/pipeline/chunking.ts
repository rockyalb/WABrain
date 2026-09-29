/**
 * Splits a chat into conversation windows for retrieval. Deterministic: the same messages always give
 * the same windows, so unchanged windows keep their stored vectors. A window never crosses a quiet gap
 * (a new conversation), and within a conversation windows are filled greedily from its first message,
 * so new messages only change the conversation's last window. A message longer than one line is split
 * into consecutive parts; each window holding a part cites that message.
 */
import type { ChunkableMessage, ChunkWindow } from "@wabrain/db";

export interface ChunkingOptions {
  /** A quiet gap longer than this starts a new conversation. Default 60 min. */
  gapMs: number;
  /** Messages per window. Default 16. */
  maxMessages: number;
  /** Characters per window (a single longer message is its own window). Default 1500. */
  maxChars: number;
  /** Messages repeated from the end of the previous window of the same conversation. Default 2. */
  overlap: number;
  /**
   * Characters per message line. A longer message (a long text, transcript, or PDF text) is split at
   * word boundaries into several lines with the same speaker, so no part of it is lost. Default 4000.
   */
  maxLineChars: number;
}

export const DEFAULT_CHUNKING: ChunkingOptions = {
  gapMs: 60 * 60_000,
  maxMessages: 16,
  maxChars: 1500,
  overlap: 2,
  maxLineChars: 4000,
};

const DERIVED_LABELS: Record<string, string> = {
  image: "image",
  sticker: "image",
  audio: "voice note",
  ptt: "voice note",
  voice: "voice note",
  document: "document",
  pdf: "document",
};

const clean = (text: string | null | undefined) => (text ?? "").replace(/\s+/g, " ").trim();

function messageContent(message: ChunkableMessage): { speaker: string; content: string } | null {
  const body = clean(message.body);
  const derived = clean(message.derivedText);
  if (!body && !derived) return null;
  const speaker = message.fromOwner ? "Me" : clean(message.senderName) || "Contact";
  const label = DERIVED_LABELS[message.kind] ?? "media";
  return { speaker, content: [body, derived ? `[${label}: ${derived}]` : ""].filter(Boolean).join(" ") };
}

/**
 * Splits long content into parts of at most `maxChars`, at a word boundary when one is near. Each part
 * after the first repeats the end of the previous part (about a tenth of `maxChars`, at most 200
 * characters), so a phrase that straddles a boundary is still found whole in one part.
 */
export function splitContent(content: string, maxChars: number): string[] {
  if (content.length <= maxChars) return [content];
  const overlap = Math.min(200, Math.floor(maxChars / 10));
  const parts: string[] = [];
  let start = 0;
  for (;;) {
    let end = Math.min(content.length, start + maxChars);
    if (end < content.length) {
      const boundary = content.lastIndexOf(" ", end);
      if (boundary > start + Math.floor(maxChars / 2)) end = boundary;
    }
    parts.push(content.slice(start, end).trim());
    if (end >= content.length) break;
    // Step back by the overlap, to the start of a word; always move forward.
    let next = Math.max(start + 1, end - overlap);
    const space = content.indexOf(" ", next);
    if (space !== -1 && space < end) next = space + 1;
    start = next;
  }
  return parts.filter(Boolean);
}

/** One or more attributed lines; long transcripts and documents retain every searchable character. */
export function messageLines(message: ChunkableMessage, maxChars = DEFAULT_CHUNKING.maxLineChars): string[] {
  const formatted = messageContent(message);
  if (!formatted) return [];
  const prefix = `${formatted.speaker}: `;
  const payloadLimit = Math.max(1, maxChars - prefix.length);
  return splitContent(formatted.content, payloadLimit).map((part) => `${prefix}${part}`);
}

/** One line per message ("Me: ...", "Sam: ... [image: ...]"), or null when it has no text yet. */
export function messageLine(message: ChunkableMessage, maxChars = DEFAULT_CHUNKING.maxLineChars): string | null {
  const formatted = messageContent(message);
  if (!formatted) return null;
  const line = `${formatted.speaker}: ${formatted.content}`;
  return line.length > maxChars ? `${line.slice(0, maxChars - 1)}…` : line;
}

export function buildChunkWindows(messages: readonly ChunkableMessage[], options: Partial<ChunkingOptions> = {}): ChunkWindow[] {
  const config = { ...DEFAULT_CHUNKING, ...options };
  const lines = messages.flatMap((message) => messageLines(message, config.maxLineChars).map((line) => ({ message, line })));

  const conversations: (typeof lines)[] = [];
  for (const entry of lines) {
    const current = conversations[conversations.length - 1];
    const previous = current?.[current.length - 1];
    if (!current || !previous || entry.message.sentAt.getTime() - previous.message.sentAt.getTime() > config.gapMs) {
      conversations.push([entry]);
    } else current.push(entry);
  }

  const windows: ChunkWindow[] = [];
  for (const conversation of conversations) {
    let start = 0;
    while (start < conversation.length) {
      let end = start;
      let chars = 0;
      while (end < conversation.length && end - start < config.maxMessages) {
        const length = conversation[end]!.line.length + 1;
        if (end > start && chars + length > config.maxChars) break;
        chars += length;
        end += 1;
      }
      const slice = conversation.slice(start, end);
      windows.push({
        // A long message split into several lines appears once: every part cites the same message.
        messageIds: [...new Set(slice.map((entry) => entry.message.id))],
        text: slice.map((entry) => entry.line).join("\n"),
        fromAt: slice[0]!.message.sentAt,
        toAt: slice[slice.length - 1]!.message.sentAt,
      });
      if (end >= conversation.length) break;
      start = Math.max(start + 1, end - config.overlap);
    }
  }
  return windows;
}
