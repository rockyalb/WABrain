import type { ChangeNotifier, Database, TaskService } from "@wabrain/db";
import type { OpenWaHistoryPage } from "@wabrain/openwa-adapter";
import type { ProviderSource } from "../providers.js";
import type { DebounceOptions, EnqueueOptions, JobLogger } from "../queue.js";
import type { JobData, JobName } from "../registry.js";
import type { PipelineConfig } from "./config.js";

/** The read-only OpenWA stored-media endpoint (OpenWaReadClient satisfies it). */
export interface MediaSource {
  getStoredMedia(sessionId: string, chatId: string, messageId: string, options?: { signal?: AbortSignal }): Promise<Response>;
}

/** The owner's saved phone contacts (OpenWaReadClient satisfies it). */
export interface ContactSource {
  listSavedContacts(sessionId: string): Promise<Array<{ jid: string; name: string }>>;
}

export interface HistorySource {
  listStoredMessages(sessionId: string, options?: { limit?: number; after?: string }): Promise<OpenWaHistoryPage>;
}

/** Pushes due durable notifications and retries failed ones (PushNotifier satisfies it). */
export interface ScheduledPushSender {
  flushPending(now?: Date): Promise<unknown>;
}

export interface PipelineQueue {
  enqueue<N extends JobName>(name: N, data: JobData<N>, options?: EnqueueOptions): Promise<string | null>;
  debounceChat(chatId: string, options?: DebounceOptions): Promise<void>;
}

export interface PipelineDeps {
  database: Database;
  queue: PipelineQueue;
  providers: ProviderSource;
  /** TaskService wired to the push notifier: applied changes emit sync, review items emit review pushes. */
  tasks: TaskService;
  /** Change notifications outside TaskService (profile updates): coalesced sync pushes. */
  notifier: ChangeNotifier;
  /** Durable notification delivery (reminders, summaries, Review items), flushed by notify-tick. */
  push: ScheduledPushSender;
  /** Null when OpenWA read access is not configured: media is then skipped with a reason. */
  media: MediaSource | null;
  /** Same read-only OpenWA connection, used for persisted-message history. */
  history?: HistorySource | null;
  /** Same read-only OpenWA connection, used for the owner's saved contact names. */
  contacts?: ContactSource | null;
  logger: JobLogger;
  config: PipelineConfig;
  now: () => Date;
}
