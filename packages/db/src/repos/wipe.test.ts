import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chats, messages, participants, people, sourceEvents, tasks } from "../schema.js";
import { createDefaultIntakeFilter, projectSourceEvent, type IntakeScheduler } from "../services/intake.js";
import { TaskService } from "../services/tasks.js";
import { createTestDatabase, makeOpenWaEnvelope, type TestDatabase } from "../testing.js";
import { findChatByJid, purgeChatData, updateChat } from "./chats.js";
import { createContext, listContexts } from "./contexts.js";
import { insertSourceEvent } from "./source-events.js";
import { readSync } from "./sync.js";
import { wipeAllData } from "./wipe.js";

let testDb: TestDatabase;
const scheduler: IntakeScheduler = { debounceAnalysis: async () => {}, enqueueMedia: async () => {} };
const filter = createDefaultIntakeFilter({ selfJids: ["447690000000@s.whatsapp.net"] });

const DIRECT_ON = "447690000101@s.whatsapp.net";
const DIRECT_OFF = "447690000102@s.whatsapp.net";
const GROUP_MENTIONS = "group-wipe-1@g.us";
const GROUP_OFF = "group-wipe-2@g.us";

async function ingest(data: Record<string, unknown>) {
  const envelope = makeOpenWaEnvelope({ data });
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

const direct = (jid: string, name: string, body = "Hi") => ({ chatId: jid, from: jid, contact: { name }, body });
const group = (jid: string, name: string, body = "Hi all") => ({
  chatId: jid,
  from: jid,
  author: "447690000199@s.whatsapp.net",
  isGroup: true,
  chatName: name,
  body,
});

/** Switches a chat Off the way the API does: purge, then change the mode, plus every other rule set. */
async function switchOff(jid: string, contextId: string) {
  const { db } = testDb.database;
  const chat = (await findChatByJid(db, jid))!;
  await updateChat(db, chat.id, {
    defaultContextId: contextId,
    contextConfirmed: true,
    autoCreate: false,
    minimumAutoConfidence: 0.95,
    aliases: ["boss"],
  });
  await purgeChatData(db, chat.id);
  await updateChat(db, chat.id, { mode: "off" });
  return (await findChatByJid(db, jid))!;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

describe("wipeAllData", () => {
  it("keeps Off chats as bare identifiers and deletes everything else", async () => {
    const { database } = testDb;
    const { db } = database;
    const errands = await createContext(db, { name: "Errands" });
    for (const data of [direct(DIRECT_ON, "Sam"), direct(DIRECT_OFF, "Bora"), group(GROUP_MENTIONS, "Warehouse"), group(GROUP_OFF, "Family")]) {
      expect((await ingest(data)).result.status).toBe("stored");
    }
    const offDirect = await switchOff(DIRECT_OFF, errands.id);
    const offGroup = await switchOff(GROUP_OFF, errands.id);
    expect(offDirect).toMatchObject({ mode: "off", name: "Bora", personId: expect.any(String), aliases: ["boss"] });
    const service = new TaskService({ database });
    await service.createManualTask({ kind: "todo", title: "Call Bora", contextId: errands.id });

    const before = await readSync(database, null);
    expect(await wipeAllData(database)).toEqual({ keptOffChats: 2 });

    const kept = await db.select().from(chats).orderBy(chats.jid);
    expect(kept).toHaveLength(2);
    const byJid = new Map(kept.map((row) => [row.jid, row]));
    for (const [jid, original, isGroup] of [
      [DIRECT_OFF, offDirect, false],
      [GROUP_OFF, offGroup, true],
    ] as const) {
      expect(byJid.get(jid)).toMatchObject({
        id: original.id,
        jid,
        isGroup,
        mode: "off",
        name: null,
        personId: null,
        defaultContextId: null,
        contextConfirmed: false,
        autoCreate: true,
        minimumAutoConfidence: null,
        aliases: [],
        lastMessageAt: null,
      });
      expect(byJid.get(jid)!.createdAt.getTime()).toBeGreaterThanOrEqual(original.updatedAt.getTime());
    }
    expect(await findChatByJid(db, DIRECT_ON)).toBeNull();
    expect(await findChatByJid(db, GROUP_MENTIONS)).toBeNull();
    for (const table of [messages, participants, people, sourceEvents, tasks]) {
      expect(await db.select().from(table)).toEqual([]);
    }
    expect((await listContexts(db)).map((c) => c.name).sort()).toEqual(["Personal", "Work"]);

    // Devices take a full snapshot that lists the kept Off chats, as it lists every Off chat.
    const after = await readSync(database, before.cursor);
    expect(after.full).toBe(true);
    expect(after.chats.map((chat) => [chat.jid, chat.mode, chat.name, chat.personId]).sort()).toEqual([
      [DIRECT_OFF, "off", null, null],
      [GROUP_OFF, "off", null, null],
    ]);
    const next = await readSync(database, after.cursor);
    expect(next).toMatchObject({ full: false, chats: [], deleted: { chats: [] } });
  });

  it("still stores nothing for a kept Off chat, and watches the other chats again by default", async () => {
    const { db } = testDb.database;
    const off = await ingest(direct(DIRECT_OFF, "Bora", "private after the wipe"));
    const offGroup = await ingest(group(GROUP_OFF, "Family", "@447690000000 private"));
    expect([off.result.status, offGroup.result.status]).toEqual(["skipped", "skipped"]);
    for (const { id } of [off, offGroup]) {
      expect(await db.select().from(sourceEvents).where(eq(sourceEvents.id, id))).toEqual([]);
    }
    expect(await findChatByJid(db, DIRECT_OFF)).toMatchObject({ mode: "off", name: null, personId: null });
    expect(await db.select().from(people)).toEqual([]);

    expect((await ingest(direct(DIRECT_ON, "Sam"))).result.status).toBe("stored");
    expect(await findChatByJid(db, DIRECT_ON)).toMatchObject({ mode: "on", name: "Sam" });
  });

  it("keeps the Off list across repeated wipes and when there is nothing to keep", async () => {
    const { database } = testDb;
    expect(await wipeAllData(database)).toEqual({ keptOffChats: 2 });
    expect((await database.db.select({ jid: chats.jid }).from(chats)).map((row) => row.jid).sort()).toEqual([DIRECT_OFF, GROUP_OFF]);
    await database.db.update(chats).set({ mode: "on" }).where(eq(chats.jid, DIRECT_OFF));
    await database.db.update(chats).set({ mode: "mentions_only" }).where(eq(chats.jid, GROUP_OFF));
    expect(await wipeAllData(database)).toEqual({ keptOffChats: 0 });
    expect(await database.db.select().from(chats)).toEqual([]);
  });
});
