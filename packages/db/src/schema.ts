/**
 * PostgreSQL schema. Row shapes are internal; repositories map them to the
 * contract types in @wabrain/contracts.
 *
 * Syncable tables (contexts, chats, people, tasks, review_items) carry a
 * `sync_version` that a trigger bumps from `sync_version_seq` on every insert
 * and update, and a delete trigger writes a row to `sync_tombstones`. See
 * drizzle/0001_sync_triggers.sql and src/repos/sync.ts.
 */
import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  vector,
} from "drizzle-orm/pg-core";

// Millisecond precision so JS Dates round-trip exactly (keyset cursors depend on it).
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date", precision: 3 });
const createdAt = () => ts("created_at").notNull().defaultNow();
const updatedAt = () => ts("updated_at").notNull().defaultNow();
const syncVersion = () =>
  bigint("sync_version", { mode: "number" })
    .notNull()
    .default(sql`nextval('sync_version_seq')`);
const textArray = (name: string) => text(name).array().notNull().default(sql`'{}'::text[]`);

export const syncVersionSeq = pgSequence("sync_version_seq", { startWith: 1, increment: 1 });

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

/** Raw, immutable OpenWA deliveries. `raw` cannot be updated (trigger). */
export const sourceEvents = pgTable(
  "source_events",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    deliveryId: text("delivery_id").notNull(),
    eventType: text("event_type").notNull(),
    /** Chat JID, so a chat's raw events can be purged with its data. */
    chatJid: text("chat_jid").notNull(),
    raw: jsonb("raw").notNull(),
    receivedAt: ts("received_at").notNull().defaultNow(),
    projectedAt: ts("projected_at"),
    projectionError: text("projection_error"),
  },
  (t) => [
    uniqueIndex("source_events_session_idem_uq").on(t.sessionId, t.idempotencyKey),
    index("source_events_chat_jid_idx").on(t.chatJid),
    index("source_events_unprojected_idx").on(t.receivedAt).where(sql`${t.projectedAt} is null`),
  ],
);

/** One durable keyset checkpoint per OpenWA session. A cancelled or failed run can resume. */
export const historyImportRuns = pgTable("history_import_runs", {
  sessionId: text("session_id").primaryKey(),
  status: text("status", { enum: ["queued", "running", "completed", "cancelled", "failed"] }).notNull(),
  days: integer("days").notNull(),
  generation: integer("generation").notNull().default(1),
  cutoffAt: ts("cutoff_at").notNull(),
  afterCursor: text("after_cursor"),
  fetchedCount: integer("fetched_count").notNull().default(0),
  totalEstimate: integer("total_estimate"),
  cancelRequested: boolean("cancel_requested").notNull().default(false),
  lastError: text("last_error"),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  updatedAt: updatedAt(),
});

/** Rows that could not be imported; cursor uniqueness keeps replayed pages from double counting. */
export const historyImportGaps = pgTable(
  "history_import_gaps",
  {
    sessionId: text("session_id").notNull().references(() => historyImportRuns.sessionId, { onDelete: "cascade" }),
    cursor: text("cursor").notNull(),
    chatJid: text("chat_jid").notNull(),
    reason: text("reason").notNull(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.cursor, t.reason] })],
);

// ---------------------------------------------------------------------------
// Contexts, chats, people
// ---------------------------------------------------------------------------

export const contexts = pgTable("contexts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  color: text("color"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  syncVersion: syncVersion(),
});

export const people = pgTable(
  "people",
  {
    id: text("id").primaryKey(),
    displayName: text("display_name").notNull(),
    /** "auto" names follow WhatsApp contact names; "owner" names are never overwritten. */
    displayNameSource: text("display_name_source", { enum: ["auto", "owner"] }).notNull().default("auto"),
    /** JID the person was created from (direct chat). Unique so concurrent projections converge. */
    primaryJid: text("primary_jid"),
    jids: textArray("jids"),
    languages: textArray("languages"),
    defaultContextId: text("default_context_id").references(() => contexts.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    syncVersion: syncVersion(),
  },
  (t) => [
    uniqueIndex("people_primary_jid_uq").on(t.primaryJid),
    index("people_jids_gin").using("gin", t.jids),
  ],
);

export const personFacts = pgTable(
  "person_facts",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    key: text("key", {
      enum: ["name", "company", "role", "relationship", "language", "topic", "location", "other"],
    }).notNull(),
    value: text("value").notNull(),
    confidence: real("confidence").notNull(),
    verified: boolean("verified").notNull().default(false),
    selfClaimed: boolean("self_claimed").notNull().default(false),
    source: text("source", { enum: ["ai", "owner"] }).notNull(),
    sourceMessageIds: textArray("source_message_ids"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("person_facts_person_idx").on(t.personId)],
);

/**
 * Names saved in the owner's phone contacts, keyed by WhatsApp jid (`…@c.us`), copied from OpenWA's
 * contact list by the weekly `sync-contacts` job. A saved name wins over the name a person chose in
 * WhatsApp (their push name), which is shown with a leading "~", as WhatsApp does.
 */
export const contactNames = pgTable("contact_names", {
  jid: text("jid").primaryKey(),
  name: text("name").notNull(),
  syncedAt: ts("synced_at").notNull().defaultNow(),
});

/** Chats with their rules (mode, context, aliases, auto-create) folded in. */
export const chats = pgTable(
  "chats",
  {
    id: text("id").primaryKey(),
    jid: text("jid").notNull(),
    name: text("name"),
    isGroup: boolean("is_group").notNull(),
    mode: text("mode", { enum: ["off", "on", "mentions_only"] }).notNull(),
    defaultContextId: text("default_context_id").references(() => contexts.id, { onDelete: "set null" }),
    contextConfirmed: boolean("context_confirmed").notNull().default(false),
    autoCreate: boolean("auto_create").notNull().default(true),
    minimumAutoConfidence: real("minimum_auto_confidence"),
    aliases: textArray("aliases"),
    personId: text("person_id").references(() => people.id, { onDelete: "set null" }),
    lastMessageAt: ts("last_message_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    syncVersion: syncVersion(),
  },
  (t) => [uniqueIndex("chats_jid_uq").on(t.jid), index("chats_person_idx").on(t.personId)],
);

export const participants = pgTable(
  "participants",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    displayName: text("display_name"),
    personId: text("person_id").references(() => people.id, { onDelete: "set null" }),
    lastSeenAt: ts("last_seen_at"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("participants_chat_jid_uq").on(t.chatId, t.jid)],
);

// ---------------------------------------------------------------------------
// Messages and media
// ---------------------------------------------------------------------------

export const messages = pgTable(
  "messages",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    waMessageId: text("wa_message_id").notNull(),
    sourceEventId: text("source_event_id").references(() => sourceEvents.id, { onDelete: "set null" }),
    participantId: text("participant_id").references(() => participants.id, { onDelete: "set null" }),
    senderJid: text("sender_jid").notNull(),
    senderName: text("sender_name"),
    direction: text("direction", { enum: ["incoming", "outgoing"] }).notNull(),
    fromOwner: boolean("from_owner").notNull(),
    kind: text("kind").notNull(),
    body: text("body").notNull().default(""),
    /** OCR / description / transcript, filled by media jobs. */
    derivedText: text("derived_text"),
    language: text("language"),
    quotedWaMessageId: text("quoted_wa_message_id"),
    quotedMessageId: text("quoted_message_id"),
    mentions: textArray("mentions"),
    hasMedia: boolean("has_media").notNull().default(false),
    source: text("source", { enum: ["webhook", "history"] }).notNull(),
    /** Set at projection: the chat rule selected this message for task analysis (not context only). */
    analyzable: boolean("analyzable").notNull().default(false),
    /** The analysis run that consumed this message; null while it waits for analysis. */
    analysisRunId: text("analysis_run_id"),
    sentAt: ts("sent_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("messages_chat_wa_uq").on(t.chatId, t.waMessageId),
    index("messages_chat_sent_idx").on(t.chatId, t.sentAt),
    index("messages_chat_created_idx").on(t.chatId, t.createdAt),
    index("messages_unanalyzed_idx")
      .on(t.chatId, t.sentAt)
      .where(sql`${t.analyzable} and ${t.analysisRunId} is null`),
  ],
);

export const mediaObjects = pgTable(
  "media_objects",
  {
    id: text("id").primaryKey(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    mimetype: text("mimetype"),
    filename: text("filename"),
    sizeBytes: bigint("size_bytes", { mode: "number" }),
    status: text("status", { enum: ["pending", "processing", "done", "failed", "skipped"] })
      .notNull()
      .default("pending"),
    derivedText: text("derived_text"),
    language: text("language"),
    /** sha256 of the fetched bytes: identical media (forwards) is analyzed once. */
    contentSha256: text("content_sha256"),
    durationSeconds: real("duration_seconds"),
    attempts: integer("attempts").notNull().default(0),
    error: text("error"),
    rawDeletedAt: ts("raw_deleted_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("media_objects_message_uq").on(t.messageId),
    index("media_objects_sha_idx").on(t.contentSha256),
  ],
);

/**
 * Conversation windows for hybrid retrieval (the embed-chat job fills this, see
 * src/repos/message-chunks.ts). `embedding` is null until a model embeds the window, or while no
 * embedding provider is configured; trigram search works either way.
 */
export const messageChunks = pgTable(
  "message_chunks",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    messageIds: textArray("message_ids"),
    text: text("text").notNull(),
    /** `text` lowercased without diacritics (é→e, ç→c), for pg_trgm matching of typos. */
    searchText: text("search_text").notNull().default(""),
    /** sha256 of the message ids and text: an unchanged window keeps its row and vector. */
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding", { dimensions: 1536 }),
    /** Model key ("provider/model@dimensions") of `embedding`; a different current key triggers a re-embed. */
    embeddingModel: text("embedding_model"),
    embeddedAt: ts("embedded_at"),
    fromAt: ts("from_at").notNull(),
    toAt: ts("to_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    index("message_chunks_chat_idx").on(t.chatId, t.fromAt),
    uniqueIndex("message_chunks_chat_hash_uq").on(t.chatId, t.contentHash),
    index("message_chunks_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("message_chunks_search_trgm").using("gin", sql`${t.searchText} gin_trgm_ops`),
  ],
);

// ---------------------------------------------------------------------------
// Tasks and review
// ---------------------------------------------------------------------------

export const analysisRuns = pgTable(
  "analysis_runs",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id").references(() => chats.id, { onDelete: "set null" }),
    status: text("status", { enum: ["running", "succeeded", "failed"] }).notNull().default("running"),
    provider: text("provider"),
    model: text("model"),
    promptVersion: text("prompt_version"),
    inputMessageIds: textArray("input_message_ids"),
    fromMessageAt: ts("from_message_at"),
    toMessageAt: ts("to_message_at"),
    usage: jsonb("usage"),
    latencyMs: integer("latency_ms"),
    actions: jsonb("actions"),
    decisions: jsonb("decisions"),
    /** Model actions removed by validation, with the reason. */
    dropped: jsonb("dropped"),
    /** Parallel to actions: why a create overrides the chat's default context. */
    contextReasons: jsonb("context_reasons"),
    /** Per-action outcome after applying (task id, review item id, or drop reason). */
    outcomes: jsonb("outcomes"),
    /** sha256(chat + consumed message ids): a retried job resumes this run instead of starting over. */
    idempotencyKey: text("idempotency_key"),
    error: text("error"),
    startedAt: ts("started_at").notNull().defaultNow(),
    finishedAt: ts("finished_at"),
  },
  (t) => [
    index("analysis_runs_chat_idx").on(t.chatId, t.startedAt),
    uniqueIndex("analysis_runs_idem_uq").on(t.idempotencyKey),
  ],
);

/** Exactly-once application of agent actions: one row per (run, action index). */
export const appliedActions = pgTable("applied_actions", {
  key: text("key").primaryKey(),
  outcome: text("outcome", { enum: ["pending", "applied", "review", "dropped"] }).notNull(),
  taskId: text("task_id"),
  reviewItemId: text("review_item_id"),
  reason: text("reason"),
  createdAt: createdAt(),
});

/** Per-chat pipeline bookkeeping that must not bump the chat's sync version. */
export const chatPipelineState = pgTable("chat_pipeline_state", {
  chatId: text("chat_id")
    .primaryKey()
    .references(() => chats.id, { onDelete: "cascade" }),
  lastAnalysisAt: ts("last_analysis_at"),
  lastAnalysisRunId: text("last_analysis_run_id"),
  /** Local date (settings timezone) of the last profile run: at most one per chat per day. */
  lastProfileDate: text("last_profile_date"),
  lastProfileAt: ts("last_profile_at"),
  profileCursorCreatedAt: ts("profile_cursor_created_at"),
  profileCursorMessageId: text("profile_cursor_message_id"),
  profileTargetCreatedAt: ts("profile_target_created_at"),
  profileTargetMessageId: text("profile_target_message_id"),
  /** Start of the last embed-chat run: messages and media changed after it are re-chunked. */
  lastEmbeddedAt: ts("last_embedded_at"),
  updatedAt: updatedAt(),
});

/** Model calls per role, for daily spending limits and the status page. Never holds content. */
export const modelUsage = pgTable(
  "model_usage",
  {
    id: text("id").primaryKey(),
    at: ts("at").notNull().defaultNow(),
    role: text("role", { enum: ["text", "vision", "transcription", "embedding"] }).notNull(),
    purpose: text("purpose").notNull(),
    provider: text("provider"),
    model: text("model"),
    inputTokens: integer("input_tokens"),
    outputTokens: integer("output_tokens"),
    refId: text("ref_id"),
  },
  (t) => [index("model_usage_role_at_idx").on(t.role, t.at)],
);

/**
 * Owner-configured model providers per role. The API key is encrypted with AES-256-GCM
 * (APP_ENCRYPTION_KEY) and never returned by the API.
 */
export const providerSettings = pgTable("provider_settings", {
  role: text("role", { enum: ["text", "vision", "transcription", "embedding"] }).primaryKey(),
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  baseUrl: text("base_url"),
  apiKeyEncrypted: text("api_key_encrypted"),
  dimensions: integer("dimensions"),
  structuredOutputs: boolean("structured_outputs"),
  dailyTokenLimit: integer("daily_token_limit"),
  dailyCallLimit: integer("daily_call_limit"),
  updatedAt: updatedAt(),
});

/** Small server-side key/value state (VAPID keys, budget deferrals). */
export const appState = pgTable("app_state", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: updatedAt(),
});

/** Sent scheduled notifications (reminders per task and due value, daily summaries per date). */
export const notificationLog = pgTable(
  "notification_log",
  {
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    sentAt: ts("sent_at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.kind, t.key] })],
);

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    kind: text("kind", { enum: ["todo", "waiting_on"] }).notNull(),
    status: text("status", { enum: ["open", "done", "cancelled"] }).notNull().default("open"),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    dueAt: ts("due_at"),
    dueHasTime: boolean("due_has_time").notNull().default(false),
    contextId: text("context_id").references(() => contexts.id, { onDelete: "set null" }),
    chatId: text("chat_id").references(() => chats.id, { onDelete: "set null" }),
    personId: text("person_id").references(() => people.id, { onDelete: "set null" }),
    origin: text("origin", { enum: ["ai", "manual", "import"] }).notNull(),
    language: text("language"),
    confidence: real("confidence"),
    evidenceMessageIds: textArray("evidence_message_ids"),
    mergedIntoTaskId: text("merged_into_task_id"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    closedAt: ts("closed_at"),
    syncVersion: syncVersion(),
  },
  (t) => [
    index("tasks_status_idx").on(t.status, t.dueAt),
    index("tasks_chat_idx").on(t.chatId),
    index("tasks_person_idx").on(t.personId),
    index("tasks_sync_idx").on(t.syncVersion),
  ],
);

export const reviewItems = pgTable(
  "review_items",
  {
    id: text("id").primaryKey(),
    type: text("type", {
      enum: ["create", "possibly_done", "possibly_cancelled", "reschedule", "merge"],
    }).notNull(),
    state: text("state", { enum: ["pending", "accepted", "rejected"] }).notNull().default("pending"),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    action: jsonb("action").notNull(),
    reason: text("reason").notNull(),
    chatId: text("chat_id").references(() => chats.id, { onDelete: "set null" }),
    personId: text("person_id").references(() => people.id, { onDelete: "set null" }),
    summary: text("summary").notNull(),
    /** create only: a later message suggests it was already handled (ReviewHandledHint). */
    handled: jsonb("handled"),
    analysisRunId: text("analysis_run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
    resultTaskId: text("result_task_id"),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
    syncVersion: syncVersion(),
  },
  (t) => [index("review_items_state_idx").on(t.state, t.createdAt), index("review_items_sync_idx").on(t.syncVersion)],
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    /** Events written by one operation (e.g. a merge) share a group and are undone together. */
    groupId: text("group_id").notNull(),
    type: text("type", {
      enum: ["created", "edited", "completed", "reopened", "cancelled", "rescheduled", "merged", "undone"],
    }).notNull(),
    actor: text("actor", { enum: ["ai", "owner", "system"] }).notNull(),
    evidenceMessageIds: textArray("evidence_message_ids"),
    before: jsonb("before").$type<Record<string, unknown> | null>(),
    after: jsonb("after").$type<Record<string, unknown> | null>(),
    undoableUntil: ts("undoable_until"),
    undoneAt: ts("undone_at"),
    reviewItemId: text("review_item_id").references(() => reviewItems.id, { onDelete: "set null" }),
    analysisRunId: text("analysis_run_id").references(() => analysisRuns.id, { onDelete: "set null" }),
    confidence: real("confidence"),
    policyReason: text("policy_reason"),
    createdAt: createdAt(),
  },
  (t) => [index("task_events_task_idx").on(t.taskId, t.createdAt), index("task_events_group_idx").on(t.groupId)],
);

/** Labelled review decisions: the trial evaluation set. */
export const evalExamples = pgTable("eval_examples", {
  id: text("id").primaryKey(),
  reviewItemId: text("review_item_id").references(() => reviewItems.id, { onDelete: "set null" }),
  reviewType: text("review_type").notNull(),
  decision: text("decision", { enum: ["accepted", "rejected"] }).notNull(),
  action: jsonb("action").notNull(),
  finalAction: jsonb("final_action"),
  edits: jsonb("edits"),
  reason: text("reason").notNull(),
  confidence: real("confidence"),
  chatId: text("chat_id"),
  analysisRunId: text("analysis_run_id"),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------------------
// Owner, devices, push
// ---------------------------------------------------------------------------

export const owner = pgTable(
  "owner",
  {
    id: integer("id").primaryKey().default(1),
    passwordHash: text("password_hash").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("owner_single_row", sql`${t.id} = 1`)],
);

export const ownerSessions = pgTable("owner_sessions", {
  /** sha256 of the session token. */
  tokenHash: text("token_hash").primaryKey(),
  createdAt: createdAt(),
  expiresAt: ts("expires_at").notNull(),
  lastSeenAt: ts("last_seen_at"),
});

export const pairingCodes = pgTable("pairing_codes", {
  /** sha256 of the one-time code. */
  codeHash: text("code_hash").primaryKey(),
  createdAt: createdAt(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  deviceId: text("device_id"),
});

export const devices = pgTable(
  "devices",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    /** sha256 of the bearer token. */
    tokenHash: text("token_hash").notNull(),
    createdAt: createdAt(),
    lastSeenAt: ts("last_seen_at"),
    revokedAt: ts("revoked_at"),
  },
  (t) => [uniqueIndex("devices_token_hash_uq").on(t.tokenHash)],
);

export const pushEndpoints = pgTable(
  "push_endpoints",
  {
    id: text("id").primaryKey(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    endpoint: text("endpoint").notNull(),
    p256dh: text("p256dh").notNull(),
    auth: text("auth").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    lastSuccessAt: ts("last_success_at"),
    lastFailureAt: ts("last_failure_at"),
    failureCount: integer("failure_count").notNull().default(0),
  },
  (t) => [uniqueIndex("push_endpoints_device_uq").on(t.deviceId)],
);

/** Durable notifications shared by push and the device polling fallback. */
export const notificationEvents = pgTable("notification_events", {
  id: text("id").primaryKey(),
  dedupKey: text("dedup_key").notNull().unique(),
  payload: jsonb("payload").notNull(),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
  reviewItemId: text("review_item_id").references(() => reviewItems.id, { onDelete: "cascade" }),
  createdAt: createdAt(),
  expiresAt: ts("expires_at").notNull(),
});

export const notificationDeliveries = pgTable("notification_deliveries", {
  eventId: text("event_id").notNull().references(() => notificationEvents.id, { onDelete: "cascade" }),
  deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
  pushedAt: ts("pushed_at"),
  acknowledgedAt: ts("acknowledged_at"),
  attempts: integer("attempts").notNull().default(0),
  nextAttemptAt: ts("next_attempt_at").notNull().defaultNow(),
}, (t) => [primaryKey({ columns: [t.eventId, t.deviceId] }), index("notification_delivery_pending_idx").on(t.nextAttemptAt)]);

// ---------------------------------------------------------------------------
// Settings, idempotency, audit, sync
// ---------------------------------------------------------------------------

export const settings = pgTable(
  "settings",
  {
    id: integer("id").primaryKey().default(1),
    timezone: text("timezone").notNull().default("UTC"),
    endOfWorkDay: text("end_of_work_day").notNull().default("17:00"),
    dailySummaryTime: text("daily_summary_time").default("08:00"),
    remindersEnabled: boolean("reminders_enabled").notNull().default(true),
    reminderLeadMinutes: integer("reminder_lead_minutes").notNull().default(60),
    trialStartedAt: ts("trial_started_at").notNull().defaultNow(),
    trialDays: integer("trial_days").notNull().default(7),
    autoCreateThreshold: real("auto_create_threshold").notNull().default(0.85),
    /** Sync cursors at or below this version must take a full snapshot (after a wipe). */
    syncResetVersion: bigint("sync_reset_version", { mode: "number" }).notNull().default(0),
    updatedAt: updatedAt(),
    syncVersion: syncVersion(),
  },
  (t) => [check("settings_single_row", sql`${t.id} = 1`)],
);

export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    /** sha256 of principal + method + path + Idempotency-Key. */
    scopeHash: text("scope_hash").primaryKey(),
    requestHash: text("request_hash").notNull(),
    state: text("state", { enum: ["in_progress", "completed"] }).notNull(),
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: createdAt(),
  },
  (t) => [index("idempotency_keys_created_idx").on(t.createdAt)],
);

export const auditEvents = pgTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    at: ts("at").notNull().defaultNow(),
    /** "owner", "device:<id>", "ai", or "system". */
    actor: text("actor").notNull(),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    /** Never contains message content or secrets. */
    details: jsonb("details"),
  },
  (t) => [index("audit_events_at_idx").on(t.at)],
);

export const syncTombstones = pgTable(
  "sync_tombstones",
  {
    entity: text("entity", { enum: ["tasks", "reviewItems", "contexts", "chats", "people"] }).notNull(),
    entityId: text("entity_id").notNull(),
    syncVersion: syncVersion(),
    deletedAt: ts("deleted_at").notNull().defaultNow(),
  },
  (t) => [index("sync_tombstones_version_idx").on(t.syncVersion)],
);

export const workerHeartbeats = pgTable("worker_heartbeats", {
  id: text("id").primaryKey(),
  seenAt: ts("seen_at").notNull().defaultNow(),
  startedAt: ts("started_at").notNull().defaultNow(),
});
