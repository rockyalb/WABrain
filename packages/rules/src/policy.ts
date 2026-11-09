import type {
  Chat,
  PolicyDecision,
  ReviewItemType,
  Settings,
  Task,
  TaskAction,
} from "@wabrain/contracts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** True while the trial is running: trialStartedAt + trialDays is still in the future. */
export function isInTrial(settings: Pick<Settings, "trialStartedAt" | "trialDays">, now: Date): boolean {
  const started = Date.parse(settings.trialStartedAt);
  if (Number.isNaN(started)) return true; // Unknown start: stay on the safe side.
  return started + settings.trialDays * DAY_MS > now.getTime();
}

/** Evidence message as the policy sees it: the direction comes from storage, never from the model. */
export interface PolicyEvidenceMessage {
  id: string;
  fromOwner: boolean;
  /**
   * True when the message was analyzed only because its "mentions only" group has linked tasks open
   * (not for a mention). Such messages may only close tasks linked to the chat.
   */
  linkedOnly?: boolean;
}

export type PolicyTask = Pick<Task, "id" | "status" | "chatId"> & {
  /** Chats with a confirmed link to the task: they may complete or cancel it, nothing else. */
  linkedChatIds?: readonly string[];
};

export interface PolicyContext {
  settings: Pick<Settings, "trialStartedAt" | "trialDays" | "autoCreateThreshold">;
  chat: Pick<Chat, "id" | "mode" | "autoCreate" | "minimumAutoConfidence">;
  now: Date;
  /** The stored messages the actions cite. Unknown evidence ids count as not the owner's. */
  evidenceMessages: readonly PolicyEvidenceMessage[];
  /**
   * Tasks the actions may reference: at least the chat's open tasks. Include closed tasks that are
   * referenced so they are reported as task_not_open rather than unknown_task.
   */
  tasks: readonly PolicyTask[];
  /**
   * Creates still pending in Review (id = review item id). A complete, cancel or reschedule aimed at one
   * updates that pending item instead of touching a task.
   */
  pendingCreates?: readonly PolicyPendingCreate[];
}

export interface PolicyPendingCreate {
  id: string;
  chatId: string | null;
  /** Chats the proposed task is linked to (confirmed links). */
  linkedChatIds?: readonly string[];
}

export interface PolicyResult {
  decision: PolicyDecision;
  /** Review inbox item type when the outcome is review; otherwise null. */
  reviewType: ReviewItemType | null;
}

const apply = (reason: PolicyDecision["reason"]): PolicyResult => ({ decision: { outcome: "apply", reason }, reviewType: null });
const drop = (reason: PolicyDecision["reason"]): PolicyResult => ({ decision: { outcome: "drop", reason }, reviewType: null });
const review = (reason: PolicyDecision["reason"], reviewType: ReviewItemType): PolicyResult => ({
  decision: { outcome: "review", reason },
  reviewType,
});

/**
 * The automatic-change threshold: the chat's override, else Settings.autoCreateThreshold (which keeps
 * its historical name). Every automatic change needs at least this confidence, including owner-evidenced
 * completions, cancellations and reschedules; this is deliberate, so a hesitant reading of the owner's
 * own message still goes to Review.
 */
export function autoConfidenceThreshold(ctx: Pick<PolicyContext, "settings" | "chat">): number {
  return ctx.chat.minimumAutoConfidence ?? ctx.settings.autoCreateThreshold;
}

/** True when every cited message is known and was analyzed only for the chat's linked tasks. */
function onlyLinkedEvidence(evidenceIds: readonly string[], ctx: PolicyContext): boolean {
  if (evidenceIds.length === 0) return false;
  const byId = new Map(ctx.evidenceMessages.map((message) => [message.id, message]));
  return evidenceIds.every((id) => byId.get(id)?.linkedOnly === true);
}

/** True only when every cited message is known and was written by the owner. */
export function allEvidenceFromOwner(evidenceIds: readonly string[], evidence: readonly PolicyEvidenceMessage[]): boolean {
  if (evidenceIds.length === 0) return false;
  const byId = new Map(evidence.map((message) => [message.id, message]));
  return evidenceIds.every((id) => byId.get(id)?.fromOwner === true);
}

/** "own": only the chat the task came from. "linked": also a chat the task is linked to. */
type Reach = "own" | "linked";

const reaches = (chatId: string, owner: string | null, linked: readonly string[] | undefined, reach: Reach) =>
  owner === chatId || (reach === "linked" && (linked ?? []).includes(chatId));

function isPendingCreate(id: string, ctx: PolicyContext, reach: Reach): boolean {
  return (ctx.pendingCreates ?? []).some((pending) => pending.id === id && reaches(ctx.chat.id, pending.chatId, pending.linkedChatIds, reach));
}

/** True when the task (or pending create) belongs to another chat and is linked to this one. */
function isLinkedHere(id: string, ctx: PolicyContext): boolean {
  const task = ctx.tasks.find((candidate) => candidate.id === id);
  if (task) return task.chatId !== ctx.chat.id && (task.linkedChatIds ?? []).includes(ctx.chat.id);
  const pending = (ctx.pendingCreates ?? []).find((candidate) => candidate.id === id);
  return Boolean(pending && pending.chatId !== ctx.chat.id && (pending.linkedChatIds ?? []).includes(ctx.chat.id));
}

type ExistingTaskCheck = { ok: true } | { ok: false; result: PolicyResult };

function checkExistingTask(taskId: string, ctx: PolicyContext, reach: Reach = "own"): ExistingTaskCheck {
  const task = ctx.tasks.find((candidate) => candidate.id === taskId);
  // A task from another chat is treated as unknown unless it is linked to this chat (complete and cancel only).
  if (!task || !reaches(ctx.chat.id, task.chatId, task.linkedChatIds, reach)) return { ok: false, result: drop("unknown_task") };
  if (task.status !== "open") return { ok: false, result: drop("task_not_open") };
  return { ok: true };
}

const CHANGE_REVIEW_TYPE = {
  complete: "possibly_done",
  cancel: "possibly_cancelled",
  reschedule: "reschedule",
} as const satisfies Record<"complete" | "cancel" | "reschedule", ReviewItemType>;

/**
 * The deterministic action policy (docs/ARCHITECTURE.md, "Action policy"; docs/SPEC.md, "Lifecycle").
 *
 * - create: Review during the trial, when auto-create is off for the chat, below the automatic-change
 *   threshold, or when the model reported any ambiguity; otherwise applied. A create whose own burst
 *   already shows it handled (alreadyHandled) passes the same gates and is then applied straight into
 *   Done or Cancelled (already_handled), so it is on record without asking the owner.
 * - complete / cancel / reschedule: dropped when the task is unknown, belongs to another chat, or is not
 *   open. A task linked to this chat (TaskLink) counts as this chat's for complete and cancel only. Applied only when every evidence message is the owner's, the action is unambiguous, and its
 *   confidence reaches the automatic-change threshold; anyone else's evidence becomes a Possibly done /
 *   Possibly cancelled / reschedule prompt. The trial does not gate these.
 * - complete / cancel / reschedule of a create still pending in Review (same chat): always goes to that
 *   pending item (pending_create) — a "may already be handled" hint or a new due — never applied.
 * - merge: always Review (dropped when a referenced task is unknown or closed).
 * - Evidence made only of messages analyzed because the group has linked tasks (linkedOnly): only a
 *   complete or cancel of a task linked to this chat may follow; anything else is dropped (linked_only).
 */
export function decideAction(action: TaskAction, ctx: PolicyContext): PolicyResult {
  if (ctx.chat.mode === "off") return drop("chat_not_analyzed");
  const threshold = autoConfidenceThreshold(ctx);
  if (onlyLinkedEvidence(action.evidenceMessageIds, ctx)) {
    const closesLinked = (action.type === "complete" || action.type === "cancel") && isLinkedHere(action.taskId, ctx);
    if (!closesLinked) return drop("linked_only");
  }

  switch (action.type) {
    case "create": {
      if (isInTrial(ctx.settings, ctx.now)) return review("trial_period", "create");
      if (!ctx.chat.autoCreate) return review("auto_create_disabled", "create");
      if (action.confidence < threshold) return review("below_threshold", "create");
      if (action.ambiguityReasons.length > 0) return review("ambiguous", "create");
      // The burst already shows it done or no longer needed: recorded as closed, nothing to review.
      return apply(action.alreadyHandled ? "already_handled" : "auto_create");
    }
    case "complete":
    case "cancel":
    case "reschedule": {
      // Linked chats may close a task (or mark a pending create handled); only its own chat moves its due.
      const reach: Reach = action.type === "reschedule" ? "own" : "linked";
      if (isPendingCreate(action.taskId, ctx, reach)) return review("pending_create", "create");
      const check = checkExistingTask(action.taskId, ctx, reach);
      if (!check.ok) return check.result;
      const reviewType = CHANGE_REVIEW_TYPE[action.type];
      if (!allEvidenceFromOwner(action.evidenceMessageIds, ctx.evidenceMessages)) {
        return review("non_owner_evidence", reviewType);
      }
      // "Clearly" completes/cancels/moves: the owner's own message still needs an unambiguous, confident reading.
      if (action.ambiguityReasons.length > 0) return review("ambiguous", reviewType);
      if (action.confidence < threshold) return review("below_threshold", reviewType);
      return apply("owner_evidence");
    }
    case "merge": {
      const ids = new Set(action.taskIds);
      if (ids.size < 2) return drop("unknown_task");
      for (const taskId of ids) {
        const check = checkExistingTask(taskId, ctx);
        if (!check.ok) return check.result;
      }
      return review("merge_requires_review", "merge");
    }
    case "link":
      // Written by the task service, never by the model: always the owner's to confirm.
      return review("link_confirmation", "link");
  }
}

/** The existing task ids an action touches. */
export function referencedTaskIds(action: TaskAction): string[] {
  switch (action.type) {
    case "create":
      return [];
    case "merge":
      return [...action.taskIds];
    default:
      return [action.taskId];
  }
}

/**
 * Applies decideAction to one analysis run's actions. When two actions in the same run touch the same task
 * (for example complete and reschedule), neither may auto-apply: both go to Review as ambiguous.
 */
export function decideActions(actions: readonly TaskAction[], ctx: PolicyContext): PolicyResult[] {
  const touches = new Map<string, number>();
  for (const action of actions) {
    for (const id of new Set(referencedTaskIds(action))) touches.set(id, (touches.get(id) ?? 0) + 1);
  }
  return actions.map((action) => {
    const result = decideAction(action, ctx);
    const conflicting = referencedTaskIds(action).some((id) => (touches.get(id) ?? 0) > 1);
    if (conflicting && result.decision.outcome === "apply" && action.type !== "create") {
      return review("ambiguous", CHANGE_REVIEW_TYPE[action.type as keyof typeof CHANGE_REVIEW_TYPE] ?? "merge");
    }
    return result;
  });
}
