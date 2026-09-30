import type { TaskKind } from "@wabrain/contracts";
import type { DerivedKind } from "../working-memory.js";

export interface EvalMessage {
  id: string;
  /** Local "HH:mm" on the case's date, or a full ISO instant. */
  at: string;
  fromOwner: boolean;
  sender?: string;
  text: string;
  kind?: string;
  derivedText?: string;
  derivedKind?: DerivedKind;
}

export interface EvalOpenTask {
  id: string;
  kind: TaskKind;
  title: string;
  /** ISO instant or null. */
  dueAt?: string | null;
  dueHasTime?: boolean;
}

export type ExpectedAction =
  | {
      type: "create";
      kind: TaskKind;
      dueDate?: string | null;
      dueTime?: string | null;
      contextId?: string | null;
      /** The same burst already shows it done / no longer needed (alreadyHandled); null = must not be flagged. */
      handled?: "done" | "cancelled" | null;
    }
  | { type: "complete" | "cancel"; taskId: string }
  | { type: "reschedule"; taskId: string; dueDate: string; dueTime?: string | null }
  | { type: "merge"; taskIds: string[] };

export interface EvalCase {
  id: string;
  description: string;
  tags: string[];
  /** Local date "YYYY-MM-DD" (default 2026-09-23, a Wednesday). */
  date?: string;
  /** Local time of "now" (default: one minute after the last burst message). */
  nowTime?: string;
  chat: { name: string; isGroup: boolean; defaultContextId?: string };
  person?: string;
  openTasks?: EvalOpenTask[];
  /** Creates proposed earlier that still wait in the owner's Review (ids are review item ids). */
  pendingTasks?: EvalOpenTask[];
  context?: EvalMessage[];
  burst: EvalMessage[];
  expected: ExpectedAction[];
}
