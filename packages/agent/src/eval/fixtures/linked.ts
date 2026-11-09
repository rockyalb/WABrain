import type { EvalCase } from "../types.js";
import { PERSONAL_CHAT, WORK_CHAT, own, them } from "./helpers.js";

const CASEY_CHAT = { name: "Casey <3", isGroup: false, defaultContextId: "ctx-personal" };
const JORDAN_CHAT = { name: "Jordan", isGroup: false, defaultContextId: "ctx-work" };
const DESIGN_GROUP = { name: "Design Team", isGroup: true, defaultContextId: "ctx-work" };

const SEND_LIST = { id: "lk1", kind: "todo" as const, title: "Send Jordan the list of remaining work", dueAt: null, fromChat: "Casey <3" };

/**
 * Tasks that involve another chat. A create names who else it involves ("involves"), so the system can
 * link that person's chat; in the linked chat the task may be completed or cancelled, and only when the
 * messages there do the specific thing.
 */
export const linkedCases: EvalCase[] = [
  {
    id: "casual-involves-send-to-jordan",
    description: "Casey asks the owner to send Jordan the list: the create involves Jordan.",
    tags: ["casual", "direct", "create", "involves"],
    chat: CASEY_CHAT,
    person: "Casey",
    burst: [them("m1", "10:00", "send Jordan the list of the remaining work and tell him to finish it by tomorrow", "Casey"), own("m2", "10:02", "ok")],
    expected: [{ type: "create", kind: "todo", involves: ["jordan"] }],
  },
  {
    id: "casual-involves-owner-will-send-robin",
    description: "The contact asks for the offer to go to Robin; the owner accepts: the create involves Robin.",
    tags: ["casual", "direct", "create", "involves", "owner"],
    chat: WORK_CHAT,
    person: "Ana",
    burst: [them("m1", "11:00", "could u get the offer over to Robin today?"), own("m2", "11:03", "sure, will do")],
    expected: [{ type: "create", kind: "todo", dueDate: "2026-09-23", involves: ["robin"] }],
  },
  {
    id: "en-involves-nobody-else",
    description: "A request for the contact themselves involves nobody else.",
    tags: ["en", "direct", "create", "involves"],
    chat: WORK_CHAT,
    person: "Ana",
    burst: [them("m1", "09:00", "can you send me the signed contract today?")],
    expected: [{ type: "create", kind: "todo", dueDate: "2026-09-23", involves: [] }],
  },
  {
    id: "casual-linked-owner-sends-list",
    description: "In Jordan's chat the owner sends the list Casey asked for: complete the linked task.",
    tags: ["casual", "direct", "complete", "owner", "linked"],
    chat: JORDAN_CHAT,
    person: "Jordan",
    linkedTasks: [SEND_LIST],
    context: [them("m1", "09:40", "hey Alex, anything new on the works?", "Jordan")],
    burst: [
      own("m2", "12:10", "Jordan here's the list of what's left, pls finish it by tomorrow"),
      own("m3", "12:10", "", { kind: "document", derivedText: "Remaining work: 1. Paint the hallway 2. Fit the doors 3. Cleaning" }),
    ],
    expected: [{ type: "complete", taskId: "lk1" }],
  },
  {
    id: "casual-linked-topic-only",
    description: "Jordan's chat only mentions the works; the list was not sent: no action on the linked task.",
    tags: ["casual", "direct", "noise", "linked"],
    chat: JORDAN_CHAT,
    person: "Jordan",
    linkedTasks: [SEND_LIST],
    burst: [them("m1", "15:00", "Alex let's talk about the works tomorrow, busy today", "Jordan"), own("m2", "15:05", "ok talk tomorrow")],
    expected: [],
  },
  {
    id: "casual-linked-never-rescheduled",
    description: "Jordan moves something in his own chat: a linked task is never rescheduled from here.",
    tags: ["casual", "direct", "noise", "linked", "reschedule"],
    chat: JORDAN_CHAT,
    person: "Jordan",
    linkedTasks: [SEND_LIST],
    burst: [them("m1", "16:00", "better send me the list on monday, not in the office today", "Jordan")],
    expected: [],
  },
  {
    id: "casual-linked-pending-delivered",
    description: "A linked create still pending in Review: the person confirms receiving it, so complete the pending item.",
    tags: ["casual", "direct", "complete", "non_owner", "linked", "pending"],
    chat: PERSONAL_CHAT,
    person: "Mira",
    linkedTasks: [{ id: "p1", kind: "todo", title: "Send Mira the photo of the passport", dueAt: null, fromChat: "Mom", pending: true }],
    context: [own("m1", "08:30", "", { kind: "image", derivedText: "Photo of a passport page" })],
    burst: [them("m2", "08:45", "got the passport photo, thanks a lot", "Mira")],
    expected: [{ type: "complete", taskId: "p1" }],
  },
  {
    id: "casual-linked-group-told",
    description: "The owner tells the Design group what another chat asked them to: complete the linked task.",
    tags: ["casual", "group", "complete", "owner", "linked"],
    chat: DESIGN_GROUP,
    linkedTasks: [{ id: "lk2", kind: "todo", title: "Tell the Design group the meeting moves to Friday", dueAt: null, fromChat: "Ana (Office)" }],
    context: [them("m1", "09:00", "who has the deploy key?", "Taylor")],
    burst: [own("m2", "10:30", "guys the meeting moves to friday at 10")],
    expected: [{ type: "complete", taskId: "lk2" }],
  },
];
