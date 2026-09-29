/**
 * Push payloads (docs/API.md, "Push"). They carry ids, counts, task titles and who a Review item
 * came from only — never raw message text — and stay under 3 KB after encryption.
 */
import type { ReviewItemType } from "@wabrain/contracts";

/**
 * `notificationId` is the durable event id (review, reminder, summary): the device shows each id at
 * most once, whether it arrives by push or through the fallback `GET /v1/notifications`.
 */
export type PushPayload =
  | { type: "sync" }
  | { type: "review"; notificationId?: string; reviewItemId: string; reviewType: ReviewItemType; title: string; from?: string }
  | { type: "reminder"; notificationId?: string; taskId: string; title: string; dueAt: string }
  | { type: "summary"; notificationId?: string; open: number; dueToday: number; overdue: number; review: number };

/** RFC 8030 limit is 4 KB; the product keeps payloads under 3 KB including aes128gcm overhead. */
export const MAX_PAYLOAD_BYTES = 3 * 1024;
/** aes128gcm header (86 bytes with a 65-byte key id) + 16-byte tag + 1 padding delimiter. */
const ENCRYPTION_OVERHEAD = 86 + 16 + 1;
const MAX_TITLE_CHARS = 200;

function clip(value: string, max: number): string {
  const clean = value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max - 1)}…`;
}

/** Serializes a payload, shortening the title when needed so the encrypted message fits. */
export function encodePayload(payload: PushPayload): string {
  let value: PushPayload = "title" in payload ? { ...payload, title: clip(payload.title, MAX_TITLE_CHARS) } : payload;
  let json = JSON.stringify(value);
  while (Buffer.byteLength(json, "utf8") + ENCRYPTION_OVERHEAD > MAX_PAYLOAD_BYTES) {
    if (!("title" in value) || value.title.length === 0) throw new Error("push payload too large");
    value = { ...value, title: clip(value.title, Math.floor(value.title.length / 2)) };
    json = JSON.stringify(value);
  }
  return json;
}
