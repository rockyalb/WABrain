/**
 * Operator commands for jobs that exhausted their retries. Run on demand; never loaded by the API
 * or worker runtime. Output never contains job payload text, exception messages, or credentials.
 *
 *   failures [--queue <name>] [--limit <n>] [--json]   list dead-lettered jobs, newest first
 *   retry <failed-job-id>                              move one of them back to its queue
 *   requeue-media                                      retry media OpenWA had no file for (not_found)
 */
import { createDatabase } from "@wabrain/db";
import {
  JobQueue,
  jobNames,
  listFailedJobs,
  requeueUnavailableMedia,
  retryFailedJob,
  type FailedJobsReport,
  type JobName,
} from "@wabrain/jobs";

const USAGE = `Usage (DATABASE_URL must be set):
  operations failures [--queue <name>] [--limit <1-200>] [--json]
  operations retry <failed-job-id>
  operations requeue-media

Queues: ${jobNames.join(", ")}
In the compose bundle: docker compose exec worker node dist/operations.js failures`;

interface Parsed {
  command: "failures" | "retry" | "requeue-media";
  id?: string;
  queue?: JobName;
  limit?: number;
  json: boolean;
}

export function parseArgs(argv: readonly string[]): Parsed | null {
  const [command, ...rest] = argv;
  if (command === "retry") return rest.length === 1 && rest[0] ? { command, id: rest[0], json: false } : null;
  if (command === "requeue-media") return rest.length === 0 ? { command, json: false } : null;
  if (command !== "failures") return null;
  const parsed: Parsed = { command, json: false };
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === "--json") parsed.json = true;
    else if (flag === "--queue" && jobNames.includes(rest[index + 1] as JobName)) parsed.queue = rest[++index] as JobName;
    else if (flag === "--limit" && /^\d{1,3}$/.test(rest[index + 1] ?? "")) parsed.limit = Number(rest[++index]);
    else return null;
  }
  return parsed;
}

export function formatReport(report: FailedJobsReport): string {
  const counts = Object.entries(report.counts);
  if (counts.length === 0) return "No failed jobs are waiting.";
  const lines = [`Waiting failed jobs: ${counts.map(([queue, count]) => `${queue} ${count}`).join(", ")}`, ""];
  for (const item of report.items) {
    const subject = Object.entries(item.subject).map(([key, value]) => `${key}=${value}`).join(" ");
    lines.push(`${item.failedAt}  ${item.id}  ${item.queue}  attempts=${item.attempts}${subject ? `  ${subject}` : ""}`);
    lines.push(`    ${item.reason}`);
  }
  lines.push("", "Fix the cause first, then retry one job with: operations retry <id>");
  return lines.join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const url = process.env.DATABASE_URL;
  if (!args || !url) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const database = createDatabase(url);
  let queue: JobQueue | undefined;
  try {
    if (args.command === "failures") {
      const report = await listFailedJobs(database, { queue: args.queue, limit: args.limit });
      console.log(args.json ? JSON.stringify(report, null, 2) : formatReport(report));
      return;
    }
    // No maintenance or cron in this short-lived process; the running worker picks the job up.
    queue = new JobQueue({ connectionString: url, supervise: false, max: 2 });
    await queue.start();
    if (args.command === "requeue-media") {
      const count = await requeueUnavailableMedia(database, queue);
      console.log(count ? `Queued ${count} media item(s) OpenWA had no file for; the worker retries them.` : "No media is waiting for a retry.");
      return;
    }
    const result = await retryFailedJob(database, queue, args.id!);
    console.log(
      result.jobId
        ? `Queued ${result.queue} job ${result.jobId}; the worker runs it with fresh retries.`
        : `An equivalent ${result.queue} job was already queued; removed the failed entry.`,
    );
  } catch (error) {
    // Messages from listFailedJobs/retryFailedJob are fixed text; anything else may carry details.
    const known = error instanceof Error && /^(Unknown queue|The failed job id|No waiting failed job|The stored payload)/.test(error.message);
    console.error(known ? (error as Error).message : "Operation failed. Check DATABASE_URL, database health and migrations.");
    process.exitCode = 1;
  } finally {
    await queue?.stop({ graceful: false, timeoutMs: 2_000 });
    await database.close();
  }
}

// Run only as a command (tsx src/operations.ts, node dist/operations.js), not when imported by tests.
if (/operations\.(js|ts)$/.test(process.argv[1] ?? "")) await main();
