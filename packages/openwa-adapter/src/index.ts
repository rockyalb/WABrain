import { createHmac, timingSafeEqual } from "node:crypto";
import {
  NormalizedMessageSchema,
  OpenWaWebhookSchema,
  type NormalizedMessage,
  type OpenWaWebhook,
} from "@wabrain/contracts";

const knownKinds = new Set([
  "text",
  "image",
  "video",
  "audio",
  "voice",
  "document",
  "contact",
  "location",
  "sticker",
  "poll",
]);

/** Kinds that always carry a file, whether or not the engine sends a hasMedia flag. */
const mediaKinds = new Set(["image", "video", "audio", "voice", "document", "sticker"]);

export function verifyOpenWaSignature(rawBody: string, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith("sha256=") || !secret) return false;
  const suppliedHex = signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/i.test(suppliedHex)) return false;
  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(suppliedHex, "hex");
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

const str = (value: unknown): string | null => (typeof value === "string" && value.length ? value : null);
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/** Quoted-message id across the field names OpenWA engines use. */
function quotedMessageId(data: Record<string, unknown>): string | null {
  return (
    str(data.quotedMessageId) ??
    str(data.quotedMsgId) ??
    str(record(data.quotedMessage)?.id) ??
    str(record(data.quotedMsg)?.id) ??
    str(record(data.contextInfo)?.stanzaId) ??
    null
  );
}

/** View-once flag across the field names OpenWA engines use. */
function isViewOnce(data: Record<string, unknown>, media: Record<string, unknown> | null): boolean {
  return [data.isViewOnce, data.viewOnce, media?.viewOnce, media?.isViewOnce].some((flag) => flag === true);
}

export function normalizeOpenWaWebhook(input: unknown): NormalizedMessage {
  const envelope: OpenWaWebhook = OpenWaWebhookSchema.parse(input);
  const data = envelope.data;
  const direction = data.direction ?? (data.fromMe || envelope.event === "message.sent" ? "outgoing" : "incoming");
  const chatId = data.chatId ?? (data.isGroup ? data.from : direction === "incoming" ? data.from : data.to);
  const senderId = data.author ?? (direction === "incoming" ? data.from : data.to || data.from);
  const rawKind = data.type.toLowerCase();
  const kind = knownKinds.has(rawKind) ? rawKind : "unknown";

  return NormalizedMessageSchema.parse({
    id: data.id,
    sessionId: envelope.sessionId,
    chatId,
    chatName: data.chatName ?? null,
    senderId,
    senderName: data.contact?.pushName ?? data.contact?.name ?? null,
    senderSavedName: data.contact?.name ?? null,
    authorId: data.author ?? null,
    body: data.body ?? "",
    kind,
    timestamp: data.timestamp,
    direction,
    isGroup: data.isGroup ?? chatId.endsWith("@g.us"),
    mentions: data.mentions,
    // The Baileys engine sends no hasMedia flag; it sends a `media` object (the file, or an
    // `omitted` marker) instead.
    hasMedia: data.hasMedia || Boolean(data.media) || mediaKinds.has(kind),
    media: data.media
      ? {
          mimetype: typeof data.media.mimetype === "string" ? data.media.mimetype : null,
          filename: typeof data.media.filename === "string" ? data.media.filename : null,
          sizeBytes: typeof data.media.sizeBytes === "number" ? data.media.sizeBytes : null,
        }
      : null,
    quotedMessageId: quotedMessageId(data),
    isViewOnce: isViewOnce(data, data.media ?? null),
    source: "webhook",
    rawIdempotencyKey: envelope.idempotencyKey,
  });
}

export interface OpenWaHistoryPage {
  messages: unknown[];
  total: number;
}

/** OpenWA's persisted row id is the paging cursor; waMessageId is the WhatsApp dedupe key. */
export function historyEnvelope(row: unknown, sessionId: string): { cursor: string; envelope: OpenWaWebhook; message: NormalizedMessage } | null {
  const value = record(row);
  if (!value) return null;
  const cursor = str(value.id);
  const waMessageId = str(value.waMessageId);
  const chatId = str(value.chatId);
  const timestamp = value.timestamp;
  if (!cursor || !waMessageId || !chatId || typeof timestamp !== "number" || !Number.isInteger(timestamp) || timestamp < 0 || timestamp > 8.64e12) return null;
  const direction = value.direction === "outgoing" ? "outgoing" : "incoming";
  const media = record(value.media);
  const contact = record(value.contact);
  const envelope = OpenWaWebhookSchema.parse({
    event: direction === "outgoing" ? "message.sent" : "message.received",
    timestamp: new Date(timestamp * 1000).toISOString(),
    sessionId,
    idempotencyKey: `history:${chatId}:${waMessageId}`,
    deliveryId: `history:${cursor}`,
    data: {
      id: waMessageId,
      chatId,
      chatName: value.chatName ?? null,
      from: str(value.from) ?? chatId,
      to: str(value.to) ?? "",
      author: value.author ?? null,
      body: value.body ?? "",
      type: value.type ?? "unknown",
      timestamp,
      direction,
      isGroup: value.isGroup === true || chatId.endsWith("@g.us"),
      mentions: Array.isArray(value.mentions) ? value.mentions : [],
      hasMedia: value.hasMedia === true,
      media: media ? {
        mimetype: str(media.mimetype), filename: str(media.filename),
        sizeBytes: typeof media.sizeBytes === "number" ? media.sizeBytes : null,
        duration: typeof media.duration === "number" ? media.duration : null,
      } : null,
      contact: contact ? { name: str(contact.name), pushName: str(contact.pushName) } : null,
      isViewOnce: value.isViewOnce === true,
    },
  });
  return { cursor, envelope, message: { ...normalizeOpenWaWebhook(envelope), source: "history" } };
}

export interface OpenWaRetryOptions {
  /** Attempts per request, including the first (default 5). */
  maxAttempts?: number;
  /** Longest single Retry-After the client waits out (default 60 s); longer ones fail at once. */
  maxWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** OpenWA kept throttling a read; retryAfterSeconds is its last Retry-After. */
export class OpenWaRateLimitedError extends Error {
  constructor(
    readonly retryAfterSeconds: number,
    path: string,
  ) {
    super(`OpenWA rate limited ${path}; retry after ${retryAfterSeconds}s`);
    this.name = "OpenWaRateLimitedError";
  }
}

function retryAfterSeconds(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds);
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

/** Measure what OpenWA already holds before asking the owner to start an import. */
export async function scanStoredHistoryCoverage(client: OpenWaReadClient, sessionId: string, cutoffAt: Date) {
  const counts = new Map<string, { chatId: string; chatName: string | null; earliestAt: string | null; messageCount: number; mediaOk: number; mediaFailed: number; gaps: string[] }>();
  let after: string | undefined;
  for (let pageNumber = 0; pageNumber < 10_000; pageNumber += 1) {
    const previousCursor = after;
    const page = await client.listStoredMessages(sessionId, { limit: 100, after });
    if (!page.messages.length) break;
    let reachedCutoff = false;
    for (const row of page.messages) {
      const item = record(row);
      const cursor = str(item?.id);
      if (!cursor) throw new Error("OpenWA returned a stored message without a paging id");
      after = cursor;
      const chatId = str(item?.chatId);
      const stamp = item?.timestamp;
      if (!chatId || typeof stamp !== "number" || !Number.isInteger(stamp) || stamp < 0 || stamp > 8.64e12) continue;
      const at = new Date(stamp * 1000);
      if (at < cutoffAt) { reachedCutoff = true; continue; }
      const coverage = counts.get(chatId) ?? { chatId, chatName: str(item?.chatName), earliestAt: null, messageCount: 0, mediaOk: 0, mediaFailed: 0, gaps: [] };
      coverage.messageCount += 1;
      if (!coverage.earliestAt || at.toISOString() < coverage.earliestAt) coverage.earliestAt = at.toISOString();
      if (!str(item?.waMessageId) && !coverage.gaps.includes("missing WhatsApp message id")) coverage.gaps.push("missing WhatsApp message id");
      counts.set(chatId, coverage);
    }
    if (after === previousCursor) throw new Error("OpenWA history cursor did not advance");
    if (reachedCutoff || page.messages.length < 100) break;
    if (pageNumber === 9_999) throw new Error("OpenWA coverage scan exceeded one million messages");
  }
  return [...counts.values()].sort((a, b) => a.chatId.localeCompare(b.chatId));
}

const CONTACT_PAGE = 1000;
const MAX_CONTACTS = 100_000;

/**
 * Read-only OpenWA client. It issues GET requests only; there is deliberately
 * no method for sending, reacting, editing, deleting, marking read, presence,
 * or group management (see index.test.ts).
 */
export class OpenWaReadClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly retry: OpenWaRetryOptions = {},
  ) {}

  /** Waits out OpenWA's rate limiter (429/503 with Retry-After) while the wait stays short. */
  private async get<T>(path: string): Promise<T> {
    const maxAttempts = this.retry.maxAttempts ?? 5;
    const maxWaitMs = this.retry.maxWaitMs ?? 60_000;
    const sleep = this.retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let attempt = 1; ; attempt += 1) {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}${path}`, {
        method: "GET",
        headers: { "X-API-Key": this.apiKey },
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (response.status === 429 || response.status === 503) {
        const seconds = retryAfterSeconds(response.headers.get("retry-after")) ?? 2 ** attempt;
        if (attempt >= maxAttempts || seconds * 1000 > maxWaitMs) throw new OpenWaRateLimitedError(seconds, path);
        await sleep(seconds * 1000);
        continue;
      }
      if (!response.ok) throw new Error(`OpenWA read failed (${response.status}) for ${path}`);
      return (await response.json()) as T;
    }
  }

  listChats(sessionId: string, limit = 100, offset = 0): Promise<unknown[]> {
    return this.get(`/api/sessions/${encodeURIComponent(sessionId)}/chats?limit=${limit}&offset=${offset}`);
  }

  /**
   * The owner's saved phone contacts as `{ jid, name }`, every page. Contacts without a saved name,
   * or not in the address book, are left out.
   */
  async listSavedContacts(sessionId: string): Promise<Array<{ jid: string; name: string }>> {
    const saved: Array<{ jid: string; name: string }> = [];
    for (let offset = 0; ; offset += CONTACT_PAGE) {
      const page = await this.get<unknown>(`/api/sessions/${encodeURIComponent(sessionId)}/contacts?limit=${CONTACT_PAGE}&offset=${offset}`);
      if (!Array.isArray(page)) throw new Error("OpenWA returned an invalid contact page");
      for (const item of page) {
        const contact = (item ?? {}) as { id?: unknown; number?: unknown; name?: unknown; isMyContact?: unknown };
        const name = typeof contact.name === "string" ? contact.name.trim() : "";
        const digits = typeof contact.number === "string" ? contact.number.replace(/\D/g, "") : "";
        const jid = typeof contact.id === "string" && contact.id.includes("@") ? contact.id : digits ? `${digits}@c.us` : "";
        if (name && jid && contact.isMyContact !== false) saved.push({ jid, name });
      }
      if (page.length < CONTACT_PAGE) break;
      if (offset >= MAX_CONTACTS) throw new Error("OpenWA contact list exceeded 100,000 contacts");
    }
    return saved;
  }

  async listStoredMessages(sessionId: string, options: { limit?: number; after?: string; chatId?: string } = {}) {
    const query = new URLSearchParams({
      limit: String(options.limit ?? 100),
      inlineMedia: "false",
    });
    if (options.after) query.set("after", options.after);
    if (options.chatId) query.set("chatId", options.chatId);
    const page = await this.get<OpenWaHistoryPage>(
      `/api/sessions/${encodeURIComponent(sessionId)}/messages?${query.toString()}`,
    );
    if (!Array.isArray(page.messages) || !Number.isInteger(page.total)) throw new Error("OpenWA returned an invalid stored-message page");
    return page;
  }

  /** Stored media bytes (or OpenWA's JSON envelope). Pass a signal to bound the download time. */
  getStoredMedia(sessionId: string, chatId: string, messageId: string, options: { signal?: AbortSignal } = {}): Promise<Response> {
    return fetch(
      `${this.baseUrl.replace(/\/$/, "")}/api/sessions/${encodeURIComponent(sessionId)}/messages/${encodeURIComponent(chatId)}/${encodeURIComponent(messageId)}/media`,
      { method: "GET", headers: { "X-API-Key": this.apiKey }, signal: options.signal, redirect: "error" },
    );
  }
}

export * from "./setup.js";
