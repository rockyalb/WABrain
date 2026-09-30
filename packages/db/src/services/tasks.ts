/**
 * Task mutations. Every change writes a TaskEvent, bumps sync versions (via
 * triggers), and emits one ChangeEvent after commit.
 */
import type {
  PolicyDecision,
  ReviewHandledHint,
  ReviewItem,
  ReviewItemType,
  Settings,
  Task,
  TaskAction,
  TaskKind,
  TaskStatus,
} from "@wabrain/contracts";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Database, Db } from "../client.js";
import { conflict, invalid, notFound } from "../errors.js";
import { newId } from "../ids.js";
import { toReviewItem, toTask, type ReviewItemRow, type TaskRow } from "../mappers.js";
import { noopNotifier, safeNotify, type ChangeEvent, type ChangeNotifier } from "../notifier.js";
import { writeAudit } from "../repos/audit.js";
import { getAnalysisRun } from "../repos/analysis-runs.js";
import { enqueueReviewNotification } from "../repos/notifications.js";
import { getSettings } from "../repos/settings.js";
import { findTaskRow, getReviewRow, getTaskRow } from "../repos/tasks.js";
import { appliedActions, chats, contexts, evalExamples, messages, people, reviewItems, taskEvents, tasks } from "../schema.js";
import { calibrateTaskProfile } from "../repos/task-calibration.js";
import { isDateOnly, resolveDateOnly } from "../time.js";

export const UNDO_WINDOW_MS = 7 * 86_400_000;

const SNAPSHOT_FIELDS = [
  "kind",
  "status",
  "title",
  "description",
  "dueAt",
  "dueHasTime",
  "contextId",
  "chatId",
  "personId",
  "evidenceMessageIds",
  "closedAt",
  "mergedIntoTaskId",
] as const;
type SnapshotField = (typeof SNAPSHOT_FIELDS)[number];
type TaskChanges = Partial<Pick<TaskRow, SnapshotField>>;
type Actor = "ai" | "owner" | "system";
type EventType = (typeof taskEvents.$inferInsert)["type"];

const REVIEW_TYPE: Record<TaskAction["type"], ReviewItemType> = {
  create: "create",
  complete: "possibly_done",
  cancel: "possibly_cancelled",
  reschedule: "reschedule",
  merge: "merge",
};

const snapshotValue = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
const restoreValue = (field: SnapshotField, value: unknown) =>
  (field === "dueAt" || field === "closedAt") && typeof value === "string" ? new Date(value) : value;

function snapshot(row: Partial<TaskRow>, fields: readonly SnapshotField[]): Record<string, unknown> {
  return Object.fromEntries(fields.map((field) => [field, snapshotValue(row[field] ?? null)]));
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(snapshotValue(a) ?? null) === JSON.stringify(snapshotValue(b) ?? null);
}

/** JSON with object keys sorted, so a jsonb round trip (which reorders keys) compares equal. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value ?? null, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

const sameCanonical = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

const isChange = (action: TaskAction): action is ChangeAction =>
  action.type === "complete" || action.type === "cancel" || action.type === "reschedule";

/** What accepting an action would do, without its supporting evidence, confidence and doubts. */
function proposalOf(action: TaskAction): Record<string, unknown> {
  const { evidenceMessageIds: _evidence, confidence: _confidence, ambiguityReasons: _ambiguity, ...proposal } = action;
  // A same-burst handled hint is evidence about the proposal, not a different proposal.
  if (proposal.type === "create") delete proposal.alreadyHandled;
  return proposal;
}

/**
 * created: a new pending item. replaced: the pending item for the same proposal identity now proposes
 * something different, is bumped and announced again. refreshed: same proposal, newer evidence or
 * confidence. unchanged: an identical retry.
 */
type ReviewItemChange = "created" | "replaced" | "refreshed" | "unchanged";

type ChangeAction = Extract<TaskAction, { type: "complete" | "cancel" | "reschedule" }>;

/** Where a change aimed at a pending create lands (see TaskService.pendingTarget). */
type PendingTarget =
  | { kind: "pending"; item: ReviewItemRow }
  | { kind: "accepted"; taskId: string }
  | { kind: "dropped"; reason: PolicyDecision["reason"] };

const EXCERPT_CHARS = 200;

/** Resolves a due input: ISO instant, date-only "YYYY-MM-DD", or null. */
export function resolveDue(
  dueAt: string | null | undefined,
  dueHasTime: boolean | undefined,
  settings: Pick<Settings, "endOfWorkDay" | "timezone">,
): { dueAt: Date | null; dueHasTime: boolean } | undefined {
  if (dueAt === undefined) return undefined;
  if (dueAt === null) return { dueAt: null, dueHasTime: false };
  if (isDateOnly(dueAt)) {
    try {
      return { dueAt: resolveDateOnly(dueAt, settings.endOfWorkDay, settings.timezone), dueHasTime: false };
    } catch (error) {
      throw invalid((error as Error).message);
    }
  }
  const instant = new Date(dueAt);
  if (Number.isNaN(instant.getTime())) throw invalid(`Invalid dueAt: ${dueAt}`);
  return { dueAt: instant, dueHasTime: dueHasTime ?? true };
}

export interface ManualTaskInput {
  /** Client-generated UUID so offline creates are idempotent. */
  id?: string;
  kind: TaskKind;
  title: string;
  description?: string;
  /** ISO instant or date-only "YYYY-MM-DD". */
  dueAt?: string | null;
  dueHasTime?: boolean;
  contextId?: string | null;
  chatId?: string | null;
  personId?: string | null;
}

export interface TaskPatch {
  title?: string;
  description?: string;
  dueAt?: string | null;
  dueHasTime?: boolean;
  contextId?: string | null;
  kind?: TaskKind;
}

export interface ApplyContext {
  chatId?: string | null;
  personId?: string | null;
  analysisRunId?: string | null;
  origin?: "ai" | "import";
  /**
   * Exactly-once key (e.g. "<analysisRunId>:<actionIndex>"). A second call with the same key applies
   * nothing, emits no notification, and returns the first call's outcome (review items with
   * created=false).
   */
  actionKey?: string | null;
}

export type ApplyResult =
  | { outcome: "applied"; task: Task; eventIds: string[] }
  | { outcome: "review"; reviewItem: ReviewItem; created: boolean }
  | { outcome: "dropped"; reason: PolicyDecision["reason"] };

/** Owner edits allowed when accepting a review item. */
export interface ReviewEdits {
  title?: string;
  description?: string;
  dueAt?: string | null;
  dueHasTime?: boolean;
  contextId?: string | null;
  kind?: TaskKind;
}

interface EventMeta {
  actor: Actor;
  groupId: string;
  evidenceMessageIds?: string[];
  undoable: boolean;
  reviewItemId?: string | null;
  analysisRunId?: string | null;
  confidence?: number | null;
  policyReason?: string | null;
}

export interface TaskServiceOptions {
  database: Database;
  notifier?: ChangeNotifier;
  now?: () => Date;
  onNotifyError?: (error: unknown) => void;
}

export class TaskService {
  private readonly database: Database;
  private readonly notifier: ChangeNotifier;
  private readonly now: () => Date;
  private readonly onNotifyError: (error: unknown) => void;

  constructor(options: TaskServiceOptions) {
    this.database = options.database;
    this.notifier = options.notifier ?? noopNotifier;
    this.now = options.now ?? (() => new Date());
    this.onNotifyError = options.onNotifyError ?? (() => {});
  }

  private emit(event: ChangeEvent) {
    return safeNotify(this.notifier, event, this.onNotifyError);
  }

  // -------------------------------------------------------------------------
  // Low-level helpers (run inside a transaction)
  // -------------------------------------------------------------------------

  private async insertEvent(
    db: Db,
    taskId: string,
    type: EventType,
    before: Record<string, unknown> | null,
    after: Record<string, unknown> | null,
    meta: EventMeta,
  ): Promise<string> {
    const id = newId();
    await db.insert(taskEvents).values({
      id,
      taskId,
      groupId: meta.groupId,
      type,
      actor: meta.actor,
      evidenceMessageIds: meta.evidenceMessageIds ?? [],
      before,
      after,
      undoableUntil: meta.undoable ? new Date(this.now().getTime() + UNDO_WINDOW_MS) : null,
      reviewItemId: meta.reviewItemId ?? null,
      analysisRunId: meta.analysisRunId ?? null,
      confidence: meta.confidence ?? null,
      policyReason: meta.policyReason ?? null,
    });
    return id;
  }

  /** Updates changed fields and records before/after. Returns null when nothing changed. */
  private async mutate(
    db: Db,
    row: TaskRow,
    changes: TaskChanges,
    type: EventType,
    meta: EventMeta,
  ): Promise<{ row: TaskRow; eventId: string } | null> {
    const fields = (Object.keys(changes) as SnapshotField[]).filter((field) => !sameValue(row[field], changes[field]));
    if (!fields.length) return null;
    const set = Object.fromEntries(fields.map((field) => [field, changes[field]])) as TaskChanges;
    const [updated] = await db
      .update(tasks)
      .set({ ...set, updatedAt: this.now() })
      .where(eq(tasks.id, row.id))
      .returning();
    const eventId = await this.insertEvent(db, row.id, type, snapshot(row, fields), snapshot(updated!, fields), meta);
    return { row: updated!, eventId };
  }

  private async assertRefs(db: Db, refs: { contextId?: string | null; chatId?: string | null; personId?: string | null }) {
    if (refs.contextId) {
      const [row] = await db.select({ id: contexts.id }).from(contexts).where(eq(contexts.id, refs.contextId));
      if (!row) throw invalid(`Unknown context ${refs.contextId}`);
    }
    if (refs.chatId) {
      const [row] = await db.select({ id: chats.id }).from(chats).where(eq(chats.id, refs.chatId));
      if (!row) throw invalid(`Unknown chat ${refs.chatId}`);
    }
    if (refs.personId) {
      const [row] = await db.select({ id: people.id }).from(people).where(eq(people.id, refs.personId));
      if (!row) throw invalid(`Unknown person ${refs.personId}`);
    }
  }

  /** Context inheritance: explicit → chat default → person default → none. */
  private async inherit(db: Db, chatId: string | null, personId: string | null) {
    let chat: { personId: string | null; defaultContextId: string | null } | undefined;
    if (chatId) {
      [chat] = await db
        .select({ personId: chats.personId, defaultContextId: chats.defaultContextId })
        .from(chats)
        .where(eq(chats.id, chatId));
    }
    const resolvedPersonId = personId ?? chat?.personId ?? null;
    let personContext: string | null = null;
    if (resolvedPersonId) {
      const [person] = await db
        .select({ defaultContextId: people.defaultContextId })
        .from(people)
        .where(eq(people.id, resolvedPersonId));
      personContext = person?.defaultContextId ?? null;
    }
    return { personId: resolvedPersonId, contextId: chat?.defaultContextId ?? personContext };
  }

  // -------------------------------------------------------------------------
  // Manual tasks and owner edits
  // -------------------------------------------------------------------------

  async createManualTask(input: ManualTaskInput): Promise<{ task: Task; created: boolean }> {
    const result = await this.database.transaction(async ({ db }) => {
      if (input.id) {
        const existing = await findTaskRow(db, input.id);
        if (existing) return { task: toTask(existing), created: false };
      }
      await this.assertRefs(db, input);
      const settings = await getSettings(db);
      const due = resolveDue(input.dueAt, input.dueHasTime, settings) ?? { dueAt: null, dueHasTime: false };
      const inherited = await this.inherit(db, input.chatId ?? null, input.personId ?? null);
      const now = this.now();
      const [row] = await db
        .insert(tasks)
        .values({
          id: input.id ?? newId(),
          kind: input.kind,
          status: "open",
          title: input.title,
          description: input.description ?? "",
          dueAt: due.dueAt,
          dueHasTime: due.dueHasTime,
          contextId: input.contextId !== undefined ? input.contextId : inherited.contextId,
          chatId: input.chatId ?? null,
          personId: inherited.personId,
          origin: "manual",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      if (!row) return { task: toTask(await getTaskRow(db, input.id!)), created: false };
      await this.insertEvent(db, row.id, "created", null, snapshot(row, SNAPSHOT_FIELDS), {
        actor: "owner",
        groupId: newId(),
        undoable: false,
      });
      return { task: toTask(row), created: true };
    });
    if (result.created) await this.emit({ type: "sync" });
    return result;
  }

  async updateTask(id: string, patch: TaskPatch): Promise<Task> {
    const result = await this.database.transaction(async ({ db }) => {
      const row = await getTaskRow(db, id, true);
      await this.assertRefs(db, { contextId: patch.contextId });
      const settings = await getSettings(db);
      const changes: TaskChanges = {};
      if (patch.title !== undefined) changes.title = patch.title;
      if (patch.description !== undefined) changes.description = patch.description;
      if (patch.kind !== undefined) changes.kind = patch.kind;
      if (patch.contextId !== undefined) changes.contextId = patch.contextId;
      const due = resolveDue(patch.dueAt, patch.dueHasTime, settings);
      if (due) Object.assign(changes, due);
      else if (patch.dueHasTime !== undefined) changes.dueHasTime = patch.dueHasTime;
      const onlyDue = Object.keys(changes).every((key) => key === "dueAt" || key === "dueHasTime");
      const mutated = await this.mutate(db, row, changes, onlyDue ? "rescheduled" : "edited", {
        actor: "owner",
        groupId: newId(),
        undoable: true,
      });
      return { task: toTask(mutated?.row ?? row), changed: Boolean(mutated) };
    });
    if (result.changed) await this.emit({ type: "sync" });
    return result.task;
  }

  /** Owner complete / reopen / cancel. Idempotent: no event when already in that state. */
  async setStatus(id: string, status: TaskStatus): Promise<Task> {
    const result = await this.database.transaction(async ({ db }) => {
      const row = await getTaskRow(db, id, true);
      if (row.status === status) return { task: toTask(row), changed: false };
      const type: EventType = status === "done" ? "completed" : status === "cancelled" ? "cancelled" : "reopened";
      const changes: TaskChanges =
        status === "open" ? { status, closedAt: null, mergedIntoTaskId: null } : { status, closedAt: this.now() };
      const mutated = await this.mutate(db, row, changes, type, { actor: "owner", groupId: newId(), undoable: true });
      return { task: toTask(mutated?.row ?? row), changed: Boolean(mutated) };
    });
    if (result.changed) await this.emit({ type: "sync" });
    return result.task;
  }

  // -------------------------------------------------------------------------
  // Agent actions
  // -------------------------------------------------------------------------

  /**
   * Applies an agent action according to the policy decision: "apply" mutates
   * the task (actor ai, undoable for 7 days), "review" creates a Review item,
   * "drop" does nothing.
   */
  async applyAction(action: TaskAction, decision: PolicyDecision, ctx: ApplyContext = {}): Promise<ApplyResult> {
    if (decision.outcome === "drop") return { outcome: "dropped", reason: decision.reason };
    const key = ctx.actionKey ?? null;
    if (decision.outcome === "review") {
      const result = await this.database.transaction(async ({ db }) => {
        if (key) {
          const previous = await this.claimActionKey(db, key);
          if (previous) return { previous };
        }
        let target = action;
        if (decision.reason === "pending_create" && isChange(action)) {
          const pending = await this.pendingTarget(db, action.taskId);
          if (pending.kind === "dropped") {
            if (key) await this.recordActionKey(db, key, { outcome: "dropped", reason: pending.reason });
            return { previous: { outcome: "dropped", reason: pending.reason } satisfies ApplyResult };
          }
          if (pending.kind === "pending") {
            const updated = await this.updatePendingCreate(db, pending.item, action);
            if (key) await this.recordActionKey(db, key, { outcome: "review", reviewItemId: updated.reviewItem.id });
            return { pending: updated };
          }
          // Accepted since the analysis read it: the change is an ordinary proposal on the resulting task.
          target = { ...action, taskId: pending.taskId };
        }
        const created = await this.createReviewItem(db, target, decision, ctx);
        // A new item, or a pending one replaced by a changed proposal (bumped createdAt), is announced
        // again; the notification key includes createdAt, so the superseded alert is dropped.
        if (created.change === "created" || created.change === "replaced") {
          await enqueueReviewNotification(db, {
            id: created.reviewItem.id,
            type: created.reviewItem.type,
            title: created.title,
            taskId: created.reviewItem.taskId,
            createdAt: created.reviewItem.createdAt,
          });
        }
        if (key) await this.recordActionKey(db, key, { outcome: "review", reviewItemId: created.reviewItem.id });
        return { created };
      });
      if ("previous" in result) return result.previous!;
      if ("pending" in result) {
        if (result.pending!.changed) await this.emit({ type: "sync" });
        return { outcome: "review", reviewItem: result.pending!.reviewItem, created: false };
      }
      const { created } = result;
      if (created.change === "created" || created.change === "replaced") {
        await this.emit({
          type: "review",
          reviewItemId: created.reviewItem.id,
          reviewType: created.reviewItem.type,
          title: created.title,
        });
      } else if (created.change === "refreshed") {
        await this.emit({ type: "sync" });
      }
      return { outcome: "review", reviewItem: created.reviewItem, created: created.change === "created" };
    }
    const result = await this.database.transaction(async ({ db }) => {
      if (key) {
        const previous = await this.claimActionKey(db, key);
        if (previous) return { previous };
      }
      const applied = await this.applyInTx(db, action, {
        actor: "ai",
        ctx,
        reviewItemId: null,
        policyReason: decision.reason,
      });
      if (key) {
        await this.recordActionKey(
          db,
          key,
          applied.outcome === "applied"
            ? { outcome: "applied", taskId: applied.task.id }
            : { outcome: "dropped", reason: applied.outcome === "dropped" ? applied.reason : null },
        );
      }
      return { applied };
    });
    if ("previous" in result) return result.previous!;
    if (result.applied.outcome === "applied") await this.emit({ type: "sync" });
    return result.applied;
  }

  /**
   * Inserts the action key, or returns the recorded outcome when it exists. The insert holds the row
   * lock until commit, so a concurrent call with the same key waits and then sees the first outcome.
   */
  private async claimActionKey(db: Db, key: string): Promise<ApplyResult | null> {
    const inserted = await db
      .insert(appliedActions)
      .values({ key, outcome: "pending" })
      .onConflictDoNothing()
      .returning({ key: appliedActions.key });
    if (inserted.length) return null;
    const [row] = await db.select().from(appliedActions).where(eq(appliedActions.key, key));
    if (row?.outcome === "applied" && row.taskId) {
      const task = await findTaskRow(db, row.taskId);
      if (task) return { outcome: "applied", task: toTask(task), eventIds: [] };
    }
    if (row?.outcome === "review" && row.reviewItemId) {
      const [item] = await db.select().from(reviewItems).where(eq(reviewItems.id, row.reviewItemId));
      if (item) return { outcome: "review", reviewItem: toReviewItem(item), created: false };
    }
    return { outcome: "dropped", reason: (row?.reason as PolicyDecision["reason"] | null) ?? "unknown_task" };
  }

  private async recordActionKey(
    db: Db,
    key: string,
    result: { outcome: "applied" | "review" | "dropped"; taskId?: string | null; reviewItemId?: string | null; reason?: string | null },
  ): Promise<void> {
    await db
      .update(appliedActions)
      .set({ outcome: result.outcome, taskId: result.taskId ?? null, reviewItemId: result.reviewItemId ?? null, reason: result.reason ?? null })
      .where(eq(appliedActions.key, key));
  }

  private async applyInTx(
    db: Db,
    action: TaskAction,
    opts: { actor: Actor; ctx: ApplyContext; reviewItemId: string | null; policyReason: string },
  ): Promise<ApplyResult> {
    const meta: EventMeta = {
      actor: opts.actor,
      groupId: newId(),
      evidenceMessageIds: action.evidenceMessageIds,
      undoable: true,
      reviewItemId: opts.reviewItemId,
      analysisRunId: opts.ctx.analysisRunId ?? null,
      confidence: action.confidence,
      policyReason: opts.policyReason,
    };
    const now = this.now();

    if (action.type === "create") {
      const chatId = opts.ctx.chatId ?? null;
      const inherited = await this.inherit(db, chatId, opts.ctx.personId ?? null);
      let contextId = action.contextId ?? inherited.contextId;
      if (action.contextId) {
        const [exists] = await db.select({ id: contexts.id }).from(contexts).where(eq(contexts.id, action.contextId));
        if (!exists) contextId = inherited.contextId;
      }
      const [row] = await db
        .insert(tasks)
        .values({
          id: newId(),
          kind: action.kind,
          status: "open",
          title: action.title,
          description: action.description,
          dueAt: action.dueAt ? new Date(action.dueAt) : null,
          dueHasTime: action.dueAt ? action.dueHasTime : false,
          contextId,
          chatId,
          personId: inherited.personId,
          origin: opts.ctx.origin ?? "ai",
          language: action.language,
          confidence: action.confidence,
          evidenceMessageIds: action.evidenceMessageIds,
          createdAt: now,
          updatedAt: now,
        })
        .returning();
      const eventId = await this.insertEvent(db, row!.id, "created", null, snapshot(row!, SNAPSHOT_FIELDS), meta);
      return { outcome: "applied", task: toTask(row!), eventIds: [eventId] };
    }

    if (action.type === "merge") {
      const [survivorId, ...otherIds] = action.taskIds;
      const rows = await db
        .select()
        .from(tasks)
        .where(inArray(tasks.id, action.taskIds))
        .for("update");
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (action.taskIds.some((id) => !byId.has(id))) return { outcome: "dropped", reason: "unknown_task" };
      if (rows.some((row) => row.status !== "open")) return { outcome: "dropped", reason: "task_not_open" };
      const survivor = byId.get(survivorId!)!;
      const evidence = [
        ...new Set([...survivor.evidenceMessageIds, ...otherIds.flatMap((id) => byId.get(id)!.evidenceMessageIds)]),
      ];
      const eventIds: string[] = [];
      const merged = await this.mutate(db, survivor, { evidenceMessageIds: evidence }, "merged", meta);
      if (merged) eventIds.push(merged.eventId);
      else eventIds.push(await this.insertEvent(db, survivor.id, "merged", {}, {}, meta));
      for (const id of otherIds) {
        const result = await this.mutate(
          db,
          byId.get(id)!,
          { status: "cancelled", closedAt: now, mergedIntoTaskId: survivor.id },
          "merged",
          meta,
        );
        if (result) eventIds.push(result.eventId);
      }
      return { outcome: "applied", task: toTask(merged?.row ?? survivor), eventIds };
    }

    const row = await findTaskRow(db, action.taskId, true);
    if (!row) return { outcome: "dropped", reason: "unknown_task" };
    if (row.status !== "open") return { outcome: "dropped", reason: "task_not_open" };
    const [type, changes]: [EventType, TaskChanges] =
      action.type === "complete"
        ? ["completed", { status: "done", closedAt: now }]
        : action.type === "cancel"
          ? ["cancelled", { status: "cancelled", closedAt: now }]
          : ["rescheduled", { dueAt: new Date(action.dueAt), dueHasTime: action.dueHasTime }];
    const mutated = await this.mutate(db, row, changes, type, meta);
    return { outcome: "applied", task: toTask(mutated?.row ?? row), eventIds: mutated ? [mutated.eventId] : [] };
  }

  /**
   * Resolves a complete / cancel / reschedule aimed at a create that was pending in Review when the
   * analysis ran. Still pending: update it. Accepted meanwhile: retarget to the task it created (if still
   * open). Rejected or gone: drop.
   */
  private async pendingTarget(db: Db, reviewItemId: string): Promise<PendingTarget> {
    const [item] = await db.select().from(reviewItems).where(eq(reviewItems.id, reviewItemId)).for("update");
    if (!item || item.type !== "create") return { kind: "dropped", reason: "unknown_task" };
    if (item.state === "pending") return { kind: "pending", item };
    if (item.state === "rejected" || !item.resultTaskId) return { kind: "dropped", reason: "task_not_open" };
    const task = await findTaskRow(db, item.resultTaskId);
    if (!task) return { kind: "dropped", reason: "unknown_task" };
    if (task.status !== "open") return { kind: "dropped", reason: "task_not_open" };
    return { kind: "accepted", taskId: task.id };
  }

  /**
   * complete / cancel mark the pending create as possibly already handled (the owner still decides);
   * reschedule moves its proposed due. Nothing is announced again: the item is already in Review.
   */
  private async updatePendingCreate(
    db: Db,
    item: ReviewItemRow,
    action: ChangeAction,
  ): Promise<{ reviewItem: ReviewItem; changed: boolean }> {
    const proposal = item.action as TaskAction;
    if (proposal.type !== "create") return { reviewItem: toReviewItem(item), changed: false };
    let set: Partial<typeof reviewItems.$inferInsert>;
    if (action.type === "reschedule") {
      if (proposal.dueAt === action.dueAt && proposal.dueHasTime === action.dueHasTime) return { reviewItem: toReviewItem(item), changed: false };
      const evidenceMessageIds = [...new Set([...proposal.evidenceMessageIds, ...action.evidenceMessageIds])];
      set = { action: { ...proposal, dueAt: action.dueAt, dueHasTime: action.dueHasTime, evidenceMessageIds } };
    } else {
      const status = action.type === "complete" ? "done" : "cancelled";
      const previous = item.handled as ReviewHandledHint | null;
      if (previous?.status === status && sameCanonical(previous.evidenceMessageIds, action.evidenceMessageIds)) {
        return { reviewItem: toReviewItem(item), changed: false };
      }
      set = { handled: await this.handledHint(db, status, action.evidenceMessageIds, action.confidence) };
    }
    const [updated] = await db.update(reviewItems).set(set).where(eq(reviewItems.id, item.id)).returning();
    return { reviewItem: toReviewItem(updated!), changed: true };
  }

  /** The Review card's "may already be handled" hint, quoting the first message that shows it. */
  private async handledHint(
    db: Db,
    status: ReviewHandledHint["status"],
    evidenceMessageIds: string[],
    confidence: number,
  ): Promise<ReviewHandledHint> {
    const [first] = await db
      .select({ body: messages.body, derivedText: messages.derivedText, fromOwner: messages.fromOwner })
      .from(messages)
      .where(eq(messages.id, evidenceMessageIds[0]!));
    const text = (first?.body.trim() || first?.derivedText?.trim() || "").replace(/\s+/g, " ");
    return {
      status,
      evidenceMessageIds,
      confidence,
      excerpt: text.length > EXCERPT_CHARS ? `${text.slice(0, EXCERPT_CHARS)}…` : text,
      fromOwner: first?.fromOwner ?? false,
      at: this.now().toISOString(),
    };
  }

  private async createReviewItem(
    db: Db,
    action: TaskAction,
    decision: PolicyDecision,
    ctx: ApplyContext,
  ): Promise<{ reviewItem: ReviewItem; change: ReviewItemChange; title: string }> {
    const type = REVIEW_TYPE[action.type];
    const taskId = action.type === "create" ? null : action.type === "merge" ? action.taskIds[0]! : action.taskId;
    const task = taskId ? await findTaskRow(db, taskId) : null;
    if (taskId && !task) throw invalid(`Unknown task ${taskId}`);
    const title = action.type === "create" ? action.title : task!.title;

    // One pending item per proposal identity: a create's chat and title, a change's task, or a merge's
    // exact set of tasks (so two merges sharing their first task stay separate items).
    const mergeIds = action.type === "merge" ? [...new Set(action.taskIds)] : [];
    const [existing] = await db
      .select()
      .from(reviewItems)
      .where(
        and(
          eq(reviewItems.state, "pending"),
          eq(reviewItems.type, type),
          action.type === "merge"
            ? sql`${reviewItems.action}->'taskIds' @> ${JSON.stringify(mergeIds)}::jsonb
                and (select count(distinct member.task_id) from jsonb_array_elements_text(${reviewItems.action}->'taskIds') as member(task_id)) = ${mergeIds.length}`
            : taskId
              ? eq(reviewItems.taskId, taskId)
              : and(
                  ctx.chatId ? eq(reviewItems.chatId, ctx.chatId) : isNull(reviewItems.chatId),
                  sql`lower(${reviewItems.action}->>'title') = lower(${title})`,
                ),
        ),
      )
      .orderBy(asc(reviewItems.createdAt))
      .limit(1)
      .for("update");

    const prefix: Record<ReviewItemType, string> = {
      create: "",
      possibly_done: "Possibly done: ",
      possibly_cancelled: "Possibly cancelled: ",
      reschedule: "Reschedule: ",
      merge: action.type === "merge" ? `Merge ${action.taskIds.length} tasks: ` : "",
    };
    const inherited = await this.inherit(db, ctx.chatId ?? task?.chatId ?? null, ctx.personId ?? task?.personId ?? null);
    const summary = `${prefix[type]}${title}`.slice(0, 300);
    const chatId = ctx.chatId ?? task?.chatId ?? null;
    // Asked and already handled in the same burst: the item carries the hint from the start.
    const handled =
      action.type === "create" && action.alreadyHandled
        ? await this.handledHint(db, action.alreadyHandled.status, action.alreadyHandled.evidenceMessageIds, action.confidence)
        : undefined;
    if (existing) {
      const existingAction = existing.action as TaskAction;
      // An identical retry (same action, evidence and confidence) returns the pending item untouched.
      if (sameCanonical(existingAction, action)) return { reviewItem: toReviewItem(existing), change: "unchanged", title };
      // A changed proposal replaces the pending one in place, so accepting it applies the latest.
      // If what would happen changes (a new date, title, ...), it is bumped and announced again;
      // new evidence or confidence for the same proposal only refreshes it.
      const replaced = !sameCanonical(proposalOf(existingAction), proposalOf(action));
      const createdAt = replaced ? new Date(Math.max(this.now().getTime(), existing.createdAt.getTime() + 1)) : existing.createdAt;
      const [updated] = await db
        .update(reviewItems)
        .set({
          taskId,
          action,
          reason: decision.reason,
          chatId,
          personId: inherited.personId,
          summary,
          ...(handled ? { handled } : {}),
          analysisRunId: ctx.analysisRunId ?? null,
          createdAt,
        })
        .where(eq(reviewItems.id, existing.id))
        .returning();
      return { reviewItem: toReviewItem(updated!), change: replaced ? "replaced" : "refreshed", title };
    }
    const [row] = await db
      .insert(reviewItems)
      .values({
        id: newId(),
        type,
        state: "pending",
        taskId,
        action,
        reason: decision.reason,
        chatId,
        personId: inherited.personId,
        summary,
        handled: handled ?? null,
        analysisRunId: ctx.analysisRunId ?? null,
        createdAt: this.now(),
      })
      .returning();
    return { reviewItem: toReviewItem(row!), change: "created", title };
  }

  // -------------------------------------------------------------------------
  // Review decisions
  // -------------------------------------------------------------------------

  /**
   * Accepts a Review item, optionally with owner edits. closeAs (creates only) accepts the proposal and
   * closes the new task at once, for a create a later message says was already handled: the task is
   * kept in history and the create still counts as a correct proposal for calibration.
   */
  async acceptReview(
    id: string,
    edits: ReviewEdits = {},
    closeAs?: "done" | "cancelled",
  ): Promise<{ reviewItem: ReviewItem; task: Task | null }> {
    const result = await this.database.transaction(async ({ db }) => {
      const item = await getReviewRow(db, id, true);
      if (item.state !== "pending") throw conflict("Review item already decided");
      if (closeAs && item.type !== "create") throw invalid("closeAs applies to create review items only");
      const action = await this.withEdits(db, item, edits);
      const applied = await this.applyInTx(db, action, {
        actor: "owner",
        ctx: { chatId: item.chatId, personId: item.personId, analysisRunId: item.analysisRunId },
        reviewItemId: item.id,
        policyReason: item.reason,
      });
      if (applied.outcome === "dropped" && applied.reason === "unknown_task") throw conflict("The task no longer exists");
      if (applied.outcome === "dropped" && action.type === "merge") throw conflict("Every merged task must be open");
      // A closed task (e.g. already done) accepts without further change.
      let task =
        applied.outcome === "applied"
          ? applied.task
          : item.taskId
            ? toTask(await getTaskRow(db, item.taskId))
            : null;
      if (closeAs && task) {
        const handled = item.handled as ReviewHandledHint | null;
        const closed = await this.mutate(
          db,
          await getTaskRow(db, task.id, true),
          { status: closeAs, closedAt: this.now() },
          closeAs === "done" ? "completed" : "cancelled",
          { actor: "owner", groupId: newId(), undoable: true, evidenceMessageIds: handled?.evidenceMessageIds ?? [], reviewItemId: item.id },
        );
        if (closed) task = toTask(closed.row);
      }
      const [decided] = await db
        .update(reviewItems)
        .set({ state: "accepted", decidedAt: this.now(), resultTaskId: task?.id ?? null })
        .where(eq(reviewItems.id, id))
        .returning();
      await this.recordExample(db, item, "accepted", action, edits);
      await writeAudit(db, {
        actor: "owner",
        action: "review.accepted",
        targetType: "review_item",
        targetId: id,
        details: { type: item.type, taskId: task?.id ?? null, edited: Object.keys(edits).length > 0, closeAs: closeAs ?? null },
      });
      return { reviewItem: toReviewItem(decided!), task };
    });
    await this.emit({ type: "sync" });
    return result;
  }

  async rejectReview(id: string): Promise<{ reviewItem: ReviewItem }> {
    const result = await this.database.transaction(async ({ db }) => {
      const item = await getReviewRow(db, id, true);
      if (item.state !== "pending") throw conflict("Review item already decided");
      const [decided] = await db
        .update(reviewItems)
        .set({ state: "rejected", decidedAt: this.now() })
        .where(eq(reviewItems.id, id))
        .returning();
      await this.recordExample(db, item, "rejected", null, null);
      await writeAudit(db, {
        actor: "owner",
        action: "review.rejected",
        targetType: "review_item",
        targetId: id,
        details: { type: item.type },
      });
      return { reviewItem: toReviewItem(decided!) };
    });
    await this.emit({ type: "sync" });
    return result;
  }

  private async withEdits(db: Db, item: ReviewItemRow, edits: ReviewEdits): Promise<TaskAction> {
    const action = item.action as TaskAction;
    const settings = await getSettings(db);
    const due = resolveDue(edits.dueAt, edits.dueHasTime, settings);
    if (action.type === "create") {
      if (edits.contextId) await this.assertRefs(db, { contextId: edits.contextId });
      return {
        ...action,
        title: edits.title ?? action.title,
        description: edits.description ?? action.description,
        kind: edits.kind ?? action.kind,
        contextId: edits.contextId !== undefined ? edits.contextId : action.contextId,
        ...(due ? { dueAt: due.dueAt?.toISOString() ?? null, dueHasTime: due.dueHasTime } : {}),
      };
    }
    if (action.type === "reschedule" && due?.dueAt) {
      return { ...action, dueAt: due.dueAt.toISOString(), dueHasTime: due.dueHasTime };
    }
    return action;
  }

  private async recordExample(
    db: Db,
    item: ReviewItemRow,
    decision: "accepted" | "rejected",
    finalAction: TaskAction | null,
    edits: ReviewEdits | null,
  ) {
    const action = item.action as TaskAction;
    await db.insert(evalExamples).values({
      id: newId(),
      reviewItemId: item.id,
      reviewType: item.type,
      decision,
      action,
      finalAction,
      edits: edits && Object.keys(edits).length ? edits : null,
      reason: item.reason,
      confidence: action.confidence,
      chatId: item.chatId,
      analysisRunId: item.analysisRunId,
    });
    // Every decided create is a label for the profile that proposed it: recalibrate that profile now.
    if (item.type === "create" && item.analysisRunId) {
      const run = await getAnalysisRun(db, item.analysisRunId);
      if (run?.provider && run.model && run.promptVersion) {
        await calibrateTaskProfile(db, { provider: run.provider, model: run.model, promptVersion: run.promptVersion }, this.now());
      }
    }
  }

  // -------------------------------------------------------------------------
  // Undo
  // -------------------------------------------------------------------------

  /**
   * Undoes an event and every event written by the same operation: restores
   * the `before` fields (an undone creation cancels the task), marks them
   * undone, and writes an "undone" event per task.
   */
  async undoEvent(eventId: string): Promise<Task> {
    const task = await this.database.transaction(async ({ db }) => {
      const [event] = await db.select().from(taskEvents).where(eq(taskEvents.id, eventId)).for("update");
      if (!event) throw notFound("Task event");
      if (event.undoneAt) throw conflict("Event already undone");
      if (!event.undoableUntil || event.undoableUntil.getTime() <= this.now().getTime()) {
        throw conflict("Event can no longer be undone");
      }
      const group = await db
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.groupId, event.groupId), isNull(taskEvents.undoneAt)))
        .orderBy(asc(taskEvents.createdAt))
        .for("update");
      const undoGroup = newId();
      const now = this.now();
      for (const member of group.reverse()) {
        const row = await getTaskRow(db, member.taskId, true);
        const changes: TaskChanges =
          member.type === "created"
            ? { status: "cancelled", closedAt: now }
            : (Object.fromEntries(
                Object.entries(member.before ?? {})
                  .filter(([field]) => (SNAPSHOT_FIELDS as readonly string[]).includes(field))
                  .map(([field, value]) => [field, restoreValue(field as SnapshotField, value)]),
              ) as TaskChanges);
        await this.mutate(db, row, changes, "undone", {
          actor: "owner",
          groupId: undoGroup,
          undoable: false,
        });
        await db.update(taskEvents).set({ undoneAt: now }).where(eq(taskEvents.id, member.id));
      }
      await writeAudit(db, {
        actor: "owner",
        action: "task.undo",
        targetType: "task_event",
        targetId: eventId,
        details: { taskId: event.taskId, type: event.type, grouped: group.length },
      });
      return toTask(await getTaskRow(db, event.taskId));
    });
    await this.emit({ type: "sync" });
    return task;
  }
}
