import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { newId } from "../ids.js";
import { chats, messageChunks, messages, participants, people } from "../schema.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { purgeChatData } from "./chats.js";
import { listContexts } from "./contexts.js";
import {
  EMBEDDING_DIMENSIONS,
  chunkContentHash,
  hybridSearch,
  listChatChunks,
  listChatsNeedingEmbedding,
  listChunksToEmbed,
  markChatEmbedded,
  normalizeSearchText,
  padEmbedding,
  searchTerms,
  storeChunkEmbedding,
  syncChatChunks,
  type ChunkWindow,
} from "./message-chunks.js";

let testDb: TestDatabase;
let seq = 0;
let workId: string;
let personalId: string;

const at = (iso: string) => new Date(iso);

async function makePerson(name: string) {
  const id = newId();
  seq += 1;
  await testDb.database.db.insert(people).values({ id, displayName: name, primaryJid: `446900${seq}@s.whatsapp.net`, jids: [`446900${seq}@s.whatsapp.net`] });
  return id;
}

async function makeChat(options: { name?: string; isGroup?: boolean; mode?: "on" | "off" | "mentions_only"; personId?: string | null; contextId?: string | null } = {}) {
  const id = newId();
  seq += 1;
  await testDb.database.db.insert(chats).values({
    id,
    jid: `chat-${seq}@${options.isGroup ? "g.us" : "s.whatsapp.net"}`,
    name: options.name ?? null,
    isGroup: options.isGroup ?? false,
    mode: options.mode ?? "on",
    personId: options.personId ?? null,
    defaultContextId: options.contextId ?? null,
  });
  return id;
}

interface MessageSpec {
  body: string;
  at: string;
  fromOwner?: boolean;
  senderName?: string;
  personId?: string | null;
}

/** Inserts messages and stores them as one window. */
async function makeWindow(chatId: string, specs: MessageSpec[]) {
  const rows = [];
  for (const spec of specs) {
    const id = newId();
    let participantId: string | null = null;
    if (spec.personId !== undefined) {
      participantId = newId();
      await testDb.database.db
        .insert(participants)
        .values({ id: participantId, chatId, jid: `p-${participantId}@s.whatsapp.net`, displayName: spec.senderName ?? null, personId: spec.personId });
    }
    await testDb.database.db.insert(messages).values({
      id,
      chatId,
      waMessageId: `wa-${id}`,
      participantId,
      senderJid: spec.fromOwner ? "owner@s.whatsapp.net" : "contact@s.whatsapp.net",
      senderName: spec.senderName ?? null,
      direction: spec.fromOwner ? "outgoing" : "incoming",
      fromOwner: spec.fromOwner ?? false,
      kind: "text",
      body: spec.body,
      source: "webhook",
      sentAt: at(spec.at),
    });
    rows.push({ id, spec });
  }
  const window: ChunkWindow = {
    messageIds: rows.map((row) => row.id),
    text: rows.map((row) => `${row.spec.fromOwner ? "Me" : (row.spec.senderName ?? "Contact")}: ${row.spec.body}`).join("\n"),
    fromAt: at(specs[0]!.at),
    toAt: at(specs[specs.length - 1]!.at),
  };
  return { window, messageIds: window.messageIds };
}

async function currentWindows(chatId: string): Promise<ChunkWindow[]> {
  const rows = await listChatChunks(testDb.database.db, chatId);
  return rows.map((row) => ({ messageIds: row.messageIds, text: row.text, fromAt: row.fromAt, toAt: row.toAt }));
}

/** Adds windows to a chat's existing chunks. */
async function addWindows(chatId: string, windows: ChunkWindow[]) {
  const result = await syncChatChunks(testDb.database, chatId, [...(await currentWindows(chatId)), ...windows]);
  expect(result.synced).toBe(true);
}

const axis = (index: number, dims = 8) => Array.from({ length: dims }, (_, i) => (i === index ? 1 : i === dims - 1 ? 0.05 : 0));

beforeAll(async () => {
  testDb = await createTestDatabase();
  const contexts = await listContexts(testDb.database.db);
  workId = contexts.find((context) => context.name === "Work")!.id;
  personalId = contexts.find((context) => context.name === "Personal")!.id;
});

afterAll(async () => {
  await testDb?.drop();
});

describe("search text", () => {
  it("normalizes diacritics and punctuation", () => {
    expect(normalizeSearchText("Can you send the CONTRACT tomorrow? Prix: 1.200€ — Ça va, Zoë")).toBe("can you send the contract tomorrow prix 1 200 ca va zoe");
  });

  it("keeps content words and drops stop words", () => {
    expect(searchTerms("When did Jordan send the contract?")).toEqual(["contract", "jordan", "send"]);
    expect(searchTerms("what is the")).toEqual(["what is the"]);
    expect(searchTerms("a")).toEqual([]);
  });

  it("pads short vectors and rejects long ones", () => {
    expect(padEmbedding([1, 2])).toHaveLength(EMBEDDING_DIMENSIONS);
    expect(() => padEmbedding(new Array(EMBEDDING_DIMENSIONS + 1).fill(0))).toThrow(/dimensions/);
  });
});

describe("hybridSearch", () => {
  it("matches a typo'd query through trigrams", async () => {
    const sam = await makePerson("Sam");
    const chatId = await makeChat({ personId: sam, contextId: workId });
    const contract = await makeWindow(chatId, [
      { body: "Can you send the rental agreement for the café tomorrow?", at: "2026-09-01T09:00:00Z", senderName: "Sam" },
      { body: "Yes, I'll send it tomorrow morning.", at: "2026-09-01T09:02:00Z", fromOwner: true },
    ]);
    const lunch = await makeWindow(chatId, [{ body: "Lunch on Friday?", at: "2026-09-03T12:00:00Z", senderName: "Sam" }]);
    await addWindows(chatId, [contract.window, lunch.window]);

    // A missing accent and a dropped letter.
    const hits = await hybridSearch(testDb.database, { query: "rental agrement cafe", personId: sam });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0]!.messages.map((message) => message.id)).toEqual(contract.messageIds);
    expect(hits[0]!.textRank).toBe(1);
    expect(hits[0]!.vectorRank).toBeNull();
    expect(hits[0]!.chatName).toBe("Sam");
    expect(hits[0]!.messages[0]).toMatchObject({ senderName: "Sam", fromOwner: false, at: "2026-09-01T09:00:00.000Z" });
    expect(hits.some((hit) => hit.messages.some((message) => lunch.messageIds.includes(message.id)))).toBe(false);

    expect(await hybridSearch(testDb.database, { query: "passport" , personId: sam })).toEqual([]);
  });

  it("applies person, context, date, and chat mode filters", async () => {
    const jordan = await makePerson("Jordan");
    const elena = await makePerson("Elena");
    const workChat = await makeChat({ personId: jordan, contextId: workId });
    const personalChat = await makeChat({ personId: elena, contextId: personalId });
    const group = await makeChat({ name: "Family", isGroup: true, mode: "mentions_only", contextId: personalId });
    const offChat = await makeChat({ contextId: workId });

    const work = await makeWindow(workChat, [{ body: "The September invoice for project Delta", at: "2026-08-10T10:00:00Z", senderName: "Jordan" }]);
    const personal = await makeWindow(personalChat, [{ body: "The power invoice this month was high", at: "2026-09-10T10:00:00Z", senderName: "Elena" }]);
    const inGroup = await makeWindow(group, [
      { body: "Who paid the internet invoice?", at: "2026-09-12T18:00:00Z", senderName: "Jordan", personId: jordan },
    ]);
    const off = await makeWindow(offChat, [{ body: "Secret invoice", at: "2026-09-11T10:00:00Z", senderName: "X" }]);
    await addWindows(workChat, [work.window]);
    await addWindows(personalChat, [personal.window]);
    await addWindows(group, [inGroup.window]);
    await addWindows(offChat, [off.window]);
    await testDb.database.db.update(chats).set({ mode: "off" }).where(eq(chats.id, offChat));

    const chatsOf = (hits: Awaited<ReturnType<typeof hybridSearch>>) => new Set(hits.map((hit) => hit.chatId));

    const all = await hybridSearch(testDb.database, { query: "invoice", limit: 50 });
    expect(chatsOf(all)).toEqual(new Set([workChat, personalChat, group]));

    const byPerson = await hybridSearch(testDb.database, { query: "invoice", personId: jordan, limit: 50 });
    expect(chatsOf(byPerson)).toEqual(new Set([workChat, group]));

    const byContext = await hybridSearch(testDb.database, { query: "invoice", contextId: personalId, limit: 50 });
    expect(chatsOf(byContext)).toEqual(new Set([personalChat, group]));

    const byDate = await hybridSearch(testDb.database, { query: "invoice", from: "2026-09-01T00:00:00Z", to: "2026-09-11T00:00:00Z", limit: 50 });
    expect(chatsOf(byDate)).toEqual(new Set([personalChat]));

    const combined = await hybridSearch(testDb.database, { query: "invoice", personId: jordan, contextId: personalId, from: new Date("2026-09-01T00:00:00Z"), limit: 50 });
    expect(chatsOf(combined)).toEqual(new Set([group]));
  });

  it("only returns messages inside the date range", async () => {
    const chatId = await makeChat({});
    const window = await makeWindow(chatId, [
      { body: "Meeting with the bank about the loan", at: "2026-07-31T23:50:00Z", senderName: "Robin" },
      { body: "Loan approved", at: "2026-08-01T00:10:00Z", senderName: "Robin" },
    ]);
    await addWindows(chatId, [window.window]);
    const hits = await hybridSearch(testDb.database, { query: "loan bank", from: "2026-08-01T00:00:00Z" });
    const hit = hits.find((entry) => entry.chatId === chatId)!;
    expect(hit.messages.map((message) => message.id)).toEqual([window.messageIds[1]]);
  });

  it("never returns purged chats", async () => {
    const chatId = await makeChat({});
    const window = await makeWindow(chatId, [{ body: "The door code is with the neighbour", at: "2026-09-02T10:00:00Z" }]);
    await addWindows(chatId, [window.window]);
    expect((await hybridSearch(testDb.database, { query: "door code neighbour" })).some((hit) => hit.chatId === chatId)).toBe(true);
    await testDb.database.transaction(({ db }) => purgeChatData(db, chatId));
    expect((await hybridSearch(testDb.database, { query: "door code neighbour" })).some((hit) => hit.chatId === chatId)).toBe(false);
    expect(await listChatChunks(testDb.database.db, chatId)).toEqual([]);
  });

  it("finds chunks by vector from the same model and fuses both lists", async () => {
    const chatId = await makeChat({ contextId: workId });
    const invoice = await makeWindow(chatId, [{ body: "Send me this month's bill", at: "2026-09-05T08:00:00Z", senderName: "Chris" }]);
    const both = await makeWindow(chatId, [{ body: "Invoice number 42 was paid", at: "2026-09-06T08:00:00Z", senderName: "Chris" }]);
    const other = await makeWindow(chatId, [{ body: "It will rain tomorrow", at: "2026-09-07T08:00:00Z", senderName: "Chris" }]);
    await addWindows(chatId, [invoice.window, both.window, other.window]);
    const chunks = await listChatChunks(testDb.database.db, chatId);
    const byFirst = (ids: string[]) => chunks.find((chunk) => chunk.messageIds[0] === ids[0])!;
    const now = new Date();
    await storeChunkEmbedding(testDb.database.db, byFirst(invoice.messageIds), "mock/concepts@8", axis(0), now);
    await storeChunkEmbedding(testDb.database.db, byFirst(both.messageIds), "mock/concepts@8", axis(0).map((v, i) => (i === 1 ? 0.3 : v)), now);
    await storeChunkEmbedding(testDb.database.db, byFirst(other.messageIds), "mock/concepts@8", axis(2), now);

    const hits = await hybridSearch(testDb.database, {
      query: "invoice",
      contextId: workId,
      queryEmbedding: { modelKey: "mock/concepts@8", vector: axis(0) },
      limit: 3,
    });
    const ids = hits.map((hit) => hit.messages[0]!.id);
    // "Invoice number 42" is in both lists and wins; "bill" only matches by vector.
    expect(ids[0]).toBe(both.messageIds[0]);
    expect(hits[0]!.vectorRank).not.toBeNull();
    expect(hits[0]!.textRank).not.toBeNull();
    expect(ids[1]).toBe(invoice.messageIds[0]);
    expect(hits[1]!.textRank).toBeNull();

    // Vectors from another model are never compared.
    const otherModel = await hybridSearch(testDb.database, {
      query: "zzzz",
      contextId: workId,
      queryEmbedding: { modelKey: "mock/other@8", vector: axis(0) },
    });
    expect(otherModel).toEqual([]);
  });
});

describe("chunk maintenance", () => {
  it("keeps unchanged windows with their vectors and replaces changed ones", async () => {
    const chatId = await makeChat({});
    const first = await makeWindow(chatId, [{ body: "Breakfast", at: "2026-09-01T07:00:00Z" }]);
    const second = await makeWindow(chatId, [{ body: "Lunch", at: "2026-09-01T12:00:00Z" }]);
    expect(await syncChatChunks(testDb.database, chatId, [first.window, second.window])).toEqual({ synced: true, inserted: 2, deleted: 0, kept: 0 });
    const todo = await listChunksToEmbed(testDb.database.db, chatId, "mock/a");
    expect(todo).toHaveLength(2);
    for (const chunk of todo) await storeChunkEmbedding(testDb.database.db, chunk, "mock/a", axis(1), new Date());
    expect(await listChunksToEmbed(testDb.database.db, chatId, "mock/a")).toEqual([]);
    expect(await listChunksToEmbed(testDb.database.db, chatId, "mock/b")).toHaveLength(2);

    const changed = { ...second.window, text: `${second.window.text} [image: a sandwich]` };
    expect(await syncChatChunks(testDb.database, chatId, [first.window, changed])).toEqual({ synced: true, inserted: 1, deleted: 1, kept: 1 });
    const rows = await listChatChunks(testDb.database.db, chatId);
    expect(rows.map((row) => [row.contentHash, row.hasEmbedding])).toEqual([
      [chunkContentHash(first.window), true],
      [chunkContentHash(changed), false],
    ]);

    // A stored vector is dropped when its chunk was replaced meanwhile.
    expect(await storeChunkEmbedding(testDb.database.db, { id: rows[1]!.id, contentHash: "stale" }, "mock/a", axis(1), new Date())).toBe(false);
  });

  it("does not insert windows whose messages are gone and clears Off chats", async () => {
    const chatId = await makeChat({});
    const window = await makeWindow(chatId, [{ body: "Hello", at: "2026-09-01T07:00:00Z" }]);
    const ghost: ChunkWindow = { messageIds: [newId()], text: "Contact: deleted", fromAt: new Date(), toAt: new Date() };
    expect(await syncChatChunks(testDb.database, chatId, [window.window, ghost])).toMatchObject({ inserted: 1 });
    await testDb.database.db.update(chats).set({ mode: "off" }).where(eq(chats.id, chatId));
    expect(await syncChatChunks(testDb.database, chatId, [window.window])).toEqual({ synced: false, inserted: 0, deleted: 1, kept: 0 });
    expect(await testDb.database.db.select().from(messageChunks).where(eq(messageChunks.chatId, chatId))).toEqual([]);
  });

  it("lists chats with new content or chunks the current model has not embedded", async () => {
    const chatId = await makeChat({});
    const window = await makeWindow(chatId, [{ body: "Meeting at 10", at: "2026-09-01T07:00:00Z" }]);
    const list = (modelKey: string | null, includeUnembedded = true) =>
      listChatsNeedingEmbedding(testDb.database.db, { modelKey, includeUnembedded, limit: 1000 });

    expect(await list(null)).toContain(chatId);
    await syncChatChunks(testDb.database, chatId, [window.window]);
    await markChatEmbedded(testDb.database.db, chatId, new Date(Date.now() + 1000));
    expect(await list(null)).not.toContain(chatId);
    expect(await list("mock/a")).toContain(chatId);
    expect(await list("mock/a", false)).not.toContain(chatId);

    for (const chunk of await listChunksToEmbed(testDb.database.db, chatId, "mock/a")) {
      await storeChunkEmbedding(testDb.database.db, chunk, "mock/a", axis(1), new Date());
    }
    expect(await list("mock/a")).not.toContain(chatId);
    // Model change.
    expect(await list("mock/b")).toContain(chatId);

    await markChatEmbedded(testDb.database.db, chatId, new Date(Date.now() - 60_000));
    expect(await list("mock/a")).toContain(chatId);
  });

  it("queues legacy chunk hashes for a one-time rebuild even without an embedding provider", async () => {
    const chatId = await makeChat({});
    const window = await makeWindow(chatId, [{ body: "A long imported document", at: "2026-09-01T07:00:00Z" }]);
    await syncChatChunks(testDb.database, chatId, [window.window]);
    await markChatEmbedded(testDb.database.db, chatId, new Date(Date.now() + 1000));
    await testDb.database.db.update(messageChunks).set({ contentHash: "a".repeat(64) }).where(eq(messageChunks.chatId, chatId));

    expect(await listChatsNeedingEmbedding(testDb.database.db, { modelKey: null, includeUnembedded: false, limit: 1000 })).toContain(chatId);
    await syncChatChunks(testDb.database, chatId, [window.window]);
    await markChatEmbedded(testDb.database.db, chatId, new Date(Date.now() + 1000));
    expect(await listChatsNeedingEmbedding(testDb.database.db, { modelKey: null, includeUnembedded: false, limit: 1000 })).not.toContain(chatId);
  });
});
