import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, parseEncryptionKey } from "../crypto.js";
import { DomainError } from "../errors.js";
import { listProviderSettings } from "../repos/provider-settings.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { providerApiKeyAad, saveProviderSettings } from "./provider-settings.js";

const KEY = parseEncryptionKey(randomBytes(32).toString("base64"));
const SECRET = "sk-live-Provider-Key-0123456789abcdef";

let testDb: TestDatabase;
beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});
beforeEach(async () => {
  await testDb.database.sql`delete from provider_settings`;
});

const rowFor = async (role: string) => (await listProviderSettings(testDb.database.db)).find((row) => row.role === role);

describe("saveProviderSettings", () => {
  it("encrypts the key at rest with a role-bound AAD and round-trips it", async () => {
    const { db } = testDb.database;
    const summary = await saveProviderSettings(db, KEY, { text: { provider: "openai", model: "gpt-x", apiKey: SECRET } });
    expect(summary).toEqual([{ role: "text", action: "saved", apiKey: "set" }]);

    const [raw] = await testDb.database.sql`select * from provider_settings`;
    expect(JSON.stringify(raw)).not.toContain(SECRET);
    const row = await rowFor("text");
    expect(row?.apiKeyEncrypted).toMatch(/^v1:/);
    expect(decryptSecret(KEY, row!.apiKeyEncrypted!, providerApiKeyAad("text"))).toBe(SECRET);
    // Bound to the role: the same ciphertext does not decrypt as another role's key.
    expect(() => decryptSecret(KEY, row!.apiKeyEncrypted!, providerApiKeyAad("vision"))).toThrow();
  });

  it("keeps an omitted key, clears a null key, and removes a null role", async () => {
    const { db } = testDb.database;
    await saveProviderSettings(db, KEY, { text: { provider: "openai", model: "gpt-x", apiKey: SECRET }, vision: { provider: "openai", model: "gpt-v" } });
    const stored = (await rowFor("text"))!.apiKeyEncrypted;

    expect(await saveProviderSettings(db, KEY, { text: { provider: "openai", model: "gpt-y", dailyCallLimit: 50 } })).toEqual([
      { role: "text", action: "saved", apiKey: "kept" },
    ]);
    expect(await rowFor("text")).toMatchObject({ model: "gpt-y", apiKeyEncrypted: stored, dailyCallLimit: 50 });

    expect(await saveProviderSettings(db, KEY, { text: { provider: "openai", model: "gpt-y", apiKey: null } })).toEqual([
      { role: "text", action: "saved", apiKey: "cleared" },
    ]);
    expect((await rowFor("text"))!.apiKeyEncrypted).toBeNull();

    expect(await saveProviderSettings(db, KEY, { vision: null, embedding: null })).toEqual([{ role: "vision", action: "removed", apiKey: "none" }]);
    expect(await rowFor("vision")).toBeUndefined();
  });

  it("drops the stored key when the provider or base URL changes without a new key", async () => {
    const { db } = testDb.database;
    await saveProviderSettings(db, KEY, { text: { provider: "openai", model: "gpt-x", apiKey: SECRET } });
    expect(await saveProviderSettings(db, KEY, { text: { provider: "anthropic", model: "claude-x" } })).toEqual([
      { role: "text", action: "saved", apiKey: "cleared" },
    ]);
    expect((await rowFor("text"))!.apiKeyEncrypted).toBeNull();

    await saveProviderSettings(db, KEY, { text: { provider: "openai-compatible", model: "llama", baseUrl: "http://ollama:11434/v1", apiKey: SECRET } });
    await saveProviderSettings(db, KEY, { text: { provider: "openai-compatible", model: "llama", baseUrl: "https://elsewhere.example/v1" } });
    expect((await rowFor("text"))!.apiKeyEncrypted).toBeNull();
  });

  it("refuses to store a key without APP_ENCRYPTION_KEY, and writes nothing", async () => {
    const { db } = testDb.database;
    let error: unknown;
    try {
      await saveProviderSettings(db, null, { vision: { provider: "openai", model: "gpt-v" }, text: { provider: "openai", model: "gpt-x", apiKey: SECRET } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("conflict");
    expect((error as Error).message).not.toContain(SECRET);
    expect(await listProviderSettings(db)).toEqual([]);
    // Settings without keys (e.g. a local Ollama) work without the encryption key.
    await saveProviderSettings(db, null, { text: { provider: "openai-compatible", model: "llama", baseUrl: "http://ollama:11434/v1" } });
    expect(await rowFor("text")).toMatchObject({ provider: "openai-compatible", apiKeyEncrypted: null });
  });
});
