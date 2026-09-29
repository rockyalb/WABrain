/**
 * Persisted create-threshold calibration from the owner's Review decisions (docs/SPEC.md, "Trial period").
 *
 * Every accepted or rejected create proposal is an `eval_examples` row tied to the analysis run that
 * proposed it, so each label belongs to one analysis profile: the text provider, the model that
 * answered, and the task-analysis prompt version. A calibration is computed per profile and stored in
 * app_state. Auto-create stays in Review until the profile that is analyzing right now has a usable
 * calibration, so switching the model or prompt falls back to Review until the owner has labelled
 * enough of the new profile's proposals. This is a conservative operational gate, not a statistical
 * guarantee.
 */
import { createHash } from "node:crypto";
import { TaskActionSchema, type AutoCreateStatus, type TaskAction } from "@wabrain/contracts";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import type { Database, Db } from "../client.js";
import { getAppState, setAppState } from "./app-state.js";
import { analysisRuns, evalExamples } from "../schema.js";

export const TASK_CALIBRATION_STATE_KEY = "task.calibration";
/** Usable (unambiguous) create decisions needed for the profile before anything is created automatically. */
export const TASK_CALIBRATION_MIN_LABELS = 20;
export const TASK_CALIBRATION_MIN_ACCEPTED = 5;
export const TASK_CALIBRATION_MIN_REJECTED = 5;
/** Accepted-without-edits proposals needed at or above the calibrated threshold. */
export const TASK_CALIBRATION_MIN_UNEDITED_ACCEPTED_AT_THRESHOLD = 5;
/** Share of decisions at or above the threshold that the owner must have accepted. */
export const TASK_CALIBRATION_TARGET_PRECISION = 0.9;

export type TaskCalibrationReason = "insufficient_labels" | "no_reliable_threshold";

export interface TaskCalibrationProfile {
  provider: string;
  model: string;
  promptVersion: string;
}

export interface TaskCalibration extends TaskCalibrationProfile {
  profileKey: string;
  ready: boolean;
  /**
   * Lowest accepted confidence at which at least 90% of the decisions at or above it were accepted and
   * at least five of those were accepted unedited. A floor: policy uses the higher of this and the
   * configured (or per-chat) threshold. Null while not ready.
   */
  threshold: number | null;
  sampleCount: number;
  acceptedCount: number;
  rejectedCount: number;
  uneditedAcceptedAtThresholdCount: number;
  precisionAtThreshold: number | null;
  reason: TaskCalibrationReason | null;
  calibratedAt: string;
}

interface CalibrationState {
  version: 2;
  profiles: Record<string, TaskCalibration>;
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
export function taskCalibrationProfile(provider: string | null, model: string | null, promptVersion: string | null): string | null {
  if (!provider?.trim() || !model?.trim() || !promptVersion?.trim()) return null;
  const tuple = JSON.stringify([provider.trim(), model.trim(), promptVersion.trim()]);
  return `task-v1:${createHash("sha256").update(tuple).digest("hex")}`;
}

function asState(value: unknown): CalibrationState {
  if (!value || typeof value !== "object") return { version: 2, profiles: {} };
  const candidate = value as Partial<CalibrationState>;
  if (candidate.version !== 2 || !candidate.profiles || typeof candidate.profiles !== "object") {
    return { version: 2, profiles: {} };
  }
  return candidate as CalibrationState;
}

const validThreshold = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

async function storedCalibration(db: Db, profileKey: string): Promise<TaskCalibration | null> {
  const state = asState(await getAppState<unknown>(db, TASK_CALIBRATION_STATE_KEY));
  const calibration = state.profiles[profileKey];
  return calibration && calibration.profileKey === profileKey ? calibration : null;
}

/** The stored result for a profile, usable or not; null when the profile was never calibrated. */
export async function getTaskCalibrationResult(db: Db, profileKey: string | null): Promise<TaskCalibration | null> {
  return profileKey ? storedCalibration(db, profileKey) : null;
}

/** Returns a usable calibration only for the exact given model/prompt profile. */
export async function getTaskCalibration(db: Db, profileKey: string | null): Promise<TaskCalibration | null> {
  const calibration = await getTaskCalibrationResult(db, profileKey);
  if (!calibration?.ready || !validThreshold(calibration.threshold)) return null;
  return calibration;
}

/**
 * The usable calibration for the profile that is analyzing now. A profile that was never calibrated
 * (labels written before calibration existed, or a model switched back to) is calibrated from its
 * labels first, so existing decisions count without waiting for the next one.
 */
export async function resolveTaskCalibration(
  database: Database,
  profile: TaskCalibrationProfile,
  now = new Date(),
): Promise<TaskCalibration | null> {
  const profileKey = taskCalibrationProfile(profile.provider, profile.model, profile.promptVersion);
  if (!profileKey) return null;
  const stored = await storedCalibration(database.db, profileKey);
  const calibration = stored ?? (await database.transaction(({ db }) => calibrateTaskProfile(db, profile, now)));
  return calibration.ready && validThreshold(calibration.threshold) ? calibration : null;
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
    const resolvedProfile = taskCalibrationProfile(row.provider, row.model, row.promptVersion);
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

/**
 * Pure calibration over one profile's labels. Proposals the model flagged as ambiguous are left out:
 * policy never creates those automatically, so they say nothing about where the threshold belongs.
 *
 * Candidate thresholds are the confidences of accepted proposals, lowest first. The chosen one is the
 * lowest where at least 90% of the decisions at or above it were accepted and at least five of them were
 * accepted without edits. The profile is usable only after 20 such decisions with at least five accepted
 * and five rejected, so a trial where the owner never rejects anything does not activate auto-create.
 * One outlier rejection does not block activation forever: later acceptances above it can outweigh it.
 */
export function computeTaskCalibration(
  profile: TaskCalibrationProfile & { profileKey: string },
  labels: readonly Pick<LabeledCreateDecision, "decision" | "edited" | "confidence" | "action">[],
  now: Date,
): TaskCalibration {
  const usable = labels.filter(
    (label) => label.action.ambiguityReasons.length === 0 && Number.isFinite(label.confidence) && label.confidence >= 0 && label.confidence <= 1,
  );
  const accepted = usable.filter((label) => label.decision === "accepted");
  const rejected = usable.filter((label) => label.decision === "rejected");
  const base = {
    profileKey: profile.profileKey,
    provider: profile.provider,
    model: profile.model,
    promptVersion: profile.promptVersion,
    sampleCount: usable.length,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
    calibratedAt: now.toISOString(),
  };
  const notReady = (reason: TaskCalibrationReason): TaskCalibration => ({
    ...base,
    ready: false,
    threshold: null,
    uneditedAcceptedAtThresholdCount: 0,
    precisionAtThreshold: null,
    reason,
  });
  if (
    usable.length < TASK_CALIBRATION_MIN_LABELS ||
    accepted.length < TASK_CALIBRATION_MIN_ACCEPTED ||
    rejected.length < TASK_CALIBRATION_MIN_REJECTED
  ) {
    return notReady("insufficient_labels");
  }
  // Only accepted confidences are candidates, so the band just above the threshold starts with a proposal
  // the owner wanted rather than with rejections that high-confidence acceptances would average away.
  const candidates = [...new Set(accepted.map((label) => label.confidence))].sort((a, b) => a - b);
  for (const threshold of candidates) {
    const atOrAbove = usable.filter((label) => label.confidence >= threshold);
    const acceptedAbove = atOrAbove.filter((label) => label.decision === "accepted");
    const uneditedAbove = acceptedAbove.filter((label) => !label.edited).length;
    const precision = acceptedAbove.length / atOrAbove.length;
    if (precision >= TASK_CALIBRATION_TARGET_PRECISION && uneditedAbove >= TASK_CALIBRATION_MIN_UNEDITED_ACCEPTED_AT_THRESHOLD) {
      return {
        ...base,
        ready: true,
        threshold,
        uneditedAcceptedAtThresholdCount: uneditedAbove,
        precisionAtThreshold: precision,
        reason: null,
      };
    }
  }
  return notReady("no_reliable_threshold");
}

/**
 * Recomputes and persists one profile's calibration from its labels. Called in the transaction that
 * records an owner decision on a Review create, and lazily for a profile that has none yet.
 */
export async function calibrateTaskProfile(db: Db, profile: TaskCalibrationProfile, now = new Date()): Promise<TaskCalibration> {
  const profileKey = taskCalibrationProfile(profile.provider, profile.model, profile.promptVersion);
  if (!profileKey) throw new RangeError("provider, model and prompt version are required");
  // Serialize read-modify-write of the shared state across concurrent decision transactions.
  await db.execute(sql`select pg_advisory_xact_lock(hashtext('wabrain:task.calibration'))`);
  const labels = await loadLabeledCreates(db, profileKey);
  const calibration = computeTaskCalibration(
    { profileKey, provider: profile.provider.trim(), model: profile.model.trim(), promptVersion: profile.promptVersion.trim() },
    labels,
    now,
  );
  await storeTaskCalibration(db, calibration);
  return calibration;
}

/** Stores one profile's result, keeping the others. Callers hold the calibration lock (or are tests). */
export async function storeTaskCalibration(db: Db, calibration: TaskCalibration): Promise<void> {
  const state = asState(await getAppState<unknown>(db, TASK_CALIBRATION_STATE_KEY));
  await setAppState(db, TASK_CALIBRATION_STATE_KEY, {
    version: 2,
    profiles: { ...state.profiles, [calibration.profileKey]: calibration },
  } satisfies CalibrationState);
}

/** Owner labels for threshold calibration and model/prompt regression replays, optionally for one profile. */
export async function listTaskCalibrationLabels(db: Db, profileKey?: string): Promise<LabeledCreateDecision[]> {
  return loadLabeledCreates(db, profileKey);
}

/**
 * Why creates are or are not automatic right now, for the settings/status responses. The current
 * profile is the one the latest successful analysis run used; per-chat "auto-create off" is separate.
 */
export async function getAutoCreateStatus(db: Db, input: { inTrial: boolean; autoCreateThreshold: number }): Promise<AutoCreateStatus> {
  const [latest] = await db
    .select({ provider: analysisRuns.provider, model: analysisRuns.model, promptVersion: analysisRuns.promptVersion })
    .from(analysisRuns)
    .where(and(eq(analysisRuns.status, "succeeded"), isNotNull(analysisRuns.model)))
    .orderBy(desc(analysisRuns.startedAt))
    .limit(1);
  const profileKey = latest ? taskCalibrationProfile(latest.provider, latest.model, latest.promptVersion) : null;
  const calibration = await getTaskCalibrationResult(db, profileKey);
  const ready = Boolean(calibration?.ready && validThreshold(calibration.threshold));
  return {
    state: input.inTrial ? "trial" : ready ? "active" : "calibrating",
    profile: latest && profileKey ? { provider: latest.provider!, model: latest.model!, promptVersion: latest.promptVersion! } : null,
    calibration: {
      ready,
      reason: calibration ? calibration.reason : "insufficient_labels",
      threshold: ready ? calibration!.threshold : null,
      effectiveThreshold: ready ? Math.max(calibration!.threshold!, input.autoCreateThreshold) : null,
      decisions: calibration?.sampleCount ?? 0,
      accepted: calibration?.acceptedCount ?? 0,
      rejected: calibration?.rejectedCount ?? 0,
      calibratedAt: calibration?.calibratedAt ?? null,
    },
    required: {
      decisions: TASK_CALIBRATION_MIN_LABELS,
      accepted: TASK_CALIBRATION_MIN_ACCEPTED,
      rejected: TASK_CALIBRATION_MIN_REJECTED,
      uneditedAcceptedAtThreshold: TASK_CALIBRATION_MIN_UNEDITED_ACCEPTED_AT_THRESHOLD,
      precision: TASK_CALIBRATION_TARGET_PRECISION,
    },
  };
}
