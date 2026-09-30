import type { MessageView, ReviewItem, Task, TaskEvent, TaskKind, TaskStatus } from "@wabrain/contracts";
import { and, asc, desc, eq, ne, sql, type SQL } from "drizzle-orm";
import type { Db } from "../client.js";
import { notFound } from "../errors.js";
import { toReviewItem, toTask, toTaskEvent, type ReviewItemRow, type TaskRow } from "../mappers.js";
import { clampLimit, decodeCursor, toPage, type Page, type PageRequest } from "../pagination.js";
import { reviewItems, taskEvents, tasks } from "../schema.js";
import { getMessageViews } from "./messages.js";

export interface TaskFilter extends PageRequest {
  /** "closed" is done or cancelled, newest closed first. */
  status?: TaskStatus | "closed" | null;
  kind?: TaskKind | null;
  contextId?: string | null;
  chatId?: string | null;
  personId?: string | null;
}

export async function listTasks(db: Db, filter: TaskFilter = {}): Promise<Page<Task>> {
  const limit = clampLimit(filter.limit);
  const closed = filter.status === "closed";
  // Closed tasks page by when they closed; a task closed without a time falls back to its last update.
  const closedAt = sql`coalesce(${tasks.closedAt}, ${tasks.updatedAt})`;
  const where: SQL[] = [];
  if (filter.status === "closed") where.push(ne(tasks.status, "open"));
  else if (filter.status) where.push(eq(tasks.status, filter.status));
  if (filter.kind) where.push(eq(tasks.kind, filter.kind));
  if (filter.contextId) where.push(eq(tasks.contextId, filter.contextId));
  if (filter.chatId) where.push(eq(tasks.chatId, filter.chatId));
  if (filter.personId) where.push(eq(tasks.personId, filter.personId));
  if (filter.cursor) {
    const [at, id] = decodeCursor(filter.cursor, 2);
    where.push(sql`(${closed ? closedAt : tasks.createdAt}, ${tasks.id}) < (${String(at)}::timestamptz, ${String(id)})`);
  }
  const rows = await db
    .select()
    .from(tasks)
    .where(and(...where))
    .orderBy(...(closed ? [desc(closedAt), desc(tasks.id)] : [desc(tasks.createdAt), desc(tasks.id)]))
    .limit(limit + 1);
  return toPage(rows, limit, toTask, (row) => [(closed ? row.closedAt ?? row.updatedAt : row.createdAt).toISOString(), row.id]);
}

export async function findTaskRow(db: Db, id: string, lock = false): Promise<TaskRow | null> {
  const query = db.select().from(tasks).where(eq(tasks.id, id));
  const [row] = lock ? await query.for("update") : await query;
  return row ?? null;
}

export async function getTaskRow(db: Db, id: string, lock = false): Promise<TaskRow> {
  const row = await findTaskRow(db, id, lock);
  if (!row) throw notFound("Task");
  return row;
}

export async function getTask(db: Db, id: string): Promise<Task> {
  return toTask(await getTaskRow(db, id));
}

export async function listOpenTasksForChat(db: Db, chatId: string): Promise<Task[]> {
  const rows = await db
    .select()
    .from(tasks)
    .where(and(eq(tasks.chatId, chatId), eq(tasks.status, "open")))
    .orderBy(asc(tasks.createdAt));
  return rows.map(toTask);
}

/** Creates of this chat still waiting in Review, oldest first. */
export async function listPendingCreatesForChat(db: Db, chatId: string): Promise<ReviewItem[]> {
  const rows = await db
    .select()
    .from(reviewItems)
    .where(and(eq(reviewItems.chatId, chatId), eq(reviewItems.state, "pending"), eq(reviewItems.type, "create")))
    .orderBy(asc(reviewItems.createdAt));
  return rows.map(toReviewItem);
}

export interface TaskDetail {
  task: Task;
  events: TaskEvent[];
  evidence: MessageView[];
}

export async function getTaskDetail(db: Db, id: string): Promise<TaskDetail> {
  const task = await getTask(db, id);
  const events = (
    await db.select().from(taskEvents).where(eq(taskEvents.taskId, id)).orderBy(asc(taskEvents.createdAt))
  ).map(toTaskEvent);
  const evidenceIds = [...new Set([...task.evidenceMessageIds, ...events.flatMap((event) => event.evidenceMessageIds)])];
  return { task, events, evidence: await getMessageViews(db, evidenceIds) };
}

export async function listPendingReview(db: Db, page: PageRequest = {}): Promise<Page<ReviewItem>> {
  const limit = clampLimit(page.limit);
  const where: SQL[] = [eq(reviewItems.state, "pending")];
  if (page.cursor) {
    const [at, id] = decodeCursor(page.cursor, 2);
    where.push(sql`(${reviewItems.createdAt}, ${reviewItems.id}) < (${String(at)}::timestamptz, ${String(id)})`);
  }
  const rows = await db
    .select()
    .from(reviewItems)
    .where(and(...where))
    .orderBy(desc(reviewItems.createdAt), desc(reviewItems.id))
    .limit(limit + 1);
  return toPage(rows, limit, toReviewItem, (row) => [row.createdAt.toISOString(), row.id]);
}

export async function getReviewRow(db: Db, id: string, lock = false): Promise<ReviewItemRow> {
  const query = db.select().from(reviewItems).where(eq(reviewItems.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) throw notFound("Review item");
  return row;
}

/** Resolve notification links after a decision, including tasks created by an accepted proposal. */
export async function getReviewDetail(db: Db, id: string): Promise<{ reviewItem: ReviewItem; task: Task | null }> {
  const row = await getReviewRow(db, id);
  const taskId = row.resultTaskId ?? row.taskId;
  const task = taskId ? await findTaskRow(db, taskId) : null;
  return { reviewItem: toReviewItem(row), task: task ? toTask(task) : null };
}
