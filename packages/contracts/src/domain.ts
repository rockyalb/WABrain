/**
 * Shared domain contract. This file is the interface between the API, worker,
 * agent, rules, and (via the OpenAPI export) the Android client. Change it
 * deliberately: every consumer depends on these shapes. See docs/SPEC.md.
 */
import { z } from "zod";

const Id = z.string().min(1);
const IsoDateTime = z.iso.datetime({ offset: true });

// ---------------------------------------------------------------------------
// Contexts and settings
// ---------------------------------------------------------------------------

export const ContextSchema = z.object({
  id: Id,
  name: z.string().min(1).max(40),
  /** Hex color such as "#3B82F6", used by the app and widget. */
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable(),
  sortOrder: z.number().int(),
});

/** "HH:mm" in 24-hour time. */
export const LocalTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const SettingsSchema = z.object({
  /** IANA timezone, e.g. "Europe/London". */
  timezone: z.string().min(1),
  /** Due time used when a due date has no explicit time. Default "17:00". */
  endOfWorkDay: LocalTimeSchema,
  /** Daily summary notification time, or null when disabled. */
  dailySummaryTime: LocalTimeSchema.nullable(),
  remindersEnabled: z.boolean(),
  /** Minutes before dueAt to send a reminder. */
  reminderLeadMinutes: z.number().int().min(0).max(10080),
  /** When the trial period started; during the trial every create goes to Review. */
  trialStartedAt: IsoDateTime,
  trialDays: z.number().int().min(0).max(90),
  /**
   * The automatic-change threshold: the minimum model confidence for any change the AI applies without
   * Review. It gates creates (after the trial, and never below the calibrated threshold for the active
   * model/prompt profile) and also completions, cancellations and reschedules backed by the owner's own
   * messages. The field keeps its historical name.
   */
  autoCreateThreshold: z.number().min(0).max(1),
});

/**
 * Why creates are or are not applied automatically right now (docs/SPEC.md, "Trial period").
 * trial: every create goes to Review. calibrating: the trial is over, but the analysis profile in use
 * (provider, model and prompt version of the latest analysis) does not yet have enough owner Review
 * decisions for a usable threshold, so creates still go to Review. active: creates at or above
 * effectiveThreshold are applied, unless the chat has auto-create off or the model flags ambiguity.
 * Completions, cancellations and reschedules are not gated by the trial or calibration.
 */
export const AutoCreateStatusSchema = z.object({
  state: z.enum(["trial", "calibrating", "active"]),
  /** Null before the first successful analysis. */
  profile: z.object({ provider: z.string(), model: z.string(), promptVersion: z.string() }).nullable(),
  calibration: z.object({
    ready: z.boolean(),
    reason: z.enum(["insufficient_labels", "no_reliable_threshold"]).nullable(),
    /** Calibrated floor for this profile; null until ready. */
    threshold: z.number().min(0).max(1).nullable(),
    /** max(calibrated floor, autoCreateThreshold); per-chat overrides can only raise it. Null until ready. */
    effectiveThreshold: z.number().min(0).max(1).nullable(),
    /** Unambiguous create proposals of this profile that the owner accepted or rejected. */
    decisions: z.number().int().min(0),
    accepted: z.number().int().min(0),
    rejected: z.number().int().min(0),
    calibratedAt: IsoDateTime.nullable(),
  }),
  required: z.object({
    decisions: z.number().int(),
    accepted: z.number().int(),
    rejected: z.number().int(),
    uneditedAcceptedAtThreshold: z.number().int(),
    /** Minimum share of decisions at or above the threshold that were accepted. */
    precision: z.number().min(0).max(1),
  }),
});

// ---------------------------------------------------------------------------
// Chats and people
// ---------------------------------------------------------------------------

/**
 * off: not stored at all (only the chat id is kept to recognize it).
 * on: every message is analyzed.
 * mentions_only: stored as context; analyzed only when the owner is mentioned
 * or an alias appears as a word. Default for groups.
 */
export const ChatModeSchema = z.enum(["off", "on", "mentions_only"]);

export const ChatSchema = z.object({
  id: Id,
  /** WhatsApp JID. */
  jid: z.string().min(1),
  name: z.string().nullable(),
  isGroup: z.boolean(),
  mode: ChatModeSchema,
  defaultContextId: Id.nullable(),
  /** False while the default context is only a suggestion awaiting owner confirmation. */
  contextConfirmed: z.boolean(),
  autoCreate: z.boolean(),
  /**
   * Per-chat override of Settings.autoCreateThreshold, the automatic-change threshold (creates and
   * owner-evidenced completions, cancellations and reschedules). It cannot lower a create below the
   * calibrated threshold.
   */
  minimumAutoConfidence: z.number().min(0).max(1).nullable(),
  aliases: z.array(z.string()),
  /** Person for direct chats; null for groups. */
  personId: Id.nullable(),
  lastMessageAt: IsoDateTime.nullable(),
});

export const PersonFactKeySchema = z.enum([
  "name",
  "company",
  "role",
  "relationship",
  "language",
  "topic",
  "location",
  "other",
]);

export const PersonFactSchema = z.object({
  id: Id,
  key: PersonFactKeySchema,
  value: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
  /** True when the owner confirmed it or it was corroborated. */
  verified: z.boolean(),
  /** True when the person asserted this about themselves. Stays unverified until corroborated. */
  selfClaimed: z.boolean(),
  source: z.enum(["ai", "owner"]),
  sourceMessageIds: z.array(Id),
  updatedAt: IsoDateTime,
});

export const PersonSchema = z.object({
  id: Id,
  displayName: z.string().min(1),
  jids: z.array(z.string()),
  /** Usual languages, most frequent first, e.g. ["en", "es"]. */
  languages: z.array(z.string()),
  defaultContextId: Id.nullable(),
  facts: z.array(PersonFactSchema),
  updatedAt: IsoDateTime,
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/** todo: the owner must act. waiting_on: the owner asked someone else for something. */
export const TaskKindSchema = z.enum(["todo", "waiting_on"]);
export const TaskStatusSchema = z.enum(["open", "done", "cancelled"]);
export const TaskOriginSchema = z.enum(["ai", "manual", "import"]);

export const TaskSchema = z.object({
  id: Id,
  kind: TaskKindSchema,
  status: TaskStatusSchema,
  title: z.string().min(1).max(180),
  description: z.string().max(4000),
  /** Absolute instant. For date-only dues this is endOfWorkDay in the configured timezone. */
  dueAt: IsoDateTime.nullable(),
  /** False when the due was date-only and dueAt was filled with endOfWorkDay. */
  dueHasTime: z.boolean(),
  contextId: Id.nullable(),
  chatId: Id.nullable(),
  personId: Id.nullable(),
  origin: TaskOriginSchema,
  /** Language the title is written in, e.g. "en". */
  language: z.string().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
  evidenceMessageIds: z.array(Id),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  closedAt: IsoDateTime.nullable(),
});

export const TaskEventTypeSchema = z.enum([
  "created",
  "edited",
  "completed",
  "reopened",
  "cancelled",
  "rescheduled",
  "merged",
  "undone",
]);

export const TaskEventSchema = z.object({
  id: Id,
  taskId: Id,
  type: TaskEventTypeSchema,
  actor: z.enum(["ai", "owner", "system"]),
  evidenceMessageIds: z.array(Id),
  /** Partial task snapshots of the changed fields. */
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
  /** Null when the event cannot be undone. */
  undoableUntil: IsoDateTime.nullable(),
  undoneAt: IsoDateTime.nullable(),
  /** Events sharing a groupId (e.g. a merge) are undone together. */
  groupId: Id.nullable().default(null),
  createdAt: IsoDateTime,
});

// ---------------------------------------------------------------------------
// Agent task actions (model output after validation)
// ---------------------------------------------------------------------------

const ActionBase = {
  confidence: z.number().min(0).max(1),
  ambiguityReasons: z.array(z.string()),
  evidenceMessageIds: z.array(Id).min(1),
};

/**
 * create only: the same new messages that ask for the task already show it done or no longer needed
 * (a request and its "here you go" in one burst). The create always goes to Review with a handled hint.
 */
export const CreateAlreadyHandledSchema = z.object({
  status: z.enum(["done", "cancelled"]),
  evidenceMessageIds: z.array(Id).min(1),
});

export const CreateTaskActionSchema = z.object({
  type: z.literal("create"),
  kind: TaskKindSchema,
  title: z.string().min(3).max(180),
  description: z.string().max(4000),
  /** Model-provided due expression resolved by the agent into dueAt/dueHasTime. */
  dueAt: IsoDateTime.nullable(),
  dueHasTime: z.boolean(),
  /** Context override; null means inherit the chat default. */
  contextId: Id.nullable(),
  language: z.string().nullable(),
  alreadyHandled: CreateAlreadyHandledSchema.optional(),
  ...ActionBase,
});

export const CompleteTaskActionSchema = z.object({
  type: z.literal("complete"),
  taskId: Id,
  ...ActionBase,
});

export const CancelTaskActionSchema = z.object({
  type: z.literal("cancel"),
  taskId: Id,
  ...ActionBase,
});

export const RescheduleTaskActionSchema = z.object({
  type: z.literal("reschedule"),
  taskId: Id,
  dueAt: IsoDateTime,
  dueHasTime: z.boolean(),
  ...ActionBase,
});

export const MergeTasksActionSchema = z.object({
  type: z.literal("merge"),
  /** The first id survives; the rest are merged into it. */
  taskIds: z.array(Id).min(2),
  ...ActionBase,
});

export const TaskActionSchema = z.discriminatedUnion("type", [
  CreateTaskActionSchema,
  CompleteTaskActionSchema,
  CancelTaskActionSchema,
  RescheduleTaskActionSchema,
  MergeTasksActionSchema,
]);

/**
 * Result of the deterministic action policy (packages/rules). The policy, not
 * the model, decides whether evidence came from the owner by looking up the
 * evidence messages' direction.
 */
export const PolicyDecisionSchema = z.object({
  outcome: z.enum(["apply", "review", "drop"]),
  reason: z.enum([
    "auto_create",
    "trial_period",
    "calibration_required",
    "auto_create_disabled",
    "below_threshold",
    "ambiguous",
    "owner_evidence",
    "non_owner_evidence",
    "merge_requires_review",
    "unknown_task",
    "task_not_open",
    "chat_not_analyzed",
    "history_import",
    "conflicting_actions",
    "pending_create",
    "already_handled",
  ]),
});

// ---------------------------------------------------------------------------
// Review inbox
// ---------------------------------------------------------------------------

export const ReviewItemTypeSchema = z.enum([
  "create",
  "possibly_done",
  "possibly_cancelled",
  "reschedule",
  "merge",
]);

/**
 * A message after the request suggests a pending create was already dealt with (done or no longer needed)
 * before the owner reviewed it: a later burst, or the same burst as the request (CreateAlreadyHandled).
 * Set by analysis; the owner decides (accept as open, accept as done/cancelled, reject).
 */
export const ReviewHandledHintSchema = z.object({
  status: z.enum(["done", "cancelled"]),
  evidenceMessageIds: z.array(Id),
  confidence: z.number().min(0).max(1),
  /** Short quote of the first evidence message, for the Review card. */
  excerpt: z.string().max(300),
  fromOwner: z.boolean(),
  at: IsoDateTime,
});

export const ReviewItemSchema = z.object({
  id: Id,
  type: ReviewItemTypeSchema,
  state: z.enum(["pending", "accepted", "rejected"]),
  /** Existing task affected (null for create). */
  taskId: Id.nullable(),
  action: TaskActionSchema,
  reason: PolicyDecisionSchema.shape.reason,
  chatId: Id.nullable(),
  personId: Id.nullable(),
  /** Short, owner-facing summary. Never shown on the lock screen. */
  summary: z.string().max(300),
  /** create only: a later message suggests it was already handled. */
  handled: ReviewHandledHintSchema.nullable(),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});

// ---------------------------------------------------------------------------
// Messages as exposed to the app (evidence and conversation view)
// ---------------------------------------------------------------------------

export const MessageViewSchema = z.object({
  id: Id,
  chatId: Id,
  senderName: z.string().nullable(),
  fromOwner: z.boolean(),
  body: z.string(),
  kind: z.string(),
  /** OCR / image description / transcript when available. */
  derivedText: z.string().nullable(),
  language: z.string().nullable(),
  quotedMessageId: Id.nullable().default(null),
  at: IsoDateTime,
});

// ---------------------------------------------------------------------------
// Ask your chats (phase 3)
// ---------------------------------------------------------------------------

export const AskRequestSchema = z.object({
  question: z.string().min(1).max(1000),
  personId: Id.nullable().default(null),
  contextId: Id.nullable().default(null),
  from: IsoDateTime.nullable().default(null),
  to: IsoDateTime.nullable().default(null),
});

export const AskCitationSchema = z.object({
  messageId: Id,
  chatId: Id,
  excerpt: z.string(),
  at: IsoDateTime,
});

export const AskResponseSchema = z.object({
  found: z.boolean(),
  answer: z.string(),
  citations: z.array(AskCitationSchema),
  /** Optional task the owner can tap to create. Never applied automatically. */
  suggestedAction: CreateTaskActionSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type Context = z.infer<typeof ContextSchema>;
export type Settings = z.infer<typeof SettingsSchema>;
export type AutoCreateStatus = z.infer<typeof AutoCreateStatusSchema>;
export type ChatMode = z.infer<typeof ChatModeSchema>;
export type Chat = z.infer<typeof ChatSchema>;
export type PersonFactKey = z.infer<typeof PersonFactKeySchema>;
export type PersonFact = z.infer<typeof PersonFactSchema>;
export type Person = z.infer<typeof PersonSchema>;
export type TaskKind = z.infer<typeof TaskKindSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type TaskEvent = z.infer<typeof TaskEventSchema>;
export type TaskAction = z.infer<typeof TaskActionSchema>;
export type CreateTaskAction = z.infer<typeof CreateTaskActionSchema>;
export type PolicyDecision = z.infer<typeof PolicyDecisionSchema>;
export type ReviewItemType = z.infer<typeof ReviewItemTypeSchema>;
export type ReviewItem = z.infer<typeof ReviewItemSchema>;
export type ReviewHandledHint = z.infer<typeof ReviewHandledHintSchema>;
export type MessageView = z.infer<typeof MessageViewSchema>;
export type AskRequest = z.infer<typeof AskRequestSchema>;
export type AskResponse = z.infer<typeof AskResponseSchema>;

// ---------------------------------------------------------------------------
// Durable notifications (push payloads and the device fallback list)
// ---------------------------------------------------------------------------

/**
 * A durable notification as pushed and as listed by GET /v1/notifications. `notificationId` is the
 * event id: the device shows each id at most once, whichever transport delivered it.
 */
export const NotificationPayloadSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("review"),
    notificationId: Id,
    reviewItemId: Id,
    reviewType: ReviewItemTypeSchema,
    title: z.string(),
  }),
  z.object({ type: z.literal("reminder"), notificationId: Id, taskId: Id, title: z.string(), dueAt: IsoDateTime }),
  z.object({
    type: z.literal("summary"),
    notificationId: Id,
    open: z.number().int(),
    dueToday: z.number().int(),
    overdue: z.number().int(),
    review: z.number().int(),
  }),
]);
export const NotificationEventSchema = z.object({ id: Id, createdAt: IsoDateTime, payload: NotificationPayloadSchema });
/** The device's unacknowledged, still-relevant notifications, oldest first (at most 100). */
export const NotificationsResponseSchema = z.object({ items: z.array(NotificationEventSchema) });
/** Ids the device has handled (shown or deliberately skipped); unknown ids are ignored. */
export const NotificationAckSchema = z.object({ ids: z.array(Id).max(100) });
