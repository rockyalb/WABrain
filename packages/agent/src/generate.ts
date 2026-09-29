import { generateText, Output, type LanguageModel, type ModelMessage } from "ai";
import type { z } from "zod";
import type { RoleModel } from "./providers.js";

/** Audit data recorded for every model call (docs/ARCHITECTURE.md, "Data model"). */
export interface ModelRun {
  provider: string;
  modelId: string;
  promptVersion: string;
  inputTokens: number | null;
  outputTokens: number | null;
  latencyMs: number;
}

export interface CallOptions {
  abortSignal?: AbortSignal;
  /** Retries per model call. Defaults to the AI SDK's 2. */
  maxRetries?: number;
  maxOutputTokens?: number;
}

export interface StructuredCall<S extends z.ZodType> {
  role: RoleModel<LanguageModel>;
  schema: S;
  name: string;
  description?: string;
  instructions: string;
  /** A plain text prompt, or messages for multimodal input. */
  prompt: string | ModelMessage[];
  promptVersion: string;
  options?: CallOptions;
}

/** One structured-output model call through the AI SDK, with timing and token usage for audit. */
export async function generateStructured<S extends z.ZodType>(call: StructuredCall<S>): Promise<{ output: z.infer<S>; run: ModelRun }> {
  const started = performance.now();
  const result = await generateText({
    model: call.role.model,
    instructions: call.instructions,
    prompt: call.prompt,
    output: Output.object({ schema: call.schema, name: call.name, description: call.description }),
    abortSignal: call.options?.abortSignal,
    maxRetries: call.options?.maxRetries,
    maxOutputTokens: call.options?.maxOutputTokens,
  });
  return {
    output: result.output as z.infer<S>,
    run: {
      provider: call.role.provider,
      modelId: result.response?.modelId || call.role.modelId,
      promptVersion: call.promptVersion,
      inputTokens: result.totalUsage?.inputTokens ?? null,
      outputTokens: result.totalUsage?.outputTokens ?? null,
      latencyMs: Math.round(performance.now() - started),
    },
  };
}
