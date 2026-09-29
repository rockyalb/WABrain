import { OpenWaWebhookSchema } from "@wabrain/contracts";
import { insertSourceEvent, shouldStoreIncoming } from "@wabrain/db";
import { normalizeOpenWaWebhook, verifyOpenWaSignature } from "@wabrain/openwa-adapter";
import type { Context } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";
import { HttpError } from "../http/errors.js";

const HANDLED_EVENTS = new Set(["message.received", "message.sent"]);

/**
 * OpenWA embeds downloaded media as base64 in `data.media.data`. The worker fetches media through the
 * read-only stored-media endpoint instead, so the stored event keeps only the metadata.
 */
function withoutEmbeddedMedia(payload: unknown): unknown {
  const data = (payload as { data?: { media?: unknown } }).data;
  const media = data?.media;
  if (!media || typeof media !== "object" || !("data" in media)) return payload;
  const { data: _file, ...metadata } = media as Record<string, unknown>;
  return { ...(payload as object), data: { ...data, media: metadata } };
}

/**
 * POST /webhooks/openwa. Verifies the HMAC over the exact raw body, drops
 * messages that must never be stored (Off chats, status, view-once), then
 * inserts the immutable source event and enqueues its projection in the same
 * transaction. Returns 202 only after that commit.
 */
export function openWaWebhook(deps: AppDeps) {
  return async (c: Context<AppEnv>) => {
    const raw = await c.req.text();
    if (!verifyOpenWaSignature(raw, c.req.header("x-openwa-signature"), deps.config.webhookSecret)) {
      deps.logger.warn("webhook signature rejected", { ip: c.get("clientIp") });
      throw new HttpError("unauthorized", "Invalid webhook signature");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new HttpError("validation_failed", "Malformed JSON");
    }
    const event = (payload as { event?: unknown } | null)?.event;
    if (typeof event !== "string" || !HANDLED_EVENTS.has(event)) return c.json({ accepted: true, ignored: true }, 202);

    const envelope = OpenWaWebhookSchema.safeParse(payload);
    if (!envelope.success) throw new HttpError("validation_failed", "Unsupported webhook payload");
    if (deps.config.openwaSessionId && envelope.data.sessionId !== deps.config.openwaSessionId) {
      throw new HttpError("forbidden", "Unexpected OpenWA session");
    }
    let message;
    try {
      message = normalizeOpenWaWebhook(payload);
    } catch {
      throw new HttpError("validation_failed", "Unsupported webhook payload");
    }

    if (!(await shouldStoreIncoming(deps.database.db, deps.intakeFilter, message))) {
      return c.json({ accepted: true, stored: false }, 202);
    }

    const result = await deps.database.transaction(async ({ db, sql }) => {
      const inserted = await insertSourceEvent(db, {
        sessionId: envelope.data.sessionId,
        idempotencyKey: envelope.data.idempotencyKey,
        deliveryId: envelope.data.deliveryId,
        eventType: envelope.data.event,
        chatJid: message.chatId,
        raw: withoutEmbeddedMedia(payload),
      });
      if (inserted.inserted) {
        await deps.queue.enqueue("project-event", { sourceEventId: inserted.id }, { tx: sql });
      }
      return inserted;
    });
    return c.json({ accepted: true, duplicate: !result.inserted }, 202);
  };
}
