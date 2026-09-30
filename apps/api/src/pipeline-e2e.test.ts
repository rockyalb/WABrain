/**
 * End to end through the running processes: the API bootstrap (startRuntime, with its Web Push
 * notifier) and the worker runtime (startPipelineWorker, as run by apps/worker and by the embedded
 * worker), with mocked model providers and a fake UnifiedPush endpoint that decrypts what it gets.
 *
 * signed webhook → source event → projection → debounce → analysis → policy → Review / task change
 * → ChangeNotifier → Web Push (aes128gcm + VAPID) → device.
 */
import { createMockProviders, parseAnalysisPrompt, scriptedJsonModel } from "@wabrain/agent/testing";
import { getAppState, schema } from "@wabrain/db";
import { createTestDatabase, makeOpenWaEnvelope, type TestDatabase } from "@wabrain/db/testing";
import { localDay } from "@wabrain/jobs";
import type { PushPayload, VapidKeys } from "@wabrain/notify";
import { createTestSubscription, type TestSubscription } from "@wabrain/notify/testing";
import { pipelineEnvFrom, startPipelineWorker, type PipelineWorker } from "@wabrain/worker/runtime";
import { and, eq } from "drizzle-orm";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";
import { silentLogger } from "./logger.js";
import { startRuntime } from "./runtime.js";
import { ownerAndDevice, PUBLIC_BASE_URL, sign, unlimited, waitFor, WEBHOOK_SECRET, type Harness } from "./test/harness.js";

const OWNER = "447690000000@s.whatsapp.net";
const CONTACT = "447690000777@s.whatsapp.net";
const PUSH_HOST = "push.test";

interface Received {
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

let testDb: TestDatabase;
let pushServer: Server;
let pushPort = 0;
const received: Received[] = [];
let runtime: Awaited<ReturnType<typeof startRuntime>>;
let worker: PipelineWorker;
let phone: TestSubscription;
let auth: Record<string, string>;
let cookie: string;

/** Routes https://push.test/... (the registered endpoint) to the local plain-HTTP fake push service. */
const pushFetch: typeof fetch = (input, init) => {
  const url = new URL(String(input));
  return fetch(`http://127.0.0.1:${pushPort}${url.pathname}`, init);
};

/** Creates a todo for "contract" messages; completes the first open task on "sent"/"done". */
const textModel = scriptedJsonModel(({ text }) => {
  if (!text.includes('{"now"')) return { facts: [] }; // the profile job
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
    if ((lower.includes("sent") || lower.includes("done")) && prompt.openTasks[0]) {
      actions.push({
        type: "complete", kind: null, title: null, description: null, language: null, due: null,
        taskId: prompt.openTasks[0].id, taskIds: null, contextId: null, contextReason: null, handled: null,
        confidence: 0.95, ambiguityReasons: [], evidenceMessageIds: [message.id],
      });
    }
  }
  return { actions };
});

function request(path: string, init: RequestInit & { json?: unknown } = {}) {
  const { json, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (json !== undefined) headers.set("content-type", "application/json");
  return Promise.resolve(runtime.app.request(path, { ...rest, headers, body: json !== undefined ? JSON.stringify(json) : rest.body }));
}

function deliver(envelope: ReturnType<typeof makeOpenWaEnvelope>) {
  const body = JSON.stringify(envelope);
  return request("/webhooks/openwa", { method: "POST", headers: { "content-type": "application/json", "x-openwa-signature": sign(body) }, body });
}

/** Pushes that reached the phone's endpoint, decrypted with the phone's subscription keys. */
const pushes = (): PushPayload[] =>
  received.filter((r) => r.path === "/up/phone").map((r) => JSON.parse(phone.decrypt(r.body)) as PushPayload);

const waitForPush = (match: (payload: PushPayload) => boolean, after = 0) =>
  waitFor(async () => pushes().slice(after).find(match) ?? null);

beforeAll(async () => {
  testDb = await createTestDatabase();
  pushServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      res.statusCode = 201;
      res.end();
    });
  });
  await new Promise<void>((resolve) => pushServer.listen(0, "127.0.0.1", resolve));
  pushPort = (pushServer.address() as AddressInfo).port;

  const env = {
    NODE_ENV: "test",
    DATABASE_URL: testDb.url,
    PUBLIC_BASE_URL,
    OPENWA_WEBHOOK_SECRET: WEBHOOK_SECRET,
    SELF_JID: OWNER,
    SELF_ALIASES: "Alex",
    NTFY_HOST: PUSH_HOST,
    EMBEDDED_WORKER: "true",
    VAPID_SUBJECT: "mailto:owner@example.com",
    ANALYSIS_DEBOUNCE_MS: "200",
    ANALYSIS_MAX_WAIT_MS: "2000",
  };
  const config = loadConfig(env);
  const pipelineEnv = pipelineEnvFrom(env);
  // Exactly what apps/api/src/index.ts does with EMBEDDED_WORKER=true, plus the test seams.
  runtime = await startRuntime(config, silentLogger, {
    push: { vapidSubject: pipelineEnv.vapidSubject, fetch: pushFetch, syncIntervalMs: 50 },
    overrides: { rateLimiters: unlimited },
  });
  worker = await startPipelineWorker({
    database: runtime.database,
    queue: runtime.queue,
    filter: runtime.deps.intakeFilter,
    logger: silentLogger,
    pipeline: pipelineEnv,
    // Provider settings resolve from the environment as in production; only the models are mocked.
    env: { AI_TEXT_PROVIDER: "openai", AI_TEXT_MODEL: "gpt-test", AI_TEXT_API_KEY: "sk-test-not-real" },
    overrides: { providerFactory: () => createMockProviders({ text: textModel }), pushFetch, syncIntervalMs: 50 },
  });

  const owner = await ownerAndDevice({ request } as Harness);
  cookie = owner.cookie;
  auth = { authorization: `Bearer ${owner.token}` };
  phone = createTestSubscription();
  const registered = await request("/v1/push-endpoints", {
    method: "POST",
    headers: auth,
    json: { endpoint: `https://${PUSH_HOST}/up/phone`, p256dh: phone.p256dh, auth: phone.auth },
  });
  expect(registered.status).toBe(204);
});

afterAll(async () => {
  await worker?.stop();
  await runtime?.push.flush();
  await runtime?.queue.stop({ graceful: false, timeoutMs: 1000 });
  await runtime?.database.close();
  pushServer?.close();
  await testDb?.drop();
});

describe("pipeline and push, end to end", () => {
  let chatId = "";
  let taskId = "";

  it("generates and stores VAPID keys on first boot; the API and worker share them", async () => {
    const stored = await getAppState<VapidKeys>(testDb.database.db, "push.vapid");
    expect(stored?.publicKey).toMatch(/^[\w-]{80,}$/);
    expect(worker.vapidPublicKey).toBe(stored!.publicKey);
  });

  it("(1) turns a signed webhook into a Review item during the trial, due tomorrow 17:00 in the default timezone (UTC)", async () => {
    const response = await deliver(makeOpenWaEnvelope({ data: { chatId: CONTACT, from: CONTACT, body: "send me the contract tomorrow", contact: { name: "Sam" } } }));
    expect(response.status).toBe(202);

    const item = await waitFor(async () => {
      const [row] = await testDb.database.db.select().from(schema.reviewItems).where(eq(schema.reviewItems.type, "create"));
      return row ?? null;
    });
    chatId = item.chatId!;
    expect(item).toMatchObject({ state: "pending", reason: "trial_period" });
    const action = item.action as { title: string; dueAt: string; dueHasTime: boolean };
    const tomorrow = localDay(new Date(Date.now() + 86_400_000), "UTC").date;
    expect(action).toMatchObject({ title: "Send the contract", dueHasTime: false });
    expect(action.dueAt).toMatch(new RegExp(`^${tomorrow}T17:00:00\\+00:00$`));
    expect(await testDb.database.db.select().from(schema.tasks)).toEqual([]);

    const review = (await (await request("/v1/review", { headers: auth })).json()) as { items: Array<{ id: string; type: string }> };
    expect(review.items).toEqual([expect.objectContaining({ id: item.id, type: "create" })]);
  });

  it("(2) pushes the Review item, encrypted to the device and signed with VAPID", async () => {
    const [item] = await testDb.database.db.select().from(schema.reviewItems).where(eq(schema.reviewItems.type, "create"));
    const payload = await waitForPush((p) => p.type === "review");
    expect(payload).toEqual({
      type: "review",
      notificationId: expect.any(String),
      reviewItemId: item!.id,
      reviewType: "create",
      title: "Send the contract",
      from: "Sam",
    });
    // The fallback list carries the same durable id, so the app shows it only once.
    const listed = (await (await request("/v1/notifications", { headers: auth })).json()) as { items: Array<{ id: string; payload: unknown }> };
    expect(listed.items).toEqual([expect.objectContaining({ id: (payload as { notificationId: string }).notificationId, payload })]);

    const raw = received.find((r) => r.path === "/up/phone" && JSON.parse(phone.decrypt(r.body)).type === "review")!;
    expect(raw.headers["content-encoding"]).toBe("aes128gcm");
    expect(raw.body.toString("utf8")).not.toContain("contract");
    expect(String(raw.headers.authorization)).toContain(`k=${worker.vapidPublicKey}`);
    expect(() => createTestSubscription().decrypt(raw.body)).toThrow();

    // An owner action in the app goes through the API's TaskService and pushes sync.
    const before = pushes().length;
    const accepted = await request(`/v1/review/${item!.id}/accept`, { method: "POST", headers: auth, json: {} });
    expect(accepted.status).toBe(200);
    await waitForPush((p) => p.type === "sync", before);
    // A decided Review item is no longer offered to the fallback.
    expect(await (await request("/v1/notifications", { headers: auth })).json()).toEqual({ items: [] });
    const [task] = await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.chatId, chatId));
    expect(task).toMatchObject({ status: "open", title: "Send the contract" });
    taskId = task!.id;
  });

  it("(4) someone else's 'done' produces a possibly_done Review item and a push", async () => {
    const before = pushes().length;
    expect((await deliver(makeOpenWaEnvelope({ data: { chatId: CONTACT, from: CONTACT, body: "done, got it", contact: { name: "Sam" } } }))).status).toBe(202);

    const item = await waitFor(async () => {
      const [row] = await testDb.database.db
        .select()
        .from(schema.reviewItems)
        .where(and(eq(schema.reviewItems.type, "possibly_done"), eq(schema.reviewItems.taskId, taskId)));
      return row ?? null;
    });
    expect(item).toMatchObject({ state: "pending", reason: "non_owner_evidence" });
    const payload = await waitForPush((p) => p.type === "review", before);
    expect(payload).toEqual({
      type: "review",
      notificationId: expect.any(String),
      reviewItemId: item.id,
      reviewType: "possibly_done",
      title: "Send the contract",
      from: "Sam",
    });
    const [task] = await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
    expect(task!.status).toBe("open");
  });

  it("(3) the owner's 'sent it ✅' closes the task after the trial", async () => {
    const policy = await request("/setup/policy", { method: "PATCH", headers: { cookie }, json: { trialDays: 0 } });
    expect(policy.status).toBe(200);
    const before = pushes().length;
    const sent = makeOpenWaEnvelope({
      event: "message.sent",
      data: { chatId: CONTACT, from: OWNER, to: CONTACT, fromMe: true, body: "sent it ✅", contact: { name: "Sam" } },
    });
    expect((await deliver(sent)).status).toBe(202);

    const done = await waitFor(async () => {
      const [row] = await testDb.database.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskId));
      return row?.status === "done" ? row : null;
    });
    expect(done).toMatchObject({ status: "done" });
    const events = await testDb.database.db.select().from(schema.taskEvents).where(eq(schema.taskEvents.taskId, taskId));
    expect(events).toContainEqual(expect.objectContaining({ type: "completed", actor: "ai" }));
    await waitForPush((p) => p.type === "sync", before);
  });
});
