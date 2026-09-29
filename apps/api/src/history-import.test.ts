import { startFakeOpenWa, type FakeOpenWa } from "@wabrain/openwa-adapter/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cookieFrom, createHarness, realLimits, type Harness } from "./test/harness.js";

const SESSION = "8f3c2b1a-9d4e-4c7a-8b2f-1e6d5a4c3b2a";
const CHAT = "447690000001@s.whatsapp.net";
let fake: FakeOpenWa;
let harness: Harness;
let cookie: string;

beforeAll(async () => {
  fake = await startFakeOpenWa({
    sessions: [{ id: SESSION, name: "personal", status: "ready" }],
    keys: { viewer: { role: "viewer", allowedSessions: [SESSION] } },
    historyRows: [
      { id: "db-1", waMessageId: "wa-1", chatId: CHAT, chatName: "Sam", timestamp: Math.floor(Date.now() / 1000) - 86_400 },
      { id: "db-2", waMessageId: "wa-2", chatId: CHAT, chatName: "Sam", timestamp: Math.floor(Date.now() / 1000) - 2 * 86_400 },
    ],
  });
  harness = await createHarness({ worker: false, rateLimiters: realLimits, env: {
    OPENWA_BASE_URL: fake.url, OPENWA_READ_API_KEY: "viewer", OPENWA_SESSION_ID: SESSION,
  } });
  cookie = cookieFrom(await harness.request("/setup/bootstrap", { method: "POST", json: { password: "correct horse battery staple" } }));
});
afterAll(async () => { await harness.close(); await fake.close(); });

describe("history import setup endpoints", () => {
  it("shows OpenWA coverage before import using only GET requests", async () => {
    expect((await harness.request("/setup/import/coverage")).status).toBe(401);
    const response = await harness.request("/setup/import/coverage", { headers: { cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      items: [{ chatId: CHAT, chatName: "Sam", messageCount: 2, mediaOk: 0, mediaFailed: 0 }],
      run: null,
    });
    expect(fake.requests.every((request) => request.method === "GET" && request.apiKey === "viewer")).toBe(true);
  });

  it("throttles repeated OpenWA scans", async () => {
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push((await harness.request("/setup/import/coverage", { headers: { cookie } })).status);
    }
    // Three scans per burst, one already used above.
    expect(statuses).toEqual([200, 200, 429]);
  });

  it("queues and cancels the durable import without a WhatsApp write", async () => {
    const start = await harness.request("/setup/import", { method: "POST", headers: { cookie }, json: { days: 90 } });
    expect(start.status).toBe(202);
    expect(await start.json()).toMatchObject({ run: { status: "queued" } });
    expect((await harness.queue.findJobs("import-history")).length).toBe(1);
    // Local progress reports are cheap: served even while OpenWA scans are throttled.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const queued = await harness.request("/setup/import/coverage", { headers: { cookie } });
      expect(queued.status).toBe(200);
      expect(await queued.json()).toMatchObject({ run: { status: "queued" } });
    }
    const cancel = await harness.request("/setup/import", { method: "DELETE", headers: { cookie } });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ run: { status: "cancelled" } });
    expect(fake.requests.every((request) => request.method === "GET")).toBe(true);
  });
});
