import {
  cancelHistoryImport,
  checkpointHistoryImport,
  getHistoryImport,
  getProfileProgress,
  historyImportCoverage,
  insertSourceEvent,
  markHistoryImportRunning,
  projectSourceEvent,
  schema,
  startHistoryImport,
  wipeAllData,
} from "@wabrain/db";
import { createTestDatabase, makeOpenWaEnvelope, type TestDatabase } from "@wabrain/db/testing";
import { OpenWaReadClient } from "@wabrain/openwa-adapter";
import { startFakeOpenWa, type FakeOpenWa } from "@wabrain/openwa-adapter/testing";
import { createRulesIntakeFilter } from "@wabrain/rules";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runHistoryImport, type HistoryImportDeps } from "./history-import.js";
import { JobQueue } from "./queue.js";
import { startWorker } from "./worker.js";

const SESSION = "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a";
const CHAT = "447690000001@s.whatsapp.net";
const now = new Date("2026-09-23T12:00:00Z");
const logger = { info() {}, warn() {}, error() {} };

function row(id: string, ageDays: number, extra: Record<string, unknown> = {}) {
  return {
    id: `openwa-${id}`, waMessageId: id, chatId: CHAT, chatName: "Sam",
    from: CHAT, to: "447690000000@s.whatsapp.net", body: `History ${id}`,
    type: "text", direction: "incoming", timestamp: Math.floor(now.getTime() / 1000) - ageDays * 86_400,
    hasMedia: false, ...extra,
  };
}

let testDb: TestDatabase;
let queue: JobQueue;
let fake: FakeOpenWa | null = null;
const filter = createRulesIntakeFilter({ ownerJids: [] });

async function deps(rows: Record<string, unknown>[], pageSize = 2): Promise<HistoryImportDeps> {
  fake = await startFakeOpenWa({
    sessions: [{ id: SESSION, name: "personal", status: "ready" }],
    keys: { viewer: { role: "viewer", allowedSessions: [SESSION] } },
    historyRows: rows,
  });
  return { database: testDb.database, queue, filter, source: new OpenWaReadClient(fake.url, "viewer"), logger, pageSize };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  queue = new JobQueue({ connectionString: testDb.url, supervise: false, logger });
  await queue.start();
});
beforeEach(async () => {
  if (fake) { await fake.close(); fake = null; }
  await wipeAllData(testDb.database);
});
afterAll(async () => {
  if (fake) await fake.close();
  await queue.stop({ graceful: false, timeoutMs: 1000 });
  await testDb.drop();
});

describe("history import", () => {
  it("resumes at the committed OpenWA cursor after a failed page", async () => {
    const base = await deps([row("m1", 1), row("m2", 2), row("m3", 3)], 2);
    await startHistoryImport(testDb.database.db, SESSION, 90, now);
    let calls = 0;
    const source = base.source;
    expect(await runHistoryImport({ ...base, source: {
      async listStoredMessages(sessionId, options) {
        calls += 1;
        if (calls === 2) throw new Error("temporary disconnect");
        return source.listStoredMessages(sessionId, options);
      },
    } }, SESSION)).toBe("failed");
    expect((await getHistoryImport(testDb.database.db, SESSION))?.afterCursor).toBe("openwa-m2");
    expect((await getHistoryImport(testDb.database.db, SESSION))?.status).toBe("failed");

    await startHistoryImport(testDb.database.db, SESSION, 90, now);
    expect(await runHistoryImport(base, SESSION)).toBe("completed");
    expect(fake!.requests.some((request) => request.path.includes("after=openwa-m2"))).toBe(true);
    expect(fake!.requests.filter((request) => request.path.includes("/messages?")).every((request) => request.path.includes("inlineMedia=false"))).toBe(true);
    const messages = await testDb.database.db.select().from(schema.messages);
    expect(messages).toHaveLength(3);
    expect(messages.every((message) => message.source === "history" && !message.analyzable)).toBe(true);
    // Every imported message is left for the profile: a catch-up up to the last one, and its job.
    const chatId = messages[0]!.chatId;
    expect((await getProfileProgress(testDb.database.db, chatId)).target).not.toBeNull();
    expect(await queue.findJobs("profile-chat", { key: chatId, queued: true })).toHaveLength(1);
  });

  it("stops when cancelled and resumes without making historical tasks", async () => {
    const base = await deps([row("recent", 2), row("older", 30), row("past-cutoff", 100)], 2);
    await startHistoryImport(testDb.database.db, SESSION, 90, now);
    const source = base.source;
    expect(await runHistoryImport({ ...base, source: {
      async listStoredMessages(sessionId, options) {
        if (options?.after) await cancelHistoryImport(testDb.database.db, SESSION);
        return source.listStoredMessages(sessionId, options);
      },
    } }, SESSION)).toBe("cancelled");
    expect((await getHistoryImport(testDb.database.db, SESSION))?.afterCursor).toBe("openwa-older");
    const oldGeneration = (await getHistoryImport(testDb.database.db, SESSION))!.generation;
    await startHistoryImport(testDb.database.db, SESSION, 90, now);
    await markHistoryImportRunning(testDb.database.db, SESSION);
    expect(await checkpointHistoryImport(testDb.database.db, SESSION, oldGeneration, "stale-cursor", 1, 3)).toBe(false);
    expect(await runHistoryImport(base, SESSION)).toBe("completed");
    expect((await testDb.database.db.select().from(schema.messages)).map((message) => message.waMessageId)).toEqual(["recent", "older"]);
    expect(await testDb.database.db.select().from(schema.tasks)).toHaveLength(0);
    expect(await testDb.database.db.select().from(schema.reviewItems)).toHaveLength(0);
    expect(await queue.findJobs("analyze-chat")).toHaveLength(0);
  });

  it("deduplicates a webhook message and reports per-chat coverage and media outcomes", async () => {
    const base = await deps([row("same", 1), row("photo", 3, { type: "image", hasMedia: true, media: { mimetype: "image/jpeg" } })]);
    const envelope = makeOpenWaEnvelope({ sessionId: SESSION, data: { id: "same", chatId: CHAT, from: CHAT } });
    const existing = await insertSourceEvent(testDb.database.db, {
      sessionId: SESSION, idempotencyKey: envelope.idempotencyKey, deliveryId: envelope.deliveryId,
      eventType: envelope.event, chatJid: CHAT, raw: envelope,
    });
    await projectSourceEvent({ database: testDb.database, filter, scheduler: { debounceAnalysis: async () => {}, enqueueMedia: async () => {} } }, existing.id);
    await startHistoryImport(testDb.database.db, SESSION, 90, now);
    expect(await runHistoryImport(base, SESSION)).toBe("completed");
    const messages = await testDb.database.db.select().from(schema.messages);
    expect(messages).toHaveLength(2);
    expect(messages.find((message) => message.waMessageId === "same")?.source).toBe("webhook");
    const media = await testDb.database.db.select().from(schema.mediaObjects);
    expect(media).toHaveLength(1);
    await testDb.database.db.update(schema.mediaObjects).set({ status: "failed" }).where(eq(schema.mediaObjects.id, media[0]!.id));
    const coverage = await historyImportCoverage(testDb.database.db, SESSION);
    expect(coverage.items[0]).toMatchObject({ chatId: CHAT, messageCount: 2, mediaOk: 0, mediaFailed: 1 });
    expect(coverage.items[0]?.earliestAt).toBeTruthy();
    expect(coverage.run?.status).toBe("completed");
  });

  it("reports missing worker read access instead of leaving the import queued", async () => {
    await startHistoryImport(testDb.database.db, SESSION, 90, now);
    await queue.enqueue("import-history", { sessionId: SESSION }, { singletonKey: SESSION });
    const worker = await startWorker({ database: testDb.database, queue, filter, logger });
    try {
      let run = await getHistoryImport(testDb.database.db, SESSION);
      for (let attempt = 0; attempt < 50 && run?.status !== "failed"; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        run = await getHistoryImport(testDb.database.db, SESSION);
      }
      expect(run?.status).toBe("failed");
      expect(run?.lastError).toContain("OpenWA read access");
    } finally {
      await worker.stop();
    }
  });
});
