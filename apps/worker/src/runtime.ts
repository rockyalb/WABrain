/**
 * Worker runtime, shared by the standalone worker process (./index.ts) and the API's embedded worker:
 * reads the pipeline environment, builds `PipelineDeps` (model providers, the Web Push notifier with
 * VAPID keys created on first boot, read-only OpenWA media access), and starts the job handlers so
 * projection, analysis, media, profile, reminder, and summary jobs all run.
 *
 * Import from "@wabrain/worker/runtime". This module has no side effects.
 */
import { EncryptionKeyError, parseEncryptionKey, type Database, type IntakeFilter } from "@wabrain/db";
import {
  buildPipeline,
  pipelineConfigFromEnv,
  startWorker,
  type BuildPipelineOptions,
  type JobLogger,
  type JobQueue,
  type Pipeline,
  type PipelineConfig,
} from "@wabrain/jobs";
import { z } from "zod";

type Env = Record<string, string | undefined>;

/** Everything the pipeline needs from the environment, parsed and validated. */
export interface PipelineEnv {
  config: PipelineConfig;
  /** Null when OPENWA_BASE_URL or OPENWA_READ_API_KEY is missing: media is then skipped with a reason. */
  openwa: { baseUrl: string; apiKey: string } | null;
  /** Self-hosted ntfy hostname, exempt from the push SSRF private-address check. */
  ntfyHost: string | null;
  /** VAPID contact ("mailto:" or "https:") sent to push services. */
  vapidSubject: string | undefined;
  /** Parsed APP_ENCRYPTION_KEY; null when unset (stored provider keys then fail closed). */
  encryptionKey: Buffer | null;
}

export class WorkerConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid configuration:\n  ${issues.join("\n  ")}`);
    this.name = "WorkerConfigError";
  }
}

const PipelineEnvSchema = z.object({
  OPENWA_BASE_URL: z.url({ protocol: /^https?$/ }).optional(),
  OPENWA_READ_API_KEY: z.string().min(1).optional(),
  NTFY_HOST: z.string().min(1).optional(),
  VAPID_SUBJECT: z
    .string()
    .regex(/^(mailto:\S+@\S+|https:\/\/\S+)$/, "must be a mailto: address or an https: URL")
    .optional(),
  APP_ENCRYPTION_KEY: z.string().optional(),
});

/** Parses the pipeline variables. Throws WorkerConfigError naming variables and reasons, never values. */
export function pipelineEnvFrom(env: Env): PipelineEnv {
  // Empty values (e.g. "OPENWA_READ_API_KEY=" in an env file) count as unset.
  const present = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ""));
  const issues: string[] = [];
  const parsed = PipelineEnvSchema.safeParse(present);
  if (!parsed.success) issues.push(...parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`));
  const config = pipelineConfigFromEnv(present);
  if (!config.success) issues.push(...config.issues);

  let encryptionKey: Buffer | null = null;
  if (present.APP_ENCRYPTION_KEY) {
    try {
      encryptionKey = parseEncryptionKey(present.APP_ENCRYPTION_KEY);
    } catch (error) {
      if (!(error instanceof EncryptionKeyError)) throw error;
      issues.push(`APP_ENCRYPTION_KEY: ${error.message}`);
    }
  }
  if (issues.length || !parsed.success || !config.success) throw new WorkerConfigError(issues);

  const value = parsed.data;
  return {
    config: config.config,
    openwa: value.OPENWA_BASE_URL && value.OPENWA_READ_API_KEY ? { baseUrl: value.OPENWA_BASE_URL.replace(/\/+$/, ""), apiKey: value.OPENWA_READ_API_KEY } : null,
    ntfyHost: value.NTFY_HOST?.toLowerCase() ?? null,
    vapidSubject: value.VAPID_SUBJECT,
    encryptionKey,
  };
}

/** Test seams forwarded to buildPipeline (mock providers, a fake push service, a fixed clock). */
export type PipelineOverrides = Pick<
  BuildPipelineOptions,
  "providers" | "providerFactory" | "media" | "pushFetch" | "syncIntervalMs" | "now"
>;

export interface StartPipelineWorkerOptions {
  database: Database;
  queue: JobQueue;
  filter: IntakeFilter;
  logger: JobLogger;
  pipeline: PipelineEnv;
  /** Environment for the provider fallback (AI_TEXT_*, ...). Default: process.env. */
  env?: Env;
  workerId?: string;
  overrides?: PipelineOverrides;
}

export interface PipelineWorker {
  pipeline: Pipeline;
  /** The server's VAPID public key (generated and stored on first boot). */
  vapidPublicKey: string;
  /** Stops the handlers and flushes pending pushes; the caller stops the queue and database. */
  stop(): Promise<void>;
}

/** Builds the pipeline (creating VAPID keys on first boot) and starts every job handler. */
export async function startPipelineWorker(options: StartPipelineWorkerOptions): Promise<PipelineWorker> {
  const { database, queue, logger } = options;
  const pipeline = await buildPipeline({
    database,
    queue,
    logger,
    config: options.pipeline.config,
    env: options.env,
    encryptionKey: options.pipeline.encryptionKey,
    openwa: options.pipeline.openwa,
    ntfyHost: options.pipeline.ntfyHost,
    vapidSubject: options.pipeline.vapidSubject,
    ...options.overrides,
  });
  if (!options.pipeline.openwa) logger.warn("OpenWA read access is not configured; media will be skipped", {});
  const worker = await startWorker({ database, queue, filter: options.filter, logger, workerId: options.workerId, pipeline: pipeline.deps });
  return {
    pipeline,
    vapidPublicKey: pipeline.sender.vapidPublicKey,
    async stop() {
      await worker.stop();
      await pipeline.notifier.flush();
    },
  };
}
