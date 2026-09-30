import type { MessageView, Task, TaskAction } from "@wabrain/contracts";
import { newId, schema } from "@wabrain/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, ownerAndDevice, type Harness } from "./test/harness.js";

let h: Harness;
let auth: Record<string, string>;
let cookie: string;

beforeAll(async () => {
  h = await createHarness({ worker: false });
  const creds = await ownerAndDevice(h);
  auth = { authorization: `Bearer ${creds.token}` };
  cookie = creds.cookie;
});
afterAll(async () => {
  await h.close();
});
beforeEach(() => {
  h.notifications.length = 0;
});

const get = async <T>(path: string) => {
  const response = await h.request(path, { headers: auth });
  expect(response.status, path).toBe(200);
  return (await response.json()) as T;
};
const send = (method: string, path: string, json?: unknown, headers: Record<string, string> = {}) =>
  h.request(path, { method, headers: { ...auth, ...headers }, ...(json === undefined ? {} : { json }) });

const createAction = (title: string): TaskAction => ({
  type: "create",
  kind: "todo",
  title,
  description: "",
  dueAt: null,
  dueHasTime: false,
  contextId: null,
  language: "en",
  confidence: 0.7,
  ambiguityReasons: [],
  evidenceMessageIds: ["m-1"],
});

describe("browser workspace", () => {
  it("uses the owner session for the task API and rejects other origins", async () => {
    expect((await h.request("/web/sync")).status).toBe(401);
    expect((await h.request("/web/sync", { headers: { cookie } })).status).toBe(200);
    expect((await h.request("/web/tasks", {
      method: "POST", headers: { cookie, origin: "https://other.example" }, json: { kind: "todo", title: "Blocked" },
    })).status).toBe(403);
    const created = await h.request("/web/tasks", {
      method: "POST", headers: { cookie }, json: { kind: "todo", title: "Browser task" },
    });
    expect(created.status).toBe(201);
    const task = (await created.json()) as Task;
    expect((await h.request(`/web/tasks/${task.id}`, { headers: { cookie } })).status).toBe(200);
  });
});

describe("tasks", () => {
  it("creates a manual task with a date-only due resolved in the default timezone (UTC)", async () => {
    const response = await send("POST", "/v1/tasks", { kind: "todo", title: "Send the contract", dueAt: "2026-03-29" });
    expect(response.status).toBe(201);
    const task = (await response.json()) as Task;
    expect(task).toMatchObject({ dueAt: "2026-03-29T17:00:00.000Z", dueHasTime: false, status: "open", origin: "manual" });
    expect(h.notifications).toEqual([{ type: "sync" }]);
    expect((await send("POST", "/v1/tasks", { kind: "todo", title: "" })).status).toBe(400);
    expect((await send("POST", "/v1/tasks", { kind: "todo", title: "x", dueAt: "tomorrow" })).status).toBe(400);
  });

  it("completes, undoes, and shows history", async () => {
    const task = (await (await send("POST", "/v1/tasks", { kind: "waiting_on", title: "Photos from Mira" })).json()) as Task;
    const done = (await (await send("POST", `/v1/tasks/${task.id}/complete`)).json()) as Task;
    expect(done.status).toBe("done");
    const detail = await get<{ events: { id: string; type: string; actor: string }[] }>(`/v1/tasks/${task.id}`);
    const completed = detail.events.find((event) => event.type === "completed")!;
    expect(completed.actor).toBe("owner");
    const undone = await send("POST", `/v1/task-events/${completed.id}/undo`);
    expect(undone.status).toBe(200);
    expect(((await undone.json()) as Task).status).toBe("open");
    const again = await send("POST", `/v1/task-events/${completed.id}/undo`);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: "conflict" } });
    expect((await send("POST", "/v1/task-events/missing/undo")).status).toBe(404);
  });

  it("edits, filters, and paginates", async () => {
    const task = (await (await send("POST", "/v1/tasks", { kind: "todo", title: "Rename me" })).json()) as Task;
    const edited = await send("PATCH", `/v1/tasks/${task.id}`, { title: "Renamed", dueAt: "2026-05-04T09:30:00+02:00" });
    expect(await edited.json()).toMatchObject({ title: "Renamed", dueAt: "2026-05-04T07:30:00.000Z", dueHasTime: true });
    const page = await get<{ items: Task[]; nextCursor: string | null }>("/v1/tasks?status=open&limit=1");
    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).not.toBeNull();
    const next = await get<{ items: Task[] }>(`/v1/tasks?status=open&limit=1&cursor=${page.nextCursor}`);
    expect(next.items[0]!.id).not.toBe(page.items[0]!.id);
    expect((await send("GET", "/v1/tasks?cursor=broken")).status).toBe(400);
    expect((await send("GET", "/v1/tasks/does-not-exist")).status).toBe(404);
  });

  it("lists done and cancelled tasks together, newest closed first", async () => {
    const make = async (title: string) => (await (await send("POST", "/v1/tasks", { kind: "todo", title })).json()) as Task;
    const first = await make("Closed first");
    const second = await make("Closed second");
    const stillOpen = await make("Closed filter stays open");
    await send("POST", `/v1/tasks/${first.id}/complete`);
    await send("POST", `/v1/tasks/${second.id}/cancel`);
    const page = await get<{ items: Task[]; nextCursor: string | null }>("/v1/tasks?status=closed&limit=1");
    expect(page.items.map((task) => task.id)).toEqual([second.id]);
    const next = await get<{ items: Task[] }>(`/v1/tasks?status=closed&limit=1&cursor=${page.nextCursor}`);
    expect(next.items.map((task) => task.id)).toEqual([first.id]);
    const all = await get<{ items: Task[] }>("/v1/tasks?status=closed&limit=200");
    expect(all.items.map((task) => task.id)).not.toContain(stillOpen.id);
    expect(all.items.every((task) => task.status === "done" || task.status === "cancelled")).toBe(true);
  });
});

describe("idempotency", () => {
  it("replays the first response for a repeated Idempotency-Key", async () => {
    const key = { "idempotency-key": "create-once-123" };
    const body = { kind: "todo", title: "Only once" };
    const first = await send("POST", "/v1/tasks", body, key);
    const second = await send("POST", "/v1/tasks", body, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    const a = (await first.json()) as Task;
    const b = (await second.json()) as Task;
    expect(b.id).toBe(a.id);
    const all = await get<{ items: Task[] }>("/v1/tasks?limit=200");
    expect(all.items.filter((task) => task.title === "Only once")).toHaveLength(1);
    const mismatch = await send("POST", "/v1/tasks", { ...body, title: "Different" }, key);
    expect(mismatch.status).toBe(409);
  });
});

describe("review", () => {
  it("accepts with edits, rejects, and syncs deltas", async () => {
    const start = await get<{ cursor: string }>("/v1/sync");
    const proposed = await h.deps.tasks.applyAction(createAction("Book the van"), { outcome: "review", reason: "trial_period" });
    const rejected = await h.deps.tasks.applyAction(createAction("Buy a gift"), { outcome: "review", reason: "trial_period" });
    if (proposed.outcome !== "review" || rejected.outcome !== "review") throw new Error("expected review");
    expect(h.notifications[0]).toMatchObject({ type: "review", reviewType: "create", title: "Book the van" });

    const pending = await get<{ items: { id: string }[] }>("/v1/review");
    expect(pending.items.map((item) => item.id).sort()).toEqual([proposed.reviewItem.id, rejected.reviewItem.id].sort());
    const delta1 = await get<{ reviewItems: { id: string }[]; cursor: string }>(`/v1/sync?since=${start.cursor}`);
    expect(delta1.reviewItems).toHaveLength(2);

    const accepted = await send("POST", `/v1/review/${proposed.reviewItem.id}/accept`, { edits: { title: "Book the van for Monday", dueAt: "2026-10-26" } });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      reviewItem: { state: "accepted" },
      task: { title: "Book the van for Monday", dueAt: "2026-10-26T17:00:00.000Z", origin: "ai" },
    });
    expect((await send("POST", `/v1/review/${rejected.reviewItem.id}/reject`)).status).toBe(200);
    expect((await send("POST", `/v1/review/${rejected.reviewItem.id}/reject`)).status).toBe(409);

    const delta2 = await get<{ reviewItems: unknown[]; deleted: { reviewItems: string[] }; tasks: Task[] }>(`/v1/sync?since=${delta1.cursor}`);
    expect(delta2.reviewItems).toEqual([]);
    expect(delta2.deleted.reviewItems.sort()).toEqual([proposed.reviewItem.id, rejected.reviewItem.id].sort());
    expect(delta2.tasks.map((task) => task.title)).toContain("Book the van for Monday");
  });

  it("resolves exact notification targets before and after decisions for both clients", async () => {
    const proposal = await h.deps.tasks.applyAction(createAction("Notification target"), { outcome: "review", reason: "trial_period" });
    if (proposal.outcome !== "review") throw new Error("expected review");
    const path = `/v1/review/${proposal.reviewItem.id}`;
    const webPath = `/web/review/${proposal.reviewItem.id}`;
    expect((await h.request(path)).status).toBe(401);
    expect((await h.request(webPath)).status).toBe(401);
    expect(await get(path)).toMatchObject({ reviewItem: { id: proposal.reviewItem.id, state: "pending" }, task: null });
    const accepted = await h.deps.tasks.acceptReview(proposal.reviewItem.id);
    expect(accepted.task).not.toBeNull();
    expect(await get(path)).toMatchObject({ reviewItem: { state: "accepted" }, task: { id: accepted.task!.id } });
    const web = await h.request(webPath, { headers: { cookie } });
    expect(web.status).toBe(200);
    expect(await web.json()).toMatchObject({ reviewItem: { state: "accepted" }, task: { id: accepted.task!.id } });
    // Old notification links remain informative after the resulting task is deleted.
    await h.testDb.database.db.delete(schema.tasks).where(eq(schema.tasks.id, accepted.task!.id));
    expect(await get(path)).toMatchObject({ reviewItem: { state: "accepted" }, task: null });
    expect((await send("GET", "/v1/review/missing")).status).toBe(404);
  });

  it("resolves rejected proposals without suggesting that a task was created", async () => {
    const proposal = await h.deps.tasks.applyAction(createAction("Rejected notification target"), { outcome: "review", reason: "trial_period" });
    if (proposal.outcome !== "review") throw new Error("expected review");
    await h.deps.tasks.rejectReview(proposal.reviewItem.id);
    expect(await get(`/v1/review/${proposal.reviewItem.id}`)).toMatchObject({ reviewItem: { state: "rejected" }, task: null });
  });
});

describe("contexts, settings, people, push", () => {
  it("manages contexts with reassignment on delete", async () => {
    const contexts = await get<{ id: string; name: string }[]>("/v1/contexts");
    const work = contexts.find((context) => context.name === "Work")!;
    const created = await send("POST", "/v1/contexts", { name: "Family", color: "#FF0000" });
    expect(created.status).toBe(201);
    const family = (await created.json()) as { id: string; sortOrder: number };
    expect(family.sortOrder).toBe(2);
    const task = (await (await send("POST", "/v1/tasks", { kind: "todo", title: "Dinner", contextId: family.id })).json()) as Task;
    expect((await send("PATCH", `/v1/contexts/${family.id}`, { name: "Home" })).status).toBe(200);
    expect((await send("DELETE", `/v1/contexts/${family.id}?reassignTo=${family.id}`)).status).toBe(400);
    expect((await send("DELETE", `/v1/contexts/${family.id}?reassignTo=${work.id}`)).status).toBe(204);
    expect((await get<{ task: Task }>(`/v1/tasks/${task.id}`)).task.contextId).toBe(work.id);
  });

  it("validates and updates settings; policy is setup-only", async () => {
    expect((await send("PATCH", "/v1/settings", { timezone: "Mars/Olympus" })).status).toBe(400);
    expect((await send("PATCH", "/v1/settings", { endOfWorkDay: "25:00" })).status).toBe(400);
    const updated = await send("PATCH", "/v1/settings", { endOfWorkDay: "18:30", dailySummaryTime: null });
    expect(await updated.json()).toMatchObject({ endOfWorkDay: "18:30", dailySummaryTime: null, timezone: "UTC" });
    const policy = await h.request("/setup/policy", { method: "PATCH", headers: { cookie }, json: { autoCreateThreshold: 0.9, trialDays: 0 } });
    expect(await policy.json()).toMatchObject({ autoCreateThreshold: 0.9, trialDays: 0 });
    expect((await send("PATCH", "/setup/policy", { trialDays: 3 })).status).toBe(401);
    // The trial is over, but nothing was calibrated: the app can tell the owner why creates still wait.
    expect(await get("/v1/settings")).toMatchObject({
      autoCreateThreshold: 0.9,
      autoCreate: { state: "calibrating", profile: null, calibration: { ready: false, reason: "insufficient_labels", decisions: 0 }, required: { decisions: 20 } },
    });
  });

  it("enforces the push endpoint SSRF policy", async () => {
    const keys = { p256dh: "B".repeat(87), auth: "A".repeat(22) };
    for (const endpoint of ["http://ntfy.sh/up123", "https://127.0.0.1/up", "https://10.1.2.3/up", "https://[::1]/up", "https://localhost/up", "https://user:pw@93.184.216.34/up"]) {
      const response = await send("POST", "/v1/push-endpoints", { endpoint, ...keys });
      expect(response.status, endpoint).toBe(400);
    }
    expect((await send("POST", "/v1/push-endpoints", { endpoint: "https://93.184.216.34/up?x=1", ...keys })).status).toBe(204);
    expect((await send("POST", "/v1/push-endpoints", { endpoint: "https://ntfy.internal/up", ...keys })).status).toBe(204);
    expect((await send("DELETE", "/v1/push-endpoints")).status).toBe(204);
  });

  it("returns every source message of a fact with the chat each one came from", async () => {
    const db = h.testDb.database.db;
    const personId = newId();
    const directId = newId();
    const groupId = newId();
    await db.insert(schema.people).values({ id: personId, displayName: "Arta", primaryJid: "447690001111@s.whatsapp.net" });
    await db.insert(schema.chats).values([
      { id: directId, jid: "447690001111@s.whatsapp.net", isGroup: false, mode: "on", personId, name: "Arta" },
      { id: groupId, jid: "120363000000000001@g.us", isGroup: true, mode: "on", name: "Office" },
    ]);
    const message = async (chatId: string, body: string, sentAt: string) => {
      const id = newId();
      await db.insert(schema.messages).values({
        id,
        chatId,
        waMessageId: `wa-${id}`,
        senderJid: "447690001111@s.whatsapp.net",
        senderName: "Arta",
        direction: "incoming",
        fromOwner: false,
        kind: "text",
        body,
        source: "webhook",
        sentAt: new Date(sentAt),
      });
      return id;
    };
    const inDirect = await message(directId, "Punoj te Banka X", "2026-09-01T09:00:00Z");
    const inGroup = await message(groupId, "From Bank X today", "2026-09-02T09:00:00Z");
    const factId = newId();
    await db.insert(schema.personFacts).values({
      id: factId,
      personId,
      key: "company",
      value: "Banka X",
      confidence: 0.9,
      source: "ai",
      sourceMessageIds: [inDirect, inGroup, "purged-message"],
    });

    const { items } = await get<{ items: MessageView[] }>(`/v1/people/${personId}/facts/${factId}/sources`);
    expect(items.map((item) => [item.id, item.chatId])).toEqual([
      [inDirect, directId],
      [inGroup, groupId],
    ]);
    expect((await send("GET", `/v1/people/${personId}/facts/missing/sources`)).status).toBe(404);
    expect((await send("GET", `/v1/people/missing/facts/${factId}/sources`)).status).toBe(404);
  });

  it("explains that Ask needs a text model and serves the OpenAPI document publicly", async () => {
    const ask = await send("POST", "/v1/ask", { question: "?" });
    expect(ask.status).toBe(409);
    expect(await ask.json()).toMatchObject({ error: { code: "conflict", message: expect.stringContaining("text model") } });
    const doc = (await (await h.request("/v1/openapi.json")).json()) as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toEqual(expect.arrayContaining(["/v1/sync", "/v1/tasks", "/v1/review/{id}/accept", "/v1/people/{id}/facts/{factId}/sources"]));
  });

  it("wipes everything on explicit confirmation", async () => {
    const before = await get<{ cursor: string }>("/v1/sync");
    expect((await h.request("/setup/wipe", { method: "POST", headers: { cookie }, json: { confirm: "yes" } })).status).toBe(400);
    expect((await h.request("/setup/wipe", { method: "POST", headers: { cookie }, json: { confirm: "DELETE EVERYTHING" } })).status).toBe(200);
    const after = await get<{ full: boolean; tasks: Task[]; contexts: unknown[] }>(`/v1/sync?since=${before.cursor}`);
    expect(after.full).toBe(true);
    expect(after.tasks).toEqual([]);
    expect(after.contexts).toHaveLength(2);
  });
});
