/**
 * Durable notifications end to end at the service level: TaskService writes the Review item and its
 * notification in one transaction, PushNotifier pushes per device and records only real successes,
 * and devices can list/acknowledge what they have not handled. The sender is a fake whose outage
 * can be switched on and off; two notifiers stand in for the API and worker processes.
 */
import type { TaskAction } from "@wabrain/contracts";
import {
  acknowledgeNotifications,
  enqueueNotification,
  listDeviceNotifications,
  schema,
  TaskService,
  upsertPushEndpoint,
} from "@wabrain/db";
import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PushNotifier } from "./notifier.js";
import type { PushPayload } from "./payload.js";

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

const T0 = new Date("2026-09-24T09:00:00Z");
const minutes = (n: number) => new Date(T0.getTime() + n * 60_000);

/** A fake push service shared by every notifier in a test. */
function fakeService() {
  const state = { up: true, attempts: [] as string[], sent: [] as Array<{ deviceId: string; payload: PushPayload }> };
  const sender = {
    sendToAll: async () => ({ endpoints: 0, delivered: 0, removed: 0, failed: 0 }),
    sendToDevice: async (payload: PushPayload, deviceId: string) => {
      state.attempts.push(deviceId);
      // Let concurrent flushes interleave, as two processes would.
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!state.up) throw new Error("push service unavailable");
      state.sent.push({ deviceId, payload });
      return { endpoints: 1, delivered: 1, removed: 0, failed: 0 };
    },
  };
  return { state, sender };
}

async function addDevice(id: string, options: { endpoint?: boolean; revoked?: boolean } = {}) {
  const { db } = testDb.database;
  await db.insert(schema.devices).values({ id, name: id, tokenHash: `hash-${id}`, revokedAt: options.revoked ? T0 : null });
  if (options.endpoint !== false) {
    await upsertPushEndpoint(db, id, { endpoint: `https://push.test/${id}`, p256dh: "key", auth: "auth" });
  }
}

const createAction = (title: string): TaskAction => ({
  type: "create",
  kind: "todo",
  title,
  description: "",
  dueAt: null,
  dueHasTime: false,
  contextId: null,
  language: "en",
  confidence: 0.9,
  ambiguityReasons: [],
  evidenceMessageIds: ["m1"],
});

beforeEach(async () => {
  await testDb.database.sql`truncate table notification_events, devices, review_items, tasks, chats, people cascade`;
});

describe("durable notifications", () => {
  it("survives a push outage and delivers exactly once per active device after recovery", async () => {
    const { db } = testDb.database;
    await addDevice("phone");
    await addDevice("tablet");
    await addDevice("laptop");
    await addDevice("poller", { endpoint: false });
    await addDevice("old", { revoked: true });
    const { state, sender } = fakeService();
    let now = T0;
    const clock = () => now;
    const worker = new PushNotifier({ database: testDb.database, sender, now: clock });
    const api = new PushNotifier({ database: testDb.database, sender, now: clock });
    const tasks = new TaskService({ database: testDb.database, notifier: worker, now: clock });

    // Outage: the Review item is created and its immediate push fails for every device.
    state.up = false;
    const result = await tasks.applyAction(createAction("Send the contract"), { outcome: "review", reason: "trial_period" });
    if (result.outcome !== "review") throw new Error("expected review");
    expect(state.attempts.sort()).toEqual(["laptop", "phone", "tablet"]);
    const [event] = await db.select().from(schema.notificationEvents);
    expect(event).toMatchObject({ reviewItemId: result.reviewItem.id });

    // Still down a minute later; the API and the worker flush concurrently without double-sending.
    now = minutes(1);
    state.attempts.length = 0;
    await Promise.all([worker.flushPending(), api.flushPending()]);
    expect(state.attempts.sort()).toEqual(["laptop", "phone", "tablet"]);
    // Within the backoff nothing is retried.
    now = minutes(1.2);
    state.attempts.length = 0;
    await Promise.all([worker.flushPending(), api.flushPending()]);
    expect(state.attempts).toEqual([]);

    // The laptop is revoked during the outage (its endpoint row is left behind on purpose).
    await testDb.database.sql`update devices set revoked_at = ${now.toISOString()} where id = 'laptop'`;

    // Recovery: phone and tablet get it exactly once, whichever process flushes.
    state.up = true;
    now = minutes(15);
    await Promise.all([worker.flushPending(), api.flushPending()]);
    now = minutes(30);
    await Promise.all([worker.flushPending(), api.flushPending(), worker.flushPending()]);
    expect(state.sent.map((s) => s.deviceId).sort()).toEqual(["phone", "tablet"]);
    for (const { payload } of state.sent) {
      expect(payload).toEqual({
        type: "review",
        notificationId: event!.id,
        reviewItemId: result.reviewItem.id,
        reviewType: "create",
        title: "Send the contract",
      });
    }
    const deliveries = await db.select().from(schema.notificationDeliveries);
    expect(deliveries.filter((d) => d.pushedAt).map((d) => d.deviceId).sort()).toEqual(["phone", "tablet"]);
    expect(deliveries.map((d) => d.deviceId)).not.toContain("old");

    // The polling device gets the same event id; acknowledging removes it for that device only.
    const polled = await listDeviceNotifications(db, "poller", now);
    expect(polled).toEqual([{ id: event!.id, createdAt: T0.toISOString(), payload: state.sent[0]!.payload }]);
    await acknowledgeNotifications(db, "poller", [event!.id], now);
    expect(await listDeviceNotifications(db, "poller", now)).toEqual([]);
    // A pushed event stays listed until that device acknowledges it (the app dedupes by id).
    expect(await listDeviceNotifications(db, "phone", now)).toHaveLength(1);
    // Revoked devices have nothing to list.
    expect(await listDeviceNotifications(db, "old", now)).toEqual([]);
  });

  it("says who a Review item came from: the person, and the group they wrote in", async () => {
    const { db } = testDb.database;
    await addDevice("phone");
    const { state, sender } = fakeService();
    const notifier = new PushNotifier({ database: testDb.database, sender, now: () => T0 });
    const tasks = new TaskService({ database: testDb.database, notifier, now: () => T0 });
    await db.insert(schema.people).values({ id: "p-sam", displayName: "Sam" });
    await db.insert(schema.chats).values([
      { id: "c-office", jid: "120363000000000001@g.us", name: "Office", isGroup: true, mode: "on" },
      { id: "c-sam", jid: "447690000001@s.whatsapp.net", name: "Sam K", isGroup: false, mode: "on", personId: "p-sam" },
    ]);

    await tasks.applyAction(createAction("Check the invoice"), { outcome: "review", reason: "trial_period" }, { chatId: "c-office", personId: "p-sam" });
    await tasks.applyAction(createAction("Send the offer"), { outcome: "review", reason: "trial_period" }, { chatId: "c-sam" });
    await tasks.applyAction(createAction("Pay the rent"), { outcome: "review", reason: "trial_period" });

    const from = Object.fromEntries(state.sent.map(({ payload }) => [(payload as { title: string }).title, (payload as { from?: string }).from]));
    expect(from).toEqual({ "Check the invoice": "Sam · Office", "Send the offer": "Sam", "Pay the rent": undefined });
  });

  it("does not alert a Review item decided before its push succeeded", async () => {
    await addDevice("phone");
    await addDevice("poller", { endpoint: false });
    const { state, sender } = fakeService();
    let now = T0;
    const notifier = new PushNotifier({ database: testDb.database, sender, now: () => now });
    const tasks = new TaskService({ database: testDb.database, notifier, now: () => now });

    state.up = false;
    const rejected = await tasks.applyAction(createAction("Pay the invoice"), { outcome: "review", reason: "trial_period" });
    const accepted = await tasks.applyAction(createAction("Thirr kontabilistin"), { outcome: "review", reason: "trial_period" });
    if (rejected.outcome !== "review" || accepted.outcome !== "review") throw new Error("expected review");
    await tasks.rejectReview(rejected.reviewItem.id);
    await tasks.acceptReview(accepted.reviewItem.id);

    state.up = true;
    now = minutes(20);
    await notifier.flushPending();
    expect(state.sent).toEqual([]);
    expect(await listDeviceNotifications(testDb.database.db, "poller", now)).toEqual([]);
  });

  it("does not remind a task that was rescheduled or closed before the push succeeded", async () => {
    const { db } = testDb.database;
    await addDevice("phone");
    await addDevice("poller", { endpoint: false });
    const { state, sender } = fakeService();
    let now = T0;
    const notifier = new PushNotifier({ database: testDb.database, sender, now: () => now });
    const tasks = new TaskService({ database: testDb.database, now: () => now });
    const { task: moved } = await tasks.createManualTask({ kind: "todo", title: "Takim", dueAt: "2026-09-24T10:00:00Z" });
    const { task: done } = await tasks.createManualTask({ kind: "todo", title: "Fatura", dueAt: "2026-09-24T10:00:00Z" });
    const { task: kept } = await tasks.createManualTask({ kind: "todo", title: "Kontrata", dueAt: "2026-09-24T10:00:00Z" });
    for (const task of [moved, done, kept]) {
      await testDb.database.transaction(({ db: tx }) =>
        enqueueNotification(tx, {
          key: `reminder:${task.id}:${task.dueAt}`,
          payload: { type: "reminder", taskId: task.id, title: task.title, dueAt: new Date(task.dueAt!).toISOString() },
          at: now,
          taskId: task.id,
          expiresAt: minutes(24 * 60),
        }),
      );
    }
    state.up = false;
    await notifier.flushPending();
    await tasks.updateTask(moved.id, { dueAt: "2026-09-24T16:00:00Z" });
    await tasks.setStatus(done.id, "done");

    state.up = true;
    now = minutes(20);
    await notifier.flushPending();
    expect(state.sent.map((s) => s.payload)).toEqual([expect.objectContaining({ type: "reminder", taskId: kept.id })]);
    expect((await listDeviceNotifications(db, "poller", now)).map((n) => n.payload)).toEqual([
      expect.objectContaining({ taskId: kept.id }),
    ]);
  });

  it("keeps nothing from a rolled-back transaction and drops expired events", async () => {
    const { db } = testDb.database;
    await addDevice("phone");
    const { state, sender } = fakeService();
    const summary = { type: "summary" as const, open: 1, dueToday: 0, overdue: 0, review: 0 };
    await expect(
      testDb.database.transaction(async ({ db: tx }) => {
        await enqueueNotification(tx, { key: "rolled-back", payload: summary, at: T0, expiresAt: minutes(60) });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db.select().from(schema.notificationEvents)).toEqual([]);

    state.up = false;
    const id = await enqueueNotification(db, { key: "summary:2026-09-24", payload: summary, at: T0, expiresAt: minutes(60) });
    // The same key is one notification.
    expect(await enqueueNotification(db, { key: "summary:2026-09-24", payload: summary, at: T0, expiresAt: minutes(60) })).toBe(id);
    const notifier = new PushNotifier({ database: testDb.database, sender });
    await notifier.flushPending(T0);
    state.up = true;
    await notifier.flushPending(minutes(61));
    expect(state.sent).toEqual([]);
    expect(await listDeviceNotifications(db, "phone", minutes(61))).toEqual([]);
    expect(await db.select().from(schema.notificationEvents)).toEqual([]);
  });
});
