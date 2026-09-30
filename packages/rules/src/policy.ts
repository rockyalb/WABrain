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
}

export type PolicyTask = Pick<Task, "id" | "status" | "chatId">;

export interface PolicyContext {
  settings: Pick<Settings, "trialStartedAt" | "trialDays" | "autoCreateThreshold">;
  chat: Pick<Chat, "id" | "mode" | "autoCreate" | "minimumAutoConfidence">;
  /**
   * Usable create calibration for the model/prompt profile that produced the actions (from the owner's
   * Review decisions). Missing (never calibrated, not enough decisions, or another profile's) keeps
   * creates in Review after the trial. Only creates read it.
   */
  calibration?: { threshold: number } | null;
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

function usableCalibration(ctx: Pick<PolicyContext, "calibration">): number | null {
  const threshold = ctx.calibration?.threshold;
  return typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 && threshold <= 1 ? threshold : null;
}

/** True only when every cited message is known and was written by the owner. */
export function allEvidenceFromOwner(evidenceIds: readonly string[], evidence: readonly PolicyEvidenceMessage[]): boolean {
  if (evidenceIds.length === 0) return false;
  const byId = new Map(evidence.map((message) => [message.id, message]));
  return evidenceIds.every((id) => byId.get(id)?.fromOwner === true);
}

function isPendingCreate(id: string, ctx: PolicyContext): boolean {
  return (ctx.pendingCreates ?? []).some((pending) => pending.id === id && pending.chatId === ctx.chat.id);
}

type ExistingTaskCheck = { ok: true } | { ok: false; result: PolicyResult };

function checkExistingTask(taskId: string, ctx: PolicyContext): ExistingTaskCheck {
  const task = ctx.tasks.find((candidate) => candidate.id === taskId);
  // A task from another chat is treated as unknown: a chat can only change its own tasks.
  if (!task || task.chatId !== ctx.chat.id) return { ok: false, result: drop("unknown_task") };
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
 * - create: Review during the trial, when auto-create is off for the chat, when the active model/prompt
 *   profile has no usable calibration yet (even after the trial), below max(automatic-change threshold,
 *   calibrated threshold), or when the model reported any ambiguity; otherwise applied. A create whose
 *   own burst already shows it handled (alreadyHandled) always goes to Review (already_handled).
 * - complete / cancel / reschedule: dropped when the task is unknown, belongs to another chat, or is not
 *   open. Applied only when every evidence message is the owner's, the action is unambiguous, and its
 *   confidence reaches the automatic-change threshold; anyone else's evidence becomes a Possibly done /
 *   Possibly cancelled / reschedule prompt. The trial and calibration do not gate these.
 * - complete / cancel / reschedule of a create still pending in Review (same chat): always goes to that
 *   pending item (pending_create) — a "may already be handled" hint or a new due — never applied.
 * - merge: always Review (dropped when a referenced task is unknown or closed).
 */
export function decideAction(action: TaskAction, ctx: PolicyContext): PolicyResult {
  if (ctx.chat.mode === "off") return drop("chat_not_analyzed");
  const threshold = autoConfidenceThreshold(ctx);

  switch (action.type) {
    case "create": {
      // The burst already shows it done or no longer needed: the owner decides, whatever the calibration.
      if (action.alreadyHandled) return review("already_handled", "create");
      if (isInTrial(ctx.settings, ctx.now)) return review("trial_period", "create");
      if (!ctx.chat.autoCreate) return review("auto_create_disabled", "create");
      const calibrated = usableCalibration(ctx);
      if (calibrated === null) return review("calibration_required", "create");
      // The calibrated threshold is a floor: neither the global setting nor a lenient chat can go below it.
      if (action.confidence < Math.max(threshold, calibrated)) return review("below_threshold", "create");
      if (action.ambiguityReasons.length > 0) return review("ambiguous", "create");
      return apply("auto_create");
    }
    case "complete":
    case "cancel":
    case "reschedule": {
      if (isPendingCreate(action.taskId, ctx)) return review("pending_create", "create");
      const check = checkExistingTask(action.taskId, ctx);
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
