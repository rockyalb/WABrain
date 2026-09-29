import { describe, expect, it, vi } from "vitest";
import { ApiError, createApi, describeError, normalizeImport, normalizeProviders, normalizeProviderTest } from "./api";

/** A fetch stub that records requests and answers from a list of responses. */
function fakeFetch(...responses: Array<{ status?: number; body?: unknown; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body: unknown }> = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    const next = responses.shift() ?? { status: 200, body: {} };
    const status = next.status ?? 200;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status, headers: next.headers });
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, calls };
}

/** The body GET/PUT /setup/providers return (apps/api ProvidersResponseSchema). */
const PROVIDERS_BODY = {
  providers: {
    text: {
      source: "db",
      provider: "openai",
      model: "gpt-5",
      baseUrl: null,
      hasApiKey: true,
      apiKeySource: "db",
      dimensions: null,
      structuredOutputs: null,
      dailyTokenLimit: 200000,
      dailyCallLimit: 500,
    },
    vision: null,
    transcription: {
      source: "env",
      provider: "openai",
      model: "whisper-1",
      baseUrl: null,
      hasApiKey: true,
      apiKeySource: "env",
      dimensions: null,
      structuredOutputs: null,
      dailyTokenLimit: null,
      dailyCallLimit: null,
    },
    embedding: {
      source: "db",
      provider: "openai-compatible",
      model: "bge-m3",
      baseUrl: "http://ollama:11434/v1",
      hasApiKey: false,
      apiKeySource: null,
      dimensions: 1024,
      structuredOutputs: false,
      dailyTokenLimit: null,
      dailyCallLimit: null,
    },
  },
  encryptionConfigured: false,
  error: "embedding: something",
};

describe("normalizers", () => {
  it("reads the providers response, including key source and limits", () => {
    const state = normalizeProviders(PROVIDERS_BODY);
    expect(state.encryptionConfigured).toBe(false);
    expect(state.error).toBe("embedding: something");
    expect(state.roles.vision).toBeNull();
    expect(state.roles.text).toMatchObject({ source: "db", hasApiKey: true, apiKeySource: "db", dailyTokenLimit: 200000, dailyCallLimit: 500 });
    expect(state.roles.transcription).toMatchObject({ source: "env", apiKeySource: "env" });
    expect(state.roles.embedding).toMatchObject({ dimensions: 1024, structuredOutputs: false, hasApiKey: false, apiKeySource: null });
  });

  it("never exposes a key value even if a server sent one", () => {
    const state = normalizeProviders({ providers: { text: { provider: "openai", model: "m", apiKey: "sk-secret", hasApiKey: true } } });
    expect(JSON.stringify(state)).not.toContain("sk-secret");
  });

  it("reads provider test results keyed by role", () => {
    const rows = normalizeProviderTest({
      results: {
        text: { ok: true, provider: "openai", model: "gpt-5", latencyMs: 420 },
        embedding: { ok: false, provider: "openai", model: "x", latencyMs: 12, error: "Unauthorized" },
      },
    });
    expect(rows).toEqual([
      { role: "text", ok: true, provider: "openai", model: "gpt-5", message: "Works", latencyMs: 420 },
      { role: "embedding", ok: false, provider: "openai", model: "x", message: "Unauthorized", latencyMs: 12 },
    ]);
  });

  it("marks coverage without a run as OpenWA's stored history, and with a run as local", () => {
    const row = { chatId: "a@c.us", chatName: "Ana", earliestAt: "2026-07-01T00:00:00.000Z", messageCount: 3, mediaOk: 0, mediaFailed: 0, gaps: [] };
    expect(normalizeImport({ items: [row], run: null })).toMatchObject({ source: "openwa", run: null, items: [row] });
    const local = normalizeImport({
      items: [row],
      run: { status: "running", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: null, progress: 0.25, error: null },
    });
    expect(local.source).toBe("local");
    expect(local.run).toEqual({ status: "running", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: null, progress: 0.25, error: null });
  });
});

describe("createApi", () => {
  it("sends the provider body as is, with an idempotency key", async () => {
    const { fetch, calls } = fakeFetch({ body: PROVIDERS_BODY });
    const api = createApi({ fetch });
    const body = {
      text: { provider: "openai", model: "gpt-5", baseUrl: null, dimensions: null, structuredOutputs: null, dailyTokenLimit: 200000, dailyCallLimit: 500 },
    };
    const state = await api.saveProviders(body);
    expect(calls[0]).toMatchObject({ url: "/setup/providers", method: "PUT", body });
    expect(calls[0]!.headers["idempotency-key"]).toBeTruthy();
    expect(state.roles.text?.model).toBe("gpt-5");
  });

  it("tests only the requested roles", async () => {
    const { fetch, calls } = fakeFetch({ body: { results: {} } }, { body: { results: {} } });
    const api = createApi({ fetch });
    await api.testProviders(["text"]);
    await api.testProviders();
    expect(calls.map((call) => call.body)).toEqual([{ roles: ["text"] }, {}]);
  });

  it("calls the OpenWA pairing route and returns the dashboard link", async () => {
    const pairing = { mode: "dashboard", dashboardUrl: "http://127.0.0.1:2785/sessions", sessionId: "s", sessionStatus: "qr_ready", paired: false, message: "Open" };
    const { fetch, calls } = fakeFetch({ body: pairing });
    expect(await createApi({ fetch }).openWaPairing()).toEqual(pairing);
    expect(calls[0]).toMatchObject({ url: "/setup/openwa/qr", method: "GET" });
  });

  it("starts a 90-day import and reads the partial run", async () => {
    const { fetch, calls } = fakeFetch(
      { status: 202, body: { run: { status: "queued", startedAt: "2026-09-24T10:00:00.000Z" } } },
      { body: { run: { status: "cancelled", finishedAt: "2026-09-24T10:05:00.000Z" } } },
      { body: { run: null } },
    );
    const api = createApi({ fetch });
    expect(await api.startImport()).toMatchObject({ status: "queued", startedAt: "2026-09-24T10:00:00.000Z", finishedAt: null });
    expect(calls[0]).toMatchObject({ url: "/setup/import", method: "POST", body: { days: 90 } });
    expect(await api.cancelImport()).toMatchObject({ status: "cancelled", finishedAt: "2026-09-24T10:05:00.000Z" });
    expect(calls[1]).toMatchObject({ url: "/setup/import", method: "DELETE" });
    expect(await api.cancelImport()).toBeNull();
  });

  it("turns error responses into friendly messages", async () => {
    const { fetch } = fakeFetch(
      { status: 409, body: { error: { code: "conflict", message: "Set OPENWA_SESSION_ID before checking history coverage" } } },
      { status: 429, body: { error: { code: "rate_limited", message: "Too many requests" } }, headers: { "retry-after": "42" } },
      { status: 501, body: { error: { code: "not_implemented", message: "Not implemented" } } },
      { status: 401, body: { error: { code: "unauthorized", message: "Unauthorized" } } },
    );
    const onUnauthorized = vi.fn();
    const api = createApi({ fetch, onUnauthorized });
    const errors: unknown[] = [];
    for (const call of [api.importCoverage, api.openWaTest, api.providers, api.openWaStatus]) {
      errors.push(await call().catch((error: unknown) => error));
    }
    expect(errors.every((error) => error instanceof ApiError)).toBe(true);
    expect(errors.map(describeError)).toEqual([
      "Set OPENWA_SESSION_ID before checking history coverage",
      "Too many attempts. Try again in 42 s.",
      "This server version does not support this yet. Update the server to use it.",
      "Your session ended. Sign in again.",
    ]);
    expect(onUnauthorized).toHaveBeenCalledTimes(1);
  });
});
