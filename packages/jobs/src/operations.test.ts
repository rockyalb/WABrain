import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { failureSummary, listFailedJobs, redactedSubject, retryFailedJob } from "./operations.js";
import { JobQueue } from "./queue.js";

describe("failureSummary", () => {
  it("provides actionable categories without leaking exception content", () => {
    const secret = "sk-sensitive-real-secret";
    expect(failureSummary({ message: `429 ${secret} private message` })).toContain("rate limit");
    expect(failureSummary({ message: `ECONNRESET https://private.invalid?key=${secret}` })).toContain("outage");
    expect(failureSummary({ message: `unknown ${secret}` })).not.toContain(secret);
    expect(failureSummary({ message: "document timed out" })).toContain("Timed out");
  });

  it("shows only UUID payload values", () => {
    const id = randomUUID();
    expect(redactedSubject({ chatId: id, jid: "447690000000@c.us" })).toEqual({ chatId: id, jid: "[redacted]" });
    expect(redactedSubject(null)).toEqual({});
  });
});

describe("failed job inspection against pg-boss", () => {
  let testDb: TestDatabase;
  let queue: JobQueue;
  const SECRET = "sk-live-0123456789abcdef private chat text";
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) return;
      await sleep(100);
    }
    throw new Error("timed out");
  }

  beforeAll(async () => {
    testDb = await createTestDatabase({ migrate: false });
    queue = new JobQueue({
      connectionString: testDb.url,
      logger: { info() {}, warn() {}, error() {} },
      queueOverrides: { "profile-chat": { retryLimit: 0, retryDelay: 1 } },
    });
    await queue.start();
  });
  afterAll(async () => {
    await queue.stop({ graceful: false, timeoutMs: 1000 });
    await testDb.drop();
  });

  it("lists exhausted jobs redacted and retries one deliberately", async () => {
    const chatId = randomUUID();
    let runs = 0;
    let fail = true;
    await queue.work(
      "profile-chat",
      async () => {
        runs += 1;
        if (fail) throw new Error(`401 invalid api key ${SECRET}`);
      },
      { pollingIntervalSeconds: 0.5 },
    );
    await queue.enqueue("profile-chat", { chatId }, { singletonKey: chatId });
    await waitFor(async () => (await listFailedJobs(testDb.database)).items.length > 0);

    const report = await listFailedJobs(testDb.database);
    expect(report.counts).toEqual({ "profile-chat": 1 });
    const [failed] = report.items;
    expect(failed).toMatchObject({ queue: "profile-chat", subject: { chatId }, attempts: 1 });
    expect(failed!.sourceJobId).toMatch(/^[0-9a-f-]{36}$/);
    expect(failed!.reason).toContain("authorization");
    expect(JSON.stringify(report)).not.toContain("sk-live");
    expect((await listFailedJobs(testDb.database, { queue: "analyze-chat" })).items).toEqual([]);
    await expect(listFailedJobs(testDb.database, { queue: "nope" as never })).rejects.toThrow("Unknown queue");

    await expect(retryFailedJob(testDb.database, queue, "not-a-uuid")).rejects.toThrow("must be a UUID");
    await expect(retryFailedJob(testDb.database, queue, randomUUID())).rejects.toThrow("No waiting failed job");

    fail = false;
    const result = await retryFailedJob(testDb.database, queue, failed!.id);
    expect(result.queue).toBe("profile-chat");
    expect(result.jobId).toMatch(/^[0-9a-f-]{36}$/);
    expect((await listFailedJobs(testDb.database)).items).toEqual([]);
    await waitFor(async () => runs >= 2);
    // A second retry of the same entry is refused: it left the dead-letter queue.
    await expect(retryFailedJob(testDb.database, queue, failed!.id)).rejects.toThrow("No waiting failed job");
  });

  it("refuses a dead-lettered payload that no longer matches its job schema", async () => {
    const [row] = await testDb.database.sql<{ id: string }[]>`
      insert into pgboss.job (name, data, source_name) values ('dead.embed-chat', ${JSON.stringify({ chatId: 42 })}::jsonb, 'embed-chat')
      returning id`;
    await expect(retryFailedJob(testDb.database, queue, row!.id)).rejects.toThrow("no longer matches");
    expect((await listFailedJobs(testDb.database, { queue: "embed-chat" })).counts).toEqual({ "embed-chat": 1 });
  });
});
