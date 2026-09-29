import { describe, expect, it } from "vitest";
import { containsAlias, evaluateMessage, shouldStore, skipReason, type RuleChat, type RuleMessage } from "./chat.js";
import { jidUser, sameJid } from "./text.js";

const OWNER = "447690000000@s.whatsapp.net";

const groupChat: RuleChat = { mode: "mentions_only", aliases: ["Alex", "@Alex"] };
const directChat: RuleChat = { mode: "on", aliases: [] };

const groupMessage: RuleMessage = {
  chatId: "120363000000@g.us",
  body: "Who has this month's invoice?",
  kind: "text",
  direction: "incoming",
  isGroup: true,
  mentions: [],
};

const directMessage: RuleMessage = {
  chatId: "447691111111@s.whatsapp.net",
  body: "send me the contract tomorrow",
  kind: "text",
  direction: "incoming",
  isGroup: false,
};

describe("skip filters", () => {
  it("drops everything from Off chats", () => {
    expect(skipReason(directMessage, { mode: "off" })).toBe("chat_off");
    expect(shouldStore(directMessage, { mode: "off" })).toBe(false);
  });

  it("drops status updates", () => {
    expect(skipReason({ ...directMessage, chatId: "status@broadcast" }, null)).toBe("status_broadcast");
  });

  it("drops view-once media", () => {
    expect(skipReason({ ...directMessage, kind: "image", isViewOnce: true }, directChat)).toBe("view_once");
  });

  it("drops one-time codes", () => {
    expect(skipReason({ ...directMessage, body: "Your verification code: 123456" }, directChat)).toBe("one_time_code");
    expect(skipReason({ ...directMessage, body: "Your verification code is 998877" }, directChat)).toBe("one_time_code");
  });

  it("stores normal messages, including ones with numbers", () => {
    expect(shouldStore(directMessage, directChat)).toBe(true);
    expect(shouldStore({ ...directMessage, body: "Invoice 12345 must be paid on Friday" }, directChat)).toBe(true);
    expect(shouldStore({ ...directMessage, body: "Room 2034 at 14:00 tomorrow" }, null)).toBe(true);
  });
});

describe("containsAlias", () => {
  it.each([
    ["Alex, can you call the supplier?", true],
    ["@Alex have you seen this?", true],
    ["ALEX did you send it?", true],
    ["that's Alex's job", true],
    ["ask alex", true],
    ["Alexandra came by", false],
    ["Smalex is a brand", false],
    ["alexxyz", false],
  ])("%s -> %s", (body, expected) => {
    expect(containsAlias(body, ["Alex"])).toBe(expected);
  });

  it("is diacritic-insensitive in both directions", () => {
    expect(containsAlias("Ask Andi about this", ["Andì"])).toBe(true);
    expect(containsAlias("Talk to Çelik", ["Celik"])).toBe(true);
    expect(containsAlias("Talk to Celik", ["Çelik"])).toBe(true);
  });

  it("matches multi-word aliases across whitespace", () => {
    expect(containsAlias("Did you see Alex   Morgan today?", ["Alex Morgan"])).toBe(true);
  });

  it("keeps short aliases exact", () => {
    expect(containsAlias("Artists are here", ["Art"])).toBe(false);
    expect(containsAlias("Art, are you coming?", ["Art"])).toBe(true);
  });

  it("ignores empty aliases", () => {
    expect(containsAlias("anything", ["", "@", " "])).toBe(false);
  });
});

describe("evaluateMessage", () => {
  it("analyzes direct chats in both directions", () => {
    expect(evaluateMessage(directMessage, directChat, OWNER)).toEqual({ action: "analyze", reason: "direct_chat" });
    expect(evaluateMessage({ ...directMessage, direction: "outgoing" }, directChat, OWNER)).toEqual({
      action: "analyze",
      reason: "direct_chat",
    });
  });

  it("analyzes a direct chat that has no stored rule yet", () => {
    expect(evaluateMessage(directMessage, null, OWNER)).toEqual({ action: "analyze", reason: "direct_chat" });
  });

  it("keeps unmentioned group messages as context only", () => {
    expect(evaluateMessage(groupMessage, groupChat, OWNER)).toEqual({ action: "context_only", reason: "mention_required" });
    expect(evaluateMessage(groupMessage, null, OWNER)).toEqual({ action: "context_only", reason: "mention_required" });
  });

  it("analyzes a real mention even when the JID format differs", () => {
    const mentioned = { ...groupMessage, mentions: ["447690000000:17@c.us"] };
    expect(evaluateMessage(mentioned, groupChat, OWNER)).toEqual({ action: "analyze", reason: "mention" });
  });

  it("does not treat someone else's mention as the owner's", () => {
    const mentioned = { ...groupMessage, mentions: ["447691111111@s.whatsapp.net"] };
    expect(evaluateMessage(mentioned, groupChat, OWNER).action).toBe("context_only");
  });

  it("analyzes a whole-word alias", () => {
    expect(evaluateMessage({ ...groupMessage, body: "Alex, do you have the invoice?" }, groupChat, OWNER)).toEqual({
      action: "analyze",
      reason: "alias",
    });
  });

  it("analyzes the owner's own group messages", () => {
    expect(evaluateMessage({ ...groupMessage, direction: "outgoing" }, groupChat, OWNER)).toEqual({
      action: "analyze",
      reason: "owner_message",
    });
  });

  it("analyzes replies to the owner", () => {
    expect(evaluateMessage(groupMessage, groupChat, OWNER, { quotesOwner: true })).toEqual({
      action: "analyze",
      reason: "reply_to_owner",
    });
  });

  it("analyzes everything in a group switched on", () => {
    expect(evaluateMessage(groupMessage, { ...groupChat, mode: "on" }, OWNER)).toEqual({ action: "analyze", reason: "group_all" });
  });

  it("skips Off chats and filtered messages before anything else", () => {
    expect(evaluateMessage({ ...groupMessage, body: "Alex" }, { ...groupChat, mode: "off" }, OWNER)).toEqual({
      action: "skip",
      reason: "chat_off",
    });
    expect(evaluateMessage({ ...directMessage, isViewOnce: true }, directChat, OWNER)).toEqual({ action: "skip", reason: "view_once" });
  });
});

describe("jid helpers", () => {
  it("normalizes JIDs", () => {
    expect(jidUser("447690000000:12@s.whatsapp.net")).toBe("447690000000");
    expect(sameJid("447690000000@c.us", "447690000000@s.whatsapp.net")).toBe(true);
    expect(sameJid("@c.us", "@s.whatsapp.net")).toBe(false);
  });
});
