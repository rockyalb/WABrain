import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chats, messages, participants, people } from "../schema.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { applyContactNames, replaceContactNames, savedContactNames, unsavedName } from "./contact-names.js";

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

const SAVED = "447690000051@c.us";
const UNSAVED = "447690000052@c.us";
const OWNER_NAMED = "447690000053@c.us";
const NUMBER_ONLY = "447690000054@c.us";

describe("contact names", () => {
  it("marks WhatsApp names once", () => {
    expect(unsavedName("Ana")).toBe("~Ana");
    expect(unsavedName("~Ana")).toBe("~Ana");
    expect(unsavedName("  ")).toBeNull();
    expect(unsavedName(null)).toBeNull();
  });

  it("replaces the contact book: adds, renames and removes", async () => {
    const { db } = testDb.database;
    expect(await replaceContactNames(db, [{ jid: "a@c.us", name: "A" }, { jid: "b@c.us", name: "B" }, { jid: "c@c.us", name: " " }])).toEqual({
      added: 2,
      renamed: 0,
      removed: 0,
    });
    expect(await replaceContactNames(db, [{ jid: "a@c.us", name: "A2" }])).toEqual({ added: 0, renamed: 1, removed: 1 });
    expect([...(await savedContactNames(db, ["a@c.us", "b@c.us"]))]).toEqual([["a@c.us", "A2"]]);
  });

  it("applies saved names to people, chats, participants and senders; marks the rest; leaves owner names alone", async () => {
    const { db } = testDb.database;
    const person = async (jid: string, displayName: string, source: "auto" | "owner" = "auto") =>
      (await db.insert(people).values({ id: `p-${jid}`, displayName, displayNameSource: source, primaryJid: jid, jids: [jid] }).returning())[0]!;
    const chat = async (jid: string, name: string | null, personId: string) =>
      (await db.insert(chats).values({ id: `c-${jid}`, jid, name, isGroup: false, mode: "on", personId }).returning())[0]!;
    for (const [jid, name, source] of [
      [SAVED, "💫B", "auto"],
      [UNSAVED, "Taylor", "auto"],
      [OWNER_NAMED, "Xhaxhi", "owner"],
      [NUMBER_ONLY, "+447690000054", "auto"],
    ] as const) {
      const p = await person(jid, name, source);
      const c = await chat(jid, name.startsWith("+") ? null : name, p.id);
      await db.insert(participants).values({ id: `pa-${jid}`, chatId: c.id, jid, displayName: name.startsWith("+") ? null : name, personId: p.id });
      await db.insert(messages).values({
        id: `m-${jid}`,
        chatId: c.id,
        waMessageId: `w-${jid}`,
        senderJid: jid,
        senderName: name.startsWith("+") ? null : name,
        direction: "incoming",
        fromOwner: false,
        kind: "text",
        source: "history",
        sentAt: new Date("2026-09-01T10:00:00Z"),
      });
    }
    await replaceContactNames(db, [
      { jid: SAVED, name: "Beni Hidraulik" },
      { jid: OWNER_NAMED, name: "Agron" },
    ]);

    const first = await applyContactNames(db);
    expect(first.changedChatIds.sort()).toEqual([`c-${OWNER_NAMED}`, `c-${SAVED}`, `c-${UNSAVED}`].sort());

    const name = async (jid: string) => ({
      person: (await db.select().from(people).where(eq(people.primaryJid, jid)))[0]!.displayName,
      chat: (await db.select().from(chats).where(eq(chats.jid, jid)))[0]!.name,
      participant: (await db.select().from(participants).where(eq(participants.jid, jid)))[0]!.displayName,
      sender: (await db.select().from(messages).where(eq(messages.senderJid, jid)))[0]!.senderName,
    });
    expect(await name(SAVED)).toEqual({ person: "Beni Hidraulik", chat: "Beni Hidraulik", participant: "Beni Hidraulik", sender: "Beni Hidraulik" });
    expect(await name(UNSAVED)).toEqual({ person: "~Taylor", chat: "~Taylor", participant: "~Taylor", sender: "~Taylor" });
    // The owner's own name for the person wins; the chat and messages still follow the phone.
    expect(await name(OWNER_NAMED)).toEqual({ person: "Xhaxhi", chat: "Agron", participant: "Agron", sender: "Agron" });
    expect(await name(NUMBER_ONLY)).toEqual({ person: "+447690000054", chat: null, participant: null, sender: null });

    // Applying again changes nothing.
    expect(await applyContactNames(db)).toEqual({ people: 0, chats: 0, participants: 0, messages: 0, changedChatIds: [] });
  });
});
