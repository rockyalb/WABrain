import type { ProvidersConfig } from "@wabrain/agent";
import { createMockProviders, mockTranscriptionModel } from "@wabrain/agent/testing";
import { encryptSecret, listProviderSettings, parseEncryptionKey, providerApiKeyAad, saveProviderSettings } from "@wabrain/db";
import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { MockEmbeddingModelV4, MockLanguageModelV4 } from "ai/test";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProviderRegistry, resolveProviders, testProviderRoles } from "./providers.js";

const KEY = parseEncryptionKey(randomBytes(32).toString("base64"));
const DB_SECRET = "sk-db-Stored-Key-0123456789abcdef";
const ENV_SECRET = "sk-env-Env-Key-0123456789abcdef";
const ENV = { AI_TEXT_PROVIDER: "openai", AI_TEXT_MODEL: "gpt-env", AI_TEXT_API_KEY: ENV_SECRET };

const row = (role: "text" | "vision" | "transcription" | "embedding", patch: Record<string, unknown> = {}) => ({
  role,
  provider: "openai",
  model: `${role}-db`,
  baseUrl: null,
  apiKeyEncrypted: null,
  dimensions: null,
  structuredOutputs: null,
  dailyTokenLimit: null,
  dailyCallLimit: null,
  updatedAt: new Date(0),
  ...patch,
});

describe("resolveProviders", () => {
  it("uses the environment when nothing is stored", () => {
    const resolved = resolveProviders([], ENV, null);
    expect(resolved.error).toBeNull();
    expect(resolved.config?.text).toMatchObject({ provider: "openai", model: "gpt-env", apiKey: ENV_SECRET });
    expect(resolved.roles.text).toMatchObject({ source: "env", model: "gpt-env", hasApiKey: true, apiKeySource: "env" });
    expect(resolved.roles.vision).toBeNull();
    expect(JSON.stringify(resolved.roles)).not.toContain(ENV_SECRET);
  });

  it("prefers stored settings per role and decrypts their keys", () => {
    const apiKeyEncrypted = encryptSecret(KEY, DB_SECRET, providerApiKeyAad("text"));
    const resolved = resolveProviders([row("text", { provider: "anthropic", model: "claude-db", apiKeyEncrypted })], ENV, KEY);
    expect(resolved.config?.text).toMatchObject({ provider: "anthropic", model: "claude-db", apiKey: DB_SECRET });
    expect(resolved.roles.text).toMatchObject({ source: "db", hasApiKey: true, apiKeySource: "db" });
    expect(JSON.stringify(resolved.roles)).not.toContain(DB_SECRET);
  });

  it("falls back to the env key only for the same provider and base URL", () => {
    const same = resolveProviders([row("text", { model: "gpt-db" })], ENV, KEY);
    expect(same.config?.text).toMatchObject({ model: "gpt-db", apiKey: ENV_SECRET });
    expect(same.roles.text).toMatchObject({ hasApiKey: true, apiKeySource: "env" });

    const other = resolveProviders([row("text", { provider: "openai-compatible", baseUrl: "https://llm.example/v1" })], ENV, KEY);
    expect(other.config?.text).not.toHaveProperty("apiKey");
    expect(other.roles.text).toMatchObject({ hasApiKey: false, apiKeySource: null });
  });

  it("reports stored budget overrides separately from effective environment limits", () => {
    const resolved = resolveProviders(
      [row("text", { dailyTokenLimit: null, dailyCallLimit: 12 })],
      { ...ENV, AI_TEXT_DAILY_TOKEN_LIMIT: "1000", AI_TEXT_DAILY_CALL_LIMIT: "50" },
      KEY,
    );
    expect(resolved.roles.text).toMatchObject({
      storedDailyTokenLimit: null,
      dailyTokenLimit: 1000,
      storedDailyCallLimit: 12,
      dailyCallLimit: 12,
    });
  });

  it("fails closed on a missing or wrong encryption key without revealing anything", () => {
    const apiKeyEncrypted = encryptSecret(KEY, DB_SECRET, providerApiKeyAad("text"));
    const missing = resolveProviders([row("text", { apiKeyEncrypted })], ENV, null);
    expect(missing.config).toBeNull();
    expect(missing.error).toContain("APP_ENCRYPTION_KEY");
    const wrong = resolveProviders([row("text", { apiKeyEncrypted })], ENV, parseEncryptionKey(randomBytes(32).toString("hex")));
    expect(wrong.config).toBeNull();
    expect(wrong.error).toMatch(/text: .*APP_ENCRYPTION_KEY/);
    for (const text of [missing.error, wrong.error]) {
      expect(text).not.toContain(DB_SECRET);
      expect(text).not.toContain(apiKeyEncrypted);
    }
  });
});

describe("ProviderRegistry", () => {
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

  it("picks up a changed setting without a restart and caches unchanged settings", async () => {
    const built: ProvidersConfig[] = [];
    const registry = new ProviderRegistry({
      database: testDb.database,
      env: ENV,
      encryptionKey: KEY,
      factory: (config) => {
        built.push(config);
        return createMockProviders();
      },
    });

    expect((await registry.load()).roles.text).toMatchObject({ source: "env", model: "gpt-env" });
    await registry.load();
    expect(built).toHaveLength(1);
    expect(built[0]?.text).toMatchObject({ model: "gpt-env", apiKey: ENV_SECRET });

    const { db } = testDb.database;
    await saveProviderSettings(db, KEY, { text: { provider: "anthropic", model: "claude-a", apiKey: DB_SECRET } });
    expect((await registry.load()).roles.text).toMatchObject({ source: "db", model: "claude-a" });
    expect(built.at(-1)?.text).toMatchObject({ provider: "anthropic", model: "claude-a", apiKey: DB_SECRET });

    // A second change within the same millisecond still counts (the whole row is the signature).
    await saveProviderSettings(db, KEY, { text: { provider: "anthropic", model: "claude-b" } });
    expect(built.at(-1)?.text).toMatchObject({ model: "claude-a" });
    await registry.load();
    expect(built.at(-1)?.text).toMatchObject({ model: "claude-b", apiKey: DB_SECRET });
    expect(built).toHaveLength(3);

    await saveProviderSettings(db, KEY, { text: null });
    expect(await listProviderSettings(db)).toEqual([]);
    expect((await registry.load()).roles.text).toMatchObject({ source: "env", model: "gpt-env" });
    expect(built.at(-1)?.text).toMatchObject({ model: "gpt-env" });
  });

  it("reports an unusable configuration instead of building providers", async () => {
    const registry = new ProviderRegistry({ database: testDb.database, env: {}, encryptionKey: null, factory: () => createMockProviders() });
    const state = await registry.load();
    expect(state.providers).toBeNull();
    expect(state.error).toBe("No text provider is configured");
  });
});

describe("testProviderRoles", () => {
  const failing = (message: string) =>
    new MockLanguageModelV4({
      provider: "mock",
      modelId: "broken",
      doGenerate: async () => {
        throw new Error(message);
      },
    });

  it("tests only the requested roles and scrubs keys from provider errors", async () => {
    const embedModel = new MockEmbeddingModelV4({
      provider: "mock",
      modelId: "embed",
      doEmbed: async () => ({ embeddings: [[0.1, 0.2]], usage: { tokens: 1 }, warnings: [] }),
    });
    const providers = createMockProviders({
      text: failing(`401 Incorrect API key provided: ${DB_SECRET}. Also odd-key ${"opaque-" + "9f8e7d6c"}`),
      embedding: embedModel,
      embeddingDimensions: 2,
    });
    const results = await testProviderRoles(providers, { roles: ["text", "embedding"], secrets: [DB_SECRET, "opaque-9f8e7d6c"] });
    expect(Object.keys(results).sort()).toEqual(["embedding", "text"]);
    expect(results.embedding).toMatchObject({ ok: true });
    // Same request shape as indexing: the configured dimensions go to the provider.
    expect(embedModel.doEmbedCalls[0]?.providerOptions).toMatchObject({ openai: { dimensions: 2 }, openaiCompatible: { dimensions: 2 } });
    expect(results.text).toMatchObject({ ok: false, provider: "mock" });
    expect(results.text?.error).toContain("401 Incorrect API key provided");
    expect(JSON.stringify(results)).not.toContain(DB_SECRET);
    expect(JSON.stringify(results)).not.toContain("opaque-9f8e7d6c");
  });

  it("passes a transcription role that hears nothing in the silent sample", async () => {
    const results = await testProviderRoles(createMockProviders({ transcription: mockTranscriptionModel("") }), { roles: ["transcription"] });
    expect(results.transcription).toMatchObject({ ok: true, model: "mock-transcription" });
  });

  it("tests embeddings through the production helper and rejects vectors outside index dimensions", async () => {
    const tooWide = new MockEmbeddingModelV4({
      provider: "mock",
      modelId: "too-wide",
      doEmbed: async () => ({ embeddings: [new Array(1537).fill(0.1)], usage: { tokens: 1 }, warnings: [] }),
    });
    const native = createMockProviders({ embedding: tooWide, embeddingDimensions: null });
    const nativeResult = await testProviderRoles(native, { roles: ["embedding"] });
    expect(nativeResult.embedding).toMatchObject({ ok: false });
    expect(nativeResult.embedding?.error).toContain("index supports at most 1536");

    const oversized = new MockEmbeddingModelV4({
      provider: "mock",
      modelId: "oversized-request",
      doEmbed: async () => ({ embeddings: [[0.1]], usage: { tokens: 1 }, warnings: [] }),
    });
    const configured = createMockProviders({ embedding: oversized, embeddingDimensions: 2048 });
    const configuredResult = await testProviderRoles(configured, { roles: ["embedding"] });
    expect(configuredResult.embedding).toMatchObject({ ok: false });
    expect(configuredResult.embedding?.error).toContain("configuration requests 2048 dimensions");
    expect(oversized.doEmbedCalls).toHaveLength(0);
  });

  it("fails when the provider ignores the configured dimension reduction", async () => {
    const ignoresReduction = new MockEmbeddingModelV4({
      provider: "mock",
      modelId: "no-reduction",
      doEmbed: async () => ({ embeddings: [new Array(3072).fill(0.1)], usage: { tokens: 1 }, warnings: [] }),
    });
    const providers = createMockProviders({ embedding: ignoresReduction, embeddingDimensions: 1536 });
    const result = await testProviderRoles(providers, { roles: ["embedding"] });
    expect(result.embedding).toMatchObject({ ok: false });
    expect(result.embedding?.error).toContain("returned 3072 dimensions, expected 1536");
  });

  it("accepts a native vector below the index size (indexing zero-pads it)", async () => {
    const small = new MockEmbeddingModelV4({
      provider: "mock",
      modelId: "small",
      doEmbed: async () => ({ embeddings: [new Array(768).fill(0.1)], usage: { tokens: 1 }, warnings: [] }),
    });
    const result = await testProviderRoles(createMockProviders({ embedding: small, embeddingDimensions: null }), { roles: ["embedding"] });
    expect(result.embedding).toMatchObject({ ok: true });
  });
});
