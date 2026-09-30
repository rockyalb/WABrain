import type { EvalCase } from "../types.js";
import { PERSONAL_CHAT, WORK_CHAT, own, them } from "./helpers.js";

/**
 * A request and its completion in the same burst. The create is still proposed, flagged as already handled
 * (alreadyHandled), so the owner confirms it in Review instead of the task silently appearing or vanishing.
 */
export const handledCases: EvalCase[] = [
  {
    id: "casual-same-burst-owner-here-you-go",
    description:
      "A contact sends an order PDF and asks the owner to look at it; a minute later, in the same burst, the owner answers 'here u go, all ready'. Create, flagged done.",
    tags: ["casual", "direct", "request", "todo", "owner", "same_burst"],
    chat: WORK_CHAT,
    person: "Ana",
    burst: [
      them("m1", "11:41", "", "Ana", { kind: "document", derivedKind: "document", derivedText: "PDF, 1 page\nPage 1: Order No 2231, 1 bed 160x200, 2 nightstands" }),
      them("m2", "11:42", "one of the warehouse guys has it"),
      them("m3", "11:42", "can u check it"),
      own("m4", "11:43", "here u go, all ready"),
    ],
    expected: [{ type: "create", kind: "todo", handled: "done" }],
  },
  {
    id: "casual-same-burst-waiting-on-delivered",
    description: "The owner asks for the invoice photo and the contact sends it in the same burst: waiting_on, flagged done.",
    tags: ["casual", "direct", "waiting_on", "non_owner", "same_burst"],
    chat: PERSONAL_CHAT,
    person: "Mira",
    burst: [
      own("m1", "18:10", "Mira send me a pic of the electricity bill pls"),
      them("m2", "18:12", "here it is", "Mira"),
      them("m3", "18:12", "", "Mira", { kind: "image", derivedKind: "image", derivedText: "A photo of an electricity bill, total 48.20 EUR, due 30 September." }),
    ],
    expected: [{ type: "create", kind: "waiting_on", handled: "done" }],
  },
  {
    id: "en-same-burst-called-off",
    description: "A request and, minutes later in the same burst, 'never mind': create, flagged no longer needed.",
    tags: ["en", "direct", "request", "todo", "non_owner", "same_burst"],
    chat: WORK_CHAT,
    person: "Ana",
    burst: [
      them("m1", "09:00", "can you book the meeting room for Thursday afternoon?"),
      them("m2", "09:04", "never mind, the client cancelled Thursday"),
    ],
    expected: [{ type: "create", kind: "todo", handled: "cancelled" }],
  },
  {
    id: "casual-same-burst-accepted-not-done",
    description: "The owner only accepts the request in the same burst ('ok will look after lunch'): an ordinary create, not flagged as handled.",
    tags: ["casual", "direct", "request", "todo", "owner", "same_burst"],
    chat: WORK_CHAT,
    person: "Ana",
    burst: [them("m1", "10:02", "can u check the hotel offer for me?"), own("m2", "10:05", "ok will look after lunch")],
    expected: [{ type: "create", kind: "todo", handled: null }],
  },
];
