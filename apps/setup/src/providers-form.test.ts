import { describe, expect, it } from "vitest";
import type { ProviderRoleView, ProvidersView } from "./api";
import { canClearKey, embeddingWarning, endpointKeyWarning, keyState, limitHint, patchForm, toForm, toForms, toInput, validate } from "./providers-form";

const view = (overrides: Partial<ProviderRoleView> = {}): ProviderRoleView => {
  const result = {
    source: "db" as const,
    provider: "openai",
    model: "gpt-5",
    baseUrl: null,
    hasApiKey: true,
    apiKeySource: "db" as const,
    dimensions: null,
    structuredOutputs: null,
    dailyTokenLimit: null,
    dailyCallLimit: null,
    ...overrides,
  };
  // By default the effective limits are the saved ones; pass stored* explicitly for inherited limits.
  return {
    ...result,
    storedDailyTokenLimit: "storedDailyTokenLimit" in overrides ? (overrides.storedDailyTokenLimit ?? null) : result.dailyTokenLimit,
    storedDailyCallLimit: "storedDailyCallLimit" in overrides ? (overrides.storedDailyCallLimit ?? null) : result.dailyCallLimit,
  };
};

const loaded = (roles: Partial<ProvidersView>): ProvidersView => ({ text: null, vision: null, transcription: null, embedding: null, ...roles });

describe("toInput", () => {
  it("leaves roles the owner did not touch out of the body", () => {
    const forms = toForms(loaded({ text: view(), transcription: view({ source: "env", apiKeySource: "env", model: "whisper-1" }) }));
    expect(toInput(forms)).toEqual({});
  });

  it("sends back the loaded limits and structured-outputs flag when another field changes", () => {
    const forms = toForms(
      loaded({ text: view({ provider: "openai-compatible", baseUrl: "http://ollama:11434/v1", structuredOutputs: false, dailyTokenLimit: 200000, dailyCallLimit: 500 }) }),
    );
    forms.text = patchForm(forms.text, { model: "qwen3:32b" });
    expect(toInput(forms)).toEqual({
      text: {
        provider: "openai-compatible",
        model: "qwen3:32b",
        baseUrl: "http://ollama:11434/v1",
        dimensions: null,
        structuredOutputs: false,
        dailyTokenLimit: 200000,
        dailyCallLimit: 500,
      },
    });
  });

  it("preserves inherited environment limits as null when another field changes", () => {
    const forms = toForms(loaded({ text: view({ dailyTokenLimit: 200000, dailyCallLimit: 500, storedDailyTokenLimit: null, storedDailyCallLimit: null }) }));
    forms.text = patchForm(forms.text, { model: "gpt-5-mini" });
    expect(forms.text.dailyTokenLimit).toBe("");
    expect(forms.text.dailyCallLimit).toBe("");
    expect(toInput(forms).text).toMatchObject({ dailyTokenLimit: null, dailyCallLimit: null });
  });

  it("keeps a saved override while inheriting the other limit", () => {
    const forms = toForms(loaded({ text: view({ dailyTokenLimit: 1000, dailyCallLimit: 12, storedDailyTokenLimit: null, storedDailyCallLimit: 12 }) }));
    forms.text = patchForm(forms.text, { model: "gpt-5-mini" });
    expect(toInput(forms).text).toMatchObject({ dailyTokenLimit: null, dailyCallLimit: 12 });
  });

  it("keeps, replaces, or clears the key", () => {
    const forms = toForms(loaded({ text: view() }));
    forms.text = patchForm(forms.text, { model: "gpt-5-mini" });
    expect(toInput(forms).text).not.toHaveProperty("apiKey");
    forms.text = patchForm(forms.text, { apiKey: "  sk-new  " });
    expect(toInput(forms).text?.apiKey).toBe("sk-new");
    forms.text = patchForm(forms.text, { apiKey: "", clearKey: true });
    expect(toInput(forms).text?.apiKey).toBeNull();
  });

  it("sends null for a role the owner emptied, and dimensions only for embeddings", () => {
    const forms = toForms(loaded({ vision: view(), embedding: view({ provider: "openai", model: "text-embedding-3-large", dimensions: 1536 }) }));
    forms.vision = patchForm(forms.vision, { provider: "", model: "" });
    forms.embedding = patchForm(forms.embedding, { dailyCallLimit: "1000" });
    const input = toInput(forms);
    expect(input.vision).toBeNull();
    expect(input.embedding).toMatchObject({ dimensions: 1536, dailyCallLimit: 1000, dailyTokenLimit: null });
  });
});

describe("validate", () => {
  it("accepts an untouched page and a valid edit", () => {
    const forms = toForms(loaded({ text: view() }));
    expect(validate(forms)).toBeNull();
    forms.text = patchForm(forms.text, { model: "gpt-5-mini" });
    expect(validate(forms)).toBeNull();
  });

  it("names the first problem", () => {
    const forms = toForms(loaded({}));
    forms.text = patchForm(forms.text, { provider: "openai-compatible", model: "llama" });
    expect(validate(forms)).toMatch(/base URL/);
    forms.text = patchForm(forms.text, { baseUrl: "ftp://x" });
    expect(validate(forms)).toMatch(/http:\/\/ or https:\/\//);
    forms.text = patchForm(forms.text, { baseUrl: "http://ollama:11434/v1", dailyTokenLimit: "1.5" });
    expect(validate(forms)).toMatch(/daily token limit/);
    forms.text = patchForm(forms.text, { dailyTokenLimit: "" });
    forms.embedding = patchForm(forms.embedding, { provider: "openai", model: "text-embedding-3-large", dimensions: "3072" });
    expect(validate(forms)).toMatch(/dimensions/);
    forms.text = patchForm(forms.text, { provider: "", model: "" });
    expect(validate(forms)).toBe("Text analysis needs a provider and a model.");
  });
});

describe("keys", () => {
  it("reports where the key comes from", () => {
    expect(keyState("text", toForm(view()))).toEqual({ kind: "stored" });
    expect(keyState("text", toForm(view({ apiKeySource: "env" })))).toEqual({ kind: "env", variable: "AI_TEXT_API_KEY" });
    expect(keyState("text", toForm(view({ hasApiKey: false, apiKeySource: null })))).toEqual({ kind: "none" });
    expect(keyState("text", patchForm(toForm(view()), { apiKey: "sk" }))).toEqual({ kind: "replace" });
    expect(keyState("text", patchForm(toForm(view()), { clearKey: true }))).toEqual({ kind: "clear" });
  });

  it("warns that changing the endpoint without a new key clears the stored key", () => {
    const form = toForm(view());
    expect(endpointKeyWarning("text", form)).toBeNull();
    const moved = patchForm(form, { baseUrl: "https://gateway.example/v1" });
    expect(endpointKeyWarning("text", moved)).toMatch(/removes the stored key/);
    expect(keyState("text", moved)).toEqual({ kind: "none" });
    expect(canClearKey(moved)).toBe(false);
    expect(endpointKeyWarning("text", patchForm(moved, { apiKey: "sk-new" }))).toBeNull();
    const envKey = patchForm(toForm(view({ apiKeySource: "env" })), { provider: "anthropic" });
    expect(endpointKeyWarning("text", envKey)).toMatch(/AI_TEXT_API_KEY/);
  });

  it("offers removing only a key saved on the page", () => {
    expect(canClearKey(toForm(view()))).toBe(true);
    expect(canClearKey(toForm(view({ apiKeySource: "env" })))).toBe(false);
    expect(canClearKey(toForm(null))).toBe(false);
  });
});

describe("embeddingWarning", () => {
  it("warns about more than 1536 dimensions", () => {
    expect(embeddingWarning(toForm(view({ model: "text-embedding-3-large", dimensions: 1536 })))).toBeNull();
    expect(embeddingWarning(patchForm(toForm(view()), { dimensions: "3072" }))).toMatch(/at most 1536/);
  });

  it("warns about openai-compatible models without dimensions", () => {
    const compatible = toForm(view({ provider: "openai-compatible", baseUrl: "https://openrouter.ai/api/v1", model: "openai/text-embedding-3-large" }));
    expect(embeddingWarning(compatible)).toMatch(/3072/);
    expect(embeddingWarning(patchForm(compatible, { model: "bge-m3" }))).toMatch(/bge-m3: 1024/);
    expect(embeddingWarning(patchForm(compatible, { dimensions: "1024" }))).toBeNull();
    expect(embeddingWarning(toForm(view({ model: "text-embedding-3-large" })))).toBeNull();
  });
});

describe("limitHint", () => {
  it("names the inherited environment value, or says an override replaces it", () => {
    const form = toForm(view({ dailyTokenLimit: 1000, storedDailyTokenLimit: null }));
    expect(limitHint("text", form, "dailyTokenLimit")).toBe("Empty: uses AI_TEXT_DAILY_TOKEN_LIMIT (1000) and follows later changes to it.");
    expect(limitHint("text", patchForm(form, { dailyTokenLimit: "50" }), "dailyTokenLimit")).toContain("Overrides AI_TEXT_DAILY_TOKEN_LIMIT (1000)");
  });

  it("falls back to the generic explanation without an inherited value", () => {
    expect(limitHint("vision", toForm(null), "dailyCallLimit")).toBe("Empty: uses AI_VISION_DAILY_CALL_LIMIT when it is set, otherwise no limit.");
    expect(limitHint("text", toForm(view({ dailyCallLimit: 7 })), "dailyCallLimit")).toContain("otherwise no limit");
  });
});
