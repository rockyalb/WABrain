import type { TaskSort } from "@wabrain/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { encodeCursor } from "../pagination.js";
import { people, tasks } from "../schema.js";
import { createTestDatabase, type TestDatabase } from "../testing.js";
import { listTasks } from "./tasks.js";

let testDb: TestDatabase;
const date = (day: number) => new Date(Date.UTC(2026, 9, day, 8));

beforeAll(async () => {
  testDb = await createTestDatabase();
  await testDb.database.db.insert(people).values({ id: "contact", displayName: "Contact" });
  await testDb.database.db.insert(tasks).values([
    { id: "a", createdAt: date(1), updatedAt: date(3), dueAt: date(5) },
    { id: "b", createdAt: date(2), updatedAt: date(1), dueAt: null },
    { id: "c", createdAt: date(3), updatedAt: date(2), dueAt: date(4) },
    { id: "d", createdAt: date(3), updatedAt: date(2), dueAt: date(4) },
    { id: "e", createdAt: date(3), updatedAt: date(2), dueAt: null },
  ].map((row) => ({ ...row, kind: "todo" as const, status: "done" as const, title: row.id, origin: "manual" as const, personId: "contact", closedAt: date(6) })));
  // These must never leak through status/contact filters on any page.
  await testDb.database.db.insert(tasks).values([
    { id: "other-contact", kind: "todo", status: "done", title: "Other", origin: "manual", createdAt: date(2), updatedAt: date(2) },
    { id: "open", kind: "todo", title: "Open", origin: "manual", personId: "contact", createdAt: date(2), updatedAt: date(2) },
  ]);
});
afterAll(async () => { await testDb?.drop(); });

describe("task list sorting and keyset pagination", () => {
  it.each<[TaskSort, string[]]>([
    ["default", ["e", "d", "c", "b", "a"]],
    ["due_asc", ["d", "c", "a", "e", "b"]],
    ["due_desc", ["a", "d", "c", "e", "b"]],
    ["created_asc", ["a", "b", "e", "d", "c"]],
    ["created_desc", ["e", "d", "c", "b", "a"]],
    ["updated_asc", ["b", "e", "d", "c", "a"]],
    ["updated_desc", ["a", "e", "d", "c", "b"]],
  ])("pages %s across tied dates and null dates without skips or duplicates", async (sort, expected) => {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page = await listTasks(testDb.database.db, { status: "closed", personId: "contact", sort, limit: 1, cursor });
      ids.push(...page.items.map((task) => task.id));
      cursor = page.nextCursor;
      expect(ids.length).toBeLessThanOrEqual(5);
    } while (cursor);
    expect(ids).toEqual(expected);
  });

  it("accepts legacy default cursors and rejects cursors from a different sort", async () => {
    const filter = { status: "closed" as const, personId: "contact", limit: 1 };
    const page = await listTasks(testDb.database.db, filter);
    const next = await listTasks(testDb.database.db, { ...filter, cursor: page.nextCursor });
    expect(next.items[0]!.id).toBe("d");
    const sorted = await listTasks(testDb.database.db, { ...filter, sort: "created_asc" });
    await expect(listTasks(testDb.database.db, { ...filter, sort: "updated_asc", cursor: sorted.nextCursor })).rejects.toThrow("Invalid cursor");
    await expect(listTasks(testDb.database.db, { ...filter, sort: "due_asc", cursor: encodeCursor(["due_asc", "bad-date", "a"]) })).rejects.toThrow("Invalid cursor");
  });
});
