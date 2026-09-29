import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { defaultSettingsMiddleware, wrapLanguageModel, type EmbeddingModel, type LanguageModel, type TranscriptionModel } from "ai";
import { z } from "zod";

/**
 * Provider registry. Each role (text, vision, transcription, embedding) has its own provider and model,
 * chosen by the owner at setup. No model name is hardcoded except the embedding default required by
 * docs/SPEC.md (text-embedding-3-large reduced to 1536 dimensions).
 */

export const ProviderKindSchema = z.enum(["openai", "anthropic", "openai-compatible"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;

export const RoleConfigSchema = z.object({
  provider: ProviderKindSchema,
  model: z.string().trim().min(1),
  apiKey: z.string().min(1).optional(),
  /** Required for openai-compatible (Ollama, OpenRouter, LM Studio...). Optional proxy URL otherwise. */
  baseUrl: z.url().optional(),
  /** openai-compatible only: whether the endpoint supports JSON-schema structured outputs. Default true. */
  structuredOutputs: z.boolean().optional(),
  /** openai only: reasoning effort sent with every call of this role. Default: the model's own. */
  reasoningEffort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
});
export type RoleConfig = z.infer<typeof RoleConfigSchema>;

export const DEFAULT_EMBEDDING_MODEL = "text-embedding-3-large";
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

export const EmbeddingRoleConfigSchema = RoleConfigSchema.extend({
  model: z.string().trim().min(1).default(DEFAULT_EMBEDDING_MODEL),
  /**
   * Requested vector size. Defaults to 1536 for OpenAI (fits pgvector's HNSW limit of 2000). For
   * openai-compatible endpoints it is only sent when set, because many local models have a fixed size.
   */
  dimensions: z.number().int().positive().max(2000).optional(),
});
export type EmbeddingRoleConfig = z.input<typeof EmbeddingRoleConfigSchema>;

export const ProvidersConfigSchema = z
  .object({
    text: RoleConfigSchema,
    /** Defaults to the text configuration: the owner's default is one multimodal model for both. */
    vision: RoleConfigSchema.optional(),
    transcription: RoleConfigSchema.optional(),
    embedding: EmbeddingRoleConfigSchema.optional(),
  })
  .superRefine((config, ctx) => {
    for (const role of ["text", "vision", "transcription", "embedding"] as const) {
      const roleConfig = config[role];
      if (roleConfig?.provider === "openai-compatible" && !roleConfig.baseUrl) {
        ctx.addIssue({ code: "custom", path: [role, "baseUrl"], message: "openai-compatible providers need a baseUrl" });
      }
    }
    for (const role of ["transcription", "embedding"] as const) {
      if (config[role]?.provider === "anthropic") {
        ctx.addIssue({ code: "custom", path: [role, "provider"], message: `Anthropic has no ${role} models; use openai or openai-compatible` });
      }
    }
  });
export type ProvidersConfig = z.input<typeof ProvidersConfigSchema>;

export interface RoleModel<M> {
  model: M;
  provider: ProviderKind | "mock";
  modelId: string;
}

export interface EmbeddingRoleModel extends RoleModel<EmbeddingModel> {
  /** Requested dimensions, or null when the model's native size is used. */
  dimensions: number | null;
  /** Configured API endpoint, when one is set (used to keep vectors from separate endpoints apart). */
  baseUrl?: string | null;
}

/**
 * Every model call in this package goes through this object, so tests can inject mock models.
 * Transcription and embedding are null when not configured.
 */
export interface Providers {
  text: RoleModel<LanguageModel>;
  vision: RoleModel<LanguageModel>;
  transcription: RoleModel<TranscriptionModel> | null;
  embedding: EmbeddingRoleModel | null;
}

export class ProviderNotConfiguredError extends Error {
  constructor(readonly role: "transcription" | "embedding") {
    super(`No ${role} provider is configured`);
    this.name = "ProviderNotConfiguredError";
  }
}

function languageModel(config: RoleConfig): LanguageModel {
  switch (config.provider) {
    case "openai": {
      const model = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl })(config.model);
      if (!config.reasoningEffort) return model;
      const settings = { providerOptions: { openai: { reasoningEffort: config.reasoningEffort } } };
      return wrapLanguageModel({ model, middleware: defaultSettingsMiddleware({ settings }) });
    }
    case "anthropic":
      return createAnthropic({ apiKey: config.apiKey, baseURL: config.baseUrl })(config.model);
    case "openai-compatible":
      return createOpenAICompatible({
        name: "openaiCompatible",
        baseURL: config.baseUrl!,
        apiKey: config.apiKey,
        supportsStructuredOutputs: config.structuredOutputs ?? true,
      }).chatModel(config.model);
  }
}

function transcriptionModel(config: RoleConfig): TranscriptionModel {
  // OpenAI-compatible speech servers (faster-whisper-server, LocalAI, Groq...) implement OpenAI's
  // /audio/transcriptions endpoint, so the OpenAI provider with a custom base URL covers them.
  switch (config.provider) {
    case "openai":
    case "openai-compatible":
      return createOpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        name: config.provider === "openai" ? "openai" : "openaiCompatible",
      }).transcription(config.model);
    case "anthropic":
      throw new Error("Anthropic has no transcription models");
  }
}

function embeddingModel(config: RoleConfig): EmbeddingModel {
  switch (config.provider) {
    case "openai":
      return createOpenAI({ apiKey: config.apiKey, baseURL: config.baseUrl }).embeddingModel(config.model);
    case "openai-compatible":
      return createOpenAICompatible({ name: "openaiCompatible", baseURL: config.baseUrl!, apiKey: config.apiKey }).embeddingModel(
        config.model,
      );
    case "anthropic":
      throw new Error("Anthropic has no embedding models");
  }
}

const role = <M>(config: RoleConfig, model: M): RoleModel<M> => ({ model, provider: config.provider, modelId: config.model });

/** Validates the configuration and builds the AI SDK models. Performs no network calls. */
export function createProviders(input: ProvidersConfig): Providers {
  const config = ProvidersConfigSchema.parse(input);
  const vision = config.vision ?? config.text;
  const embedding = config.embedding;
  return {
    text: role(config.text, languageModel(config.text)),
    vision: role(vision, languageModel(vision)),
    transcription: config.transcription ? role(config.transcription, transcriptionModel(config.transcription)) : null,
    embedding: embedding
      ? {
          ...role(embedding, embeddingModel(embedding)),
          dimensions: embedding.dimensions ?? (embedding.provider === "openai" ? DEFAULT_EMBEDDING_DIMENSIONS : null),
          baseUrl: embedding.baseUrl ?? null,
        }
      : null,
  };
}

/** Human-readable "provider/model" identifier for audit records. */
export function describeRole(roleModel: RoleModel<unknown>): string {
  return `${roleModel.provider}/${roleModel.modelId}`;
}

type Env = Record<string, string | undefined>;

function roleFromEnv(env: Env, prefix: string): Record<string, unknown> | undefined {
  const provider = env[`${prefix}_PROVIDER`];
  const model = env[`${prefix}_MODEL`];
  if (!provider && !model) return undefined;
  const dimensions = env[`${prefix}_DIMENSIONS`];
  const structured = env[`${prefix}_STRUCTURED_OUTPUTS`];
  const reasoningEffort = env[`${prefix}_REASONING_EFFORT`];
  return {
    provider,
    model,
    apiKey: env[`${prefix}_API_KEY`] || undefined,
    baseUrl: env[`${prefix}_BASE_URL`] || undefined,
    ...(dimensions ? { dimensions: Number(dimensions) } : {}),
    ...(structured ? { structuredOutputs: structured === "true" } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
  };
}

const ENV_PREFIX = { text: "AI_TEXT", vision: "AI_VISION", transcription: "AI_TRANSCRIPTION", embedding: "AI_EMBEDDING" } as const;

/**
 * One role's raw (unvalidated) configuration from environment variables, or undefined when neither
 * its provider nor its model is set. Used to merge env fallbacks with owner-stored settings.
 */
export function roleConfigFromEnv(env: Env, role: keyof typeof ENV_PREFIX): Record<string, unknown> | undefined {
  return roleFromEnv(env, ENV_PREFIX[role]);
}

/**
 * Reads the configuration from environment variables:
 * AI_TEXT_PROVIDER, AI_TEXT_MODEL, AI_TEXT_API_KEY, AI_TEXT_BASE_URL, and the same for AI_VISION_*,
 * AI_TRANSCRIPTION_* and AI_EMBEDDING_* (plus AI_EMBEDDING_DIMENSIONS, and AI_TEXT_/AI_VISION_REASONING_EFFORT). Returns a Zod result so callers
 * can print a friendly error instead of throwing.
 */
export function providersConfigFromEnv(env: Env) {
  return ProvidersConfigSchema.safeParse({
    text: roleFromEnv(env, "AI_TEXT"),
    vision: roleFromEnv(env, "AI_VISION"),
    transcription: roleFromEnv(env, "AI_TRANSCRIPTION"),
    // The embedding model has a default, so AI_EMBEDDING_PROVIDER alone is enough.
    embedding: roleFromEnv(env, "AI_EMBEDDING"),
  });
}
