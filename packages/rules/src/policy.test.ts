import { describe, expect, it } from "vitest";
import type { TaskAction } from "@wabrain/contracts";
import { decideAction, decideActions, isInTrial, type PolicyContext } from "./policy.js";

const NOW = new Date("2026-10-15T10:00:00+02:00");

const baseCtx: PolicyContext = {
  settings: { trialStartedAt: "2026-09-01T00:00:00+02:00", trialDays: 7, autoCreateThreshold: 0.8 },
  chat: { id: "chat-1", mode: "on", autoCreate: true, minimumAutoConfidence: null },
  calibration: { threshold: 0.8 },
  now: NOW,
  evidenceMessages: [
    { id: "own-1", fromOwner: true },
    { id: "own-2", fromOwner: true },
    { id: "other-1", fromOwner: false },
  ],
  tasks: [
    { id: "t-open", status: "open", chatId: "chat-1" },
    { id: "t-open-2", status: "open", chatId: "chat-1" },
    { id: "t-done", status: "done", chatId: "chat-1" },
    { id: "t-cancelled", status: "cancelled", chatId: "chat-1" },
    { id: "t-other-chat", status: "open", chatId: "chat-2" },
    { id: "t-manual", status: "open", chatId: null },
  ],
};

const base = { confidence: 0.95, ambiguityReasons: [] as string[], evidenceMessageIds: ["own-1"] };

const create = (overrides: Partial<Extract<TaskAction, { type: "create" }>> = {}): TaskAction => ({
  type: "create",
  kind: "todo",
  title: "Send the contract",
  description: "",
  dueAt: null,
  dueHasTime: false,
  contextId: null,
  language: "en",
  ...base,
  evidenceMessageIds: ["other-1"],
  ...overrides,
});

const complete = (overrides: Partial<Extract<TaskAction, { type: "complete" }>> = {}): TaskAction => ({
  type: "complete",
  taskId: "t-open",
  ...base,
  ...overrides,
});
const cancel = (overrides: Partial<Extract<TaskAction, { type: "cancel" }>> = {}): TaskAction => ({
  type: "cancel",
  taskId: "t-open",
  ...base,
  ...overrides,
});
const reschedule = (overrides: Partial<Extract<TaskAction, { type: "reschedule" }>> = {}): TaskAction => ({
  type: "reschedule",
  taskId: "t-open",
  dueAt: "2026-10-16T17:00:00+02:00",
  dueHasTime: false,
  ...base,
  ...overrides,
});
const merge = (taskIds: string[], overrides: Partial<Extract<TaskAction, { type: "merge" }>> = {}): TaskAction => ({
  type: "merge",
  taskIds,
  ...base,
  ...overrides,
});

describe("isInTrial", () => {
  const settings = { trialStartedAt: "2026-09-23T12:00:00+02:00", trialDays: 7 };
  it("is in trial until trialStartedAt + trialDays", () => {
    expect(isInTrial(settings, new Date("2026-09-23T12:00:00+02:00"))).toBe(true);
    expect(isInTrial(settings, new Date("2026-09-30T11:59:59+02:00"))).toBe(true);
    expect(isInTrial(settings, new Date("2026-09-30T12:00:00+02:00"))).toBe(false);
  });
  it("has no trial with zero days", () => {
    expect(isInTrial({ ...settings, trialDays: 0 }, new Date("2026-09-23T12:00:00+02:00"))).toBe(false);
  });
  it("treats an unparseable start as in trial", () => {
    expect(isInTrial({ ...settings, trialStartedAt: "nope" }, NOW)).toBe(true);
  });
});

describe("decideAction: create", () => {
  it("applies a confident, unambiguous create after the trial", () => {
    expect(decideAction(create(), baseCtx)).toEqual({ decision: { outcome: "apply", reason: "auto_create" }, reviewType: null });
  });

  it("applies a create from the owner's own commitment", () => {
    expect(decideAction(create({ evidenceMessageIds: ["own-1"] }), baseCtx).decision.outcome).toBe("apply");
  });

  it("reviews every create during the trial", () => {
    const ctx = { ...baseCtx, settings: { ...baseCtx.settings, trialStartedAt: "2026-10-14T00:00:00+02:00" } };
    expect(decideAction(create(), ctx)).toEqual({ decision: { outcome: "review", reason: "trial_period" }, reviewType: "create" });
  });

  it("keeps creates in Review after the trial until the active profile is calibrated", () => {
    const ctx = { ...baseCtx, calibration: null };
    expect(decideAction(create(), ctx)).toEqual({
      decision: { outcome: "review", reason: "calibration_required" },
      reviewType: "create",
    });
  });

  it("uses calibration as an additional floor above the configured and per-chat thresholds", () => {
    const configured = { ...baseCtx, settings: { ...baseCtx.settings, autoCreateThreshold: 0.6 }, calibration: { threshold: 0.9 } };
    expect(decideAction(create({ confidence: 0.89 }), configured).decision.reason).toBe("below_threshold");
    expect(decideAction(create({ confidence: 0.9 }), configured).decision.outcome).toBe("apply");

    const chatFloor = { ...configured, chat: { ...configured.chat, minimumAutoConfidence: 0.95 } };
    expect(decideAction(create({ confidence: 0.94 }), chatFloor).decision.reason).toBe("below_threshold");
  });

  it("reviews when auto-create is off for the chat", () => {
    const ctx = { ...baseCtx, chat: { ...baseCtx.chat, autoCreate: false } };
    expect(decideAction(create(), ctx)).toEqual({ decision: { outcome: "review", reason: "auto_create_disabled" }, reviewType: "create" });
  });

  it("reviews below the settings threshold and applies at it", () => {
    expect(decideAction(create({ confidence: 0.79 }), baseCtx).decision).toEqual({ outcome: "review", reason: "below_threshold" });
    expect(decideAction(create({ confidence: 0.8 }), baseCtx).decision).toEqual({ outcome: "apply", reason: "auto_create" });
  });

  it("uses the chat's confidence override", () => {
    const strict = { ...baseCtx, chat: { ...baseCtx.chat, minimumAutoConfidence: 0.97 } };
    expect(decideAction(create({ confidence: 0.95 }), strict).decision.reason).toBe("below_threshold");
    const lenient = { ...baseCtx, chat: { ...baseCtx.chat, minimumAutoConfidence: 0.5 }, calibration: { threshold: 0.55 } };
    expect(decideAction(create({ confidence: 0.6 }), lenient).decision.reason).toBe("auto_create");
  });

  it("never lets a lenient chat override go below the calibrated threshold", () => {
    const lenient = { ...baseCtx, chat: { ...baseCtx.chat, minimumAutoConfidence: 0.5 } };
    expect(decideAction(create({ confidence: 0.6 }), lenient).decision.reason).toBe("below_threshold");
  });

  it("treats an invalid calibration as missing", () => {
    for (const threshold of [Number.NaN, -0.1, 1.5]) {
      expect(decideAction(create(), { ...baseCtx, calibration: { threshold } }).decision.reason).toBe("calibration_required");
    }
  });

  it("always reviews a create its own burst already shows handled, even when it would auto-apply", () => {
    expect(decideAction(create({ alreadyHandled: { status: "done", evidenceMessageIds: ["m2"] } }), baseCtx)).toEqual({
      decision: { outcome: "review", reason: "already_handled" },
      reviewType: "create",
    });
  });

  it("reviews ambiguous creates", () => {
    expect(decideAction(create({ ambiguityReasons: ["who should do it is unclear"] }), baseCtx)).toEqual({
      decision: { outcome: "review", reason: "ambiguous" },
      reviewType: "create",
    });
  });

  it("drops everything for Off chats", () => {
    const ctx = { ...baseCtx, chat: { ...baseCtx.chat, mode: "off" as const } };
    for (const action of [create(), complete(), cancel(), reschedule(), merge(["t-open", "t-open-2"])]) {
      expect(decideAction(action, ctx)).toEqual({ decision: { outcome: "drop", reason: "chat_not_analyzed" }, reviewType: null });
    }
  });
});

describe.each([
  ["complete", complete, "possibly_done"],
  ["cancel", cancel, "possibly_cancelled"],
  ["reschedule", reschedule, "reschedule"],
] as const)("decideAction: %s", (_name, make, reviewType) => {
  it("applies on the owner's own evidence", () => {
    expect(decideAction(make(), baseCtx)).toEqual({ decision: { outcome: "apply", reason: "owner_evidence" }, reviewType: null });
    expect(decideAction(make({ evidenceMessageIds: ["own-1", "own-2"] }), baseCtx).decision.outcome).toBe("apply");
  });

  it("applies during the trial (the trial only gates creates)", () => {
    const ctx = { ...baseCtx, settings: { ...baseCtx.settings, trialStartedAt: "2026-10-14T00:00:00+02:00" } };
    expect(decideAction(make(), ctx).decision.outcome).toBe("apply");
  });

  it("applies even when auto-create is off", () => {
    const ctx = { ...baseCtx, chat: { ...baseCtx.chat, autoCreate: false } };
    expect(decideAction(make(), ctx).decision.outcome).toBe("apply");
  });

  it("is not gated by create calibration, only by the automatic-change threshold", () => {
    expect(decideAction(make(), { ...baseCtx, calibration: null }).decision.outcome).toBe("apply");
    // A high calibrated create floor does not raise the bar for owner-evidenced changes.
    expect(decideAction(make({ confidence: 0.85 }), { ...baseCtx, calibration: { threshold: 0.99 } }).decision.outcome).toBe("apply");
    const strictChat = { ...baseCtx, chat: { ...baseCtx.chat, minimumAutoConfidence: 0.9 } };
    expect(decideAction(make({ confidence: 0.85 }), strictChat).decision.reason).toBe("below_threshold");
  });

  it("turns someone else's evidence into a review prompt", () => {
    expect(decideAction(make({ evidenceMessageIds: ["other-1"] }), baseCtx)).toEqual({
      decision: { outcome: "review", reason: "non_owner_evidence" },
      reviewType,
    });
  });

  it("requires ALL evidence to be the owner's", () => {
    expect(decideAction(make({ evidenceMessageIds: ["own-1", "other-1"] }), baseCtx).decision.reason).toBe("non_owner_evidence");
  });

  it("treats unknown evidence ids as not the owner's", () => {
    expect(decideAction(make({ evidenceMessageIds: ["ghost"] }), baseCtx).decision.reason).toBe("non_owner_evidence");
  });

  it("drops actions on unknown tasks", () => {
    expect(decideAction(make({ taskId: "nope" }), baseCtx)).toEqual({ decision: { outcome: "drop", reason: "unknown_task" }, reviewType: null });
  });

  it("drops actions on another chat's task, even with owner evidence", () => {
    expect(decideAction(make({ taskId: "t-other-chat" }), baseCtx).decision).toEqual({ outcome: "drop", reason: "unknown_task" });
    expect(decideAction(make({ taskId: "t-manual" }), baseCtx).decision).toEqual({ outcome: "drop", reason: "unknown_task" });
  });

  it("drops actions on closed tasks", () => {
    expect(decideAction(make({ taskId: "t-done" }), baseCtx).decision).toEqual({ outcome: "drop", reason: "task_not_open" });
    expect(decideAction(make({ taskId: "t-cancelled" }), baseCtx).decision).toEqual({ outcome: "drop", reason: "task_not_open" });
  });

  it("checks the task before the evidence", () => {
    expect(decideAction(make({ taskId: "t-done", evidenceMessageIds: ["other-1"] }), baseCtx).decision.outcome).toBe("drop");
  });

  it("reviews an ambiguous or low-confidence owner message", () => {
    expect(decideAction(make({ ambiguityReasons: ["two invoices are open"] }), baseCtx)).toEqual({
      decision: { outcome: "review", reason: "ambiguous" },
      reviewType,
    });
    expect(decideAction(make({ confidence: 0.5 }), baseCtx)).toEqual({
      decision: { outcome: "review", reason: "below_threshold" },
      reviewType,
    });
  });
});

describe("decideAction: merge", () => {
  it("always reviews merges, even on owner evidence", () => {
    expect(decideAction(merge(["t-open", "t-open-2"]), baseCtx)).toEqual({
      decision: { outcome: "review", reason: "merge_requires_review" },
      reviewType: "merge",
    });
  });

  it("drops merges touching unknown or closed tasks", () => {
    expect(decideAction(merge(["t-open", "nope"]), baseCtx).decision).toEqual({ outcome: "drop", reason: "unknown_task" });
    expect(decideAction(merge(["t-open", "t-done"]), baseCtx).decision).toEqual({ outcome: "drop", reason: "task_not_open" });
    expect(decideAction(merge(["t-open", "t-open"]), baseCtx).decision).toEqual({ outcome: "drop", reason: "unknown_task" });
  });
});

describe("decideActions", () => {
  it("decides each action independently when they do not conflict", () => {
    const results = decideActions([create(), complete(), cancel({ taskId: "t-open-2", evidenceMessageIds: ["other-1"] })], baseCtx);
    expect(results.map((result) => result.decision.outcome)).toEqual(["apply", "apply", "review"]);
  });

  it("sends conflicting changes to the same task to review", () => {
    const results = decideActions([complete(), reschedule()], baseCtx);
    expect(results).toEqual([
      { decision: { outcome: "review", reason: "ambiguous" }, reviewType: "possibly_done" },
      { decision: { outcome: "review", reason: "ambiguous" }, reviewType: "reschedule" },
    ]);
  });

  it("keeps drops as drops", () => {
    const results = decideActions([complete({ taskId: "t-done" }), cancel({ taskId: "t-done" })], baseCtx);
    expect(results.map((result) => result.decision)).toEqual([
      { outcome: "drop", reason: "task_not_open" },
      { outcome: "drop", reason: "task_not_open" },
    ]);
  });
});

describe("changes to a create still pending in Review", () => {
  const ctx: PolicyContext = {
    ...baseCtx,
    pendingCreates: [
      { id: "r-pending", chatId: "chat-1" },
      { id: "r-other-chat", chatId: "chat-2" },
    ],
  };

  it("routes complete, cancel and reschedule to the pending item, whoever wrote the evidence", () => {
    const pending = { decision: { outcome: "review", reason: "pending_create" }, reviewType: "create" };
    expect(decideAction(complete({ taskId: "r-pending" }), ctx)).toEqual(pending);
    expect(decideAction(cancel({ taskId: "r-pending", evidenceMessageIds: ["other-1"] }), ctx)).toEqual(pending);
    expect(decideAction(reschedule({ taskId: "r-pending" }), ctx)).toEqual(pending);
  });

  it("never applies them, even with confident owner evidence", () => {
    expect(decideAction(complete({ taskId: "r-pending", confidence: 1 }), ctx).decision.outcome).toBe("review");
  });

  it("treats another chat's pending create as unknown", () => {
    expect(decideAction(complete({ taskId: "r-other-chat" }), ctx).decision).toEqual({ outcome: "drop", reason: "unknown_task" });
  });

  it("does not merge pending creates", () => {
    expect(decideAction(merge(["t-open", "r-pending"]), ctx).decision).toEqual({ outcome: "drop", reason: "unknown_task" });
  });
});
