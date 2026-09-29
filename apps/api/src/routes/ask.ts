/**
 * POST /v1/ask: answers a question only from stored messages (docs/SPEC.md, "Ask your chats").
 *
 * Read-only. Retrieval is `searchChats` (hybrid vector + trigram search, trigram only without an
 * embedding model), the answer is `answerFromChunks`. Citations are validated against the retrieved
 * messages, and a suggested task is only returned for the owner to tap: nothing here creates or
 * changes a task, a chat, or a message. Message content is untrusted evidence, never instructions.
 *
 * The only rows written are `model_usage` accounting rows (the query embedding and the answer call),
 * so Ask counts against the same daily model limits as the pipeline.
 */
import { answerFromChunks, notFoundAnswer } from "@wabrain/agent";
import { AskRequestSchema, type AskResponse } from "@wabrain/contracts";
import { getSettings, recordModelUsage, type HybridSearchHit } from "@wabrain/db";
import { checkBudget, searchChats } from "@wabrain/jobs";
import { Hono } from "hono";
import type { AppDeps, AppEnv } from "../deps.js";
import { HttpError } from "../http/errors.js";
import { jsonBody } from "../http/validate.js";
import { rateLimit } from "../middleware/common.js";

/** Every question makes one or two billed model calls: a small burst, then one every 6 s per device. */
export const ASK_RATE_LIMIT = { capacity: 10, refillPerSecond: 1 / 6 };
/** Conversation windows retrieved per question. */
export const ASK_HITS = 10;
const ASK_MODEL_TIMEOUT_MS = 45_000;

/**
 * Defense in depth on top of answerFromChunks: a citation or a suggested task's evidence may only
 * name a message that was retrieved for this question, in the chat it was retrieved from. An answer
 * left without a citation becomes "not found".
 */
export function onlyRetrievedEvidence(answer: AskResponse, hits: readonly HybridSearchHit[], question: string): AskResponse {
  const retrieved = new Map<string, string>();
  for (const hit of hits) for (const message of hit.messages) retrieved.set(message.id, hit.chatId);
  const citations = answer.citations.filter((citation) => retrieved.get(citation.messageId) === citation.chatId);
  if (!answer.found || citations.length === 0) {
    return { found: false, answer: answer.found ? notFoundAnswer(question) : answer.answer, citations: [], suggestedAction: null };
  }
  const action = answer.suggestedAction;
  const evidence = action ? action.evidenceMessageIds.filter((id) => retrieved.has(id)) : [];
  return {
    ...answer,
    citations,
    suggestedAction: action && evidence.length > 0 ? { ...action, evidenceMessageIds: evidence } : null,
  };
}

export function askRoutes(deps: AppDeps) {
  const app = new Hono<AppEnv>();
  const { database } = deps;

  app.post(
    "/ask",
    rateLimit(deps, "ask", ASK_RATE_LIMIT, (c) => c.get("deviceId") ?? c.get("clientIp")),
    async (c) => {
      const request = await jsonBody(c, AskRequestSchema);
      const question = request.question.trim();
      if (!question) throw new HttpError("validation_failed", "question: must not be blank");
      if (request.from && request.to && Date.parse(request.from) > Date.parse(request.to)) {
        throw new HttpError("validation_failed", "from: must not be after to");
      }

      const state = await deps.providers.load();
      if (!state.providers) {
        throw new HttpError("conflict", `Ask needs a text model. ${state.error ?? "No text provider is configured"}; set one on the setup page.`);
      }
      const now = deps.now();
      const budget = await checkBudget(database, "text", state.limits.text, now);
      if (budget.exceeded) {
        const retryAfter = Math.max(1, Math.ceil((budget.resetAt.getTime() - now.getTime()) / 1000));
        throw new HttpError("budget_exceeded", "The daily limit for the text model is used up; Ask works again after local midnight.", {
          "Retry-After": String(retryAfter),
        });
      }

      const { hits, vectorSearch } = await searchChats(
        { database, providers: deps.providers, logger: deps.logger, now: deps.now },
        {
          query: question,
          personId: request.personId,
          contextId: request.contextId,
          from: request.from,
          to: request.to,
          limit: ASK_HITS,
        },
      );

      const settings = await getSettings(database.db);
      let result;
      try {
        result = await answerFromChunks(state.providers, question, hits, {
          settings,
          now,
          abortSignal: AbortSignal.timeout(ASK_MODEL_TIMEOUT_MS),
          maxRetries: 1,
        });
      } catch (error) {
        // Never log the question or the retrieved text: only what failed.
        deps.logger.warn("ask: text model call failed", { error: error instanceof Error ? error.name : "error" });
        throw new HttpError("unavailable", "The text model did not answer. Try again in a moment.");
      }
      const { run, ...answered } = result;
      const answer = onlyRetrievedEvidence(answered, hits, question);
      if (run) {
        await recordModelUsage(database.db, {
          role: "text",
          purpose: "ask",
          provider: run.provider,
          model: run.modelId,
          inputTokens: run.inputTokens,
          outputTokens: run.outputTokens,
          refId: null,
        });
      }
      deps.logger.info("ask answered", {
        hits: hits.length,
        vectorSearch,
        found: answer.found,
        citations: answer.citations.length,
        suggested: answer.suggestedAction !== null,
      });
      return c.json(answer satisfies AskResponse);
    },
  );

  return app;
}
