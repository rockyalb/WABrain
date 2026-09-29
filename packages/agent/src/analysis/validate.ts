import { TaskActionSchema, type Settings, type TaskAction } from "@wabrain/contracts";
import { resolveDue, type ResolvedDue } from "../due.js";
import { detectLanguage } from "../language.js";
import { toLocal } from "../time.js";
import { citableIds, type WorkingMemory } from "../working-memory.js";
import type { ModelAnalysis, ModelTaskAction } from "./schema.js";

export type DropReason =
  | "no_evidence"
  | "unknown_evidence"
  | "no_new_evidence"
  | "unknown_task"
  | "missing_fields"
  | "invalid_due"
  | "no_change"
  | "duplicate"
  | "invalid_contract";

export interface DroppedAction {
  index: number;
  reason: DropReason;
  raw: ModelTaskAction;
}

export interface ValidatedActions {
  actions: TaskAction[];
  /** Parallel to actions: the model's reason for a context override, or null. */
  contextReasons: Array<string | null>;
  dropped: DroppedAction[];
}

type Outcome = { ok: true; action: TaskAction; contextReason: string | null } | { ok: false; reason: DropReason };

const MAX_AMBIGUITY_REASONS = 5;
const LANGUAGE_RE = /^[a-z]{2,3}(?:-[a-z]{2})?$/i;

const clamp01 = (value: number) => (Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0);
const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();

function cleanAmbiguity(reasons: readonly string[]): string[] {
  return [...new Set(reasons.map((reason) => clean(reason).slice(0, 200)).filter(Boolean))].slice(0, MAX_AMBIGUITY_REASONS);
}

function localDueLabel(due: ResolvedDue, timezone: string): string {
  const local = toLocal(new Date(due.dueAt), timezone);
  return due.dueHasTime ? `${local.date} ${local.time}` : local.date;
}

function convert(raw: ModelTaskAction, memory: WorkingMemory, settings: Pick<Settings, "timezone" | "endOfWorkDay">): Outcome {
  const ids = citableIds(memory);
  const evidenceMessageIds = [...new Set(raw.evidenceMessageIds.map((id) => id.trim()).filter(Boolean))];
  if (evidenceMessageIds.length === 0) return { ok: false, reason: "no_evidence" };
  if (!evidenceMessageIds.every((id) => ids.all.has(id))) return { ok: false, reason: "unknown_evidence" };
  // Each run only acts on its new burst; older messages alone must not re-trigger actions.
  if (!evidenceMessageIds.some((id) => ids.burst.has(id))) return { ok: false, reason: "no_new_evidence" };

  const ambiguityReasons = cleanAmbiguity(raw.ambiguityReasons);
  const base = { confidence: clamp01(raw.confidence), ambiguityReasons, evidenceMessageIds };

  switch (raw.type) {
    case "create": {
      const title = clean(raw.title).slice(0, 180);
      if (!raw.kind || title.length < 3) return { ok: false, reason: "missing_fields" };
      let due: ResolvedDue | null = null;
      if (raw.due) {
        due = resolveDue(raw.due, settings);
        if (!due) ambiguityReasons.push("the due date could not be understood");
        else if (raw.due.date < memory.calendar.today) ambiguityReasons.push("the due date is in the past");
      }
      const contextReason = clean(raw.contextReason) || null;
      const contextId =
        raw.contextId && ids.contexts.has(raw.contextId) && raw.contextId !== memory.chat.defaultContext?.id && contextReason
          ? raw.contextId
          : null;
      // The same title as a create still waiting in Review is the same proposal again.
      if (memory.pendingTasks.some((task) => task.title.toLowerCase() === title.toLowerCase())) return { ok: false, reason: "duplicate" };
      const modelLanguage = clean(raw.language).toLowerCase();
      return {
        ok: true,
        contextReason: contextId ? contextReason : null,
        action: {
          type: "create",
          kind: raw.kind,
          title,
          description: clean(raw.description).slice(0, 4000),
          dueAt: due?.dueAt ?? null,
          dueHasTime: due?.dueHasTime ?? false,
          contextId,
          language: LANGUAGE_RE.test(modelLanguage) ? modelLanguage : detectLanguage(title),
          ...base,
          ambiguityReasons: ambiguityReasons.slice(0, MAX_AMBIGUITY_REASONS),
        },
      };
    }
    case "complete":
    case "cancel": {
      if (!raw.taskId || !(ids.openTasks.has(raw.taskId) || ids.pendingTasks.has(raw.taskId))) return { ok: false, reason: "unknown_task" };
      return { ok: true, contextReason: null, action: { type: raw.type, taskId: raw.taskId, ...base } };
    }
    case "reschedule": {
      if (!raw.taskId || !(ids.openTasks.has(raw.taskId) || ids.pendingTasks.has(raw.taskId))) return { ok: false, reason: "unknown_task" };
      if (!raw.due) return { ok: false, reason: "invalid_due" };
      const due = resolveDue(raw.due, settings);
      if (!due) return { ok: false, reason: "invalid_due" };
      const current = [...memory.openTasks, ...memory.pendingTasks].find((task) => task.id === raw.taskId)?.due ?? null;
      if (current === localDueLabel(due, settings.timezone)) return { ok: false, reason: "no_change" };
      if (raw.due.date < memory.calendar.today) base.ambiguityReasons.push("the new due date is in the past");
      return { ok: true, contextReason: null, action: { type: "reschedule", taskId: raw.taskId, ...due, ...base } };
    }
    case "merge": {
      const taskIds = [...new Set(raw.taskIds ?? [])];
      if (taskIds.length < 2 || !taskIds.every((id) => ids.openTasks.has(id))) return { ok: false, reason: "unknown_task" };
      return { ok: true, contextReason: null, action: { type: "merge", taskIds, ...base } };
    }
  }
}

function dedupeKey(action: TaskAction): string {
  switch (action.type) {
    case "create":
      return `create:${action.kind}:${action.title.toLowerCase()}`;
    case "merge":
      return `merge:${[...action.taskIds].sort().join(",")}`;
    default:
      return `${action.type}:${action.taskId}`;
  }
}

/**
 * Turns raw model output into contract TaskActions. Drops actions that cite unknown messages or no new
 * message, reference tasks that are in neither the open nor the pending task list (merge: open only), repeat a
 * pending create's title, or lack required fields; resolves
 * local dues into instants; keeps only allowed context overrides; removes duplicates (highest confidence
 * wins); and finally parses each action with the contract's TaskActionSchema.
 */
export function validateModelActions(
  output: ModelAnalysis,
  memory: WorkingMemory,
  settings: Pick<Settings, "timezone" | "endOfWorkDay">,
): ValidatedActions {
  const dropped: DroppedAction[] = [];
  const kept = new Map<string, { index: number; action: TaskAction; contextReason: string | null }>();

  output.actions.forEach((raw, index) => {
    const outcome = convert(raw, memory, settings);
    if (!outcome.ok) {
      dropped.push({ index, reason: outcome.reason, raw });
      return;
    }
    const parsed = TaskActionSchema.safeParse(outcome.action);
    if (!parsed.success) {
      dropped.push({ index, reason: "invalid_contract", raw });
      return;
    }
    const key = dedupeKey(parsed.data);
    const existing = kept.get(key);
    if (existing && existing.action.confidence >= parsed.data.confidence) {
      dropped.push({ index, reason: "duplicate", raw });
      return;
    }
    if (existing) dropped.push({ index: existing.index, reason: "duplicate", raw: output.actions[existing.index]! });
    kept.set(key, { index, action: parsed.data, contextReason: outcome.contextReason });
  });

  const ordered = [...kept.values()].sort((a, b) => a.index - b.index);
  return {
    actions: ordered.map((entry) => entry.action),
    contextReasons: ordered.map((entry) => entry.contextReason),
    dropped: dropped.sort((a, b) => a.index - b.index),
  };
}
