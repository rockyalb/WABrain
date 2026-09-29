import type { EvalCase } from "../types.js";
import { NEXT_MONDAY, PERSONAL_CHAT, WORK_CHAT, own, them } from "./helpers.js";

/**
 * Creates proposed earlier that still wait in the owner's Review ("pending tasks"). A later message about
 * one must reference it (the owner then sees it may already be handled), never propose it again.
 */
export const pendingCases: EvalCase[] = [
  {
    id: "casual-pending-waiting-on-delivered",
    description: "The owner asked for the photos; before they reviewed the suggestion, Mira sends them: complete the pending item.",
    tags: ["casual", "direct", "complete", "non_owner", "waiting_on", "pending"],
    chat: PERSONAL_CHAT,
    person: "Mira",
    pendingTasks: [{ id: "p1", kind: "waiting_on", title: "Mira sends the wedding photos", dueAt: null }],
    context: [own("m1", "18:10", "Mira send me the wedding photos when u have time")],
    burst: [them("m2", "19:00", "here they are, thats all of them 📸", "Mira")],
    expected: [{ type: "complete", taskId: "p1" }],
  },
  {
    id: "casual-pending-owner-already-did-it",
    description: "Ana asked for the contract; the owner says it was sent before reviewing the suggestion: complete the pending item.",
    tags: ["casual", "direct", "complete", "owner", "pending"],
    chat: WORK_CHAT,
    person: "Ana",
    pendingTasks: [{ id: "p1", kind: "todo", title: "Send the contract to Ana", dueAt: null }],
    context: [them("m1", "09:30", "can u send me the new contract?")],
    burst: [own("m2", "11:15", "emailed u the contract")],
    expected: [{ type: "complete", taskId: "p1" }],
  },
  {
    id: "casual-pending-repeat-request-no-duplicate",
    description: "Ana repeats a request that is already pending in Review: no new create.",
    tags: ["casual", "direct", "noise", "pending", "duplicate"],
    chat: WORK_CHAT,
    person: "Ana",
    pendingTasks: [{ id: "p1", kind: "todo", title: "Send the contract to Ana", dueAt: null }],
    context: [them("m1", "09:30", "can u send me the new contract?")],
    burst: [them("m2", "12:40", "alex dont forget the contract pls")],
    expected: [],
  },
  {
    id: "en-pending-no-longer-needed",
    description: "The contact calls off a request still pending in Review: cancel the pending item.",
    tags: ["en", "direct", "cancel", "non_owner", "pending"],
    chat: WORK_CHAT,
    person: "Ana",
    pendingTasks: [{ id: "p1", kind: "todo", title: "Book the meeting room for Thursday", dueAt: null }],
    context: [them("m1", "09:00", "can you book the meeting room for Thursday?")],
    burst: [them("m2", "10:30", "never mind the room, the meeting got cancelled")],
    expected: [{ type: "cancel", taskId: "p1" }],
  },
  {
    id: "casual-pending-moved",
    description: "A pending request's date moves before the owner reviewed it: reschedule the pending item.",
    tags: ["casual", "direct", "reschedule", "non_owner", "pending"],
    chat: WORK_CHAT,
    person: "Ana",
    pendingTasks: [{ id: "p1", kind: "todo", title: "Send the report to Ana", dueAt: "2026-09-24T17:00:00+02:00", dueHasTime: false }],
    context: [them("m1", "09:00", "send me the report tmrw")],
    burst: [them("m2", "14:00", "no rush on the report, send it monday")],
    expected: [{ type: "reschedule", taskId: "p1", dueDate: NEXT_MONDAY }],
  },
];
