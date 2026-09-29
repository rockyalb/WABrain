/**
 * Mock providers for tests (here and in the worker). No network: every model is an AI SDK mock.
 * Import from "@wabrain/agent/testing".
 */
import { MockEmbeddingModelV4, MockLanguageModelV4, MockTranscriptionModelV4 } from "ai/test";
import type { Providers } from "../providers.js";

const usage = {
  inputTokens: { total: 100, noCache: 100, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 50, text: 50, reasoning: undefined },
};

/** A language model that answers every call with the next JSON value (the last one repeats). */
export function mockJsonModel(...responses: unknown[]): MockLanguageModelV4 {
  let call = 0;
  return new MockLanguageModelV4({
    provider: "mock",
    modelId: "mock-text",
    doGenerate: async () => {
      const value = responses[Math.min(call++, responses.length - 1)];
      return {
        content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

/** An embedding model returning deterministic vectors of the given size. */
export function mockEmbeddingModel(dimensions: number): MockEmbeddingModelV4 {
  return new MockEmbeddingModelV4({
    provider: "mock",
    modelId: "mock-embedding",
    maxEmbeddingsPerCall: 2048,
    doEmbed: async ({ values }) => ({
      embeddings: values.map((value, index) => Array.from({ length: dimensions }, (_, i) => ((value.length + index + i) % 7) / 7)),
      usage: { tokens: values.length * 3 },
      warnings: [],
    }),
  });
}

export function mockTranscriptionModel(text: string, language?: string): MockTranscriptionModelV4 {
  return new MockTranscriptionModelV4({
    provider: "mock",
    modelId: "mock-transcription",
    doGenerate: async () => ({
      text,
      segments: [],
      language,
      durationInSeconds: 4.2,
      warnings: [],
      response: { timestamp: new Date(0), modelId: "mock-transcription" },
    }),
  });
}

export interface MockProvidersOptions {
  text?: MockLanguageModelV4;
  vision?: MockLanguageModelV4;
  transcription?: MockTranscriptionModelV4 | null;
  embedding?: MockEmbeddingModelV4 | null;
  embeddingDimensions?: number | null;
}

export function createMockProviders(options: MockProvidersOptions = {}): Providers {
  const text = options.text ?? mockJsonModel({ actions: [] });
  const embeddingDimensions = options.embeddingDimensions === undefined ? 1536 : options.embeddingDimensions;
  return {
    text: { model: text, provider: "mock", modelId: "mock-text" },
    vision: { model: options.vision ?? text, provider: "mock", modelId: "mock-vision" },
    transcription:
      options.transcription === null
        ? null
        : { model: options.transcription ?? mockTranscriptionModel(""), provider: "mock", modelId: "mock-transcription" },
    embedding:
      options.embedding === null
        ? null
        : {
            model: options.embedding ?? mockEmbeddingModel(embeddingDimensions ?? 8),
            provider: "mock",
            modelId: "mock-embedding",
            dimensions: embeddingDimensions,
          },
  };
}

export interface ScriptedCall {
  /** All text parts of the prompt (system instructions excluded), joined by newlines. */
  text: string;
  /** File parts (images, audio) passed to the model, by reference. */
  files: Array<{ data: unknown; mediaType: string }>;
}

/**
 * Provider-level file parts carry tagged data (`{ type: "data", data }`, `{ type: "url", url }`, ...).
 * Returns the raw bytes (or base64 string) for inline data, and the tagged value otherwise.
 */
function unwrapFileData(data: unknown): unknown {
  if (data && typeof data === "object" && (data as { type?: unknown }).type === "data" && "data" in data) {
    return (data as { data: unknown }).data;
  }
  return data;
}

/**
 * A language model whose JSON answer is computed from each call's prompt, e.g. to cite the message ids
 * and open-task ids the pipeline put into working memory.
 */
export function scriptedJsonModel(respond: (call: ScriptedCall) => unknown, modelId = "mock-text"): MockLanguageModelV4 {
  return new MockLanguageModelV4({
    provider: "mock",
    modelId,
    doGenerate: async (options) => {
      const texts: string[] = [];
      const files: ScriptedCall["files"] = [];
      for (const message of options.prompt) {
        if (message.role === "system" || typeof message.content === "string") continue;
        for (const part of message.content) {
          if (part.type === "text") texts.push(part.text);
          if (part.type === "file") files.push({ data: unwrapFileData(part.data), mediaType: part.mediaType });
        }
      }
      const value = respond({ text: texts.join("\n"), files });
      return {
        content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
        finishReason: { unified: "stop", raw: undefined },
        usage,
        warnings: [],
      };
    },
  });
}

export interface ParsedAnalysisPrompt {
  openTasks: Array<{ id: string; kind: string; title: string; due: string | null }>;
  /** Creates still pending in Review (ids are review item ids). */
  pendingTasks: Array<{ id: string; kind: string; title: string; due: string | null }>;
  /** Messages marked isNew, oldest first. */
  newMessages: Array<{ id: string; from: "owner" | "contact"; text: string; derived: { type: string; text: string } | null }>;
  calendar: { today: string; tomorrow: string };
}

/** Reads the working memory back out of a task-analysis prompt (see renderTaskAnalysisPrompt). */
export function parseAnalysisPrompt(text: string): ParsedAnalysisPrompt {
  const lines = text.split("\n");
  const trusted = JSON.parse(lines.find((line) => line.startsWith('{"now"'))!) as {
    openTasks: ParsedAnalysisPrompt["openTasks"];
    pendingTasks?: ParsedAnalysisPrompt["pendingTasks"];
    calendar: ParsedAnalysisPrompt["calendar"];
  };
  const newMessages = lines
    .filter((line) => line.startsWith('{"id"'))
    .map((line) => JSON.parse(line) as ParsedAnalysisPrompt["newMessages"][number] & { isNew: boolean })
    .filter((message) => message.isNew);
  return { openTasks: trusted.openTasks, pendingTasks: trusted.pendingTasks ?? [], newMessages, calendar: trusted.calendar };
}
