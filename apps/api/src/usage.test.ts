/** GET /setup/usage: recorded model usage per day, and OpenAI's billed costs per day. */
import { recordModelUsage, schema } from "@wabrain/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchOpenAiCosts } from "./openai-costs.js";
import { UsageResponseSchema } from "./http/schemas.js";
import { createHarness, ownerAndDevice, type Harness } from "./test/harness.js";

const DAY = 86_400_000;
const utcDay = (offset: number) => new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()) - offset * DAY);

let h: Harness;
let cookie: string;
beforeAll(async () => {
  h = await createHarness({ worker: false, env: { OPENAI_ADMIN_KEY: "sk-admin-test", OPENAI_COSTS_PROJECT_ID: "proj_wab" } });
  ({ cookie } = await ownerAndDevice(h));
});
afterAll(async () => {
  await h.close();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GET /setup/usage", () => {
  it("adds up calls, tokens and audio per day and model, next to OpenAI's daily costs", async () => {
    const { db } = h.deps.database;
    const at = (offset: number) => new Date(utcDay(offset).getTime() + 10 * 3_600_000);
    await recordModelUsage(db, { role: "text", purpose: "analysis", provider: "openai", model: "gpt-6-luna", inputTokens: 1000, outputTokens: 50, at: at(1) });
    await recordModelUsage(db, { role: "text", purpose: "profile", provider: "openai", model: "gpt-6-luna", inputTokens: 500, outputTokens: 20, at: at(1) });
    await recordModelUsage(db, { role: "text", purpose: "analysis", provider: "openai", model: "gpt-6-luna", inputTokens: 10, outputTokens: 1, at: at(40) });
    // A transcription is counted in audio seconds from the voice note it transcribed.
    await db.insert(schema.chats).values({ id: "c1", jid: "447690000071@c.us", isGroup: false, mode: "on" });
    await db.insert(schema.messages).values({
      id: "m1", chatId: "c1", waMessageId: "w1", senderJid: "447690000071@c.us", direction: "incoming", fromOwner: false,
      kind: "voice", source: "webhook", sentAt: at(0),
    });
    await db.insert(schema.mediaObjects).values({ id: "mo1", messageId: "m1", kind: "voice", status: "done", durationSeconds: 90 });
    await recordModelUsage(db, { role: "transcription", purpose: "transcription", provider: "openai", model: "gpt-transcribe", refId: "mo1", at: at(0) });

    const calls: Array<{ url: string; auth: string | null }> = [];
    const pages = [
      {
        data: [{ start_time: utcDay(1).getTime() / 1000, results: [{ amount: { value: 0.42, currency: "usd" }, line_item: "gpt-6-luna, input" }] }],
        has_more: true,
        next_page: "p2",
      },
      {
        data: [
          {
            start_time: utcDay(1).getTime() / 1000,
            results: [{ amount: { value: "0.08", currency: "usd" }, line_item: "gpt-6-luna, output" }, { amount: { value: 0 }, line_item: "zero" }],
          },
        ],
        has_more: false,
      },
    ];
    const realFetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).startsWith("https://api.openai.com/")) return realFetch(url, init);
      calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
      return new Response(JSON.stringify(pages.shift()), { headers: { "content-type": "application/json" } });
    });

    expect((await h.request("/setup/usage")).status).toBe(401);
    const response = await h.request("/setup/usage?days=30", { headers: { cookie } });
    expect(response.status).toBe(200);
    const body = UsageResponseSchema.parse(await response.json());

    expect(body.usage).toEqual([
      { day: utcDay(1).toISOString().slice(0, 10), role: "text", provider: "openai", model: "gpt-6-luna", calls: 2, inputTokens: 1500, outputTokens: 70, audioSeconds: 0 },
      { day: utcDay(0).toISOString().slice(0, 10), role: "transcription", provider: "openai", model: "gpt-transcribe", calls: 1, inputTokens: 0, outputTokens: 0, audioSeconds: 90 },
    ]);
    expect(body.costs).toEqual({
      status: "ok",
      projectId: "proj_wab",
      days: [
        {
          day: utcDay(1).toISOString().slice(0, 10),
          items: [
            { lineItem: "gpt-6-luna, input", usd: 0.42 },
            { lineItem: "gpt-6-luna, output", usd: 0.08 },
          ],
        },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.auth === "Bearer sk-admin-test")).toBe(true);
    const first = new URL(calls[0]!.url);
    expect(first.searchParams.get("bucket_width")).toBe("1d");
    expect(first.searchParams.get("group_by")).toBe("line_item");
    expect(first.searchParams.get("project_ids")).toBe("proj_wab");
    expect(first.searchParams.get("start_time")).toBe(String(utcDay(29).getTime() / 1000));
    expect(new URL(calls[1]!.url).searchParams.get("page")).toBe("p2");
    // The admin key is never returned.
    expect(JSON.stringify(body)).not.toContain("sk-admin-test");
  });
});

describe("fetchOpenAiCosts", () => {
  it("reports a missing key and a refused key without throwing", async () => {
    expect(await fetchOpenAiCosts({ access: null, since: utcDay(29), days: 30 })).toEqual({ status: "not_configured" });
    const refused = await fetchOpenAiCosts({
      access: { adminKey: "sk-project", projectId: null },
      since: utcDay(29),
      days: 30,
      fetch: async () => new Response("{}", { status: 403 }),
    });
    expect(refused).toMatchObject({ status: "error", message: expect.stringContaining("Admin key") });
  });
});
