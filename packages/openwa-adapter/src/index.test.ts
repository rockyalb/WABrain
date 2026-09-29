import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { historyEnvelope, normalizeOpenWaWebhook, OpenWaReadClient, verifyOpenWaSignature } from "./index.js";

const envelope = {
  event: "message.received",
  timestamp: "2026-09-02T12:00:00Z",
  sessionId: "session-1",
  idempotencyKey: "idem-1",
  deliveryId: "delivery-1",
  data: {
    id: "message-1",
    chatId: "group@g.us",
    chatName: "Warehouse team",
    from: "group@g.us",
    to: "self@c.us",
    author: "mira@c.us",
    body: "@Alex can you check this?",
    type: "text",
    timestamp: 1_780_000_000,
    isGroup: true,
    mentions: ["self@c.us"],
    hasMedia: false,
  },
} as const;

describe("OpenWA adapter", () => {
  it("verifies an HMAC over the raw request bytes", () => {
    const raw = JSON.stringify(envelope);
    const digest = createHmac("sha256", "secret").update(raw).digest("hex");
    expect(verifyOpenWaSignature(raw, `sha256=${digest}`, "secret")).toBe(true);
    expect(verifyOpenWaSignature(`${raw} `, `sha256=${digest}`, "secret")).toBe(false);
  });

  it("uses the group author as the sender", () => {
    const message = normalizeOpenWaWebhook(envelope);
    expect(message.senderId).toBe("mira@c.us");
    expect(message.chatId).toBe("group@g.us");
    expect(message.direction).toBe("incoming");
  });

  it("flags view-once media and quoted replies", () => {
    const message = normalizeOpenWaWebhook({
      ...envelope,
      data: { ...envelope.data, isViewOnce: true, quotedMsgId: "earlier-1" },
    });
    expect(message.isViewOnce).toBe(true);
    expect(message.quotedMessageId).toBe("earlier-1");
    expect(normalizeOpenWaWebhook(envelope).isViewOnce).toBe(false);
  });
});

describe("OpenWA adapter media", () => {
  it("treats a Baileys voice note without a hasMedia flag as media", () => {
    const { hasMedia: _flag, ...data } = envelope.data;
    const voice = normalizeOpenWaWebhook({
      ...envelope,
      data: { ...data, isGroup: false, chatId: "a@c.us", from: "a@c.us", author: undefined, type: "voice", body: "", media: { mimetype: "audio/ogg; codecs=opus", data: "T2dnUw==" } },
    });
    expect(voice).toMatchObject({ kind: "voice", hasMedia: true, media: { mimetype: "audio/ogg; codecs=opus" } });
    const omitted = normalizeOpenWaWebhook({ ...envelope, data: { ...data, type: "image", media: { mimetype: "image/jpeg", omitted: true } } });
    expect(omitted.hasMedia).toBe(true);
    expect(normalizeOpenWaWebhook({ ...envelope, data }).hasMedia).toBe(false);
  });
});

describe("OpenWaReadClient", () => {
  it("uses the stored row id for paging and the WhatsApp id for deduplication", () => {
    const item = historyEnvelope({
      id: "db-row-1", waMessageId: "wamid-1", chatId: "person@c.us",
      from: "person@c.us", to: "owner@c.us", direction: "incoming",
      timestamp: 1_780_000_000, type: "text", body: "Hello",
    }, "session-1");
    expect(item?.cursor).toBe("db-row-1");
    expect(item?.message).toMatchObject({ id: "wamid-1", source: "history", body: "Hello" });
    expect(item?.envelope.idempotencyKey).toBe("history:person@c.us:wamid-1");
  });

  it("only ever issues GET requests", async () => {
    const calls: { url: string; method: string }[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ messages: [], total: 0 }), { status: 200 });
    }) as typeof fetch;
    try {
      const client = new OpenWaReadClient("https://openwa.example", "read-key");
      await client.listChats("s1");
      await client.listStoredMessages("s1", { after: "c", chatId: "x@c.us" });
      await client.getStoredMedia("s1", "x@c.us", "m1");
      await client.listSavedContacts("s1").catch(() => undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(calls).toHaveLength(4);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("waits out OpenWA's rate limiter, and gives up when the wait is too long", async () => {
    const page = () => new Response(JSON.stringify({ messages: [], total: 0 }), { status: 200 });
    const throttled = (retryAfter: string) => new Response("", { status: 429, headers: { "retry-after": retryAfter } });
    const responses = [throttled("3"), throttled("1"), page(), throttled("120")];
    const waits: number[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => responses.shift()!) as typeof fetch;
    try {
      const client = new OpenWaReadClient("https://openwa.example", "read-key", { maxWaitMs: 10_000, sleep: async (ms) => void waits.push(ms) });
      await expect(client.listStoredMessages("s1")).resolves.toEqual({ messages: [], total: 0 });
      expect(waits).toEqual([3000, 1000]);
      await expect(client.listStoredMessages("s1")).rejects.toMatchObject({ name: "OpenWaRateLimitedError", retryAfterSeconds: 120 });
      expect(waits).toEqual([3000, 1000]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("lists saved contacts across pages, skipping unsaved and unnamed ones", async () => {
    const full = Array.from({ length: 1000 }, (_, i) => ({ id: `4469${String(i).padStart(7, "0")}@c.us`, name: `Contact ${i}`, isMyContact: true }));
    const last = [
      { id: "447690009999@c.us", name: " Beni ", isMyContact: true },
      { id: "447690009998@c.us", name: "", isMyContact: true },
      { id: "447690009997@c.us", name: "Stranger", isMyContact: false },
      { number: "+44 769 000 9996", name: "By number" },
    ];
    const urls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url));
      return new Response(JSON.stringify(urls.length === 1 ? full : last), { status: 200 });
    }) as typeof fetch;
    try {
      const contacts = await new OpenWaReadClient("https://openwa.example", "read-key").listSavedContacts("s1");
      expect(contacts).toHaveLength(1002);
      expect(contacts.slice(-2)).toEqual([
        { jid: "447690009999@c.us", name: "Beni" },
        { jid: "447690009996@c.us", name: "By number" },
      ]);
      expect(urls).toEqual([
        "https://openwa.example/api/sessions/s1/contacts?limit=1000&offset=0",
        "https://openwa.example/api/sessions/s1/contacts?limit=1000&offset=1000",
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("exposes no WhatsApp write operation", () => {
    const methods = Object.getOwnPropertyNames(OpenWaReadClient.prototype).filter((name) => name !== "constructor");
    expect(methods.sort()).toEqual(["get", "getStoredMedia", "listChats", "listSavedContacts", "listStoredMessages"]);
    const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
    expect(source).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)["']/i);
    expect(source).not.toMatch(/\/(send|react|edit|delete|read|seen|presence|typing|groups?)\b/i);
  });
});
