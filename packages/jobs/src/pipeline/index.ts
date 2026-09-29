/**
 * The live processing pipeline: builds its dependencies and registers the analysis, media, profile,
 * notification, and embedding handlers on the job queue.
 */
import { OpenWaReadClient } from "@wabrain/openwa-adapter";
import type { Providers, ProvidersConfig } from "@wabrain/agent";
import { TaskService, listChatsWithStaleUnanalyzed, type Database } from "@wabrain/db";
import { createPush, type PushNotifier, type PushSender } from "@wabrain/notify";
import { ProviderRegistry, type ProviderSource } from "../providers.js";
import type { JobLogger, JobQueue } from "../queue.js";
import { runChatAnalysis } from "./analysis.js";
import type { PipelineConfig } from "./config.js";
import type { MediaSource, PipelineDeps } from "./deps.js";
import { runChatEmbedding, sweepEmbeddings } from "./embeddings.js";
import { syncContacts } from "./contacts.js";
import { processMedia } from "./media.js";
import { runNotificationTick } from "./notifications.js";
import { runChatProfile, sweepProfiles } from "./profile.js";

export interface BuildPipelineOptions {
  database: Database;
  queue: JobQueue;
  logger: JobLogger;
  config: PipelineConfig;
  env?: Record<string, string | undefined>;
  /** Parsed APP_ENCRYPTION_KEY (needed when provider API keys are stored in the database). */
  encryptionKey: Buffer | null;
  /** Read-only OpenWA access for media; null skips media with a recorded reason. */
  openwa?: { baseUrl: string; apiKey: string } | null;
  /** Hostname exempt from the push SSRF private-address check (self-hosted ntfy). */
  ntfyHost?: string | null;
  vapidSubject?: string;
  now?: () => Date;
  /** Test seams. */
  providers?: ProviderSource;
  providerFactory?: (config: ProvidersConfig) => Providers;
  media?: MediaSource | null;
  pushFetch?: typeof fetch;
  syncIntervalMs?: number;
}

export interface Pipeline {
  deps: PipelineDeps;
  notifier: PushNotifier;
  sender: PushSender;
}

export async function buildPipeline(options: BuildPipelineOptions): Promise<Pipeline> {
  const { database, logger } = options;
  const { notifier, sender } = await createPush({
    now: options.now,
    database,
    allowHost: options.ntfyHost ?? null,
    vapidSubject: options.vapidSubject,
    logger,
    fetch: options.pushFetch,
    syncIntervalMs: options.syncIntervalMs,
  });
  const now = options.now ?? (() => new Date());
  const tasks = new TaskService({
    database,
    notifier,
    now,
    onNotifyError: (error) => logger.warn("notifier failed", { error: error instanceof Error ? error.name : "error" }),
  });
  const openwa = options.openwa ? new OpenWaReadClient(options.openwa.baseUrl, options.openwa.apiKey) : null;
  const media =
    options.media !== undefined
      ? options.media
      : openwa;
  const providers =
    options.providers ??
    new ProviderRegistry({ database, env: options.env, encryptionKey: options.encryptionKey, factory: options.providerFactory });
  return {
    notifier,
    sender,
    deps: { database, queue: options.queue, providers, tasks, notifier, push: notifier, media, history: openwa, contacts: openwa, logger, config: options.config, now },
  };
}

const HANDLERS = ["analyze-chat", "process-media", "profile-chat", "profile-sweep", "notify-tick", "embed-chat", "embed-sweep", "sync-contacts"] as const;

/**
 * Registers the pipeline handlers, the per-minute notification tick, the 10-minute profile sweep,
 * the 5-minute embedding sweep, and the weekly contact-name sync.
 */
export async function registerPipeline(queue: JobQueue, deps: PipelineDeps, options: { mediaConcurrency?: number; analysisConcurrency?: number } = {}) {
  await queue.work(
    "analyze-chat",
    async ({ chatId }) => {
      const outcome = await runChatAnalysis(deps, chatId);
      if (outcome.status !== "analyzed") deps.logger.info("analysis not run", { chatId, status: outcome.status });
    },
    { concurrency: options.analysisConcurrency ?? 2, pollingIntervalSeconds: 1 },
  );
  await queue.work(
    "process-media",
    async ({ mediaObjectId }) => {
      await processMedia(deps, mediaObjectId);
    },
    { concurrency: options.mediaConcurrency ?? 2, pollingIntervalSeconds: 1 },
  );
  await queue.work(
    "profile-chat",
    async ({ chatId }) => {
      const outcome = await runChatProfile(deps, chatId);
      if (outcome.status === "skipped") deps.logger.info("profile skipped", { chatId, reason: outcome.reason });
    },
    { concurrency: 1, pollingIntervalSeconds: 5 },
  );
  await queue.work("profile-sweep", async () => {
    await sweepProfiles(deps, queue, deps.now());
  });
  await queue.schedule("profile-sweep", "*/10 * * * *", {});
  await queue.work("notify-tick", async () => {
    await runNotificationTick(deps, deps.now());
  });
  await queue.schedule("notify-tick", "* * * * *", {});
  await queue.work(
    "embed-chat",
    async ({ chatId }) => {
      const outcome = await runChatEmbedding(deps, chatId);
      if (outcome.status !== "done") deps.logger.info("embedding not run", { chatId, status: outcome.status });
    },
    { concurrency: 1, pollingIntervalSeconds: 5 },
  );
  await queue.work("embed-sweep", async () => {
    await sweepEmbeddings(deps, queue, deps.now());
  });
  await queue.schedule("embed-sweep", "*/5 * * * *", {});
  await queue.work("sync-contacts", async ({ sessionId }) => {
    const outcome = await syncContacts(deps, sessionId);
    if (outcome.status === "skipped") deps.logger.info("contacts not synced", { reason: outcome.reason });
  });
  // Weekly (Monday 04:00 UTC), and once now so a restart picks up renamed contacts.
  await queue.schedule("sync-contacts", "0 4 * * 1", {});
  await queue.enqueue("sync-contacts", {}, { singletonKey: "sync-contacts" });
  return {
    async stop() {
      for (const name of HANDLERS) await queue.boss.offWork(name, { wait: true }).catch(() => queue.boss.offWork(name));
    },
  };
}

/**
 * Re-debounces chats whose analyzable messages have waited too long without a queued job (a lost
 * enqueue, or a provider that was configured later). Called by maintenance.
 */
export async function sweepStaleAnalysis(deps: Pick<PipelineDeps, "database" | "logger">, queue: JobQueue, now: Date, olderThanMs: number): Promise<number> {
  const chatIds = await listChatsWithStaleUnanalyzed(deps.database.db, new Date(now.getTime() - olderThanMs));
  let queued = 0;
  for (const chatId of chatIds) {
    const [pending] = await queue.findJobs("analyze-chat", { key: chatId, queued: true });
    if (pending) continue;
    await queue.debounceChat(chatId, { delayMs: 1000 });
    queued += 1;
  }
  if (queued) deps.logger.warn("re-queued stale chat analyses", { chats: queued });
  return queued;
}
