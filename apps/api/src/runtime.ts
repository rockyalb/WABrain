/** Wires config → database, job queue, push notifier, services → Hono app. */
import { createProviders } from "@wabrain/agent";
import {
  createDatabase,
  ensureDefaults,
  noopNotifier,
  runMigrations,
  TaskService,
  type ChangeNotifier,
  type Database,
  type IntakeFilter,
} from "@wabrain/db";
import { JobQueue, ProviderRegistry } from "@wabrain/jobs";
import { createPush } from "@wabrain/notify";
import { createRulesIntakeFilter } from "@wabrain/rules";
import { createApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { AppDeps } from "./deps.js";
import type { Logger } from "./logger.js";
import { inMemoryRateLimiters, type RateLimiterFactory } from "./security/rate-limit.js";

export interface RuntimeOverrides {
  database?: Database;
  queue?: AppDeps["queue"];
  notifier?: ChangeNotifier;
  intakeFilter?: IntakeFilter;
  rateLimiters?: RateLimiterFactory;
  providerEnv?: AppDeps["providerEnv"];
  providerFactory?: AppDeps["providerFactory"];
  providers?: AppDeps["providers"];
  now?: () => Date;
}

/** Push delivery options for startRuntime. */
export interface RuntimePushOptions {
  /** VAPID contact ("mailto:" or "https:") sent to push services. */
  vapidSubject?: string;
  /** Test seams: a fake push service and a shorter sync coalescing interval. */
  fetch?: typeof fetch;
  syncIntervalMs?: number;
}

export function buildDeps(config: AppConfig, logger: Logger, database: Database, queue: AppDeps["queue"], overrides: RuntimeOverrides = {}): AppDeps {
  const notifier = overrides.notifier ?? noopNotifier;
  const now = overrides.now ?? (() => new Date());
  const providerEnv = overrides.providerEnv ?? process.env;
  const providerFactory = overrides.providerFactory ?? createProviders;
  return {
    config,
    database,
    queue,
    notifier,
    logger,
    now,
    intakeFilter:
      overrides.intakeFilter ?? createRulesIntakeFilter({ ownerJids: config.selfJids, aliases: config.selfAliases }),
    rateLimiters: overrides.rateLimiters ?? inMemoryRateLimiters,
    providerEnv,
    providerFactory,
    providers:
      overrides.providers ?? new ProviderRegistry({ database, env: providerEnv, encryptionKey: config.encryptionKey, factory: providerFactory }),
    tasks: new TaskService({
      database,
      notifier,
      now,
      onNotifyError: (error) => logger.warn("notifier failed", { error }),
    }),
  };
}

/**
 * Boots the API: migrations, defaults, the job queue, and the Web Push notifier (VAPID keys are
 * generated and stored on first boot). TaskService and the routes share the notifier, so owner
 * actions made in the app push `sync`, and new Review items push `review`, to the owner's devices.
 */
export async function startRuntime(
  config: AppConfig,
  logger: Logger,
  options: { push?: RuntimePushOptions; overrides?: Omit<RuntimeOverrides, "database" | "queue" | "notifier"> } = {},
) {
  const database = createDatabase(config.databaseUrl);
  if (config.runMigrations) {
    await runMigrations(database);
    logger.info("migrations applied");
  }
  await ensureDefaults(database.db);
  const queue = new JobQueue({ connectionString: config.databaseUrl, supervise: config.embeddedWorker, logger });
  await queue.start();
  const { notifier: push } = await createPush({
    now: options.overrides?.now,
    database,
    allowHost: config.ntfyHost,
    vapidSubject: options.push?.vapidSubject,
    logger,
    fetch: options.push?.fetch,
    syncIntervalMs: options.push?.syncIntervalMs,
  });
  const deps = buildDeps(config, logger, database, queue, { ...options.overrides, notifier: push });
  return { deps, app: createApp(deps), database, queue, push };
}
