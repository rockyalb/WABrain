import type { Providers } from "@wabrain/agent";
import { createMockProviders, scriptedJsonModel } from "@wabrain/agent/testing";
import { TaskService, completeMediaObject, getProfileProgress, newId, requestProfileCatchUp, schema } from "@wabrain/db";
import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProvidersState } from "../providers.js";
import { defaultPipelineConfig } from "./config.js";
import type { PipelineDeps } from "./deps.js";
import { PROFILE_BATCH_MESSAGES, runChatProfile, sweepProfiles } from "./profile.js";

const silent = { info() {}, warn() {}, error() {} };
const nolimit = { dailyTokenLimit: null, dailyCallLimit: null };

let testDb: TestDatabase;
let seq = 0;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb?.drop();
});

interface Harness {
  deps: PipelineDeps;
  enqueued: string[];
}

function harness(providers: Providers | null, limits: Partial<ProvidersState["limits"]> = {}): Harness {
  const enqueued: string[] = [];
  const notifier = { notify() {} };
  const deps: PipelineDeps = {
    database: testDb.database,
    queue: {
      enqueue: async (name, data) => (enqueued.push(`${name}:${(data as { chatId?: string }).chatId ?? ""}`), "job"),
      debounceChat: async () => {},
    },
    providers: {
      load: async () => ({
        providers,
        error: providers ? null : "No text provider is configured",
        roles: { text: null, vision: null, transcription: null, embedding: null },
        limits: { text: nolimit, vision: nolimit, transcription: nolimit, embedding: nolimit, ...limits },
      }),
    },
    tasks: new TaskService({ database: testDb.database, notifier }),
    notifier,
    push: { flushPending: async () => {} },
    media: null,
    logger: silent,
    config: defaultPipelineConfig(),
    now: () => new Date(),
  };
  return { deps, enqueued };
}

/** The profile prompt's conversation messages (one JSON object per line). */
function conversation(prompt: string): Array<{ id: string; text?: string; derived?: { text: string } }> {
  const body = prompt.split("<conversation>")[1]!.split("</conversation>")[0]!;
  return body
    .split("\n")
    .filter((line) => line.trim().startsWith("{"))
    .map((line) => JSON.parse(line) as { id: string; text?: string; derived?: { text: string } });
}

/** Proposes the fact "works as an engineer" when a message says so, and records every prompt. */
function factModel(seen: string[][], options: { fail?: () => boolean } = {}) {
  return scriptedJsonModel(({ text }) => {
    if (options.fail?.()) throw new Error("provider down");
    const messages = conversation(text);
    seen.push(messages.map((message) => message.id));
    const source = messages.find((message) => /engineer/i.test(`${message.text ?? ""} ${message.derived?.text ?? ""}`));
    return {
      facts: source
        ? [{ subject: "this_person", key: "role", value: "engineer", confidence: 0.9, selfClaimed: true, sourceMessageIds: [source.id] }]
        : [],
    };
  });
}

async function makeDirectChat(chatId = newId()) {
  seq += 1;
  const personId = newId();
  const jid = `446922${String(seq).padStart(4, "0")}@s.whatsapp.net`;
  await testDb.database.db.insert(schema.people).values({ id: personId, displayName: `Contact ${seq}`, primaryJid: jid });
  await testDb.database.db.insert(schema.chats).values({ id: chatId, jid, isGroup: false, mode: "on", personId });
  return { chatId, personId };
}

/** Inserts messages one by one (so storage order follows the list), oldest `sentAt` first. */
async function addMessages(chatId: string, bodies: string[], options: { source?: "webhook" | "history"; startMinutes?: number } = {}) {
  const ids: string[] = [];
  for (const [index, body] of bodies.entries()) {
    const id = newId();
    await testDb.database.db.insert(schema.messages).values({
      id,
      chatId,
      waMessageId: `wa-${id}`,
      senderJid: "contact@s.whatsapp.net",
      senderName: "Contact",
      direction: "incoming",
      fromOwner: false,
      kind: "text",
      body,
      source: options.source ?? "webhook",
      sentAt: new Date(Date.parse("2026-06-01T08:00:00Z") + ((options.startMinutes ?? 0) + index) * 60_000),
    });
    ids.push(id);
  }
  return ids;
}

async function factsOf(personId: string) {
  return testDb.database.db.select().from(schema.personFacts).where(eq(schema.personFacts.personId, personId));
}

/** Runs profile-chat like the queue would: again while the run asks for another batch. */
async function runUntilIdle(h: Harness, chatId: string, max = 10) {
  const outcomes = [];
  for (let run = 0; run < max; run += 1) {
    const outcome = await runChatProfile(h.deps, chatId);
    outcomes.push(outcome);
    if (outcome.status !== "profiled" || !outcome.more) break;
  }
  return outcomes;
}

describe("profile-chat over imported history", () => {
  it("extracts facts older than the latest batch by reading every imported message in checkpointed batches", async () => {
    const { chatId, personId } = await makeDirectChat();
    // Live messages first, then 90 imported messages (older by sent time, stored later).
    await addMessages(chatId, ["Good morning", "How are you?"], { startMinutes: 10_000 });
    const history = Array.from({ length: 90 }, (_, index) => (index === 0 ? "I have been a civil engineer for 10 years" : `old message ${index}`));
    const [factId] = await addMessages(chatId, history, { source: "history" });
    expect(await requestProfileCatchUp(testDb.database.db, chatId)).toBe(true);

    const seen: string[][] = [];
    const h = harness(createMockProviders({ text: factModel(seen) }));
    const outcomes = await runUntilIdle(h, chatId);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(["profiled", "profiled", "profiled"]);
    expect(outcomes.map((outcome) => (outcome.status === "profiled" ? outcome.messages : 0))).toEqual([PROFILE_BATCH_MESSAGES, PROFILE_BATCH_MESSAGES, 12]);
    // Each batch asks for the next one while the catch-up lasts, all on the same day.
    expect(h.enqueued).toEqual([`profile-chat:${chatId}`, `profile-chat:${chatId}`]);
    // Every message was read exactly once, including the fact far older than the latest 40.
    expect(seen.flat()).toHaveLength(92);
    expect(new Set(seen.flat()).size).toBe(92);
    expect(seen.flat()).toContain(factId);
    expect(await factsOf(personId)).toEqual([expect.objectContaining({ key: "role", value: "engineer", source: "ai" })]);

    const progress = await getProfileProgress(testDb.database.db, chatId);
    expect(progress.target).toBeNull();
    expect(progress.cursor).not.toBeNull();
    // Once caught up, the daily limit applies again: a new message waits for the next day's run.
    await addMessages(chatId, ["Faleminderit"], { startMinutes: 20_000 });
    expect(await runChatProfile(h.deps, chatId)).toEqual({ status: "skipped", reason: "already_today" });
    expect(seen).toHaveLength(3);
    const dayLater = (days: number) => ({ ...h.deps, now: () => new Date(Date.now() + days * 86_400_000) });
    expect(await runChatProfile(dayLater(1), chatId)).toMatchObject({ status: "profiled", messages: 1, more: false });
    expect(await runChatProfile(dayLater(2), chatId)).toEqual({ status: "skipped", reason: "up_to_date" });
  });

  it("profiles an import that finished before any provider existed once one is configured", async () => {
    const { chatId, personId } = await makeDirectChat();
    await addMessages(chatId, ["I am an engineer", ...Array.from({ length: 50 }, (_, index) => `history ${index}`)], { source: "history" });
    expect(await requestProfileCatchUp(testDb.database.db, chatId)).toBe(true);

    const none = harness(null);
    expect(await runChatProfile(none.deps, chatId)).toEqual({ status: "skipped", reason: "no_provider" });
    // Nothing was recorded: no checkpoint and no daily claim.
    expect(await getProfileProgress(testDb.database.db, chatId)).toMatchObject({ cursor: null, lastProfileDate: null, target: expect.anything() });
    // The sweep does nothing without a provider.
    expect(await sweepProfiles(none.deps, none.deps.queue, new Date())).toBe(0);
    expect(none.enqueued).toEqual([]);

    // Off chats and groups are never profiled.
    const off = await makeDirectChat();
    await addMessages(off.chatId, ["Sekret"]);
    await testDb.database.db.update(schema.chats).set({ mode: "off" }).where(eq(schema.chats.id, off.chatId));
    const group = await makeDirectChat();
    await addMessages(group.chatId, ["Grupi"]);
    await testDb.database.db.update(schema.chats).set({ isGroup: true }).where(eq(schema.chats.id, group.chatId));
    expect(await requestProfileCatchUp(testDb.database.db, off.chatId)).toBe(false);

    const seen: string[][] = [];
    const ready = harness(createMockProviders({ text: factModel(seen) }));
    await sweepProfiles(ready.deps, ready.deps.queue, new Date(), 1000);
    expect(ready.enqueued).toContain(`profile-chat:${chatId}`);
    expect(ready.enqueued).not.toContain(`profile-chat:${off.chatId}`);
    expect(ready.enqueued).not.toContain(`profile-chat:${group.chatId}`);
    const outcomes = await runUntilIdle(ready, chatId);
    expect(outcomes.every((outcome) => outcome.status === "profiled")).toBe(true);
    expect(seen.flat()).toHaveLength(51);
    expect(await factsOf(personId)).toEqual([expect.objectContaining({ key: "role", value: "engineer" })]);

    // Done: the sweep no longer lists the chat today.
    ready.enqueued.length = 0;
    await sweepProfiles(ready.deps, ready.deps.queue, new Date(), 1000);
    expect(ready.enqueued).not.toContain(`profile-chat:${chatId}`);
  });

  it("retries the same day after a model failure (the day is recorded only after success)", async () => {
    const { chatId, personId } = await makeDirectChat();
    await addMessages(chatId, ["I am an engineer", "Working today"]);
    let failing = true;
    const seen: string[][] = [];
    const h = harness(createMockProviders({ text: factModel(seen, { fail: () => failing }) }));

    await expect(runChatProfile(h.deps, chatId)).rejects.toThrow();
    expect(await getProfileProgress(testDb.database.db, chatId)).toMatchObject({ cursor: null, lastProfileDate: null });
    expect(await factsOf(personId)).toEqual([]);

    failing = false;
    const retried = await runChatProfile(h.deps, chatId);
    expect(retried).toMatchObject({ status: "profiled", facts: 1, messages: 2, more: false });
    expect(await factsOf(personId)).toHaveLength(1);
  });

  it("waits for old unfinished media and profiles its derived facts on a later sweep", async () => {
    const { chatId, personId } = await makeDirectChat();
    const [messageId] = await addMessages(chatId, [""], { source: "history" });
    const mediaId = newId();
    await testDb.database.db.update(schema.messages).set({ kind: "audio" }).where(eq(schema.messages.id, messageId!));
    await testDb.database.db.insert(schema.mediaObjects).values({ id: mediaId, messageId: messageId!, kind: "audio", status: "pending", createdAt: new Date("2026-01-01") });
    await requestProfileCatchUp(testDb.database.db, chatId);
    const seen: string[][] = [];
    const h = harness(createMockProviders({ text: factModel(seen) }));
    expect(await runChatProfile(h.deps, chatId)).toEqual({ status: "waiting_media", pending: 1 });
    expect(await getProfileProgress(testDb.database.db, chatId)).toMatchObject({ cursor: null, lastProfileDate: null });
    expect(seen).toEqual([]);

    await completeMediaObject(testDb.database.db, { id: mediaId, messageId: messageId!, derivedText: "I am an engineer", language: "en", contentSha256: "test-digest", sizeBytes: 128, setMessageLanguage: true });
    await sweepProfiles(h.deps, h.deps.queue, new Date(), 1000);
    expect(h.enqueued).toContain(`profile-chat:${chatId}`);
    expect(await runChatProfile(h.deps, chatId)).toMatchObject({ status: "profiled", messages: 1, facts: 1 });
    expect(await factsOf(personId)).toEqual([expect.objectContaining({ value: "engineer" })]);
    expect(await getProfileProgress(testDb.database.db, chatId)).toMatchObject({ cursor: { messageId }, target: null });
  });

  it("does not let media-blocked chats starve ready chats in a bounded sweep", async () => {
    const blocked = await makeDirectChat("00000000-0000-4000-8000-000000000001");
    const ready = await makeDirectChat("00000000-0000-4000-8000-000000000002");
    const [messageId] = await addMessages(blocked.chatId, [""]);
    await testDb.database.db.insert(schema.mediaObjects).values({ id: newId(), messageId: messageId!, kind: "audio", status: "pending" });
    await addMessages(ready.chatId, ["I am an engineer"]);
    await requestProfileCatchUp(testDb.database.db, blocked.chatId);
    await requestProfileCatchUp(testDb.database.db, ready.chatId);
    const h = harness(createMockProviders({ text: factModel([]) }));
    expect(await sweepProfiles(h.deps, h.deps.queue, new Date(), 1)).toBe(1);
    expect(h.enqueued).toEqual([`profile-chat:${ready.chatId}`]);
    expect(await runChatProfile(h.deps, ready.chatId)).toMatchObject({ status: "profiled", facts: 1 });
  });

  it("keeps part of the text budget for live analysis while catching up", async () => {
    const { chatId } = await makeDirectChat();
    await addMessages(chatId, Array.from({ length: 45 }, (_, index) => `history ${index}`), { source: "history" });
    await requestProfileCatchUp(testDb.database.db, chatId);
    const limits = { text: { dailyTokenLimit: null, dailyCallLimit: 1_000 } };
    const { db } = testDb.database;
    // 850 of 1,000 calls used today: over the catch-up share (80%), under the limit.
    await db.insert(schema.modelUsage).values(
      Array.from({ length: 850 }, () => ({ id: newId(), role: "text" as const, purpose: "analysis", provider: "mock", model: "m", inputTokens: 1, outputTokens: 1 })),
    );
    const seen: string[][] = [];
    const h = harness(createMockProviders({ text: factModel(seen) }), limits);
    expect(await runChatProfile(h.deps, chatId)).toEqual({ status: "skipped", reason: "budget" });
    await sweepProfiles(h.deps, h.deps.queue, new Date(), 1000);
    expect(h.enqueued).not.toContain(`profile-chat:${chatId}`);
    expect(seen).toEqual([]);

    // A chat that is not catching up still gets its daily run.
    const live = await makeDirectChat();
    await addMessages(live.chatId, ["See you tomorrow"]);
    expect(await runChatProfile(h.deps, live.chatId)).toMatchObject({ status: "profiled", messages: 1, more: false });
    await db.delete(schema.modelUsage).where(eq(schema.modelUsage.purpose, "analysis"));
  });
});
