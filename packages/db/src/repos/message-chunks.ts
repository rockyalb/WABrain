/**
 * message_chunks: conversation windows (message text plus derived media text) for hybrid retrieval.
 *
 * - The embed-chat job (packages/jobs) rebuilds a chat's windows with `syncChatChunks`, which keeps
 *   unchanged windows (same content hash) with their vectors and deletes the rest, then fills the
 *   missing or stale vectors with `storeChunkEmbedding`.
 * - `hybridSearch` merges an HNSW cosine search and a pg_trgm word-similarity search with reciprocal
 *   rank fusion. Off chats are never searched, and hits only carry messages that still exist, so
 *   purged data can never come back through search.
 *
 * Chunk text is untrusted message content: it is data for retrieval, never instructions.
 */
import { and, asc, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Database, Db } from "../client.js";
import { newId, sha256Hex } from "../ids.js";
import { chatPipelineState, chats, mediaObjects, messageChunks, messages } from "../schema.js";

/** Vector column size (pgvector HNSW indexes at most 2000 dimensions). */
export const EMBEDDING_DIMENSIONS = 1536;

/** Reciprocal rank fusion constant (the usual k = 60). */
export const RRF_K = 60;

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/**
 * Lowercase, without diacritics (é→e, ç→c), letters and digits only. Chats are often typed without
 * diacritics, so both the stored search text and the query are normalized the same way before pg_trgm
 * compares them.
 */
export function normalizeSearchText(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

const STOP_WORDS = new Set(
  [
    // English
    "the and for with what when where who whom why how did does was were has have had that this those these from about",
    "are you your can could would will not any all our his her their them they she him its which there then than but into",
    "tell said say says been being just some more most very also please",
  ]
    .join(" ")
    .split(" "),
);

/** Distinct query words worth matching by trigram (at least 3 characters, no stop words), longest first. */
export function searchTerms(query: string, max = 8): string[] {
  const words = normalizeSearchText(query).split(" ").filter((word) => word.length >= 3 && !STOP_WORDS.has(word));
  const unique = [...new Set(words)].sort((a, b) => b.length - a.length).slice(0, max);
  if (unique.length) return unique;
  const whole = normalizeSearchText(query);
  return whole.length >= 3 ? [whole.slice(0, 200)] : [];
}

/** Zero-pads a vector to the column size; cosine distances are unchanged. Rejects longer vectors. */
export function padEmbedding(vector: readonly number[]): number[] {
  if (vector.length > EMBEDDING_DIMENSIONS) {
    throw new Error(`Embedding has ${vector.length} dimensions; the index holds at most ${EMBEDDING_DIMENSIONS}`);
  }
  if (vector.some((value) => !Number.isFinite(value))) throw new Error("Embedding contains a non-finite value");
  return vector.length === EMBEDDING_DIMENSIONS ? [...vector] : [...vector, ...new Array<number>(EMBEDDING_DIMENSIONS - vector.length).fill(0)];
}

const vectorLiteral = (vector: readonly number[]) => `[${padEmbedding(vector).join(",")}]`;

// ---------------------------------------------------------------------------
// Chunk maintenance (embed-chat job)
// ---------------------------------------------------------------------------

export interface ChunkableMessage {
  id: string;
  sentAt: Date;
  fromOwner: boolean;
  senderName: string | null;
  kind: string;
  body: string;
  derivedText: string | null;
}

/** A conversation window built by the chunker (messages in chat order). */
export interface ChunkWindow {
  messageIds: string[];
  text: string;
  fromAt: Date;
  toAt: Date;
}

/**
 * Chunker format. Bump it when chunk boundaries or line formatting change: the sweep then re-chunks every
 * chat that still has chunks of an older format (v1 truncated each message at 4,000 characters; v2
 * splits long messages into several parts). Windows the new format builds identically keep their row
 * and vector, so only windows that really changed are embedded again.
 */
export const MESSAGE_CHUNK_VERSION = "v2";
const CHUNK_HASH_PREFIX = `chunks:${MESSAGE_CHUNK_VERSION}:`;

const windowDigest = (window: Pick<ChunkWindow, "messageIds" | "text">) => sha256Hex(`${window.messageIds.join(",")}\n${window.text}`);

export const chunkContentHash = (window: Pick<ChunkWindow, "messageIds" | "text">) => `${CHUNK_HASH_PREFIX}${windowDigest(window)}`;

/** The window digest inside a stored hash of any format (v1 stored the bare digest). */
const storedDigest = (contentHash: string) => contentHash.replace(/^chunks:[^:]+:/, "");

/** Every message of a chat in order, with the fields the chunker uses. */
export async function listChunkableMessages(db: Db, chatId: string): Promise<ChunkableMessage[]> {
  return db
    .select({
      id: messages.id,
      sentAt: messages.sentAt,
      fromOwner: messages.fromOwner,
      senderName: messages.senderName,
      kind: messages.kind,
      body: messages.body,
      derivedText: messages.derivedText,
    })
    .from(messages)
    .where(eq(messages.chatId, chatId))
    .orderBy(asc(messages.sentAt), asc(messages.id));
}

export interface SyncChunksResult {
  /** False when the chat is missing or Off (then it has no chunks left). */
  synced: boolean;
  inserted: number;
  deleted: number;
  kept: number;
}

/**
 * Makes the chat's chunks equal to `windows`: unchanged windows keep their row and vector, others are
 * deleted, new ones are inserted without a vector. Holds the chat row FOR SHARE, and purgeChatData
 * takes it FOR UPDATE, so a purge never interleaves; a window is inserted only while all its messages
 * still exist.
 */
export async function syncChatChunks(database: Database, chatId: string, windows: readonly ChunkWindow[]): Promise<SyncChunksResult> {
  return database.transaction(async ({ db }) => {
    const [chat] = await db.select({ mode: chats.mode }).from(chats).where(eq(chats.id, chatId)).for("share");
    if (!chat || chat.mode === "off") {
      const removed = await db.delete(messageChunks).where(eq(messageChunks.chatId, chatId)).returning({ id: messageChunks.id });
      return { synced: false, inserted: 0, deleted: removed.length, kept: 0 };
    }
    const wanted = new Map(windows.map((window) => [chunkContentHash(window), window]));
    const existing = await db
      .select({ id: messageChunks.id, contentHash: messageChunks.contentHash })
      .from(messageChunks)
      .where(eq(messageChunks.chatId, chatId));
    // One-time format upgrade: an older-format row whose window is unchanged keeps its vector and only
    // gets the current hash; the rest of the older rows are deleted below like any stale window.
    const legacy = existing.filter((row) => !row.contentHash.startsWith(CHUNK_HASH_PREFIX));
    if (legacy.length) {
      const current = new Map([...wanted.entries()].map(([hash, window]) => [windowDigest(window), hash]));
      const taken = new Set(existing.map((row) => row.contentHash));
      for (const row of legacy) {
        const upgraded = current.get(storedDigest(row.contentHash));
        if (!upgraded || taken.has(upgraded)) continue;
        await db.update(messageChunks).set({ contentHash: upgraded }).where(eq(messageChunks.id, row.id));
        taken.add(upgraded);
        row.contentHash = upgraded;
      }
    }
    const stale = existing.filter((row) => !wanted.has(row.contentHash)).map((row) => row.id);
    for (let i = 0; i < stale.length; i += 500) await db.delete(messageChunks).where(inArray(messageChunks.id, stale.slice(i, i + 500)));
    const have = new Set(existing.map((row) => row.contentHash));
    const fresh = [...wanted.entries()].filter(([hash]) => !have.has(hash));

    let inserted = 0;
    if (fresh.length) {
      const ids = [...new Set(fresh.flatMap(([, window]) => window.messageIds))];
      const present = new Set<string>();
      for (let i = 0; i < ids.length; i += 1000) {
        const rows = await db
          .select({ id: messages.id })
          .from(messages)
          .where(and(eq(messages.chatId, chatId), inArray(messages.id, ids.slice(i, i + 1000))));
        for (const row of rows) present.add(row.id);
      }
      const values = fresh
        .filter(([, window]) => window.messageIds.length > 0 && window.messageIds.every((id) => present.has(id)))
        .map(([contentHash, window]) => ({
          id: newId(),
          chatId,
          messageIds: window.messageIds,
          text: window.text,
          searchText: normalizeSearchText(window.text),
          contentHash,
          fromAt: window.fromAt,
          toAt: window.toAt,
        }));
      for (let i = 0; i < values.length; i += 200) {
        const rows = await db
          .insert(messageChunks)
          .values(values.slice(i, i + 200))
          .onConflictDoNothing()
          .returning({ id: messageChunks.id });
        inserted += rows.length;
      }
    }
    return { synced: true, inserted, deleted: stale.length, kept: existing.length - stale.length };
  });
}

export interface ChunkToEmbed {
  id: string;
  contentHash: string;
  text: string;
}

/** Chunks of a chat without a vector from `modelKey` (never embedded, or embedded by another model). */
export async function listChunksToEmbed(db: Db, chatId: string, modelKey: string): Promise<ChunkToEmbed[]> {
  return db
    .select({ id: messageChunks.id, contentHash: messageChunks.contentHash, text: messageChunks.text })
    .from(messageChunks)
    .where(
      and(
        eq(messageChunks.chatId, chatId),
        or(isNull(messageChunks.embedding), isNull(messageChunks.embeddingModel), ne(messageChunks.embeddingModel, modelKey)),
      ),
    )
    .orderBy(asc(messageChunks.fromAt));
}

/** Stores a vector unless the chunk was replaced or deleted meanwhile. Returns whether a row changed. */
export async function storeChunkEmbedding(
  db: Db,
  chunk: Pick<ChunkToEmbed, "id" | "contentHash">,
  modelKey: string,
  vector: readonly number[],
  at: Date,
): Promise<boolean> {
  const rows = await db
    .update(messageChunks)
    .set({ embedding: padEmbedding(vector), embeddingModel: modelKey, embeddedAt: at })
    .where(and(eq(messageChunks.id, chunk.id), eq(messageChunks.contentHash, chunk.contentHash)))
    .returning({ id: messageChunks.id });
  return rows.length > 0;
}

/** Records the start of an embed-chat run: later message or media changes re-queue the chat. */
export async function markChatEmbedded(db: Db, chatId: string, snapshotAt: Date): Promise<void> {
  await db
    .insert(chatPipelineState)
    .values({ chatId, lastEmbeddedAt: snapshotAt })
    .onConflictDoUpdate({ target: chatPipelineState.chatId, set: { lastEmbeddedAt: snapshotAt, updatedAt: sql`now()` } });
}

/** The database clock (message created_at and media updated_at come from it). */
export async function databaseNow(db: Db): Promise<Date> {
  const [row] = await db.execute<{ now: string | Date }>(sql`select now() as now`);
  return new Date(row!.now);
}

/** Media of the chat still pending or processing, created after `since` (the job waits for it). */
export async function countRecentPendingChatMedia(db: Db, chatId: string, since: Date): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(mediaObjects)
    .innerJoin(messages, eq(messages.id, mediaObjects.messageId))
    .where(
      and(
        eq(messages.chatId, chatId),
        inArray(mediaObjects.status, ["pending", "processing"]),
        sql`${mediaObjects.createdAt} > ${since.toISOString()}::timestamptz`,
      ),
    );
  return row?.count ?? 0;
}

export interface ChatsNeedingEmbeddingOptions {
  /** Current embedding model key; with `includeUnembedded`, chunks without its vector count as work. */
  modelKey: string | null;
  includeUnembedded: boolean;
  limit?: number;
}

/**
 * Chats (not Off) whose messages or media changed since their last embed-chat run, that still have
 * chunks of an older chunker format (with or without an embedding provider), or, when
 * `includeUnembedded` is set, that have chunks without a vector from the current model (a model
 * change, or a provider configured after the chunks were built).
 */
export async function listChatsNeedingEmbedding(db: Db, options: ChatsNeedingEmbeddingOptions): Promise<string[]> {
  const since = sql`coalesce(${chatPipelineState.lastEmbeddedAt}, '-infinity'::timestamptz)`;
  const unembedded =
    options.includeUnembedded && options.modelKey
      ? sql`or exists (
          select 1 from ${messageChunks} mc
          where mc.chat_id = ${chats.id}
            and (mc.embedding is null or mc.embedding_model is distinct from ${options.modelKey})
        )`
      : sql``;
  const rows = await db
    .select({ id: chats.id })
    .from(chats)
    .leftJoin(chatPipelineState, eq(chatPipelineState.chatId, chats.id))
    .where(
      and(
        ne(chats.mode, "off"),
        sql`(
          exists (select 1 from ${messages} m where m.chat_id = ${chats.id} and m.created_at > ${since})
          or exists (
            select 1 from ${mediaObjects} mo join ${messages} m on m.id = mo.message_id
            where m.chat_id = ${chats.id} and mo.updated_at > ${since}
          )
          or exists (
            select 1 from ${messageChunks} legacy
            where legacy.chat_id = ${chats.id} and legacy.content_hash not like ${`${CHUNK_HASH_PREFIX}%`}
          )
          ${unembedded}
        )`,
      ),
    )
    .orderBy(asc(chats.id))
    .limit(options.limit ?? 200);
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------
// Hybrid search
// ---------------------------------------------------------------------------

export interface QueryEmbedding {
  /** Must equal the `embedding_model` key of the stored chunks to be compared. */
  modelKey: string;
  vector: readonly number[];
}

export interface HybridSearchParams {
  query: string;
  /** The query's vector; null or omitted runs the trigram search only. */
  queryEmbedding?: QueryEmbedding | null;
  /** Direct chats with this person, and group windows where one of their messages appears. */
  personId?: string | null;
  /** Chats whose default context is this one. */
  contextId?: string | null;
  /** Inclusive bounds (ISO 8601 or Date): windows overlapping the range, and only their messages inside it. */
  from?: Date | string | null;
  to?: Date | string | null;
  /** Hits returned. Default 8, at most 50. */
  limit?: number;
}

/** One retrieved message; structurally the agent's RetrievedMessage. */
export interface SearchHitMessage {
  id: string;
  /** ISO 8601 instant. */
  at: string;
  senderName: string | null;
  fromOwner: boolean;
  text: string;
  derivedText: string | null;
}

/** One conversation window; structurally the agent's RetrievedChunk, so hits go to answerFromChunks as they are. */
export interface HybridSearchHit {
  chunkId: string;
  chatId: string;
  /** Group name, or the person's name for a direct chat. */
  chatName: string | null;
  fromAt: string;
  toAt: string;
  /** Reciprocal rank fusion score (higher is better). */
  score: number;
  /** 1-based rank in the vector list, or null when the chunk was not in it. */
  vectorRank: number | null;
  /** 1-based rank in the trigram list, or null when the chunk was not in it. */
  textRank: number | null;
  messages: SearchHitMessage[];
}

const WORD_SIMILARITY_THRESHOLD = 0.5;
const iterativeScanSupport = new WeakMap<object, Promise<boolean>>();

/** pgvector 0.8+ can keep scanning the HNSW index until filtered queries have enough rows. */
function supportsIterativeScan(sql: Sql): Promise<boolean> {
  let cached = iterativeScanSupport.get(sql);
  if (!cached) {
    cached = sql<{ v: string | null }[]>`select extversion as v from pg_extension where extname = 'vector'`
      .then(([row]) => {
        const [major = 0, minor = 0] = (row?.v ?? "0.0").split(".").map(Number);
        return major > 0 || minor >= 8;
      })
      .catch(() => false);
    iterativeScanSupport.set(sql, cached);
  }
  return cached;
}

// Drizzle's postgres-js driver turns off postgres.js date parsing and serialization on the shared
// client, so raw queries bind timestamps as ISO strings and get strings back.
const epochMs = (value: Date | string) => (value instanceof Date ? value.getTime() : Date.parse(value));
const isoString = (value: Date | string) => new Date(epochMs(value)).toISOString();

const toDate = (value: Date | string | null | undefined): Date | null => {
  if (value === null || value === undefined || value === "") return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error("Invalid search date");
  return date;
};

/**
 * Hybrid retrieval over message_chunks: HNSW cosine search (when a query vector is given; only chunks
 * embedded by the same model) and pg_trgm word similarity on the normalized text (typos and missing
 * diacritics still match), fused with reciprocal rank fusion. Read-only.
 */
export async function hybridSearch(database: Database, params: HybridSearchParams): Promise<HybridSearchHit[]> {
  const limit = Math.min(50, Math.max(1, Math.trunc(params.limit ?? 8)));
  const pool = Math.min(200, Math.max(40, limit * 4));
  const from = toDate(params.from);
  const to = toDate(params.to);
  const terms = searchTerms(params.query);
  const embedding = params.queryEmbedding ?? null;
  const iterative = embedding ? await supportsIterativeScan(database.sql) : false;

  return database.transaction(async ({ sql: tx }) => {
    await tx`set transaction read only`;
    const filters = () => tx`
      c.mode <> 'off'
      ${params.contextId ? tx`and c.default_context_id = ${params.contextId}` : tx``}
      ${
        params.personId
          ? tx`and (c.person_id = ${params.personId} or exists (
              select 1 from messages m join participants p on p.id = m.participant_id
              where m.id = any(mc.message_ids) and p.person_id = ${params.personId}
            ))`
          : tx``
      }
      ${from ? tx`and mc.to_at >= ${from.toISOString()}::timestamptz` : tx``}
      ${to ? tx`and mc.from_at <= ${to.toISOString()}::timestamptz` : tx``}
    `;

    let vectorIds: string[] = [];
    if (embedding) {
      const literal = vectorLiteral(embedding.vector);
      await tx`select set_config('hnsw.ef_search', ${String(Math.min(1000, pool))}, true)`;
      if (iterative) await tx`select set_config('hnsw.iterative_scan', 'relaxed_order', true)`;
      const rows = await tx<{ id: string; distance: number }[]>`
        with nearest as materialized (
          select mc.id, mc.embedding <=> ${literal}::vector as distance
          from message_chunks mc join chats c on c.id = mc.chat_id
          where mc.embedding is not null and mc.embedding_model = ${embedding.modelKey} and ${filters()}
          order by mc.embedding <=> ${literal}::vector
          limit ${pool}
        )
        select id, distance from nearest order by distance, id`;
      vectorIds = rows.map((row) => row.id);
    }

    let textIds: string[] = [];
    if (terms.length) {
      await tx`select set_config('pg_trgm.word_similarity_threshold', ${String(WORD_SIMILARITY_THRESHOLD)}, true)`;
      // `text %> term` means word_similarity(term, text) >= threshold; OR-ed terms become a BitmapOr over
      // the GIN index. The score sums each matching term's similarity.
      const matches = terms.slice(1).reduce((acc, term) => tx`${acc} or mc.search_text %> ${term}`, tx`mc.search_text %> ${terms[0]!}`);
      const score = terms
        .slice(1)
        .reduce(
          (acc, term) => tx`${acc} + (case when mc.search_text %> ${term} then word_similarity(${term}, mc.search_text) else 0 end)`,
          tx`(case when mc.search_text %> ${terms[0]!} then word_similarity(${terms[0]!}, mc.search_text) else 0 end)`,
        );
      const rows = await tx<{ id: string }[]>`
        select mc.id, ${score} as score
        from message_chunks mc join chats c on c.id = mc.chat_id
        where (${matches}) and ${filters()}
        order by score desc, mc.to_at desc, mc.id
        limit ${pool}`;
      textIds = rows.map((row) => row.id);
    }

    // Reciprocal rank fusion.
    const fused = new Map<string, { score: number; vectorRank: number | null; textRank: number | null }>();
    const add = (ids: string[], key: "vectorRank" | "textRank") =>
      ids.forEach((id, index) => {
        const entry = fused.get(id) ?? { score: 0, vectorRank: null, textRank: null };
        entry.score += 1 / (RRF_K + index + 1);
        entry[key] = index + 1;
        fused.set(id, entry);
      });
    add(vectorIds, "vectorRank");
    add(textIds, "textRank");
    if (!fused.size) return [];

    const chunkRows = await tx<
      { id: string; chat_id: string; chat_name: string | null; message_ids: string[]; from_at: Date | string; to_at: Date | string }[]
    >`
      select mc.id, mc.chat_id, coalesce(c.name, pe.display_name) as chat_name, mc.message_ids, mc.from_at, mc.to_at
      from message_chunks mc
      join chats c on c.id = mc.chat_id
      left join people pe on pe.id = c.person_id
      where mc.id = any(${[...fused.keys()]}::text[]) and c.mode <> 'off'`;
    const ranked = chunkRows
      .map((row) => ({ row, ...fused.get(row.id)! }))
      .sort((a, b) => b.score - a.score || epochMs(b.row.to_at) - epochMs(a.row.to_at) || a.row.id.localeCompare(b.row.id));

    // Load messages for the best windows, skipping windows whose messages are gone (purged) or all
    // outside the date range, until `limit` hits are filled.
    const hits: HybridSearchHit[] = [];
    for (let start = 0; start < ranked.length && hits.length < limit; start += limit) {
      const batch = ranked.slice(start, start + limit);
      const ids = [...new Set(batch.flatMap((entry) => entry.row.message_ids))];
      const messageRows = await tx<
        { id: string; chat_id: string; sent_at: Date | string; sender_name: string | null; from_owner: boolean; body: string; derived_text: string | null }[]
      >`
        select id, chat_id, sent_at, sender_name, from_owner, body, derived_text
        from messages
        where id = any(${ids}::text[])
          ${from ? tx`and sent_at >= ${from.toISOString()}::timestamptz` : tx``}
          ${to ? tx`and sent_at <= ${to.toISOString()}::timestamptz` : tx``}`;
      const byId = new Map(messageRows.map((row) => [row.id, row]));
      for (const entry of batch) {
        const list = entry.row.message_ids
          .map((id) => byId.get(id))
          .filter((row): row is NonNullable<typeof row> => Boolean(row) && row!.chat_id === entry.row.chat_id)
          .map((row) => ({
            id: row.id,
            at: isoString(row.sent_at),
            senderName: row.sender_name,
            fromOwner: row.from_owner,
            text: row.body,
            derivedText: row.derived_text,
          }));
        if (!list.length) continue;
        hits.push({
          chunkId: entry.row.id,
          chatId: entry.row.chat_id,
          chatName: entry.row.chat_name,
          fromAt: isoString(entry.row.from_at),
          toAt: isoString(entry.row.to_at),
          score: entry.score,
          vectorRank: entry.vectorRank,
          textRank: entry.textRank,
          messages: list,
        });
        if (hits.length >= limit) break;
      }
    }
    return hits;
  }) as Promise<HybridSearchHit[]>;
}

/** Test and maintenance helper: the chat's chunks in order. */
export async function listChatChunks(db: Db, chatId: string) {
  return db
    .select({
      id: messageChunks.id,
      messageIds: messageChunks.messageIds,
      text: messageChunks.text,
      contentHash: messageChunks.contentHash,
      embeddingModel: messageChunks.embeddingModel,
      hasEmbedding: sql<boolean>`${messageChunks.embedding} is not null`,
      fromAt: messageChunks.fromAt,
      toAt: messageChunks.toAt,
    })
    .from(messageChunks)
    .where(eq(messageChunks.chatId, chatId))
    .orderBy(asc(messageChunks.fromAt), asc(messageChunks.id));
}
