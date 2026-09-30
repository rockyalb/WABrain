import type { Snapshot, SyncResponse, Task } from "./model";

type Entity = { id: string };

function mergeEntities<T extends Entity>(current: T[], changed: T[], deleted: string[]): T[] {
  // Keep the same array when nothing changed so views depending on it don't re-render.
  if (changed.length === 0 && deleted.length === 0) return current;
  const removed = new Set(deleted);
  const changes = new Map(changed.filter((item) => !removed.has(item.id)).map((item) => [item.id, item]));
  const merged = current
    .filter((item) => !removed.has(item.id))
    .map((item) => changes.get(item.id) ?? item);
  const existing = new Set(merged.map((item) => item.id));
  for (const item of changed) {
    if (!removed.has(item.id) && !existing.has(item.id)) {
      merged.push(item);
      existing.add(item.id);
    }
  }
  return merged;
}

/** Apply an ordered sync response. A server reset replaces all local collections. */
export function mergeSyncResponse(current: Snapshot | null, response: SyncResponse): Snapshot {
  if (!current || response.full) {
    return {
      tasks: response.tasks,
      reviewItems: response.reviewItems,
      contexts: response.contexts,
      chats: response.chats,
      people: response.people,
      settings: response.settings,
    };
  }
  return {
    tasks: mergeEntities(current.tasks, response.tasks, response.deleted.tasks),
    reviewItems: mergeEntities(current.reviewItems, response.reviewItems, response.deleted.reviewItems),
    contexts: mergeEntities(current.contexts, response.contexts, response.deleted.contexts),
    chats: mergeEntities(current.chats, response.chats, response.deleted.chats),
    people: mergeEntities(current.people, response.people, response.deleted.people),
    settings: response.settings,
  };
}

export function upsertSnapshotTask(current: Snapshot, task: Task): Snapshot {
  return { ...current, tasks: mergeEntities(current.tasks, [task], []) };
}

export function applyReviewDecision(current: Snapshot, reviewId: string, task?: Task | null): Snapshot {
  const withoutReview = { ...current, reviewItems: current.reviewItems.filter((item) => item.id !== reviewId) };
  return task ? upsertSnapshotTask(withoutReview, task) : withoutReview;
}

export interface RefreshCoordinator {
  request: () => Promise<void>;
}

/**
 * Serialize syncs and coalesce every request received during one in-flight sync
 * into a single follow-up. Each caller resolves only after its requested pass.
 */
export function createRefreshCoordinator(sync: () => Promise<void>): RefreshCoordinator {
  let requested = 0;
  let completed = 0;
  let running: Promise<void> | null = null;
  const waiters: Array<{ target: number; resolve: () => void; reject: (error: unknown) => void }> = [];

  const settle = (through: number, error?: unknown) => {
    for (let index = waiters.length - 1; index >= 0; index -= 1) {
      const waiter = waiters[index]!;
      if (waiter.target > through) continue;
      waiters.splice(index, 1);
      if (error === undefined) waiter.resolve();
      else waiter.reject(error);
    }
  };

  const drain = async () => {
    while (completed < requested) {
      const through = requested;
      try {
        await sync();
        completed = through;
        settle(through);
      } catch (error) {
        completed = through;
        settle(through, error);
      }
    }
  };

  const start = () => {
    if (running) return;
    running = drain().finally(() => {
      running = null;
      if (completed < requested) start();
    });
  };

  return {
    request: () => {
      const target = ++requested;
      const result = new Promise<void>((resolve, reject) => waiters.push({ target, resolve, reject }));
      start();
      return result;
    },
  };
}

export interface KeyedOperationRunner {
  run: (key: string, operation: () => Promise<unknown>) => Promise<boolean>;
}

/** Run unrelated mutations concurrently while suppressing duplicate work on one item. */
export function createKeyedOperationRunner(options: {
  afterSuccess: () => Promise<void>;
  onChange: (keys: ReadonlySet<string>) => void;
  onError: (error: unknown) => void;
}): KeyedOperationRunner {
  const pending = new Set<string>();
  const publish = () => options.onChange(new Set(pending));
  return {
    run: async (key, operation) => {
      if (pending.has(key)) return false;
      pending.add(key);
      publish();
      try {
        try {
          await operation();
        } catch (error) {
          options.onError(error);
          return false;
        }
        try {
          await options.afterSuccess();
        } catch (error) {
          // The server mutation already succeeded. Report stale data separately
          // without asking the caller to roll its successful interaction back.
          options.onError(error);
        }
        return true;
      } finally {
        pending.delete(key);
        publish();
      }
    },
  };
}
