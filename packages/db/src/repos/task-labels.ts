/**
 * The owner's Review decisions on create proposals, as labels for evaluating models and prompts
 * (docs/SPEC.md, "Trial period").
 *
 * Every accepted or rejected create proposal is an `eval_examples` row tied to the analysis run that
 * proposed it, so each label belongs to one analysis profile: the text provider, the model that
 * answered, and the task-analysis prompt version. The labels no longer gate anything: whether a create
 * applies automatically is the trial and the automatic-change threshold alone. They are kept for
 * replaying a model or prompt against what the owner actually wanted.
 */
import { createHash } from "node:crypto";
import { TaskActionSchema, type TaskAction } from "@wabrain/contracts";
import { and, eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { analysisRuns, evalExamples } from "../schema.js";

export interface TaskAnalysisProfile {
  provider: string;
  model: string;
  promptVersion: string;
}

export interface LabeledCreateDecision {
  id: string;
  reviewItemId: string | null;
  analysisRunId: string;
  chatId: string | null;
  profileKey: string;
  provider: string;
  model: string;
  promptVersion: string;
  decision: "accepted" | "rejected";
  /** The create exactly as proposed (the model's confidence and ambiguity included). */
  action: Extract<TaskAction, { type: "create" }>;
  /** The create as accepted, with the owner's edits applied; null for rejections. */
  finalAction: TaskAction | null;
  edited: boolean;
  confidence: number;
  /** Messages the proposing run analyzed, for replaying the label against another model or prompt. */
  sourceMessageIds: string[];
  sourceWindowStartAt: string | null;
  createdAt: string;
}

/** Stable identity of the task-analysis provider/model/prompt tuple. */
export function taskAnalysisProfile(provider: string | null, model: string | null, promptVersion: string | null): string | null {
  if (!provider?.trim() || !model?.trim() || !promptVersion?.trim()) return null;
  const tuple = JSON.stringify([provider.trim(), model.trim(), promptVersion.trim()]);
  return `task-v1:${createHash("sha256").update(tuple).digest("hex")}`;
}

async function loadLabeledCreates(db: Db, profileKey?: string): Promise<LabeledCreateDecision[]> {
  const rows = await db
    .select({
      id: evalExamples.id,
      reviewItemId: evalExamples.reviewItemId,
      analysisRunId: evalExamples.analysisRunId,
      chatId: evalExamples.chatId,
      decision: evalExamples.decision,
      action: evalExamples.action,
      finalAction: evalExamples.finalAction,
      edits: evalExamples.edits,
      createdAt: evalExamples.createdAt,
      provider: analysisRuns.provider,
      model: analysisRuns.model,
      promptVersion: analysisRuns.promptVersion,
      inputMessageIds: analysisRuns.inputMessageIds,
      fromMessageAt: analysisRuns.fromMessageAt,
    })
    .from(evalExamples)
    .innerJoin(analysisRuns, eq(evalExamples.analysisRunId, analysisRuns.id))
    .where(and(eq(evalExamples.reviewType, "create"), eq(analysisRuns.status, "succeeded")))
    .orderBy(evalExamples.createdAt, evalExamples.id);

  return rows.flatMap((row) => {
    const resolvedProfile = taskAnalysisProfile(row.provider, row.model, row.promptVersion);
    const parsedAction = TaskActionSchema.safeParse(row.action);
    if (
      !resolvedProfile ||
      (profileKey !== undefined && resolvedProfile !== profileKey) ||
      !row.analysisRunId ||
      !parsedAction.success ||
      parsedAction.data.type !== "create"
    ) {
      return [];
    }
    const parsedFinal = row.finalAction === null ? null : TaskActionSchema.safeParse(row.finalAction);
    return [{
      id: row.id,
      reviewItemId: row.reviewItemId,
      analysisRunId: row.analysisRunId,
      chatId: row.chatId,
      profileKey: resolvedProfile,
      provider: row.provider!.trim(),
      model: row.model!.trim(),
      promptVersion: row.promptVersion!.trim(),
      decision: row.decision,
      action: parsedAction.data,
      finalAction: parsedFinal?.success ? parsedFinal.data : null,
      edited: row.edits !== null,
      // The action's own (double) confidence, not the rounded `real` column, so live comparisons match.
      confidence: parsedAction.data.confidence,
      sourceMessageIds: row.inputMessageIds ?? [],
      sourceWindowStartAt: row.fromMessageAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }];
  });
}

/** Owner labels for model/prompt regression replays, optionally for one profile. */
export async function listTaskCreateLabels(db: Db, profileKey?: string): Promise<LabeledCreateDecision[]> {
  return loadLabeledCreates(db, profileKey);
}
