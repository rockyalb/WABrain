/**
 * Operator view of jobs that exhausted their retries. Every queue dead-letters into `dead.<name>`
 * (kept 30 days), so the dead-letter queues are the failure record: listing reads them without
 * exposing payload text or exception messages, and a retry moves one dead-lettered job back to its
 * queue after validating its payload.
 */
import type { Database } from "@wabrain/db";
import { pgBossDb, type JobQueue } from "./queue.js";
import { deadLetterName, jobNames, jobs, type JobName } from "./registry.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEAD_NAMES = jobNames.map(deadLetterName);
const SOURCE_BY_DEAD = new Map<string, JobName>(jobNames.map((name) => [deadLetterName(name), name]));

/** Never expose arbitrary exception text: providers can echo chat content, URLs or keys. */
export function failureSummary(output: unknown): string {
  const text = JSON.stringify(output ?? {}).toLowerCase();
  if (/timeout|timed out|deadline|expired/.test(text)) return "Timed out; inspect worker capacity and provider availability.";
  if (/429|rate.limit|budget/.test(text)) return "Provider rate limit or budget; wait for reset or adjust the configured limit.";
  if (/401|403|unauthor|api.key|authentication/.test(text)) return "Provider authorization failed; verify the configured key and permissions.";
  if (/econn|enotfound|network|fetch failed|outage|503/.test(text)) return "Connection or provider outage; verify connectivity before retrying.";
  if (/zod|validation|schema|invalid/.test(text)) return "Input or model output failed validation; inspect configuration and supported payload shape.";
  if (/postgres|database|deadlock|sql/.test(text)) return "Database operation failed; inspect database health and migration status.";
  return "Job exhausted its retries; inspect the worker logs around the failure time before retrying.";
}

/** Job payloads hold internal ids only; anything that is not a UUID is withheld. */
export function redactedSubject(data: unknown): Record<string, string> {
  if (!data || typeof data !== "object") return {};
  const subject: Record<string, string> = {};
  for (const [key, value] of Object.entries(data).slice(0, 5)) {
    subject[key] = typeof value === "string" && UUID.test(value) ? value : "[redacted]";
  }
  return subject;
}

export interface FailedJob {
  /** Id of the dead-letter entry: pass it to retryFailedJob. */
  id: string;
  queue: JobName;
  /** Id of the original job that failed. */
  sourceJobId: string | null;
  subject: Record<string, string>;
  /** Attempts made before the job was dead-lettered. */
  attempts: number;
  createdAt: string | null;
  failedAt: string;
  /** A fixed category: never the exception text. */
  reason: string;
}

export interface FailedJobsReport {
  /** Waiting dead-letter entries per queue (only queues with any). */
  counts: Partial<Record<JobName, number>>;
  /** The newest entries, at most `limit`. */
  items: FailedJob[];
}

export interface ListFailedJobsOptions {
  /** Only this queue. */
  queue?: JobName;
  /** Default 50, at most 200. */
  limit?: number;
  /** pg-boss schema. Default "pgboss". */
  schema?: string;
}

const iso = (value: unknown): string | null => (value ? new Date(value as string).toISOString() : null);

function assertQueue(name: string): JobName {
  if (!jobNames.includes(name as JobName)) throw new Error(`Unknown queue; expected one of: ${jobNames.join(", ")}`);
  return name as JobName;
}

/** Dead-lettered jobs, newest first, bounded and redacted. */
export async function listFailedJobs(database: Database, options: ListFailedJobsOptions = {}): Promise<FailedJobsReport> {
  const { sql } = database;
  const job = sql(`${options.schema ?? "pgboss"}.job`);
  const names = options.queue ? [deadLetterName(assertQueue(options.queue))] : DEAD_NAMES;
  const limit = Math.min(Math.max(1, Math.trunc(options.limit ?? 50)), 200);
  const [countRows, rows] = await Promise.all([
    sql<{ name: string; count: number }[]>`
      select name, count(*)::int as count from ${job}
      where name = any(${names}) and state < 'active' group by name`,
    sql<{ id: string; name: string; source_id: string | null; source_created_on: Date | null; source_retry_count: number | null; created_on: Date; data: unknown; output: unknown }[]>`
      select id, name, source_id, source_created_on, source_retry_count, created_on, data, output from ${job}
      where name = any(${names}) and state < 'active'
      order by created_on desc
      limit ${limit}`,
  ]);
  const counts: FailedJobsReport["counts"] = {};
  for (const row of countRows) counts[SOURCE_BY_DEAD.get(row.name)!] = row.count;
  return {
    counts,
    items: rows.map((row) => ({
      id: String(row.id),
      queue: SOURCE_BY_DEAD.get(row.name)!,
      sourceJobId: row.source_id ? String(row.source_id) : null,
      subject: redactedSubject(row.data),
      attempts: (row.source_retry_count ?? 0) + 1,
      createdAt: iso(row.source_created_on),
      failedAt: iso(row.created_on)!,
      reason: failureSummary(row.output),
    })),
  };
}

export interface RetryResult {
  queue: JobName;
  /** The new job, or null when an equivalent job was already queued (stately queues). */
  jobId: string | null;
}

/**
 * Moves one dead-lettered job back to its queue with fresh retries. The payload is validated
 * against the job's schema first; the enqueue and the removal from the dead-letter queue commit
 * together, so a retry is never lost and never doubled.
 */
export async function retryFailedJob(database: Database, queue: JobQueue, id: string, options: { schema?: string } = {}): Promise<RetryResult> {
  if (!UUID.test(id)) throw new Error("The failed job id must be a UUID (the id column of the failures list)");
  const table = `${options.schema ?? "pgboss"}.job`;
  return database.transaction(async ({ sql }) => {
    const job = sql(table);
    const [row] = await sql<{ name: string; data: unknown; singleton_key: string | null }[]>`
      select name, data, singleton_key from ${job}
      where id = ${id}::uuid and name = any(${DEAD_NAMES}) and state < 'active'
      for update`;
    if (!row) throw new Error("No waiting failed job with that id; it may already have been retried or expired");
    const name = SOURCE_BY_DEAD.get(row.name)!;
    const parsed = jobs[name].schema.safeParse(row.data);
    if (!parsed.success) throw new Error(`The stored payload no longer matches the ${name} job; not retried`);
    const jobId = await queue.boss.send(name, parsed.data as object, {
      ...(row.singleton_key ? { singletonKey: row.singleton_key } : {}),
      db: pgBossDb(sql),
    });
    await sql`delete from ${job} where id = ${id}::uuid and name = ${row.name}`;
    return { queue: name, jobId };
  });
}
