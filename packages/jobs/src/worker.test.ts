import { insertSourceEvent } from "@wabrain/db";
import { createTestDatabase, makeOpenWaEnvelope, type TestDatabase } from "@wabrain/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobQueue } from "./queue.js";
import { runMaintenance } from "./worker.js";

let testDb: TestDatabase;
let queue: JobQueue;

beforeAll(async () => {
  testDb = await createTestDatabase();
  queue = new JobQueue({ connectionString: testDb.url, supervise: false, logger: { info() {}, warn() {}, error() {} } });
  await queue.start();
});
afterAll(async () => {
  await queue.stop({ graceful: false, timeoutMs: 1000 });
  await testDb.drop();
});

describe("maintenance", () => {
  it("re-enqueues events whose projection job was lost", async () => {
    const envelope = makeOpenWaEnvelope();
    const { id } = await insertSourceEvent(testDb.database.db, {
      sessionId: envelope.sessionId,
      idempotencyKey: envelope.idempotencyKey,
      deliveryId: envelope.deliveryId,
      eventType: envelope.event,
      chatJid: envelope.data.chatId,
      raw: envelope,
    });
    expect((await runMaintenance(testDb.database, queue, new Date())).requeued).toBe(0);
    const later = new Date(Date.now() + 5 * 60_000);
    expect((await runMaintenance(testDb.database, queue, later)).requeued).toBe(1);
    const jobs = await queue.findJobs("project-event");
    expect(jobs.map((job) => (job.data as { sourceEventId: string }).sourceEventId)).toContain(id);
  });
});
