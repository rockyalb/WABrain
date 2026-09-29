import type { Chat, Context, NormalizedMessage, Person, Settings, TaskKind } from "@wabrain/contracts";
import { detectLanguage } from "./language.js";
import { WEEKDAYS_EN, addDays, lastDayOfMonth, toLocal, toZonedIso, weekdayOf } from "./time.js";

/**
 * Working memory: the bounded, rebuilt-per-run context for one analysis (docs/MEMORY.md, layer 1).
 * Pure: no I/O, no model calls.
 */

export type DerivedKind = "image" | "ocr" | "transcript" | "document";

export interface MemoryMessageInput {
  id: string;
  /** Date, ISO string, or Unix seconds (as in NormalizedMessage.timestamp). */
  at: Date | string | number;
  fromOwner: boolean;
  senderName?: string | null;
  text: string;
  /** Message kind, e.g. "text", "image", "voice". */
  kind?: string;
  /** OCR, image description, transcript, or document text produced by a media job. */
  derivedText?: string | null;
  derivedKind?: DerivedKind | null;
  language?: string | null;
  quotedMessageId?: string | null;
}

export interface OpenTaskInput {
  id: string;
  kind: TaskKind;
  title: string;
  dueAt: string | null;
  dueHasTime: boolean;
}

export interface WorkingMemoryLimits {
  /** Preceding messages kept before the burst (most recent first). Default 30. */
  maxPreceding?: number;
  /** Characters kept per message text. Default 1500. */
  maxTextChars?: number;
  /** Characters kept per derived text. Default 2500. */
  maxDerivedChars?: number;
  /** Open tasks listed. Default 50. */
  maxOpenTasks?: number;
  /** Pending (not yet reviewed) creates listed. Default 20. */
  maxPendingTasks?: number;
}

export interface WorkingMemoryInput {
  now: Date;
  settings: Pick<Settings, "timezone" | "endOfWorkDay">;
  chat: Pick<Chat, "id" | "name" | "isGroup" | "defaultContextId">;
  /** Contexts a task may be assigned to (for per-task overrides). */
  contexts?: ReadonlyArray<Pick<Context, "id" | "name">>;
  /** The contact's profile for direct chats; null for groups or unknown people. */
  person?: Pick<Person, "displayName" | "languages" | "facts"> | null;
  ownerName?: string | null;
  /** The new messages that triggered this analysis. */
  burst: readonly MemoryMessageInput[];
  /** Messages before the burst, oldest or newest first (they are sorted). */
  preceding?: readonly MemoryMessageInput[];
  /** Messages quoted by the burst or preceding messages that fall outside the window. */
  quoted?: readonly MemoryMessageInput[];
  openTasks: readonly OpenTaskInput[];
  /**
   * Creates proposed earlier that still wait in the owner's Review (id = review item id). Listed so the
   * model neither proposes them again nor misses a later message saying they were already handled.
   */
  pendingTasks?: readonly OpenTaskInput[];
  limits?: WorkingMemoryLimits;
}

export interface MemoryMessage {
  id: string;
  /** Local "YYYY-MM-DD HH:mm" in the configured timezone. */
  time: string;
  from: "owner" | "contact";
  sender: string;
  /** True for messages in the new burst. Actions must cite at least one of them. */
  isNew: boolean;
  text: string;
  /** Text derived from media by a model. Clearly separate from what the sender typed. */
  derived: { type: DerivedKind; text: string } | null;
  language: string | null;
  replyTo: string | null;
}

export interface MemoryTask {
  id: string;
  kind: TaskKind;
  title: string;
  /** Local "YYYY-MM-DD HH:mm", "YYYY-MM-DD" for date-only dues, or null. */
  due: string | null;
}

export interface WorkingMemory {
  now: {
    instant: string;
    localDate: string;
    localTime: string;
    weekday: string;
    timezone: string;
    endOfWorkDay: string;
  };
  calendar: {
    today: string;
    tomorrow: string;
    dayAfterTomorrow: string;
    nextMonday: string;
    endOfMonth: string;
    nextDays: Array<{ date: string; weekday: string }>;
  };
  chat: { id: string; name: string | null; type: "direct" | "group"; defaultContext: { id: string; name: string } | null };
  owner: { name: string | null };
  contexts: Array<{ id: string; name: string }>;
  person: { name: string; languages: string[]; facts: Array<{ key: string; value: string; verified: boolean }> } | null;
  openTasks: MemoryTask[];
  /** Suggested tasks the owner has not reviewed yet (ids are review item ids). */
  pendingTasks: MemoryTask[];
  messages: MemoryMessage[];
  /** Quoted messages outside the window, for reference only. */
  quotedMessages: MemoryMessage[];
}

const DEFAULT_LIMITS: Required<WorkingMemoryLimits> = {
  maxPreceding: 30,
  maxTextChars: 1500,
  maxDerivedChars: 2500,
  maxOpenTasks: 50,
  maxPendingTasks: 20,
};

export function toDate(at: Date | string | number): Date {
  if (at instanceof Date) return at;
  if (typeof at === "number") return new Date(at < 1e12 ? at * 1000 : at);
  return new Date(at);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\u0000/g, "").trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}… [truncated]`;
}

const weekdayLabel = (weekday: number): string => WEEKDAYS_EN[weekday] ?? "";

function toMemoryMessage(
  message: MemoryMessageInput,
  isNew: boolean,
  input: WorkingMemoryInput,
  limits: Required<WorkingMemoryLimits>,
): MemoryMessage {
  const local = toLocal(toDate(message.at), input.settings.timezone);
  const text = truncate(message.text ?? "", limits.maxTextChars);
  const derivedText = message.derivedText ? truncate(message.derivedText, limits.maxDerivedChars) : "";
  const fallbackSender = message.fromOwner ? (input.ownerName ?? "Owner") : (input.person?.displayName ?? "Contact");
  return {
    id: message.id,
    time: `${local.date} ${local.time}`,
    from: message.fromOwner ? "owner" : "contact",
    sender: message.senderName?.trim() || fallbackSender,
    isNew,
    text: text || (message.kind && message.kind !== "text" ? `[${message.kind}]` : ""),
    derived: derivedText ? { type: message.derivedKind ?? "document", text: derivedText } : null,
    language: message.language ?? detectLanguage(`${text} ${derivedText}`),
    replyTo: message.quotedMessageId ?? null,
  };
}

function formatDue(task: OpenTaskInput, timezone: string): string | null {
  if (!task.dueAt) return null;
  const local = toLocal(new Date(task.dueAt), timezone);
  return task.dueHasTime ? `${local.date} ${local.time}` : local.date;
}

function toMemoryTask(task: OpenTaskInput, timezone: string): MemoryTask {
  return { id: task.id, kind: task.kind, title: task.title, due: formatDue(task, timezone) };
}

export function buildWorkingMemory(input: WorkingMemoryInput): WorkingMemory {
  const limits = { ...DEFAULT_LIMITS, ...input.limits };
  const tz = input.settings.timezone;
  const nowLocal = toLocal(input.now, tz);
  const today = nowLocal.date;

  const daysUntilMonday = ((8 - weekdayOf(today)) % 7) || 7;
  const nextDays = Array.from({ length: 7 }, (_, index) => {
    const date = addDays(today, index + 1);
    return { date, weekday: weekdayLabel(weekdayOf(date)) };
  });

  const byTime = (a: MemoryMessageInput, b: MemoryMessageInput) => toDate(a.at).getTime() - toDate(b.at).getTime();
  const burstIds = new Set(input.burst.map((message) => message.id));
  const preceding = [...(input.preceding ?? [])]
    .filter((message) => !burstIds.has(message.id))
    .sort(byTime)
    .slice(-limits.maxPreceding);
  const burst = [...input.burst].sort(byTime);
  const windowIds = new Set([...preceding, ...burst].map((message) => message.id));
  const quoted = [...(input.quoted ?? [])].filter((message) => !windowIds.has(message.id)).sort(byTime);

  const contexts = (input.contexts ?? []).map((context) => ({ id: context.id, name: context.name }));
  const defaultContext = contexts.find((context) => context.id === input.chat.defaultContextId) ?? null;

  return {
    now: {
      instant: toZonedIso(input.now, tz),
      localDate: today,
      localTime: nowLocal.time,
      weekday: weekdayLabel(nowLocal.weekday),
      timezone: tz,
      endOfWorkDay: input.settings.endOfWorkDay,
    },
    calendar: {
      today,
      tomorrow: addDays(today, 1),
      dayAfterTomorrow: addDays(today, 2),
      nextMonday: addDays(today, daysUntilMonday),
      endOfMonth: lastDayOfMonth(today),
      nextDays,
    },
    chat: {
      id: input.chat.id,
      name: input.chat.name,
      type: input.chat.isGroup ? "group" : "direct",
      defaultContext,
    },
    owner: { name: input.ownerName ?? null },
    contexts,
    person: input.person
      ? {
          name: input.person.displayName,
          languages: [...input.person.languages],
          facts: input.person.facts.map((fact) => ({ key: fact.key, value: fact.value, verified: fact.verified })),
        }
      : null,
    openTasks: input.openTasks.slice(0, limits.maxOpenTasks).map((task) => toMemoryTask(task, tz)),
    pendingTasks: (input.pendingTasks ?? []).slice(0, limits.maxPendingTasks).map((task) => toMemoryTask(task, tz)),
    messages: [
      ...preceding.map((message) => toMemoryMessage(message, false, input, limits)),
      ...burst.map((message) => toMemoryMessage(message, true, input, limits)),
    ],
    quotedMessages: quoted.map((message) => toMemoryMessage(message, false, input, limits)),
  };
}

/** Ids the model may cite, split by where they appear. Used to validate model output. */
export function citableIds(memory: WorkingMemory) {
  return {
    all: new Set([...memory.messages, ...memory.quotedMessages].map((message) => message.id)),
    burst: new Set(memory.messages.filter((message) => message.isNew).map((message) => message.id)),
    openTasks: new Set(memory.openTasks.map((task) => task.id)),
    pendingTasks: new Set(memory.pendingTasks.map((task) => task.id)),
    contexts: new Set(memory.contexts.map((context) => context.id)),
  };
}

/** JSON for embedding in a prompt: "<" is escaped so message text can never close a delimiter tag. */
export function promptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

/** Adapts a stored NormalizedMessage (Unix-seconds timestamp, direction) to the working-memory input. */
export function fromNormalizedMessage(
  message: Pick<NormalizedMessage, "id" | "timestamp" | "direction" | "senderName" | "body" | "kind" | "derivedText" | "language" | "quotedMessageId">,
  derivedKind: DerivedKind | null = null,
): MemoryMessageInput {
  return {
    id: message.id,
    at: message.timestamp,
    fromOwner: message.direction === "outgoing",
    senderName: message.senderName ?? null,
    text: message.body,
    kind: message.kind,
    derivedText: message.derivedText ?? null,
    derivedKind: message.derivedText ? (derivedKind ?? defaultDerivedKind(message.kind)) : null,
    language: message.language ?? null,
    quotedMessageId: message.quotedMessageId ?? null,
  };
}

function defaultDerivedKind(kind: string): DerivedKind {
  if (kind === "voice" || kind === "audio") return "transcript";
  if (kind === "image" || kind === "sticker") return "image";
  return "document";
}
