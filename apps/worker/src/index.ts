/**
 * Worker process: applies migrations, then runs durable jobs: event projection, maintenance, and
 * the live pipeline (analysis, media, profiles, reminders, daily summary) with Web Push delivery.
 * The same runtime runs inside the API when EMBEDDED_WORKER=true (see ./runtime.ts).
 */
import { createDatabase, ensureDefaults, runMigrations } from "@wabrain/db";
import { JobQueue } from "@wabrain/jobs";
import { createRulesIntakeFilter } from "@wabrain/rules";
import { z } from "zod";
import { pipelineEnvFrom, startPipelineWorker, WorkerConfigError, type PipelineEnv } from "./runtime.js";

const csv = z
  .string()
  .optional()
  .transform((value) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean));

const env = z
  .object({
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/ }),
    SELF_JID: csv,
    SELF_ALIASES: csv,
    // The same spellings the API accepts (apps/api/src/config.ts), so one shared value works for both.
    RUN_MIGRATIONS: z
      .enum(["true", "false", "1", "0", "yes", "no"])
      .default("true")
      .transform((value) => ["true", "1", "yes"].includes(value)),
    LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  })
  .safeParse(process.env);

let pipelineEnv: PipelineEnv | null = null;
const issues = env.success ? [] : env.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
try {
  pipelineEnv = pipelineEnvFrom(process.env);
} catch (error) {
  if (!(error instanceof WorkerConfigError)) throw error;
  issues.push(...error.issues);
}
if (!env.success || !pipelineEnv) {
  console.error(`Invalid configuration:\n  ${issues.join("\n  ")}`);
  process.exit(78);
}
const config = env.data;
const levels = ["debug", "info", "warn", "error"];
const log =
  (level: string) =>
  (message: string, fields?: Record<string, unknown>): void => {
    if (levels.indexOf(level) < levels.indexOf(config.LOG_LEVEL)) return;
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, msg: message, ...fields })}\n`);
  };
const logger = { info: log("info"), warn: log("warn"), error: log("error") };

const database = createDatabase(config.DATABASE_URL);
if (config.RUN_MIGRATIONS) await runMigrations(database);
await ensureDefaults(database.db);

const queue = new JobQueue({ connectionString: config.DATABASE_URL, logger });
await queue.start();
const worker = await startPipelineWorker({
  database,
  queue,
  logger,
  pipeline: pipelineEnv,
  filter: createRulesIntakeFilter({ ownerJids: config.SELF_JID, aliases: config.SELF_ALIASES }),
});
logger.info("pipeline ready", { media: Boolean(pipelineEnv.openwa) });

const shutdown = async (signal: string) => {
  logger.info("worker shutting down", { signal });
  await worker.stop();
  await queue.stop();
  await database.close();
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
