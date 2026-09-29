import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JobQueue } from "./queue.js";

let testDb: TestDatabase;
let queue: JobQueue;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
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
    queueOverrides: { maintenance: { retryLimit: 1, retryDelay: 1 } },
  });
  await queue.start();
});
afterAll(async () => {
  await queue.stop({ graceful: false, timeoutMs: 1000 });
  await testDb.drop();
});

describe("JobQueue", () => {
  it("debounces repeated calls into one job that runs after the key is quiet", async () => {
    const runs: { chatId: string; at: number }[] = [];
    await queue.work("analyze-chat", async (data) => void runs.push({ chatId: data.chatId, at: Date.now() }), {
      concurrency: 4,
      pollingIntervalSeconds: 0.5,
    });
    await queue.debounceChat("chat-a", { delayMs: 1500 });
    await sleep(500);
    await queue.debounceChat("chat-a", { delayMs: 1500 });
    await sleep(500);
    const lastCall = Date.now();
    await queue.debounceChat("chat-a", { delayMs: 1500 });

    const queued = await queue.findJobs("analyze-chat", { key: "chat-a", queued: true });
    expect(queued).toHaveLength(1);
    await waitFor(() => runs.length >= 1);
    await sleep(1500);
    expect(runs.filter((run) => run.chatId === "chat-a")).toHaveLength(1);
    expect(runs[0]!.at).toBeGreaterThanOrEqual(lastCall + 1400);

    // A later burst schedules a new run.
    await queue.debounceChat("chat-a", { delayMs: 200 });
    await waitFor(() => runs.length >= 2);
  });

  it("caps postponement with maxWait", async () => {
    await queue.debounceChat("chat-b", { delayMs: 60_000, maxWaitMs: 60_000 });
    await queue.debounceChat("chat-b", { delayMs: 60_000, maxWaitMs: 1_000 });
    const [job] = await queue.findJobs("analyze-chat", { key: "chat-b", queued: true });
    expect(job!.startAfter.getTime() - job!.createdOn.getTime()).toBeLessThan(5_000);
  });

  it("serializes jobs per key while running different keys in parallel", async () => {
    const active = new Map<string, number>();
    let maxSameKey = 0;
    let maxTotal = 0;
    let done = 0;
    await queue.work(
      "process-media",
      async (data) => {
        const key = data.mediaObjectId.split(":")[0]!;
        active.set(key, (active.get(key) ?? 0) + 1);
        maxSameKey = Math.max(maxSameKey, active.get(key)!);
        maxTotal = Math.max(maxTotal, [...active.values()].reduce((a, b) => a + b, 0));
        await sleep(800);
        active.set(key, active.get(key)! - 1);
        done += 1;
      },
      { concurrency: 4, pollingIntervalSeconds: 0.5 },
    );
    await queue.enqueue("process-media", { mediaObjectId: "x:1" }, { singletonKey: "x" });
    await queue.enqueue("process-media", { mediaObjectId: "y:1" }, { singletonKey: "y" });
    await waitFor(() => maxTotal >= 2);
    await queue.enqueue("process-media", { mediaObjectId: "x:2" }, { singletonKey: "x" });
    await waitFor(() => done >= 3);
    expect(maxSameKey).toBe(1);
    expect(maxTotal).toBeGreaterThanOrEqual(2);
  });

  it("retries failures and dead-letters them with the reason", async () => {
    let attempts = 0;
    await queue.work(
      "maintenance",
      async () => {
        attempts += 1;
        throw new Error("provider outage");
      },
      { pollingIntervalSeconds: 0.5 },
    );
    await queue.enqueue("maintenance", {});
    await waitFor(async () => (await queue.deadLetters("maintenance")).length > 0, 30_000);
    expect(attempts).toBe(2);
    const [dead] = await queue.deadLetters("maintenance");
    expect(dead!.data).toEqual({});
    const [failed] = (await queue.boss.findJobs("maintenance")).filter((job) => job.state === "failed");
    expect(JSON.stringify(failed)).toContain("provider outage");
  });

  it("enqueues transactionally", async () => {
    const { database } = testDb;
    await expect(
      database.transaction(async ({ sql }) => {
        await queue.enqueue("project-event", { sourceEventId: "rolled-back" }, { tx: sql });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    await database.transaction(async ({ sql }) => {
      await queue.enqueue("project-event", { sourceEventId: "committed" }, { tx: sql });
    });
    const jobs = await queue.findJobs("project-event");
    const ids = jobs.map((job) => (job.data as { sourceEventId: string }).sourceEventId);
    expect(ids).toContain("committed");
    expect(ids).not.toContain("rolled-back");
  });
});
