import type { ProvidersConfig } from "@wabrain/agent";
import { createMockProviders } from "@wabrain/agent/testing";
import { getAppState, parseEncryptionKey, saveProviderSettings } from "@wabrain/db";
import { randomBytes } from "node:crypto";
import { createTestDatabase, type TestDatabase } from "@wabrain/db/testing";
import { JobQueue, defaultPipelineConfig } from "@wabrain/jobs";
import { createRulesIntakeFilter } from "@wabrain/rules";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pipelineEnvFrom, startPipelineWorker, WorkerConfigError } from "./runtime.js";

const silent = { info() {}, warn() {}, error() {} };

describe("pipelineEnvFrom", () => {
  it("uses safe defaults and treats empty values as unset", () => {
    const parsed = pipelineEnvFrom({ OPENWA_BASE_URL: "", APP_ENCRYPTION_KEY: "" });
    expect(parsed).toEqual({ config: defaultPipelineConfig(), openwa: null, ntfyHost: null, vapidSubject: undefined, encryptionKey: null });
  });

  it("reads OpenWA read access, ntfy, VAPID subject, the encryption key, and pipeline timings", () => {
    const key = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1));
    const parsed = pipelineEnvFrom({
      OPENWA_BASE_URL: "https://openwa.example.com/",
      OPENWA_READ_API_KEY: "read-key",
      NTFY_HOST: "Ntfy.Internal",
      VAPID_SUBJECT: "mailto:owner@example.com",
      APP_ENCRYPTION_KEY: key.toString("base64"),
      ANALYSIS_DEBOUNCE_MS: "5000",
    });
    expect(parsed.openwa).toEqual({ baseUrl: "https://openwa.example.com", apiKey: "read-key" });
    expect(parsed.ntfyHost).toBe("ntfy.internal");
    expect(parsed.vapidSubject).toBe("mailto:owner@example.com");
    expect(parsed.encryptionKey?.equals(key)).toBe(true);
    expect(parsed.config.analysisDebounceMs).toBe(5000);
    // Media needs both the URL and the read key.
    expect(pipelineEnvFrom({ OPENWA_BASE_URL: "https://openwa.example.com" }).openwa).toBeNull();
  });

  it("rejects invalid values, naming the variables but never echoing values", () => {
    let error: unknown;
    try {
      pipelineEnvFrom({ VAPID_SUBJECT: "owner-at-example", APP_ENCRYPTION_KEY: "not-a-real-key-value", ANALYSIS_DEBOUNCE_MS: "soon", OPENWA_BASE_URL: "ftp://x" });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WorkerConfigError);
    const message = (error as Error).message;
    for (const name of ["VAPID_SUBJECT", "APP_ENCRYPTION_KEY", "ANALYSIS_DEBOUNCE_MS", "OPENWA_BASE_URL"]) expect(message).toContain(name);
    for (const value of ["owner-at-example", "not-a-real-key-value", "soon", "ftp://x"]) expect(message).not.toContain(value);
  });
});

describe("startPipelineWorker", () => {
  let testDb: TestDatabase;
  let queue: JobQueue;

  beforeAll(async () => {
    testDb = await createTestDatabase();
    queue = new JobQueue({ connectionString: testDb.url, logger: silent });
    await queue.start();
  });
  afterAll(async () => {
    await queue.stop({ graceful: false, timeoutMs: 1000 });
    await testDb.drop();
  });

  it("generates VAPID keys on first boot, stores them, and reuses them after a restart", async () => {
    expect(await getAppState(testDb.database.db, "push.vapid")).toBeNull();
    const options = {
      database: testDb.database,
      queue,
      filter: createRulesIntakeFilter({ ownerJids: [], aliases: [] }),
      logger: silent,
      pipeline: pipelineEnvFrom({}),
      overrides: { providers: { load: async () => ({ providers: createMockProviders(), error: null, roles: {} as never, limits: {} as never }) } },
    };
    const first = await startPipelineWorker(options);
    const stored = await getAppState<{ publicKey: string; privateKey: string }>(testDb.database.db, "push.vapid");
    expect(stored?.publicKey).toBe(first.vapidPublicKey);
    expect(stored?.privateKey).toMatch(/^[\w-]{40,}$/);
    // The pipeline is wired: analysis, media, profile, and reminder handlers use the built deps.
    expect(first.pipeline.deps.tasks).toBeDefined();
    expect(first.pipeline.deps.media).toBeNull();
    await first.stop();

    const second = await startPipelineWorker(options);
    expect(second.vapidPublicKey).toBe(first.vapidPublicKey);
    await second.stop();
  });

  it("reads provider settings from the database, falls back to the env, and picks up changes without a restart", async () => {
    const encryptionKey = randomBytes(32).toString("base64");
    const built: ProvidersConfig[] = [];
    const worker = await startPipelineWorker({
      database: testDb.database,
      queue,
      filter: createRulesIntakeFilter({ ownerJids: [], aliases: [] }),
      logger: silent,
      pipeline: pipelineEnvFrom({ APP_ENCRYPTION_KEY: encryptionKey }),
      env: { AI_TEXT_PROVIDER: "openai", AI_TEXT_MODEL: "gpt-env", AI_TEXT_API_KEY: "sk-env-key-0123456789" },
      overrides: {
        providerFactory: (config) => {
          built.push(config);
          return createMockProviders();
        },
      },
    });
    const { providers } = worker.pipeline.deps;
    try {
      expect((await providers.load()).roles.text).toMatchObject({ source: "env", model: "gpt-env" });
      expect(built.at(-1)?.text).toMatchObject({ model: "gpt-env", apiKey: "sk-env-key-0123456789" });

      // The owner saves new settings on the setup page (another process): the next job sees them.
      await saveProviderSettings(testDb.database.db, parseEncryptionKey(encryptionKey), {
        text: { provider: "anthropic", model: "claude-saved", apiKey: "sk-ant-saved-0123456789" },
      });
      const state = await providers.load();
      expect(state.error).toBeNull();
      expect(state.roles.text).toMatchObject({ source: "db", model: "claude-saved", hasApiKey: true });
      expect(built.at(-1)?.text).toMatchObject({ provider: "anthropic", model: "claude-saved", apiKey: "sk-ant-saved-0123456789" });

      await saveProviderSettings(testDb.database.db, null, { text: null });
      expect((await providers.load()).roles.text).toMatchObject({ source: "env", model: "gpt-env" });
    } finally {
      await worker.stop();
    }
  });
});
