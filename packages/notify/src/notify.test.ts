import { upsertPushEndpoint } from "@wabrain/db";
import { schema } from "@wabrain/db";
import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PushNotifier } from "./notifier.js";
import { encodePayload, MAX_PAYLOAD_BYTES } from "./payload.js";
import { ensureVapidKeys, PushSender } from "./sender.js";
import { createTestSubscription, type TestSubscription } from "./testing.js";

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let testDb: TestDatabase;
let server: Server;
let port = 0;
const received: Received[] = [];
/** Status per path, default 201. */
const statusFor = new Map<string, number>();

/** Routes https://push.test/... to the local plain-HTTP fake push service. */
const localFetch: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  return fetch(`http://127.0.0.1:${port}${url.pathname}`, init);
};

async function device(name: string, sub: TestSubscription, path: string) {
  const { db } = testDb.database;
  const id = `device-${name}`;
  await db.insert(schema.devices).values({ id, name, tokenHash: `hash-${name}` });
  await upsertPushEndpoint(db, id, { endpoint: `https://push.test${path}`, p256dh: sub.p256dh, auth: sub.auth });
  return id;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = statusFor.get(req.url ?? "") ?? 201;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  server.close();
  await testDb.drop();
});

describe("Web Push sender", () => {
  it("encrypts payloads to each subscription (aes128gcm) with VAPID, and drops gone endpoints", async () => {
    const vapid = await ensureVapidKeys(testDb.database);
    expect(await ensureVapidKeys(testDb.database)).toEqual(vapid);
    const phone = createTestSubscription();
    const tablet = createTestSubscription();
    await device("phone", phone, "/up/phone");
    await device("tablet", tablet, "/up/tablet");
    statusFor.set("/up/tablet", 410);

    const sender = new PushSender({ database: testDb.database, vapid, allowHost: "push.test", fetch: localFetch, vapidSubject: "mailto:owner@example.com" });
    const report = await sender.sendToAll({ type: "review", reviewItemId: "r1", reviewType: "create", title: "Send the contract" });
    expect(report).toEqual({ endpoints: 2, delivered: 1, removed: 1, failed: 0 });

    const toPhone = received.find((request) => request.path === "/up/phone")!;
    expect(toPhone.headers["content-encoding"]).toBe("aes128gcm");
    expect(toPhone.headers.urgency).toBe("high");
    expect(String(toPhone.headers.authorization)).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${vapid.publicKey}$`));
    expect(toPhone.body.toString("utf8")).not.toContain("kontraten");
    expect(JSON.parse(phone.decrypt(toPhone.body))).toEqual({ type: "review", reviewItemId: "r1", reviewType: "create", title: "Send the contract" });
    expect(() => tablet.decrypt(toPhone.body)).toThrow();

    const endpoints = await testDb.database.db.select().from(schema.pushEndpoints);
    expect(endpoints.map((row) => row.deviceId)).toEqual(["device-phone"]);
  });

  it("re-validates endpoints against the SSRF guard at send time", async () => {
    const vapid = await ensureVapidKeys(testDb.database);
    const sender = new PushSender({
      database: testDb.database,
      vapid,
      fetch: localFetch,
      resolve: async () => ["10.0.0.5"],
    });
    const before = received.length;
    const report = await sender.sendToAll({ type: "sync" });
    expect(report.failed).toBe(1);
    expect(received.length).toBe(before);
    const [row] = (await testDb.database.db.select().from(schema.pushEndpoints)).filter((r) => r.deviceId === "device-phone");
    expect(row!.failureCount).toBe(1);
  });

  it("keeps payloads under 3 KB by shortening the title", () => {
    const json = encodePayload({ type: "reminder", taskId: "t", title: "x".repeat(10_000), dueAt: "2026-09-24T15:00:00.000Z" });
    expect(Buffer.byteLength(json) + 103).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(JSON.parse(json).title.length).toBeLessThanOrEqual(200);
  });
});

describe("PushNotifier", () => {
  it("coalesces sync bursts and pushes every review item", async () => {
    const sent: string[] = [];
    const notifier = new PushNotifier({
      sender: { sendToAll: async (payload) => (sent.push(payload.type), { endpoints: 1, delivered: 1, removed: 0, failed: 0 }) },
      syncIntervalMs: 300,
    });
    for (let i = 0; i < 5; i++) await notifier.notify({ type: "sync" });
    await notifier.notify({ type: "review", reviewItemId: "a", reviewType: "create", title: "A" });
    await notifier.notify({ type: "review", reviewItemId: "b", reviewType: "possibly_done", title: "B" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(sent).toEqual(["review", "review", "sync"]);
    for (let i = 0; i < 5; i++) await notifier.notify({ type: "sync" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(sent.filter((type) => type === "sync")).toHaveLength(1); // still inside the interval
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(sent.filter((type) => type === "sync")).toHaveLength(2);
    await notifier.notify({ type: "sync" });
    await notifier.flush();
    expect(sent.filter((type) => type === "sync")).toHaveLength(3);
  });
});
