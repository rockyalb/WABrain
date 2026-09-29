import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findChatByJid, purgeChatData, updateChat } from "../repos/chats.js";
import { replaceContactNames } from "../repos/contact-names.js";
import { insertSourceEvent } from "../repos/source-events.js";
import { chats, mediaObjects, messages, people, sourceEvents } from "../schema.js";
import { createTestDatabase, makeOpenWaEnvelope, type TestDatabase } from "../testing.js";
import { createDefaultIntakeFilter, projectSourceEvent, type IntakeScheduler } from "./intake.js";
import { TaskService } from "./tasks.js";

let testDb: TestDatabase;
const debounced: string[] = [];
const mediaQueued: string[] = [];
const scheduler: IntakeScheduler = {
  debounceAnalysis: async (chatId) => void debounced.push(chatId),
  enqueueMedia: async (id) => void mediaQueued.push(id),
};
const filter = createDefaultIntakeFilter({ selfJids: ["447690000000@s.whatsapp.net"], aliases: ["Alex"] });

async function ingest(envelope: ReturnType<typeof makeOpenWaEnvelope>) {
  const { database } = testDb;
  const { id } = await insertSourceEvent(database.db, {
    sessionId: envelope.sessionId,
    idempotencyKey: envelope.idempotencyKey,
    deliveryId: envelope.deliveryId,
    eventType: envelope.event,
    chatJid: String(envelope.data.chatId),
    raw: envelope,
  });
  return { id, result: await projectSourceEvent({ database, filter, scheduler }, id) };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

describe("projector", () => {
  it("projects a direct message into chat, person, participant, and message", async () => {
    const { result } = await ingest(makeOpenWaEnvelope());
    expect(result.status).toBe("stored");
    const chat = await findChatByJid(testDb.database.db, "447690000001@s.whatsapp.net");
    // The engine reported the owner's saved name (whatsapp-web.js does).
    expect(chat).toMatchObject({ mode: "on", isGroup: false, name: "Sam" });
    const [person] = await testDb.database.db.select().from(people).where(eq(people.id, chat!.personId!));
    expect(person).toMatchObject({ displayName: "Sam", jids: ["447690000001@s.whatsapp.net"] });
    const [message] = await testDb.database.db.select().from(messages).where(eq(messages.chatId, chat!.id));
    expect(message).toMatchObject({ direction: "incoming", fromOwner: false, language: "en" });
    expect(debounced).toContain(chat!.id);
  });

  it("names chats, people and senders by the owner's saved contact name", async () => {
    const { db } = testDb.database;
    const direct = "447690000041@s.whatsapp.net";
    const member = "447690000042@s.whatsapp.net";
    await replaceContactNames(db, [
      { jid: direct, name: "Beni Hidraulik" },
      { jid: member, name: "Mira Zyra" },
    ]);
    await ingest(makeOpenWaEnvelope({ data: { id: "saved-1", chatId: direct, from: direct, contact: { pushName: "💫B" } } }));
    const chat = await findChatByJid(db, direct);
    expect(chat).toMatchObject({ name: "Beni Hidraulik" });
    const [person] = await db.select().from(people).where(eq(people.id, chat!.personId!));
    expect(person).toMatchObject({ displayName: "Beni Hidraulik" });

    const group = { chatId: "group-9@g.us", from: "group-9@g.us", isGroup: true, chatName: "Office" };
    await ingest(makeOpenWaEnvelope({ data: { ...group, id: "saved-2", author: member, contact: { pushName: "Mira" } } }));
    await ingest(makeOpenWaEnvelope({ data: { ...group, id: "saved-3", author: "447690000043@s.whatsapp.net", contact: { pushName: "Taylor" } } }));
    const rows = await db.select({ waMessageId: messages.waMessageId, senderName: messages.senderName }).from(messages);
    expect(Object.fromEntries(rows.filter((r) => r.waMessageId.startsWith("saved-")).map((r) => [r.waMessageId, r.senderName]))).toEqual({
      "saved-1": "Beni Hidraulik",
      "saved-2": "Mira Zyra",
      "saved-3": "~Taylor",
    });
    expect(await findChatByJid(db, "group-9@g.us")).toMatchObject({ name: "Office" });
  });

  it("is idempotent and deduplicates the same message from another delivery", async () => {
    const envelope = makeOpenWaEnvelope();
    const first = await ingest(envelope);
    const retry = await projectSourceEvent({ database: testDb.database, filter, scheduler }, first.id);
    expect(retry.status).toBe("already_projected");
    const other = await ingest({ ...envelope, idempotencyKey: `${envelope.idempotencyKey}-redelivered` });
    expect(other.result.status).toBe("duplicate");
    const rows = await testDb.database.db.select().from(messages).where(eq(messages.waMessageId, envelope.data.id));
    expect(rows).toHaveLength(1);
  });

  it("stores group messages as mentions_only and analyzes only on mention or alias", async () => {
    const group = { chatId: "group-1@g.us", from: "group-1@g.us", author: "447690000009@s.whatsapp.net", isGroup: true, chatName: "Warehouse" };
    debounced.length = 0;
    await ingest(makeOpenWaEnvelope({ data: { ...group, body: "Who has the key?" } }));
    expect(debounced).toHaveLength(0);
    await ingest(makeOpenWaEnvelope({ data: { ...group, body: "Alex, can you check the invoice?" } }));
    expect(debounced).toHaveLength(1);
    await ingest(makeOpenWaEnvelope({ data: { ...group, body: "look", mentions: ["447690000000@c.us"] } }));
    expect(debounced).toHaveLength(2);
    const chat = await findChatByJid(testDb.database.db, "group-1@g.us");
    expect(chat).toMatchObject({ mode: "mentions_only", isGroup: true, personId: null });
  });

  it("stores nothing for Off chats, status updates, or view-once media", async () => {
    const { database } = testDb;
    const jid = "447690000077@s.whatsapp.net";
    await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid } }));
    const chat = (await findChatByJid(database.db, jid))!;
    await purgeChatData(database.db, chat.id);
    await updateChat(database.db, chat.id, { mode: "off" });

    const off = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "secret" } }));
    const status = await ingest(makeOpenWaEnvelope({ data: { chatId: "status@broadcast", from: "status@broadcast" } }));
    const viewOnce = await ingest(makeOpenWaEnvelope({ data: { isViewOnce: true, type: "image", hasMedia: true } }));
    expect([off.result.status, status.result.status, viewOnce.result.status]).toEqual(["skipped", "skipped", "skipped"]);
    for (const { id } of [off, status, viewOnce]) {
      expect(await database.db.select().from(sourceEvents).where(eq(sourceEvents.id, id))).toEqual([]);
    }
    expect(await database.db.select().from(messages).where(eq(messages.chatId, chat.id))).toEqual([]);
    expect(await database.db.select().from(chats).where(eq(chats.jid, "status@broadcast"))).toEqual([]);
  });

  it("queues media for processing and purging a chat keeps tasks without evidence", async () => {
    const { database } = testDb;
    const jid = "447690000055@s.whatsapp.net";
    const { result } = await ingest(
      makeOpenWaEnvelope({ data: { chatId: jid, from: jid, type: "image", hasMedia: true, media: { mimetype: "image/jpeg" } } }),
    );
    if (result.status !== "stored") throw new Error("expected stored");
    const [media] = await database.db.select().from(mediaObjects).where(eq(mediaObjects.messageId, result.messageId));
    expect(media).toMatchObject({ status: "pending", mimetype: "image/jpeg" });
    expect(mediaQueued).toContain(media!.id);

    const service = new TaskService({ database });
    const applied = await service.applyAction(
      {
        type: "create",
        kind: "todo",
        title: "Check the photo",
        description: "",
        dueAt: null,
        dueHasTime: false,
        contextId: null,
        language: "en",
        confidence: 0.9,
        ambiguityReasons: [],
        evidenceMessageIds: [result.messageId],
      },
      { outcome: "apply", reason: "auto_create" },
      { chatId: result.chatId },
    );
    if (applied.outcome !== "applied") throw new Error("expected applied");
    expect(applied.task.personId).not.toBeNull();
    await purgeChatData(database.db, result.chatId);
    const task = await service.setStatus(applied.task.id, "open");
    expect(task.evidenceMessageIds).toEqual([]);
    expect(await database.db.select().from(mediaObjects).where(eq(mediaObjects.id, media!.id))).toEqual([]);
  });
});
