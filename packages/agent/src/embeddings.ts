import { embedMany } from "ai";
import { ProviderNotConfiguredError, type Providers } from "./providers.js";

export interface EmbedTextsResult {
  /** Embedding model id; store it with every vector so a model change triggers a re-embed. */
  model: string;
  provider: string;
  /** Vector length actually returned. */
  dimensions: number;
  /** One vector per input text, in input order. */
  vectors: number[][];
  tokens: number | null;
}

export interface EmbedOptions {
  /** Texts per request. Default 64. */
  batchSize?: number;
  abortSignal?: AbortSignal;
  maxRetries?: number;
}

/**
 * Embeds texts in batches with the embedding role. Requests the configured dimensions through provider
 * options (OpenAI text-embedding-3-large → 1536 by default) and checks every vector has the same length.
 */
export async function embedTexts(providers: Providers, texts: readonly string[], options: EmbedOptions = {}): Promise<EmbedTextsResult> {
  const role = providers.embedding;
  if (!role) throw new ProviderNotConfiguredError("embedding");
  const batchSize = Math.max(1, options.batchSize ?? 64);
  const dims = role.dimensions;
  const providerOptions = dims ? { openai: { dimensions: dims }, openaiCompatible: { dimensions: dims } } : undefined;

  const vectors: number[][] = [];
  let tokens: number | null = 0;
  for (let start = 0; start < texts.length; start += batchSize) {
    const values = texts.slice(start, start + batchSize).map((text) => text.replace(/\s+/g, " ").trim() || " ");
    const result = await embedMany({
      model: role.model,
      values,
      providerOptions,
      abortSignal: options.abortSignal,
      maxRetries: options.maxRetries,
    });
    if (result.embeddings.length !== values.length) {
      throw new Error(`Embedding model returned ${result.embeddings.length} vectors for ${values.length} texts`);
    }
    vectors.push(...result.embeddings.map((embedding) => [...embedding]));
    tokens = tokens !== null && typeof result.usage?.tokens === "number" ? tokens + result.usage.tokens : null;
  }

  const dimensions = vectors[0]?.length ?? dims ?? 0;
  if (vectors.some((vector) => vector.length !== dimensions)) throw new Error("Embedding vectors have inconsistent dimensions");
  if (dims && vectors.length > 0 && dimensions !== dims) {
    throw new Error(`Embedding model returned ${dimensions} dimensions, expected ${dims}`);
  }
  return { model: role.modelId, provider: role.provider, dimensions, vectors, tokens: texts.length === 0 ? 0 : tokens };
}
