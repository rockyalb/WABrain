import { render } from "preact";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../api";
import { ApiContext } from "../components/ui";
import type { ReviewItem, SyncResponse, Task } from "./model";
import { Workspace } from "./Workspace";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (message: string, status = 500) => json({ error: { code: "server_error", message } }, status);

const task = (id: string, title: string, values: Partial<Task> = {}): Task => ({
  id, kind: "todo", status: "open", title, description: "", dueAt: "2020-01-01T12:00:00.000Z", dueHasTime: true,
  contextId: null, chatId: null, personId: null, origin: "manual", language: null, confidence: null, evidenceMessageIds: [],
  createdAt: "2026-09-30T08:00:00.000Z", updatedAt: "2026-09-30T08:00:00.000Z", closedAt: null, ...values,
});

const review = (id: string): ReviewItem => ({
  id, type: "create", state: "pending", taskId: null, reason: "trial_period", chatId: null, personId: null,
  summary: "Book the van", handled: null, createdAt: "2026-09-30T08:00:00.000Z", decidedAt: null,
  action: { type: "create", kind: "todo", title: "Book the van", description: "", dueAt: null, dueHasTime: false, contextId: null, language: null, confidence: .9, ambiguityReasons: [], evidenceMessageIds: ["message"] },
});

const sync = (tasks: Task[] = [], reviews: ReviewItem[] = [], cursor = "cursor-1"): SyncResponse => ({
  cursor, full: true, tasks, reviewItems: reviews, contexts: [], chats: [], people: [],
  settings: { timezone: "Europe/Rome", endOfWorkDay: "17:00", dailySummaryTime: null, remindersEnabled: true, reminderLeadMinutes: 30, trialStartedAt: "2026-09-01T00:00:00.000Z", trialDays: 7, autoCreateThreshold: .85 },
  deleted: { tasks: [], reviewItems: [], contexts: [], chats: [], people: [] },
});

async function settle(rounds = 6) {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
}

describe("Workspace interactions", () => {
  let root: HTMLElement;

  beforeEach(() => {
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    vi.unstubAllGlobals();
  });

  const mount = async (fetch: typeof globalThis.fetch, hash = "#/tasks/today") => {
    const api = createApi({ fetch });
    await act(async () => {
      render(<ApiContext.Provider value={api}><Workspace section="tasks" hash={hash} /></ApiContext.Provider>, root);
    });
    await settle();
  };

  it("keeps unrelated task actions usable, rolls back a failure, and preserves a success when refresh fails", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    let syncCalls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET" && url.startsWith("/web/sync")) {
        syncCalls += 1;
        return syncCalls === 1 ? json(sync([task("one", "First task"), task("two", "Second task")])) : error("Sync unavailable", 503);
      }
      if (url === "/web/tasks/one/complete") return first.promise;
      if (url === "/web/tasks/two/complete") return second.promise;
      return error(`Unexpected ${url}`, 404);
    }) as typeof globalThis.fetch;
    await mount(fetch);

    const firstButton = root.querySelector<HTMLButtonElement>('button[aria-label="Complete First task"]')!;
    const secondButton = root.querySelector<HTMLButtonElement>('button[aria-label="Complete Second task"]')!;
    await act(async () => { firstButton.click(); });
    expect(firstButton.disabled).toBe(true);
    expect(secondButton.disabled).toBe(false);
    await act(async () => { secondButton.click(); });

    first.resolve(error("Completion refused"));
    second.resolve(json(task("two", "Second task", { status: "done", closedAt: "2026-09-30T10:00:00.000Z" })));
    await settle(10);

    expect(root.querySelector('button[aria-label="Complete First task"]')).not.toBeNull();
    expect(root.querySelector<HTMLButtonElement>('button[aria-label="Complete First task"]')!.disabled).toBe(false);
    expect(root.querySelector('button[aria-label="Complete Second task"]')).toBeNull();
    expect(root.textContent).toContain("Update failed");
    expect(root.textContent).toContain("Sync unavailable");
  });

  it("adopts a review decision even when its follow-up refresh fails", async () => {
    let syncCalls = 0;
    const item = review("review-one");
    const created = task("created", "Book the van", { origin: "ai", dueAt: null });
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if ((init?.method ?? "GET") === "GET" && url.startsWith("/web/sync")) {
        syncCalls += 1;
        return syncCalls === 1 ? json(sync([], [item])) : error("Sync unavailable", 503);
      }
      if (url === "/web/review/review-one/accept") return json({ reviewItem: { ...item, state: "accepted", decidedAt: "2026-09-30T10:00:00.000Z" }, task: created });
      return error(`Unexpected ${url}`, 404);
    }) as typeof globalThis.fetch;
    await mount(fetch, "#/tasks/review");

    const accept = [...root.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Accept")!;
    await act(async () => { accept.click(); });
    await settle(10);

    expect(root.textContent).not.toContain("Book the van");
    expect(root.textContent).toContain("Review is clear");
    expect(root.textContent).toContain("Update failed");
  });

  it("refreshes on foreground focus and removes the listener when unmounted", async () => {
    let syncCalls = 0;
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith("/web/sync")) {
        syncCalls += 1;
        return json({ ...sync([], [], `cursor-${syncCalls}`), full: syncCalls === 1 });
      }
      return error("Unexpected", 404);
    }) as typeof globalThis.fetch;
    await mount(fetch);
    const initial = syncCalls;

    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(syncCalls).toBe(initial + 1);

    render(null, root);
    window.dispatchEvent(new Event("focus"));
    await settle();
    expect(syncCalls).toBe(initial + 1);
  });
});
