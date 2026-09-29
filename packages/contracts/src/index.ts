import { z } from "zod";

export const MessageKindSchema = z.enum([
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
  "unknown",
]);

export const NormalizedMessageSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  chatId: z.string().min(1),
  chatName: z.string().nullish(),
  senderId: z.string().min(1),
  /** The name the sender chose in WhatsApp (their push name). */
  senderName: z.string().nullish(),
  /** The owner's saved contact name, when the engine reports it (whatsapp-web.js does, Baileys does not). */
  senderSavedName: z.string().nullish(),
  authorId: z.string().nullish(),
  body: z.string().default(""),
  kind: MessageKindSchema,
  timestamp: z.number().int().nonnegative(),
  direction: z.enum(["incoming", "outgoing"]),
  isGroup: z.boolean(),
  mentions: z.array(z.string()).default([]),
  hasMedia: z.boolean().default(false),
  media: z
    .object({
      mimetype: z.string().nullish(),
      filename: z.string().nullish(),
      sizeBytes: z.number().int().nonnegative().nullish(),
      downloadUrl: z.string().url().nullish(),
    })
    .nullish(),
  quotedMessageId: z.string().nullish(),
  isViewOnce: z.boolean().default(false),
  /** BCP-47-ish language tag detected for this message, e.g. "en" or "es". */
  language: z.string().nullish(),
  /** Text derived from media (OCR, image description, transcript), filled by media jobs. */
  derivedText: z.string().nullish(),
  source: z.enum(["webhook", "history"]),
  rawIdempotencyKey: z.string().nullish(),
});

export const OpenWaWebhookSchema = z.object({
  event: z.enum(["message.received", "message.sent"]),
  timestamp: z.string(),
  sessionId: z.string().min(1),
  idempotencyKey: z.string().min(1),
  deliveryId: z.string().min(1),
  data: z.object({
    id: z.string().min(1),
    chatId: z.string().optional(),
    chatName: z.string().nullish(),
    from: z.string().min(1),
    to: z.string().optional().default(""),
    author: z.string().nullish(),
    body: z.string().nullish(),
    type: z.string().default("unknown"),
    timestamp: z.number().int().nonnegative(),
    direction: z.enum(["incoming", "outgoing"]).optional(),
    fromMe: z.boolean().optional(),
    isGroup: z.boolean().optional(),
    mentions: z.array(z.string()).optional().default([]),
    hasMedia: z.boolean().optional().default(false),
    media: z.record(z.string(), z.unknown()).nullish(),
    contact: z
      .object({
        name: z.string().nullish(),
        pushName: z.string().nullish(),
      })
      .passthrough()
      .nullish(),
  }).passthrough(),
});

export * from "./domain.js";

export type NormalizedMessage = z.infer<typeof NormalizedMessageSchema>;
export type OpenWaWebhook = z.infer<typeof OpenWaWebhookSchema>;
