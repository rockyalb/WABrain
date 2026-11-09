import { render } from "preact";
import { Storage } from "happy-dom";
import { act } from "preact/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApi } from "../api";
import { ApiContext } from "../components/ui";
import type { Section } from "../sections";
import type { Chat, Context, Person, ReviewItem, SyncResponse, Task } from "./model";
import { Workspace } from "./Workspace";
import { TASK_SORT_KEY } from "./task-sort";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const error = (message: string, status = 500) => json({ error: { code: "server_error", message } }, status);

const task = (id: string, title: string, values: Partial<Task> = {}): Task => ({
  id, kind: "todo", status: "open", title, description: "", dueAt: "2020-01-01T12:00:00.000Z", dueHasTime: true,
  contextId: null, chatId: null, personId: null, links: [], origin: "manual", language: null, confidence: null, evidenceMessageIds: [],
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
    vi.stubGlobal("localStorage", new Storage());
    window.localStorage.removeItem(TASK_SORT_KEY);
    root = document.createElement("div");
    document.body.appendChild(root);
    vi.stubGlobal("matchMedia", () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  });

  afterEach(() => {
    render(null, root);
    root.remove();
    window.localStorage.removeItem(TASK_SORT_KEY);
    vi.unstubAllGlobals();
  });

  const mount = async (fetch: typeof globalThis.fetch, hash = "#/tasks/today", section: Section = "tasks") => {
    const api = createApi({ fetch });
    await act(async () => {
      render(<ApiContext.Provider value={api}><Workspace section={section} hash={hash} /></ApiContext.Provider>, root);
    });
    await settle();
  };

  it("sorts tasks, preserves tab membership, and remembers the choice after remount", async () => {
    const tasks = [
      task("old", "Old task", { createdAt: "2026-09-01T08:00:00Z", updatedAt: "2026-10-02T08:00:00Z" }),
      task("new", "New task", { createdAt: "2026-10-01T08:00:00Z", updatedAt: "2026-10-01T08:00:00Z" }),
      task("future", "Future task", { dueAt: "2099-01-01T08:00:00Z" }),
    ];
    const fetch = vi.fn(async () => json(sync(tasks))) as typeof globalThis.fetch;
    const titles = () => [...root.querySelectorAll(".ws-task-title")].map((item) => item.textContent);
    await mount(fetch);
    const select = root.querySelector<HTMLSelectElement>(".ws-task-sort select")!;
    await act(async () => { select.value = "created_desc"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(titles()).toEqual(["New task", "Old task"]);
    expect(window.localStorage.getItem(TASK_SORT_KEY)).toBe("created_desc");
    render(null, root);
    await mount(fetch);
    expect(root.querySelector<HTMLSelectElement>(".ws-task-sort select")!.value).toBe("created_desc");
    expect(titles()).toEqual(["New task", "Old task"]);
    const restored = root.querySelector<HTMLSelectElement>(".ws-task-sort select")!;
    await act(async () => { restored.value = "updated_desc"; restored.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(titles()).toEqual(["Old task", "New task"]);
  });

  it("restarts closed search in the selected order and ignores a stale response", async () => {
    const stale = deferred<Response>();
    const person: Person = { id: "mira", displayName: "Mira", jids: ["mira@c.us"], languages: [], defaultContextId: null, contextConfirmed: true, facts: [], updatedAt: "2026-10-01T08:00:00Z" };
    const requests: URL[] = [];
    const closed = (id: string) => task(id, id, { status: "done", closedAt: "2026-10-01T08:00:00Z" });
    const fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), "https://brain.example");
      if (url.pathname === "/web/sync") return json({ ...sync(), people: [person] });
      if (url.pathname === "/web/tasks") {
        requests.push(url);
        if (url.searchParams.get("sort") === "default") return stale.promise;
        return json({ items: [closed(url.searchParams.has("cursor") ? "Next page" : "Sorted first page")], nextCursor: url.searchParams.has("cursor") ? null : "next-page" });
      }
      return error(`Unexpected ${url}`, 404);
    }) as typeof globalThis.fetch;
    await mount(fetch, "#/tasks/closed");
    const contact = root.querySelector<HTMLInputElement>('input[role="combobox"]')!;
    await act(async () => { contact.focus(); });
    const option = [...root.querySelectorAll<HTMLElement>('[role="option"]')].find((item) => item.textContent?.includes("Mira"))!;
    await act(async () => { option.click(); });
    await settle();
    expect(requests.at(-1)!.searchParams.get("sort")).toBe("default");
    const select = root.querySelector<HTMLSelectElement>(".ws-task-sort select")!;
    await act(async () => { select.value = "updated_desc"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(requests.at(-1)!.searchParams.has("cursor")).toBe(false);
    expect(root.textContent).toContain("Sorted first page");
    stale.resolve(json({ items: [closed("Stale result")], nextCursor: "stale-cursor" }));
    await settle();
    expect(root.textContent).not.toContain("Stale result");
    await act(async () => { root.querySelector<HTMLButtonElement>(".ws-load-more")!.click(); });
    await settle();
    expect(requests.at(-1)!.searchParams.get("sort")).toBe("updated_desc");
    expect(requests.at(-1)!.searchParams.get("cursor")).toBe("next-page");
    expect(root.textContent).toContain("Next page");
    await act(async () => { select.value = "due_asc"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    await settle();
    expect(requests.at(-1)!.searchParams.get("sort")).toBe("due_asc");
    expect(requests.at(-1)!.searchParams.has("cursor")).toBe(false);
    expect(root.textContent).not.toContain("Next page");
  });

  it("marks open tasks the AI created on its own beside the due date", async () => {
    const tasks = [
      task("auto", "AI created", { origin: "ai", createdBy: "ai" }),
      task("accepted", "Accepted in review", { origin: "ai", createdBy: "owner" }),
      task("manual", "Added by hand", { createdBy: "owner" }),
      task("legacy", "Unknown creator", { origin: "ai" }),
    ];
    const fetch = vi.fn(async () => json(sync(tasks))) as typeof globalThis.fetch;
    await mount(fetch);

    const cards = [...root.querySelectorAll(".ws-task-card")];
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      const indicator = card.querySelector('[aria-label="Created by AI"]');
      expect(Boolean(indicator)).toBe(card.textContent!.includes("AI created"));
      if (indicator) expect(indicator.parentElement?.classList.contains("ws-due-date")).toBe(true);
    }
  });

  it("marks AI closures beside the date independently of task creation origin", async () => {
    const closedAt = new Date().toISOString();
    const tasks = [
      task("ai-done", "AI completed", { status: "done", origin: "manual", closedAt, closedBy: "ai" }),
      task("ai-cancelled", "AI cancelled", { status: "cancelled", closedAt, closedBy: "ai" }),
      task("owner", "Owner completed", { status: "done", origin: "ai", closedAt, closedBy: "owner" }),
      task("unknown", "Unknown closure", { status: "done", origin: "ai", closedAt }),
    ];
    const fetch = vi.fn(async () => json(sync(tasks))) as typeof globalThis.fetch;
    await mount(fetch, "#/tasks/closed");

    const cards = [...root.querySelectorAll(".ws-task-card")];
    expect(cards).toHaveLength(4);
    for (const card of cards) {
      const indicator = card.querySelector('[aria-label="Closed by AI"]');
      expect(Boolean(indicator)).toBe(card.textContent!.includes("AI completed") || card.textContent!.includes("AI cancelled"));
      if (indicator) {
        expect(indicator.parentElement?.className).toBe("ws-closed-date");
        expect(indicator.getAttribute("title")).toBe("Closed by AI");
      }
    }
  });

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

  it("shows the chats a task is linked to and asks who an unconfirmed name is", async () => {
    const chat = (id: string, name: string): Chat => ({
      id, jid: `${id}@c.us`, name, isGroup: false, mode: "on", defaultContextId: null, contextConfirmed: true, autoCreate: true,
      minimumAutoConfidence: null, aliases: [], personId: null, lastMessageAt: null,
    });
    const chats = [chat("casey", "Casey <3"), chat("jordan", "Jordan"), chat("robin-h", "Robin Hale"), chat("robin-d", "Robin Diaz")];
    const linked = task("t1", "Send Jordan the list", {
      chatId: "casey",
      links: [
        { name: "Jordan", chatId: "jordan", candidates: [], source: "ai" },
        { name: "Robin", chatId: null, candidates: [{ chatId: "robin-h", name: "Robin Hale" }, { chatId: "robin-d", name: "Robin Diaz" }], source: "ai" },
      ],
    });
    const patches: unknown[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.startsWith("/web/sync")) return json({ ...sync([linked]), chats });
      if (method === "GET" && url === "/web/tasks/t1") return json({ task: linked, events: [], evidence: [] });
      if (method === "PATCH" && url === "/web/tasks/t1") {
        patches.push(JSON.parse(String(init?.body)));
        return json(linked);
      }
      return error(`Unexpected ${method} ${url}`, 404);
    }) as typeof globalThis.fetch;

    await mount(fetch);
    expect(root.textContent).toContain("→ Jordan, Robin?");

    render(null, root);
    await mount(fetch, "#/tasks/t1");
    expect(root.textContent).toContain("Also closed from");
    expect(root.textContent).toContain("→ Jordan");
    const who = [...root.querySelectorAll<HTMLInputElement>('input[role="combobox"]')].find((input) => input.labels?.[0]?.textContent === "Who is “Robin”?")!;
    await act(async () => { who.focus(); });
    const options = [...root.querySelectorAll<HTMLElement>('[role="option"]')];
    // The suggested chats come first, then every other chat that could close it (never the task's own).
    expect(options.map((option) => option.textContent)).toEqual(["✦Choose a chat", "RRobin HaleSuggested", "RRobin DiazSuggested"]);
    await act(async () => { options[1]!.click(); });
    await settle();
    expect(patches).toEqual([{ links: [{ name: "Jordan", chatId: "jordan" }, { name: "Robin", chatId: "robin-h" }] }]);
  });

  it("shows a direct chat's context as its person's and keeps it out of the chat's rules", async () => {
    const family: Context = { id: "family", name: "Family", color: "#e11d48", sortOrder: 0 };
    const mira: Person = { id: "mira", displayName: "Mira", jids: ["mira@c.us"], languages: [], defaultContextId: "family", contextConfirmed: false, facts: [], updatedAt: "2026-09-30T08:00:00.000Z" };
    const chat: Chat = {
      id: "c-mira", jid: "mira@c.us", name: "Mira", isGroup: false, mode: "on", defaultContextId: "family", contextConfirmed: false, autoCreate: true,
      minimumAutoConfidence: null, aliases: [], personId: "mira", lastMessageAt: null,
    };
    const requests: Array<{ method: string; url: string; body: unknown }> = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (method === "GET" && url.startsWith("/web/sync")) return json({ ...sync(), contexts: [family], chats: [chat], people: [mira] });
      if (method === "GET" && url.startsWith("/web/chats/c-mira/messages")) return json({ items: [], nextCursor: null });
      requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) : null });
      if (url === "/web/chats/c-mira") return json(chat);
      if (url === "/web/people/mira") return json({ ...mira, contextConfirmed: true });
      return error(`Unexpected ${method} ${url}`, 404);
    }) as typeof globalThis.fetch;

    await mount(fetch, "#/chats/c-mira", "chats");
    expect(root.querySelector("select option[value='family']")).toBeNull();
    expect(root.textContent).toContain("Family");
    expect(root.querySelector<HTMLAnchorElement>(".ws-person-context a")?.getAttribute("href")).toBe("#/people/mira");

    const confirm = [...root.querySelectorAll("button")].find((button) => button.textContent === "Confirm")!;
    await act(async () => { confirm.click(); });
    await settle();
    const save = [...root.querySelectorAll("button")].find((button) => button.textContent === "Save rules")!;
    await act(async () => { save.click(); });
    await settle();

    expect(requests[0]).toEqual({ method: "PATCH", url: "/web/people/mira", body: { contextConfirmed: true } });
    expect(requests[1]).toMatchObject({ method: "PATCH", url: "/web/chats/c-mira" });
    expect(requests[1]!.body).not.toHaveProperty("defaultContextId");
    expect(requests[1]!.body).not.toHaveProperty("contextConfirmed");
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
