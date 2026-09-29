/**
 * @wabrain/agent — the model layer: provider registry, working memory, task analysis, person
 * profiles, media analyzers, embeddings, and Ask. WhatsApp is read-only: nothing here can write to it,
 * and every message, OCR result, and transcript is treated as untrusted evidence.
 */
export {
  DEFAULT_EMBEDDING_DIMENSIONS,
  DEFAULT_EMBEDDING_MODEL,
  EmbeddingRoleConfigSchema,
  ProviderKindSchema,
  ProviderNotConfiguredError,
  ProvidersConfigSchema,
  RoleConfigSchema,
  createProviders,
  describeRole,
  providersConfigFromEnv,
  roleConfigFromEnv,
  type EmbeddingRoleConfig,
  type EmbeddingRoleModel,
  type ProviderKind,
  type Providers,
  type ProvidersConfig,
  type RoleConfig,
  type RoleModel,
} from "./providers.js";
export type { CallOptions, ModelRun } from "./generate.js";
export { detectLanguage, type LanguageTag } from "./language.js";
export { resolveDue, type ModelDue, type ResolvedDue } from "./due.js";
export { addDays, isValidDate, toLocal, toZonedIso, zonedTimeToInstant } from "./time.js";
export {
  buildWorkingMemory,
  citableIds,
  fromNormalizedMessage,
  promptJson,
  type DerivedKind,
  type MemoryMessage,
  type MemoryMessageInput,
  type MemoryTask,
  type OpenTaskInput,
  type WorkingMemory,
  type WorkingMemoryInput,
  type WorkingMemoryLimits,
} from "./working-memory.js";
export { PROMPT_VERSION, TASK_ANALYSIS_SYSTEM_PROMPT, renderTaskAnalysisPrompt } from "./analysis/prompt.js";
export { ModelAnalysisSchema, ModelTaskActionSchema, type ModelAnalysis, type ModelTaskAction } from "./analysis/schema.js";
export { validateModelActions, type DropReason, type DroppedAction, type ValidatedActions } from "./analysis/validate.js";
export { analyzeChat, type AnalyzeChatResult } from "./analysis/analyze.js";
export {
  PROFILE_PROMPT_VERSION,
  extractPersonFacts,
  suggestChatContext,
  type ContextSuggestion,
  type ExtractPersonFactsResult,
  type ProfileMessageInput,
  type ProposedPersonFact,
} from "./profile.js";
export {
  DEFAULT_MAX_PDF_PAGES,
  MEDIA_PROMPT_VERSION,
  describeImage,
  describePdfPages,
  transcribeAudio,
  type AudioTranscript,
  type ImageAnalysis,
  type PageImage,
  type PdfAnalysis,
} from "./media.js";
export { embedTexts, type EmbedOptions, type EmbedTextsResult } from "./embeddings.js";
export {
  ASK_PROMPT_VERSION,
  answerFromChunks,
  notFoundAnswer,
  type AskOptions,
  type AskResult,
  type RetrievedChunk,
  type RetrievedMessage,
} from "./ask.js";
