/**
 * PDFs and the vision gates: a text-layer PDF needs no vision provider or budget; a scanned one is
 * skipped without a provider and deferred (not failed) over budget. Plus the opt-in pre-T10 backfill.
 */
import type { Providers } from "@wabrain/agent";
import { createMockProviders, scriptedJsonModel } from "@wabrain/agent/testing";
import {
  LEGACY_PDF_SKIP_REASON,
  TaskService,
  insertSourceEvent,
  projectSourceEvent,
  schema,
  type IntakeScheduler,
} from "@wabrain/db";
import { createTestDatabase, makeOpenWaEnvelope, type TestDatabase } from "@wabrain/db/testing";
import { createRulesIntakeFilter } from "@wabrain/rules";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProvidersState } from "../providers.js";
import { defaultPipelineConfig } from "./config.js";
import type { MediaSource, PipelineDeps } from "./deps.js";
import { processMedia, requeueLegacyPdfs, requeueUnavailableMedia } from "./media.js";
import { buildPdf } from "./test-fixtures/pdf.js";

const OWNER = "447690000000@s.whatsapp.net";
const filter = createRulesIntakeFilter({ ownerJids: [OWNER], aliases: ["Alex"] });
const silent = { info() {}, warn() {}, error() {} };
const nolimit = { dailyTokenLimit: null, dailyCallLimit: null };
const scheduler: IntakeScheduler = { debounceAnalysis: async () => {}, enqueueMedia: async () => {} };

let testDb: TestDatabase;
let jidSeq = 500;

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb?.drop();
});

// Distinct bytes per test: identical files would be deduplicated by content hash.
const TEXT_PDF = (tag: string) => buildPdf([{ text: `Fatura Nr. 77, Totali 9.000 ALL, afati i pageses 5 tetor, ref ${tag}` }]);
const SCANNED_PDF = (pages: number) => buildPdf(Array.from({ length: pages }, () => ({ box: true })));

function openWa(files: Record<string, Buffer>) {
  const calls: string[] = [];
  const source: MediaSource = {
    async getStoredMedia(_session, _chat, messageId) {
      calls.push(messageId);
      const bytes = files[messageId];
      if (!bytes) return new Response("not found", { status: 404 });
      return new Response(new Uint8Array(bytes), { headers: { "content-type": "application/pdf" } });
    },
  };
  return { source, calls };
}

function harness(providers: Providers | null, media: MediaSource, limits: Partial<ProvidersState["limits"]> = {}) {
  const enqueued: Array<{ name: string; data: unknown; startAfter?: unknown }> = [];
  const notifier = { notify() {} };
  const deps: PipelineDeps = {
    database: testDb.database,
    queue: {
      enqueue: async (name, data, options) => (enqueued.push({ name, data, startAfter: options?.startAfter }), "job"),
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
    media,
    logger: silent,
    config: defaultPipelineConfig(),
    now: () => new Date(),
  };
  return { deps, enqueued };
}

async function pdfMessage(id: string) {
  const jid = `446933${jidSeq++}@s.whatsapp.net`;
  const envelope = makeOpenWaEnvelope({
    data: { id, chatId: jid, from: jid, type: "document", hasMedia: true, body: "", media: { mimetype: "application/pdf", filename: "Fatura.pdf" } },
  });
  const { id: eventId } = await insertSourceEvent(testDb.database.db, {
    sessionId: envelope.sessionId,
    idempotencyKey: envelope.idempotencyKey,
    deliveryId: envelope.deliveryId,
    eventType: envelope.event,
    chatJid: jid,
    raw: envelope,
  });
  const stored = await projectSourceEvent({ database: testDb.database, filter, scheduler }, eventId);
  if (stored.status !== "stored") throw new Error(stored.status);
  const [media] = await testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.messageId, stored.messageId));
  return { messageId: stored.messageId, media: media! };
}

const mediaRow = async (id: string) => (await testDb.database.db.select().from(schema.mediaObjects).where(eq(schema.mediaObjects.id, id)))[0]!;
const derivedText = async (messageId: string) =>
  (await testDb.database.db.select({ derivedText: schema.messages.derivedText }).from(schema.messages).where(eq(schema.messages.id, messageId)))[0]!.derivedText;

function visionModel() {
  return scriptedJsonModel(({ files }) => ({
    summary: "A scanned invoice.",
    pages: files.map((_, index) => ({ page: index + 1, text: `faqja ${index + 1}` })),
    language: "en",
  }), "mock-vision");
}

describe("PDFs and the vision gates", () => {
  it("stores a text-layer PDF without any provider configured", async () => {
    const { messageId, media } = await pdfMessage("gate-text-noprov");
    const h = harness(null, openWa({ "gate-text-noprov": TEXT_PDF("a") }).source);
    expect(await processMedia(h.deps, media.id)).toEqual({ status: "done", deduped: false });
    expect(await derivedText(messageId)).toContain("Fatura Nr. 77");
  });

  it("stores a text-layer PDF while the vision budget is used up, with no model call", async () => {
    const vision = visionModel();
    const { messageId, media } = await pdfMessage("gate-text-budget");
    const h = harness(createMockProviders({ vision }), openWa({ "gate-text-budget": TEXT_PDF("b") }).source, {
      vision: { dailyTokenLimit: null, dailyCallLimit: 0 },
    });
    expect(await processMedia(h.deps, media.id)).toEqual({ status: "done", deduped: false });
    expect(vision.doGenerateCalls).toHaveLength(0);
    expect(await derivedText(messageId)).toContain("Fatura Nr. 77");
    expect(h.enqueued).toEqual([]);
  });

  it("defers a scanned PDF to the budget reset without counting an attempt, then describes it", async () => {
    const vision = visionModel();
    const { messageId, media } = await pdfMessage("gate-scan-budget");
    const files = openWa({ "gate-scan-budget": SCANNED_PDF(1) });
    const over = harness(createMockProviders({ vision }), files.source, { vision: { dailyTokenLimit: null, dailyCallLimit: 0 } });
    const outcome = await processMedia(over.deps, media.id);
    expect(outcome).toMatchObject({ status: "deferred" });
    expect(vision.doGenerateCalls).toHaveLength(0);
    expect(over.enqueued).toEqual([{ name: "process-media", data: { mediaObjectId: media.id }, startAfter: (outcome as { until: Date }).until }]);
    expect(await mediaRow(media.id)).toMatchObject({ status: "pending", attempts: 0, derivedText: null });

    const ready = harness(createMockProviders({ vision }), files.source);
    expect(await processMedia(ready.deps, media.id)).toEqual({ status: "done", deduped: false });
    expect(vision.doGenerateCalls).toHaveLength(1);
    expect(await derivedText(messageId)).toContain("A scanned invoice.");
    expect(await mediaRow(media.id)).toMatchObject({ status: "done", attempts: 1 });
  });

  it("skips a scanned PDF when no provider is configured", async () => {
    const { media } = await pdfMessage("gate-scan-noprov");
    const h = harness(null, openWa({ "gate-scan-noprov": SCANNED_PDF(2) }).source);
    expect(await processMedia(h.deps, media.id)).toEqual({ status: "skipped", reason: "no_provider" });
    expect(await mediaRow(media.id)).toMatchObject({ status: "skipped", error: "no_provider" });
  });
});

describe("pre-T10 PDF backfill", () => {
  it("re-queues only PDFs skipped as pdf_deferred_phase2, idempotently, and they are then processed", async () => {
    const legacy = await pdfMessage("legacy-pdf");
    const other = await pdfMessage("legacy-other");
    const { db } = testDb.database;
    await db.update(schema.mediaObjects).set({ status: "skipped", error: LEGACY_PDF_SKIP_REASON, attempts: 1 }).where(eq(schema.mediaObjects.id, legacy.media.id));
    await db.update(schema.mediaObjects).set({ status: "skipped", error: "unsupported_document" }).where(eq(schema.mediaObjects.id, other.media.id));

    const h = harness(null, openWa({ "legacy-pdf": TEXT_PDF("c") }).source);
    expect(await requeueLegacyPdfs(h.deps, h.deps.queue)).toBe(1);
    // Re-running before the job ran queues the same row again (deduplicated by the queue's singleton key).
    expect(await requeueLegacyPdfs(h.deps, h.deps.queue)).toBe(1);
    expect(h.enqueued.map((job) => job.data)).toEqual([{ mediaObjectId: legacy.media.id }, { mediaObjectId: legacy.media.id }]);
    expect(await mediaRow(other.media.id)).toMatchObject({ status: "skipped", error: "unsupported_document" });
    expect(await mediaRow(legacy.media.id)).toMatchObject({ status: "pending", attempts: 0 });

    expect(await processMedia(h.deps, legacy.media.id)).toEqual({ status: "done", deduped: false });
    expect(await derivedText(legacy.messageId)).toContain("Fatura Nr. 77");
    expect(await mediaRow(legacy.media.id)).toMatchObject({ status: "done" });
    // Nothing left to re-queue.
    expect(await requeueLegacyPdfs(h.deps, h.deps.queue)).toBe(0);
  });
});

describe("re-queueing media OpenWA had no file for", () => {
  it("retries only not_found failures, idempotently, and they succeed once the file is available", async () => {
    const missing = await pdfMessage("history-pdf");
    const broken = await pdfMessage("broken-pdf");
    const { db } = testDb.database;
    // The real first attempt: OpenWA answers 404, so the media job records failed / not_found.
    const before = harness(null, openWa({}).source);
    expect(await processMedia(before.deps, missing.media.id)).toMatchObject({ status: "failed", reason: "not_found" });
    await db.update(schema.mediaObjects).set({ status: "failed", error: "download_failed" }).where(eq(schema.mediaObjects.id, broken.media.id));

    const after = harness(null, openWa({ "history-pdf": TEXT_PDF("d") }).source);
    expect(await requeueUnavailableMedia(after.deps.database, after.deps.queue)).toBe(1);
    expect(await requeueUnavailableMedia(after.deps.database, after.deps.queue)).toBe(1);
    expect(after.enqueued.map((job) => job.data)).toEqual([{ mediaObjectId: missing.media.id }, { mediaObjectId: missing.media.id }]);
    expect(await mediaRow(broken.media.id)).toMatchObject({ status: "failed", error: "download_failed" });
    expect(await mediaRow(missing.media.id)).toMatchObject({ status: "pending", attempts: 0 });

    expect(await processMedia(after.deps, missing.media.id)).toEqual({ status: "done", deduped: false });
    expect(await derivedText(missing.messageId)).toContain("Fatura Nr. 77");
    expect(await requeueUnavailableMedia(after.deps.database, after.deps.queue)).toBe(0);
  });
});
