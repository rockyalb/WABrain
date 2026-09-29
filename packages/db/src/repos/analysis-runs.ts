/** Provenance of each analysis: provider, model, prompt version, usage, and decisions. */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../client.js";
import { newId } from "../ids.js";
import { analysisRuns } from "../schema.js";

export type AnalysisRunRow = typeof analysisRuns.$inferSelect;

export async function startAnalysisRun(
  db: Db,
  input: {
    chatId: string | null;
    provider?: string | null;
    model?: string | null;
    promptVersion?: string | null;
    inputMessageIds?: string[];
    fromMessageAt?: Date | null;
    toMessageAt?: Date | null;
    idempotencyKey?: string | null;
  },
): Promise<string> {
  const id = newId();
  await db.insert(analysisRuns).values({ id, ...input, inputMessageIds: input.inputMessageIds ?? [] });
  return id;
}

export async function finishAnalysisRun(
  db: Db,
  id: string,
  result: {
    status: "succeeded" | "failed";
    usage?: unknown;
    latencyMs?: number | null;
    actions?: unknown;
    decisions?: unknown;
    outcomes?: unknown;
    error?: string | null;
  },
): Promise<void> {
  await db
    .update(analysisRuns)
    .set({ ...result, finishedAt: sql`now()` })
    .where(eq(analysisRuns.id, id));
}

export async function findAnalysisRunByKey(db: Db, idempotencyKey: string): Promise<AnalysisRunRow | null> {
  const [row] = await db.select().from(analysisRuns).where(eq(analysisRuns.idempotencyKey, idempotencyKey));
  return row ?? null;
}

export async function getAnalysisRun(db: Db, id: string): Promise<AnalysisRunRow | null> {
  const [row] = await db.select().from(analysisRuns).where(eq(analysisRuns.id, id));
  return row ?? null;
}

/**
 * Stores the model's (validated) output and the policy decisions on a running run, before anything is
 * applied. A retried job reuses them instead of calling the model again.
 */
export async function recordAnalysisOutput(
  db: Db,
  id: string,
  output: {
    provider: string;
    model: string;
    promptVersion: string;
    usage: unknown;
    latencyMs: number;
    actions: unknown;
    decisions: unknown;
    dropped: unknown;
    contextReasons: unknown;
  },
): Promise<void> {
  await db
    .update(analysisRuns)
    .set({ ...output, error: null })
    .where(eq(analysisRuns.id, id));
}

export async function recordAnalysisError(db: Db, id: string, error: string): Promise<void> {
  await db.update(analysisRuns).set({ error: error.slice(0, 500) }).where(eq(analysisRuns.id, id));
}
