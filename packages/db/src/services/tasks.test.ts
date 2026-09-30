import type { PolicyDecision, TaskAction } from "@wabrain/contracts";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ChangeEvent } from "../notifier.js";
import { readSync } from "../repos/sync.js";
import { newId } from "../ids.js";
import { getTaskDetail, listPendingCreatesForChat } from "../repos/tasks.js";
import { chats, evalExamples, messages, notificationEvents, reviewItems } from "../schema.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { TaskService } from "./tasks.js";

let testDb: TestDatabase;
let events: ChangeEvent[];
let now: Date;
let service: TaskService;

const apply: PolicyDecision = { outcome: "apply", reason: "auto_create" };
const review: PolicyDecision = { outcome: "review", reason: "trial_period" };

const createAction = (title = "Send the contract"): TaskAction => ({
  type: "create",
  kind: "todo",
  title,
  description: "",
  dueAt: "2026-09-24T15:00:00.000Z",
  dueHasTime: false,
  contextId: null,
  language: "en",
  confidence: 0.93,
  ambiguityReasons: [],
  evidenceMessageIds: ["m1"],
});

beforeAll(async () => {
  testDb = await createTestDatabase();
});
afterAll(async () => {
  await testDb.drop();
});
beforeEach(() => {
  events = [];
  now = new Date("2026-09-23T10:00:00.000Z");
  service = new TaskService({ database: testDb.database, notifier: { notify: (event) => void events.push(event) }, now: () => now });
});

describe("TaskService", () => {
  it("resolves a date-only manual due to end of work day in the default timezone (UTC)", async () => {
    const { task } = await service.createManualTask({ kind: "todo", title: "Call the bank", dueAt: "2026-10-26" });
    expect(task.dueAt).toBe("2026-10-26T17:00:00.000Z");
    expect(task.dueHasTime).toBe(false);
    expect(task.origin).toBe("manual");
    expect(events).toEqual([{ type: "sync" }]);
  });

  it("creates manual tasks idempotently by client id", async () => {
    const id = "6f0f7c1e-6b0e-4f6f-9d7c-1f1e2a3b4c5d";
    const first = await service.createManualTask({ id, kind: "waiting_on", title: "Photos from Mira" });
    const second = await service.createManualTask({ id, kind: "waiting_on", title: "Different" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.task.title).toBe("Photos from Mira");
  });

  it("applies an AI create with an undoable event, and undo cancels it", async () => {
    const result = await service.applyAction(createAction(), apply);
    expect(result.outcome).toBe("applied");
    if (result.outcome !== "applied") return;
    const detail = await getTaskDetail(testDb.database.db, result.task.id);
    expect(detail.events).toHaveLength(1);
    expect(detail.events[0]).toMatchObject({ type: "created", actor: "ai" });
    expect(detail.events[0]!.undoableUntil).toBe("2026-09-30T10:00:00.000Z");

    const undone = await service.undoEvent(detail.events[0]!.id);
    expect(undone.status).toBe("cancelled");
    await expect(service.undoEvent(detail.events[0]!.id)).rejects.toMatchObject({ code: "conflict" });
    const after = await getTaskDetail(testDb.database.db, result.task.id);
    expect(after.events.map((event) => event.type)).toEqual(["created", "undone"]);
  });

  it("completes on owner evidence and undo restores the task", async () => {
    const created = await service.applyAction(createAction("Pay invoice"), apply);
    if (created.outcome !== "applied") throw new Error("expected apply");
    const completed = await service.applyAction(
      { type: "complete", taskId: created.task.id, confidence: 0.9, ambiguityReasons: [], evidenceMessageIds: ["m2"] },
      { outcome: "apply", reason: "owner_evidence" },
    );
    if (completed.outcome !== "applied") throw new Error("expected apply");
    expect(completed.task.status).toBe("done");
    expect(completed.task.closedAt).toBe(now.toISOString());
    const undone = await service.undoEvent(completed.eventIds[0]!);
    expect(undone.status).toBe("open");
    expect(undone.closedAt).toBeNull();
  });

  it("rejects undo after the undo window", async () => {
    const created = await service.applyAction(createAction("Old one"), apply);
    if (created.outcome !== "applied") throw new Error("expected apply");
    now = new Date(now.getTime() + 8 * 86_400_000);
    await expect(service.undoEvent(created.eventIds[0]!)).rejects.toMatchObject({ code: "conflict" });
  });

  it("maps review actions to review item types and notifies once", async () => {
    const created = await service.applyAction(createAction("Book the van"), apply);
    if (created.outcome !== "applied") throw new Error("expected apply");
    events = [];
    const possiblyDone = await service.applyAction(
      { type: "complete", taskId: created.task.id, confidence: 0.8, ambiguityReasons: [], evidenceMessageIds: ["m3"] },
      { outcome: "review", reason: "non_owner_evidence" },
    );
    expect(possiblyDone.outcome).toBe("review");
    if (possiblyDone.outcome !== "review") return;
    expect(possiblyDone.reviewItem).toMatchObject({ type: "possibly_done", taskId: created.task.id, state: "pending" });
    expect(events).toEqual([
      { type: "review", reviewItemId: possiblyDone.reviewItem.id, reviewType: "possibly_done", title: "Book the van" },
    ]);
    // A repeated prompt for the same task collapses into the pending one.
    const again = await service.applyAction(
      { type: "complete", taskId: created.task.id, confidence: 0.8, ambiguityReasons: [], evidenceMessageIds: ["m4"] },
      { outcome: "review", reason: "non_owner_evidence" },
    );
    expect(again.outcome === "review" && again.created).toBe(false);

    const accepted = await service.acceptReview(possiblyDone.reviewItem.id);
    expect(accepted.reviewItem.state).toBe("accepted");
    expect(accepted.task?.status).toBe("done");
    await expect(service.acceptReview(possiblyDone.reviewItem.id)).rejects.toMatchObject({ code: "conflict" });
  });

  it("accepts a create with owner edits and records labelled examples", async () => {
    const proposed = await service.applyAction(createAction("Send contract"), review);
    if (proposed.outcome !== "review") throw new Error("expected review");
    const { task, reviewItem } = await service.acceptReview(proposed.reviewItem.id, {
      title: "Send the signed contract",
      dueAt: "2026-03-29",
    });
    expect(reviewItem.state).toBe("accepted");
    expect(task).toMatchObject({ title: "Send the signed contract", dueAt: "2026-03-29T17:00:00.000Z", dueHasTime: false });

    const rejected = await service.applyAction(createAction("Buy flowers"), review);
    if (rejected.outcome !== "review") throw new Error("expected review");
    await service.rejectReview(rejected.reviewItem.id);

    const examples = await testDb.database.db.select().from(evalExamples);
    const byReview = new Map(examples.map((example) => [example.reviewItemId, example]));
    expect(byReview.get(proposed.reviewItem.id)).toMatchObject({ decision: "accepted", edits: { title: "Send the signed contract", dueAt: "2026-03-29" } });
    expect(byReview.get(rejected.reviewItem.id)).toMatchObject({ decision: "rejected", finalAction: null });
    const [row] = await testDb.database.db.select().from(reviewItems).where(eq(reviewItems.id, rejected.reviewItem.id));
    expect(row!.state).toBe("rejected");
  });

  it("merges tasks and undoes the whole merge", async () => {
    const a = await service.createManualTask({ kind: "todo", title: "Invoice A" });
    const b = await service.createManualTask({ kind: "todo", title: "Invoice A (dup)" });
    const proposal = await service.applyAction(
      { type: "merge", taskIds: [a.task.id, b.task.id], confidence: 0.7, ambiguityReasons: [], evidenceMessageIds: ["m9"] },
      { outcome: "review", reason: "merge_requires_review" },
    );
    if (proposal.outcome !== "review") throw new Error("expected review");
    expect(proposal.reviewItem.type).toBe("merge");
    const accepted = await service.acceptReview(proposal.reviewItem.id);
    expect(accepted.task?.id).toBe(a.task.id);
    const merged = await getTaskDetail(testDb.database.db, b.task.id);
    expect(merged.task.status).toBe("cancelled");
    const mergeEvent = merged.events.find((event) => event.type === "merged")!;
    await service.undoEvent(mergeEvent.id);
    expect((await getTaskDetail(testDb.database.db, b.task.id)).task.status).toBe("open");
  });

  describe("pending Review proposals", () => {
    const nonOwner: PolicyDecision = { outcome: "review", reason: "non_owner_evidence" };
    const reschedule = (taskId: string, dueAt: string, evidence = ["m20"]): TaskAction => ({
      type: "reschedule",
      taskId,
      dueAt,
      dueHasTime: true,
      confidence: 0.8,
      ambiguityReasons: [],
      evidenceMessageIds: evidence,
    });
    const pendingFor = (taskId: string) =>
      testDb.database.db.select().from(reviewItems).where(eq(reviewItems.taskId, taskId));
    const notificationsFor = (reviewItemId: string) =>
      testDb.database.db.select().from(notificationEvents).where(eq(notificationEvents.reviewItemId, reviewItemId));

    it("replaces a pending reschedule with a newer date, so accepting applies the latest", async () => {
      const { task } = await service.createManualTask({ kind: "todo", title: "Meet Sam" });
      events = [];
      const first = await service.applyAction(reschedule(task.id, "2026-09-25T09:00:00.000Z"), nonOwner);
      if (first.outcome !== "review") throw new Error("expected review");
      now = new Date(now.getTime() + 60_000);
      const second = await service.applyAction(reschedule(task.id, "2026-09-26T11:00:00.000Z", ["m21"]), nonOwner);
      if (second.outcome !== "review") throw new Error("expected review");

      expect(second.reviewItem.id).toBe(first.reviewItem.id);
      expect(second.created).toBe(false);
      expect(second.reviewItem.createdAt).toBe(now.toISOString());
      expect(await pendingFor(task.id)).toHaveLength(1);
      // Announced again for the new proposal; the superseded alert is gone.
      expect(events.map((event) => event.type)).toEqual(["review", "review"]);
      const alerts = await notificationsFor(first.reviewItem.id);
      expect(alerts).toHaveLength(1);
      expect(alerts[0]!.createdAt.toISOString()).toBe(now.toISOString());

      const accepted = await service.acceptReview(first.reviewItem.id);
      expect(accepted.task?.dueAt).toBe("2026-09-26T11:00:00.000Z");
    });

    it("returns the pending item for an identical retry without announcing it again", async () => {
      const { task } = await service.createManualTask({ kind: "todo", title: "Call the notary" });
      const action = reschedule(task.id, "2026-09-27T08:00:00.000Z");
      const first = await service.applyAction(action, nonOwner);
      if (first.outcome !== "review") throw new Error("expected review");
      events = [];
      now = new Date(now.getTime() + 60_000);
      const retry = await service.applyAction({ ...action, evidenceMessageIds: [...action.evidenceMessageIds] }, nonOwner);
      if (retry.outcome !== "review") throw new Error("expected review");
      expect(retry).toMatchObject({ created: false, reviewItem: { id: first.reviewItem.id, createdAt: first.reviewItem.createdAt } });
      expect(events).toEqual([]);
      expect(await pendingFor(task.id)).toHaveLength(1);
      expect(await notificationsFor(first.reviewItem.id)).toHaveLength(1);
    });

    it("refreshes the evidence of an unchanged proposal without announcing it again", async () => {
      const { task } = await service.createManualTask({ kind: "todo", title: "Return the keys" });
      const first = await service.applyAction(reschedule(task.id, "2026-09-28T08:00:00.000Z"), nonOwner);
      if (first.outcome !== "review") throw new Error("expected review");
      events = [];
      now = new Date(now.getTime() + 60_000);
      const refreshed = await service.applyAction(reschedule(task.id, "2026-09-28T08:00:00.000Z", ["m20", "m22"]), nonOwner);
      if (refreshed.outcome !== "review") throw new Error("expected review");
      expect(refreshed.reviewItem).toMatchObject({ id: first.reviewItem.id, createdAt: first.reviewItem.createdAt });
      expect(refreshed.reviewItem.action).toMatchObject({ evidenceMessageIds: ["m20", "m22"] });
      expect(events).toEqual([{ type: "sync" }]);
    });

    it("keeps different merge suggestions that share their first task apart", async () => {
      const a = await service.createManualTask({ kind: "todo", title: "Invoice March" });
      const b = await service.createManualTask({ kind: "todo", title: "Invoice March (copy)" });
      const c = await service.createManualTask({ kind: "todo", title: "March invoice" });
      const mergeOf = (taskIds: string[]): TaskAction => ({ type: "merge", taskIds, confidence: 0.7, ambiguityReasons: [], evidenceMessageIds: ["m30"] });
      const decision: PolicyDecision = { outcome: "review", reason: "merge_requires_review" };
      const ab = await service.applyAction(mergeOf([a.task.id, b.task.id]), decision);
      const ac = await service.applyAction(mergeOf([a.task.id, c.task.id]), decision);
      if (ab.outcome !== "review" || ac.outcome !== "review") throw new Error("expected review");
      expect(ab.created && ac.created).toBe(true);
      expect(ac.reviewItem.id).not.toBe(ab.reviewItem.id);
      const retry = await service.applyAction(mergeOf([a.task.id, b.task.id]), decision);
      expect(retry.outcome === "review" && retry.reviewItem.id).toBe(ab.reviewItem.id);
      expect(retry.outcome === "review" && retry.created).toBe(false);
      const merges = await testDb.database.db.select().from(reviewItems).where(eq(reviewItems.taskId, a.task.id));
      expect(merges.filter((item) => item.state === "pending")).toHaveLength(2);
    });
  });

  describe("changes to a create still pending in Review", () => {
    const pendingDecision: PolicyDecision = { outcome: "review", reason: "pending_create" };
    let chatId: string;

    async function message(body: string, fromOwner = false): Promise<string> {
      const id = newId();
      await testDb.database.db.insert(messages).values({
        id,
        chatId,
        waMessageId: `wa-${id}`,
        senderJid: fromOwner ? "owner@s.whatsapp.net" : "mira@s.whatsapp.net",
        direction: fromOwner ? "outgoing" : "incoming",
        fromOwner,
        kind: "text",
        body,
        source: "webhook",
        sentAt: now,
      });
      return id;
    }

    async function pendingCreate(title: string) {
      const proposed = await service.applyAction({ ...(createAction(title) as Extract<TaskAction, { type: "create" }>), kind: "waiting_on" }, review, { chatId });
      if (proposed.outcome !== "review") throw new Error("expected review");
      return proposed.reviewItem;
    }

    const change = (type: "complete" | "cancel", taskId: string, evidence: string): TaskAction => ({
      type,
      taskId,
      confidence: 0.88,
      ambiguityReasons: [],
      evidenceMessageIds: [evidence],
    });

    beforeEach(async () => {
      chatId = newId();
      await testDb.database.db.insert(chats).values({ id: chatId, jid: `${chatId}@s.whatsapp.net`, name: "Mira", isGroup: false, mode: "on" });
    });

    it("marks the pending create as possibly done, quoting the message, without a new item or alert", async () => {
      const item = await pendingCreate("Mira sends the wedding photos");
      const evidence = await message("here they are, all of them 📸");
      events = [];
      const result = await service.applyAction(change("complete", item.id, evidence), pendingDecision, { chatId, actionKey: "run-2:0" });
      expect(result).toMatchObject({ outcome: "review", created: false, reviewItem: { id: item.id, state: "pending" } });
      if (result.outcome !== "review") return;
      expect(result.reviewItem.handled).toEqual({
        status: "done",
        evidenceMessageIds: [evidence],
        confidence: 0.88,
        excerpt: "here they are, all of them 📸",
        fromOwner: false,
        at: now.toISOString(),
      });
      expect(events).toEqual([{ type: "sync" }]);
      expect(await testDb.database.db.select().from(reviewItems).where(eq(reviewItems.chatId, chatId))).toHaveLength(1);
      // A retried job applies nothing twice.
      events = [];
      const retried = await service.applyAction(change("complete", item.id, evidence), pendingDecision, { chatId, actionKey: "run-2:0" });
      expect(retried).toMatchObject({ outcome: "review", reviewItem: { id: item.id } });
      expect(events).toEqual([]);
    });

    it("moves a pending create's due on reschedule", async () => {
      const item = await pendingCreate("Mira sends the invoice");
      const evidence = await message("I'll send it on Monday instead");
      const result = await service.applyAction(
        { type: "reschedule", taskId: item.id, dueAt: "2026-09-28T15:00:00.000Z", dueHasTime: false, confidence: 0.9, ambiguityReasons: [], evidenceMessageIds: [evidence] },
        pendingDecision,
        { chatId },
      );
      if (result.outcome !== "review") throw new Error("expected review");
      expect(result.reviewItem.handled).toBeNull();
      expect(result.reviewItem.action).toMatchObject({ type: "create", dueAt: "2026-09-28T15:00:00.000Z", evidenceMessageIds: ["m1", evidence] });
    });

    it("turns the change into an ordinary proposal when the create was accepted meanwhile", async () => {
      const item = await pendingCreate("Mira sends the menu");
      const { task } = await service.acceptReview(item.id);
      const evidence = await message("sent you the menu");
      const result = await service.applyAction(change("complete", item.id, evidence), pendingDecision, { chatId });
      expect(result).toMatchObject({ outcome: "review", created: true, reviewItem: { type: "possibly_done", taskId: task!.id } });
    });

    it("drops the change when the create was rejected meanwhile", async () => {
      const item = await pendingCreate("Mira sends the tickets");
      await service.rejectReview(item.id);
      const evidence = await message("never mind the tickets");
      expect(await service.applyAction(change("cancel", item.id, evidence), pendingDecision, { chatId })).toEqual({ outcome: "dropped", reason: "task_not_open" });
    });

    it("accepts as already done: the task is kept closed and the create counts as accepted", async () => {
      const item = await pendingCreate("Mira sends the playlist");
      const evidence = await message("playlist sent!");
      await service.applyAction(change("complete", item.id, evidence), pendingDecision, { chatId });
      const { task, reviewItem } = await service.acceptReview(item.id, {}, "done");
      expect(reviewItem.state).toBe("accepted");
      expect(task).toMatchObject({ status: "done", title: "Mira sends the playlist" });
      const detail = await getTaskDetail(testDb.database.db, task!.id);
      expect(detail.events.map((event) => [event.type, event.actor])).toEqual([["created", "owner"], ["completed", "owner"]]);
      expect(detail.events[1]!.evidenceMessageIds).toEqual([evidence]);
      const [example] = await testDb.database.db.select().from(evalExamples).where(eq(evalExamples.reviewItemId, item.id));
      expect(example).toMatchObject({ decision: "accepted" });
      expect(await listPendingCreatesForChat(testDb.database.db, chatId)).toEqual([]);
    });

    it("stamps a create handled in its own burst with the hint from the start", async () => {
      const request = await message("can you check the order document?");
      const reply = await message("here you go, all ready", true);
      events = [];
      const result = await service.applyAction(
        { ...(createAction("Check the order document") as Extract<TaskAction, { type: "create" }>), evidenceMessageIds: [request], alreadyHandled: { status: "done", evidenceMessageIds: [reply] } },
        { outcome: "review", reason: "already_handled" },
        { chatId },
      );
      if (result.outcome !== "review") throw new Error("expected review");
      expect(result).toMatchObject({ created: true, reviewItem: { type: "create", reason: "already_handled" } });
      expect(result.reviewItem.handled).toMatchObject({ status: "done", evidenceMessageIds: [reply], excerpt: "here you go, all ready", fromOwner: true });
      expect(events.map((event) => event.type)).toEqual(["review"]);
      const { task } = await service.acceptReview(result.reviewItem.id, {}, "done");
      expect(task).toMatchObject({ status: "done", title: "Check the order document" });
    });

    it("refuses closeAs on anything but a create", async () => {
      const created = await service.applyAction(createAction("Pay rent"), apply, { chatId });
      if (created.outcome !== "applied") throw new Error("expected applied");
      const evidence = await message("I paid the rent");
      const proposed = await service.applyAction(change("complete", created.task.id, evidence), { outcome: "review", reason: "non_owner_evidence" }, { chatId });
      if (proposed.outcome !== "review") throw new Error("expected review");
      await expect(service.acceptReview(proposed.reviewItem.id, {}, "done")).rejects.toMatchObject({ code: "validation_failed" });
    });
  });

  it("owner status changes are idempotent and reflected in sync deltas", async () => {
    const start = await readSync(testDb.database, null, now);
    const { task } = await service.createManualTask({ kind: "todo", title: "Water plants" });
    const delta1 = await readSync(testDb.database, start.cursor, now);
    expect(delta1.full).toBe(false);
    expect(delta1.tasks.map((t) => t.id)).toContain(task.id);

    await service.setStatus(task.id, "done");
    events = [];
    await service.setStatus(task.id, "done");
    expect(events).toEqual([]);
    const delta2 = await readSync(testDb.database, delta1.cursor, now);
    expect(delta2.tasks.find((t) => t.id === task.id)?.status).toBe("done");
    const delta3 = await readSync(testDb.database, delta2.cursor, now);
    expect(delta3.tasks).toEqual([]);
  });
});
