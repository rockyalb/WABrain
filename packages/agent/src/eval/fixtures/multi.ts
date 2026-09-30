import type { EvalCase } from "../types.js";
import { FRIDAY, PERSONAL_CHAT, TOMORROW, WORK_CHAT, own, them } from "./helpers.js";

const COLLEAGUE_CHAT = { name: "Sam", isGroup: false, defaultContextId: "ctx-work" };

/** Bursts that hold two or more separate tasks: each one is its own create. */
export const multiCases: EvalCase[] = [
  {
    id: "casual-document-then-voice-request",
    description:
      "A colleague sends a document asking the owner to print it (owner: 'yep'), then a voice note asking the owner to check something else: two todos, the voice note must not be lost behind the first request.",
    tags: ["casual", "direct", "multi", "todo", "voice"],
    chat: COLLEAGUE_CHAT,
    person: "Sam",
    burst: [
      them("m1", "09:58", "print this for the taxes pls", "Sam", { kind: "document" }),
      own("m2", "09:58", "yep"),
      them("m3", "10:02", "", "Sam", {
        kind: "voice",
        derivedKind: "transcript",
        derivedText: "I fixed the part that picks up tasks from voice messages. Can you check whether it shows up in your tasks?",
      }),
    ],
    expected: [
      { type: "create", kind: "todo" },
      { type: "create", kind: "todo" },
    ],
  },
  {
    id: "casual-document-then-voice-about-tasks",
    description:
      "As above, but the voice note asks the owner to check whether 'the tasks' feature works: a real request to the owner about an app, not an instruction to the analyst. Two todos.",
    tags: ["casual", "direct", "multi", "todo", "voice"],
    chat: COLLEAGUE_CHAT,
    person: "Sam",
    burst: [
      them("m1", "09:58", "can u print this for the taxes", "Sam", { kind: "document" }),
      own("m2", "09:58", "yep"),
      them("m3", "10:02", "", "Sam", {
        kind: "voice",
        derivedKind: "transcript",
        derivedText: "I've fixed the part that takes actions from Voice Notes. Can you check if it comes through to the tasks?",
      }),
    ],
    expected: [
      { type: "create", kind: "todo" },
      { type: "create", kind: "todo" },
    ],
  },
  {
    id: "casual-voice-about-tasks-alone",
    description: "The voice note about checking the tasks feature on its own: one todo.",
    tags: ["casual", "direct", "todo", "voice"],
    chat: COLLEAGUE_CHAT,
    person: "Sam",
    burst: [
      them("m1", "10:02", "", "Sam", {
        kind: "voice",
        derivedKind: "transcript",
        derivedText: "I've fixed the part that takes actions from Voice Notes. Can you check if it comes through to the tasks?",
      }),
    ],
    expected: [{ type: "create", kind: "todo" }],
  },
  {
    id: "casual-busy-chat-document-then-voice",
    description:
      "The document + voice-note burst in a busy work chat (earlier handled exchanges, open tasks and proposals still in Review about other things): both requests still become todos.",
    tags: ["casual", "direct", "multi", "todo", "voice", "busy"],
    chat: COLLEAGUE_CHAT,
    person: "Sam",
    openTasks: [
      { id: "t1", kind: "todo", title: "Check whether you can take the van this week", dueAt: null },
      { id: "t2", kind: "waiting_on", title: "Wait for Leo's answer about the supplier", dueAt: null },
      { id: "t3", kind: "todo", title: "Leave the storeroom empty for sorting", dueAt: null },
    ],
    pendingTasks: [
      { id: "p1", kind: "todo", title: "Close Dan's old number", dueAt: null },
      { id: "p2", kind: "todo", title: "Send the new work number for Nico", dueAt: null },
    ],
    context: [
      them("c1", "2026-09-22T15:01:00+02:00", "And you say you did it before it even opened", "Sam"),
      own("c2", "2026-09-22T15:09:00+02:00", "I get it"),
      own("c3", "2026-09-22T15:09:30+02:00", "It treats it as pretty much done by itself"),
      them("c4", "2026-09-22T15:11:30+02:00", "If it was done before you accepted it yeah", "Sam"),
      them("c5", "2026-09-22T15:11:45+02:00", "Just so there aren't 100 more approvals", "Sam"),
      own("c6", "2026-09-22T15:15:00+02:00", "yeah exactly"),
      own("c7", "09:18", "", { kind: "document", derivedKind: "document", derivedText: "PDF, 1 page\nPage 1: No Description Unit Quantity Price incl. VAT" }),
      own("c8", "09:20", "Have a look"),
      them("c9", "09:22", "it's ready", "Sam"),
      them("c10", "09:23", "Nico needs a work number, I haven't closed Dan's number yet, or should we close it and open another?", "Sam"),
      own("c11", "09:23", "close it and I'll send you another number"),
      them("c12", "09:27", "ok send it", "Sam"),
      own("c13", "09:34", "", { kind: "image", derivedKind: "image", derivedText: "A photo of a red box with a barcode label lying on papers." }),
      them("c14", "09:45", "send the PC to Nico, he'll set it up himself", "Sam"),
      own("c15", "09:45", "sent it"),
      them("c16", "09:45", "great", "Sam"),
    ],
    burst: [
      them("m1", "09:58", "can u print this for the taxes", "Sam", { kind: "document" }),
      own("m2", "09:58", "yep"),
      them("m3", "10:02", "", "Sam", {
        kind: "voice",
        derivedKind: "transcript",
        derivedText: "I've fixed the part that takes actions from Voice Notes. Could you check if it comes through to the tasks?",
      }),
    ],
    expected: [
      { type: "create", kind: "todo" },
      { type: "create", kind: "todo" },
    ],
  },
  {
    id: "casual-two-requests-one-message",
    description: "One message asks for two unrelated things with different dates: two todos.",
    tags: ["casual", "direct", "multi", "todo"],
    chat: WORK_CHAT,
    person: "Ana",
    burst: [them("m1", "10:15", "send me the invoice tmrw pls, and on friday tell me when the technician is coming")],
    expected: [
      { type: "create", kind: "todo", dueDate: TOMORROW, dueTime: null },
      { type: "create", kind: "todo", dueDate: FRIDAY, dueTime: null },
    ],
  },
  {
    id: "casual-request-and-owner-ask",
    description: "The contact asks the owner for something and the owner asks the contact for something else: a todo and a waiting_on.",
    tags: ["casual", "direct", "multi", "todo", "waiting_on"],
    chat: WORK_CHAT,
    person: "Ana",
    burst: [
      them("m1", "14:02", "could u check the offer before we send it?"),
      own("m2", "14:05", "ok will look today. u send me the new price list"),
    ],
    expected: [
      { type: "create", kind: "todo" },
      { type: "create", kind: "waiting_on" },
    ],
  },
  {
    id: "en-three-separate-requests",
    description: "Three separate requests across three messages: three todos.",
    tags: ["en", "direct", "multi", "todo"],
    chat: PERSONAL_CHAT,
    person: "Mira",
    burst: [
      them("m1", "18:00", "Can you pick up the cake tomorrow?", "Mira"),
      them("m2", "18:01", "Also please book the restaurant for Friday", "Mira"),
      them("m3", "18:03", "and send me Ben's number when you can", "Mira"),
    ],
    expected: [
      { type: "create", kind: "todo", dueDate: TOMORROW, dueTime: null },
      { type: "create", kind: "todo", dueDate: FRIDAY, dueTime: null },
      { type: "create", kind: "todo", dueDate: null },
    ],
  },
  {
    id: "casual-same-request-repeated",
    description: "The same request, repeated and reworded across messages, is one task, not several.",
    tags: ["casual", "direct", "multi", "todo", "duplicate"],
    chat: WORK_CHAT,
    person: "Ana",
    burst: [
      them("m1", "09:10", "send me the contract today"),
      them("m2", "09:25", "??"),
      them("m3", "09:40", "the contract pls, i really need it today"),
    ],
    expected: [{ type: "create", kind: "todo" }],
  },
];
