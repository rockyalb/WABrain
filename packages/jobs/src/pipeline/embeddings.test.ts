import type { Providers } from "@wabrain/agent";
import { createMockProviders } from "@wabrain/agent/testing";
import { listChatChunks, newId, normalizeSearchText, schema, sha256Hex, updateChatPipelineState } from "@wabrain/db";
import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { MockEmbeddingModelV4 } from "ai/test";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProvidersState } from "../providers.js";
import { listDeferrals } from "./budget.js";
import { defaultPipelineConfig } from "./config.js";
import type { PipelineQueue } from "./deps.js";
import { embeddingEndpointId, embeddingModelKey, runChatEmbedding, searchChats, sweepEmbeddings, type EmbeddingDeps } from "./embeddings.js";

const silent = { info() {}, warn() {}, error() {} };
const DIMS = 8;

let testDb: TestDatabase;
let seq = 0;

/** Maps words to concept axes, so "invoice" and "bill" land close together without sharing trigrams. */
const CONCEPTS: RegExp[] = [/bill|invoice|payment/i, /contract/i, /dinner|restaurant/i];
function conceptVector(text: string): number[] {
  const vector = CONCEPTS.map((pattern) => (pattern.test(text) ? 1 : 0));
  return [...vector, ...new Array(DIMS - vector.length - 1).fill(0), 0.05];
}

function conceptModel(calls: { batches: number; texts: string[] }, options: { fail?: boolean } = {}) {
  return new MockEmbeddingModelV4({
    provider: "mock",
    modelId: "concepts",
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values }) => {
      if (options.fail) throw new Error("provider down");
      calls.batches += 1;
      calls.texts.push(...values);
      return { embeddings: values.map(conceptVector), usage: { tokens: values.length * 3 }, warnings: [] };
    },
  });
}

function providersWith(modelId: string, calls: { batches: number; texts: string[] }, options: { fail?: boolean } = {}): Providers {
  const base = createMockProviders({ embedding: null });
  return { ...base, embedding: { model: conceptModel(calls, options), provider: "mock", modelId, dimensions: DIMS } };
}

const nolimit = { dailyTokenLimit: null, dailyCallLimit: null };
const roles = { text: null, vision: null, transcription: null, embedding: null };

function deps(providers: Providers | null, limits: Partial<ProvidersState["limits"]> = {}): EmbeddingDeps {
  return {
    database: testDb.database,
    providers: {
      load: async () => ({
        providers,
        error: null,
        roles,
        limits: { text: nolimit, vision: nolimit, transcription: nolimit, embedding: nolimit, ...limits },
      }),
    },
    logger: silent,
    config: defaultPipelineConfig(),
    now: () => new Date(),
  };
}

async function makeChat(options: { mode?: "on" | "off" } = {}) {
  const id = newId();
  seq += 1;
  const personId = newId();
  await testDb.database.db.insert(schema.people).values({ id: personId, displayName: `Person ${seq}`, primaryJid: `446911${seq}@s.whatsapp.net` });
  await testDb.database.db.insert(schema.chats).values({ id, jid: `446911${seq}@s.whatsapp.net`, isGroup: false, mode: options.mode ?? "on", personId });
  return id;
}

async function addMessage(chatId: string, body: string, minutes: number, extra: Partial<typeof schema.messages.$inferInsert> = {}) {
  const id = newId();
  await testDb.database.db.insert(schema.messages).values({
    id,
    chatId,
    waMessageId: `wa-${id}`,
    senderJid: "contact@s.whatsapp.net",
    senderName: "Sam",
    direction: "incoming",
    fromOwner: false,
    kind: "text",
    body,
    source: "webhook",
    sentAt: new Date(Date.parse("2026-09-01T08:00:00Z") + minutes * 60_000),
    ...extra,
  });
  return id;
}

/** Moves the chat's watermark past its messages (runs leave a 30 s safety margin). */
async function settle(chatId: string) {
  await updateChatPipelineState(testDb.database.db, chatId, { lastEmbeddedAt: new Date(Date.now() + 60_000) });
}

function recordingQueue(queued: string[]): Pick<PipelineQueue, "enqueue"> {
  return {
    enqueue: async (_name, data) => {
      queued.push(String((data as { chatId?: string }).chatId));
      return "job";
    },
  };
}

async function resetDeferrals() {
  await testDb.database.db.delete(schema.appState).where(eq(schema.appState.key, "pipeline.deferrals"));
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb?.drop();
});

describe("embed-chat", () => {
  it("chunks and embeds a chat, records the model on each row, and skips unchanged windows", async () => {
    const chatId = await makeChat();
    await addMessage(chatId, "Can you send the contract tomorrow?", 0);
    await addMessage(chatId, "Yes, tomorrow", 1, { fromOwner: true, direction: "outgoing", senderName: null });
    await addMessage(chatId, "Dinner out on Saturday?", 300);
    const calls = { batches: 0, texts: [] as string[] };
    const providers = providersWith("concepts", calls);

    const first = await runChatEmbedding(deps(providers), chatId);
    expect(first).toMatchObject({ status: "done", chunks: { inserted: 2, deleted: 0, kept: 0 }, embedded: 2, model: "mock/concepts@8", reason: null });
    const chunks = await listChatChunks(testDb.database.db, chatId);
    expect(chunks.map((chunk) => [chunk.text, chunk.embeddingModel, chunk.hasEmbedding])).toEqual([
      ["Sam: Can you send the contract tomorrow?\nMe: Yes, tomorrow", "mock/concepts@8", true],
      ["Sam: Dinner out on Saturday?", "mock/concepts@8", true],
    ]);
    const usage = await testDb.database.db.select().from(schema.modelUsage).where(eq(schema.modelUsage.refId, chatId));
    expect(usage).toMatchObject([{ role: "embedding", purpose: "embed", inputTokens: 6 }]);

    // Nothing changed: no model call.
    const again = await runChatEmbedding(deps(providers), chatId);
    expect(again).toMatchObject({ status: "done", chunks: { inserted: 0, deleted: 0, kept: 2 }, embedded: 0 });
    expect(calls.batches).toBe(1);

    // A new message only re-embeds the conversation's last window.
    await addMessage(chatId, "At the new restaurant", 301);
    const third = await runChatEmbedding(deps(providers), chatId);
    expect(third).toMatchObject({ chunks: { inserted: 1, deleted: 1, kept: 1 }, embedded: 1 });
    expect(calls.texts.at(-1)).toBe("Sam: Dinner out on Saturday? Sam: At the new restaurant");
  });

  it("re-embeds every chunk when the embedding model changes", async () => {
    const chatId = await makeChat();
    await addMessage(chatId, "Fatura e korrikut", 0);
    await addMessage(chatId, "Kontrata e re", 500);
    const v1 = { batches: 0, texts: [] as string[] };
    await runChatEmbedding(deps(providersWith("concepts", v1)), chatId);
    expect(v1.texts).toHaveLength(2);
    await settle(chatId);

    const queued: string[] = [];
    const queue = recordingQueue(queued);
    // Same model: nothing to do for this chat.
    await sweepEmbeddings(deps(providersWith("concepts", v1)), queue, new Date());
    expect(queued).not.toContain(chatId);

    const v2 = { batches: 0, texts: [] as string[] };
    const changed = deps(providersWith("concepts-v2", v2));
    await sweepEmbeddings(changed, queue, new Date());
    expect(queued).toContain(chatId);

    const outcome = await runChatEmbedding(changed, chatId);
    expect(outcome).toMatchObject({ status: "done", chunks: { inserted: 0, deleted: 0, kept: 2 }, embedded: 2, model: "mock/concepts-v2@8" });
    expect(v2.texts).toHaveLength(2);
    await settle(chatId);
    const chunks = await listChatChunks(testDb.database.db, chatId);
    expect(chunks.every((chunk) => chunk.embeddingModel === "mock/concepts-v2@8" && chunk.hasEmbedding)).toBe(true);

    queued.length = 0;
    await sweepEmbeddings(changed, queue, new Date());
    expect(queued).not.toContain(chatId);
  });

  it("keeps chunks for trigram search without an embedding provider, and embeds them once one exists", async () => {
    const chatId = await makeChat();
    await addMessage(chatId, "Send me the power bill", 0);
    const outcome = await runChatEmbedding(deps(createMockProviders({ embedding: null })), chatId);
    expect(outcome).toMatchObject({ status: "done", chunks: { inserted: 1 }, embedded: 0, model: null, reason: "no_provider" });

    const found = await searchChats(deps(null), { query: "power bill" });
    expect(found.vectorSearch).toBe(false);
    expect(found.hits.map((hit) => hit.chatId)).toContain(chatId);

    const queued: string[] = [];
    const calls = { batches: 0, texts: [] as string[] };
    await sweepEmbeddings(deps(providersWith("concepts", calls)), recordingQueue(queued), new Date());
    expect(queued).toContain(chatId);
    expect(await runChatEmbedding(deps(providersWith("concepts", calls)), chatId)).toMatchObject({ embedded: 1, reason: null });
  });

  it("defers on budget and provider errors without failing the job", async () => {
    await resetDeferrals();
    const chatId = await makeChat();
    await addMessage(chatId, "Kontrata me klientin", 0);
    const calls = { batches: 0, texts: [] as string[] };
    const overBudget = await runChatEmbedding(deps(providersWith("concepts", calls), { embedding: { dailyTokenLimit: null, dailyCallLimit: 0 } }), chatId);
    expect(overBudget).toMatchObject({ status: "done", embedded: 0, reason: "budget" });
    expect(calls.batches).toBe(0);
    expect((await listDeferrals(testDb.database, new Date())).map((deferral) => deferral.role)).toContain("embedding");
    // While deferred, neither the job nor the sweep call the model for unembedded chunks.
    expect(await runChatEmbedding(deps(providersWith("concepts", calls)), chatId)).toMatchObject({ reason: "deferred" });
    await settle(chatId);
    const queued: string[] = [];
    await sweepEmbeddings(deps(providersWith("concepts", calls)), recordingQueue(queued), new Date());
    expect(queued).not.toContain(chatId);

    await resetDeferrals();
    const failing = await runChatEmbedding(deps(providersWith("concepts", calls, { fail: true })), chatId);
    expect(failing).toMatchObject({ status: "done", embedded: 0, reason: "provider_error" });
    await resetDeferrals();
  });

  it("waits for recent media and never embeds Off chats", async () => {
    const chatId = await makeChat();
    const messageId = await addMessage(chatId, "", 0, { kind: "image", hasMedia: true });
    await testDb.database.db.insert(schema.mediaObjects).values({ id: newId(), messageId, kind: "image", status: "pending" });
    expect(await runChatEmbedding(deps(providersWith("concepts", { batches: 0, texts: [] })), chatId)).toEqual({ status: "waiting_media", pending: 1 });

    const off = await makeChat({ mode: "off" });
    await addMessage(off, "Sekret", 0);
    expect(await runChatEmbedding(deps(providersWith("concepts", { batches: 0, texts: [] })), off)).toEqual({ status: "skipped", reason: "chat_off" });
    expect(await listChatChunks(testDb.database.db, off)).toEqual([]);
  });
});

describe("searchChats", () => {
  it("embeds the question and fuses vector and trigram results", async () => {
    await resetDeferrals();
    const chatId = await makeChat();
    const invoiceId = await addMessage(chatId, "Send me this month's bill", 0);
    await addMessage(chatId, "The meeting was postponed", 400);
    const calls = { batches: 0, texts: [] as string[] };
    const providers = providersWith("concepts", calls);
    await runChatEmbedding(deps(providers), chatId);

    // "invoice" shares no trigrams with "bill": only the vector search can find it.
    const [chat] = await testDb.database.db.select({ personId: schema.chats.personId }).from(schema.chats).where(eq(schema.chats.id, chatId));
    const result = await searchChats({ ...deps(providers), recordUsage: false }, { query: "invoice", personId: chat!.personId, limit: 3 });
    expect(result.vectorSearch).toBe(true);
    expect(result.hits[0]!.messages.map((message) => message.id)).toEqual([invoiceId]);
    expect(result.hits[0]!.vectorRank).toBe(1);
    expect(calls.texts.at(-1)).toBe("invoice");

    // Trigram-only fallback when the query cannot be embedded.
    const fallback = await searchChats(deps(providersWith("concepts", calls, { fail: true })), { query: "invoice" });
    expect(fallback.vectorSearch).toBe(false);
    expect(fallback.hits.some((hit) => hit.chatId === chatId)).toBe(false);
  });

  it("keys vectors by provider, model, dimensions, and a non-secret endpoint identity", () => {
    // The provider's default endpoint keeps the original key, so existing OpenAI vectors stay valid.
    expect(embeddingModelKey({ provider: "openai", modelId: "text-embedding-3-large", dimensions: 1536 })).toBe(
      "openai/text-embedding-3-large@1536",
    );
    expect(embeddingModelKey({ provider: "openai", modelId: "text-embedding-3-large", dimensions: 1536, baseUrl: null })).toBe(
      "openai/text-embedding-3-large@1536",
    );
    const key = (baseUrl: string) => embeddingModelKey({ provider: "openai-compatible", modelId: "bge-m3", dimensions: 1024, baseUrl });
    const first = key("https://embed.example/v1/");
    // Credentials, query, fragment, and a trailing slash do not change the identity.
    expect(key("https://user:secret@embed.example/v1?token=rotated#x")).toBe(first);
    expect(key("https://other.example/v1")).not.toBe(first);
    expect(key("https://embed.example/v2")).not.toBe(first);
    expect(first).toMatch(/^openai-compatible\/bge-m3@1024#[0-9a-f]{16}$/);
    expect(first).not.toContain("embed.example");
    expect(embeddingEndpointId("https://user:secret@embed.example/v1")).toBe(embeddingEndpointId("https://embed.example/v1"));
    expect(embeddingEndpointId(null)).toBeNull();
    expect(embeddingEndpointId("  ")).toBeNull();
  });

  it("re-embeds when a compatible endpoint with the same model alias and dimensions is switched, and queries only its vectors", async () => {
    await resetDeferrals();
    const chatId = await makeChat();
    const invoiceId = await addMessage(chatId, "Send me this month's bill", 0);
    const atEndpoint = (baseUrl: string, calls: { batches: number; texts: string[] }): Providers => {
      const providers = providersWith("bge-m3", calls);
      return { ...providers, embedding: { ...providers.embedding!, provider: "openai-compatible", baseUrl } };
    };
    const first = { batches: 0, texts: [] as string[] };
    const a = deps(atEndpoint("http://gpu-a.local:8080/v1", first));
    const outcome = await runChatEmbedding(a, chatId);
    expect(outcome).toMatchObject({ status: "done", embedded: 1 });
    const keyA = (outcome as { model: string }).model;
    await settle(chatId);

    const second = { batches: 0, texts: [] as string[] };
    const b = deps(atEndpoint("http://gpu-b.local:8080/v1", second));
    const keyB = embeddingModelKey((await b.providers.load()).providers!.embedding!);
    expect(keyB).not.toBe(keyA);
    expect(keyB.split("#")[0]).toBe(keyA.split("#")[0]);

    // Before re-embedding, a query from endpoint B never compares against endpoint A's vectors.
    const before = await searchChats({ ...b, recordUsage: false }, { query: "invoice", limit: 5 });
    expect(before.vectorSearch).toBe(true);
    expect(before.hits.some((hit) => hit.chatId === chatId)).toBe(false);

    const queued: string[] = [];
    await sweepEmbeddings(b, recordingQueue(queued), new Date());
    expect(queued).toContain(chatId);
    expect(await runChatEmbedding(b, chatId)).toMatchObject({ status: "done", embedded: 1, model: keyB, chunks: { kept: 1 } });
    expect(second.texts).toHaveLength(2); // the query, then the chunk
    const chunks = await listChatChunks(testDb.database.db, chatId);
    expect(chunks.every((chunk) => chunk.embeddingModel === keyB && chunk.hasEmbedding)).toBe(true);

    const after = await searchChats({ ...b, recordUsage: false }, { query: "invoice", limit: 5 });
    expect(after.hits.find((hit) => hit.chatId === chatId)?.messages.map((message) => message.id)).toEqual([invoiceId]);
  });
});

describe("long messages and documents", () => {
  const UNIQUE = "Zqvorlandbridge";

  /** Derived text shaped like a stored text-layer PDF (up to 20,000 characters) with a late unique fact. */
  function longPdfText() {
    const pages = Array.from({ length: 9 }, (_, index) => `Page ${index + 1}: ${"General terms of the contract for monthly services. ".repeat(40)}`);
    return `PDF, 10 pages\n${pages.join("\n")}\nPage 10: The account number for the final payment is ${UNIQUE} 7781.`;
  }

  it("indexes a fact near the end of a long PDF's derived text and cites the message", async () => {
    await resetDeferrals();
    const chatId = await makeChat();
    const text = longPdfText();
    expect(text.length).toBeGreaterThan(18_000);
    expect(text.indexOf(UNIQUE)).toBeGreaterThan(18_000);
    const pdfId = await addMessage(chatId, "", 0, { kind: "document", hasMedia: true, derivedText: text });
    await addMessage(chatId, "Did you get the contract?", 2);

    const calls = { batches: 0, texts: [] as string[] };
    const outcome = await runChatEmbedding(deps(providersWith("concepts", calls)), chatId);
    expect(outcome).toMatchObject({ status: "done", reason: null });
    const chunks = await listChatChunks(testDb.database.db, chatId);
    expect(chunks.length).toBeGreaterThan(4);
    expect(chunks.every((chunk) => chunk.text.length <= 4_000 * 2 && chunk.hasEmbedding)).toBe(true);
    // Every part cites the document message (once), and the tail is in a chunk.
    expect(chunks.every((chunk) => chunk.messageIds.filter((id) => id === pdfId).length <= 1)).toBe(true);
    const tail = chunks.filter((chunk) => chunk.text.includes(UNIQUE));
    expect(tail.length).toBeGreaterThan(0);
    expect(tail.every((chunk) => chunk.messageIds.includes(pdfId))).toBe(true);

    const found = await searchChats(deps(null), { query: "zqvorlandbridge", limit: 3 });
    expect(found.vectorSearch).toBe(false);
    const hit = found.hits.find((entry) => entry.chatId === chatId);
    expect(hit?.textRank).toBe(1);
    expect(hit?.messages.map((message) => message.id)).toContain(pdfId);
    expect(hit?.messages.find((message) => message.id === pdfId)?.derivedText).toContain(UNIQUE);
  });

  it("re-chunks chats indexed by the old truncating chunker once, keeping vectors of unchanged windows", async () => {
    await resetDeferrals();
    const chatId = await makeChat();
    await addMessage(chatId, "Fatura e korrikut", 0);
    const pdfId = await addMessage(chatId, "", 300, { kind: "document", hasMedia: true, derivedText: longPdfText() });
    const calls = { batches: 0, texts: [] as string[] };
    const providers = deps(providersWith("concepts", calls));
    await runChatEmbedding(providers, chatId);

    // Simulate the v1 index: bare-digest hashes, and the document truncated at 4,000 characters.
    const { db } = testDb.database;
    const current = await listChatChunks(db, chatId);
    const short = current.find((chunk) => chunk.text.includes("Fatura e korrikut"))!;
    await db.delete(schema.messageChunks).where(eq(schema.messageChunks.chatId, chatId));
    await db.insert(schema.messageChunks).values([
      { ...rowOf(short, chatId), contentHash: short.contentHash.replace(/^chunks:[^:]+:/, "") },
      {
        ...rowOf({ ...short, messageIds: [pdfId], text: `Sam: [document: ${longPdfText().slice(0, 3_980)}…` }, chatId),
        id: newId(),
        contentHash: sha256Hex("legacy-truncated-window"),
      },
    ]);
    await settle(chatId);
    expect((await searchChats(deps(null), { query: "zqvorlandbridge" })).hits.some((hit) => hit.chatId === chatId)).toBe(false);

    const queued: string[] = [];
    await sweepEmbeddings(deps(null), recordingQueue(queued), new Date());
    expect(queued).toContain(chatId);
    calls.texts.length = 0;
    const outcome = await runChatEmbedding(providers, chatId);
    expect(outcome).toMatchObject({ status: "done", chunks: { deleted: 1, kept: 1 } });
    // The unchanged short window kept its vector; only the document's windows were embedded.
    expect(calls.texts.some((text) => text.includes("Fatura e korrikut"))).toBe(false);
    expect((outcome as { embedded: number }).embedded).toBeGreaterThan(1);
    const hits = (await searchChats(deps(null), { query: "zqvorlandbridge" })).hits.filter((hit) => hit.chatId === chatId);
    expect(hits[0]?.messages.map((message) => message.id)).toContain(pdfId);

    // Idempotent: the chat is not queued again for the format.
    await settle(chatId);
    queued.length = 0;
    await sweepEmbeddings(providers, recordingQueue(queued), new Date());
    expect(queued).not.toContain(chatId);
  });
});

function rowOf(chunk: { id: string; messageIds: string[]; text: string; fromAt: Date; toAt: Date }, chatId: string) {
  return {
    id: chunk.id,
    chatId,
    messageIds: chunk.messageIds,
    text: chunk.text,
    searchText: normalizeSearchText(chunk.text),
    fromAt: chunk.fromAt,
    toAt: chunk.toAt,
    embedding: new Array(1536).fill(0).map((_, index) => (index === 0 ? 1 : 0)),
    embeddingModel: "mock/concepts@8",
    embeddedAt: new Date(),
  };
}
