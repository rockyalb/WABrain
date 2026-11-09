import type { TaskAction } from "@wabrain/contracts";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newId } from "../ids.js";
import { analysisRuns } from "../schema.js";
import { TaskService } from "../services/tasks.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { listTaskCreateLabels, taskAnalysisProfile } from "./task-labels.js";

const PROFILE = { provider: "openai", model: "gpt-test", promptVersion: "task-analysis/1" };
const KEY = taskAnalysisProfile(PROFILE.provider, PROFILE.model, PROFILE.promptVersion)!;
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

describe("labels from owner Review decisions", () => {
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
    service = new TaskService({ database: testDb.database, now: () => NOW });
  });

  async function run(profile = PROFILE): Promise<string> {
    const id = newId();
    await testDb.database.db.insert(analysisRuns).values({ id, status: "succeeded", ...profile, inputMessageIds: ["m1"] });
    return id;
  }

  async function decide(decision: "accepted" | "rejected", confidence: number, title: string, profile = PROFILE) {
    const analysisRunId = await run(profile);
    const proposed = await service.applyAction(create(confidence, title), { outcome: "review", reason: "below_threshold" }, { analysisRunId });
    if (proposed.outcome !== "review") throw new Error("expected review");
    if (decision === "accepted") await service.acceptReview(proposed.reviewItem.id);
    else await service.rejectReview(proposed.reviewItem.id);
  }

  it("records every decided create as a label of the profile that proposed it", async () => {
    const other = { ...PROFILE, model: "gpt-test-2" };
    await decide("rejected", 0.5, "Rejected");
    await decide("accepted", 0.9, "Accepted");
    await decide("accepted", 0.8, "Other model", other);

    const labels = await listTaskCreateLabels(testDb.database.db, KEY);
    expect(labels).toHaveLength(2);
    expect(labels[0]).toMatchObject({ ...PROFILE, decision: "rejected", sourceMessageIds: ["m1"], action: { type: "create" } });
    expect(labels[1]).toMatchObject({ decision: "accepted", edited: false, confidence: 0.9 });
    expect(await listTaskCreateLabels(testDb.database.db)).toHaveLength(3);
  });
});
