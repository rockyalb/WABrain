import { describe, expect, it, vi } from "vitest";
import type { Snapshot, SyncResponse } from "./model";
import { applyReviewDecision, createKeyedOperationRunner, createRefreshCoordinator, mergeSyncResponse, upsertSnapshotTask } from "./sync";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const snapshot = (values: Partial<Snapshot> = {}): Snapshot => ({
  tasks: [], reviewItems: [], contexts: [], chats: [], people: [], settings: { timezone: "Europe/Rome" },
  ...values,
} as unknown as Snapshot);

const response = (values: Partial<SyncResponse> = {}): SyncResponse => ({
  ...snapshot(), cursor: "next", full: false,
  deleted: { tasks: [], reviewItems: [], contexts: [], chats: [], people: [] },
  ...values,
} as unknown as SyncResponse);

describe("workspace delta sync", () => {
  it("upserts changed entities, applies tombstones, and keeps untouched data", () => {
    const before = snapshot({
      tasks: [{ id: "keep", title: "Old" }, { id: "gone", title: "Remove" }] as Snapshot["tasks"],
      contexts: [{ id: "context", name: "Work" }] as Snapshot["contexts"],
    });
    const merged = mergeSyncResponse(before, response({
      tasks: [{ id: "keep", title: "Updated" }, { id: "new", title: "Added" }] as SyncResponse["tasks"],
      settings: { timezone: "UTC" } as SyncResponse["settings"],
      deleted: { tasks: ["gone"], reviewItems: [], contexts: [], chats: [], people: [] },
    }));

    expect(merged.tasks.map((task) => [task.id, task.title])).toEqual([["keep", "Updated"], ["new", "Added"]]);
    expect(merged.contexts).toBe(before.contexts);
    expect(merged.settings.timezone).toBe("UTC");
    expect(before.tasks.map((task) => task.id)).toEqual(["keep", "gone"]);
  });

  it("replaces every collection when the server requests a full reset", () => {
    const before = snapshot({ tasks: [{ id: "stale" }] as Snapshot["tasks"], contexts: [{ id: "stale-context" }] as Snapshot["contexts"] });
    const merged = mergeSyncResponse(before, response({ full: true, tasks: [{ id: "fresh" }] as SyncResponse["tasks"] }));
    expect(merged.tasks.map((task) => task.id)).toEqual(["fresh"]);
    expect(merged.contexts).toEqual([]);
  });

  it("adopts an authoritative task mutation without replacing unrelated state", () => {
    const before = snapshot({ tasks: [{ id: "one", title: "Open", status: "open" }, { id: "two", title: "Other", status: "open" }] as Snapshot["tasks"] });
    const next = upsertSnapshotTask(before, { id: "one", title: "Open", status: "done" } as Snapshot["tasks"][number]);
    expect(next.tasks.map((task) => [task.id, task.status])).toEqual([["one", "done"], ["two", "open"]]);
    expect(next.contexts).toBe(before.contexts);
  });

  it("adopts a review decision and its resulting task together", () => {
    const before = snapshot({
      reviewItems: [{ id: "review-one" }, { id: "review-two" }] as Snapshot["reviewItems"],
      tasks: [{ id: "existing", status: "open" }] as Snapshot["tasks"],
    });
    const next = applyReviewDecision(before, "review-one", { id: "created", status: "open" } as Snapshot["tasks"][number]);
    expect(next.reviewItems.map((item) => item.id)).toEqual(["review-two"]);
    expect(next.tasks.map((task) => task.id)).toEqual(["existing", "created"]);
  });
});

describe("workspace refresh ordering", () => {
  it("serializes refreshes and coalesces calls received during one request", async () => {
    const first = deferred();
    const second = deferred();
    const sync = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const coordinator = createRefreshCoordinator(sync);

    const initial = coordinator.request();
    const foreground = coordinator.request();
    const reconnect = coordinator.request();
    expect(sync).toHaveBeenCalledTimes(1);

    first.resolve();
    await initial;
    expect(sync).toHaveBeenCalledTimes(2);
    let followUpFinished = false;
    void foreground.then(() => { followUpFinished = true; });
    await Promise.resolve();
    expect(followUpFinished).toBe(false);

    second.resolve();
    await Promise.all([foreground, reconnect]);
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("recovers after a failed refresh", async () => {
    const sync = vi.fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined);
    const coordinator = createRefreshCoordinator(sync);
    await expect(coordinator.request()).rejects.toThrow("offline");
    await expect(coordinator.request()).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(2);
  });

  it("continues accepting refreshes immediately after earlier callers settle", async () => {
    const sync = vi.fn(async () => {});
    const coordinator = createRefreshCoordinator(sync);
    for (let index = 0; index < 5; index += 1) await coordinator.request();
    expect(sync).toHaveBeenCalledTimes(5);
  });
});

describe("keyed workspace mutations", () => {
  it("allows unrelated items concurrently and suppresses a duplicate item action", async () => {
    const task = deferred();
    const review = deferred();
    const pending: string[][] = [];
    const afterSuccess = vi.fn(async () => {});
    const runner = createKeyedOperationRunner({
      afterSuccess,
      onChange: (keys) => pending.push([...keys].sort()),
      onError: vi.fn(),
    });

    const completing = runner.run("task:one", () => task.promise);
    const deciding = runner.run("review:two", () => review.promise);
    await expect(runner.run("task:one", async () => {})).resolves.toBe(false);
    expect(pending).toContainEqual(["review:two", "task:one"]);

    task.resolve();
    await expect(completing).resolves.toBe(true);
    expect(pending.at(-1)).toEqual(["review:two"]);
    review.resolve();
    await expect(deciding).resolves.toBe(true);
    expect(pending.at(-1)).toEqual([]);
    expect(afterSuccess).toHaveBeenCalledTimes(2);
  });

  it("does not roll back a successful mutation when its follow-up sync fails", async () => {
    const onError = vi.fn();
    const runner = createKeyedOperationRunner({
      afterSuccess: async () => { throw new Error("sync offline"); },
      onChange: vi.fn(),
      onError,
    });
    await expect(runner.run("task:one", async () => {})).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: "sync offline" }));
  });
});
