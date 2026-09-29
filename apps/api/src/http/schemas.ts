/**
 * Request/response schemas for the HTTP API (docs/API.md). Domain shapes come
 * from @wabrain/contracts; these wrap them for each endpoint and feed
 * the OpenAPI document.
 */
import { ProviderKindSchema } from "@wabrain/agent";
import { jobNames, type JobName } from "@wabrain/jobs";
import {
  AutoCreateStatusSchema,
  ChatModeSchema,
  ChatSchema,
  ContextSchema,
  LocalTimeSchema,
  MessageViewSchema,
  PersonFactKeySchema,
  PersonFactSchema,
  PersonSchema,
  ReviewItemSchema,
  SettingsSchema,
  TaskEventSchema,
  TaskKindSchema,
  TaskSchema,
  TaskStatusSchema,
} from "@wabrain/contracts";
import { z } from "zod";

const Id = z.string().min(1).max(200);
const IsoDateTime = z.iso.datetime({ offset: true });
/** An ISO instant, or a date-only "YYYY-MM-DD" resolved to end of work day. */
const DueInput = z.union([IsoDateTime, z.iso.date()]);

export const listOf = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: z.string().nullable() });

export const PageQuerySchema = z.object({
  cursor: z.string().max(500).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// Tasks --------------------------------------------------------------------

export const TaskListQuerySchema = PageQuerySchema.extend({
  status: TaskStatusSchema.optional(),
  kind: TaskKindSchema.optional(),
  contextId: Id.optional(),
  chatId: Id.optional(),
  personId: Id.optional(),
});

export const CreateTaskRequestSchema = z.object({
  id: z.uuid().optional(),
  kind: TaskKindSchema,
  title: z.string().trim().min(1).max(180),
  description: z.string().max(4000).optional(),
  dueAt: DueInput.nullable().optional(),
  dueHasTime: z.boolean().optional(),
  contextId: Id.nullable().optional(),
  chatId: Id.nullable().optional(),
  personId: Id.nullable().optional(),
});

export const UpdateTaskRequestSchema = z.object({
  title: z.string().trim().min(1).max(180).optional(),
  description: z.string().max(4000).optional(),
  dueAt: DueInput.nullable().optional(),
  dueHasTime: z.boolean().optional(),
  contextId: Id.nullable().optional(),
  kind: TaskKindSchema.optional(),
});

export const TaskDetailSchema = z.object({
  task: TaskSchema,
  events: z.array(TaskEventSchema),
  evidence: z.array(MessageViewSchema),
});

// Review -------------------------------------------------------------------

export const AcceptReviewRequestSchema = z.object({
  edits: z
    .object({
      title: z.string().trim().min(1).max(180).optional(),
      description: z.string().max(4000).optional(),
      dueAt: DueInput.nullable().optional(),
      dueHasTime: z.boolean().optional(),
      contextId: Id.nullable().optional(),
      kind: TaskKindSchema.optional(),
    })
    .optional(),
  /** Creates only: accept and close the new task at once (a later message says it was already handled). */
  closeAs: z.enum(["done", "cancelled"]).optional(),
});

export const AcceptReviewResponseSchema = z.object({ reviewItem: ReviewItemSchema, task: TaskSchema.nullable() });
export const RejectReviewResponseSchema = z.object({ reviewItem: ReviewItemSchema });

// Messages, chats, people ----------------------------------------------------

export const MessagesQuerySchema = z.object({
  around: Id.optional(),
  before: z.coerce.number().int().min(0).max(100).optional(),
  after: z.coerce.number().int().min(0).max(100).optional(),
});
export const MessagesResponseSchema = z.object({ items: z.array(MessageViewSchema) });

export const ChatListQuerySchema = PageQuerySchema.extend({
  q: z.string().max(100).optional(),
  mode: ChatModeSchema.optional(),
});

export const UpdateChatRequestSchema = z.object({
  mode: ChatModeSchema.optional(),
  defaultContextId: Id.nullable().optional(),
  contextConfirmed: z.boolean().optional(),
  autoCreate: z.boolean().optional(),
  minimumAutoConfidence: z.number().min(0).max(1).nullable().optional(),
  aliases: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
});

export const PeopleQuerySchema = PageQuerySchema.extend({ q: z.string().max(100).optional() });

export const UpdatePersonRequestSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  defaultContextId: Id.nullable().optional(),
});

export const CreateFactRequestSchema = z.object({
  key: PersonFactKeySchema,
  value: z.string().trim().min(1).max(500),
});

export const UpdateFactRequestSchema = z.object({
  value: z.string().trim().min(1).max(500).optional(),
  verified: z.boolean().optional(),
});

// Contexts and settings ------------------------------------------------------

const Color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const CreateContextRequestSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: Color.nullable().optional(),
});

export const UpdateContextRequestSchema = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  color: Color.nullable().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

export const DeleteContextQuerySchema = z.object({ reassignTo: Id.optional() });

export const UpdateSettingsRequestSchema = z.object({
  timezone: z.string().min(1).max(64).optional(),
  endOfWorkDay: LocalTimeSchema.optional(),
  dailySummaryTime: LocalTimeSchema.nullable().optional(),
  remindersEnabled: z.boolean().optional(),
  reminderLeadMinutes: z.number().int().min(0).max(10080).optional(),
});

export const UpdatePolicyRequestSchema = z.object({
  trialDays: z.number().int().min(0).max(90).optional(),
  autoCreateThreshold: z.number().min(0).max(1).optional(),
});

// Sync -----------------------------------------------------------------------

export const SyncQuerySchema = z.object({ since: z.string().max(200).optional() });

export const SyncResponseSchema = z.object({
  cursor: z.string(),
  full: z.boolean(),
  tasks: z.array(TaskSchema),
  reviewItems: z.array(ReviewItemSchema),
  contexts: z.array(ContextSchema),
  chats: z.array(ChatSchema),
  people: z.array(PersonSchema),
  settings: SettingsSchema,
  deleted: z.object({
    tasks: z.array(Id),
    reviewItems: z.array(Id),
    contexts: z.array(Id),
    chats: z.array(Id),
    people: z.array(Id),
  }),
});

// Devices and push -------------------------------------------------------------

export const PairRequestSchema = z.object({
  code: z.string().min(32).max(200),
  deviceName: z.string().trim().min(1).max(80),
});
export const PairResponseSchema = z.object({ deviceId: z.string(), token: z.string() });

const Base64Url = z.string().regex(/^[A-Za-z0-9_-]+={0,2}$/);
export const PushEndpointRequestSchema = z.object({
  endpoint: z.url().max(2000),
  /** Uncompressed P-256 public key (65 bytes), base64url. */
  p256dh: Base64Url.min(86).max(90),
  /** 16-byte auth secret, base64url. */
  auth: Base64Url.min(21).max(24),
});

// Setup ------------------------------------------------------------------------

export const PasswordRequestSchema = z.object({ password: z.string().min(1).max(1024) });
export const BootstrapRequestSchema = z.object({ password: z.string().min(12).max(1024) });
export const PairingCodeResponseSchema = z.object({ qrPayload: z.string(), expiresAt: IsoDateTime });
export const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdAt: IsoDateTime,
  lastSeenAt: IsoDateTime.nullable(),
});
export const DeviceListSchema = z.object({ items: z.array(DeviceSchema) });

export const SetupStatusSchema = z.object({
  database: z.object({ ok: z.boolean() }),
  worker: z.object({ ok: z.boolean(), lastSeenAt: IsoDateTime.nullable() }),
  openwa: z.object({ configured: z.boolean() }),
  providers: z.object({ configured: z.array(z.string()) }),
  trial: z.object({ active: z.boolean(), startedAt: IsoDateTime, endsAt: IsoDateTime, days: z.number().int() }),
  /** Why creates are (not) automatic: the trial, calibration of the current model/prompt, or active. */
  autoCreate: AutoCreateStatusSchema,
  devices: z.object({ count: z.number().int() }),
});

/** GET /v1/settings: the settings plus the read-only auto-create status. */
export const SettingsResponseSchema = SettingsSchema.extend({ autoCreate: AutoCreateStatusSchema });

// Model providers (setup) ------------------------------------------------------------

export const PROVIDER_ROLE_NAMES = ["text", "vision", "transcription", "embedding"] as const;
type RoleName = (typeof PROVIDER_ROLE_NAMES)[number];
export const ProviderRoleSchema = z.enum(PROVIDER_ROLE_NAMES);

const perRole = <T extends z.ZodType>(schema: T) =>
  Object.fromEntries(PROVIDER_ROLE_NAMES.map((role) => [role, schema])) as { [R in RoleName]: T };

const DailyLimit = z.number().int().min(0).max(1_000_000_000).nullable().optional();

export const ProviderRoleInputSchema = z.object({
  provider: ProviderKindSchema,
  model: z.string().trim().min(1).max(200),
  /** Required for openai-compatible (Ollama, OpenRouter...); an optional proxy URL otherwise. */
  baseUrl: z.url({ protocol: /^https?$/ }).max(2000).nullable().optional(),
  /** Write-only. Omitted keeps the stored key, null clears it, a string replaces it. */
  apiKey: z.string().trim().min(1).max(4096).nullable().optional(),
  /** Embedding only: requested vector size (at most 2000 for pgvector's HNSW index). */
  dimensions: z.number().int().positive().max(2000).nullable().optional(),
  /** openai-compatible only: whether the endpoint supports JSON-schema structured outputs. */
  structuredOutputs: z.boolean().nullable().optional(),
  dailyTokenLimit: DailyLimit,
  dailyCallLimit: DailyLimit,
});

/**
 * Per role: settings to store, null to remove them (the role falls back to the environment), or
 * omitted to leave the role alone.
 */
export const UpdateProvidersRequestSchema = z
  .object(perRole(ProviderRoleInputSchema.nullable().optional()))
  .strict()
  .superRefine((body, ctx) => {
    for (const role of PROVIDER_ROLE_NAMES) {
      const entry = body[role];
      if (!entry) continue;
      if (entry.provider === "openai-compatible" && !entry.baseUrl) {
        ctx.addIssue({ code: "custom", path: [role, "baseUrl"], message: "openai-compatible providers need a baseUrl" });
      }
      if ((role === "transcription" || role === "embedding") && entry.provider === "anthropic") {
        ctx.addIssue({ code: "custom", path: [role, "provider"], message: `Anthropic has no ${role} models; use openai or openai-compatible` });
      }
      if (role !== "embedding" && entry.dimensions != null) {
        ctx.addIssue({ code: "custom", path: [role, "dimensions"], message: "only applies to the embedding role" });
      }
    }
  });

export const ProviderRoleViewSchema = z.object({
  /** "db": saved on the setup page; "env": from the AI_<ROLE>_* variables. */
  source: z.enum(["db", "env"]),
  provider: z.string(),
  model: z.string(),
  baseUrl: z.string().nullable(),
  /** Whether an API key is in use. The key itself is never returned. */
  hasApiKey: z.boolean(),
  apiKeySource: z.enum(["db", "env"]).nullable(),
  dimensions: z.number().int().nullable(),
  structuredOutputs: z.boolean().nullable(),
  /** Effective limits: the saved value, else AI_<ROLE>_DAILY_*_LIMIT, else null (no limit). */
  dailyTokenLimit: z.number().int().nullable(),
  dailyCallLimit: z.number().int().nullable(),
  /** Only the saved values; null inherits the environment's limit (send null back to keep inheriting). */
  storedDailyTokenLimit: z.number().int().nullable(),
  storedDailyCallLimit: z.number().int().nullable(),
});

export const ProvidersResponseSchema = z.object({
  /** Null for a role that is not configured (vision then reuses text). */
  providers: z.object(perRole(ProviderRoleViewSchema.nullable())),
  /** Whether APP_ENCRYPTION_KEY is set, i.e. whether API keys can be saved. */
  encryptionConfigured: z.boolean(),
  /** Why the worker cannot use the current configuration, or null. */
  error: z.string().nullable(),
});

export const ProviderTestRequestSchema = z.object({ roles: z.array(ProviderRoleSchema).min(1).max(4).optional() });

export const ProviderTestResultSchema = z.object({
  ok: z.boolean(),
  provider: z.string(),
  model: z.string(),
  latencyMs: z.number().int(),
  /** Sanitized provider error; never contains API keys. */
  error: z.string().optional(),
});

export const ProviderTestResponseSchema = z.object({ results: z.object(perRole(ProviderTestResultSchema.optional())) });

// OpenWA connection (setup) ----------------------------------------------------------

const OpenWaProblemSchema = z.object({
  /** not_configured, no_session_id, unreachable, timeout, unauthorized, forbidden, invalid_session_id, session_not_found, rate_limited, openwa_error. */
  code: z.string(),
  message: z.string(),
});

export const OpenWaSessionSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  /** OpenWA's session state: created, initializing, qr_ready, authenticating, ready, disconnected, action_required, failed. */
  status: z.string(),
  phone: z.string().nullable(),
  pushName: z.string().nullable(),
  connectedAt: z.string().nullable(),
  lastActive: z.string().nullable(),
  engineLoaded: z.boolean().nullable(),
  lastError: z.string().nullable(),
  restriction: z.object({ kind: z.string(), code: z.string().nullable(), expiresAt: z.string().nullable() }).nullable(),
});

export const OpenWaStatusResponseSchema = z.object({
  /** Whether OPENWA_BASE_URL and OPENWA_READ_API_KEY are set. */
  configured: z.boolean(),
  sessionId: z.string().nullable(),
  reachable: z.boolean(),
  /** The session state is `ready`, i.e. WhatsApp is linked. */
  paired: z.boolean(),
  session: OpenWaSessionSchema.nullable(),
  /** Sessions the read key can see; only filled when OPENWA_SESSION_ID is not set. */
  sessions: z.array(z.object({ id: z.string(), name: z.string().nullable(), status: z.string() })),
  error: OpenWaProblemSchema.nullable(),
  /** The OpenWA dashboard's sessions page, where WhatsApp is paired; null when its address is unknown. */
  dashboardUrl: z.string().nullable(),
  /** The address OpenWA's webhook must point to. */
  webhookUrl: z.string(),
});

export const OpenWaCheckSchema = z.object({
  id: z.enum(["reachable", "session", "linked", "chats", "messages", "role", "session_scope"]),
  label: z.string(),
  /** False only for a failed check; a warning counts as passed. */
  ok: z.boolean(),
  level: z.enum(["ok", "warn", "error"]),
  detail: z.string(),
});

export const OpenWaTestResponseSchema = z.object({ ok: z.boolean(), checks: z.array(OpenWaCheckSchema) });

export const OpenWaQrResponseSchema = z.object({
  /**
   * Always "dashboard": OpenWA serves the QR code only to operator keys, which can also send
   * messages, so WABrain links to the OpenWA dashboard instead of proxying the code.
   */
  mode: z.literal("dashboard"),
  dashboardUrl: z.string().nullable(),
  sessionId: z.string().nullable(),
  sessionStatus: z.string().nullable(),
  paired: z.boolean(),
  message: z.string(),
});

export const WipeRequestSchema = z.object({ confirm: z.literal("DELETE EVERYTHING") });
export const OkSchema = z.object({ ok: z.boolean() });
export const WebhookAcceptedSchema = z.object({
  accepted: z.boolean(),
  duplicate: z.boolean().optional(),
  stored: z.boolean().optional(),
  ignored: z.boolean().optional(),
});

const JobNameSchema = z.enum(jobNames as [JobName, ...JobName[]]);

export const FailedJobsQuerySchema = z.object({
  queue: JobNameSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

/** Jobs that exhausted their retries. Payload text and exception messages are never included. */
export const FailedJobsResponseSchema = z.object({
  /** Waiting dead-letter entries per queue. */
  counts: z.record(z.string(), z.number().int()),
  /** The newest entries. */
  items: z.array(
    z.object({
      id: z.string(),
      queue: JobNameSchema,
      sourceJobId: z.string().nullable(),
      /** Payload ids: UUIDs only, anything else "[redacted]". */
      subject: z.record(z.string(), z.string()),
      attempts: z.number().int(),
      createdAt: z.string().nullable(),
      failedAt: z.string(),
      /** A fixed failure category. */
      reason: z.string(),
    }),
  ),
});

export const UsageQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).optional(),
});

/** Model usage per UTC day for the setup page, and OpenAI's billed costs when an admin key is set. */
export const UsageResponseSchema = z.object({
  since: z.string(),
  days: z.number().int(),
  /** Calls, tokens and audio seconds recorded by WABrain, per day, role and model. */
  usage: z.array(
    z.object({
      day: z.string(),
      role: z.enum(["text", "vision", "transcription", "embedding"]),
      provider: z.string().nullable(),
      model: z.string().nullable(),
      calls: z.number().int(),
      inputTokens: z.number().int(),
      outputTokens: z.number().int(),
      audioSeconds: z.number(),
    }),
  ),
  /** OpenAI's Costs API: "not_configured" without OPENAI_ADMIN_KEY. */
  costs: z.discriminatedUnion("status", [
    z.object({
      status: z.literal("ok"),
      /** Null when the costs cover the whole OpenAI organization. */
      projectId: z.string().nullable(),
      days: z.array(z.object({ day: z.string(), items: z.array(z.object({ lineItem: z.string(), usd: z.number() })) })),
    }),
    z.object({ status: z.literal("not_configured") }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]),
});

export { PersonFactSchema };
