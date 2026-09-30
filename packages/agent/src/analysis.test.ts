import { describe, expect, it } from "vitest";
import { analyzeChat } from "./analysis/analyze.js";
import { PROMPT_VERSION, renderTaskAnalysisPrompt } from "./analysis/prompt.js";
import type { ModelTaskAction } from "./analysis/schema.js";
import { validateModelActions } from "./analysis/validate.js";
import { evalCases } from "./eval/fixtures/index.js";
import { EVAL_SETTINGS, buildCaseMemory, replayPrediction, scoreCase, scoreLabeledCreatePredictions } from "./eval/harness.js";
import type { EvalCase, ExpectedAction } from "./eval/types.js";
import { createMockProviders, mockJsonModel } from "./testing/index.js";

const baseCase: EvalCase = {
  id: "unit",
  description: "unit",
  tags: [],
  chat: { name: "Ana", isGroup: false, defaultContextId: "ctx-work" },
  person: "Ana",
  openTasks: [
    { id: "t1", kind: "todo", title: "Send the contract", dueAt: "2026-09-24T17:00:00+02:00", dueHasTime: false },
    { id: "t2", kind: "waiting_on", title: "Ana dergon fotot", dueAt: null },
  ],
  context: [{ id: "old", at: "09:00", fromOwner: false, sender: "Ana", text: "miremengjes" }],
  burst: [
    { id: "m1", at: "10:00", fromOwner: false, sender: "Ana", text: "send me the contract tomorrow" },
    { id: "m2", at: "10:01", fromOwner: true, text: "ok" },
  ],
  expected: [],
};
const memory = buildCaseMemory(baseCase);

const action = (overrides: Partial<ModelTaskAction>): ModelTaskAction => ({
  type: "create",
  kind: "todo",
  title: "Send the contract to Ana",
  description: "Ana e kerkoi kontraten.",
  language: "en",
  due: null,
  taskId: null,
  taskIds: null,
  contextId: null,
  contextReason: null,
  handled: null,
  confidence: 0.9,
  ambiguityReasons: [],
  evidenceMessageIds: ["m1"],
  ...overrides,
});

const validate = (...actions: ModelTaskAction[]) => validateModelActions({ actions }, memory, EVAL_SETTINGS);

describe("validateModelActions", () => {
  it("resolves a date-only due to 17:00 Europe/Rome", () => {
    const { actions } = validate(action({ due: { date: "2026-09-24", time: null } }));
    expect(actions[0]).toMatchObject({ type: "create", dueAt: "2026-09-24T17:00:00+02:00", dueHasTime: false, language: "en", contextId: null });
  });

  it("keeps a stated time", () => {
    const { actions } = validate(action({ due: { date: "2026-10-26", time: "09:30" } }));
    expect(actions[0]).toMatchObject({ dueAt: "2026-10-26T09:30:00+01:00", dueHasTime: true });
  });

  it("keeps a create with an unreadable or past due but marks it ambiguous", () => {
    const unreadable = validate(action({ due: { date: "2026-02-30", time: null } })).actions[0];
    expect(unreadable).toMatchObject({ dueAt: null, ambiguityReasons: ["the due date could not be understood"] });
    const past = validate(action({ due: { date: "2026-09-20", time: null } })).actions[0];
    expect(past?.ambiguityReasons).toContain("the due date is in the past");
  });

  it("drops actions citing unknown messages", () => {
    const result = validate(action({ evidenceMessageIds: ["m1", "ghost"] }), action({ evidenceMessageIds: [] }));
    expect(result.actions).toEqual([]);
    expect(result.dropped.map((drop) => drop.reason)).toEqual(["unknown_evidence", "no_evidence"]);
  });

  it("drops actions that cite only older context messages", () => {
    expect(validate(action({ evidenceMessageIds: ["old"] })).dropped[0]?.reason).toBe("no_new_evidence");
    expect(validate(action({ evidenceMessageIds: ["old", "m1"] })).actions).toHaveLength(1);
  });

  it("drops changes to tasks that are not in the open task list", () => {
    const result = validate(
      action({ type: "complete", taskId: "t999" }),
      action({ type: "cancel", taskId: null }),
      action({ type: "merge", taskIds: ["t1", "t999"] }),
      action({ type: "merge", taskIds: ["t1", "t1"] }),
    );
    expect(result.actions).toEqual([]);
    expect(result.dropped.every((drop) => drop.reason === "unknown_task")).toBe(true);
  });

  it("converts complete, cancel, reschedule, and merge", () => {
    const { actions } = validate(
      action({ type: "complete", taskId: "t2", evidenceMessageIds: ["m2"] }),
      action({ type: "reschedule", taskId: "t1", due: { date: "2026-09-28", time: "11:00" } }),
      action({ type: "merge", taskIds: ["t1", "t2"], confidence: 0.6 }),
    );
    expect(actions).toEqual([
      { type: "complete", taskId: "t2", confidence: 0.9, ambiguityReasons: [], evidenceMessageIds: ["m2"] },
      {
        type: "reschedule",
        taskId: "t1",
        dueAt: "2026-09-28T11:00:00+02:00",
        dueHasTime: true,
        confidence: 0.9,
        ambiguityReasons: [],
        evidenceMessageIds: ["m1"],
      },
      { type: "merge", taskIds: ["t1", "t2"], confidence: 0.6, ambiguityReasons: [], evidenceMessageIds: ["m1"] },
    ]);
  });

  it("drops a reschedule without a valid due or without a change", () => {
    const result = validate(
      action({ type: "reschedule", taskId: "t1", due: null }),
      action({ type: "reschedule", taskId: "t1", due: { date: "2026-13-01", time: null } }),
      action({ type: "reschedule", taskId: "t1", due: { date: "2026-09-24", time: null } }),
    );
    expect(result.dropped.map((drop) => drop.reason)).toEqual(["invalid_due", "invalid_due", "no_change"]);
  });

  it("drops creates without kind or a real title", () => {
    const result = validate(action({ kind: null }), action({ title: "  ok " }));
    expect(result.dropped.map((drop) => drop.reason)).toEqual(["missing_fields", "missing_fields"]);
  });

  it("only accepts a context override to a listed, different context with a reason", () => {
    const [valid, noReason, unknown, same] = [
      action({ contextId: "ctx-personal", contextReason: "birthday dinner" }),
      action({ title: "Merr torten", contextId: "ctx-personal", contextReason: " " }),
      action({ title: "Rezervo sallen", contextId: "ctx-invented", contextReason: "because" }),
      action({ title: "Thirr noterin", contextId: "ctx-work", contextReason: "work" }),
    ];
    const result = validate(valid, noReason, unknown, same);
    expect(result.actions.map((entry) => entry.type === "create" && entry.contextId)).toEqual(["ctx-personal", null, null, null]);
    expect(result.contextReasons).toEqual(["birthday dinner", null, null, null]);
  });

  it("clamps confidence, cleans ambiguity reasons, and dedupes evidence", () => {
    const { actions } = validate(action({ confidence: 1.7, ambiguityReasons: [" who? ", "", "who?"], evidenceMessageIds: ["m1", "m1"] }));
    expect(actions[0]).toMatchObject({ confidence: 1, ambiguityReasons: ["who?"], evidenceMessageIds: ["m1"] });
  });

  it("keeps the most confident of duplicate actions", () => {
    const result = validate(
      action({ type: "complete", taskId: "t1", confidence: 0.6 }),
      action({ type: "complete", taskId: "t1", confidence: 0.8 }),
      action({ type: "complete", taskId: "t1", confidence: 0.7 }),
    );
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0]?.confidence).toBe(0.8);
    expect(result.dropped.map((drop) => [drop.index, drop.reason])).toEqual([
      [0, "duplicate"],
      [2, "duplicate"],
    ]);
  });

  it("falls back to detecting the title language", () => {
    const { actions } = validate(action({ title: "Send the contract tomorrow", language: "English please" }));
    expect(actions[0]).toMatchObject({ language: "en" });
  });

  it("keeps a create's same-burst handled hint, citing only new messages", () => {
    const { actions } = validate(action({ handled: { status: "done", evidenceMessageIds: ["m2", "old", "nope", "m2"] } }));
    expect(actions[0]).toMatchObject({ type: "create", alreadyHandled: { status: "done", evidenceMessageIds: ["m2"] } });
  });

  it("drops a handled hint that cites no new message, keeping the create", () => {
    const { actions, dropped } = validate(action({ handled: { status: "cancelled", evidenceMessageIds: ["old"] } }));
    expect(dropped).toEqual([]);
    expect(actions[0]).toMatchObject({ type: "create" });
    expect(actions[0]).not.toHaveProperty("alreadyHandled");
  });
});

describe("validateModelActions with pending creates", () => {
  const pendingMemory = buildCaseMemory({
    ...baseCase,
    pendingTasks: [{ id: "p1", kind: "waiting_on", title: "Ana dergon faturen", dueAt: "2026-09-24T17:00:00+02:00", dueHasTime: false }],
  });
  const validatePending = (...actions: ModelTaskAction[]) => validateModelActions({ actions }, pendingMemory, EVAL_SETTINGS);

  it("accepts complete, cancel and reschedule on a pending id", () => {
    const { actions, dropped } = validatePending(
      action({ type: "complete", taskId: "p1" }),
      action({ type: "cancel", taskId: "p1" }),
      action({ type: "reschedule", taskId: "p1", due: { date: "2026-09-28", time: null } }),
    );
    expect(dropped).toEqual([]);
    expect(actions.map((kept) => kept.type)).toEqual(["complete", "cancel", "reschedule"]);
  });

  it("drops a reschedule to the pending item's current due", () => {
    expect(validatePending(action({ type: "reschedule", taskId: "p1", due: { date: "2026-09-24", time: null } })).dropped[0]?.reason).toBe("no_change");
  });

  it("never merges a pending id", () => {
    expect(validatePending(action({ type: "merge", taskIds: ["t1", "p1"] })).dropped[0]?.reason).toBe("unknown_task");
  });

  it("drops a create repeating a pending title", () => {
    const { actions, dropped } = validatePending(action({ kind: "waiting_on", title: "ana dergon FATUREN" }));
    expect(actions).toEqual([]);
    expect(dropped[0]?.reason).toBe("duplicate");
  });

  it("still rejects pending ids when no pending tasks were given", () => {
    expect(validate(action({ type: "complete", taskId: "p1" })).dropped[0]?.reason).toBe("unknown_task");
  });
});

describe("renderTaskAnalysisPrompt", () => {
  it("lists pending tasks as trusted system data", () => {
    const prompt = renderTaskAnalysisPrompt(buildCaseMemory({ ...baseCase, pendingTasks: [{ id: "p1", kind: "todo", title: "Dergo raportin", dueAt: null }] }));
    expect(prompt).toContain('"pendingTasks":[{"id":"p1","kind":"todo","title":"Dergo raportin","due":null}]');
    expect(prompt.indexOf('"pendingTasks"')).toBeLessThan(prompt.indexOf("<conversation>"));
  });

  it("fences untrusted messages and escapes delimiter spoofing", () => {
    const injection = evalCases.find((evalCase) => evalCase.id === "json-injection")!;
    const prompt = renderTaskAnalysisPrompt(buildCaseMemory(injection));
    expect(prompt.match(/<\/conversation>/g)).toHaveLength(1);
    expect(prompt).toContain("\\u003c/conversation\\u003e");
    expect(prompt.indexOf("<conversation>")).toBeLessThan(prompt.indexOf('"id":"m1"'));
  });

  it("labels derived media text separately from typed text", () => {
    const voice = evalCases.find((evalCase) => evalCase.id === "casual-voice-note-request")!;
    const prompt = renderTaskAnalysisPrompt(buildCaseMemory(voice));
    expect(prompt).toContain('"derived":{"type":"transcript","text":"hi alex please send me the quote');
  });
});

describe("analyzeChat", () => {
  it("calls the text model once with the read-only system prompt and returns audited actions", async () => {
    const model = mockJsonModel({ actions: [action({ due: { date: "2026-09-24", time: null } })] });
    const result = await analyzeChat(createMockProviders({ text: model }), memory);
    expect(result.actions).toHaveLength(1);
    expect(result.run).toMatchObject({ provider: "mock", promptVersion: PROMPT_VERSION, inputTokens: 100, outputTokens: 50 });
    expect(model.doGenerateCalls).toHaveLength(1);
    const call = model.doGenerateCalls[0]!;
    const system = call.prompt.find((message) => message.role === "system");
    expect(JSON.stringify(system)).toContain("read-only");
    expect(JSON.stringify(system)).toContain("UNTRUSTED EVIDENCE");
    expect(call.responseFormat?.type).toBe("json");
  });

  it("makes no model call without new messages", async () => {
    const model = mockJsonModel({ actions: [] });
    const contextOnly = buildCaseMemory({ ...baseCase, burst: [], nowTime: "12:00" });
    expect(contextOnly.messages.map((message) => message.isNew)).toEqual([false]);
    const result = await analyzeChat(createMockProviders({ text: model }), contextOnly);
    expect(result.actions).toEqual([]);
    expect(model.doGenerateCalls).toHaveLength(0);
  });

  it("drops a model that obeys an injection with invented tasks and evidence", async () => {
    const injection = evalCases.find((evalCase) => evalCase.id === "en-injection-mark-done")!;
    const model = mockJsonModel({
      actions: [
        action({ type: "complete", taskId: "t999", evidenceMessageIds: ["m1"] }),
        action({ type: "cancel", taskId: "t2", evidenceMessageIds: ["system"] }),
      ],
    });
    const result = await analyzeChat(createMockProviders({ text: model }), buildCaseMemory(injection));
    expect(result.actions).toEqual([]);
    expect(result.dropped.map((drop) => drop.reason)).toEqual(["unknown_task", "unknown_evidence"]);
  });

  it("propagates model output that does not match the schema", async () => {
    const model = mockJsonModel("not json at all");
    await expect(analyzeChat(createMockProviders({ text: model }), memory)).rejects.toThrow();
  });
});

function toModelAction(expected: ExpectedAction, evidenceId: string, index = 0): ModelTaskAction {
  switch (expected.type) {
    case "create":
      return action({
        kind: expected.kind,
        // Distinct per create: the validator drops creates with the same kind and title as duplicates.
        title: `Eval task title ${index + 1}`,
        due: expected.dueDate ? { date: expected.dueDate, time: expected.dueTime ?? null } : null,
        contextId: expected.contextId ?? null,
        contextReason: expected.contextId ? "fixture override" : null,
        handled: expected.handled ? { status: expected.handled, evidenceMessageIds: [evidenceId] } : null,
        evidenceMessageIds: [evidenceId],
      });
    case "reschedule":
      return action({ type: "reschedule", taskId: expected.taskId, due: { date: expected.dueDate, time: expected.dueTime ?? null }, evidenceMessageIds: [evidenceId] });
    case "merge":
      return action({ type: "merge", taskIds: expected.taskIds, evidenceMessageIds: [evidenceId] });
    default:
      return action({ type: expected.type, taskId: expected.taskId, evidenceMessageIds: [evidenceId] });
  }
}

describe("eval fixtures", () => {
  it("has at least 25 cases with unique ids, mostly casual chat language", () => {
    expect(evalCases.length).toBeGreaterThanOrEqual(25);
    expect(new Set(evalCases.map((evalCase) => evalCase.id)).size).toBe(evalCases.length);
    const casual = evalCases.filter((evalCase) => evalCase.tags.includes("casual")).length;
    expect(casual).toBeGreaterThan(evalCases.length / 2);
    expect(evalCases.filter((evalCase) => evalCase.tags.includes("injection")).length).toBeGreaterThanOrEqual(3);
  });

  it.each(evalCases.map((evalCase) => [evalCase.id, evalCase] as const))("%s is well-formed and scores perfectly with a perfect model", async (_id, evalCase) => {
    const evidenceId = evalCase.burst.at(-1)!.id;
    const model = mockJsonModel({ actions: evalCase.expected.map((expected, index) => toModelAction(expected, evidenceId, index)) });
    const result = await analyzeChat(createMockProviders({ text: model }), buildCaseMemory(evalCase));
    expect(result.dropped).toEqual([]);
    expect(scoreCase(evalCase, result.actions).problems).toEqual([]);
  });

  it("scores misses, extras, and wrong dues", () => {
    const evalCase = evalCases.find((candidate) => candidate.id === "casual-request-tomorrow")!;
    const wrongDue = scoreCase(evalCase, [
      {
        type: "create",
        kind: "todo",
        title: "Send the contract",
        description: "",
        dueAt: "2026-09-25T17:00:00+02:00",
        dueHasTime: false,
        contextId: null,
        language: "en",
        confidence: 0.9,
        ambiguityReasons: [],
        evidenceMessageIds: ["m1"],
      },
      { type: "complete", taskId: "t1", confidence: 0.9, ambiguityReasons: [], evidenceMessageIds: ["m1"] },
    ]);
    expect(wrongDue.truePositives.create).toBe(1);
    expect(wrongDue.falsePositives.complete).toBe(1);
    expect(wrongDue.dueCorrect).toBe(0);
    expect(wrongDue.dueChecked).toBe(1);
    expect(scoreCase(evalCase, []).falseNegatives.create).toBe(1);
  });
});

describe("owner-labelled create replays", () => {
  const replayCreate = (title: string, confidence: number, evidence: string[], ambiguityReasons: string[] = []) => ({
    type: "create" as const,
    kind: "todo" as const,
    title,
    description: "",
    dueAt: null,
    dueHasTime: false,
    contextId: null,
    language: "en",
    confidence,
    ambiguityReasons,
    evidenceMessageIds: evidence,
  });

  it("scores a candidate model's replay against accepted and rejected Review decisions", () => {
    const accepted = { decision: "accepted" as const, edited: false, action: { title: "Send the contract", evidenceMessageIds: ["m1"] } };
    const edited = { decision: "accepted" as const, edited: true, action: { title: "Pay the invoice", evidenceMessageIds: ["m2"] } };
    const rejected = { decision: "rejected" as const, edited: false, action: { title: "Bli lule", evidenceMessageIds: ["m3"] } };
    const samples = [
      replayPrediction(accepted, [replayCreate("Send the contract", 0.95, ["m1"])], 0.9),
      replayPrediction(edited, [replayCreate("pay the invoice ", 0.92, ["m9"])], 0.9),
      // Below the threshold or ambiguous: the candidate would still ask Review, so not an automatic create.
      replayPrediction(rejected, [replayCreate("Bli lule", 0.85, ["m3"]), replayCreate("Bli lule", 0.99, ["m3"], ["for whom?"])], 0.9),
    ];
    expect(samples.map((sample) => sample.predicted)).toEqual([true, true, false]);
    expect(scoreLabeledCreatePredictions([...samples, replayPrediction(rejected, [replayCreate("Bli lule", 0.95, ["m3"])], 0.9)])).toMatchObject({
      samples: 4,
      accepted: 2,
      rejected: 2,
      editedAccepted: 1,
      truePositives: 2,
      falsePositives: 1,
      trueNegatives: 1,
      precision: 2 / 3,
      recall: 1,
    });
  });
});
