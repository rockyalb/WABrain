import type { Chat, NormalizedMessage } from "@wabrain/contracts";
import { evaluateMessage, skipReason, type MessageEvaluation, type RuleMessage, type SkipReason } from "./chat.js";

export interface RulesIntakeFilterOptions {
  /** The owner's JIDs (phone JID and, when known, LID). Used to recognize real @mentions in groups. */
  ownerJids: readonly string[];
  /** Owner aliases that apply to every chat, in addition to each chat's own aliases. */
  aliases?: readonly string[];
  /** Called for every discarded or context-only message with the reason (never the content). */
  onDecision?: (decision: { stage: "store"; reason: SkipReason } | { stage: "analyze"; evaluation: MessageEvaluation }) => void;
}

export interface IntakeAnalyzeContext {
  /** True when the message quotes one of the owner's messages. */
  quotesOwner?: boolean;
}

/**
 * The intake filter used by the webhook and the projector (structurally compatible with
 * `IntakeFilter` in @wabrain/db):
 * - shouldStore: false for Off chats, status updates, channels, view-once media, and one-time codes.
 *   Nothing of such a message is stored.
 * - shouldAnalyze: direct chats and the owner's own messages always; groups in "on" mode always; groups
 *   in "mentions_only" mode only on a real @mention, a whole-word alias, or a reply to the owner.
 *   Only live (webhook) messages are analyzed; imported history never proposes tasks from here.
 */
export function createRulesIntakeFilter(options: RulesIntakeFilterOptions) {
  const ownerJids = options.ownerJids.filter(Boolean);
  const globalAliases = options.aliases ?? [];

  const toRuleMessage = (message: NormalizedMessage): RuleMessage => ({
    chatId: message.chatId,
    body: message.body,
    kind: message.kind,
    direction: message.direction,
    isGroup: message.isGroup,
    mentions: message.mentions,
    isViewOnce: message.isViewOnce,
    senderName: message.senderName ?? null,
  });

  return {
    shouldStore(message: NormalizedMessage, chat: Chat | null): boolean {
      const reason = skipReason(toRuleMessage(message), chat);
      if (reason) options.onDecision?.({ stage: "store", reason });
      return reason === null;
    },
    shouldAnalyze(message: NormalizedMessage, chat: Chat, context: IntakeAnalyzeContext = {}): boolean {
      if (message.source !== "webhook") return false;
      const evaluation = evaluateMessage(
        toRuleMessage(message),
        { mode: chat.mode, aliases: [...globalAliases, ...chat.aliases] },
        ownerJids,
        { quotesOwner: context.quotesOwner ?? false },
      );
      if (evaluation.action !== "analyze") options.onDecision?.({ stage: "analyze", evaluation });
      return evaluation.action === "analyze";
    },
  };
}

export type RulesIntakeFilter = ReturnType<typeof createRulesIntakeFilter>;
