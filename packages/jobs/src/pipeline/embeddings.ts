/**
 * embed-chat: rebuilds a chat's conversation windows (message text plus derived media text) in
 * message_chunks and embeds the windows that have no vector from the current embedding model, so a
 * model change re-embeds everything. Chunks are kept even without an embedding provider: trigram search
 * works on them, and the sweep embeds them once a provider is configured.
 *
 * embed-sweep (every 5 minutes): queues embed-chat for chats whose messages or media changed since their
 * last run, and for chats with chunks the current model has not embedded.
 *
 * searchChats: embeds the question (when an embedding provider is available) and runs hybridSearch.
 */
import { embedTexts, type EmbeddingRoleModel } from "@wabrain/agent";
import {
  countRecentPendingChatMedia,
  databaseNow,
  getChatRow,
  hybridSearch,
  listChatsNeedingEmbedding,
  listChunkableMessages,
  listChunksToEmbed,
  markChatEmbedded,
  recordModelUsage,
  storeChunkEmbedding,
  syncChatChunks,
  EMBEDDING_DIMENSIONS,
  type Database,
  type HybridSearchHit,
  type HybridSearchParams,
  type SyncChunksResult,
} from "@wabrain/db";
import { createHash } from "node:crypto";
import type { ProviderSource } from "../providers.js";
import type { JobLogger } from "../queue.js";
import { checkBudget, listDeferrals, recordDeferral } from "./budget.js";
import { buildChunkWindows, type ChunkingOptions } from "./chunking.js";
import type { PipelineDeps, PipelineQueue } from "./deps.js";

/** Texts per embedding request. */
const EMBED_BATCH = 64;
/** Characters of a window sent to the embedding model (well under 8k tokens). */
const MAX_EMBED_CHARS = 6000;
/** Watermark safety margin for messages committed by transactions that started before the run. */
const WATERMARK_MARGIN_MS = 30_000;
/** How long an incompatible embedding model (more than 1536 dimensions) pauses embedding. */
const INCOMPATIBLE_RETRY_MS = 60 * 60_000;

/**
 * A stable, non-secret identity of a configured endpoint: a short hash of its normalized base URL
 * (scheme, host, port, and path; without credentials, query, or fragment). The API key is never part
 * of it. Null for the provider's default endpoint.
 */
export function embeddingEndpointId(baseUrl: string | null | undefined): string | null {
  const raw = baseUrl?.trim();
  if (!raw) return null;
  let normalized: string;
  try {
    const url = new URL(raw);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "") || "/";
    normalized = url.toString();
  } catch {
    normalized = raw.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * The id stored with every vector: provider, model, requested dimensions, and, for a configured base
 * URL, the endpoint identity (`openai-compatible/bge-m3#1a2b…`). Two servers exposing the same model
 * alias therefore never share vectors. Vectors from different keys are never compared, and a new key
 * re-embeds every chunk.
 */
export function embeddingModelKey(role: Pick<EmbeddingRoleModel, "provider" | "modelId" | "dimensions"> & { baseUrl?: string | null }): string {
  const endpoint = embeddingEndpointId(role.baseUrl);
  return `${role.provider}/${role.modelId}${role.dimensions ? `@${role.dimensions}` : ""}${endpoint ? `#${endpoint}` : ""}`;
}

export type EmbeddingDeps = Pick<PipelineDeps, "database" | "providers" | "logger" | "config" | "now">;

export type EmbedSkipReason = "no_provider" | "deferred" | "budget" | "incompatible" | "provider_error";

export type EmbedOutcome =
  | { status: "skipped"; reason: "chat_missing" | "chat_off" }
  | { status: "waiting_media"; pending: number }
  | {
      status: "done";
      chunks: Omit<SyncChunksResult, "synced">;
      embedded: number;
      /** Model key the chat's vectors now have (null without a provider). */
      model: string | null;
      /** Why some chunks are still without a current vector. */
      reason: EmbedSkipReason | null;
    };

export async function runChatEmbedding(deps: EmbeddingDeps, chatId: string, chunking: Partial<ChunkingOptions> = {}): Promise<EmbedOutcome> {
  const { database, logger } = deps;
  const db = database.db;
  const chat = await getChatRow(db, chatId).catch(() => null);
  if (!chat) return { status: "skipped", reason: "chat_missing" };
  if (chat.mode === "off") {
    await syncChatChunks(database, chatId, []);
    return { status: "skipped", reason: "chat_off" };
  }

  const now = deps.now();
  const pending = await countRecentPendingChatMedia(db, chatId, new Date(now.getTime() - deps.config.mediaWaitMaxMs));
  if (pending > 0) return { status: "waiting_media", pending };

  const snapshotAt = new Date((await databaseNow(db)).getTime() - WATERMARK_MARGIN_MS);
  const windows = buildChunkWindows(await listChunkableMessages(db, chatId), chunking);
  const { synced, ...chunks } = await syncChatChunks(database, chatId, windows);
  if (!synced) return { status: "skipped", reason: "chat_off" };
  await markChatEmbedded(db, chatId, snapshotAt);

  const done = (embedded: number, model: string | null, reason: EmbedSkipReason | null): EmbedOutcome => {
    logger.info("chat chunks embedded", { chatId, ...chunks, embedded, reason });
    return { status: "done", chunks, embedded, model, reason };
  };

  const state = await deps.providers.load();
  const role = state.providers?.embedding ?? null;
  if (!state.providers || !role) return done(0, null, "no_provider");
  const modelKey = embeddingModelKey(role);
  if ((await listDeferrals(database, now)).some((deferral) => deferral.role === "embedding")) return done(0, modelKey, "deferred");
  const defer = async (reason: "budget" | "provider", until: Date) =>
    recordDeferral(database, { role: "embedding", reason, at: now.toISOString(), until: until.toISOString() });
  if (role.dimensions && role.dimensions > EMBEDDING_DIMENSIONS) {
    await defer("provider", new Date(now.getTime() + INCOMPATIBLE_RETRY_MS));
    logger.warn("embedding model has too many dimensions", { dimensions: role.dimensions, max: EMBEDDING_DIMENSIONS });
    return done(0, modelKey, "incompatible");
  }

  const todo = await listChunksToEmbed(db, chatId, modelKey);
  let embedded = 0;
  for (let start = 0; start < todo.length; start += EMBED_BATCH) {
    const budget = await checkBudget(database, "embedding", state.limits.embedding, deps.now());
    if (budget.exceeded) {
      await defer("budget", budget.resetAt);
      return done(embedded, modelKey, "budget");
    }
    const batch = todo.slice(start, start + EMBED_BATCH);
    let result: Awaited<ReturnType<typeof embedTexts>>;
    try {
      result = await embedTexts(
        state.providers,
        batch.map((chunk) => chunk.text.slice(0, MAX_EMBED_CHARS)),
        { batchSize: EMBED_BATCH, abortSignal: AbortSignal.timeout(deps.config.modelTimeoutMs), maxRetries: 1 },
      );
    } catch (error) {
      await defer("provider", new Date(deps.now().getTime() + deps.config.providerRetryMs));
      logger.warn("embedding failed", { chatId, error: error instanceof Error ? error.name : "error" });
      return done(embedded, modelKey, "provider_error");
    }
    await recordModelUsage(db, {
      role: "embedding",
      purpose: "embed",
      provider: result.provider,
      model: result.model,
      inputTokens: result.tokens,
      outputTokens: null,
      refId: chatId,
    });
    if (result.dimensions > EMBEDDING_DIMENSIONS) {
      await defer("provider", new Date(deps.now().getTime() + INCOMPATIBLE_RETRY_MS));
      logger.warn("embedding model has too many dimensions", { dimensions: result.dimensions, max: EMBEDDING_DIMENSIONS });
      return done(embedded, modelKey, "incompatible");
    }
    const at = deps.now();
    for (const [index, chunk] of batch.entries()) {
      if (await storeChunkEmbedding(db, chunk, modelKey, result.vectors[index]!, at)) embedded += 1;
    }
  }
  return done(embedded, modelKey, null);
}

/** Queues embed-chat for every chat with new or changed content, or with chunks the current model lacks. */
export async function sweepEmbeddings(
  deps: Pick<PipelineDeps, "database" | "providers" | "logger">,
  queue: Pick<PipelineQueue, "enqueue">,
  now: Date,
  limit = 200,
): Promise<number> {
  const state = await deps.providers.load();
  const role = state.providers?.embedding ?? null;
  const deferred = (await listDeferrals(deps.database, now)).some((deferral) => deferral.role === "embedding");
  const chatIds = await listChatsNeedingEmbedding(deps.database.db, {
    modelKey: role ? embeddingModelKey(role) : null,
    includeUnembedded: !deferred,
    limit,
  });
  for (const chatId of chatIds) await queue.enqueue("embed-chat", { chatId }, { singletonKey: chatId });
  if (chatIds.length) deps.logger.info("embedding queued", { chats: chatIds.length });
  return chatIds.length;
}

export interface SearchChatsDeps {
  database: Database;
  providers: ProviderSource;
  logger?: JobLogger;
  now?: () => Date;
  /** Record the query embedding in model_usage (daily limits). Default true. */
  recordUsage?: boolean;
  /** Timeout for embedding the query. Default 15 s. */
  embedTimeoutMs?: number;
}

export type SearchChatsParams = Omit<HybridSearchParams, "queryEmbedding">;

export interface SearchChatsResult {
  hits: HybridSearchHit[];
  /** True when the question was embedded and the vector search ran (otherwise trigram only). */
  vectorSearch: boolean;
}

/**
 * Hybrid search for Ask: embeds the question with the current embedding model when one is configured,
 * within budget, and not paused, then runs hybridSearch. Falls back to the trigram search alone when
 * the question cannot be embedded. Never changes chats, messages, or tasks.
 */
export async function searchChats(deps: SearchChatsDeps, params: SearchChatsParams): Promise<SearchChatsResult> {
  const now = deps.now?.() ?? new Date();
  let queryEmbedding: HybridSearchParams["queryEmbedding"] = null;
  const state = await deps.providers.load();
  const role = state.providers?.embedding ?? null;
  if (state.providers && role && (!role.dimensions || role.dimensions <= EMBEDDING_DIMENSIONS)) {
    const deferred = (await listDeferrals(deps.database, now)).some((deferral) => deferral.role === "embedding");
    const budget = deferred ? null : await checkBudget(deps.database, "embedding", state.limits.embedding, now);
    if (budget && !budget.exceeded) {
      try {
        const result = await embedTexts(state.providers, [params.query], {
          abortSignal: AbortSignal.timeout(deps.embedTimeoutMs ?? 15_000),
          maxRetries: 1,
        });
        if (deps.recordUsage !== false) {
          await recordModelUsage(deps.database.db, {
            role: "embedding",
            purpose: "search",
            provider: result.provider,
            model: result.model,
            inputTokens: result.tokens,
            outputTokens: null,
            refId: null,
          });
        }
        const vector = result.vectors[0];
        if (vector && vector.length <= EMBEDDING_DIMENSIONS) queryEmbedding = { modelKey: embeddingModelKey(role), vector };
      } catch (error) {
        deps.logger?.warn("query embedding failed; using trigram search only", { error: error instanceof Error ? error.name : "error" });
      }
    }
  }
  const hits = await hybridSearch(deps.database, { ...params, queryEmbedding });
  return { hits, vectorSearch: queryEmbedding !== null };
}
