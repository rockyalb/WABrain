/**
 * analyze-chat: runs once a chat has been quiet (debounced per chat; pg-boss serializes runs per chat).
 *
 * 1. Re-checks the chat (it may have been switched Off) and selects the burst: messages the chat rule
 *    selected for analysis that no run has consumed yet.
 * 2. Waits for the burst's media jobs (re-debouncing itself) up to a bound, then analyzes anyway.
 * 3. Opens (or resumes) an analysis run keyed by sha256(chat + burst message ids). The model output and
 *    policy decisions are stored on the run before anything is applied, so a retried job never calls
 *    the model twice for the same burst, and each action is applied exactly once (TaskService actionKey).
 * 4. Builds working memory (with the chat's open tasks and the creates still pending in Review), asks the model, runs the deterministic action policy with evidence
 *    directions from the database, applies each action, and marks the burst consumed.
 */
import { PROMPT_VERSION, analyzeChat, buildWorkingMemory, type MemoryMessageInput, type OpenTaskInput } from "@wabrain/agent";
import type { Chat, PolicyDecision, ReviewItem, ReviewItemType, TaskAction } from "@wabrain/contracts";
import {
  countPendingMedia,
  findAnalysisRunByKey,
  finishAnalysisRun,
  getChatRow,
  getSettings,
  listContexts,
  listMessagesBefore,
  listMessagesByIds,
  listOpenTasksForChat,
  listPendingCreatesForChat,
  listUnanalyzedMessages,
  markMessagesAnalyzed,
  recordAnalysisError,
  recordAnalysisOutput,
  recordModelUsage,
  startAnalysisRun,
  toChat,
  updateChatPipelineState,
  withFacts,
  getPersonRow,
  findTaskRow,
  resolveTaskCalibration,
  type ApplyResult,
  type MessageRow,
} from "@wabrain/db";
import { decideActions, type PolicyResult, type PolicyTask } from "@wabrain/rules";
import { createHash } from "node:crypto";
import { checkBudget, recordDeferral } from "./budget.js";
import type { PipelineDeps } from "./deps.js";

export type AnalysisOutcome =
  | { status: "skipped"; reason: "chat_missing" | "chat_off" | "empty" }
  | { status: "waiting_media"; pending: number }
  | { status: "deferred"; reason: "budget" | "provider"; until: Date }
  | { status: "analyzed"; runId: string; resumed: boolean; outcomes: ActionOutcome[] };

export interface ActionOutcome {
  type: TaskAction["type"];
  decision: PolicyDecision;
  result: "applied" | "review" | "dropped";
  taskId?: string | null;
  reviewItemId?: string | null;
  reviewType?: ReviewItemType | null;
}

interface StoredOutput {
  actions: TaskAction[];
  decisions: PolicyResult[];
}

function runKey(chatId: string, messageIds: readonly string[]): string {
  return createHash("sha256")
    .update(`${chatId}\n${[...messageIds].sort().join("\n")}`)
    .digest("hex");
}

function derivedKind(kind: string) {
  if (kind === "voice" || kind === "audio") return "transcript" as const;
  if (kind === "image" || kind === "sticker") return "image" as const;
  return "document" as const;
}

function toMemoryMessage(row: MessageRow): MemoryMessageInput {
  return {
    id: row.id,
    at: row.sentAt,
    fromOwner: row.fromOwner,
    senderName: row.senderName,
    text: row.body,
    kind: row.kind,
    derivedText: row.derivedText,
    derivedKind: row.derivedText ? derivedKind(row.kind) : null,
    language: row.language,
    quotedMessageId: row.quotedMessageId,
  };
}

function toOpenTask(task: { id: string; kind: OpenTaskInput["kind"]; title: string; dueAt: string | null; dueHasTime: boolean }): OpenTaskInput {
  return { id: task.id, kind: task.kind, title: task.title, dueAt: task.dueAt, dueHasTime: task.dueHasTime };
}

/** A create still waiting in Review, shown to the model as a pending task keyed by its review item id. */
function toPendingTask(item: ReviewItem): OpenTaskInput | null {
  if (item.action.type !== "create") return null;
  const { kind, title, dueAt, dueHasTime } = item.action;
  return { id: item.id, kind, title, dueAt, dueHasTime };
}

async function defer(deps: PipelineDeps, chatId: string, reason: "budget" | "provider", until: Date, role: "text" = "text"): Promise<AnalysisOutcome> {
  await deps.queue.enqueue("analyze-chat", { chatId }, { singletonKey: chatId, startAfter: until });
  await recordDeferral(deps.database, { role, reason, at: deps.now().toISOString(), until: until.toISOString() });
  deps.logger.warn("analysis deferred", { chatId, reason, until: until.toISOString() });
  return { status: "deferred", reason, until };
}

/** Runs the model and the policy for a new run, storing both before anything is applied. */
async function produceOutput(
  deps: PipelineDeps,
  chat: Chat,
  runId: string,
  burst: MessageRow[],
  providers: NonNullable<Awaited<ReturnType<PipelineDeps["providers"]["load"]>>["providers"]>,
): Promise<StoredOutput> {
  const { database, config } = deps;
  const db = database.db;
  const now = deps.now();
  const settings = await getSettings(db);
  const burstIds = burst.map((message) => message.id);
  const lastAt = burst[burst.length - 1]!.sentAt;
  const preceding = await listMessagesBefore(db, chat.id, lastAt, burstIds, config.precedingMessages);
  const windowIds = new Set([...burstIds, ...preceding.map((message) => message.id)]);
  const quotedIds = [...burst, ...preceding]
    .map((message) => message.quotedMessageId)
    .filter((id): id is string => Boolean(id) && !windowIds.has(id!));
  const quoted = await listMessagesByIds(db, chat.id, [...new Set(quotedIds)]);
  const openTasks = await listOpenTasksForChat(db, chat.id);
  const pendingCreates = await listPendingCreatesForChat(db, chat.id);
  const pendingTasks = pendingCreates.map(toPendingTask).filter((task): task is OpenTaskInput => task !== null);
  const contexts = await listContexts(db);
  const person = chat.personId && !chat.isGroup ? (await withFacts(db, [await getPersonRow(db, chat.personId)]))[0] ?? null : null;

  const memory = buildWorkingMemory({
    now,
    settings,
    chat,
    contexts,
    person,
    burst: burst.map(toMemoryMessage),
    preceding: preceding.map(toMemoryMessage),
    quoted: quoted.map(toMemoryMessage),
    openTasks: openTasks.map(toOpenTask),
    pendingTasks,
  });

  let result;
  try {
    result = await analyzeChat(providers, memory, { abortSignal: AbortSignal.timeout(config.modelTimeoutMs), maxRetries: 1 });
  } catch (error) {
    await recordAnalysisError(db, runId, error instanceof Error ? error.name : "error");
    throw error;
  }
  await recordModelUsage(db, {
    role: "text",
    purpose: "analysis",
    provider: result.run.provider,
    model: result.run.modelId,
    inputTokens: result.run.inputTokens,
    outputTokens: result.run.outputTokens,
    refId: runId,
  });

  // Evidence directions come from storage, never from the model; only this chat's messages count.
  const evidenceIds = [...new Set(result.actions.flatMap((action) => action.evidenceMessageIds))];
  const evidence = await listMessagesByIds(db, chat.id, evidenceIds);
  // Creates auto-apply only with a usable calibration for exactly this provider/model/prompt profile.
  const calibration = await resolveTaskCalibration(
    database,
    { provider: result.run.provider, model: result.run.modelId, promptVersion: result.run.promptVersion },
    now,
  );
  const tasks: PolicyTask[] = openTasks.map((task) => ({ id: task.id, status: task.status, chatId: task.chatId }));
  const known = new Set([...tasks.map((task) => task.id), ...pendingTasks.map((task) => task.id)]);
  for (const action of result.actions) {
    const ids = action.type === "merge" ? action.taskIds : action.type === "create" ? [] : [action.taskId];
    for (const id of ids) {
      if (known.has(id)) continue;
      const row = await findTaskRow(db, id);
      if (row) tasks.push({ id: row.id, status: row.status, chatId: row.chatId });
      known.add(id);
    }
  }
  const decisions = decideActions(result.actions, {
    settings,
    chat,
    calibration: calibration?.threshold != null ? { threshold: calibration.threshold } : null,
    now,
    evidenceMessages: evidence.map((message) => ({ id: message.id, fromOwner: message.fromOwner })),
    tasks,
    pendingCreates: pendingCreates.map((item) => ({ id: item.id, chatId: item.chatId })),
  });

  await recordAnalysisOutput(db, runId, {
    provider: result.run.provider,
    model: result.run.modelId,
    promptVersion: result.run.promptVersion,
    usage: { inputTokens: result.run.inputTokens, outputTokens: result.run.outputTokens },
    latencyMs: result.run.latencyMs,
    actions: result.actions,
    decisions,
    dropped: result.dropped.map((drop) => ({ index: drop.index, reason: drop.reason, type: drop.raw.type })),
    contextReasons: result.contextReasons,
  });
  return { actions: result.actions, decisions };
}

function summarize(action: TaskAction, decision: PolicyResult, result: ApplyResult): ActionOutcome {
  if (result.outcome === "applied") return { type: action.type, decision: decision.decision, result: "applied", taskId: result.task.id };
  if (result.outcome === "review") {
    return { type: action.type, decision: decision.decision, result: "review", reviewItemId: result.reviewItem.id, reviewType: result.reviewItem.type, taskId: result.reviewItem.taskId };
  }
  return { type: action.type, decision: decision.decision, result: "dropped" };
}

export async function runChatAnalysis(deps: PipelineDeps, chatId: string): Promise<AnalysisOutcome> {
  const { database, config } = deps;
  const db = database.db;
  const chatRow = await getChatRow(db, chatId).catch(() => null);
  if (!chatRow) return { status: "skipped", reason: "chat_missing" };
  const chat = toChat(chatRow);
  if (chat.mode === "off") return { status: "skipped", reason: "chat_off" };

  const burst = await listUnanalyzedMessages(db, chatId, config.maxBurstMessages);
  if (burst.length === 0) return { status: "skipped", reason: "empty" };
  const burstIds = burst.map((message) => message.id);

  // Wait (bounded) for images and voice notes of this burst to get their derived text.
  const pending = await countPendingMedia(db, burstIds);
  const oldest = Math.min(...burst.map((message) => message.createdAt.getTime()));
  if (pending > 0 && deps.now().getTime() - oldest < config.mediaWaitMaxMs) {
    await deps.queue.debounceChat(chatId, { delayMs: config.mediaRecheckMs, maxWaitMs: config.mediaRecheckMs });
    return { status: "waiting_media", pending };
  }

  const key = runKey(chatId, burstIds);
  const existing = await findAnalysisRunByKey(db, key);
  let runId: string;
  let output: StoredOutput;
  let resumed = false;
  if (existing?.status === "succeeded") {
    await markMessagesAnalyzed(db, burstIds, existing.id);
    return { status: "analyzed", runId: existing.id, resumed: true, outcomes: (existing.outcomes as ActionOutcome[] | null) ?? [] };
  }
  if (existing?.actions && existing.decisions) {
    // A retry after the model answered: reuse the stored output, never call the model again.
    runId = existing.id;
    output = { actions: existing.actions as TaskAction[], decisions: existing.decisions as PolicyResult[] };
    resumed = true;
  } else {
    const state = await deps.providers.load();
    if (!state.providers) {
      deps.logger.warn("analysis waiting for a text provider", { chatId, error: state.error });
      return defer(deps, chatId, "provider", new Date(deps.now().getTime() + config.providerRetryMs));
    }
    const budget = await checkBudget(database, "text", state.limits.text, deps.now());
    if (budget.exceeded) return defer(deps, chatId, "budget", budget.resetAt);
    runId =
      existing?.id ??
      (await startAnalysisRun(db, {
        chatId,
        provider: state.providers.text.provider,
        model: state.providers.text.modelId,
        promptVersion: PROMPT_VERSION,
        inputMessageIds: burstIds,
        fromMessageAt: burst[0]!.sentAt,
        toMessageAt: burst[burst.length - 1]!.sentAt,
        idempotencyKey: key,
      }));
    output = await produceOutput(deps, chat, runId, burst, state.providers);
  }

  // Apply: exactly once per (run, action index), even across retries.
  const outcomes: ActionOutcome[] = [];
  for (const [index, action] of output.actions.entries()) {
    const decision = output.decisions[index]!;
    const result = await deps.tasks.applyAction(action, decision.decision, {
      chatId,
      personId: chat.personId,
      analysisRunId: runId,
      actionKey: `${runId}:${index}`,
    });
    outcomes.push(summarize(action, decision, result));
  }

  await database.transaction(async ({ db: tx }) => {
    await markMessagesAnalyzed(tx, burstIds, runId);
    await finishAnalysisRun(tx, runId, { status: "succeeded", outcomes, decisions: output.decisions });
    await updateChatPipelineState(tx, chatId, { lastAnalysisAt: deps.now(), lastAnalysisRunId: runId });
  });
  deps.logger.info("chat analyzed", {
    chatId,
    runId,
    resumed,
    messages: burstIds.length,
    applied: outcomes.filter((outcome) => outcome.result === "applied").length,
    review: outcomes.filter((outcome) => outcome.result === "review").length,
    dropped: outcomes.filter((outcome) => outcome.result === "dropped").length,
  });

  // More messages than one run takes: continue shortly.
  if (burst.length >= config.maxBurstMessages) await deps.queue.debounceChat(chatId, { delayMs: 1000 });
  // Profile at most once per chat per day (the profile job enforces the day).
  if (chat.personId && !chat.isGroup) {
    await deps.queue.enqueue("profile-chat", { chatId }, { singletonKey: chatId });
  }
  return { status: "analyzed", runId, resumed, outcomes };
}
