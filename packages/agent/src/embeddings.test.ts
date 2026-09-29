import { describe, expect, it } from "vitest";
import { embedTexts } from "./embeddings.js";
import { ProviderNotConfiguredError } from "./providers.js";
import { createMockProviders, mockEmbeddingModel } from "./testing/index.js";

describe("embedTexts", () => {
  it("embeds in batches, keeps order, and records the model", async () => {
    const model = mockEmbeddingModel(1536);
    const providers = createMockProviders({ embedding: model });
    const result = await embedTexts(providers, ["a", "bb", "ccc", "dddd", "eeeee"], { batchSize: 2 });
    expect(model.doEmbedCalls.map((call) => call.values)).toEqual([["a", "bb"], ["ccc", "dddd"], ["eeeee"]]);
    expect(result).toMatchObject({ model: "mock-embedding", provider: "mock", dimensions: 1536, tokens: 15 });
    expect(result.vectors).toHaveLength(5);
  });

  it("requests the configured dimensions through provider options", async () => {
    const model = mockEmbeddingModel(1536);
    await embedTexts(createMockProviders({ embedding: model }), ["x"]);
    expect(model.doEmbedCalls[0]?.providerOptions).toMatchObject({ openai: { dimensions: 1536 }, openaiCompatible: { dimensions: 1536 } });
  });

  it("uses the native size when no dimensions are configured", async () => {
    const model = mockEmbeddingModel(1024);
    const result = await embedTexts(createMockProviders({ embedding: model, embeddingDimensions: null }), ["x"]);
    expect(result.dimensions).toBe(1024);
    expect(model.doEmbedCalls[0]?.providerOptions).toBeUndefined();
  });

  it("rejects vectors of the wrong size", async () => {
    await expect(embedTexts(createMockProviders({ embedding: mockEmbeddingModel(3072), embeddingDimensions: 1536 }), ["x"])).rejects.toThrow(
      /3072 dimensions, expected 1536/,
    );
  });

  it("handles empty input and missing configuration", async () => {
    const model = mockEmbeddingModel(1536);
    expect(await embedTexts(createMockProviders({ embedding: model }), [])).toMatchObject({ vectors: [], dimensions: 1536, tokens: 0 });
    expect(model.doEmbedCalls).toHaveLength(0);
    await expect(embedTexts(createMockProviders({ embedding: null }), ["x"])).rejects.toBeInstanceOf(ProviderNotConfiguredError);
  });
});
