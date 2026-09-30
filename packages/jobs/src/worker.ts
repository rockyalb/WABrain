/**
 * Worker runtime: event projection, housekeeping, and a heartbeat; plus, when
 * a pipeline is given, the analysis, media, profile, and notification
 * handlers (see ./pipeline).
 */
import {
  listStaleUnprojected,
  listUnfinishedHistoryImports,
  failHistoryImport,
  markHistoryImportRunning,
  projectSourceEvent,
  purgeExpiredAuth,
  purgeExpiredIdempotencyKeys,
  recordHeartbeat,
  type Database,
  type IntakeFilter,
  type IntakeScheduler,
} from "@wabrain/db";
import { hostname } from "node:os";
import { registerPipeline, sweepStaleAnalysis } from "./pipeline/index.js";
import { runHistoryImport } from "./history-import.js";
import type { PipelineDeps } from "./pipeline/deps.js";
import type { JobLogger, JobQueue } from "./queue.js";
import { MEDIA_PRIORITY } from "./registry.js";

export const ANALYSIS_DEBOUNCE_MS = 90_000;
const STALE_EVENT_MS = 2 * 60_000;
const HEARTBEAT_MS = 30_000;
/** Analyzable messages older than this without a queued job are re-queued by maintenance. */
const STALE_ANALYSIS_MS = 15 * 60_000;

export interface WorkerOptions {
  database: Database;
  queue: JobQueue;
  filter: IntakeFilter;
  logger: JobLogger;
  workerId?: string;
  analysisDebounceMs?: number;
  /** Cap on how long a busy chat's analysis can be postponed (default 10 min). */
  analysisMaxWaitMs?: number;
  projectionConcurrency?: number;
  /** The live processing pipeline (analysis, media, profiles, reminders). Omit to run intake only. */
  pipeline?: PipelineDeps;
}

export function createIntakeScheduler(queue: JobQueue, analysisDebounceMs = ANALYSIS_DEBOUNCE_MS, analysisMaxWaitMs?: number): IntakeScheduler {
  return {
    debounceAnalysis: (chatId) => queue.debounceChat(chatId, { delayMs: analysisDebounceMs, maxWaitMs: analysisMaxWaitMs }),
    enqueueMedia: async (mediaObjectId) => {
      await queue.enqueue("process-media", { mediaObjectId }, { singletonKey: mediaObjectId, priority: MEDIA_PRIORITY.live });
    },
  };
}

/** Re-enqueues events whose projection was lost, and purges expired keys and sessions. */
export async function runMaintenance(database: Database, queue: JobQueue, now = new Date()): Promise<{ requeued: number }> {
  const stale = await listStaleUnprojected(database.db, new Date(now.getTime() - STALE_EVENT_MS));
  for (const sourceEventId of stale) await queue.enqueue("project-event", { sourceEventId });
  await purgeExpiredIdempotencyKeys(database.db, now);
  await purgeExpiredAuth(database.db, now);
  return { requeued: stale.length };
}

export async function startWorker(options: WorkerOptions): Promise<{ stop(): Promise<void> }> {
  const { database, queue, filter, logger } = options;
  const workerId = options.workerId ?? `${hostname()}:${process.pid}`;
  const pipeline = options.pipeline;
  const scheduler = createIntakeScheduler(
    queue,
    options.analysisDebounceMs ?? pipeline?.config.analysisDebounceMs,
    options.analysisMaxWaitMs ?? pipeline?.config.analysisMaxWaitMs,
  );

  await queue.work(
    "project-event",
    async ({ sourceEventId }) => {
      const result = await projectSourceEvent({ database, filter, scheduler }, sourceEventId);
      logger.info("event projected", { sourceEventId, status: result.status });
    },
    { concurrency: options.projectionConcurrency ?? 4, pollingIntervalSeconds: 1 },
  );
  await queue.work("maintenance", async () => {
    const { requeued } = await runMaintenance(database, queue);
    if (requeued) logger.warn("requeued unprojected events", { requeued });
    if (pipeline) await sweepStaleAnalysis(pipeline, queue, new Date(), STALE_ANALYSIS_MS);
    for (const sessionId of await listUnfinishedHistoryImports(database.db)) {
      await queue.enqueue("import-history", { sessionId }, { singletonKey: sessionId });
    }
  });
  await queue.schedule("maintenance", "* * * * *", {});
  const handlers = pipeline ? await registerPipeline(queue, pipeline) : null;
  await queue.work("import-history", async ({ sessionId }) => {
    if (!pipeline?.history) {
      const run = await markHistoryImportRunning(database.db, sessionId);
      if (run) await failHistoryImport(database.db, sessionId, run.generation, "OpenWA read access is not configured in the worker");
      return;
    }
    await runHistoryImport({ database, queue, filter, source: pipeline.history, logger }, sessionId);
  }, { concurrency: 1, pollingIntervalSeconds: 2 });

  const beat = () =>
    recordHeartbeat(database.db, workerId).catch((error: unknown) =>
      logger.warn("heartbeat failed", { error: error instanceof Error ? error.message : String(error) }),
    );
  await beat();
  const timer = setInterval(() => void beat(), HEARTBEAT_MS);
  timer.unref();
  logger.info("worker started", { workerId, pipeline: Boolean(pipeline) });

  return {
    /** Stops fetching new jobs and waits for running handlers (the queue's own stop drains the rest). */
    async stop() {
      clearInterval(timer);
      await queue.boss.offWork("project-event");
      await queue.boss.offWork("maintenance");
      await handlers?.stop();
      await queue.boss.offWork("import-history");
    },
  };
}
