import type { TaskAction } from "@wabrain/contracts";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret, EncryptionKeyError, parseEncryptionKey } from "../crypto.js";
import type { ChangeEvent } from "../notifier.js";
import { people, personFacts, reviewItems, tasks } from "../schema.js";
import { TaskService } from "../services/tasks.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { getOrCreateAppState } from "./app-state.js";
import { recordModelUsage, usageSince } from "./model-usage.js";
import { claimNotification } from "./notification-log.js";
import { applyProposedFacts, claimDailyProfile } from "./pipeline.js";
import { deleteProviderSettings, listProviderSettings, upsertProviderSettings } from "./provider-settings.js";

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});

describe("secret encryption", () => {
  const key = parseEncryptionKey(randomBytes(32).toString("base64"));

  it("round-trips and binds the ciphertext to its purpose", () => {
    const blob = encryptSecret(key, "sk-test-123", "provider:text");
    expect(blob).not.toContain("sk-test-123");
    expect(decryptSecret(key, blob, "provider:text")).toBe("sk-test-123");
    expect(() => decryptSecret(key, blob, "provider:vision")).toThrow(EncryptionKeyError);
    const other = parseEncryptionKey(randomBytes(32).toString("hex"));
    expect(() => decryptSecret(other, blob, "provider:text")).toThrow(EncryptionKeyError);
  });

  it("rejects weak or malformed keys without echoing them", () => {
    for (const value of ["short", "a".repeat(64), Buffer.alloc(32).toString("base64")]) {
      try {
        parseEncryptionKey(value);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(EncryptionKeyError);
        expect((error as Error).message).not.toContain(value);
      }
    }
  });
});

describe("pipeline repositories", () => {
  it("stores provider settings and keeps the key when the update omits it", async () => {
    const { db } = testDb.database;
    const base = { provider: "openai", model: "gpt-x", baseUrl: null, dimensions: null, structuredOutputs: null, dailyTokenLimit: 1000, dailyCallLimit: null };
    await upsertProviderSettings(db, "text", { ...base, apiKeyEncrypted: "v1:a:b:c" });
    await upsertProviderSettings(db, "text", { ...base, model: "gpt-y" });
    const [row] = await listProviderSettings(db);
    expect(row).toMatchObject({ role: "text", model: "gpt-y", apiKeyEncrypted: "v1:a:b:c", dailyTokenLimit: 1000 });
    await deleteProviderSettings(db, "text");
    expect(await listProviderSettings(db)).toEqual([]);
  });

  it("counts model usage per role since a moment", async () => {
    const { db } = testDb.database;
    const since = new Date(Date.now() - 1000);
    await recordModelUsage(db, { role: "vision", purpose: "image", inputTokens: 10, outputTokens: 5 });
    await recordModelUsage(db, { role: "vision", purpose: "image", inputTokens: null, outputTokens: null });
    await recordModelUsage(db, { role: "vision", purpose: "image", inputTokens: 99, at: new Date(since.getTime() - 60_000) });
    expect(await usageSince(db, "vision", since)).toEqual({ calls: 2, tokens: 15 });
  });

  it("claims scheduled notifications and daily profiles once", async () => {
    const { db } = testDb.database;
    expect(await claimNotification(db, "reminder", "t1:2026-09-24T15:00:00.000Z")).toBe(true);
    expect(await claimNotification(db, "reminder", "t1:2026-09-24T15:00:00.000Z")).toBe(false);
    expect(await claimNotification(db, "reminder", "t1:2026-09-25T15:00:00.000Z")).toBe(true);

    const chatId = await createChat();
    const now = new Date();
    expect(await claimDailyProfile(db, chatId, "2026-09-23", now)).toBe(true);
    expect(await claimDailyProfile(db, chatId, "2026-09-23", now)).toBe(false);
    expect(await claimDailyProfile(db, chatId, "2026-09-24", now)).toBe(true);
  });

  it("creates app state once", async () => {
    const { db } = testDb.database;
    const first = await getOrCreateAppState(db, "vapid", () => ({ n: 1 }));
    const second = await getOrCreateAppState(db, "vapid", () => ({ n: 2 }));
    expect(first).toEqual({ n: 1 });
    expect(second).toEqual({ n: 1 });
  });

  it("never touches owner or verified facts and keeps self-claims unverified", async () => {
    const { db } = testDb.database;
    const personId = "person-facts-1";
    await db.insert(people).values({ id: personId, displayName: "Ana" });
    await db.insert(personFacts).values([
      { id: "f-owner", personId, key: "role", value: "CFO", confidence: 1, verified: true, source: "owner" },
      { id: "f-ai", personId, key: "company", value: "Acme", confidence: 0.5, source: "ai" },
    ]);
    await applyProposedFacts(db, personId, [
      { key: "role", value: "CEO", confidence: 0.9, selfClaimed: true, sourceMessageIds: ["m1"], existingFactId: "f-owner" },
      { key: "company", value: "Vodafone", confidence: 0.8, selfClaimed: true, sourceMessageIds: ["m2"], existingFactId: null },
      { key: "topic", value: "invoices", confidence: 0.7, selfClaimed: false, sourceMessageIds: ["m3"], existingFactId: null },
    ]);
    const rows = await db.select().from(personFacts).where(eq(personFacts.personId, personId));
    expect(rows.find((row) => row.id === "f-owner")).toMatchObject({ value: "CFO", verified: true });
    expect(rows.filter((row) => row.key === "company")).toEqual([
      expect.objectContaining({ id: "f-ai", value: "Vodafone", selfClaimed: true, verified: false }),
    ]);
    expect(rows.find((row) => row.key === "topic")).toMatchObject({ value: "invoices", verified: false, source: "ai" });
  });
});

describe("exactly-once agent actions", () => {
  const create: TaskAction = {
    type: "create",
    kind: "todo",
    title: "Send the contract",
    description: "",
    dueAt: null,
    dueHasTime: false,
    contextId: null,
    language: "en",
    confidence: 0.95,
    ambiguityReasons: [],
    evidenceMessageIds: ["m1"],
  };

  it("applies an action key once and replays the outcome without notifying", async () => {
    const events: ChangeEvent[] = [];
    const service = new TaskService({ database: testDb.database, notifier: { notify: (event) => void events.push(event) } });
    const first = await service.applyAction(create, { outcome: "apply", reason: "auto_create" }, { actionKey: "run-1:0" });
    const again = await service.applyAction(create, { outcome: "apply", reason: "auto_create" }, { actionKey: "run-1:0" });
    if (first.outcome !== "applied" || again.outcome !== "applied") throw new Error("expected applied");
    expect(again.task.id).toBe(first.task.id);
    const rows = await testDb.database.db.select().from(tasks).where(eq(tasks.title, "Send the contract"));
    expect(rows).toHaveLength(1);
    expect(events).toEqual([{ type: "sync" }]);

    const review = { ...create, title: "Pay the invoice" };
    const r1 = await service.applyAction(review, { outcome: "review", reason: "trial_period" }, { actionKey: "run-1:1" });
    const r2 = await service.applyAction(review, { outcome: "review", reason: "trial_period" }, { actionKey: "run-1:1" });
    if (r1.outcome !== "review" || r2.outcome !== "review") throw new Error("expected review");
    expect(r1.created).toBe(true);
    expect(r2).toMatchObject({ created: false, reviewItem: { id: r1.reviewItem.id } });
    expect(await testDb.database.db.select().from(reviewItems).where(eq(reviewItems.id, r1.reviewItem.id))).toHaveLength(1);
    expect(events.filter((event) => event.type === "review")).toHaveLength(1);
  });
});

async function createChat(): Promise<string> {
  const { chats } = await import("../schema.js");
  const id = `chat-${randomBytes(4).toString("hex")}`;
  await testDb.database.db.insert(chats).values({ id, jid: `${id}@s.whatsapp.net`, isGroup: false, mode: "on" });
  return id;
}
