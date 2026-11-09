import type { PolicyDecision, TaskAction, TaskLink } from "@wabrain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TaskService } from "../services/tasks.js";
import { and, eq } from "drizzle-orm";
import { chats, contactNames, notificationEvents, people, reviewItems } from "../schema.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { getTaskDetail } from "./tasks.js";
import { hasOpenLinks, listLinkableChats, listLinkedOpenTasks, listLinkedPendingCreates } from "./task-links.js";

let testDb: TestDatabase;
let service: TaskService;
const now = new Date("2026-10-01T10:00:00.000Z");

const apply: PolicyDecision = { outcome: "apply", reason: "auto_create" };
const review: PolicyDecision = { outcome: "review", reason: "trial_period" };

const jordanLink: TaskLink = { name: "Jordan", chatId: "c-jordan", candidates: [], source: "ai" };
const robinLink: TaskLink = { name: "Robin", chatId: null, candidates: [{ chatId: "c-robin-h", name: "Robin Hale" }, { chatId: "c-robin-d", name: "Robin Diaz" }], source: "ai" };

const create = (title: string, links: TaskLink[]): TaskAction => ({
  type: "create",
  kind: "todo",
  title,
  description: "",
  dueAt: null,
  dueHasTime: false,
  contextId: null,
  language: "en",
  links,
  confidence: 0.9,
  ambiguityReasons: [],
  evidenceMessageIds: ["m1"],
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  service = new TaskService({ database: testDb.database, now: () => now });
  const { db } = testDb.database;
  await db.insert(people).values({ id: "p-jordan", displayName: "Jordan P." });
  await db.insert(contactNames).values({ jid: "jordan@c.us", name: "Jordan Price" });
  await db.insert(chats).values([
    { id: "c-casey", jid: "casey@c.us", name: "Casey <3", isGroup: false, mode: "on", lastMessageAt: new Date("2026-10-01T09:00:00Z") },
    { id: "c-jordan", jid: "jordan@c.us", name: "Jordan", isGroup: false, mode: "on", personId: "p-jordan", lastMessageAt: new Date("2026-09-30T09:00:00Z") },
    { id: "c-robin-h", jid: "robin-h@c.us", name: "Robin Hale", isGroup: false, mode: "on", lastMessageAt: null },
    { id: "c-robin-d", jid: "robin-d@c.us", name: "Robin Diaz", isGroup: false, mode: "on", lastMessageAt: null },
    { id: "c-design", jid: "design@g.us", name: "Design", isGroup: true, mode: "mentions_only", lastMessageAt: null },
    { id: "c-off", jid: "off@c.us", name: "Jordan Off", isGroup: false, mode: "off", lastMessageAt: null },
  ]);
});
afterAll(async () => {
  await testDb.drop();
});

describe("listLinkableChats", () => {
  it("lists every chat but Off ones, with all its names, most recently active first", async () => {
    const chatsList = await listLinkableChats(testDb.database.db);
    expect(chatsList.map((chat) => chat.id).slice(0, 2)).toEqual(["c-casey", "c-jordan"]);
    expect(chatsList.find((chat) => chat.id === "c-jordan")).toMatchObject({ name: "Jordan Price", names: ["Jordan Price", "Jordan P.", "Jordan"], isGroup: false });
    expect(chatsList.some((chat) => chat.id === "c-off")).toBe(false);
  });
});

describe("linked tasks", () => {
  it("creates the task with its links (never its own chat) and finds it from the linked chat", async () => {
    const result = await service.applyAction(create("Send Jordan the list", [jordanLink, robinLink, { ...jordanLink, chatId: "c-casey" }]), apply, { chatId: "c-casey" });
    if (result.outcome !== "applied") throw new Error("expected apply");
    expect(result.task.links).toEqual([jordanLink, robinLink]);
    const { db } = testDb.database;
    expect((await listLinkedOpenTasks(db, "c-jordan")).map((task) => task.id)).toEqual([result.task.id]);
    expect(await listLinkedOpenTasks(db, "c-casey")).toEqual([]);
    expect(await listLinkedOpenTasks(db, "c-robin-h")).toEqual([]); // unconfirmed links never count
    expect(await hasOpenLinks(db, "c-jordan")).toBe(true);
    expect(await hasOpenLinks(db, "c-robin-h")).toBe(false);

    await service.setStatus(result.task.id, "done");
    expect(await listLinkedOpenTasks(db, "c-jordan")).toEqual([]);
    expect(await hasOpenLinks(db, "c-jordan")).toBe(false);
  });

  it("finds a linked create still pending in Review, and accepting it keeps the links", async () => {
    const result = await service.applyAction(create("Tell the Design group about the meeting", [{ name: "Design group", chatId: "c-design", candidates: [], source: "ai" }]), review, {
      chatId: "c-casey",
    });
    if (result.outcome !== "review") throw new Error("expected review");
    const { db } = testDb.database;
    expect((await listLinkedPendingCreates(db, "c-design")).map((item) => item.id)).toEqual([result.reviewItem.id]);
    expect(await hasOpenLinks(db, "c-design")).toBe(true);

    const accepted = await service.acceptReview(result.reviewItem.id, { links: [{ chatId: "c-design" }, { chatId: "c-jordan", name: "Jordan" }] });
    expect(accepted.task?.links).toEqual([
      { name: "Design group", chatId: "c-design", candidates: [], source: "ai" },
      { name: "Jordan", chatId: "c-jordan", candidates: [], source: "owner" },
    ]);
    expect(await listLinkedPendingCreates(db, "c-design")).toEqual([]);
    expect(await hasOpenLinks(db, "c-design")).toBe(true); // now through the task
  });
});

describe("owner edits of links", () => {
  it("picks a chat for an unconfirmed link, keeps or drops the others, and undo restores them", async () => {
    const result = await service.applyAction(create("Send Robin the offer", [robinLink, jordanLink]), apply, { chatId: "c-casey" });
    if (result.outcome !== "applied") throw new Error("expected apply");

    // Keep the unconfirmed one as it is: nothing changes.
    const kept = await service.updateTask(result.task.id, { links: [{ name: "Robin", chatId: null }, { chatId: "c-jordan" }] });
    expect(kept.links).toEqual([robinLink, jordanLink]);

    // Pick Robin Hale for "Robin", drop Jordan.
    const picked = await service.updateTask(result.task.id, { links: [{ name: "Robin", chatId: "c-robin-h" }] });
    expect(picked.links).toEqual([{ name: "Robin", chatId: "c-robin-h", candidates: [], source: "owner" }]);
    expect((await listLinkedOpenTasks(testDb.database.db, "c-robin-h")).map((task) => task.id)).toEqual([result.task.id]);

    const detail = await getTaskDetail(testDb.database.db, result.task.id);
    const edit = detail.events.filter((event) => event.type === "edited").at(-1)!;
    const undone = await service.undoEvent(edit.id);
    expect(undone.links).toEqual([robinLink, jordanLink]);
  });

  it("refuses the task's own chat and unknown chats, and never invents an unconfirmed link", async () => {
    const { task } = await service.createManualTask({ kind: "todo", title: "Call Jordan", chatId: "c-casey" });
    await expect(service.updateTask(task.id, { links: [{ chatId: "c-casey" }] })).rejects.toMatchObject({ code: "validation_failed" });
    await expect(service.updateTask(task.id, { links: [{ chatId: "c-missing" }] })).rejects.toMatchObject({ code: "validation_failed" });
    const updated = await service.updateTask(task.id, { links: [{ name: "Taylor", chatId: null }, { chatId: "c-jordan" }, { chatId: "c-jordan" }] });
    expect(updated.links).toEqual([{ name: "Jordan P.", chatId: "c-jordan", candidates: [], source: "owner" }]);
  });
});

describe("confirming the contacts of a task created automatically", () => {
  const linkItems = async (taskId: string) =>
    testDb.database.db.select().from(reviewItems).where(and(eq(reviewItems.taskId, taskId), eq(reviewItems.type, "link")));
  const notificationFor = async (reviewItemId: string) => {
    const [row] = await testDb.database.db.select().from(notificationEvents).where(eq(notificationEvents.reviewItemId, reviewItemId));
    return row?.payload as Record<string, unknown> | undefined;
  };
  const autoCreate = async (title: string, links: TaskLink[]) => {
    const result = await service.applyAction(create(title, links), apply, { chatId: "c-casey" });
    if (result.outcome !== "applied") throw new Error("expected apply");
    return result.task;
  };

  it("asks to confirm the links with Accept, and Accept as is keeps the task's current links", async () => {
    const task = await autoCreate("Send Jordan the plan", [jordanLink]);
    const [item] = await linkItems(task.id);
    expect(item).toMatchObject({ state: "pending", reason: "link_confirmation", chatId: "c-casey", summary: "Contact: Send Jordan the plan" });
    expect(await notificationFor(item!.id)).toEqual({ type: "review", reviewItemId: item!.id, reviewType: "link", title: "Send Jordan the plan → Jordan P.", from: "Casey <3" });
    // The link works before it is confirmed.
    expect((await listLinkedOpenTasks(testDb.database.db, "c-jordan")).map((open) => open.id)).toContain(task.id);

    const accepted = await service.acceptReview(item!.id);
    expect(accepted.task?.links).toEqual([jordanLink]);
    expect((await linkItems(task.id))[0]).toMatchObject({ state: "accepted" });
  });

  it("adds a contact on accept, and Remove drops only the links the analysis proposed", async () => {
    const task = await autoCreate("Tell Jordan about the appointment", [jordanLink]);
    const [first] = await linkItems(task.id);
    const accepted = await service.acceptReview(first!.id, { links: [{ chatId: "c-jordan" }, { chatId: "c-robin-h" }] });
    expect(accepted.task?.links.map((link) => [link.chatId, link.source])).toEqual([["c-jordan", "ai"], ["c-robin-h", "owner"]]);

    const other = await autoCreate("Tell Jordan about the offer", [jordanLink]);
    await service.updateTask(other.id, { links: [{ chatId: "c-jordan" }, { chatId: "c-robin-d" }] });
    // Editing the links by hand answers the pending confirmation.
    expect((await linkItems(other.id))[0]).toMatchObject({ state: "accepted" });

    const refreshed = await autoCreate("Send Jordan the invoice", [jordanLink]);
    const [pending] = await linkItems(refreshed.id);
    const removed = await service.rejectReview(pending!.id);
    expect(removed.reviewItem.state).toBe("rejected");
    const detail = await getTaskDetail(testDb.database.db, refreshed.id);
    expect(detail.task.links).toEqual([]);
    expect(detail.events.at(-1)).toMatchObject({ type: "edited", actor: "owner" });
  });

  it("keeps links the owner added when the analysis's links are removed", async () => {
    const task = await autoCreate("Send Jordan the contract", [jordanLink]);
    const [item] = await linkItems(task.id);
    // Added through the task page while the confirmation waits (this settles it), then a new proposal arrives.
    await testDb.database.db.update(reviewItems).set({ state: "pending", decidedAt: null }).where(eq(reviewItems.id, item!.id));
    await service.updateTask(task.id, { links: [{ chatId: "c-jordan" }, { chatId: "c-design" }] });
    await testDb.database.db.update(reviewItems).set({ state: "pending", decidedAt: null }).where(eq(reviewItems.id, item!.id));
    await service.rejectReview(item!.id);
    const detail = await getTaskDetail(testDb.database.db, task.id);
    expect(detail.task.links.map((link) => link.chatId)).toEqual(["c-design"]);
  });

  it("asks who an unconfirmed name is, without an Accept in the notification", async () => {
    const task = await autoCreate("Send Robin the offer", [robinLink]);
    const [item] = await linkItems(task.id);
    expect(await notificationFor(item!.id)).toMatchObject({ reviewType: "link", title: "Send Robin the offer → Robin?", needsPick: true });
    const picked = await service.acceptReview(item!.id, { links: [{ name: "Robin", chatId: "c-robin-h" }] });
    expect(picked.task?.links).toEqual([{ name: "Robin", chatId: "c-robin-h", candidates: [], source: "owner" }]);
  });

  it("asks nothing for a task without links or one the owner accepted from Review", async () => {
    const plain = await autoCreate("No links", []);
    expect(await linkItems(plain.id)).toEqual([]);
    const proposed = await service.applyAction(create("Send Jordan the draft", [jordanLink]), review, { chatId: "c-casey" });
    if (proposed.outcome !== "review") throw new Error("expected review");
    const accepted = await service.acceptReview(proposed.reviewItem.id);
    expect(await linkItems(accepted.task!.id)).toEqual([]);
  });
});
