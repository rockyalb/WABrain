/**
 * profile-chat: extracts person facts from a direct chat (owner-entered and verified facts are never
 * changed; self-claims stay unverified), refreshes the person's languages from the per-message language
 * tags, and suggests a default context for chats without one (contextConfirmed=false until the owner
 * confirms).
 *
 * Every message is read once, in checkpointed batches in storage order (see db profile-progress), so
 * imported history reaches the profile too, not only the latest messages:
 * - Normally at most one run per chat per local day. The day is recorded only after a successful
 *   extraction, so a retry after a model failure is not blocked.
 * - A catch-up (after a history import, or when a daily run finds more than one batch) continues batch
 *   after batch without the daily limit, leaving part of the text budget for live analysis.
 * - Without a text provider, or over budget, nothing is recorded: profile-sweep queues the chat again
 *   once it can run.
 */
import { extractPersonFacts, suggestChatContext, type ProfileMessageInput } from "@wabrain/agent";
import {
  applyProposedFacts,
  countPendingMedia,
  getChatRow,
  getPersonRow,
  getProfileProgress,
  getSettings,
  hasProfileBacklog,
  languageCounts,
  latestProfileKey,
  listChatsNeedingProfile,
  listContexts,
  listProfileBatch,
  listMessagesByIds,
  recordModelUsage,
  safeNotify,
  saveProfileProgress,
  setPersonLanguages,
  suggestChatDefaultContext,
  clearProfileTarget,
  withFacts,
  type ProfileMessageKey,
} from "@wabrain/db";
import { checkBudget, type BudgetCheck } from "./budget.js";
import type { PipelineDeps, PipelineQueue } from "./deps.js";
import { localDay } from "./time.js";

export type ProfileSkipReason = "chat_missing" | "not_direct" | "chat_off" | "up_to_date" | "already_today" | "no_provider" | "budget";

export type ProfileOutcome =
  | { status: "skipped"; reason: ProfileSkipReason }
  | { status: "waiting_media"; pending: number }
  | {
      status: "profiled";
      facts: number;
      languages: string[];
      contextSuggested: boolean;
      /** Messages read by this run. */
      messages: number;
      /** True when more batches follow (a catch-up is still running; the next one is queued). */
      more: boolean;
    };

/** Messages per extraction (one model call). */
export const PROFILE_BATCH_MESSAGES = 40;
/** A catch-up stops for the day at this share of a daily text limit, leaving the rest for analysis. */
export const PROFILE_CATCH_UP_BUDGET_SHARE = 0.8;
const LANGUAGE_WINDOW_MS = 90 * 86_400_000;
/** A language counts when it is at least this share of the person's tagged messages. */
const LANGUAGE_MIN_SHARE = 0.15;

export function languagesFromCounts(counts: ReadonlyArray<{ language: string; count: number }>): string[] {
  const total = counts.reduce((sum, entry) => sum + entry.count, 0);
  if (total === 0) return [];
  return counts
    .filter((entry) => entry.count >= 2 && entry.count / total >= LANGUAGE_MIN_SHARE)
    .sort((a, b) => b.count - a.count)
    .map((entry) => entry.language)
    .slice(0, 4);
}

/** Over the limit, or (for catch-up batches) over its share of the limit. */
function overBudget(budget: BudgetCheck, catchUp: boolean): boolean {
  if (budget.exceeded) return true;
  if (!catchUp) return false;
  const near = (used: number, limit: number | null) => limit !== null && used >= limit * PROFILE_CATCH_UP_BUDGET_SHARE;
  return near(budget.usedTokens, budget.tokenLimit) || near(budget.usedCalls, budget.callLimit);
}

export async function runChatProfile(deps: PipelineDeps, chatId: string): Promise<ProfileOutcome> {
  const { database } = deps;
  const db = database.db;
  const chat = await getChatRow(db, chatId).catch(() => null);
  if (!chat) return { status: "skipped", reason: "chat_missing" };
  if (chat.mode === "off") return { status: "skipped", reason: "chat_off" };
  if (chat.isGroup || !chat.personId) return { status: "skipped", reason: "not_direct" };

  const now = deps.now();
  const settings = await getSettings(db);
  const today = localDay(now, settings.timezone).date;
  const progress = await getProfileProgress(db, chatId);
  const catchUp = progress.target !== null;
  if (!catchUp && progress.lastProfileDate === today) return { status: "skipped", reason: "already_today" };
  let batch = await listProfileBatch(db, chatId, progress.cursor, PROFILE_BATCH_MESSAGES);
  if (batch.length === 0) {
    if (catchUp) await clearProfileTarget(db, chatId);
    return { status: "skipped", reason: "up_to_date" };
  }

  // Advancing past unfinished media would permanently omit its derived text. Leave both the
  // cursor and daily claim untouched; the periodic profile sweep retries after media settles.
  const pending = await countPendingMedia(db, batch.map((message) => message.id));
  if (pending > 0) return { status: "waiting_media", pending };
  // Media can finish after the first read. Reload those exact rows to see committed derived text.
  batch = await listMessagesByIds(db, chatId, batch.map((message) => message.id));
  batch.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id));
  if (batch.length === 0) return { status: "skipped", reason: "up_to_date" };

  const state = await deps.providers.load();
  if (!state.providers) return { status: "skipped", reason: "no_provider" };
  if (overBudget(await checkBudget(database, "text", state.limits.text, now), catchUp)) return { status: "skipped", reason: "budget" };

  const [person] = await withFacts(db, [await getPersonRow(db, chat.personId)]);
  // The model sees the batch in conversation order; the checkpoint follows storage order.
  const ordered = [...batch].sort((a, b) => a.sentAt.getTime() - b.sentAt.getTime() || a.id.localeCompare(b.id));
  const messages: ProfileMessageInput[] = ordered.map((row) => ({
    id: row.id,
    at: row.sentAt,
    fromOwner: row.fromOwner,
    fromPerson: !row.fromOwner,
    senderName: row.senderName,
    text: row.body,
    kind: row.kind,
    derivedText: row.derivedText,
    language: row.language,
  }));

  const extracted = await extractPersonFacts(state.providers, person!, messages, {
    now,
    timezone: settings.timezone,
    abortSignal: AbortSignal.timeout(deps.config.modelTimeoutMs),
    maxRetries: 1,
  });
  if (extracted.run) {
    await recordModelUsage(db, {
      role: "text",
      purpose: "profile",
      provider: extracted.run.provider,
      model: extracted.run.modelId,
      inputTokens: extracted.run.inputTokens,
      outputTokens: extracted.run.outputTokens,
      refId: chatId,
    });
  }

  const last = batch[batch.length - 1]!;
  const cursor: ProfileMessageKey = { createdAt: last.createdAt, messageId: last.id };
  // Catch-up continues until it reaches its target. A daily run that did not read everything starts
  // one, up to the chat's current last message.
  let target: ProfileMessageKey | null = null;
  if (catchUp) target = (await hasProfileBacklog(db, chatId, cursor, progress.target)) ? progress.target : null;
  else if (batch.length >= PROFILE_BATCH_MESSAGES && (await hasProfileBacklog(db, chatId, cursor))) target = await latestProfileKey(db, chatId);

  const result = await database.transaction(async ({ db: tx }) => {
    const facts = await applyProposedFacts(tx, person!.id, extracted.facts);
    const languages = languagesFromCounts(await languageCounts(tx, chatId, new Date(now.getTime() - LANGUAGE_WINDOW_MS)));
    const languagesChanged = languages.length > 0 && (await setPersonLanguages(tx, person!.id, languages));
    let contextSuggested = false;
    if (!chat.defaultContextId) {
      const [updated] = await withFacts(tx, [await getPersonRow(tx, person!.id)]);
      const suggestion = suggestChatContext(updated!, await listContexts(tx));
      if (suggestion.contextId) contextSuggested = await suggestChatDefaultContext(tx, chatId, suggestion.contextId);
    }
    // The checkpoint and the day are recorded with the facts, only after a successful extraction.
    await saveProfileProgress(tx, chatId, { cursor, target, localDate: today, at: now });
    return { facts, languages: languagesChanged ? languages : person!.languages, contextSuggested, changed: facts > 0 || languagesChanged || contextSuggested };
  });
  if (result.changed) await safeNotify(deps.notifier, { type: "sync" });
  const more = target !== null;
  if (more) await deps.queue.enqueue("profile-chat", { chatId }, { singletonKey: chatId });
  deps.logger.info("person profiled", { chatId, facts: result.facts, contextSuggested: result.contextSuggested, messages: batch.length, more });
  return { status: "profiled", facts: result.facts, languages: result.languages, contextSuggested: result.contextSuggested, messages: batch.length, more };
}

/**
 * Queues profile-chat for direct chats with unread messages that may run now (a pending catch-up, or
 * not yet profiled today): recovers runs deferred for a missing provider, the budget, or a failure,
 * and history imported before a provider was configured. Does nothing while no text provider is
 * configured or the text budget is used up.
 */
export async function sweepProfiles(
  deps: Pick<PipelineDeps, "database" | "providers" | "logger">,
  queue: Pick<PipelineQueue, "enqueue">,
  now: Date,
  limit = 50,
): Promise<number> {
  const state = await deps.providers.load();
  if (!state.providers) return 0;
  const budget = await checkBudget(deps.database, "text", state.limits.text, now);
  if (budget.exceeded) return 0;
  const settings = await getSettings(deps.database.db);
  const chatIds = await listChatsNeedingProfile(deps.database.db, {
    localDate: localDay(now, settings.timezone).date,
    limit,
    batchSize: PROFILE_BATCH_MESSAGES,
    includeCatchUp: !overBudget(budget, true),
  });
  for (const chatId of chatIds) await queue.enqueue("profile-chat", { chatId }, { singletonKey: chatId });
  if (chatIds.length) deps.logger.info("profiles queued", { chats: chatIds.length });
  return chatIds.length;
}
