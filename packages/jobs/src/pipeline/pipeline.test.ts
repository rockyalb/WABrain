import { createMockProviders, mockTranscriptionModel, parseAnalysisPrompt, scriptedJsonModel } from "@wabrain/agent/testing";
import { PROMPT_VERSION, type Providers } from "@wabrain/agent";
import {
  TaskService,
  findChatByJid,
  insertSourceEvent,
  projectSourceEvent,
  recordModelUsage,
  schema,
  updateChat,
  updateSettings,
  upsertPushEndpoint,
  type ChangeEvent,
  type IntakeScheduler,
} from "@wabrain/db";
import { createTestDatabase, makeOpenWaEnvelope, seedTaskCalibration, type TestDatabase } from "@wabrain/db/testing";
import { PushNotifier, type PushPayload } from "@wabrain/notify";
import { createRulesIntakeFilter } from "@wabrain/rules";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ProvidersState } from "../providers.js";
import { runChatAnalysis } from "./analysis.js";
import { defaultPipelineConfig } from "./config.js";
import type { MediaSource, PipelineDeps } from "./deps.js";
import { processMedia, requeueExhaustedVoice } from "./media.js";
import { runNotificationTick } from "./notifications.js";
import { profileRecoveredMedia, runChatProfile } from "./profile.js";
import { buildPdf } from "./test-fixtures/pdf.js";
import { localDay } from "./time.js";

const OWNER = "447690000000@s.whatsapp.net";
const filter = createRulesIntakeFilter({ ownerJids: [OWNER], aliases: ["Alex"] });
const silent = { info() {}, warn() {}, error() {} };

let testDb: TestDatabase;
let jidSeq = 100;
const nextJid = () => `446900${jidSeq++}@s.whatsapp.net`;

const scheduled = { debounced: [] as string[], media: [] as string[] };
const scheduler: IntakeScheduler = {
  debounceAnalysis: async (chatId) => void scheduled.debounced.push(chatId),
  enqueueMedia: async (id) => void scheduled.media.push(id),
};

async function ingest(envelope: ReturnType<typeof makeOpenWaEnvelope>) {
  const { id } = await insertSourceEvent(testDb.database.db, {
    sessionId: envelope.sessionId,
    idempotencyKey: envelope.idempotencyKey,
    deliveryId: envelope.deliveryId,
    eventType: envelope.event,
    chatJid: String(envelope.data.chatId),
    raw: envelope,
  });
  return projectSourceEvent({ database: testDb.database, filter, scheduler }, id);
}

interface Harness {
  deps: PipelineDeps;
  events: ChangeEvent[];
  pushes: PushPayload[];
  enqueued: Array<{ name: string; data: unknown; startAfter?: unknown }>;
  debounced: Array<{ chatId: string; delayMs?: number }>;
  modelCalls: () => number;
}

function harness(options: { providers?: Providers | null; limits?: Partial<ProvidersState["limits"]>; media?: MediaSource | null; now?: () => Date; tasks?: (service: TaskService) => TaskService } = {}): Harness {
  const events: ChangeEvent[] = [];
  const pushes: PushPayload[] = [];
  const enqueued: Harness["enqueued"] = [];
  const debounced: Harness["debounced"] = [];
  const notifier = { notify: (event: ChangeEvent) => void events.push(event) };
  const service = new TaskService({ database: testDb.database, notifier });
  const providers = options.providers === undefined ? createMockProviders() : options.providers;
  const nolimit = { dailyTokenLimit: null, dailyCallLimit: null };
  const deps: PipelineDeps = {
    database: testDb.database,
    queue: {
      enqueue: async (name, data, opts) => (enqueued.push({ name, data, startAfter: opts?.startAfter }), "job"),
      debounceChat: async (chatId, opts) => void debounced.push({ chatId, delayMs: opts?.delayMs }),
    },
    providers: {
      load: async () => ({
        providers,
        error: providers ? null : "No text provider is configured",
        roles: { text: null, vision: null, transcription: null, embedding: null },
        limits: { text: nolimit, vision: nolimit, transcription: nolimit, embedding: nolimit, ...options.limits },
      }),
    },
    tasks: options.tasks ? options.tasks(service) : service,
    notifier,
    // Records the durable notifications queued by this tick (created at the tick's time).
    push: {
      flushPending: async (at = new Date()) => {
        const rows = await testDb.database.db
          .select({ payload: schema.notificationEvents.payload })
          .from(schema.notificationEvents)
          .where(eq(schema.notificationEvents.createdAt, at))
          .orderBy(schema.notificationEvents.id);
        for (const row of rows) pushes.push(row.payload as PushPayload);
      },
    },
    media: options.media ?? null,
    logger: silent,
    config: { ...defaultPipelineConfig(), mediaWaitMaxMs: 60_000 },
    now: options.now ?? (() => new Date()),
  };
  const text = providers?.text.model as { doGenerateCalls?: unknown[] } | undefined;
  return { deps, events, pushes, enqueued, debounced, modelCalls: () => text?.doGenerateCalls?.length ?? 0 };
}

/**
 * Creates a todo for "contract" requests and completes the first open task (else the first create pending
 * in Review) on "sent"/"done".
 */
function taskModel() {
  return scriptedJsonModel(({ text }) => {
    const prompt = parseAnalysisPrompt(text);
    const actions = [];
    for (const message of prompt.newMessages) {
      const lower = message.text.toLowerCase();
      if (lower.includes("contract")) {
        actions.push({
          type: "create", kind: "todo", title: "Send the contract", description: "Sam asks for the contract.", language: "en",
          due: { date: prompt.calendar.tomorrow, time: null }, taskId: null, taskIds: null, contextId: null, contextReason: null, handled: null,
          confidence: 0.95, ambiguityReasons: [], evidenceMessageIds: [message.id],
        });
      }
      const target = prompt.openTasks[0] ?? prompt.pendingTasks[0];
      if ((lower.includes("sent") || lower.includes("done")) && target) {
        actions.push({
          type: "complete", kind: null, title: null, description: null, language: null, due: null,
          taskId: target.id, taskIds: null, contextId: null, contextReason: null, handled: null,
          confidence: 0.95, ambiguityReasons: [], evidenceMessageIds: [message.id],
        });
      }
    }
    return { actions };
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

describe("analysis job", () => {
  beforeEach(async () => {
    await updateSettings(testDb.database.db, { trialDays: 7 });
    await testDb.database.db.update(schema.settings).set({ trialStartedAt: new Date() });
    await testDb.database.db.execute(sql`delete from app_state where key = 'task.calibration'`);
  });

  /** The mock text model's profile, calibrated as if the owner had decided enough Review creates. */
  const calibrateMockProfile = () =>
    seedTaskCalibration(testDb.database.db, { provider: "mock", model: "mock-text", promptVersion: PROMPT_VERSION, threshold: 0.9 });

  /** Mock providers whose text model reports another model id. */
  function otherModelProviders(modelId: string): Providers {
    const providers = createMockProviders({ text: taskModel() });
    (providers.text.model as { modelId: string }).modelId = modelId;
    return { ...providers, text: { ...providers.text, modelId } };
  }

  it("keeps creates in Review on an idle install after the 7-day trial when nothing was calibrated", async () => {
    await testDb.database.db.update(schema.settings).set({ trialStartedAt: new Date(Date.now() - 8 * 86_400_000) });
    const jid = nextJid();
    const stored = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "send me the contract tomorrow" } }));
    if (stored.status !== "stored") throw new Error(stored.status);
    const h = harness({ providers: createMockProviders({ text: taskModel() }) });
    expect(await runChatAnalysis(h.deps, stored.chatId)).toMatchObject({
      outcomes: [{ type: "create", result: "review", decision: { reason: "calibration_required" } }],
    });
    expect(await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.chatId, stored.chatId))).toHaveLength(0);
  });

  it("auto-creates for a calibrated profile and falls back to Review when the model or prompt changes", async () => {
    await updateSettings(testDb.database.db, { trialDays: 0 });
    await calibrateMockProfile();
    const analyze = async (providers: Providers) => {
      const jid = nextJid();
      const stored = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "send me the contract tomorrow" } }));
      if (stored.status !== "stored") throw new Error(stored.status);
      return runChatAnalysis(harness({ providers }).deps, stored.chatId);
    };
    expect(await analyze(createMockProviders({ text: taskModel() }))).toMatchObject({
      outcomes: [{ type: "create", result: "applied", decision: { reason: "auto_create" } }],
    });
    // Another model answering: its proposals have no owner decisions yet.
    expect(await analyze(otherModelProviders("mock-text-v2"))).toMatchObject({
      outcomes: [{ type: "create", result: "review", decision: { reason: "calibration_required" } }],
    });
    // A calibration of the same model under another prompt version does not count either.
    await seedTaskCalibration(testDb.database.db, { provider: "mock", model: "mock-text-v2", promptVersion: "task-analysis/older" });
    expect(await analyze(otherModelProviders("mock-text-v2"))).toMatchObject({
      outcomes: [{ type: "create", result: "review", decision: { reason: "calibration_required" } }],
    });
  });

  it("turns a burst into a review item during the trial, due tomorrow 17:00 in the default timezone (UTC)", async () => {
    const jid = nextJid();
    const stored = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "send me the contract tomorrow" } }));
    if (stored.status !== "stored") throw new Error(stored.status);
    const h = harness({ providers: createMockProviders({ text: taskModel() }) });

    const outcome = await runChatAnalysis(h.deps, stored.chatId);
    expect(outcome).toMatchObject({ status: "analyzed", outcomes: [{ type: "create", result: "review", decision: { reason: "trial_period" } }] });
    const [item] = await testDb.database.db.select().from(schema.reviewItems).where(eq(schema.reviewItems.chatId, stored.chatId));
    const action = item!.action as { dueAt: string; dueHasTime: boolean };
    const tomorrow = localDay(new Date(Date.now() + 86_400_000), "UTC").date;
    expect(action.dueAt).toMatch(new RegExp(`^${tomorrow}T17:00:00\\+00:00$`));
    expect(action.dueHasTime).toBe(false);
    expect(h.events).toEqual([expect.objectContaining({ type: "review", reviewType: "create", title: "Send the contract" })]);
    const [run] = await testDb.database.db.select().from(schema.analysisRuns).where(eq(schema.analysisRuns.chatId, stored.chatId));
    expect(run).toMatchObject({ status: "succeeded", provider: "mock", promptVersion: expect.stringContaining("task-analysis"), usage: { inputTokens: 100, outputTokens: 50 } });
    expect(h.enqueued).toContainEqual(expect.objectContaining({ name: "profile-chat" }));

    // Nothing new: the next run does nothing and calls no model.
    expect(await runChatAnalysis(h.deps, stored.chatId)).toEqual({ status: "skipped", reason: "empty" });
    expect(h.modelCalls()).toBe(1);
  });

  it("does not duplicate tasks when a job is retried after a crash mid-apply", async () => {
    await updateSettings(testDb.database.db, { trialDays: 0 });
    await calibrateMockProfile();
    const jid = nextJid();
    await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "send me the contract tomorrow" } }));
    const stored = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "the second contract too pls" } }));
    if (stored.status !== "stored") throw new Error(stored.status);
    const model = taskModel();
    let crash = true;
    const h = harness({
      providers: createMockProviders({ text: model }),
      tasks: (service) => {
        const original = service.applyAction.bind(service);
        let calls = 0;
        service.applyAction = async (...args) => {
          const result = await original(...args);
          if (crash && ++calls === 1) throw new Error("worker crashed");
          return result;
        };
        return service;
      },
    });
    await expect(runChatAnalysis(h.deps, stored.chatId)).rejects.toThrow("worker crashed");
    crash = false;
    const retry = await runChatAnalysis(h.deps, stored.chatId);
    expect(retry).toMatchObject({ status: "analyzed", resumed: true });
    expect(model.doGenerateCalls).toHaveLength(1);
    const tasks = await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.chatId, stored.chatId));
    // "Send the contract" twice from the model is deduplicated by the agent; one create, auto-applied once.
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ title: "Send the contract", status: "open", origin: "ai" });
    // A redelivered job for the same burst replays the finished run.
    await testDb.database.db.update(schema.messages).set({ analysisRunId: null }).where(eq(schema.messages.chatId, stored.chatId));
    expect(await runChatAnalysis(h.deps, stored.chatId)).toMatchObject({ status: "analyzed", resumed: true });
    expect(await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.chatId, stored.chatId))).toHaveLength(1);
    expect(model.doGenerateCalls).toHaveLength(1);
  });

  it("closes a task from the owner's message and asks Review for someone else's", async () => {
    await updateSettings(testDb.database.db, { trialDays: 0 });
    await calibrateMockProfile();
    const jid = nextJid();
    const first = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "send me the contract tomorrow" } }));
    if (first.status !== "stored") throw new Error(first.status);
    const h = harness({ providers: createMockProviders({ text: taskModel() }) });
    await runChatAnalysis(h.deps, first.chatId);
    const [task] = await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.chatId, first.chatId));
    expect(task).toMatchObject({ status: "open" });

    await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "done, got it" } }));
    const other = await runChatAnalysis(h.deps, first.chatId);
    expect(other).toMatchObject({ outcomes: [{ type: "complete", result: "review", reviewType: "possibly_done", decision: { reason: "non_owner_evidence" } }] });

    await ingest(makeOpenWaEnvelope({ event: "message.sent", data: { chatId: jid, from: OWNER, to: jid, fromMe: true, body: "sent it ✅" } }));
    const owner = await runChatAnalysis(h.deps, first.chatId);
    expect(owner).toMatchObject({ outcomes: [{ type: "complete", result: "applied", decision: { reason: "owner_evidence" } }] });
    const [closed] = await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.id, task!.id));
    expect(closed!.status).toBe("done");
  });

  it("shows pending creates to later runs: a later 'done' flags the item, a repeated request adds nothing", async () => {
    const jid = nextJid();
    const first = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "send me the contract tomorrow" } }));
    if (first.status !== "stored") throw new Error(first.status);
    const h = harness({ providers: createMockProviders({ text: taskModel() }) });
    await runChatAnalysis(h.deps, first.chatId);
    const pendingItems = () => testDb.database.db.select().from(schema.reviewItems).where(eq(schema.reviewItems.chatId, first.chatId));
    const [item] = await pendingItems();
    expect(item).toMatchObject({ type: "create", state: "pending", handled: null });

    // The same request again: the mock model proposes it again, validation drops it as a duplicate.
    await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "dont forget the contract" } }));
    expect(await runChatAnalysis(h.deps, first.chatId)).toMatchObject({ status: "analyzed", outcomes: [] });
    const [run] = await testDb.database.db
      .select()
      .from(schema.analysisRuns)
      .where(eq(schema.analysisRuns.chatId, first.chatId))
      .orderBy(sql`${schema.analysisRuns.startedAt} desc`)
      .limit(1);
    expect(run!.dropped).toEqual([{ index: 0, reason: "duplicate", type: "create" }]);

    // The contact says it is done before the owner reviewed it: the pending item is flagged, nothing closes.
    h.events.length = 0;
    await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "done, got it" } }));
    const done = await runChatAnalysis(h.deps, first.chatId);
    expect(done).toMatchObject({ outcomes: [{ type: "complete", result: "review", reviewItemId: item!.id, reviewType: "create", decision: { reason: "pending_create" } }] });
    const items = await pendingItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ state: "pending", handled: { status: "done", excerpt: "done, got it", fromOwner: false } });
    expect(h.events).toEqual([{ type: "sync" }]);
    expect(await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.chatId, first.chatId))).toEqual([]);
  });

  it("waits for the burst's media, re-checks Off chats, and defers over budget", async () => {
    const jid = nextJid();
    const stored = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, type: "image", hasMedia: true, body: "", media: { mimetype: "image/jpeg" } } }));
    if (stored.status !== "stored") throw new Error(stored.status);
    const h = harness({ providers: createMockProviders({ text: taskModel() }), limits: { text: { dailyTokenLimit: 100, dailyCallLimit: null } } });
    expect(await runChatAnalysis(h.deps, stored.chatId)).toEqual({ status: "waiting_media", pending: 1 });
    expect(h.debounced).toEqual([{ chatId: stored.chatId, delayMs: 15_000 }]);

    await testDb.database.db.update(schema.mediaObjects).set({ status: "done" });
    await recordModelUsage(testDb.database.db, { role: "text", purpose: "analysis", inputTokens: 150 });
    const deferred = await runChatAnalysis(h.deps, stored.chatId);
    expect(deferred).toMatchObject({ status: "deferred", reason: "budget" });
    expect(h.enqueued).toContainEqual(expect.objectContaining({ name: "analyze-chat", data: { chatId: stored.chatId } }));
    expect(h.modelCalls()).toBe(0);

    await updateChat(testDb.database.db, stored.chatId, { mode: "off" });
    expect(await runChatAnalysis(h.deps, stored.chatId)).toEqual({ status: "skipped", reason: "chat_off" });
    await testDb.database.db.execute(sql`delete from model_usage`);
  });

  it("defers (does not drop) when no provider is configured", async () => {
    const jid = nextJid();
    const stored = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body: "can you send me the invoice?" } }));
    if (stored.status !== "stored") throw new Error(stored.status);
    const h = harness({ providers: null });
    expect(await runChatAnalysis(h.deps, stored.chatId)).toMatchObject({ status: "deferred", reason: "provider" });
    const [message] = await testDb.database.db.select().from(schema.messages).where(eq(schema.messages.chatId, stored.chatId));
    expect(message!.analysisRunId).toBeNull();
  });

  it("stores group messages without a mention as context only", async () => {
    const group = { chatId: "team-x@g.us", from: "team-x@g.us", author: "447690000009@s.whatsapp.net", isGroup: true, chatName: "Team" };
    const plain = await ingest(makeOpenWaEnvelope({ data: { ...group, body: "who has the contract?" } }));
    if (plain.status !== "stored") throw new Error(plain.status);
    const h = harness({ providers: createMockProviders({ text: taskModel() }) });
    expect(await runChatAnalysis(h.deps, plain.chatId)).toEqual({ status: "skipped", reason: "empty" });
    await ingest(makeOpenWaEnvelope({ data: { ...group, body: "Alex, send me the contract" } }));
    expect(await runChatAnalysis(h.deps, plain.chatId)).toMatchObject({ status: "analyzed" });
  });
});

describe("media job", () => {
  const png = Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.from("fake image payload for tests")]);
  const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(64, 7)]);

  function fakeOpenWa(files: Record<string, { bytes: Buffer; type: string; status?: number }>) {
    const calls: string[] = [];
    const source: MediaSource = {
      async getStoredMedia(_session, _chat, messageId) {
        calls.push(messageId);
        const file = files[messageId];
        if (!file) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(file.bytes), { status: file.status ?? 200, headers: { "content-type": file.type } });
      },
    };
    return { source, calls };
  }

  async function mediaMessage(kind: "image" | "voice", mimetype: string, id: string, sizeBytes?: number) {
    const jid = nextJid();
    const stored = await ingest(makeOpenWaEnvelope({ data: { id, chatId: jid, from: jid, type: kind, hasMedia: true, body: "", media: { mimetype, ...(sizeBytes ? { sizeBytes } : {}) } } }));
    if (stored.status !== "stored") throw new Error(stored.status);
    const [media] = await testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.messageId, stored.messageId));
    return { stored, media: media! };
  }

  it("describes an image, stores derived text, dedupes identical bytes, and keeps no raw bytes", async () => {
    const seen: Uint8Array[] = [];
    const vision = scriptedJsonModel(({ files }) => {
      seen.push(files[0]!.data as Uint8Array);
      return { description: "An electricity bill.", ocrText: "Total 45.00 EUR", language: "en" };
    }, "mock-vision");
    const providers = createMockProviders({ vision });
    const first = await mediaMessage("image", "image/png", "img-1");
    const second = await mediaMessage("image", "image/png", "img-2");
    const openwa = fakeOpenWa({ "img-1": { bytes: png, type: "image/png" }, "img-2": { bytes: png, type: "image/png" } });
    const h = harness({ providers, media: openwa.source });

    expect(await processMedia(h.deps, first.media.id)).toEqual({ status: "done", deduped: false });
    expect(await processMedia(h.deps, second.media.id)).toEqual({ status: "done", deduped: true });
    expect(vision.doGenerateCalls).toHaveLength(1);
    // The in-memory buffer handed to the model is zeroed after processing.
    expect(seen[0]!.every((byte) => byte === 0)).toBe(true);

    const [message] = await testDb.database.db.select().from(schema.messages).where(eq(schema.messages.id, first.stored.messageId));
    expect(message).toMatchObject({ derivedText: "An electricity bill.\nText in image: Total 45.00 EUR", language: "en" });
    const [row] = await testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, first.media.id));
    expect(row).toMatchObject({ status: "done", sizeBytes: png.length, contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(row!.rawDeletedAt).toBeInstanceOf(Date);
    const dump = JSON.stringify(await testDb.database.db.execute(sql`select * from media_objects`));
    expect(dump).not.toContain(png.toString("base64"));
    expect(await processMedia(h.deps, first.media.id)).toEqual({ status: "already_final" });
  });

  it("transcribes a voice note", async () => {
    const providers = createMockProviders({ transcription: mockTranscriptionModel("send me the contract tomorrow", "en") });
    const { stored, media } = await mediaMessage("voice", "audio/ogg; codecs=opus", "voice-1");
    const h = harness({ providers, media: fakeOpenWa({ "voice-1": { bytes: ogg, type: "audio/ogg" } }).source });
    expect(await processMedia(h.deps, media.id)).toEqual({ status: "done", deduped: false });
    const [message] = await testDb.database.db.select().from(schema.messages).where(eq(schema.messages.id, stored.messageId));
    expect(message).toMatchObject({ derivedText: "send me the contract tomorrow", language: "en" });
  });

  it("re-queues voice notes that used up their attempts and profiles the ones the profile read past", async () => {
    const jid = nextJid();
    const text = (id: string, body: string, t: number) => ingest(makeOpenWaEnvelope({ data: { id, chatId: jid, from: jid, type: "chat", body, timestamp: t } }));
    await text("rv-hello", "Good morning", 1_790_000_000);
    const voice = await ingest(
      makeOpenWaEnvelope({ data: { id: "rv-voice", chatId: jid, from: jid, type: "voice", hasMedia: true, body: "", timestamp: 1_790_000_060, media: { mimetype: "audio/ogg; codecs=opus" } } }),
    );
    if (voice.status !== "stored") throw new Error(voice.status);
    const [media] = await testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.messageId, voice.messageId));
    const other = await mediaMessage("voice", "audio/ogg", "rv-other");
    const { db } = testDb.database;
    await db.update(schema.mediaObjects).set({ status: "failed", error: "retries_exhausted:AI_APICallError", attempts: 4 }).where(eq(schema.mediaObjects.id, media!.id));
    await db.update(schema.mediaObjects).set({ status: "failed", error: "not_found" }).where(eq(schema.mediaObjects.id, other.media.id));

    const facts = scriptedJsonModel(({ text: prompt }) => {
      const source = /"id":"([^"]+)"[^\n]*engineer/.exec(prompt)?.[1];
      return { facts: source ? [{ subject: "this_person", key: "role", value: "engineer", confidence: 0.9, selfClaimed: true, sourceMessageIds: [source] }] : [] };
    });
    const providers = createMockProviders({ text: facts, transcription: mockTranscriptionModel("I am a civil engineer", "en") });
    const h = harness({ providers, media: fakeOpenWa({ "rv-voice": { bytes: Buffer.concat([ogg, Buffer.from("rv")]), type: "audio/ogg" } }).source });
    const chat = await findChatByJid(db, jid);
    // The profile already read past the voice note while it had no text.
    expect(await runChatProfile(h.deps, chat!.id)).toMatchObject({ status: "profiled", facts: 0 });

    expect(await requeueExhaustedVoice(h.deps.database, h.deps.queue)).toBe(1);
    expect(h.enqueued).toEqual([{ name: "process-media", data: { mediaObjectId: media!.id }, startAfter: undefined }]);
    const [requeued] = await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media!.id));
    expect(requeued).toMatchObject({ status: "pending", attempts: 0 });
    const [untouched] = await db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, other.media.id));
    expect(untouched).toMatchObject({ status: "failed", error: "not_found" });

    expect(await processMedia(h.deps, media!.id)).toEqual({ status: "done", deduped: false });
    expect(h.enqueued.at(-1)).toMatchObject({ name: "profile-media", data: { mediaObjectId: media!.id } });
    expect(await profileRecoveredMedia(h.deps, media!.id)).toEqual({ status: "profiled", facts: 1 });
    const personFacts = await db.select().from(schema.personFacts).where(eq(schema.personFacts.personId, chat!.personId!));
    expect(personFacts).toEqual([expect.objectContaining({ key: "role", value: "engineer", sourceMessageIds: [voice.messageId] })]);
    // Facts only: no task and no analysis run came from the recovered voice note.
    expect(await db.select().from(schema.tasks).where(eq(schema.tasks.chatId, chat!.id))).toEqual([]);
    expect(await requeueExhaustedVoice(h.deps.database, h.deps.queue)).toBe(0);
  });

  it("enforces limits and records permanent failures with a reason", async () => {
    const providers = createMockProviders();
    const big = await mediaMessage("image", "image/jpeg", "img-big", 50 * 1024 * 1024);
    const wrong = await mediaMessage("image", "image/gif", "img-gif");
    const missing = await mediaMessage("image", "image/jpeg", "img-missing");
    const streamedBig = await mediaMessage("image", "image/jpeg", "img-streamed");
    const openwa = fakeOpenWa({ "img-streamed": { bytes: Buffer.alloc(2048, 1), type: "image/jpeg" } });
    const h = harness({ providers, media: openwa.source });
    h.deps.config = { ...h.deps.config, maxImageBytes: 1024 };
    expect(await processMedia(h.deps, big.media.id)).toEqual({ status: "skipped", reason: "too_large" });
    expect(await processMedia(h.deps, wrong.media.id)).toEqual({ status: "skipped", reason: "type_not_allowed" });
    expect(await processMedia(h.deps, missing.media.id)).toEqual({ status: "failed", reason: "not_found" });
    expect(await processMedia(h.deps, streamedBig.media.id)).toEqual({ status: "skipped", reason: "too_large" });
    expect(openwa.calls).toEqual(["img-missing", "img-streamed"]);
    const noOpenWa = await mediaMessage("image", "image/jpeg", "img-noconfig");
    expect(await processMedia(harness({ providers }).deps, noOpenWa.media.id)).toEqual({ status: "skipped", reason: "openwa_not_configured" });
  });

  it("retries transient failures a bounded number of times", async () => {
    const { media } = await mediaMessage("image", "image/jpeg", "img-flaky");
    const h = harness({ providers: createMockProviders(), media: fakeOpenWa({ "img-flaky": { bytes: png, type: "image/jpeg", status: 503 } }).source });
    h.deps.config = { ...h.deps.config, maxMediaAttempts: 2 };
    await expect(processMedia(h.deps, media.id)).rejects.toThrow("openwa_http_503");
    expect(await processMedia(h.deps, media.id)).toMatchObject({ status: "failed" });
    const [row] = await testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, media.id));
    expect(row).toMatchObject({ status: "failed", attempts: 2 });
  });
});

describe("media job: PDFs", () => {
  function fakeOpenWa(files: Record<string, { bytes: Buffer; type: string }>) {
    const calls: string[] = [];
    const source: MediaSource = {
      async getStoredMedia(_session, _chat, messageId) {
        calls.push(messageId);
        const file = files[messageId];
        if (!file) return new Response("not found", { status: 404 });
        return new Response(new Uint8Array(file.bytes), { headers: { "content-type": file.type } });
      },
    };
    return { source, calls };
  }

  async function pdfMessage(id: string, options: { mimetype?: string | null; sizeBytes?: number; filename?: string } = {}) {
    const jid = nextJid();
    const mimetype = options.mimetype === undefined ? "application/pdf" : options.mimetype;
    const media = { ...(mimetype ? { mimetype } : {}), ...(options.sizeBytes ? { sizeBytes: options.sizeBytes } : {}), filename: options.filename ?? "Fatura.pdf" };
    const stored = await ingest(makeOpenWaEnvelope({ data: { id, chatId: jid, from: jid, type: "document", hasMedia: true, body: "", media } }));
    if (stored.status !== "stored") throw new Error(stored.status);
    const [row] = await testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.messageId, stored.messageId));
    expect(row).toMatchObject({ kind: "document", status: "pending" });
    return { stored, media: row! };
  }

  const mediaRow = async (id: string) => (await testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, id)))[0]!;
  const messageRow = async (id: string) => (await testDb.database.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;

  /** A vision model that transcribes "page N" for each image it gets and records what it was sent. */
  function pdfVision() {
    const seen: Array<Array<{ data: Uint8Array; mediaType: string }>> = [];
    const model = scriptedJsonModel(({ files }) => {
      seen.push(files.map((file) => ({ data: file.data as Uint8Array, mediaType: file.mediaType })));
      return {
        summary: "Rental agreement between Alfa Ltd and Alex, 1,200 EUR a month.",
        pages: files.map((_, index) => ({ page: index + 1, text: `text of page ${index + 1}` })),
        language: "en",
      };
    }, "mock-vision");
    return { model, seen };
  }

  it("renders a scanned PDF for the vision model, stores the derived text, and keeps no raw bytes", async () => {
    const pdf = buildPdf([{ box: true }, { box: true }]);
    const vision = pdfVision();
    const { stored, media } = await pdfMessage("pdf-scan");
    const h = harness({ providers: createMockProviders({ vision: vision.model }), media: fakeOpenWa({ "pdf-scan": { bytes: pdf, type: "application/pdf" } }).source });

    expect(await processMedia(h.deps, media.id)).toEqual({ status: "done", deduped: false });
    expect(vision.model.doGenerateCalls).toHaveLength(1);
    const sent = vision.seen[0]!;
    expect(sent.map((file) => file.mediaType)).toEqual(["image/png", "image/png"]);
    // The rendered page images handed to the model are zeroed after processing.
    expect(sent.every((file) => file.data.length > 0 && file.data.every((byte) => byte === 0))).toBe(true);

    expect(await messageRow(stored.messageId)).toMatchObject({
      derivedText: "PDF, 2 pages\nRental agreement between Alfa Ltd and Alex, 1,200 EUR a month.\nPage 1: text of page 1\nPage 2: text of page 2",
      language: "en",
    });
    const row = await mediaRow(media.id);
    expect(row).toMatchObject({ status: "done", sizeBytes: pdf.length, contentSha256: expect.stringMatching(/^[0-9a-f]{64}$/), error: null });
    expect(row.rawDeletedAt).toBeInstanceOf(Date);
    const usage = await testDb.database.db.select().from(schema.modelUsage).where(eq(schema.modelUsage.refId, media.id));
    expect(usage).toMatchObject([{ role: "vision", purpose: "pdf" }]);
    const dump = JSON.stringify(await testDb.database.db.execute(sql`select * from media_objects`));
    expect(dump).not.toContain(pdf.toString("base64").slice(0, 40));
  });

  it("stores the text layer without a model call when every page has one", async () => {
    const pdf = buildPdf([{ text: "Invoice No. 42, Total 1,200 EUR, payment due 1 October" }, { text: "Please pay on time into the account of Alfa Ltd" }]);
    const vision = pdfVision();
    // Only a generic type from WhatsApp and OpenWA: the file name and the header make it a PDF.
    const { stored, media } = await pdfMessage("pdf-text", { mimetype: "application/octet-stream", filename: "invoice.PDF" });
    const h = harness({ providers: createMockProviders({ vision: vision.model }), media: fakeOpenWa({ "pdf-text": { bytes: pdf, type: "application/octet-stream" } }).source });

    expect(await processMedia(h.deps, media.id)).toEqual({ status: "done", deduped: false });
    expect(vision.model.doGenerateCalls).toHaveLength(0);
    expect(await messageRow(stored.messageId)).toMatchObject({
      derivedText: "PDF, 2 pages\nPage 1: Invoice No. 42, Total 1,200 EUR, payment due 1 October\nPage 2: Please pay on time into the account of Alfa Ltd",
    });
  });

  it("caps pages, size, and bad documents with a recorded reason and no retries", async () => {
    const vision = pdfVision();
    const long = await pdfMessage("pdf-long");
    const declaredBig = await pdfMessage("pdf-big", { sizeBytes: 50 * 1024 * 1024 });
    const streamedBig = await pdfMessage("pdf-streamed");
    const broken = await pdfMessage("pdf-broken");
    const notPdf = await pdfMessage("pdf-png");
    const locked = await pdfMessage("pdf-locked");
    const slow = await pdfMessage("pdf-slow");
    const word = await pdfMessage("doc-word", { mimetype: "application/msword", filename: "contract.doc" });
    const openwa = fakeOpenWa({
      "pdf-long": { bytes: buildPdf(Array.from({ length: 12 }, () => ({ box: true }))), type: "application/pdf" },
      "pdf-streamed": { bytes: Buffer.concat([buildPdf([{ box: true }]), Buffer.alloc(300_000, 0x20)]), type: "application/pdf" },
      "pdf-broken": { bytes: Buffer.from("%PDF-1.7\n1 0 obj << /Type /Catalog >> garbage\n%%EOF"), type: "application/pdf" },
      "pdf-png": { bytes: Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"), type: "application/pdf" },
      "pdf-locked": { bytes: buildPdf([{ text: "Secret: the full contract with all terms" }], { password: true }), type: "application/pdf" },
      "pdf-slow": { bytes: buildPdf([{ box: true }, { box: true }, { box: true }]), type: "application/pdf" },
    });
    const h = harness({ providers: createMockProviders({ vision: vision.model }), media: openwa.source });
    h.deps.config = { ...h.deps.config, maxPdfPages: 3, maxPdfBytes: 200_000 };

    expect(await processMedia(h.deps, long.media.id)).toEqual({ status: "done", deduped: false });
    expect(vision.seen[0]).toHaveLength(3);
    expect((await messageRow(long.stored.messageId)).derivedText).toMatch(/^PDF, 12 pages \(first 3 read\)\n/);

    expect(await processMedia(h.deps, declaredBig.media.id)).toEqual({ status: "skipped", reason: "too_large" });
    expect(await processMedia(h.deps, streamedBig.media.id)).toEqual({ status: "skipped", reason: "too_large" });
    expect(await processMedia(h.deps, broken.media.id)).toEqual({ status: "failed", reason: "invalid_pdf" });
    expect(await processMedia(h.deps, notPdf.media.id)).toEqual({ status: "failed", reason: "invalid_pdf" });
    expect(await processMedia(h.deps, locked.media.id)).toEqual({ status: "skipped", reason: "pdf_encrypted" });
    expect(await processMedia({ ...h.deps, config: { ...h.deps.config, pdfTimeoutMs: 1 } }, slow.media.id)).toEqual({ status: "failed", reason: "pdf_timeout" });
    expect(await processMedia(h.deps, word.media.id)).toEqual({ status: "skipped", reason: "unsupported_document" });
    expect(openwa.calls).not.toContain("pdf-big");
    expect(openwa.calls).not.toContain("doc-word");
    expect(vision.model.doGenerateCalls).toHaveLength(1);

    for (const { media } of [broken, locked, slow]) {
      const row = await mediaRow(media.id);
      expect(row).toMatchObject({ attempts: 1, derivedText: null });
      expect(row.rawDeletedAt).toBeInstanceOf(Date);
      expect(await processMedia(h.deps, media.id)).toEqual({ status: "already_final" });
    }
  });
});

describe("profile job", () => {
  it("adds facts, updates languages, and suggests a context once per day", async () => {
    const jid = nextJid();
    const bodies = ["Hello, I am the accountant at Alfa", "will send the invoices tomorrow", "thanks a lot"];
    let chatId = "";
    for (const body of bodies) {
      const stored = await ingest(makeOpenWaEnvelope({ data: { chatId: jid, from: jid, body } }));
      if (stored.status === "stored") chatId = stored.chatId;
    }
    const text = scriptedJsonModel(({ text: prompt }) => {
      const id = /"id":"([^"]+)"/.exec(prompt.split("<conversation>")[1]!)![1];
      return { facts: [{ subject: "this_person", key: "relationship", value: "accountant (colleague)", confidence: 0.8, selfClaimed: true, sourceMessageIds: [id] }] };
    });
    const h = harness({ providers: createMockProviders({ text }) });
    const outcome = await runChatProfile(h.deps, chatId);
    expect(outcome).toMatchObject({ status: "profiled", facts: 1, languages: ["en"], contextSuggested: true });
    expect(await runChatProfile(h.deps, chatId)).toEqual({ status: "skipped", reason: "already_today" });

    const chat = await findChatByJid(testDb.database.db, jid);
    const [work] = await testDb.database.db.select().from(schema.contexts).where(eq(schema.contexts.name, "Work"));
    expect(chat).toMatchObject({ defaultContextId: work!.id, contextConfirmed: false });
    const facts = await testDb.database.db.select().from(schema.personFacts).where(eq(schema.personFacts.personId, chat!.personId!));
    expect(facts).toEqual([expect.objectContaining({ key: "relationship", selfClaimed: true, verified: false, source: "ai" })]);
    expect(h.events).toEqual([{ type: "sync" }]);
  });
});

describe("reminders and daily summary", () => {
  it("reminds once per task and due value, re-arms on reschedule, and sends the summary at its time", async () => {
    const { db } = testDb.database;
    await db.execute(sql`update tasks set status = 'done'`);
    await db.execute(sql`update review_items set state = 'rejected'`);
    await updateSettings(db, { timezone: "Europe/Rome", reminderLeadMinutes: 60, remindersEnabled: true, dailySummaryTime: "08:00" });
    const service = new TaskService({ database: testDb.database });
    // 2026-09-24 is CEST (UTC+2): 17:00 local = 15:00Z.
    const { task } = await service.createManualTask({ kind: "todo", title: "Send the contract", dueAt: "2026-09-24" });
    await service.createManualTask({ kind: "todo", title: "Old", dueAt: "2026-09-20T10:00:00Z" });
    const h = harness();
    const at = (iso: string) => new Date(iso);

    expect(await runNotificationTick(h.deps, at("2026-09-24T13:30:00Z"))).toEqual({ reminders: 0, summary: false });
    expect(await runNotificationTick(h.deps, at("2026-09-24T14:05:00Z"))).toEqual({ reminders: 1, summary: false });
    expect(await runNotificationTick(h.deps, at("2026-09-24T14:06:00Z"))).toEqual({ reminders: 0, summary: false });
    expect(h.pushes).toEqual([{ type: "reminder", taskId: task.id, title: "Send the contract", dueAt: "2026-09-24T15:00:00.000Z" }]);

    await service.updateTask(task.id, { dueAt: "2026-09-24T16:00:00Z" });
    expect(await runNotificationTick(h.deps, at("2026-09-24T15:01:00Z"))).toEqual({ reminders: 1, summary: false });

    await updateSettings(db, { remindersEnabled: false });
    await service.updateTask(task.id, { dueAt: "2026-09-24T17:00:00Z" });
    expect((await runNotificationTick(h.deps, at("2026-09-24T16:30:00Z"))).reminders).toBe(0);

    // Summary: 08:00 Rome on 2026-09-25 = 06:00Z.
    h.pushes.length = 0;
    expect((await runNotificationTick(h.deps, at("2026-09-25T05:59:00Z"))).summary).toBe(false);
    expect((await runNotificationTick(h.deps, at("2026-09-25T06:00:30Z"))).summary).toBe(true);
    expect((await runNotificationTick(h.deps, at("2026-09-25T06:01:30Z"))).summary).toBe(false);
    expect(h.pushes).toEqual([{ type: "summary", open: 2, dueToday: 0, overdue: 2, review: 0 }]);
    // Too late to catch up (worker was down all morning): no summary.
    expect((await runNotificationTick(h.deps, at("2026-09-26T12:00:00Z"))).summary).toBe(false);
  });
});

describe("durable reminder delivery", () => {
  it("keeps reminders through a push outage, delivers each once per device on recovery, and skips rescheduled ones", async () => {
    const { db } = testDb.database;
    await db.execute(sql`update tasks set status = 'done'`);
    await updateSettings(db, { timezone: "Europe/Rome", reminderLeadMinutes: 60, remindersEnabled: true, dailySummaryTime: null });
    for (const id of ["phone", "tablet"]) {
      await db.insert(schema.devices).values({ id, name: id, tokenHash: `hash-${id}` });
      await upsertPushEndpoint(db, id, { endpoint: `https://push.test/${id}`, p256dh: "key", auth: "auth" });
    }
    const service = new TaskService({ database: testDb.database });
    const { task } = await service.createManualTask({ kind: "todo", title: "Pay the rent", dueAt: "2026-10-02T15:00:00Z" });
    const { task: moved } = await service.createManualTask({ kind: "todo", title: "Thirr Samin", dueAt: "2026-10-02T15:30:00Z" });

    let up = false;
    let attempts = 0;
    const sent: Array<{ deviceId: string; payload: PushPayload }> = [];
    const sender = {
      sendToAll: async () => ({ endpoints: 0, delivered: 0, removed: 0, failed: 0 }),
      sendToDevice: async (payload: PushPayload, deviceId: string) => {
        attempts += 1;
        if (!up) return { endpoints: 1, delivered: 0, removed: 0, failed: 1 };
        sent.push({ deviceId, payload });
        return { endpoints: 1, delivered: 1, removed: 0, failed: 0 };
      },
    };
    const deps = { ...harness().deps, push: new PushNotifier({ database: testDb.database, sender }) };
    const at = (iso: string) => new Date(iso);

    // The push service is down: both reminders are queued and attempted, nothing is delivered.
    expect(await runNotificationTick(deps, at("2026-10-02T14:31:00Z"))).toEqual({ reminders: 2, summary: false });
    expect(attempts).toBe(4);
    // Within the backoff nothing is retried.
    expect(await runNotificationTick(deps, at("2026-10-02T14:31:10Z"))).toEqual({ reminders: 0, summary: false });
    expect(attempts).toBe(4);
    // One task is rescheduled during the outage: its old reminder must not be delivered.
    await service.updateTask(moved.id, { dueAt: "2026-10-02T18:00:00Z" });

    up = true;
    await runNotificationTick(deps, at("2026-10-02T14:33:00Z"));
    await runNotificationTick(deps, at("2026-10-02T14:45:00Z"));
    expect(sent.map((s) => s.deviceId).sort()).toEqual(["phone", "tablet"]);
    const ids = new Set(sent.map((s) => (s.payload as { notificationId?: string }).notificationId));
    expect(ids.size).toBe(1);
    expect(sent.map((s) => s.payload)).toEqual([
      { type: "reminder", taskId: task.id, title: "Pay the rent", dueAt: "2026-10-02T15:00:00.000Z", notificationId: [...ids][0] },
      { type: "reminder", taskId: task.id, title: "Pay the rent", dueAt: "2026-10-02T15:00:00.000Z", notificationId: [...ids][0] },
    ]);

    // The rescheduled task is reminded for its new due value.
    sent.length = 0;
    expect((await runNotificationTick(deps, at("2026-10-02T17:01:00Z"))).reminders).toBe(1);
    expect(sent.map((s) => s.payload)).toEqual([
      expect.objectContaining({ taskId: moved.id, dueAt: "2026-10-02T18:00:00.000Z" }),
      expect.objectContaining({ taskId: moved.id, dueAt: "2026-10-02T18:00:00.000Z" }),
    ]);
  });
});
