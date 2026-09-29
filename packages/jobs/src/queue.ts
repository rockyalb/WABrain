/**
 * Postgres-backed job queue on pg-boss: typed enqueue/work, retries with
 * exponential backoff, dead-letter queues, per-key debounce, and
 * transactional enqueue from a postgres.js transaction.
 */
import { PgBoss, type Db as IDatabase, type Job, type JobWithMetadata, type QueueOptions } from "pg-boss";
import type { TransactionSql } from "postgres";
import { deadLetterName, jobNames, jobs, type JobData, type JobName } from "./registry.js";

export interface JobLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const consoleLogger: JobLogger = {
  info: () => {},
  warn: (message, fields) => console.warn(message, fields ?? ""),
  error: (message, fields) => console.error(message, fields ?? ""),
};

export interface JobQueueOptions {
  connectionString: string;
  /** Postgres schema for pg-boss tables. Default "pgboss". */
  schema?: string;
  /** Run pg-boss maintenance and cron scheduling in this process. Default true. */
  supervise?: boolean;
  logger?: JobLogger;
  max?: number;
  /** Per-queue overrides of the registry's retry/expiry settings (tests, tuning). */
  queueOverrides?: Partial<Record<JobName, QueueOptions>>;
}

export interface EnqueueOptions {
  singletonKey?: string;
  /** Seconds from now (database clock) or an absolute time. */
  startAfter?: number | Date;
  /** Enqueue inside this transaction, so the job exists iff the transaction commits. */
  tx?: TransactionSql;
}

export interface WorkOptions {
  /** Parallel handlers in this process. Default 2. */
  concurrency?: number;
  pollingIntervalSeconds?: number;
}

export interface DebounceOptions {
  /** Quiet period before the job may run. Default 90 s. */
  delayMs?: number;
  /** Upper bound on how long a continuously busy key can be postponed. Default 10 min. */
  maxWaitMs?: number;
}

export type JobHandler<N extends JobName> = (data: JobData<N>, job: Job<unknown>) => Promise<void>;

/** Adapts a postgres.js transaction to pg-boss's IDatabase. */
export function pgBossDb(tx: TransactionSql): IDatabase {
  return {
    executeSql: async (text: string, values?: unknown[]) => ({
      rows: await tx.unsafe(text, (values ?? []) as never[]),
    }),
  };
}

export class JobQueue {
  readonly boss: PgBoss;
  private readonly logger: JobLogger;
  private readonly overrides: Partial<Record<JobName, QueueOptions>>;
  private started = false;

  constructor(options: JobQueueOptions) {
    this.logger = options.logger ?? consoleLogger;
    this.overrides = options.queueOverrides ?? {};
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: options.schema ?? "pgboss",
      supervise: options.supervise ?? true,
      schedule: options.supervise ?? true,
      max: options.max ?? 5,
      application_name: "wabrain-jobs",
    });
    this.boss.on("error", (error: unknown) =>
      this.logger.error("job queue error", { error: error instanceof Error ? error.message : String(error) }),
    );
  }

  /** Starts pg-boss and creates every registered queue and its dead-letter queue. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.boss.start();
    for (const name of jobNames) {
      const definition = jobs[name];
      const dead = deadLetterName(name);
      await this.boss.createQueue(dead, { policy: "standard", retryLimit: 0, retentionSeconds: 30 * 86_400 });
      const { retryDelayMax: _ignored, ...settings } = { ...definition.options, ...this.overrides[name] };
      await this.boss.createQueue(name, {
        ...definition.options,
        ...this.overrides[name],
        policy: definition.policy,
        deadLetter: dead,
      });
      // createQueue keeps an existing queue's settings; bring them up to date.
      await this.boss.updateQueue(name, { ...settings, deadLetter: dead });
    }
    this.started = true;
  }

  async stop(options: { graceful?: boolean; timeoutMs?: number } = {}): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.boss.stop({ graceful: options.graceful ?? true, timeout: options.timeoutMs ?? 10_000 });
  }

  async enqueue<N extends JobName>(name: N, data: JobData<N>, options: EnqueueOptions = {}): Promise<string | null> {
    const payload = jobs[name].schema.parse(data) as object;
    return this.boss.send(name, payload, {
      singletonKey: options.singletonKey,
      startAfter: options.startAfter,
      ...(options.tx ? { db: pgBossDb(options.tx) } : {}),
    });
  }

  /**
   * Trailing-edge debounce: collapses repeated calls for `key` into one queued
   * job that becomes runnable only after `delayMs` without another call
   * (capped by `maxWaitMs` since the first call). Requires a queue policy with
   * a unique queued job per key (short/stately).
   */
  async debounce<N extends JobName>(name: N, key: string, data: JobData<N>, options: DebounceOptions = {}): Promise<void> {
    const delayMs = options.delayMs ?? 90_000;
    const maxWaitMs = options.maxWaitMs ?? 600_000;
    const payload = jobs[name].schema.parse(data) as object;
    let delaySeconds = delayMs / 1000;
    const [queued] = await this.boss.findJobs(name, { key, queued: true });
    if (queued?.createdOn) {
      const remaining = (queued.createdOn.getTime() + maxWaitMs - Date.now()) / 1000;
      delaySeconds = Math.max(0, Math.min(delaySeconds, remaining));
    }
    await this.boss.upsert(name, payload, { singletonKey: key, startAfter: delaySeconds });
  }

  /** Per-chat analysis debounce (default 90 s of quiet). */
  debounceChat(chatId: string, options: DebounceOptions = {}): Promise<void> {
    return this.debounce("analyze-chat", chatId, { chatId }, options);
  }

  /** Registers a handler. Throwing fails the job; pg-boss retries with backoff, then dead-letters it. */
  async work<N extends JobName>(name: N, handler: JobHandler<N>, options: WorkOptions = {}): Promise<string> {
    const schema = jobs[name].schema;
    return this.boss.work<unknown>(
      name,
      {
        batchSize: 1,
        localConcurrency: options.concurrency ?? 2,
        pollingIntervalSeconds: options.pollingIntervalSeconds ?? 2,
      },
      async (batch) => {
        for (const job of batch) {
          try {
            await handler(schema.parse(job.data) as JobData<N>, job);
          } catch (error) {
            this.logger.warn("job failed", {
              queue: name,
              jobId: job.id,
              error: error instanceof Error ? error.message : String(error),
            });
            throw error;
          }
        }
      },
    );
  }

  async schedule<N extends JobName>(name: N, cron: string, data: JobData<N>): Promise<void> {
    await this.boss.schedule(name, cron, jobs[name].schema.parse(data) as object, { tz: "UTC" });
  }

  /** Jobs that exhausted their retries, with their failure output. */
  async deadLetters(name: JobName): Promise<JobWithMetadata<unknown>[]> {
    return this.boss.findJobs(deadLetterName(name));
  }

  async findJobs(name: JobName, options: { key?: string; queued?: boolean } = {}) {
    return this.boss.findJobs(name, options);
  }
}
