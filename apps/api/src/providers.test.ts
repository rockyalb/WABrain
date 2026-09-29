/**
 * Model provider setup: GET/PUT /setup/providers and POST /setup/providers/test. API keys are
 * write-only: stored encrypted, never returned, never logged, never audited.
 */
import type { ProvidersConfig } from "@wabrain/agent";
import { createMockProviders, mockEmbeddingModel, mockJsonModel } from "@wabrain/agent/testing";
import { decryptSecret, listProviderSettings, parseEncryptionKey, providerApiKeyAad } from "@wabrain/db";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createLogger } from "./logger.js";
import { cookieFrom, createHarness, realLimits, type Harness } from "./test/harness.js";

const ENCRYPTION_KEY = randomBytes(32).toString("base64");
const TEXT_KEY = "sk-proj-TextKey-0123456789abcdefghij";
const EMBED_KEY = "opaque7Embed9Key3Value5XYZ";
const ENV_KEY = "sk-env-EnvKey-0123456789abcdefghij";
const SECRETS = [TEXT_KEY, EMBED_KEY, ENV_KEY];

const logLines: string[] = [];
const built: ProvidersConfig[] = [];

/** Mock models: text answers, the embedding model fails with an error that quotes its key. */
function mockFactory(config: ProvidersConfig) {
  built.push(config);
  const embedding = mockEmbeddingModel(8);
  embedding.doEmbed = async () => {
    throw new Error(`401 Unauthorized: invalid api key ${EMBED_KEY} for ${config.embedding?.baseUrl ?? "?"}?token=abc`);
  };
  return createMockProviders({ text: mockJsonModel("OK"), embedding, transcription: null });
}

let h: Harness;
let cookie = "";

beforeAll(async () => {
  h = await createHarness({
    worker: false,
    rateLimiters: realLimits,
    env: { APP_ENCRYPTION_KEY: ENCRYPTION_KEY },
    logger: createLogger("debug", (line) => logLines.push(line)),
    providerEnv: { AI_TEXT_PROVIDER: "openai", AI_TEXT_MODEL: "gpt-env", AI_TEXT_API_KEY: ENV_KEY },
    providerFactory: mockFactory,
  });
  const boot = await h.request("/setup/bootstrap", { method: "POST", json: { password: "correct horse battery staple" } });
  cookie = cookieFrom(boot);
});
afterAll(async () => {
  await h.close();
});

const get = () => h.request("/setup/providers", { headers: { cookie } });
const put = (json: unknown, headers: Record<string, string> = {}) =>
  h.request("/setup/providers", { method: "PUT", headers: { cookie, ...headers }, json });
const test = (json: unknown = {}) => h.request("/setup/providers/test", { method: "POST", headers: { cookie }, json });

/** Every row of every table in the database, as text. */
async function databaseDump(): Promise<string> {
  const { sql } = h.testDb.database;
  const tables = await sql<{ name: string }[]>`
    select quote_ident(table_schema) || '.' || quote_ident(table_name) as name
    from information_schema.tables
    where table_type = 'BASE TABLE' and table_schema not in ('pg_catalog', 'information_schema')`;
  const parts: string[] = [];
  for (const { name } of tables) {
    const rows = await sql.unsafe(`select t::text as row from ${name} t`);
    parts.push(...rows.map((row) => String(row.row)));
  }
  return parts.join("\n");
}

describe("provider setup", () => {
  it("requires the owner session", async () => {
    expect((await h.request("/setup/providers")).status).toBe(401);
    expect((await h.request("/setup/providers", { method: "PUT", json: {} })).status).toBe(401);
    expect((await h.request("/setup/providers/test", { method: "POST", json: {} })).status).toBe(401);
  });

  it("shows the environment fallback without its key", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      encryptionConfigured: true,
      error: null,
      providers: {
        text: { source: "env", provider: "openai", model: "gpt-env", hasApiKey: true, apiKeySource: "env" },
        vision: null,
        transcription: null,
        embedding: null,
      },
    });
    expect(JSON.stringify(body)).not.toContain(ENV_KEY);
  });

  it("saves settings with write-only keys that are encrypted at rest", async () => {
    const response = await put(
      {
        text: { provider: "anthropic", model: "claude-test", apiKey: TEXT_KEY, dailyTokenLimit: 200000 },
        embedding: { provider: "openai-compatible", model: "bge-m3", baseUrl: "http://ollama:11434/v1", apiKey: EMBED_KEY, dimensions: 1024 },
      },
      { "idempotency-key": "providers-save-1" },
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.providers).toMatchObject({
      text: { source: "db", provider: "anthropic", model: "claude-test", hasApiKey: true, apiKeySource: "db", dailyTokenLimit: 200000, storedDailyTokenLimit: 200000 },
      embedding: { source: "db", provider: "openai-compatible", baseUrl: "http://ollama:11434/v1", hasApiKey: true, dimensions: 1024, storedDailyTokenLimit: null },
      vision: null,
    });
    expect(body.error).toBeNull();

    const rows = await listProviderSettings(h.testDb.database.db);
    const key = parseEncryptionKey(ENCRYPTION_KEY);
    const text = rows.find((row) => row.role === "text")!;
    expect(text.apiKeyEncrypted).not.toContain(TEXT_KEY);
    expect(decryptSecret(key, text.apiKeyEncrypted!, providerApiKeyAad("text"))).toBe(TEXT_KEY);

    const again = await get();
    expect(await again.json()).toMatchObject({ providers: { text: { model: "claude-test", hasApiKey: true } } });

    const status = await (await h.request("/setup/status", { headers: { cookie } })).json();
    expect(status.providers.configured).toEqual(["text", "embedding"]);
  });

  it("keeps a key when it is omitted and clears it on null", async () => {
    let body = await (await put({ text: { provider: "anthropic", model: "claude-next" } })).json();
    expect(body.providers.text).toMatchObject({ model: "claude-next", hasApiKey: true, apiKeySource: "db" });
    body = await (await put({ embedding: { provider: "openai-compatible", model: "bge-m3", baseUrl: "http://ollama:11434/v1", apiKey: null } })).json();
    expect(body.providers.embedding).toMatchObject({ hasApiKey: false, apiKeySource: null });
    // A role's settings are replaced as a whole (except the key), so dimensions were reset too.
    expect(body.providers.embedding.dimensions).toBeNull();
    // Restore for the tests below.
    await put({ embedding: { provider: "openai-compatible", model: "bge-m3", baseUrl: "http://ollama:11434/v1", apiKey: EMBED_KEY, dimensions: 1024 } });
  });

  it("validates settings without echoing the submitted key", async () => {
    const cases: unknown[] = [
      { text: { provider: "openai-compatible", model: "llama", apiKey: TEXT_KEY } },
      { embedding: { provider: "anthropic", model: "x", apiKey: TEXT_KEY } },
      { vision: { provider: "openai", model: "gpt", dimensions: 512, apiKey: TEXT_KEY } },
      { text: { provider: "mistral", model: "m", apiKey: TEXT_KEY } },
      { text: { provider: "openai", model: "gpt", baseUrl: "ftp://files", apiKey: TEXT_KEY } },
      { chat: { provider: "openai", model: "gpt", apiKey: TEXT_KEY } },
    ];
    for (const json of cases) {
      const response = await put(json);
      expect(response.status, JSON.stringify(json)).toBe(400);
      expect(await response.text()).not.toContain(TEXT_KEY);
    }
  });

  it("tests each configured role with the decrypted keys and scrubs keys from errors", async () => {
    built.length = 0;
    const response = await test();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.results.text).toMatchObject({ ok: true, provider: "mock", model: "mock-text" });
    expect(body.results.vision).toMatchObject({ ok: true });
    expect(body.results.embedding).toMatchObject({ ok: false });
    expect(body.results.embedding.error).toContain("401 Unauthorized");
    expect(body.results.transcription).toBeUndefined();
    const text = JSON.stringify(body);
    for (const secret of SECRETS) expect(text).not.toContain(secret);
    expect(text).not.toContain("token=abc");

    // The providers were built from the stored settings with the decrypted keys.
    expect(built).toHaveLength(1);
    expect(built[0]).toMatchObject({
      text: { provider: "anthropic", model: "claude-next", apiKey: TEXT_KEY },
      embedding: { provider: "openai-compatible", apiKey: EMBED_KEY, dimensions: 1024 },
    });

    const only = await (await test({ roles: ["text"] })).json();
    expect(Object.keys(only.results)).toEqual(["text"]);
    expect((await test({ roles: ["chat"] })).status).toBe(400);
  });

  it("never writes a key to the logs, the audit trail, or anywhere else in the database", async () => {
    expect(logLines.length).toBeGreaterThan(0);
    const logs = logLines.join("\n");
    const dump = await databaseDump();
    expect(dump).toContain("providers.changed");
    // The keys are there, but only as ciphertext.
    expect(dump).toMatch(/v1:[\w-]+:[\w-]+:[\w-]+/);
    for (const secret of SECRETS) {
      expect(logs).not.toContain(secret);
      expect(dump).not.toContain(secret);
    }
  });

  it("falls back to the environment when a role is removed", async () => {
    const body = await (await put({ text: null, embedding: null })).json();
    expect(body.providers.text).toMatchObject({ source: "env", model: "gpt-env", hasApiKey: true, apiKeySource: "env" });
    expect(body.providers.embedding).toBeNull();
    expect(await listProviderSettings(h.testDb.database.db)).toEqual([]);
  });

  it("rate-limits the test endpoint, which makes billed calls", async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 8; i += 1) statuses.push((await test({ roles: ["text"] })).status);
    expect(statuses).toContain(429);
  });
});

describe("provider setup without APP_ENCRYPTION_KEY", () => {
  let bare: Harness;
  let bareCookie = "";
  beforeAll(async () => {
    bare = await createHarness({ worker: false, providerFactory: mockFactory });
    bareCookie = cookieFrom(await bare.request("/setup/bootstrap", { method: "POST", json: { password: "correct horse battery staple" } }));
  });
  afterAll(async () => {
    await bare.close();
  });

  it("refuses to store keys but accepts keyless settings", async () => {
    const headers = { cookie: bareCookie };
    expect(await (await bare.request("/setup/providers", { headers })).json()).toMatchObject({
      encryptionConfigured: false,
      error: "No text provider is configured",
      providers: { text: null },
    });
    expect((await bare.request("/setup/providers/test", { method: "POST", headers, json: {} })).status).toBe(409);

    const refused = await bare.request("/setup/providers", { method: "PUT", headers, json: { text: { provider: "openai", model: "gpt", apiKey: TEXT_KEY } } });
    expect(refused.status).toBe(409);
    const refusedText = await refused.text();
    expect(refusedText).toContain("APP_ENCRYPTION_KEY");
    expect(refusedText).not.toContain(TEXT_KEY);
    expect(await listProviderSettings(bare.testDb.database.db)).toEqual([]);

    const local = await bare.request("/setup/providers", {
      method: "PUT",
      headers,
      json: { text: { provider: "openai-compatible", model: "qwen", baseUrl: "http://ollama:11434/v1" } },
    });
    expect(local.status).toBe(200);
    expect(await local.json()).toMatchObject({ error: null, providers: { text: { source: "db", hasApiKey: false } } });
  });
});
