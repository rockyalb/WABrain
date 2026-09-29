/** Row ⇄ contract mapping. Contract shapes live in @wabrain/contracts. */
import type {
  Chat,
  Context,
  MessageView,
  Person,
  PersonFact,
  ReviewHandledHint,
  ReviewItem,
  Settings,
  Task,
  TaskAction,
  TaskEvent,
} from "@wabrain/contracts";
import type {
  chats,
  contexts,
  messages,
  people,
  personFacts,
  reviewItems,
  settings,
  taskEvents,
  tasks,
} from "./schema.js";

export type ContextRow = typeof contexts.$inferSelect;
export type ChatRow = typeof chats.$inferSelect;
export type PersonRow = typeof people.$inferSelect;
export type PersonFactRow = typeof personFacts.$inferSelect;
export type TaskRow = typeof tasks.$inferSelect;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type ReviewItemRow = typeof reviewItems.$inferSelect;
export type MessageRow = typeof messages.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;

/** Accepts Date or the string drizzle returns from raw queries. */
export function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}
export function isoOrNull(value: Date | string | null | undefined): string | null {
  return value == null ? null : iso(value);
}

export function toContext(row: ContextRow): Context {
  return { id: row.id, name: row.name, color: row.color, sortOrder: row.sortOrder };
}

export function toSettings(row: SettingsRow): Settings {
  return {
    timezone: row.timezone,
    endOfWorkDay: row.endOfWorkDay,
    dailySummaryTime: row.dailySummaryTime,
    remindersEnabled: row.remindersEnabled,
    reminderLeadMinutes: row.reminderLeadMinutes,
    trialStartedAt: iso(row.trialStartedAt),
    trialDays: row.trialDays,
    autoCreateThreshold: row.autoCreateThreshold,
  };
}

export function toChat(row: ChatRow): Chat {
  return {
    id: row.id,
    jid: row.jid,
    name: row.name,
    isGroup: row.isGroup,
    mode: row.mode,
    defaultContextId: row.defaultContextId,
    contextConfirmed: row.contextConfirmed,
    autoCreate: row.autoCreate,
    minimumAutoConfidence: row.minimumAutoConfidence,
    aliases: row.aliases,
    personId: row.personId,
    lastMessageAt: isoOrNull(row.lastMessageAt),
  };
}

export function toPersonFact(row: PersonFactRow): PersonFact {
  return {
    id: row.id,
    key: row.key,
    value: row.value,
    confidence: row.confidence,
    verified: row.verified,
    selfClaimed: row.selfClaimed,
    source: row.source,
    sourceMessageIds: row.sourceMessageIds,
    updatedAt: iso(row.updatedAt),
  };
}

export function toPerson(row: PersonRow, facts: PersonFactRow[]): Person {
  return {
    id: row.id,
    displayName: row.displayName,
    jids: row.jids,
    languages: row.languages,
    defaultContextId: row.defaultContextId,
    facts: facts.map(toPersonFact),
    updatedAt: iso(row.updatedAt),
  };
}

export function toTask(row: TaskRow): Task {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    title: row.title,
    description: row.description,
    dueAt: isoOrNull(row.dueAt),
    dueHasTime: row.dueHasTime,
    contextId: row.contextId,
    chatId: row.chatId,
    personId: row.personId,
    origin: row.origin,
    language: row.language,
    confidence: row.confidence,
    evidenceMessageIds: row.evidenceMessageIds,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    closedAt: isoOrNull(row.closedAt),
  };
}

export function toTaskEvent(row: TaskEventRow): TaskEvent {
  return {
    id: row.id,
    taskId: row.taskId,
    type: row.type,
    actor: row.actor,
    evidenceMessageIds: row.evidenceMessageIds,
    before: row.before ?? null,
    after: row.after ?? null,
    undoableUntil: isoOrNull(row.undoableUntil),
    undoneAt: isoOrNull(row.undoneAt),
    groupId: row.groupId,
    createdAt: iso(row.createdAt),
  };
}

export function toReviewItem(row: ReviewItemRow): ReviewItem {
  return {
    id: row.id,
    type: row.type,
    state: row.state,
    taskId: row.taskId,
    action: row.action as TaskAction,
    reason: row.reason as ReviewItem["reason"],
    chatId: row.chatId,
    personId: row.personId,
    summary: row.summary,
    handled: (row.handled as ReviewHandledHint | null) ?? null,
    createdAt: iso(row.createdAt),
    decidedAt: isoOrNull(row.decidedAt),
  };
}

export function toMessageView(row: MessageRow, senderName: string | null = row.senderName): MessageView {
  return {
    id: row.id,
    chatId: row.chatId,
    senderName: row.fromOwner ? null : senderName,
    fromOwner: row.fromOwner,
    body: row.body,
    kind: row.kind,
    derivedText: row.derivedText,
    quotedMessageId: row.quotedMessageId,
    language: row.language,
    at: iso(row.sentAt),
  };
}
