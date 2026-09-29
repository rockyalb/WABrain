import { schema } from "@wabrain/db";
import { makeOpenWaEnvelope } from "@wabrain/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHarness, ownerAndDevice, sign, waitFor, type Harness } from "./test/harness.js";

let h: Harness;
let auth: Record<string, string>;
let cookie: string;

beforeAll(async () => {
  h = await createHarness();
  const creds = await ownerAndDevice(h);
  auth = { authorization: `Bearer ${creds.token}` };
  cookie = creds.cookie;
});
afterAll(async () => {
  await h.close();
});

function deliver(payload: unknown, signature?: string) {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  return h.request("/webhooks/openwa", {
    method: "POST",
    headers: { "content-type": "application/json", "x-openwa-signature": signature ?? sign(body) },
    body,
  });
}

const messagesFor = (waId: string) =>
  h.testDb.database.db.select().from(schema.messages).where(eq(schema.messages.waMessageId, waId));

describe("POST /webhooks/openwa", () => {
  it("rejects an invalid signature without storing anything", async () => {
    const envelope = makeOpenWaEnvelope();
    const response = await deliver(envelope, sign(JSON.stringify(envelope), "some-other-secret-value-0123456789abcdef"));
    expect(response.status).toBe(401);
    const missing = await h.request("/webhooks/openwa", { method: "POST", body: JSON.stringify(envelope) });
    expect(missing.status).toBe(401);
    const rows = await h.testDb.database.db
      .select()
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.idempotencyKey, envelope.idempotencyKey));
    expect(rows).toEqual([]);
  });

  it("stores once, projects asynchronously, and deduplicates replays", async () => {
    const envelope = makeOpenWaEnvelope();
    const first = await deliver(envelope);
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ accepted: true, duplicate: false });
    const replay = await deliver(envelope);
    expect(replay.status).toBe(202);
    expect(await replay.json()).toEqual({ accepted: true, duplicate: true });

    const events = await h.testDb.database.db
      .select()
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.idempotencyKey, envelope.idempotencyKey));
    expect(events).toHaveLength(1);
    const [message] = await waitFor(async () => {
      const rows = await messagesFor(envelope.data.id);
      return rows.length ? rows : null;
    });
    expect(message).toMatchObject({ body: envelope.data.body, direction: "incoming", language: "en" });

    const chats = (await (await h.request("/v1/chats", { headers: auth })).json()) as { items: { id: string; name: string }[] };
    const chat = chats.items.find((item) => item.name === "Sam")!;
    const around = await h.request(`/v1/chats/${chat.id}/messages?around=${message!.id}&before=5&after=5`, { headers: auth });
    expect(((await around.json()) as { items: { id: string }[] }).items.map((item) => item.id)).toEqual([message!.id]);
  });

  it("accepts a voice note with embedded media, stores it without the file, and queues the media", async () => {
    const file = Buffer.alloc(2 * 1024 * 1024, 1).toString("base64");
    const envelope = makeOpenWaEnvelope({ data: { type: "voice", body: "", media: { mimetype: "audio/ogg; codecs=opus", data: file } } });
    const response = await deliver(envelope);
    expect(response.status).toBe(202);
    const [event] = await h.testDb.database.db
      .select()
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.idempotencyKey, envelope.idempotencyKey));
    expect((event!.raw as { data: { media: unknown } }).data.media).toEqual({ mimetype: "audio/ogg; codecs=opus" });
    const [message] = await waitFor(async () => {
      const rows = await messagesFor(envelope.data.id);
      return rows.length ? rows : null;
    });
    expect(message).toMatchObject({ kind: "voice", hasMedia: true });
    const media = await h.testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.messageId, message!.id));
    expect(media).toMatchObject([{ kind: "voice", status: "pending", mimetype: "audio/ogg; codecs=opus" }]);
  });

  it("rejects malformed payloads and ignores unrelated events", async () => {
    expect((await deliver("{not json")).status).toBe(400);
    expect((await deliver({ event: "message.received", data: {} })).status).toBe(400);
    const ignored = await deliver({ event: "session.status", sessionId: "s", data: {} });
    expect(ignored.status).toBe(202);
    expect(await ignored.json()).toEqual({ accepted: true, ignored: true });
  });

  it("stores nothing for an Off chat, status updates, channels, codes, or view-once media", async () => {
    const jid = "447690000321@s.whatsapp.net";
    const first = makeOpenWaEnvelope({ data: { chatId: jid, from: jid, contact: { name: "Bora" } } });
    await deliver(first);
    await waitFor(async () => ((await messagesFor(first.data.id)).length ? true : null));
    const chats = (await (await h.request("/v1/chats?q=Bora", { headers: auth })).json()) as { items: { id: string }[] };
    const chatId = chats.items[0]!.id;

    const off = await h.request(`/v1/chats/${chatId}`, { method: "PATCH", headers: auth, json: { mode: "off" } });
    expect(off.status).toBe(200);
    expect(await off.json()).toMatchObject({ mode: "off", jid });
    expect(await messagesFor(first.data.id)).toEqual([]);

    const later = makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "private" } });
    const response = await deliver(later);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, stored: false });
    for (const payload of [
      makeOpenWaEnvelope({ data: { chatId: "status@broadcast", from: "status@broadcast" } }),
      makeOpenWaEnvelope({ data: { chatId: "12345@newsletter", from: "12345@newsletter" } }),
      makeOpenWaEnvelope({ data: { chatId: "447690000888@s.whatsapp.net", from: "447690000888@s.whatsapp.net", body: "Your verification code is 482913. Do not share it." } }),
      makeOpenWaEnvelope({ data: { isViewOnce: true, type: "image", hasMedia: true } }),
    ]) {
      expect(await (await deliver(payload)).json()).toEqual({ accepted: true, stored: false });
      expect(await h.testDb.database.db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.idempotencyKey, payload.idempotencyKey))).toEqual([]);
    }
    const raw = await h.testDb.database.db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.chatJid, jid));
    expect(raw).toEqual([]);
    const statusRows = await h.testDb.database.db
      .select()
      .from(schema.sourceEvents)
      .where(eq(schema.sourceEvents.chatJid, "status@broadcast"));
    expect(statusRows).toEqual([]);
  });

  it("exposes projected people with editable facts, and deletes a person's data", async () => {
    const jid = "447690000456@s.whatsapp.net";
    const envelope = makeOpenWaEnvelope({ data: { chatId: jid, from: jid, contact: { name: "Klea" } } });
    await deliver(envelope);
    await waitFor(async () => ((await messagesFor(envelope.data.id)).length ? true : null));
    const people = (await (await h.request("/v1/people?q=Kle", { headers: auth })).json()) as { items: { id: string; jids: string[] }[] };
    expect(people.items).toHaveLength(1);
    const personId = people.items[0]!.id;
    expect(people.items[0]!.jids).toEqual([jid]);

    const fact = await h.request(`/v1/people/${personId}/facts`, { method: "POST", headers: auth, json: { key: "company", value: "Acme" } });
    expect(fact.status).toBe(201);
    const factBody = (await fact.json()) as { id: string };
    expect(factBody).toMatchObject({ source: "owner", verified: true, confidence: 1 });
    const patched = await h.request(`/v1/people/${personId}/facts/${factBody.id}`, { method: "PATCH", headers: auth, json: { value: "Acme Sh.p.k." } });
    expect(await patched.json()).toMatchObject({ value: "Acme Sh.p.k." });
    const renamed = await h.request(`/v1/people/${personId}`, { method: "PATCH", headers: auth, json: { displayName: "Klea (Acme)" } });
    expect(await renamed.json()).toMatchObject({ displayName: "Klea (Acme)", facts: [expect.objectContaining({ key: "company" })] });
    expect((await h.request(`/v1/people/${personId}/facts/${factBody.id}`, { method: "DELETE", headers: auth })).status).toBe(204);

    expect((await h.request(`/v1/people/${personId}/data`, { method: "DELETE", headers: auth })).status).toBe(204);
    expect((await h.request(`/v1/people/${personId}`, { headers: auth })).status).toBe(404);
    expect(await messagesFor(envelope.data.id)).toEqual([]);
  });

  it("rejects events from another OpenWA session when one is configured", async () => {
    const scoped = await createHarness({ worker: false, env: { OPENWA_SESSION_ID: "session-1" } });
    try {
      const envelope = makeOpenWaEnvelope({ sessionId: "someone-else" });
      const body = JSON.stringify(envelope);
      const response = await scoped.request("/webhooks/openwa", {
        method: "POST",
        headers: { "content-type": "application/json", "x-openwa-signature": sign(body) },
        body,
      });
      expect(response.status).toBe(403);
    } finally {
      await scoped.close();
    }
  });

  // Last: it wipes the database the other tests use.
  it("keeps an Off chat Off, as a bare identifier, across a full wipe", async () => {
    const offJid = "447690000611@s.whatsapp.net";
    const onJid = "447690000612@s.whatsapp.net";
    const first = makeOpenWaEnvelope({ data: { chatId: offJid, from: offJid, contact: { name: "Dritan" } } });
    const other = makeOpenWaEnvelope({ data: { chatId: onJid, from: onJid, contact: { name: "Ema" } } });
    await deliver(first);
    await deliver(other);
    await waitFor(async () => ((await messagesFor(first.data.id)).length && (await messagesFor(other.data.id)).length ? true : null));
    const found = (await (await h.request("/v1/chats?q=Dritan", { headers: auth })).json()) as { items: { id: string }[] };
    const chatId = found.items[0]!.id;
    expect((await h.request(`/v1/chats/${chatId}`, { method: "PATCH", headers: auth, json: { mode: "off", aliases: ["DD"] } })).status).toBe(200);

    const wiped = await h.request("/setup/wipe", { method: "POST", headers: { cookie }, json: { confirm: "DELETE EVERYTHING" } });
    expect(wiped.status).toBe(200);
    // Only Off chats remain (this one and the one an earlier test switched Off).
    const listed = (await (await h.request("/v1/chats", { headers: auth })).json()) as { items: { jid: string; mode: string }[] };
    expect(listed.items.every((chat) => chat.mode === "off")).toBe(true);
    expect(listed.items.find((chat) => chat.jid === offJid)).toEqual(
      expect.objectContaining({ id: chatId, mode: "off", name: null, personId: null, aliases: [], lastMessageAt: null }),
    );
    const [event] = await h.testDb.database.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, "data.wiped"));
    expect(event?.details).toEqual({ keptOffChats: listed.items.length });

    const later = makeOpenWaEnvelope({ data: { chatId: offJid, from: offJid, contact: { name: "Dritan" }, body: "private" } });
    const response = await deliver(later);
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ accepted: true, stored: false });
    expect(await h.testDb.database.db.select().from(schema.sourceEvents).where(eq(schema.sourceEvents.chatJid, offJid))).toEqual([]);
    expect(await messagesFor(later.data.id)).toEqual([]);

    // Chats that were not Off are watched again from scratch.
    const again = makeOpenWaEnvelope({ data: { chatId: onJid, from: onJid, contact: { name: "Ema" } } });
    await deliver(again);
    await waitFor(async () => ((await messagesFor(again.data.id)).length ? true : null));
    const chatsNow = (await (await h.request("/v1/chats", { headers: auth })).json()) as { items: { jid: string; mode: string }[] };
    expect(chatsNow.items.find((chat) => chat.jid === onJid)).toMatchObject({ mode: "on", name: "Ema" });
    expect(chatsNow.items.find((chat) => chat.jid === offJid)).toMatchObject({ mode: "off", name: null });
  });
});
