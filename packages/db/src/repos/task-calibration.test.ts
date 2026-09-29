import type { TaskAction } from "@wabrain/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../ids.js";
import { analysisRuns } from "../schema.js";
import { TaskService } from "../services/tasks.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import {
  computeTaskCalibration,
  getAutoCreateStatus,
  getTaskCalibration,
  listTaskCalibrationLabels,
  resolveTaskCalibration,
  taskCalibrationProfile,
} from "./task-calibration.js";

const PROFILE = { provider: "openai", model: "gpt-test", promptVersion: "task-analysis/1" };
const KEY = taskCalibrationProfile(PROFILE.provider, PROFILE.model, PROFILE.promptVersion)!;
const NOW = new Date("2026-09-24T10:00:00.000Z");

const create = (confidence: number, title = `Task ${confidence}`, ambiguityReasons: string[] = []): Extract<TaskAction, { type: "create" }> => ({
  type: "create",
  kind: "todo",
  title,
  description: "",
  dueAt: null,
  dueHasTime: false,
  contextId: null,
  language: "en",
  confidence,
  ambiguityReasons,
  evidenceMessageIds: ["m1"],
});

type Label = { decision: "accepted" | "rejected"; edited: boolean; confidence: number; action: Extract<TaskAction, { type: "create" }> };
const label = (decision: Label["decision"], confidence: number, edited = false, ambiguity: string[] = []): Label => ({
  decision,
  edited,
  confidence,
  action: create(confidence, undefined, ambiguity),
});
const repeat = (count: number, make: (index: number) => Label) => Array.from({ length: count }, (_, index) => make(index));

describe("computeTaskCalibration", () => {
  const compute = (labels: Label[]) => computeTaskCalibration({ ...PROFILE, profileKey: KEY }, labels, NOW);

  it("needs 20 decisions with at least five accepted and five rejected", () => {
    expect(compute([])).toMatchObject({ ready: false, threshold: null, reason: "insufficient_labels" });
    // An owner who accepts everything never shows where the threshold belongs.
    expect(compute(repeat(25, (i) => label("accepted", 0.8 + i * 0.005)))).toMatchObject({ ready: false, reason: "insufficient_labels" });
    expect(compute([...repeat(15, () => label("accepted", 0.95)), ...repeat(4, () => label("rejected", 0.5))])).toMatchObject({
      ready: false,
      sampleCount: 19,
    });
  });

  it("picks the lowest confidence where at least 90% of the decisions at or above it were accepted", () => {
    const labels = [
      ...repeat(5, (i) => label("rejected", 0.5 + i * 0.05)), // 0.50 .. 0.70
      label("accepted", 0.72),
      label("rejected", 0.8),
      ...repeat(13, (i) => label("accepted", 0.82 + i * 0.01)), // 0.82 .. 0.94
    ];
    const result = compute(labels);
    // At 0.72: 14 accepted of 15 (93%). Anything lower includes more rejections.
    expect(result).toMatchObject({ ready: true, threshold: 0.72, sampleCount: 20, acceptedCount: 14, rejectedCount: 6, reason: null });
    expect(result.precisionAtThreshold).toBeCloseTo(14 / 15);
    expect(result.uneditedAcceptedAtThresholdCount).toBe(14);
  });

  it("needs five unedited acceptances at or above the threshold", () => {
    const labels = [
      ...repeat(10, () => label("rejected", 0.6)),
      ...repeat(10, () => label("accepted", 0.9, true)),
      ...repeat(4, () => label("accepted", 0.95)),
    ];
    expect(compute(labels)).toMatchObject({ ready: false, reason: "no_reliable_threshold" });
    expect(compute([...labels, label("accepted", 0.96)])).toMatchObject({ ready: true, threshold: 0.9 });
  });

  it("stays in Review when high-confidence proposals keep being rejected", () => {
    const labels = [...repeat(10, () => label("accepted", 0.9)), ...repeat(10, () => label("rejected", 0.95))];
    expect(compute(labels)).toMatchObject({ ready: false, reason: "no_reliable_threshold" });
  });

  it("ignores proposals the model flagged as ambiguous", () => {
    const labels = [
      ...repeat(5, () => label("rejected", 0.5)),
      ...repeat(15, () => label("accepted", 0.9)),
      ...repeat(10, () => label("rejected", 0.95, false, ["who does it?"])),
    ];
    expect(compute(labels)).toMatchObject({ ready: true, threshold: 0.9, sampleCount: 20, rejectedCount: 5 });
  });
});

describe("calibration from owner Review decisions", () => {
  let testDb: TestDatabase;
  let service: TaskService;

  beforeAll(async () => {
    testDb = await createTestDatabase();
  });
  afterAll(async () => {
    await testDb.drop();
  });
  beforeEach(async () => {
    await testDb.database.db.execute(sql`truncate eval_examples, review_items, analysis_runs cascade`);
    await testDb.database.db.execute(sql`delete from app_state where key = 'task.calibration'`);
    service = new TaskService({ database: testDb.database, now: () => NOW });
  });

  async function run(profile = PROFILE): Promise<string> {
    const id = newId();
    await testDb.database.db.insert(analysisRuns).values({ id, status: "succeeded", ...profile, inputMessageIds: ["m1"] });
    return id;
  }

  async function decide(decision: "accepted" | "rejected", confidence: number, title: string, profile = PROFILE) {
    const analysisRunId = await run(profile);
    const proposed = await service.applyAction(create(confidence, title), { outcome: "review", reason: "calibration_required" }, { analysisRunId });
    if (proposed.outcome !== "review") throw new Error("expected review");
    if (decision === "accepted") await service.acceptReview(proposed.reviewItem.id);
    else await service.rejectReview(proposed.reviewItem.id);
  }

  it("recalibrates the proposing profile on every decided create and activates once usable", async () => {
    for (let i = 0; i < 5; i += 1) await decide("rejected", 0.4 + i * 0.05, `Rejected ${i}`);
    for (let i = 0; i < 14; i += 1) await decide("accepted", 0.85 + i * 0.005, `Accepted ${i}`);
    expect(await getTaskCalibration(testDb.database.db, KEY)).toBeNull();
    const pending = await getAutoCreateStatus(testDb.database.db, { inTrial: false, autoCreateThreshold: 0.85 });
    expect(pending).toMatchObject({
      state: "calibrating",
      profile: PROFILE,
      calibration: { ready: false, reason: "insufficient_labels", decisions: 19, accepted: 14, rejected: 5 },
      required: { decisions: 20, accepted: 5, rejected: 5 },
    });

    await decide("accepted", 0.9, "Accepted last");
    const calibration = await getTaskCalibration(testDb.database.db, KEY);
    expect(calibration).toMatchObject({ ready: true, threshold: 0.85, sampleCount: 20 });
    expect(await getAutoCreateStatus(testDb.database.db, { inTrial: false, autoCreateThreshold: 0.9 })).toMatchObject({
      state: "active",
      calibration: { ready: true, threshold: 0.85, effectiveThreshold: 0.9 },
    });
    expect(await getAutoCreateStatus(testDb.database.db, { inTrial: true, autoCreateThreshold: 0.9 })).toMatchObject({ state: "trial" });

    // The labels are reusable for replays against another model or prompt.
    const labels = await listTaskCalibrationLabels(testDb.database.db, KEY);
    expect(labels).toHaveLength(20);
    expect(labels[0]).toMatchObject({ ...PROFILE, decision: "rejected", sourceMessageIds: ["m1"], action: { type: "create" } });
  });

  it("keeps each profile's decisions separate and calibrates a never-seen profile lazily", async () => {
    const other = { ...PROFILE, model: "gpt-test-2" };
    for (let i = 0; i < 5; i += 1) await decide("rejected", 0.5, `Old rejected ${i}`);
    for (let i = 0; i < 15; i += 1) await decide("accepted", 0.9, `Old accepted ${i}`);
    expect(await getTaskCalibration(testDb.database.db, KEY)).toMatchObject({ ready: true });
    expect(await resolveTaskCalibration(testDb.database, other, NOW)).toBeNull();

    // Labels written before calibration existed (no stored result): computed on first use.
    await testDb.database.db.execute(sql`delete from app_state where key = 'task.calibration'`);
    expect(await resolveTaskCalibration(testDb.database, PROFILE, NOW)).toMatchObject({ ready: true, threshold: 0.9 });
  });
});
