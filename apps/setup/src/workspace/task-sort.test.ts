import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Storage } from "happy-dom";
import type { TaskSort } from "@wabrain/contracts";
import { savedTaskSort, sortTasks, TASK_SORT_KEY } from "./task-sort";

const task = (id: string, createdAt: string, updatedAt: string, dueAt: string | null) => ({ id, createdAt, updatedAt, dueAt, closedAt: null });
const items = [
  task("a", "2026-10-01T08:00:00Z", "2026-10-03T08:00:00Z", "2026-10-05T08:00:00Z"),
  task("b", "2026-10-02T08:00:00Z", "2026-10-01T08:00:00Z", null),
  task("c", "2026-10-03T08:00:00Z", "2026-10-02T08:00:00Z", "2026-10-04T08:00:00Z"),
];

describe("task sorting", () => {
  beforeEach(() => { vi.stubGlobal("localStorage", new Storage()); });
  afterEach(() => { vi.unstubAllGlobals(); });
  it.each<[TaskSort, string[]]>([
    ["due_asc", ["c", "a", "b"]], ["due_desc", ["a", "c", "b"]],
    ["created_desc", ["c", "b", "a"]], ["created_asc", ["a", "b", "c"]],
    ["updated_desc", ["a", "c", "b"]], ["updated_asc", ["b", "c", "a"]],
  ])("sorts %s without mutating the source", (sort, expected) => {
    expect(sortTasks(items, sort).map((item) => item.id)).toEqual(expected);
    expect(items.map((item) => item.id)).toEqual(["a", "b", "c"]);
  });

  it("compares offsets as instants and breaks ties by ID descending", () => {
    const tied = [task("a", "2026-10-01T10:00:00+02:00", "", null), task("b", "2026-10-01T08:00:00Z", "", null)];
    expect(sortTasks(tied, "created_asc").map((item) => item.id)).toEqual(["b", "a"]);
    expect(sortTasks(tied, "due_desc").map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("retains due ordering for open lists and closure ordering for closed lists by default", () => {
    expect(sortTasks(items, "default").map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(sortTasks(items, "default", true).map((item) => item.id)).toEqual(["a", "c", "b"]);
  });

  it("reads a saved sort and safely falls back for an unknown preference", () => {
    window.localStorage.setItem(TASK_SORT_KEY, "created_asc");
    expect(savedTaskSort()).toBe("created_asc");
    window.localStorage.setItem(TASK_SORT_KEY, "removed-sort");
    expect(savedTaskSort()).toBe("default");
    window.localStorage.removeItem(TASK_SORT_KEY);
  });
});
