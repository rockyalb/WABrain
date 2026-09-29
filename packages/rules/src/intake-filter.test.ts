import type { Chat, NormalizedMessage } from "@wabrain/contracts";
import { describe, expect, it } from "vitest";
import { evaluateMessage, skipReason } from "./chat.js";
import { createRulesIntakeFilter } from "./intake-filter.js";

const OWNER = "447690000000@s.whatsapp.net";
const OWNER_LID = "12345678901234@lid";

const message = (overrides: Partial<NormalizedMessage> = {}): NormalizedMessage => ({
  id: "m1",
  sessionId: "s1",
  chatId: "447690000001@s.whatsapp.net",
  senderId: "447690000001@s.whatsapp.net",
  senderName: "Sam",
  body: "send me the contract tomorrow",
  kind: "text",
  timestamp: 1_790_000_000,
  direction: "incoming",
  isGroup: false,
  mentions: [],
  hasMedia: false,
  isViewOnce: false,
  source: "webhook",
  ...overrides,
});

const chat = (overrides: Partial<Chat> = {}): Chat => ({
  id: "c1",
  jid: "447690000001@s.whatsapp.net",
  name: "Sam",
  isGroup: false,
  mode: "on",
  defaultContextId: null,
  contextConfirmed: false,
  autoCreate: true,
  minimumAutoConfidence: null,
  aliases: [],
  personId: null,
  lastMessageAt: null,
  ...overrides,
});

const group = (overrides: Partial<NormalizedMessage> = {}) =>
  message({ chatId: "team@g.us", isGroup: true, senderId: "447690000009@s.whatsapp.net", body: "who has the key?", ...overrides });

describe("rules intake filter", () => {
  const filter = createRulesIntakeFilter({ ownerJids: [OWNER, OWNER_LID], aliases: ["Alex"] });

  it("does not store one-time codes, Off chats, status updates, channels, or view-once media", () => {
    expect(filter.shouldStore(message({ body: "Your verification code: 482913. Do not share it." }), null)).toBe(false);
    expect(filter.shouldStore(message(), chat({ mode: "off" }))).toBe(false);
    expect(filter.shouldStore(message({ chatId: "status@broadcast" }), null)).toBe(false);
    expect(filter.shouldStore(message({ chatId: "120363000000000000@newsletter" }), null)).toBe(false);
    expect(filter.shouldStore(message({ kind: "image", hasMedia: true, isViewOnce: true }), chat())).toBe(false);
    expect(filter.shouldStore(message(), null)).toBe(true);
  });

  it("uses the sender name as an OTP hint", () => {
    expect(filter.shouldStore(message({ body: "Ref 4821, your code", senderName: "Example Bank" }), null)).toBe(false);
  });

  it("analyzes direct chats and the owner's own group messages", () => {
    expect(filter.shouldAnalyze(message(), chat())).toBe(true);
    expect(filter.shouldAnalyze(group({ direction: "outgoing" }), chat({ isGroup: true, mode: "mentions_only" }))).toBe(true);
  });

  it("keeps group messages without a mention as context only", () => {
    const groupChat = chat({ isGroup: true, mode: "mentions_only", jid: "team@g.us" });
    expect(filter.shouldAnalyze(group(), groupChat)).toBe(false);
    expect(filter.shouldAnalyze(group({ mentions: [OWNER_LID] }), groupChat)).toBe(true);
    expect(filter.shouldAnalyze(group({ body: "Alex's invoice, do you have it?" }), groupChat)).toBe(true);
    expect(filter.shouldAnalyze(group({ body: "Ana can you check" }), { ...groupChat, aliases: ["Ana"] })).toBe(true);
    expect(filter.shouldAnalyze(group(), groupChat, { quotesOwner: true })).toBe(true);
    expect(filter.shouldAnalyze(group(), { ...groupChat, mode: "on" })).toBe(true);
  });

  it("never analyzes imported history", () => {
    expect(filter.shouldAnalyze(message({ source: "history" }), chat())).toBe(false);
  });
});

describe("channel and multi-JID rules", () => {
  it("skips newsletter channels", () => {
    expect(skipReason({ chatId: "1203@newsletter", body: "news", kind: "text", direction: "incoming", isGroup: false }, null)).toBe("channel");
  });

  it("accepts several owner JIDs", () => {
    const evaluation = evaluateMessage(
      { chatId: "g@g.us", body: "hi", kind: "text", direction: "incoming", isGroup: true, mentions: ["999@lid"] },
      { mode: "mentions_only", aliases: [] },
      ["447690000000@s.whatsapp.net", "999@lid"],
    );
    expect(evaluation).toEqual({ action: "analyze", reason: "mention" });
  });
});
