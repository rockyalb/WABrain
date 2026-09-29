import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProvidersConfigSchema, createProviders, describeRole, providersConfigFromEnv } from "./providers.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createProviders", () => {
  it("builds every role without network calls", () => {
    const providers = createProviders({
      text: { provider: "anthropic", model: "text-model", apiKey: "k" },
      vision: { provider: "openai", model: "vision-model", apiKey: "k" },
      transcription: { provider: "openai", model: "stt-model", apiKey: "k" },
      embedding: { provider: "openai", apiKey: "k" },
    });
    expect(describeRole(providers.text)).toBe("anthropic/text-model");
    expect(describeRole(providers.vision)).toBe("openai/vision-model");
    expect(providers.transcription?.modelId).toBe("stt-model");
    expect(providers.embedding).toMatchObject({ modelId: "text-embedding-3-large", dimensions: 1536, provider: "openai" });
  });

  it("uses the text model for vision when vision is not configured", () => {
    const providers = createProviders({ text: { provider: "openai", model: "multimodal", apiKey: "k" } });
    expect(providers.vision.modelId).toBe("multimodal");
    expect(providers.transcription).toBeNull();
    expect(providers.embedding).toBeNull();
  });

  it("supports openai-compatible endpoints (Ollama, OpenRouter, LM Studio)", () => {
    const providers = createProviders({
      text: { provider: "openai-compatible", model: "qwen3", baseUrl: "http://localhost:11434/v1" },
      transcription: { provider: "openai-compatible", model: "whisper-large-v3", baseUrl: "http://localhost:8000/v1" },
      embedding: { provider: "openai-compatible", model: "bge-m3", baseUrl: "http://localhost:11434/v1" },
    });
    expect(providers.text.provider).toBe("openai-compatible");
    expect(providers.transcription?.modelId).toBe("whisper-large-v3");
    expect(providers.embedding).toMatchObject({ modelId: "bge-m3", dimensions: null });
  });

  it("sends the configured reasoning effort with every OpenAI call", async () => {
    const bodies: Record<string, unknown>[] = [];
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return new Response(
        JSON.stringify({
          id: "resp_1",
          created_at: 0,
          model: "gpt-6-luna",
          output: [{ type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok", annotations: [] }] }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }),
        { headers: { "content-type": "application/json" } },
      );
    });
    const providers = createProviders({ text: { provider: "openai", model: "gpt-6-luna", apiKey: "k", reasoningEffort: "medium" } });
    await generateText({ model: providers.text.model, prompt: "hi" });
    expect(bodies[0]).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "medium" } });
    expect(providers.text.modelId).toBe("gpt-6-luna");
  });

  it("rejects invalid configurations", () => {
    expect(() => createProviders({ text: { provider: "openai-compatible", model: "x" } })).toThrow(/baseUrl/);
    expect(() => createProviders({ text: { provider: "openai", model: "" } })).toThrow();
    const anthropicStt = ProvidersConfigSchema.safeParse({
      text: { provider: "openai", model: "x" },
      transcription: { provider: "anthropic", model: "y" },
      embedding: { provider: "anthropic" },
    });
    expect(anthropicStt.success).toBe(false);
    expect(anthropicStt.error?.issues.map((issue) => issue.path.join("."))).toEqual(["transcription.provider", "embedding.provider"]);
    expect(ProvidersConfigSchema.safeParse({ text: { provider: "openai", model: "x" }, embedding: { provider: "openai", dimensions: 3072 } }).success).toBe(false);
  });
});

describe("providersConfigFromEnv", () => {
  it("reads every role", () => {
    const result = providersConfigFromEnv({
      AI_TEXT_PROVIDER: "openai",
      AI_TEXT_MODEL: "m",
      AI_TEXT_API_KEY: "k",
      AI_TEXT_REASONING_EFFORT: "medium",
      AI_TRANSCRIPTION_PROVIDER: "openai-compatible",
      AI_TRANSCRIPTION_MODEL: "whisper",
      AI_TRANSCRIPTION_BASE_URL: "http://stt:8000/v1",
      AI_EMBEDDING_PROVIDER: "openai",
      AI_EMBEDDING_DIMENSIONS: "1024",
    });
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      text: { provider: "openai", model: "m", apiKey: "k", reasoningEffort: "medium" },
      transcription: { provider: "openai-compatible", model: "whisper", baseUrl: "http://stt:8000/v1" },
      embedding: { provider: "openai", model: "text-embedding-3-large", dimensions: 1024 },
    });
    expect(result.data?.vision).toBeUndefined();
  });

  it("fails gracefully when nothing is configured", () => {
    const result = providersConfigFromEnv({});
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["text"]);
  });
});
