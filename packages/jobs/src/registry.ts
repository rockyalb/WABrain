/**
 * Typed job registry. Each job has a queue policy, retry/backoff settings,
 * and a dead-letter queue (`dead.<name>`) that receives jobs whose retries
 * are exhausted, with the failure reason kept in the job output.
 */
import type { QueueOptions, QueuePolicy } from "pg-boss";
import { z } from "zod";

export interface JobDefinition<S extends z.ZodType = z.ZodType> {
  name: string;
  schema: S;
  policy: QueuePolicy;
  options: QueueOptions;
}

const define = <S extends z.ZodType>(
  name: string,
  schema: S,
  policy: QueuePolicy,
  options: QueueOptions,
): JobDefinition<S> => ({ name, schema, policy, options });

export const jobs = {
  /** Project one stored webhook event into chats/messages (packages/db projector). */
  "project-event": define("project-event", z.object({ sourceEventId: z.string().min(1) }), "standard", {
    retryLimit: 10,
    retryDelay: 2,
    retryBackoff: true,
    retryDelayMax: 600,
    expireInSeconds: 120,
  }),
  /**
   * Analyze a chat's new messages. `stately` + singletonKey=chatId gives at
   * most one queued and one running job per chat: runs are serialized per
   * chat, and debounce() keeps pushing the queued job's start time.
   */
  "analyze-chat": define("analyze-chat", z.object({ chatId: z.string().min(1) }), "stately", {
    retryLimit: 6,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 1800,
    expireInSeconds: 600,
  }),
  /** Describe/OCR/transcribe one media object (bounded attempts are also tracked on the row). */
  "process-media": define("process-media", z.object({ mediaObjectId: z.string().min(1) }), "stately", {
    retryLimit: 6,
    retryDelay: 20,
    retryBackoff: true,
    retryDelayMax: 1800,
    expireInSeconds: 600,
  }),
  /**
   * Person facts, languages, and context suggestion for a direct chat: one checkpointed batch of
   * unread messages (at most once per chat per day, except while a catch-up is running).
   */
  "profile-chat": define("profile-chat", z.object({ chatId: z.string().min(1) }), "stately", {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 600,
  }),
  /**
   * Person facts from one media object whose text arrived after profile-chat had already read past its
   * message (a voice note, image or PDF recovered after a failure). Facts only: never tasks.
   */
  "profile-media": define("profile-media", z.object({ mediaObjectId: z.string().min(1) }), "stately", {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 3600,
    expireInSeconds: 600,
  }),
  /**
   * Every 10 minutes: queue profile-chat for direct chats with unread messages that may run now
   * (deferred for a missing provider or the budget, failed, or imported history catching up).
   */
  "profile-sweep": define("profile-sweep", z.object({}).passthrough(), "stately", {
    retryLimit: 1,
    expireInSeconds: 300,
  }),
  /** Read OpenWA's persisted messages from a durable keyset checkpoint. */
  "import-history": define("import-history", z.object({ sessionId: z.string().min(1) }), "stately", {
    retryLimit: 5,
    retryDelay: 30,
    retryBackoff: true,
    retryDelayMax: 1800,
    expireInSeconds: 3600,
  }),
  /** Rebuild a chat's conversation windows and embed the ones the current model has not embedded. */
  "embed-chat": define("embed-chat", z.object({ chatId: z.string().min(1) }), "stately", {
    retryLimit: 3,
    retryDelay: 60,
    retryBackoff: true,
    retryDelayMax: 1800,
    expireInSeconds: 900,
  }),
  /** Every 5 minutes: queue embed-chat for chats with new content or stale vectors. */
  "embed-sweep": define("embed-sweep", z.object({}).passthrough(), "stately", {
    retryLimit: 1,
    expireInSeconds: 300,
  }),
  /**
   * Weekly, at worker start and after a history import: copy the owner's saved contact names from
   * OpenWA and apply them to people, chats and senders. `sessionId` defaults to the latest event's.
   */
  "sync-contacts": define("sync-contacts", z.object({ sessionId: z.string().min(1).optional() }).passthrough(), "stately", {
    retryLimit: 3,
    retryDelay: 120,
    retryBackoff: true,
    expireInSeconds: 600,
  }),
  /** Every minute: due-date reminders and the daily summary. */
  "notify-tick": define("notify-tick", z.object({}).passthrough(), "stately", {
    retryLimit: 1,
    expireInSeconds: 120,
  }),
  /** Periodic housekeeping: re-enqueue stale events, purge expired keys and sessions. */
  maintenance: define("maintenance", z.object({}).passthrough(), "stately", {
    retryLimit: 1,
    expireInSeconds: 300,
  }),
} as const;

export type JobName = keyof typeof jobs;
export type JobData<N extends JobName> = z.infer<(typeof jobs)[N]["schema"]>;

export const deadLetterName = (name: string) => `dead.${name}`;
export const jobNames = Object.keys(jobs) as JobName[];
