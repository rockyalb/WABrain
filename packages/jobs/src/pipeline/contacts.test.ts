/** Saved contact names: synced from OpenWA, applied everywhere, and re-embedded where senders changed. */
import { schema, savedContactNames } from "@wabrain/db";
import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { syncContacts } from "./contacts.js";
import type { ContactSource, PipelineQueue } from "./deps.js";

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

const silent = { info() {}, warn() {}, error() {} };

function harness(contacts: ContactSource | null) {
  const enqueued: Array<{ name: string; data: unknown }> = [];
  const notified: unknown[] = [];
  const queue: PipelineQueue = {
    enqueue: async (name, data) => (enqueued.push({ name, data }), "job"),
    debounceChat: async () => {},
  };
  return {
    deps: { database: testDb.database, queue, contacts, notifier: { notify: (event: unknown) => void notified.push(event) }, logger: silent },
    enqueued,
    notified,
  };
}

describe("syncContacts", () => {
  it("applies the phone's saved names and rebuilds search for chats whose senders changed", async () => {
    const { db } = testDb.database;
    const jid = "447690000061@c.us";
    await db.insert(schema.sourceEvents).values({ id: "se1", sessionId: "s1", idempotencyKey: "k1", deliveryId: "d1", eventType: "message.received", chatJid: jid, raw: {} });
    await db.insert(schema.people).values({ id: "p1", displayName: "~B", primaryJid: jid, jids: [jid] });
    await db.insert(schema.chats).values({ id: "c1", jid, name: "~B", isGroup: false, mode: "on", personId: "p1" });
    await db.insert(schema.messages).values({
      id: "m1", chatId: "c1", waMessageId: "w1", senderJid: jid, senderName: "~B", direction: "incoming",
      fromOwner: false, kind: "text", source: "webhook", sentAt: new Date("2026-09-20T10:00:00Z"),
    });
    const sessions: string[] = [];
    const h = harness({ listSavedContacts: async (session) => (sessions.push(session), [{ jid, name: "Beni Hidraulik" }]) });

    expect(await syncContacts(h.deps)).toEqual({ status: "done", contacts: 1, people: 1, chats: 1, messages: 1 });
    expect(sessions).toEqual(["s1"]);
    expect((await db.select().from(schema.people).where(eq(schema.people.id, "p1")))[0]!.displayName).toBe("Beni Hidraulik");
    expect((await db.select().from(schema.messages).where(eq(schema.messages.id, "m1")))[0]!.senderName).toBe("Beni Hidraulik");
    expect(h.enqueued).toEqual([{ name: "embed-chat", data: { chatId: "c1" } }]);
    expect(h.notified).toEqual([{ type: "sync" }]);
  });

  it("keeps the contact book when OpenWA returns no contacts, and skips without OpenWA", async () => {
    const before = await savedContactNames(testDb.database.db, ["447690000061@c.us"]);
    expect(await syncContacts(harness({ listSavedContacts: async () => [] }).deps, "s1")).toEqual({ status: "skipped", reason: "no_contacts" });
    expect(await savedContactNames(testDb.database.db, ["447690000061@c.us"])).toEqual(before);
    expect(await syncContacts(harness(null).deps)).toEqual({ status: "skipped", reason: "openwa_not_configured" });
  });
});
