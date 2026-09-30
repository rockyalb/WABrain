import type { Settings, TaskAction } from "@wabrain/contracts";
import { toLocal, zonedTimeToInstant } from "../time.js";
import { buildWorkingMemory, type MemoryMessageInput, type OpenTaskInput, type WorkingMemory } from "../working-memory.js";
import { DATE } from "./fixtures/helpers.js";
import type { EvalCase, EvalMessage, EvalOpenTask, ExpectedAction } from "./types.js";

export const EVAL_SETTINGS: Pick<Settings, "timezone" | "endOfWorkDay"> = { timezone: "Europe/Rome", endOfWorkDay: "17:00" };
export const EVAL_CONTEXTS = [
  { id: "ctx-work", name: "Work" },
  { id: "ctx-personal", name: "Personal" },
];

function instantOf(at: string, date: string): Date {
  return /^\d{2}:\d{2}$/.test(at) ? zonedTimeToInstant(date, at, EVAL_SETTINGS.timezone) : new Date(at);
}

function toInput(message: EvalMessage, date: string): MemoryMessageInput {
  return {
    id: message.id,
    at: instantOf(message.at, date),
    fromOwner: message.fromOwner,
    senderName: message.fromOwner ? "Alex" : (message.sender ?? null),
    text: message.text,
    kind: message.kind ?? "text",
    derivedText: message.derivedText ?? null,
    derivedKind: message.derivedKind ?? null,
  };
}

export function caseNow(evalCase: EvalCase): Date {
  const date = evalCase.date ?? DATE;
  if (evalCase.nowTime) return zonedTimeToInstant(date, evalCase.nowTime, EVAL_SETTINGS.timezone);
  const last = Math.max(...evalCase.burst.map((message) => instantOf(message.at, date).getTime()));
  return new Date(last + 60_000);
}

export function buildCaseMemory(evalCase: EvalCase): WorkingMemory {
  const date = evalCase.date ?? DATE;
  return buildWorkingMemory({
    now: caseNow(evalCase),
    settings: EVAL_SETTINGS,
    chat: { id: `chat-${evalCase.id}`, name: evalCase.chat.name, isGroup: evalCase.chat.isGroup, defaultContextId: evalCase.chat.defaultContextId ?? null },
    contexts: EVAL_CONTEXTS,
    person: evalCase.person ? { displayName: evalCase.person, languages: [], facts: [] } : null,
    ownerName: "Alex",
    burst: evalCase.burst.map((message) => toInput(message, date)),
    preceding: (evalCase.context ?? []).map((message) => toInput(message, date)),
    openTasks: (evalCase.openTasks ?? []).map(toTaskInput),
    pendingTasks: (evalCase.pendingTasks ?? []).map(toTaskInput),
  });
}

function toTaskInput(task: EvalOpenTask): OpenTaskInput {
  return { id: task.id, kind: task.kind, title: task.title, dueAt: task.dueAt ?? null, dueHasTime: task.dueHasTime ?? false };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

export type ActionType = TaskAction["type"];
export const ACTION_TYPES: ActionType[] = ["create", "complete", "cancel", "reschedule", "merge"];

export interface LabeledCreatePrediction {
  decision: "accepted" | "rejected";
  /** Whether the candidate replay proposed this labeled create. */
  predicted: boolean;
  /** Owner edits mean the initial proposal needed correction; keep this visible in the report. */
  edited: boolean;
}

export interface LabeledCreateEvaluation {
  samples: number;
  accepted: number;
  rejected: number;
  editedAccepted: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  trueNegatives: number;
  precision: number | null;
  recall: number | null;
}

/**
 * One owner Review decision on a create, as stored for calibration (packages/db `listTaskCalibrationLabels`),
 * reduced to what a replay needs. The source messages rebuild the working memory for a candidate
 * model or prompt; this helper then judges the replay's output.
 */
export interface LabeledCreate {
  decision: "accepted" | "rejected";
  edited: boolean;
  action: Pick<Extract<TaskAction, { type: "create" }>, "title" | "evidenceMessageIds">;
}

/**
 * Whether a replay would have created the labeled task automatically: an unambiguous create at or above
 * the threshold that cites the same evidence or proposes the same title. With threshold 0 this measures
 * proposals rather than automatic creation.
 */
export function replayPrediction(label: LabeledCreate, replayActions: readonly TaskAction[], threshold: number): LabeledCreatePrediction {
  const evidence = new Set(label.action.evidenceMessageIds);
  const title = label.action.title.trim().toLocaleLowerCase();
  const predicted = replayActions.some(
    (action) =>
      action.type === "create" &&
      action.ambiguityReasons.length === 0 &&
      action.confidence >= threshold &&
      (action.evidenceMessageIds.some((id) => evidence.has(id)) || action.title.trim().toLocaleLowerCase() === title),
  );
  return { decision: label.decision, edited: label.edited, predicted };
}

/** Scores candidate-model replays against the owner's persisted create decisions. */
export function scoreLabeledCreatePredictions(samples: readonly LabeledCreatePrediction[]): LabeledCreateEvaluation {
  const accepted = samples.filter((sample) => sample.decision === "accepted");
  const rejected = samples.filter((sample) => sample.decision === "rejected");
  const truePositives = accepted.filter((sample) => sample.predicted).length;
  const falseNegatives = accepted.length - truePositives;
  const falsePositives = rejected.filter((sample) => sample.predicted).length;
  const trueNegatives = rejected.length - falsePositives;
  return {
    samples: samples.length,
    accepted: accepted.length,
    rejected: rejected.length,
    editedAccepted: accepted.filter((sample) => sample.edited).length,
    truePositives,
    falsePositives,
    falseNegatives,
    trueNegatives,
    precision: ratio(truePositives, truePositives + falsePositives),
    recall: ratio(truePositives, truePositives + falseNegatives),
  };
}

export interface CaseScore {
  caseId: string;
  truePositives: Record<ActionType, number>;
  falsePositives: Record<ActionType, number>;
  falseNegatives: Record<ActionType, number>;
  /** Matched creates/reschedules whose due date (and time, when expected) was right / checked. */
  dueCorrect: number;
  dueChecked: number;
  /** For cases that expect no action: true when none was returned. */
  noActionCorrect: boolean | null;
  problems: string[];
}

const zero = (): Record<ActionType, number> => ({ create: 0, complete: 0, cancel: 0, reschedule: 0, merge: 0 });

function matches(expected: ExpectedAction, actual: TaskAction): boolean {
  if (expected.type !== actual.type) return false;
  switch (expected.type) {
    case "create":
      return actual.type === "create" && actual.kind === expected.kind;
    case "merge":
      return actual.type === "merge" && [...actual.taskIds].sort().join() === [...expected.taskIds].sort().join();
    default:
      return "taskId" in actual && actual.taskId === expected.taskId;
  }
}

function dueMatches(expected: ExpectedAction, actual: TaskAction): boolean | null {
  if (expected.type === "create" && actual.type === "create") {
    if (expected.dueDate === undefined) return null;
    if (expected.dueDate === null) return actual.dueAt === null;
    if (!actual.dueAt) return false;
    const local = toLocal(new Date(actual.dueAt), EVAL_SETTINGS.timezone);
    if (local.date !== expected.dueDate) return false;
    if (expected.dueTime === undefined) return true;
    return expected.dueTime === null ? !actual.dueHasTime : actual.dueHasTime && local.time === expected.dueTime;
  }
  if (expected.type === "reschedule" && actual.type === "reschedule") {
    const local = toLocal(new Date(actual.dueAt), EVAL_SETTINGS.timezone);
    if (local.date !== expected.dueDate) return false;
    if (expected.dueTime === undefined) return true;
    return expected.dueTime === null ? !actual.dueHasTime : actual.dueHasTime && local.time === expected.dueTime;
  }
  return null;
}

export function scoreCase(evalCase: EvalCase, actions: readonly TaskAction[]): CaseScore {
  const score: CaseScore = {
    caseId: evalCase.id,
    truePositives: zero(),
    falsePositives: zero(),
    falseNegatives: zero(),
    dueCorrect: 0,
    dueChecked: 0,
    noActionCorrect: evalCase.expected.length === 0 ? actions.length === 0 : null,
    problems: [],
  };
  const unmatched = [...actions];
  for (const expected of evalCase.expected) {
    const index = unmatched.findIndex((actual) => matches(expected, actual));
    if (index === -1) {
      score.falseNegatives[expected.type] += 1;
      score.problems.push(`missed ${expected.type}${"taskId" in expected ? ` ${expected.taskId}` : ""}`);
      continue;
    }
    const [actual] = unmatched.splice(index, 1);
    score.truePositives[expected.type] += 1;
    const due = dueMatches(expected, actual!);
    if (due !== null) {
      score.dueChecked += 1;
      if (due) score.dueCorrect += 1;
      else score.problems.push(`wrong due on ${expected.type}: got ${"dueAt" in actual! ? actual.dueAt : "?"}`);
    }
    if (expected.type === "create" && expected.contextId !== undefined && actual!.type === "create" && actual!.contextId !== expected.contextId) {
      score.problems.push(`context: expected ${expected.contextId}, got ${actual!.contextId}`);
    }
    if (expected.type === "create" && expected.handled !== undefined && actual!.type === "create") {
      const handled = actual!.alreadyHandled?.status ?? null;
      if (handled !== expected.handled) score.problems.push(`handled: expected ${expected.handled}, got ${handled}`);
    }
  }
  for (const extra of unmatched) {
    score.falsePositives[extra.type] += 1;
    score.problems.push(`unexpected ${extra.type}${"taskId" in extra ? ` ${extra.taskId}` : ""}`);
  }
  return score;
}

export interface EvalSummary {
  cases: number;
  perType: Record<ActionType, { tp: number; fp: number; fn: number; precision: number | null; recall: number | null }>;
  dueAccuracy: number | null;
  noActionAccuracy: number | null;
}

const ratio = (numerator: number, denominator: number) => (denominator === 0 ? null : numerator / denominator);

export function summarize(scores: readonly CaseScore[]): EvalSummary {
  const perType = Object.fromEntries(
    ACTION_TYPES.map((type) => {
      const tp = scores.reduce((sum, score) => sum + score.truePositives[type], 0);
      const fp = scores.reduce((sum, score) => sum + score.falsePositives[type], 0);
      const fn = scores.reduce((sum, score) => sum + score.falseNegatives[type], 0);
      return [type, { tp, fp, fn, precision: ratio(tp, tp + fp), recall: ratio(tp, tp + fn) }];
    }),
  ) as EvalSummary["perType"];
  const noAction = scores.filter((score) => score.noActionCorrect !== null);
  return {
    cases: scores.length,
    perType,
    dueAccuracy: ratio(
      scores.reduce((sum, score) => sum + score.dueCorrect, 0),
      scores.reduce((sum, score) => sum + score.dueChecked, 0),
    ),
    noActionAccuracy: ratio(noAction.filter((score) => score.noActionCorrect).length, noAction.length),
  };
}

const pct = (value: number | null) => (value === null ? "   n/a" : `${(value * 100).toFixed(1).padStart(5)}%`);

export function formatSummary(summary: EvalSummary): string {
  const lines = [`Cases: ${summary.cases}`, "type        tp  fp  fn  precision  recall"];
  for (const type of ACTION_TYPES) {
    const row = summary.perType[type];
    if (row.tp + row.fp + row.fn === 0) continue;
    lines.push(
      `${type.padEnd(10)} ${String(row.tp).padStart(3)} ${String(row.fp).padStart(3)} ${String(row.fn).padStart(3)}     ${pct(row.precision)}  ${pct(row.recall)}`,
    );
  }
  lines.push(`due date accuracy (matched creates/reschedules): ${pct(summary.dueAccuracy)}`);
  lines.push(`no-action cases correct: ${pct(summary.noActionAccuracy)}`);
  return lines.join("\n");
}
