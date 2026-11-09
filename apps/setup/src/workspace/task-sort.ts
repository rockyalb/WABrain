import { TaskSortSchema, type Task, type TaskSort } from "@wabrain/contracts";

export const TASK_SORT_KEY = "wabrain-task-sort";
export const TASK_SORT_OPTIONS: ReadonlyArray<{ value: TaskSort; label: string }> = [
  { value: "default", label: "Default order" },
  { value: "due_asc", label: "Due date · soonest first" },
  { value: "due_desc", label: "Due date · latest first" },
  { value: "created_desc", label: "Created · newest first" },
  { value: "created_asc", label: "Created · oldest first" },
  { value: "updated_desc", label: "Last edited · newest first" },
  { value: "updated_asc", label: "Last edited · oldest first" },
];

export function savedTaskSort(): TaskSort {
  try { return TaskSortSchema.parse(window.localStorage.getItem(TASK_SORT_KEY)); } catch { return "default"; }
}

type SortableTask = Pick<Task, "id" | "dueAt" | "createdAt" | "updatedAt" | "closedAt">;

/** Compare instants rather than ISO strings, which may carry different UTC offsets. */
export function sortTasks<T extends SortableTask>(tasks: T[], sort: TaskSort, closed = false): T[] {
  const value = (task: T) => sort === "default" && closed ? task.closedAt ?? task.updatedAt
    : sort.startsWith("created_") ? task.createdAt : sort.startsWith("updated_") ? task.updatedAt : task.dueAt;
  const descending = sort.endsWith("_desc") || (sort === "default" && closed);
  return [...tasks].sort((a, b) => {
    const left = value(a), right = value(b);
    if (left === null || right === null) return left === right ? b.id.localeCompare(a.id) : left === null ? 1 : -1;
    return (Date.parse(left) - Date.parse(right)) * (descending ? -1 : 1) || b.id.localeCompare(a.id);
  });
}
