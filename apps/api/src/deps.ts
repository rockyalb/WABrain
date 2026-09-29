import type { Providers, ProvidersConfig } from "@wabrain/agent";
import type { ChangeNotifier, Database, IntakeFilter, TaskService } from "@wabrain/db";
import type { JobQueue, ProviderSource } from "@wabrain/jobs";
import type { AppConfig } from "./config.js";
import type { Logger } from "./logger.js";
import type { RateLimiterFactory } from "./security/rate-limit.js";

export interface AppDeps {
  config: AppConfig;
  database: Database;
  /** Only `enqueue` is used by the API (transactional webhook → project-event). */
  queue: Pick<JobQueue, "enqueue">;
  tasks: TaskService;
  notifier: ChangeNotifier;
  intakeFilter: IntakeFilter;
  logger: Logger;
  rateLimiters: RateLimiterFactory;
  /** Environment for the model provider fallback (AI_TEXT_*, ...), as the worker reads it. */
  providerEnv: Record<string, string | undefined>;
  /** Builds the AI SDK models for POST /setup/providers/test (tests inject mock providers). */
  providerFactory: (config: ProvidersConfig) => Providers;
  /** The configured models as the worker sees them (stored settings, then the environment), for POST /v1/ask. */
  providers: ProviderSource;
  now: () => Date;
}

export type AppEnv = {
  Variables: {
    requestId: string;
    /** "owner", "device:<id>", or "anonymous". */
    principal: string;
    deviceId: string | undefined;
    clientIp: string;
  };
};
